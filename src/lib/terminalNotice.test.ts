import { describe, expect, it } from 'vitest';
import { Terminal } from '@xterm/xterm';
import {
  NOTICE_RESET_PLACE_AT_BOTTOM,
  buildNoticeScrollSequence,
  buildNoticeWriteSequence,
  computeNoticePlacement,
  computeNoticeScrollLines
} from './terminalNotice';

const NOTICE = '\x1b[90m[已恢复上次会话的滚动缓冲]\x1b[0m';

function lineText(term: Terminal, row: number): string {
  return term.buffer.active.getLine(row)?.translateToString(true) ?? '';
}

function writeAsync(term: Terminal, data: string): Promise<void> {
  return new Promise((resolve) => {
    term.write(data, resolve);
  });
}

/** Full placeAtBottom sequence, mirroring XtermCanvas.writeScrollbackNotice. */
async function writePlaceAtBottomNotice(term: Terminal, notice: string): Promise<void> {
  await writeAsync(term, NOTICE_RESET_PLACE_AT_BOTTOM);
  term.scrollToBottom();
  const buffer = term.buffer.active;
  const placement = computeNoticePlacement(
    (row) => buffer.getLine(buffer.baseY + row)?.translateToString(true) ?? '',
    buffer.cursorY,
    term.rows
  );
  await writeAsync(term, buildNoticeWriteSequence(notice, placement, term.rows));
  await writeAsync(term, buildNoticeScrollSequence(placement.targetRow, term.rows));
}

/** All non-empty lines from scrollback start to viewport end, in order. */
function allContentLines(term: Terminal): string[] {
  const buffer = term.buffer.active;
  const lines: string[] = [];
  for (let row = 0; row < buffer.length; row += 1) {
    const text = lineText(term, row);
    if (text.length > 0) {
      lines.push(text);
    }
  }
  return lines;
}

describe('computeNoticePlacement', () => {
  it('places the notice on the first row below short content', () => {
    const getLineText = (row: number) => (row === 2 ? 'content' : '');
    expect(computeNoticePlacement(getLineText, 2, 10)).toEqual({
      scrollFirst: 0,
      targetRow: 3
    });
  });

  it('scrolls once when content fills the viewport', () => {
    const getLineText = (row: number) => (row === 9 ? 'bottom' : '');
    expect(computeNoticePlacement(getLineText, 9, 10)).toEqual({
      scrollFirst: 1,
      targetRow: 9
    });
  });

  it('keeps the target below the cursor when it trails the content', () => {
    const getLineText = (row: number) => (row === 1 ? 'content' : '');
    expect(computeNoticePlacement(getLineText, 4, 10)).toEqual({
      scrollFirst: 0,
      targetRow: 5
    });
  });

  it('ignores a stale cursor parked above or inside the content', () => {
    // Regression: `\x1b[?1049l` restores the cursor to (0,0) and serialized
    // snapshot tails can park it mid-content. Either way the notice must go
    // below the last content row, never on a content row.
    const getLineText = (row: number) => (row >= 3 && row <= 5 ? 'history' : '');
    expect(computeNoticePlacement(getLineText, 0, 10)).toEqual({
      scrollFirst: 0,
      targetRow: 6
    });
    expect(computeNoticePlacement(getLineText, 4, 10)).toEqual({
      scrollFirst: 0,
      targetRow: 6
    });
  });
});

describe('computeNoticeScrollLines', () => {
  it('pushes the notice row and everything above it out of the viewport', () => {
    expect(computeNoticeScrollLines(0, 10)).toBe(1);
    expect(computeNoticeScrollLines(5, 10)).toBe(6);
    expect(computeNoticeScrollLines(9, 10)).toBe(10);
  });
});

describe('placeAtBottom notice sequence', () => {
  it('preserves restored history, keeps the notice on its own line and clears the viewport', async () => {
    const term = new Terminal({ cols: 40, rows: 6, scrollback: 100 });
    // Snapshot replay ends mid-line after the last content character.
    const history = ['SUBST', 'SYSTEMINFO', 'TASKLIST', 'TASKKILL', 'TIME', 'TITLE'];
    await writeAsync(term, history.join('\r\n'));

    await writePlaceAtBottomNotice(term, NOTICE);

    const content = allContentLines(term);
    // Every history line survives, in order, with the notice as the final
    // line — nothing overwritten, nothing swallowed by the clear.
    expect(content).toEqual([...history, '[已恢复上次会话的滚动缓冲]']);

    // The notice ended up in scrollback: viewport is blank for the new shell.
    const buffer = term.buffer.active;
    expect(buffer.baseY).toBeGreaterThan(0);
    for (let row = 0; row < term.rows; row += 1) {
      expect(lineText(term, buffer.baseY + row)).toBe('');
    }
  });

  it('survives a stale home cursor left by the mode reset', async () => {
    const term = new Terminal({ cols: 40, rows: 6, scrollback: 100 });
    const history = ['line-a', 'line-b', 'line-c'];
    await writeAsync(term, history.join('\r\n'));
    // Simulate `\x1b[?1049l` restoring a stale saved cursor to (0,0).
    await writeAsync(term, '\x1b[H');

    await writePlaceAtBottomNotice(term, NOTICE);

    expect(allContentLines(term)).toEqual([...history, '[已恢复上次会话的滚动缓冲]']);
  });

  it('handles content filling the whole viewport', async () => {
    const term = new Terminal({ cols: 40, rows: 4, scrollback: 100 });
    const history = ['row-0', 'row-1', 'row-2', 'row-3'];
    await writeAsync(term, history.join('\r\n'));

    await writePlaceAtBottomNotice(term, NOTICE);

    expect(allContentLines(term)).toEqual([...history, '[已恢复上次会话的滚动缓冲]']);
    const buffer = term.buffer.active;
    for (let row = 0; row < term.rows; row += 1) {
      expect(lineText(term, buffer.baseY + row)).toBe('');
    }
  });

  it('clears a stale scroll region so the scroll sequence moves the whole viewport', async () => {
    const term = new Terminal({ cols: 40, rows: 4, scrollback: 100 });
    // Snapshot left a DECSTBM region over rows 1-2 (0-based).
    await writeAsync(term, 'row-0\r\nrow-1\r\nrow-2\r\nrow-3\x1b[2;3r');
    await writeAsync(term, '\x1b[4;1H');

    await writePlaceAtBottomNotice(term, NOTICE);

    expect(allContentLines(term)).toEqual([
      'row-0',
      'row-1',
      'row-2',
      'row-3',
      '[已恢复上次会话的滚动缓冲]'
    ]);
  });
});
