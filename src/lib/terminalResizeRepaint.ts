/**
 * ConPTY's resize repaint writes the cursor line back as
 *
 *   CUP, erase-to-end, CUP, <text>, [padding], CUP
 *
 * The bytes between the text and the final CUP vary by scenario (all
 * captured from the bundled ConPTY 1.25):
 *
 * - shrink with a wrapped cursor line pads with spaces to overwrite stale
 *   cells (`help            ` before the final CUP);
 * - grow from a wrapped cursor line emits `\e[K` right before the final CUP;
 * - grow with a single-row cursor line emits nothing before the final CUP.
 *
 * The padding exists to overwrite stale cells, but `\e[J` already cleared
 * them. On the last viewport row those extra spaces auto-wrap, scroll the
 * viewport by one row, and the final CUP lands on a blank row. Stripping only
 * the trailing padding keeps text that legitimately wraps (for example a
 * prompt whose last column is followed by the first character of the input)
 * intact.
 *
 * The repaint is not guaranteed to be the first 16ms batch, or to arrive in
 * one IPC chunk. The filter stays armed until a complete repaint is seen or
 * the timeout fires, and holds back only a suffix that can still grow into
 * the pattern.
 */
export const RESIZE_REPAINT_TIMEOUT_MS = 150;

/**
 * A cursor-line repaint is one row of text plus the CUP framing. Wide-character
 * prompt lines can exceed 512 UTF-16 units; a hold cap below the longest
 * plausible repaint would let split padding reach xterm raw.
 */
const MAX_REPAINT_HOLD = 8 * 1024;

export type RepaintScan = 'complete' | 'prefix' | 'no';

export interface RepaintMatch {
  /** Index just past the repaint's final CUP. */
  end: number;
  /**
   * Remove `[trimStart, trimEnd)` — the padding run before the final CUP.
   * Empty when the repaint ends with `\e[K` or with bare text.
   */
  trimStart: number;
  trimEnd: number;
}

function isDigit(char: string | undefined): boolean {
  return char !== undefined && char >= '0' && char <= '9';
}

type CupParse = { ok: true; end: number } | { ok: false; alive: boolean };

/** Parse `ESC [ row ; col H` starting at `start`. `alive` reports whether more
 * input could still complete the sequence. */
function parseCup(input: string, start: number): CupParse {
  let index = start;
  const length = input.length;
  if (index >= length) {
    return { ok: false, alive: true };
  }
  if (input[index] !== '\x1b') {
    return { ok: false, alive: false };
  }
  index += 1;
  if (index >= length) {
    return { ok: false, alive: true };
  }
  if (input[index] !== '[') {
    return { ok: false, alive: false };
  }
  index += 1;
  const rowStart = index;
  while (index < length && isDigit(input[index])) {
    index += 1;
  }
  if (index === rowStart) {
    return { ok: false, alive: index >= length };
  }
  if (index >= length) {
    return { ok: false, alive: true };
  }
  if (input[index] !== ';') {
    return { ok: false, alive: false };
  }
  index += 1;
  const colStart = index;
  while (index < length && isDigit(input[index])) {
    index += 1;
  }
  if (index === colStart) {
    return { ok: false, alive: index >= length };
  }
  if (index >= length) {
    return { ok: false, alive: true };
  }
  if (input[index] !== 'H') {
    return { ok: false, alive: false };
  }
  return { ok: true, end: index + 1 };
}

/** Length of the erase-to-end sequence at `start`, or 0 when absent. */
function eraseToEndLength(input: string, start: number): number {
  if (input.startsWith('\x1b[J', start)) {
    return 3;
  }
  if (input.startsWith('\x1b[0J', start)) {
    return 4;
  }
  return 0;
}

type TailScan =
  { kind: 'complete'; end: number; trimStart: number; trimEnd: number } | { kind: 'prefix' };

/**
 * Scan the repaint tail after the framing `CUP, \e[J, CUP`. The repaint ends
 * at the first CUP in the tail; a space run before it (optionally with an
 * `\e[K`) is padding and gets trimmed. Anything short of a terminating CUP
 * can still grow into one, so an incomplete tail is always a prefix.
 */
function scanRepaintTail(input: string, start: number): TailScan {
  let index = start;
  const length = input.length;
  while (index < length) {
    const char = input[index];
    if (char === ' ') {
      let runEnd = index;
      while (runEnd < length && input[runEnd] === ' ') {
        runEnd += 1;
      }
      let cupStart = runEnd;
      const hasErase = input.startsWith('\x1b[K', cupStart);
      if (hasErase) {
        cupStart += 3;
      }
      const cup = parseCup(input, cupStart);
      if (cup.ok) {
        // Keep an \e[K terminator; only the space run is padding.
        return { kind: 'complete', end: cup.end, trimStart: index, trimEnd: runEnd };
      }
      if (cup.alive || cupStart >= length) {
        return { kind: 'prefix' };
      }
      // Text may itself contain spaces; keep scanning past this run.
      index = runEnd;
      continue;
    }
    if (char === '\x1b') {
      const eraseLength = eraseToEndLength(input, index);
      const afterErase = index + eraseLength;
      if (eraseLength > 0) {
        const cup = parseCup(input, afterErase);
        if (cup.ok) {
          return { kind: 'complete', end: cup.end, trimStart: index, trimEnd: index };
        }
        if (cup.alive || afterErase >= length) {
          return { kind: 'prefix' };
        }
        // A standalone \e[K is not the terminator; keep scanning.
        index = afterErase;
        continue;
      }
      const cup = parseCup(input, index);
      if (cup.ok) {
        return { kind: 'complete', end: cup.end, trimStart: index, trimEnd: index };
      }
      if (cup.alive) {
        return { kind: 'prefix' };
      }
      // Some other escape sequence is part of the text.
      index += 1;
      continue;
    }
    index += 1;
  }
  return { kind: 'prefix' };
}

/**
 * Find the first complete ConPTY cursor-line repaint in `input`, starting at
 * or after `from`. Returns `null` when no framing (`CUP \e[J CUP`) followed
 * by a terminating CUP exists.
 */
export function findConptyResizeRepaint(input: string, from = 0): RepaintMatch | null {
  let search = Math.max(0, from);
  while (search < input.length) {
    const esc = input.indexOf('\x1b', search);
    if (esc < 0) {
      return null;
    }
    const first = parseCup(input, esc);
    const erase = first.ok ? eraseToEndLength(input, first.end) : 0;
    if (!first.ok || erase === 0) {
      search = esc + 1;
      continue;
    }
    const second = parseCup(input, first.end + erase);
    if (!second.ok) {
      search = esc + 1;
      continue;
    }
    const tail = scanRepaintTail(input, second.end);
    if (tail.kind === 'complete') {
      return { end: tail.end, trimStart: tail.trimStart, trimEnd: tail.trimEnd };
    }
    search = esc + 1;
  }
  return null;
}

/** Remove the redundant space run before the repaint's final CUP. */
export function trimConptyResizeRepaint(data: string): string {
  const match = findConptyResizeRepaint(data);
  if (!match || match.trimStart === match.trimEnd) {
    return data;
  }
  return data.slice(0, match.trimStart) + data.slice(match.trimEnd);
}

/**
 * Classify `input` as a ConPTY resize repaint, a strict prefix of one, or
 * neither. Used to hold a split chunk without delaying unrelated output.
 */
export function scanConptyResizeRepaint(input: string): RepaintScan {
  const first = parseCup(input, 0);
  if (!first.ok) {
    return first.alive ? 'prefix' : 'no';
  }
  const rest = input.slice(first.end);
  if (rest.length === 0) {
    return 'prefix';
  }
  if ('\x1b[J'.startsWith(rest) || '\x1b[0J'.startsWith(rest)) {
    // The input ends inside the erase sequence itself.
    return 'prefix';
  }
  const erase = eraseToEndLength(input, first.end);
  if (erase === 0) {
    return 'no';
  }
  const second = parseCup(input, first.end + erase);
  if (!second.ok) {
    return second.alive ? 'prefix' : 'no';
  }
  const tail = scanRepaintTail(input, second.end);
  return tail.kind === 'complete' ? 'complete' : 'prefix';
}

/** Bytes at the end of `data` that must be held so a split repaint can complete. */
export function repaintHoldLength(data: string): number {
  let searchFrom = data.length;
  while (searchFrom > 0) {
    const esc = data.lastIndexOf('\x1b', searchFrom - 1);
    if (esc < 0) {
      return 0;
    }
    const tail = data.slice(esc);
    if (tail.length > MAX_REPAINT_HOLD) {
      // A tail this long cannot be a cursor-line repaint worth holding; the
      // timeout path releases anything the window has already held.
      return 0;
    }
    const scan = scanConptyResizeRepaint(tail);
    if (scan === 'prefix') {
      return tail.length;
    }
    if (scan === 'complete') {
      return 0;
    }
    searchFrom = esc;
  }
  return 0;
}

/**
 * Only the output after a local-reflow resize can be ConPTY's cursor-line
 * repaint. Unrelated batches pass through and leave the filter armed; a
 * matching batch (alone, prefixed, or split across consumes) is trimmed once.
 * If the backend stays silent (PowerShell does until the next key), the
 * filter expires without touching anything.
 */
export class ResizeRepaintFilter {
  private pending = false;
  private carry = '';
  private timer: ReturnType<typeof setTimeout> | null = null;
  private settled: Array<() => void> = [];

  constructor(private readonly timeoutMs: number = RESIZE_REPAINT_TIMEOUT_MS) {}

  get isPending(): boolean {
    return this.pending;
  }

  /**
   * Start (or restart) the window. Returns bytes held from the previous
   * window so the caller can write them instead of dropping a split chunk.
   */
  arm(): string {
    const previous = this.carry;
    this.carry = '';
    this.pending = true;
    this.releaseWaiters();
    if (this.timer !== null) {
      clearTimeout(this.timer);
    }
    this.timer = setTimeout(() => {
      this.timer = null;
      this.pending = false;
      this.releaseWaiters();
    }, this.timeoutMs);
    return previous;
  }

  /**
   * Trim a repaint if this batch contains one. Otherwise pass the batch
   * through, holding back only a suffix that is still a prefix of the pattern.
   */
  consume(data: string): string {
    if (!this.pending) {
      if (!this.carry) {
        return data;
      }
      const flushed = this.carry + data;
      this.carry = '';
      return flushed;
    }
    const combined = this.carry + data;
    this.carry = '';
    const match = findConptyResizeRepaint(combined);
    if (match) {
      this.pending = false;
      if (this.timer !== null) {
        clearTimeout(this.timer);
        this.timer = null;
      }
      this.releaseWaiters();
      if (match.trimStart === match.trimEnd) {
        return combined;
      }
      return combined.slice(0, match.trimStart) + combined.slice(match.trimEnd);
    }
    const hold = repaintHoldLength(combined);
    if (hold > 0) {
      this.carry = combined.slice(combined.length - hold);
      return combined.slice(0, combined.length - hold);
    }
    return combined;
  }

  /** Fire `callback` once the window matches or times out. Already settled: now. */
  whenSettled(callback: () => void): void {
    if (!this.pending) {
      callback();
      return;
    }
    this.settled.push(callback);
  }

  /** Bytes held back from the current window. Does not disarm. */
  takeCarry(): string {
    const carry = this.carry;
    this.carry = '';
    return carry;
  }

  /**
   * Stop waiting. Returns held bytes so a direct write (notice, teardown)
   * cannot drop a split chunk or be mistaken for the repaint.
   */
  cancel(): string {
    const carry = this.carry;
    this.carry = '';
    this.pending = false;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.releaseWaiters();
    return carry;
  }

  private releaseWaiters(): void {
    const waiters = this.settled;
    this.settled = [];
    for (const waiter of waiters) {
      queueMicrotask(waiter);
    }
  }
}
