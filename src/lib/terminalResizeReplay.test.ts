import { describe, expect, it } from 'vitest';
import headless from '@xterm/headless';
import { trimConptyResizeRepaint } from './terminalResizeRepaint';
import { shouldCommitConptyPendingWrap } from './terminalResizePendingWrap';

const { Terminal } = headless;

type HeadlessTerminal = InstanceType<typeof Terminal>;

/**
 * Regression tests against real vt sequences.
 *
 * The ConPTY bytes were captured from the bundled ConPTY 1.25 with cmd.exe:
 * it emits a cursor-line repaint on resize (CUP, erase, CUP, text+padding,
 * CUP), not a full reprint. xterm must have reflowed the group already; only
 * the trailing padding is stripped. Never disable autowrap for the whole
 * batch: at 16-18 columns the repaint text itself wraps at the last column.
 *
 * The readline bytes mirror `_rl_redisplay_after_sigwinch()`: move to the
 * current cursor row, erase it, move up the old row count, redraw prompt and
 * input. The cursor line must not be reflowed or parked underneath it.
 */

const CMD_BOOT =
  '\x1b[1t\x1b[c\x1b[?1004h\x1b[?9001h\x1b[?7l\x1b[?7h' +
  'Microsoft Windows [版本 10.0.26200.8875]\r\n' +
  '(c) Microsoft Corporation。保留所有权利。\r\n\r\n' +
  'C:\\Users\\46838>';
const CMD_TYPED_HELP = '\x1b[4;16Hhelp\x1b[4;20H';
const CMD_SHRINK_12 = '\x1b[11;4H\x1b[J\x1b[11;4Hhelp            \x1b[11;8H';
const CMD_TYPED_X = '\x1b[11;8HX\x1b[11;9H';
const CMD_GROW_100 = '\x1b[4;16H\x1b[J\x1b[4;16HhelpX\x1b[4;21H';
const CMD_TYPED_Y = '\x1b[4;21HY\x1b[4;22H';

const BASH_PROMPT = 'dietpi@NanoPC-T4:~$ ';
const BASH_INPUT = 'help';
const BASH_REDRAW = `\r\x1b[K${BASH_PROMPT}${BASH_INPUT}`;

function makeCmd(cols = 100, rows = 30): HeadlessTerminal {
  return new Terminal({
    allowProposedApi: true,
    cols,
    rows,
    scrollback: 1000,
    reflowCursorLine: true,
    windowsPty: { backend: 'conpty', buildNumber: 26200 }
  });
}

function makeBash(cols: number, rows = 24): HeadlessTerminal {
  return new Terminal({
    allowProposedApi: true,
    cols,
    rows,
    scrollback: 1000,
    reflowCursorLine: false
  });
}

function write(terminal: HeadlessTerminal, data: string): Promise<void> {
  return new Promise((resolve) => (data.length ? terminal.write(data, resolve) : resolve()));
}

/** xterm.resize() plus the captured backend repaint with its padding trimmed. */
async function resizeWithRepaintTrim(
  terminal: HeadlessTerminal,
  cols: number,
  rows: number,
  backendRepaint: string
): Promise<void> {
  terminal.resize(cols, rows);
  await write(terminal, trimConptyResizeRepaint(backendRepaint));
}

function lineText(terminal: HeadlessTerminal, y: number): string {
  return terminal.buffer.active.getLine(y)?.translateToString(true) ?? '';
}

describe('ConPTY cmd cursor-line reflow', () => {
  it('keeps the prompt and typed text aligned across shrink and grow', async () => {
    const terminal = makeCmd();
    await write(terminal, CMD_BOOT + CMD_TYPED_HELP);

    await resizeWithRepaintTrim(terminal, 12, 30, CMD_SHRINK_12);

    // The prompt reflows above the cursor; the cursor sits at the end of
    // "38>help" instead of a phantom blank row.
    expect(lineText(terminal, 9)).toBe('C:\\Users\\468');
    expect(lineText(terminal, 10).trimEnd()).toBe('38>help');
    expect(terminal.buffer.active.cursorX).toBe(7);
    expect(terminal.buffer.active.cursorY).toBe(10);
    expect(lineText(terminal, 11)).toBe('');

    await write(terminal, CMD_TYPED_X);
    expect(lineText(terminal, 10).trimEnd()).toBe('38>helpX');
    expect(terminal.buffer.active.cursorX).toBe(8);

    await resizeWithRepaintTrim(terminal, 100, 30, CMD_GROW_100);
    expect(lineText(terminal, 3)).toBe('C:\\Users\\46838>helpX');
    expect(terminal.buffer.active.cursorX).toBe(20);
    expect(terminal.buffer.active.cursorY).toBe(3);

    await write(terminal, CMD_TYPED_Y);
    expect(lineText(terminal, 3)).toBe('C:\\Users\\46838>helpXY');
    expect(terminal.buffer.active.cursorX).toBe(21);
  });

  it.each([
    // 13-18 columns expose the edge where the repaint text itself wraps at
    // the last column. Disabling autowrap for the batch used to lose "elp".
    [13, '\x1b[11;3H\x1b[J\x1b[11;3Hhelp             \x1b[11;7H', '\x1b[11;7HX\x1b[11;8H'],
    [14, '\x1b[9;2H\x1b[J\x1b[9;2Hhelp              \x1b[9;6H', '\x1b[9;6HX\x1b[9;7H'],
    [15, '\x1b[9;1H\x1b[J\x1b[9;1Hhelp               \x1b[9;5H', '\x1b[9;5HX\x1b[9;6H'],
    [16, '\x1b[8;16H\x1b[J\x1b[8;16Hhelp\x1b[9;4H', '\x1b[9;4HX\x1b[9;5H'],
    [17, '\x1b[8;16H\x1b[J\x1b[8;16Hhelp\x1b[9;3H', '\x1b[9;3HX\x1b[9;4H'],
    [18, '\x1b[8;16H\x1b[J\x1b[8;16Hhelp\x1b[9;2H', '\x1b[9;2HX\x1b[9;3H']
  ])('keeps the logical prompt line intact at %i columns', async (cols, repaint, typedX) => {
    const terminal = makeCmd();
    await write(terminal, CMD_BOOT + CMD_TYPED_HELP);

    await resizeWithRepaintTrim(terminal, cols, 30, repaint);
    await write(terminal, typedX);

    const buffer = terminal.buffer.active;
    let start = buffer.baseY;
    while (
      start < buffer.baseY + buffer.cursorY &&
      !lineText(terminal, start).startsWith('C:\\Users')
    ) {
      start += 1;
    }
    let text = '';
    for (let y = start; y <= buffer.baseY + buffer.cursorY; y++) {
      text += lineText(terminal, y);
    }
    expect(text).toBe('C:\\Users\\46838>helpX');
    expect(lineText(terminal, buffer.baseY + buffer.cursorY + 1)).toBe('');
  });

  it('does not scroll the viewport when the prompt is on the last row', async () => {
    const terminal = makeCmd();
    // Boot, then 45 empty commands: the prompt ends up on the last row and
    // the scrollback is populated, matching the captured bottom-row probe.
    const scroll = `\x1b[4;16H${'\r\nC:\\Users\\46838>'.repeat(45)}`;
    await write(terminal, CMD_BOOT + scroll + '\x1b[30;16Hhelp\x1b[30;20H');
    expect(terminal.buffer.active.cursorY).toBe(29);

    await resizeWithRepaintTrim(
      terminal,
      12,
      30,
      '\x1b[30;4H\x1b[J\x1b[30;4Hhelp            \x1b[30;8H'
    );

    const bottom = terminal.buffer.active.baseY + terminal.rows - 1;
    expect(lineText(terminal, bottom - 1)).toBe('C:\\Users\\468');
    expect(lineText(terminal, bottom).trimEnd()).toBe('38>help');
    expect(terminal.buffer.active.cursorX).toBe(7);
    expect(terminal.buffer.active.cursorY).toBe(29);

    await write(terminal, '\x1b[30;8HX\x1b[30;9H');
    expect(lineText(terminal, bottom).trimEnd()).toBe('38>helpX');
    expect(terminal.buffer.active.cursorX).toBe(8);
    expect(terminal.buffer.active.cursorY).toBe(29);
  });

  it('commits the pending wrap when the prompt exactly fills the last row', async () => {
    const terminal = makeCmd();
    const scroll = `\x1b[4;16H${'\r\nC:\\Users\\46838>'.repeat(45)}`;
    await write(terminal, CMD_BOOT + scroll);
    expect(terminal.buffer.active.cursorY).toBe(29);

    // 15 columns: the 15-char prompt exactly fills the bottom row. ConPTY
    // emits nothing on resize but has already scrolled internally, so its
    // next CUP targets a fresh bottom row.
    terminal.resize(15, 30);
    await write(terminal, '');
    expect(
      shouldCommitConptyPendingWrap(terminal.buffer.active, terminal.cols, terminal.rows)
    ).toBe(true);
    await write(terminal, '\n');
    await write(terminal, '\x1b[30;1Hhelp\x1b[30;5H');
    await write(terminal, '\x1b[30;5HX\x1b[30;6H');

    const bottom = terminal.buffer.active.baseY + terminal.rows - 1;
    expect(lineText(terminal, bottom - 1)).toBe('C:\\Users\\46838>');
    expect(lineText(terminal, bottom).trimEnd()).toBe('helpX');
    expect(terminal.buffer.active.cursorX).toBe(5);
    expect(terminal.buffer.active.cursorY).toBe(29);
  });
});

describe('readline shell repaint', () => {
  it('does not duplicate the prompt when shrinking', async () => {
    const terminal = makeBash(80);
    await write(terminal, BASH_PROMPT + BASH_INPUT);

    terminal.resize(22, 24);
    await write(terminal, '');
    await write(terminal, BASH_REDRAW);

    expect(lineText(terminal, 0)).toBe('dietpi@NanoPC-T4:~$ he');
    expect(lineText(terminal, 1)).toBe('lp');
    expect(lineText(terminal, 2)).toBe('');
    expect(terminal.buffer.active.cursorX).toBe(2);
    expect(terminal.buffer.active.cursorY).toBe(1);
  });

  it('does not swallow the line above when growing a wrapped prompt', async () => {
    const terminal = makeBash(22);
    await write(terminal, `previous\r\n${BASH_PROMPT}${BASH_INPUT}`);
    expect(terminal.buffer.active.cursorY).toBe(2);

    terminal.resize(80, 24);
    await write(terminal, '');
    // _rl_redisplay_after_sigwinch: erase the current row, move up the old
    // row count (1), then redraw the whole prompt from there.
    await write(terminal, `\r\x1b[K\x1b[1A${BASH_PROMPT}${BASH_INPUT}`);

    expect(lineText(terminal, 0)).toBe('previous');
    expect(lineText(terminal, 1)).toBe('dietpi@NanoPC-T4:~$ help');
    expect(lineText(terminal, 2)).toBe('');
    expect(terminal.buffer.active.cursorX).toBe(24);
    expect(terminal.buffer.active.cursorY).toBe(1);
  });
});
