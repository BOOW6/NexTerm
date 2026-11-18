/**
 * ConPTY's resize repaint writes the cursor line back as
 *
 *   CUP, erase-to-end, CUP, <text plus padding spaces>, CUP
 *
 * The padding exists to overwrite stale cells, but `\e[J` already cleared
 * them. On the last viewport row those extra spaces auto-wrap, scroll the
 * viewport by one row, and the final CUP lands on a blank row. Stripping only
 * the trailing padding keeps text that legitimately wraps (for example a
 * prompt whose last column is followed by the first character of the input)
 * intact.
 *
 * The repaint is not guaranteed to be the first 16ms batch, or to arrive in
 * one IPC chunk. The filter stays armed until the pattern is seen or the
 * timeout fires, and holds back only a suffix that can still grow into the
 * pattern.
 */
export const RESIZE_REPAINT_TIMEOUT_MS = 150;

/** A cursor-line repaint is one row of padding plus the CUP framing. */
const MAX_REPAINT_HOLD = 512;

const CONPTY_RESIZE_REPAINT =
  // eslint-disable-next-line no-control-regex -- ConPTY's repaint is raw VT data.
  /(\x1b\[\d+;\d+H\x1b\[J\x1b\[\d+;\d+H)([\s\S]*?)( +)(\x1b\[\d+;\d+H)/;

/** Remove the redundant space run before the repaint's final CUP. */
export function trimConptyResizeRepaint(data: string): string {
  return data.replace(CONPTY_RESIZE_REPAINT, '$1$2$4');
}

type RepaintScan = 'complete' | 'prefix' | 'no';

function isDigit(char: string | undefined): boolean {
  return char !== undefined && char >= '0' && char <= '9';
}

/**
 * Classify `input` as a ConPTY resize repaint, a strict prefix of one, or
 * neither. Used to hold a split chunk without delaying unrelated output.
 */
export function scanConptyResizeRepaint(input: string): RepaintScan {
  let index = 0;

  const readCup = (): 'ok' | 'prefix' | 'no' => {
    if (index >= input.length) {
      return 'prefix';
    }
    if (input[index] !== '\x1b') {
      return 'no';
    }
    index += 1;
    if (index >= input.length) {
      return 'prefix';
    }
    if (input[index] !== '[') {
      return 'no';
    }
    index += 1;
    const rowStart = index;
    while (isDigit(input[index])) {
      index += 1;
    }
    if (index === rowStart) {
      return index >= input.length ? 'prefix' : 'no';
    }
    if (index >= input.length) {
      return 'prefix';
    }
    if (input[index] !== ';') {
      return 'no';
    }
    index += 1;
    const colStart = index;
    while (isDigit(input[index])) {
      index += 1;
    }
    if (index === colStart) {
      return index >= input.length ? 'prefix' : 'no';
    }
    if (index >= input.length) {
      return 'prefix';
    }
    if (input[index] !== 'H') {
      return 'no';
    }
    index += 1;
    return 'ok';
  };

  const first = readCup();
  if (first !== 'ok') {
    return first;
  }
  if (index >= input.length) {
    return 'prefix';
  }
  if (input[index] !== '\x1b') {
    return 'no';
  }
  index += 1;
  if (index >= input.length) {
    return 'prefix';
  }
  if (input[index] !== '[') {
    return 'no';
  }
  index += 1;
  if (index >= input.length) {
    return 'prefix';
  }
  if (input[index] !== 'J') {
    return 'no';
  }
  index += 1;
  const second = readCup();
  if (second !== 'ok') {
    return second;
  }
  if (index >= input.length) {
    return 'prefix';
  }
  // Text may itself contain spaces. The repaint is complete once a space run
  // is followed by the final CUP; anything short of that can still grow into
  // one and must be held.
  // eslint-disable-next-line no-control-regex -- ConPTY's repaint is raw VT data.
  if (/ +\x1b\[\d+;\d+H/.test(input.slice(index))) {
    return 'complete';
  }
  return 'prefix';
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
    const stripped = trimConptyResizeRepaint(combined);
    if (stripped !== combined) {
      this.pending = false;
      if (this.timer !== null) {
        clearTimeout(this.timer);
        this.timer = null;
      }
      this.releaseWaiters();
      return stripped;
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
