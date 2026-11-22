/**
 * Placement math for in-buffer terminal notices (restore divider, reconnect
 * divider). Kept pure so the buffer-scan logic can be unit-tested against a
 * headless xterm.
 */

export interface NoticePlacement {
  /** Number of `\r\n` to emit before positioning; each scrolls the buffer up one line. */
  scrollFirst: number;
  /** Viewport-relative row (0-based) the notice should be written to. */
  targetRow: number;
}

/**
 * Compute where a `placeAtBottom` notice must go so it never overwrites
 * history. The cursor after replaying a serialized snapshot is unreliable
 * (the snapshot tail repositions it, and `\x1b[?1049l` restores a stale saved
 * cursor), so the last content row is derived from the buffer itself instead
 * of the cursor.
 *
 * The notice goes on the first row below ALL content. When content fills the
 * viewport, the buffer is scrolled first so a blank row becomes available.
 */
export function computeNoticePlacement(
  getLineText: (row: number) => string,
  cursorRow: number,
  rows: number,
  noticeRows = 1
): NoticePlacement {
  let lastContentRow = -1;
  for (let row = rows - 1; row >= 0; row -= 1) {
    if (getLineText(row).length > 0) {
      lastContentRow = row;
      break;
    }
  }
  const lastUsedRow = Math.max(lastContentRow, Math.min(cursorRow, rows - 1));

  // All `noticeRows` lines of the notice must fit below the last used row.
  const freeBelow = rows - 1 - lastUsedRow;
  if (freeBelow >= noticeRows) {
    return { scrollFirst: 0, targetRow: lastUsedRow + 1 };
  }
  // Content reaches too low: scroll up until the bottom holds enough blank
  // rows for the whole notice.
  return { scrollFirst: noticeRows - freeBelow, targetRow: rows - noticeRows };
}

/**
 * Scroll counts for pushing `[...history][notice]` fully into scrollback so
 * the incoming shell gets a clean viewport. With the notice at `targetRow`,
 * `targetRow + 1` line feeds move every content row (and the notice) above
 * the viewport; ED2 then only clears blank rows.
 */
export function computeNoticeScrollLines(targetRow: number, rows: number, noticeRows = 1): number {
  return Math.min(rows, Math.max(1, targetRow + noticeRows));
}

/**
 * Mode/scroll-region reset emitted before a `placeAtBottom` notice. Exits the
 * alternate buffer, resets SGR/modes and clears DECSTBM so subsequent line
 * feeds scroll the full viewport. Note: `\x1b[?1049l` restores a stale saved
 * cursor in xterm.js, so every position after this reset must be absolute.
 */
export const NOTICE_RESET_PLACE_AT_BOTTOM =
  '\x1b[?1049l\x1b[0m\x1b[r\x1b[?6l\x1b[4l\x1b[?1l\x1b[?7h\x1b[?25h';

/**
 * Absolute-positioned write that places the notice at `placement.targetRow`:
 * park at the viewport bottom first (`\r\n` only scrolls when issued from the
 * bottom row), scroll if needed, CUP to the target row, clear it defensively
 * (it is always blank), then write the notice.
 */
export function buildNoticeWriteSequence(
  notice: string,
  placement: NoticePlacement,
  rows: number
): string {
  return (
    `\x1b[${rows};1H${'\r\n'.repeat(placement.scrollFirst)}` +
    `\x1b[${placement.targetRow + 1};1H\x1b[2K${notice}`
  );
}

/**
 * Push `[...history][notice]` above the viewport and clear the (blank)
 * viewport for the incoming shell.
 */
export function buildNoticeScrollSequence(targetRow: number, rows: number, noticeRows = 1): string {
  const scrollLines = computeNoticeScrollLines(targetRow, rows, noticeRows);
  return `\x1b[${rows};1H${'\r\n'.repeat(scrollLines)}\x1b[2J\x1b[H`;
}
