import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  RESIZE_REPAINT_TIMEOUT_MS,
  ResizeRepaintFilter,
  scanConptyResizeRepaint,
  trimConptyResizeRepaint
} from './terminalResizeRepaint';

const REPAINT = '\x1b[9;1H\x1b[J\x1b[9;1Hhelp     \x1b[9;5H';
const TRIMMED = '\x1b[9;1H\x1b[J\x1b[9;1Hhelp\x1b[9;5H';

/** Captured from the bundled ConPTY 1.25: grow repaints end with `\e[K`. */
const K_REPAINT = '\x1b[4;16H\x1b[J\x1b[4;16Hfoobar\x1b[K\x1b[4;22H';
/** Captured from the bundled ConPTY 1.25: some grow repaints carry no tail at all. */
const BARE_REPAINT = '\x1b[4;16H\x1b[J\x1b[4;16Hfoobar\x1b[4;22H';

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

  it('completes the \\e[K variant without trimming', () => {
    expect(scanConptyResizeRepaint(K_REPAINT)).toBe('complete');
    expect(trimConptyResizeRepaint(K_REPAINT)).toBe(K_REPAINT);
  });

  it('completes the bare variant without trimming', () => {
    expect(scanConptyResizeRepaint(BARE_REPAINT)).toBe('complete');
    expect(trimConptyResizeRepaint(BARE_REPAINT)).toBe(BARE_REPAINT);
  });

  it('trims padding that precedes an \\e[K terminator', () => {
    const repaint = '\x1b[11;4H\x1b[J\x1b[11;4Hhelp   \x1b[K\x1b[11;8H';
    expect(trimConptyResizeRepaint(repaint)).toBe('\x1b[11;4H\x1b[J\x1b[11;4Hhelp\x1b[K\x1b[11;8H');
  });

  it('keeps spaces that are part of the text but trims the tail run', () => {
    // An internal space is followed by more text — no terminator — so it
    // survives. A space run directly before the final CUP is indistinguishable
    // from padding and is trimmed.
    expect(trimConptyResizeRepaint('\x1b[9;1H\x1b[J\x1b[9;1Hfoo bar\x1b[9;8H')).toBe(
      '\x1b[9;1H\x1b[J\x1b[9;1Hfoo bar\x1b[9;8H'
    );
    expect(trimConptyResizeRepaint('\x1b[9;1H\x1b[J\x1b[9;1Hfoo bar \x1b[9;8H')).toBe(
      '\x1b[9;1H\x1b[J\x1b[9;1Hfoo bar\x1b[9;8H'
    );
  });

  it('accepts \\e[0J as the erase form', () => {
    const repaint = '\x1b[9;1H\x1b[0J\x1b[9;1Hhelp     \x1b[9;5H';
    expect(trimConptyResizeRepaint(repaint)).toBe('\x1b[9;1H\x1b[0J\x1b[9;1Hhelp\x1b[9;5H');
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

  it('joins a repaint split between the text and the padding', () => {
    const filter = new ResizeRepaintFilter();
    filter.arm();

    // The first chunk ends with text — no ESC suffix, but the framing makes
    // it a pattern prefix, so the whole chunk is held.
    expect(filter.consume('\x1b[9;1H\x1b[J\x1b[9;1Hfoobar')).toBe('');
    expect(filter.consume('     \x1b[9;5H')).toBe(TRIMMED.replace('help', 'foobar'));
    expect(filter.isPending).toBe(false);
  });

  it('holds a long wrapped repaint past the old 512-byte cap', () => {
    const filter = new ResizeRepaintFilter();
    filter.arm();

    const text = 'x'.repeat(600);
    expect(filter.consume(`\x1b[9;1H\x1b[J\x1b[9;1H${text}`)).toBe('');
    expect(filter.consume('     \x1b[9;601H')).toBe(`\x1b[9;1H\x1b[J\x1b[9;1H${text}\x1b[9;601H`);
    expect(filter.isPending).toBe(false);
  });

  it('releases the \\e[K variant immediately instead of waiting for the timeout', () => {
    const filter = new ResizeRepaintFilter();
    filter.arm();

    expect(filter.consume(K_REPAINT)).toBe(K_REPAINT);
    expect(filter.isPending).toBe(false);
    expect(filter.consume('more')).toBe('more');
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
