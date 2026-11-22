import type { IBufferLine } from '@xterm/xterm';

/** Minimal buffer surface used for transcripts; narrows the xterm types so
 * tests can pass a real Terminal without coupling to the full API. */
export interface TranscriptBufferSource {
  active: {
    length: number;
    getLine(row: number): IBufferLine | undefined;
  };
}

/**
 * Plain-text transcript of the active buffer (scrollback plus viewport),
 * one line per row with trailing whitespace trimmed (xterm only drops
 * never-written cells, so explicit spaces need their own trim). Trailing
 * blank rows are dropped so the file never ends in a gap. The alternate
 * buffer is not handled here: callers only export settled sessions, where
 * the normal buffer is active.
 */
export function terminalTranscript(buffer: TranscriptBufferSource): string {
  const lines: string[] = [];
  for (let row = 0; row < buffer.active.length; row += 1) {
    lines.push((buffer.active.getLine(row)?.translateToString(true) ?? '').replace(/\s+$/, ''));
  }
  while (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop();
  }
  return lines.join('\n');
}

/**
 * Default save-file name for a transcript: session title plus a local
 * timestamp. Characters Windows forbids in file names collapse to dashes,
 * and an empty title falls back to a generic name.
 */
export function transcriptFileName(title: string, now: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0');
  const stamp =
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const safeTitle = (title.trim() || 'terminal').replace(/[\\/:*?"<>|]+/g, '-');
  return `${safeTitle}-${stamp}.txt`;
}
