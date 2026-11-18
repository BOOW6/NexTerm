/**
 * ConPTY commits a pending wrap at resize time when the cursor sits in the
 * last cell of the bottom row: internally the line wraps, the viewport scrolls
 * one row, and the next input is positioned with CUP on the new bottom row.
 * xterm has no pending-wrap commit: it keeps the prompt on the old bottom row,
 * so the next CUP overwrites the prompt (cmd echoes `help` at row 30 col 1).
 *
 * Detect that exact state after a shrink and emit one LF so xterm scrolls the
 * same way ConPTY did. This is only valid for the normal buffer.
 */
export interface PendingWrapBufferLine {
  getCell(x: number): { getWidth(): number; getChars(): string } | undefined;
}

export interface PendingWrapBuffer {
  readonly type: 'normal' | 'alternate';
  readonly baseY: number;
  readonly cursorX: number;
  readonly cursorY: number;
  getLine(y: number): PendingWrapBufferLine | undefined;
}

export function shouldCommitConptyPendingWrap(
  buffer: PendingWrapBuffer,
  cols: number,
  rows: number
): boolean {
  if (buffer.type !== 'normal' || cols < 2 || rows < 1) {
    return false;
  }
  // xterm keeps a pending-wrap cursor at `cols` (one past the last cell) until
  // the next printable, but Buffer.resize clamps it to `cols - 1`. Accept both
  // spellings of "at/after the last column".
  if (buffer.cursorY !== rows - 1 || buffer.cursorX < cols - 1) {
    return false;
  }
  const line = buffer.getLine(buffer.baseY + buffer.cursorY);
  if (!line) {
    return false;
  }
  const cell = line.getCell(cols - 1);
  if (!cell || cell.getWidth() === 0) {
    return false;
  }
  return cell.getChars().trim() !== '';
}
