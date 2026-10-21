import { existsSync, readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Terminal } from '@xterm/xterm';
import { readSystemFont } from '../lib/systemFonts';
import { NativeLigaturesAddon } from './nativeLigaturesAddon';

vi.mock('../lib/systemFonts', () => ({
  readSystemFont: vi.fn()
}));

const readSystemFontMock = vi.mocked(readSystemFont);
const cascadiaPath = 'C:/Windows/Fonts/CascadiaCode.ttf';

function createTerminal(family = '"Missing Font", monospace') {
  let joiner: ((text: string) => Array<[number, number]>) | undefined;
  const element = document.createElement('div');
  const terminal = {
    element,
    options: { fontFamily: family },
    rows: 24,
    registerCharacterJoiner: vi.fn((handler: (text: string) => Array<[number, number]>) => {
      joiner = handler;
      return 7;
    }),
    deregisterCharacterJoiner: vi.fn(),
    refresh: vi.fn()
  } as unknown as Terminal;

  return {
    terminal,
    element,
    getJoiner: () => joiner
  };
}

function readCascadiaBuffer(): ArrayBuffer {
  const data = readFileSync(cascadiaPath);
  return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
}

describe('NativeLigaturesAddon', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    readSystemFontMock.mockReset();
    readSystemFontMock.mockRejectedValue(new Error('font service unavailable'));
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('sets font feature settings and registers a joiner', () => {
    const { terminal, element, getJoiner } = createTerminal();
    const addon = new NativeLigaturesAddon();

    addon.activate(terminal);

    expect(element.style.fontFeatureSettings).toBe('"calt" on');
    expect(terminal.registerCharacterJoiner).toHaveBeenCalledTimes(1);
    expect(getJoiner()?.('a -> b')).toEqual([[2, 4]]);
  });

  it('applies custom font feature settings', () => {
    const { terminal, element } = createTerminal();
    const addon = new NativeLigaturesAddon({
      featureSettings: '"calt" off, "ss03"'
    });

    addon.activate(terminal);
    expect(element.style.fontFeatureSettings).toBe('"calt" off, "ss03"');
  });

  it('falls back when the native font cannot be loaded', () => {
    const { terminal, getJoiner } = createTerminal();
    const addon = new NativeLigaturesAddon();

    addon.activate(terminal);

    expect(getJoiner()?.('a => b != c === d')).toEqual([
      [2, 4],
      [7, 9],
      [12, 15]
    ]);

    addon.dispose();
    expect(terminal.deregisterCharacterJoiner).toHaveBeenCalledWith(7);
    expect(terminal.element?.style.fontFeatureSettings).toBe('');
  });

  it.skipIf(!existsSync(cascadiaPath))(
    'parses ligature ranges from native font bytes',
    async () => {
      readSystemFontMock.mockResolvedValue(readCascadiaBuffer());
      const { terminal, getJoiner } = createTerminal('"Cascadia Code", monospace');
      const addon = new NativeLigaturesAddon();

      addon.activate(terminal);
      expect(getJoiner()?.('-> =>')).toEqual([
        [0, 2],
        [3, 5]
      ]);

      await vi.waitFor(() => expect(terminal.refresh).toHaveBeenCalled());
      expect(getJoiner()?.('-> =>')).toEqual([
        [0, 2],
        [3, 5]
      ]);
    }
  );
});
