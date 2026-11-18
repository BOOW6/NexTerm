import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  RESIZE_REPAINT_TIMEOUT_MS,
  ResizeRepaintFilter,
  trimConptyResizeRepaint
} from './terminalResizeRepaint';

describe('trimConptyResizeRepaint', () => {
  it('removes the padding run before the final CUP', () => {
    // cmd 100x30 -> 15x30 with "help" typed.
    expect(trimConptyResizeRepaint('\x1b[9;1H\x1b[J\x1b[9;1Hhelp               \x1b[9;5H')).toBe(
      '\x1b[9;1H\x1b[J\x1b[9;1Hhelp\x1b[9;5H'
    );
    expect(trimConptyResizeRepaint('\x1b[11;3H\x1b[J\x1b[11;3Hhelp             \x1b[11;7H')).toBe(
      '\x1b[11;3H\x1b[J\x1b[11;3Hhelp\x1b[11;7H'
    );
  });

  it('keeps text that legitimately wraps at the last column', () => {
    // 16 columns: "help" starts at the last cell and must wrap, no padding.
    const repaint = '\x1b[8;16H\x1b[J\x1b[8;16Hhelp\x1b[9;4H';
    expect(trimConptyResizeRepaint(repaint)).toBe(repaint);
  });

  it('leaves unrelated output untouched', () => {
    const output = 'dir output\r\nanother line\r\n';
    expect(trimConptyResizeRepaint(output)).toBe(output);
    expect(trimConptyResizeRepaint('\x1b[1;1Hhello   ')).toBe('\x1b[1;1Hhello   ');
  });
});

describe('ResizeRepaintFilter', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('normalizes only the first batch after arming', () => {
    const filter = new ResizeRepaintFilter();
    filter.arm();

    expect(filter.consume('\x1b[9;1H\x1b[J\x1b[9;1Hhelp     \x1b[9;5H')).toBe(
      '\x1b[9;1H\x1b[J\x1b[9;1Hhelp\x1b[9;5H'
    );
    expect(filter.isPending).toBe(false);
    expect(filter.consume('\x1b[9;1H\x1b[J\x1b[9;1Hhelp     \x1b[9;5H')).toBe(
      '\x1b[9;1H\x1b[J\x1b[9;1Hhelp     \x1b[9;5H'
    );
  });

  it('expires when the backend stays silent', () => {
    const filter = new ResizeRepaintFilter();
    filter.arm();
    vi.advanceTimersByTime(RESIZE_REPAINT_TIMEOUT_MS);

    expect(filter.isPending).toBe(false);
    const output = '\x1b[9;1H\x1b[J\x1b[9;1Hhelp     \x1b[9;5H';
    expect(filter.consume(output)).toBe(output);
  });

  it('can be cancelled before a direct write sequence', () => {
    const filter = new ResizeRepaintFilter();
    filter.arm();
    filter.cancel();

    const output = '\x1b[9;1H\x1b[J\x1b[9;1Hhelp     \x1b[9;5H';
    expect(filter.consume(output)).toBe(output);
  });
});
