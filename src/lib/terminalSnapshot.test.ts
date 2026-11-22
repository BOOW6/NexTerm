import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearAllTerminalSnapshots,
  clearTerminalSnapshot,
  readTerminalSnapshot,
  trimSnapshot,
  writeTerminalSnapshot
} from './terminalSnapshot';

describe('terminalSnapshot', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('stores and clears a snapshot per session', () => {
    writeTerminalSnapshot('a', 'hello');
    writeTerminalSnapshot('b', 'world');
    expect(readTerminalSnapshot('a')).toBe('hello');
    expect(readTerminalSnapshot('b')).toBe('world');

    clearTerminalSnapshot('a');
    expect(readTerminalSnapshot('a')).toBeNull();
    expect(readTerminalSnapshot('b')).toBe('world');
  });

  it('drops oversized snapshots', () => {
    writeTerminalSnapshot('big', 'x'.repeat(512 * 1024 + 1));
    expect(readTerminalSnapshot('big')).toBeNull();
  });

  it('trims blank-row noise from snapshots', () => {
    expect(trimSnapshot('prompt\r\n\r\n\r\n')).toBe('prompt');
    expect(trimSnapshot('line1\nline2\n')).toBe('line1\nline2');
    expect(trimSnapshot('keep\n\ninner')).toBe('keep\n\ninner');
    expect(trimSnapshot('a\r\n\r\n\r\n\r\n\r\nb')).toBe('a\r\n\r\nb');

    writeTerminalSnapshot('blank', 'old output\r\n\r\n\r\n\r\n\r\n\r\n');
    expect(readTerminalSnapshot('blank')).toBe('old output');
  });

  it('evicts the least recently used sessions beyond the retention cap', () => {
    // MAX_SNAPSHOT_ENTRIES is 24: fill 25 sessions, the oldest must go.
    for (let i = 0; i < 25; i += 1) {
      writeTerminalSnapshot(`s${i}`, `content-${i}`);
    }
    expect(readTerminalSnapshot('s0')).toBeNull();
    expect(readTerminalSnapshot('s24')).toBe('content-24');

    // Reading refreshes recency: touch s1, then overflow with s25 — the
    // victim is s2 (the oldest untouched), not s1.
    expect(readTerminalSnapshot('s1')).toBe('content-1');
    writeTerminalSnapshot('s25', 'newest');
    expect(readTerminalSnapshot('s1')).toBe('content-1');
    expect(readTerminalSnapshot('s2')).toBeNull();
  });

  it('wipes every snapshot on the privacy cleanup entry point', () => {
    writeTerminalSnapshot('a', 'one');
    writeTerminalSnapshot('b', 'two');

    expect(clearAllTerminalSnapshots()).toBe(2);
    expect(readTerminalSnapshot('a')).toBeNull();
    expect(readTerminalSnapshot('b')).toBeNull();
    expect(clearAllTerminalSnapshots()).toBe(0);
  });
});
