/**
 * ConPTY's resize repaint writes the cursor line back with padding spaces to
 * the old line end. On the last viewport row those spaces auto-wrap, scroll the
 * viewport by one row, and the following absolute CUP lands on the blank row.
 * xterm has already reflowed the line locally, so the padding carries no
 * information: turn DECAWM off for the first output batch that follows the
 * resize, then restore the application's previous mode.
 */
export const WRAP_GUARD_TIMEOUT_MS = 150;

const DISABLE_WRAP = '\x1b[?7l';
const ENABLE_WRAP = '\x1b[?7h';

export class ResizeWrapGuard {
  private armed = false;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly write: (data: string) => void,
    private readonly timeoutMs: number = WRAP_GUARD_TIMEOUT_MS
  ) {}

  get isArmed(): boolean {
    return this.armed;
  }

  /**
   * Arm the guard when the application had autowrap enabled. Returns false
   * when there is nothing to do, so callers can skip the release bookkeeping.
   */
  arm(wraparoundEnabled: boolean): boolean {
    if (this.armed || !wraparoundEnabled) {
      return false;
    }
    this.armed = true;
    this.write(DISABLE_WRAP);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.release();
    }, this.timeoutMs);
    return true;
  }

  /** Restore autowrap after the resize output batch was parsed. */
  release(): void {
    if (!this.armed) {
      return;
    }
    this.armed = false;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.write(ENABLE_WRAP);
  }

  /** Teardown must not write; the terminal is going away. */
  dispose(): void {
    this.armed = false;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
