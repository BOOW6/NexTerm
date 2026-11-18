/**
 * ConPTY commits a pending wrap at resize time when the cursor is already
 * past the last glyph of the bottom row and that row will exactly fill the
 * new width: internally the line wraps, the viewport scrolls one row, and the
 * next input is positioned with CUP on the new bottom row. xterm has no
 * pending-wrap commit: it keeps the prompt on the old bottom row, so the next
 * CUP overwrites the prompt (cmd echoes `help` at row 30 col 1).
 *
 * Detect that state *before* `resize()`. Afterwards xterm clamps a pending-wrap
 * cursor (`cursorX === cols`) down to `cols - 1`, which is indistinguishable
 * from the cursor sitting on the last glyph — and ConPTY does not scroll for
 * the latter. Wide glyphs occupy two cells; the trailing half has width 0 and
 * must not be treated as an empty last column.
 *
 * This is only valid for the normal buffer, and only when shrinking.
 */
export interface PendingWrapBufferLine {
  getCell(x: number): { getWidth(): number; getCode(): number } | undefined;
}

export interface PendingWrapBuffer {
  readonly type: 'normal' | 'alternate';
  readonly baseY: number;
  readonly cursorX: number;
  readonly cursorY: number;
  getLine(y: number): PendingWrapBufferLine | undefined;
}

/** Exclusive cell index just past the last written cell, accounting for wide cells. */
export function occupiedCellEnd(line: PendingWrapBufferLine, cols: number): number {
  let end = 0;
  for (let x = 0; x < cols; x += 1) {
    const cell = line.getCell(x);
    if (!cell || cell.getWidth() === 0) {
      continue;
    }
    // An untouched (or erased) cell has code 0. A space the user actually
    // typed has code 32 and occupies a cell — trimming by chars would treat
    // it as blank and miss a pending wrap that ConPTY does commit.
    if (cell.getCode() === 0) {
      continue;
    }
    end = x + cell.getWidth();
  }
  return end;
}

export function shouldCommitConptyPendingWrap(
  buffer: PendingWrapBuffer,
  cols: number,
  rows: number,
  targetCols: number = cols
): boolean {
  if (buffer.type !== 'normal' || cols < 2 || rows < 1 || targetCols < 2 || targetCols > cols) {
    return false;
  }
  if (buffer.cursorY !== rows - 1) {
    return false;
  }
  const line = buffer.getLine(buffer.baseY + buffer.cursorY);
  if (!line) {
    return false;
  }
  const contentEnd = occupiedCellEnd(line, cols);
  // The row must exactly fill the width ConPTY is about to adopt. A cursor
  // sitting on the last glyph (`cursorX < contentEnd`) is not a pending wrap.
  if (contentEnd !== targetCols || buffer.cursorX < contentEnd) {
    return false;
  }
  return true;
}
