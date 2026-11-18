/**
 * Backend resize delivery for one terminal.
 *
 * Invariants:
 * - at most one IPC resize is in flight;
 * - bursts converge on the newest requested grid (a stale target never wins);
 * - an identical request for the same target is not sent twice (`onResize`
 *   re-sends the grid after `applyGridResize`);
 * - a request that arrives before the transport exists is queued and
 *   delivered when the next target registers;
 * - `send()` resolves when the newest request has been acknowledged, so the
 *   caller can reflow xterm only after the PTY adopted the new size.
 */

export interface BackendResizeTarget {
  id: string;
  transport: string;
}

export interface BackendResizeDimensions {
  cols: number;
  rows: number;
}

interface SentDimensions extends BackendResizeDimensions {
  targetId: string;
}

export interface BackendResizeSenderOptions<T extends BackendResizeTarget> {
  getTarget: () => T | null;
  send: (target: T, cols: number, rows: number) => Promise<void>;
  onError?: (target: T, cols: number, rows: number, error: unknown) => void;
}

export class BackendResizeSender<T extends BackendResizeTarget> {
  private pending: BackendResizeDimensions | null = null;
  private queuedWithoutTarget: BackendResizeDimensions | null = null;
  private lastSent: SentDimensions | null = null;
  private inFlight = false;
  private idleWaiters: Array<() => void> = [];

  constructor(private readonly options: BackendResizeSenderOptions<T>) {}

  send(cols: number, rows: number): Promise<void> {
    const target = this.options.getTarget();
    if (!target) {
      this.queuedWithoutTarget = { cols, rows };
      return Promise.resolve();
    }
    if (
      this.lastSent &&
      this.lastSent.targetId === target.id &&
      this.lastSent.cols === cols &&
      this.lastSent.rows === rows
    ) {
      // The newest intent is already on the wire (or done). Drop a pending
      // intermediate target so an older request cannot win after the ack.
      this.pending = null;
      return this.whenIdle();
    }
    this.pending = { cols, rows };
    if (!this.inFlight) {
      this.flush();
    }
    return this.whenIdle();
  }

  /**
   * A transport just registered its target. Deliver the request that was
   * queued while nothing was connected, else sync the current grid.
   */
  flushQueued(cols: number, rows: number): void {
    const queued = this.queuedWithoutTarget;
    this.queuedWithoutTarget = null;
    void this.send(queued?.cols ?? cols, queued?.rows ?? rows);
  }

  /**
   * True when the last dispatched grid differs from `cols/rows`. Used by the
   * no-op path: xterm's grid did not change, but the PTY may already have
   * adopted an in-flight target.
   */
  lastSentDiffers(cols: number, rows: number): boolean {
    return !!this.lastSent && (this.lastSent.cols !== cols || this.lastSent.rows !== rows);
  }

  whenIdle(): Promise<void> {
    if (!this.inFlight && !this.pending) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.idleWaiters.push(resolve);
    });
  }

  /** Teardown: forget every queued/in-flight intent and release waiters. */
  reset(): void {
    this.pending = null;
    this.queuedWithoutTarget = null;
    this.lastSent = null;
    this.inFlight = false;
    this.signalIdle();
  }

  private flush(): void {
    const target = this.options.getTarget();
    const next = this.pending;
    this.pending = null;
    if (!target || !next) {
      this.inFlight = false;
      this.signalIdle();
      return;
    }
    this.inFlight = true;
    this.lastSent = { targetId: target.id, cols: next.cols, rows: next.rows };
    let request: Promise<void>;
    try {
      request = this.options.send(target, next.cols, next.rows);
    } catch (error) {
      this.options.onError?.(target, next.cols, next.rows, error);
      request = Promise.resolve();
    }
    void request
      .catch((error) => {
        // Let a later request re-send instead of treating a failed IPC as
        // delivered (the two-phase reflow would otherwise reflow on a grid
        // the PTY never adopted).
        if (
          this.lastSent &&
          this.lastSent.targetId === target.id &&
          this.lastSent.cols === next.cols &&
          this.lastSent.rows === next.rows
        ) {
          this.lastSent = null;
        }
        this.options.onError?.(target, next.cols, next.rows, error);
      })
      .finally(() => {
        if (this.pending && this.options.getTarget()) {
          this.flush();
        } else {
          this.inFlight = false;
          this.signalIdle();
        }
      });
  }

  private signalIdle(): void {
    if (this.inFlight || this.pending) {
      return;
    }
    const waiters = this.idleWaiters;
    this.idleWaiters = [];
    for (const waiter of waiters) {
      waiter();
    }
  }
}
