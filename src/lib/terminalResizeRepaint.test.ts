import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  RESIZE_REPAINT_TIMEOUT_MS,
  ResizeRepaintFilter,
  trimConptyResizeRepaint
} from './terminalResizeRepaint';

const REPAINT = '\x1b[9;1H\x1b[J\x1b[9;1Hhelp     \x1b[9;5H';
const TRIMMED = '\x1b[9;1H\x1b[J\x1b[9;1Hhelp\x1b[9;5H';

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

  it('trims a repaint that shares a batch with earlier output', () => {
    expect(trimConptyResizeRepaint(`dir output\r\n${REPAINT}`)).toBe(`dir output\r\n${TRIMMED}`);
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

  it('normalizes a matching batch and then passes data through', () => {
    const filter = new ResizeRepaintFilter();
    filter.arm();

    expect(filter.consume(REPAINT)).toBe(TRIMMED);
    expect(filter.isPending).toBe(false);
    expect(filter.consume(REPAINT)).toBe(REPAINT);
  });

  it('does not disarm on an unrelated first batch', () => {
    const filter = new ResizeRepaintFilter();
    filter.arm();

    expect(filter.consume('dir output\r\n')).toBe('dir output\r\n');
    expect(filter.isPending).toBe(true);
    expect(filter.consume(REPAINT)).toBe(TRIMMED);
    expect(filter.isPending).toBe(false);
  });

  it('joins a repaint split across consumes', () => {
    const filter = new ResizeRepaintFilter();
    filter.arm();

    expect(filter.consume('\x1b[9;1H\x1b[J\x1b[9;1Hhe')).toBe('');
    expect(filter.isPending).toBe(true);
    expect(filter.consume('lp     \x1b[9;5H')).toBe(TRIMMED);
    expect(filter.isPending).toBe(false);
  });

  it('expires when the backend stays silent and flushes a held prefix', () => {
    const filter = new ResizeRepaintFilter();
    filter.arm();
    expect(filter.consume('\x1b[9;1H')).toBe('');

    vi.advanceTimersByTime(RESIZE_REPAINT_TIMEOUT_MS);

    expect(filter.isPending).toBe(false);
    expect(filter.consume('more')).toBe('\x1b[9;1Hmore');
  });

  it('can be cancelled before a direct write sequence', () => {
    const filter = new ResizeRepaintFilter();
    filter.arm();
    expect(filter.consume('\x1b[9;1H')).toBe('');

    expect(filter.cancel()).toBe('\x1b[9;1H');
    expect(filter.isPending).toBe(false);
    expect(filter.consume(REPAINT)).toBe(REPAINT);
  });
});
