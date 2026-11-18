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
 */
export const RESIZE_REPAINT_TIMEOUT_MS = 150;

const CONPTY_RESIZE_REPAINT =
  // eslint-disable-next-line no-control-regex -- ConPTY's repaint is raw VT data.
  /^(\x1b\[\d+;\d+H\x1b\[J\x1b\[\d+;\d+H)([\s\S]*?)( +)(\x1b\[\d+;\d+H)$/;

/** Remove the redundant space run before the repaint's final CUP. */
export function trimConptyResizeRepaint(data: string): string {
  return data.replace(CONPTY_RESIZE_REPAINT, '$1$2$4');
}

/**
 * Only the first output batch after a local-reflow resize can be ConPTY's
 * cursor-line repaint. If the backend stays silent (PowerShell does until the
 * next key), the filter expires without touching anything.
 */
export class ResizeRepaintFilter {
  private pending = false;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly timeoutMs: number = RESIZE_REPAINT_TIMEOUT_MS) {}

  get isPending(): boolean {
    return this.pending;
  }

  arm(): void {
    this.pending = true;
    if (this.timer !== null) {
      clearTimeout(this.timer);
    }
    this.timer = setTimeout(() => {
      this.timer = null;
      this.pending = false;
    }, this.timeoutMs);
  }

  /** Normalize the first batch, then pass subsequent batches through. */
  consume(data: string): string {
    if (!this.pending) {
      return data;
    }
    this.pending = false;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    return trimConptyResizeRepaint(data);
  }

  cancel(): void {
    this.pending = false;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
