/**
 * xterm.js never reflows the wrapped line group containing the cursor
 * (Buffer._reflowSmaller and reflowLargerGetLinesToRemove both skip it: "the
 * program will handle fixing up wrapped lines with the cursor"), and
 * Buffer.resize then truncates every line to the new width. Unix shells heal
 * that line by redrawing it on SIGWINCH, but a ConPTY session in resize-quirk
 * mode emits no repaint on resize at all, so the truncated tail is lost
 * permanently (e.g. `C:\Users\46838>` degrading to `C:\Users\46`) and every
 * later absolute cursor move from ConPTY lands on a different layout.
 *
 * The workaround: right before a cols-changing resize, move the cursor onto
 * the blank row below its wrapped group ("parking" it). The group no longer
 * contains the cursor, so xterm's own reflow wraps/rejoins it like any other
 * content — with correct isWrapped flags and cell attributes intact — which
 * is the same greedy rewrap ConPTY performs internally. After the resize the
 * cursor is restored to the position ConPTY's rewrap implies: the parked row
 * sits directly below the group, so the group's new start row is
 * (parked row) - (group rows after reflow).
 *
 * When the layout would not change, or the group is not fully visible with a
 * blank park row inside the viewport, no plan is produced and the stock
 * resize behavior applies.
 */

/** Structural subset of xterm's IBufferLine, shared with @xterm/headless. */
export interface ReflowBufferLine {
  readonly isWrapped: boolean;
  readonly length: number;
  getCell(x: number): { getWidth(): number; getChars(): string } | undefined;
  translateToString(trimRight?: boolean): string;
}

/** Structural subset of xterm's IBuffer. */
export interface ReflowBuffer {
  readonly type: 'normal' | 'alternate';
  readonly baseY: number;
  readonly cursorX: number;
  readonly cursorY: number;
  readonly length: number;
  getLine(y: number): ReflowBufferLine | undefined;
}

export interface CursorGroupResizePlan {
  /** CUP writing the cursor onto the park row; write before Terminal.resize(). */
  before: string;
  /** Row count the wrapped group occupies after the reflow. */
  rowsAfter: number;
  /** Cursor cell offset inside the reflowed group. */
  cursorSeg: number;
  cursorCol: number;
}

export function cupCursor(row1: number, col1: number): string {
  return `\x1b[${row1};${col1}H`;
}

function collectCells(line: ReflowBufferLine): { chars: string; width: number }[] {
  const cells: { chars: string; width: number }[] = [];
  for (let x = 0; x < line.length; x++) {
    const cell = line.getCell(x);
    if (!cell) {
      break;
    }
    const chars = cell.getChars();
    const width = cell.getWidth();
    if (width === 0) {
      // Combining mark: xterm merges it into the base cell, but guard anyway.
      if (chars && cells.length > 0) {
        cells[cells.length - 1].chars += chars;
      }
      continue;
    }
    cells.push({ chars, width });
  }
  // Trim trailing blanks the same way xterm's reflow treats line ends.
  while (
    cells.length > 0 &&
    (cells[cells.length - 1].chars === '' || cells[cells.length - 1].chars === ' ')
  ) {
    cells.pop();
  }
  return cells;
}

/**
 * Compute the park/restore plan for a resize to `targetCols`, or null when
 * the current layout already matches or the situation is not supported.
 */
export function buildCursorGroupResizePlan(
  buffer: ReflowBuffer,
  targetCols: number,
  viewportRows: number
): CursorGroupResizePlan | null {
  if (buffer.type !== 'normal' || targetCols < 2) {
    return null;
  }

  const cursorAbsY = buffer.baseY + buffer.cursorY;
  let startY = cursorAbsY;
  while (startY > 0 && buffer.getLine(startY)?.isWrapped) {
    startY--;
  }
  let endY = cursorAbsY;
  while (endY + 1 < buffer.length && buffer.getLine(endY + 1)?.isWrapped) {
    endY++;
  }

  // The restore CUP targets the viewport, and the park row must be on screen.
  const top = startY - buffer.baseY;
  const bottom = endY - buffer.baseY;
  if (top < 0 || bottom + 1 > viewportRows - 1) {
    return null;
  }
  // The park row sits directly below the group and must be blank: the math
  // "group start = parked row - rowsAfter" depends on that adjacency, and a
  // blank row is never harmed by being skipped during reflow.
  const parkAbsY = endY + 1;
  const parkLine = buffer.getLine(parkAbsY);
  if (!parkLine || parkLine.translateToString(true) !== '') {
    return null;
  }

  const groupCells: { chars: string; width: number }[] = [];
  const lineCells: { chars: string; width: number }[][] = [];
  for (let y = startY; y <= endY; y++) {
    const line = buffer.getLine(y);
    if (!line) {
      return null;
    }
    const cells = collectCells(line);
    lineCells.push(cells);
    groupCells.push(...cells);
  }

  // Cursor offset inside the group's concatenated cells. The offset may sit
  // past the trimmed content (cursor after trailing blanks) — clamp to the end.
  let cursorOffset = buffer.cursorX;
  for (let y = startY; y < cursorAbsY; y++) {
    cursorOffset += lineCells[y - startY].length;
  }
  cursorOffset = Math.min(cursorOffset, groupCells.length);

  // Greedy wrap at the target width — the rewrap ConPTY performs internally —
  // tracking where the cursor offset lands.
  const segments: { chars: string; width: number }[][] = [];
  let current: { chars: string; width: number }[] = [];
  let currentWidth = 0;
  let cursorSeg = 0;
  let cursorCol = 0;
  for (let i = 0; i < groupCells.length; i++) {
    const cell = groupCells[i];
    if (currentWidth > 0 && currentWidth + cell.width > targetCols) {
      segments.push(current);
      current = [];
      currentWidth = 0;
    }
    if (i === cursorOffset) {
      cursorSeg = segments.length;
      cursorCol = currentWidth;
    }
    current.push(cell);
    currentWidth += cell.width;
  }
  segments.push(current);
  if (cursorOffset >= groupCells.length) {
    cursorSeg = segments.length - 1;
    cursorCol = currentWidth;
  }
  cursorCol = Math.min(cursorCol, targetCols - 1);

  // Already laid out exactly as the target requires — stock resize suffices.
  const groupHeight = endY - startY + 1;
  if (segments.length === groupHeight) {
    let identical = true;
    for (let i = 0; i < segments.length; i++) {
      const line = buffer.getLine(startY + i);
      const text = segments[i].map((cell) => cell.chars).join('');
      if (!line || line.translateToString(true) !== text) {
        identical = false;
        break;
      }
    }
    if (identical) {
      return null;
    }
  }

  return {
    before: cupCursor(parkAbsY - buffer.baseY + 1, 1),
    rowsAfter: segments.length,
    cursorSeg,
    cursorCol
  };
}

/**
 * CUP restoring the cursor after the resize: the parked row moved with the
 * reflow, and the group now ends directly above it.
 */
export function buildCursorRestore(
  buffer: ReflowBuffer,
  plan: CursorGroupResizePlan,
  viewportRows: number
): string | null {
  const groupStart = buffer.baseY + buffer.cursorY - plan.rowsAfter;
  const row = groupStart + plan.cursorSeg;
  if (row < 0 || row > viewportRows - 1 || plan.cursorCol < 0) {
    return null;
  }
  return cupCursor(row + 1, plan.cursorCol + 1);
}
