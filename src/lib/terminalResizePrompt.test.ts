import { describe, expect, it } from 'vitest';
import headless from '@xterm/headless';
import { buildCursorGroupResizePlan, buildCursorRestore } from './terminalCursorReflow';

/**
 * Regression tests for the "cursor jumps a row / an extra prompt appears"
 * report on Git Bash, PowerShell 5 and pwsh.
 *
 * Those shells redraw their prompt on SIGWINCH. Parking the cursor on a blank
 * row below the prompt therefore put the caret one row below the text, and the
 * shell's repaint then drew its prompt on a new line. The park step exists for
 * the opposite case — a prompt (or typed command) wider than the new grid,
 * where `Terminal.resize()` would truncate the cursor row and ConPTY, in
 * resize-quirk mode, never repaints the loss.
 *
 * These tests pin both halves: no park when nothing would be lost, park when
 * something would.
 */

type Terminal = headless.Terminal;

function makeTerminal(cols: number, rows = 10): Terminal {
  return new headless.Terminal({
    allowProposedApi: true,
    cols,
    rows,
    scrollback: 1000,
    // Local sessions on Windows run under ConPTY; the option also selects
    // xterm's ConPTY reflow strategy.
    windowsPty: { backend: 'conpty', buildNumber: 26200 }
  });
}

function write(terminal: Terminal, data: string): Promise<void> {
  return new Promise((resolve) => terminal.write(data, resolve));
}

function lineText(terminal: Terminal, y: number): string {
  return terminal.buffer.active.getLine(y)?.translateToString(true) ?? '';
}

function isWrapped(terminal: Terminal, y: number): boolean {
  return terminal.buffer.active.getLine(y)?.isWrapped ?? false;
}

interface ResizeOutcome {
  parked: boolean;
  cursorX: number;
  cursorY: number;
  /** Text on the row the cursor ended up on, blanks trimmed from the right. */
  cursorLine: string;
}

/** Resize exactly like XtermCanvas.applyResize(): park, resize, restore. */
async function resizeColumns(terminal: Terminal, cols: number): Promise<ResizeOutcome> {
  const plan = buildCursorGroupResizePlan(terminal.buffer.active, cols, terminal.rows);
  if (plan) {
    await write(terminal, plan.before);
  }
  terminal.resize(cols, terminal.rows);
  if (plan) {
    const restore = buildCursorRestore(terminal.buffer.active, plan, terminal.rows);
    if (restore) {
      await write(terminal, restore);
    }
  }
  const active = terminal.buffer.active;
  return {
    parked: plan !== null,
    cursorX: active.cursorX,
    cursorY: active.cursorY,
    cursorLine: lineText(terminal, active.baseY + active.cursorY)
  };
}

/** msys2 / Git Bash style prompt: the path line, then `$ ` on its own row. */
const GIT_BASH_PROMPT = 'user@host MINGW64 /c/Users/someone/very/long/project/path\r\n$ ';

describe('horizontal resize with prompts that redraw on SIGWINCH', () => {
  it('keeps a two-line Git Bash prompt in place and does not park', async () => {
    const terminal = makeTerminal(30);
    await write(terminal, GIT_BASH_PROMPT);
    expect(lineText(terminal, 2)).toBe('$ ');

    const after = await resizeColumns(terminal, 18);

    // Nothing on the `$ ` row overflows, so the cursor row survives the shrink
    // untouched and xterm reflows the wrapped path above it by itself.
    expect(after.parked).toBe(false);
    // The prompt is still the last thing on screen and the caret follows it:
    // a parked cursor would have ended on the empty row below instead.
    expect(after.cursorLine).toBe('$ ');
    expect(after.cursorX).toBe(2);
    // The path rewrapped as a group (rows 0-3 at 18 columns) and the `$ ` row
    // stayed directly above the caret row, with no blank line inserted.
    expect(isWrapped(terminal, 1)).toBe(true);
    expect(lineText(terminal, after.cursorY - 1)).toBe('ath');
    expect(lineText(terminal, after.cursorY + 1)).toBe('');
  });

  it('keeps a short PowerShell 5 prompt on its own row', async () => {
    const terminal = makeTerminal(40);
    await write(terminal, 'PS C:\\Users\\someone> ');

    const after = await resizeColumns(terminal, 22);

    expect(after.parked).toBe(false);
    // `PS C:\Users\someone> ` is 20 columns and fits 22, so it must not be
    // split and the caret must stay on it rather than dropping to row 1.
    expect(after.cursorY).toBe(0);
    expect(after.cursorLine.trimEnd()).toBe('PS C:\\Users\\someone>');
    expect(lineText(terminal, 1)).toBe('');
  });

  it('does not park when the prompt would not be truncated', async () => {
    const terminal = makeTerminal(40);
    await write(terminal, 'PS C:\\Users\\someone\\code\\project> ');

    const after = await resizeColumns(terminal, 30);

    // 36 columns of prompt at 30 columns: still a park, because the tail
    // (`project> `) would be cut off otherwise.
    expect(after.parked).toBe(true);
    // Whatever route it took, the whole prompt must still be readable and the
    // caret must sit at its end.
    const rows = [0, 1, 2].map((y) => lineText(terminal, y));
    expect(rows.join('')).toContain('code');
    expect(rows.join('')).toContain('project>');
    expect(after.cursorLine.endsWith('> ') || after.cursorLine.endsWith('>')).toBe(true);
  });

  it('still parks a ConPTY prompt whose tail would be truncated', async () => {
    const terminal = makeTerminal(30);
    await write(terminal, 'C:\\Users\\46838>');

    const after = await resizeColumns(terminal, 10);

    // ConPTY never repaints, so losing the tail here is unrecoverable.
    expect(after.parked).toBe(true);
    expect(lineText(terminal, 0) + lineText(terminal, 1)).toBe('C:\\Users\\46838>');
    expect(after.cursorLine).toBe('6838>');
  });

  it('leaves a wrapped typed command intact when shrinking', async () => {
    const terminal = makeTerminal(40);
    await write(terminal, 'PS C:\\> git status --short --branch');

    const after = await resizeColumns(terminal, 12);

    const rows = [0, 1, 2, 3].map((y) => lineText(terminal, y)).join('');
    expect(rows.replace(/\s+$/, '')).toBe(
      'PS C:\\> git status --short --branch'.replace(/\s+$/, '')
    );
    // The caret parks after the last command character, never on a blank row.
    expect(after.cursorLine.trim()).not.toBe('');
  });
});
