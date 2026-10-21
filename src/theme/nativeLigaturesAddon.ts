import type { ITerminalAddon, Terminal } from '@xterm/xterm';
import { loadBuffer, type Font as LigatureFont } from 'font-ligatures';
import { firstFontFamily } from '../lib/fontFamily';
import { readSystemFont } from '../lib/systemFonts';
import {
  TERMINAL_LIGATURE_FALLBACKS,
  TERMINAL_LIGATURE_FEATURE_SETTINGS
} from './terminalLigatures';

export interface NativeLigaturesAddonOptions {
  featureSettings?: string;
  fallbackLigatures?: string[];
}

function asArrayBuffer(data: ArrayBuffer | Uint8Array): ArrayBuffer {
  if (ArrayBuffer.isView(data)) {
    return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
  }
  return data as ArrayBuffer;
}

function fallbackRanges(text: string, sequences: string[]): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  let index = 0;

  while (index < text.length) {
    const match = sequences.find((sequence) => text.startsWith(sequence, index));
    if (!match) {
      index += 1;
      continue;
    }
    ranges.push([index, index + match.length]);
    index += match.length;
  }

  return ranges;
}

const sharedFontCache = new Map<string, LigatureFont | null>();
const sharedFontLoading = new Map<string, Promise<LigatureFont | null>>();

function loadSharedFont(family: string): Promise<LigatureFont | null> {
  const cached = sharedFontCache.get(family);
  if (cached !== undefined) {
    return Promise.resolve(cached);
  }

  const existing = sharedFontLoading.get(family);
  if (existing) {
    return existing;
  }

  const promise = readSystemFont({ family })
    .then((data) => {
      const font = loadBuffer(asArrayBuffer(data), { cacheSize: 100_000 });
      sharedFontCache.set(family, font);
      return font;
    })
    .catch((error) => {
      sharedFontCache.set(family, null);
      console.warn('[terminal] failed to load font ligatures', family, error);
      return null;
    })
    .finally(() => {
      sharedFontLoading.delete(family);
    });

  sharedFontLoading.set(family, promise);
  return promise;
}

/**
 * Terminal ligatures backed by native font files. Font bytes come from the
 * platform font service, so no browser Local Font Access permission is needed.
 */
export class NativeLigaturesAddon implements ITerminalAddon {
  private terminal: Terminal | null = null;
  private joinerId: number | undefined;
  private disposed = false;
  private previousFeatureSettings = '';
  private readonly featureSettings: string;
  private readonly fallbackLigatures: string[];
  private readonly sortedFallbacks: string[];
  private readonly waiting = new Set<string>();

  constructor(options: NativeLigaturesAddonOptions = {}) {
    this.featureSettings = options.featureSettings ?? TERMINAL_LIGATURE_FEATURE_SETTINGS;
    this.fallbackLigatures = options.fallbackLigatures ?? TERMINAL_LIGATURE_FALLBACKS;
    this.sortedFallbacks = [...this.fallbackLigatures].sort((a, b) => b.length - a.length);
  }

  activate(terminal: Terminal): void {
    if (!terminal.element) {
      throw new Error('NativeLigaturesAddon requires terminal.open() first');
    }

    this.terminal = terminal;
    this.previousFeatureSettings = terminal.element.style.fontFeatureSettings;
    terminal.element.style.fontFeatureSettings = this.featureSettings;
    this.joinerId = terminal.registerCharacterJoiner((text) => this.findRanges(text));
  }

  dispose(): void {
    this.disposed = true;
    if (this.terminal) {
      if (this.joinerId !== undefined) {
        this.terminal.deregisterCharacterJoiner(this.joinerId);
        this.joinerId = undefined;
      }
      if (this.terminal.element) {
        this.terminal.element.style.fontFeatureSettings = this.previousFeatureSettings;
      }
    }
    this.waiting.clear();
    this.terminal = null;
  }

  private findRanges(text: string): Array<[number, number]> {
    const terminal = this.terminal;
    if (!terminal) {
      return fallbackRanges(text, this.sortedFallbacks);
    }

    const family = firstFontFamily(terminal.options.fontFamily ?? '');
    if (!family) {
      return fallbackRanges(text, this.sortedFallbacks);
    }

    const font = this.ensureFont(family);
    if (!font) {
      return fallbackRanges(text, this.sortedFallbacks);
    }

    try {
      return font.findLigatureRanges(text);
    } catch {
      return fallbackRanges(text, this.sortedFallbacks);
    }
  }

  private ensureFont(family: string): LigatureFont | null {
    const cached = sharedFontCache.get(family);
    if (cached !== undefined) {
      return cached;
    }
    if (this.waiting.has(family)) {
      return null;
    }

    this.waiting.add(family);
    void loadSharedFont(family).then(() => {
      this.waiting.delete(family);
      if (!this.disposed && this.terminal?.element) {
        this.terminal.refresh(0, this.terminal.rows - 1);
      }
    });

    return null;
  }
}
