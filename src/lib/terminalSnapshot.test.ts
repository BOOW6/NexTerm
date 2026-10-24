import { beforeEach, describe, expect, it } from 'vitest';
import {
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
});
