import { describe, expect, it } from 'vitest';
import headless from '@xterm/headless';
import { ResizeRepaintFilter } from './terminalResizeRepaint';
import { shouldCommitConptyPendingWrap } from './terminalResizePendingWrap';

const { Terminal } = headless;

type HeadlessTerminal = InstanceType<typeof Terminal>;

/**
 * Regression tests against real vt sequences.
 *
 * The bundled-ConPTY bytes were captured by the probe
 * (`src-tauri/src/pty/conpty_resize_probe.rs`) with cmd.exe. Booting cmd at a
 * narrow width wraps the banner lines; widening re-joins them in BOTH ConPTY's
 * buffer and xterm's, and the cursor-line repaint re-anchors the cursor. The
 * repaint has three tail variants:
 *
 * - space padding (shrink with a wrapped cursor line);
 * - `\e[K` right before the final CUP (grow from a wrapped cursor line);
 * - bare final CUP (grow otherwise).
 *
 * Everything flows through `ResizeRepaintFilter.consume()` so the hold /
 * release behavior is exercised exactly like the app's pipeline. A stale
 * pre-resize echo CUP would land exactly N rows below the joined prompt
 * (N = re-joined groups), which is the duplicated-command bug this suite
 * guards against.
 *
 * The system-ConPTY bytes (probe without the bundled DLL) show the fallback
 * contract: an absolute-CUP boot screen, a FULL screen reprint on resize, and
 * raw echo without re-anchoring CUPs. The reprint must pass through the
 * filter untouched and leave nothing held.
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

/** 30-col boot: both banner lines wrap; widening re-joins two groups. */
const CMD_ECHO_30 = '\x1b[6;16Hfoobar\x1b[6;22H';
const CMD_REPAINT_WIDEN_30 = '\x1b[4;16H\x1b[J\x1b[4;16Hfoobar\x1b[4;22H';
const CMD_TYPED_X_WIDE = '\x1b[4;22HX\x1b[4;23H';

/** 18-col boot: the prompt line itself wraps; the grow repaint ends with `\e[K`. */
const CMD_ECHO_18 = '\x1b[8;16Hfoobar\x1b[9;4H';
const CMD_REPAINT_K = '\x1b[4;16H\x1b[J\x1b[4;16Hfoobar\x1b[K\x1b[4;22H';

/**
 * System ConPTY (bundled load failed): absolute-CUP boot screen, the banner's
 * split wide char emitted as a literal space, then a full screen reprint on
 * resize and raw echo.
 */
const SYS_BOOT =
  '\x1b[?9001h\x1b[?1004h\x1b[?25l\x1b[2J\x1b[m\x1b[H' +
  'Microsoft Windows [版本 10.0.26200.8875]\x1b]0;C:\\WINDOWS\\system32\\cmd.exe\x07\x1b[?25h\x1b[?25l\r\n' +
  '(c) Microsoft Corporation。保 留所有权利。\r\n' +
  '\x1b[6;1HC:\\Users\\46838>\x1b[?25h';
const SYS_REPRINT =
  '\x1b[?25l\x1b[8;30;100t\x1b[H' +
  'Microsoft Windows [版本 10.0.26200.8875]\x1b[K\r\n' +
  '(c) Microsoft Corporation。保留所有权利。\x1b[K\r\n' +
  '\x1b[K\r\n' +
  'C:\\Users\\46838>foobar\x1b[K\r\n' +
  '\x1b[K\r\n'.repeat(25) +
  '\x1b[K\x1b[4;22H\x1b[?25h';

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

/**
 * xterm.resize() plus the captured backend repaint, through the same filter
 * the app uses. Returns the filter so subsequent echo bytes can be routed
 * through `consume()` as well.
 */
async function resizeWithRepaint(
  terminal: HeadlessTerminal,
  cols: number,
  rows: number,
  backendRepaint: string,
  options: { settles?: boolean } = {}
): Promise<ResizeRepaintFilter> {
  const filter = new ResizeRepaintFilter();
  const output = filter.arm() + filter.consume(backendRepaint);
  expect(filter.takeCarry()).toBe('');
  terminal.resize(cols, rows);
  await write(terminal, output);
  if (options.settles ?? true) {
    expect(filter.isPending).toBe(false);
  }
  return filter;
}

function lineText(terminal: HeadlessTerminal, y: number): string {
  return terminal.buffer.active.getLine(y)?.translateToString(true) ?? '';
}

describe('ConPTY cmd cursor-line reflow', () => {
  it('keeps the prompt and typed text aligned across shrink and grow', async () => {
    const terminal = makeCmd();
    await write(terminal, CMD_BOOT + CMD_TYPED_HELP);

    const shrinkFilter = await resizeWithRepaint(terminal, 12, 30, CMD_SHRINK_12);

    // The prompt reflows above the cursor; the cursor sits at the end of
    // "38>help" instead of a phantom blank row.
    expect(lineText(terminal, 9)).toBe('C:\\Users\\468');
    expect(lineText(terminal, 10).trimEnd()).toBe('38>help');
    expect(terminal.buffer.active.cursorX).toBe(7);
    expect(terminal.buffer.active.cursorY).toBe(10);
    expect(lineText(terminal, 11)).toBe('');

    await write(terminal, shrinkFilter.consume(CMD_TYPED_X));
    expect(lineText(terminal, 10).trimEnd()).toBe('38>helpX');
    expect(terminal.buffer.active.cursorX).toBe(8);

    const growFilter = await resizeWithRepaint(terminal, 100, 30, CMD_GROW_100);
    expect(lineText(terminal, 3)).toBe('C:\\Users\\46838>helpX');
    expect(terminal.buffer.active.cursorX).toBe(20);
    expect(terminal.buffer.active.cursorY).toBe(3);

    await write(terminal, growFilter.consume(CMD_TYPED_Y));
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

    const filter = await resizeWithRepaint(terminal, cols, 30, repaint);
    await write(terminal, filter.consume(typedX));

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

    await resizeWithRepaint(
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

    // 15 columns: the 15-char prompt exactly fills the bottom row. Decide
    // before resize — afterwards xterm clamps the pending-wrap cursor onto
    // the last glyph and the two states are indistinguishable. ConPTY emits
    // nothing on resize but has already scrolled internally, so its next CUP
    // targets a fresh bottom row.
    expect(
      shouldCommitConptyPendingWrap(terminal.buffer.active, terminal.cols, terminal.rows, 15)
    ).toBe(true);
    terminal.resize(15, 30);
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

describe('bundled ConPTY: wrapped banner above the prompt', () => {
  it('re-joins the banner and echoes at the joined cursor row', async () => {
    const terminal = makeCmd(30);
    await write(terminal, CMD_BOOT);

    // Both banner lines wrap at 30 cols; the prompt sits below two groups
    // that widening will re-join.
    expect(lineText(terminal, 0)).toBe('Microsoft Windows [版本 10.0.2');
    expect(lineText(terminal, 1)).toBe('6200.8875]');
    expect(lineText(terminal, 2)).toBe('(c) Microsoft Corporation。保');
    expect(lineText(terminal, 3)).toBe('留所有权利。');
    expect(lineText(terminal, 4)).toBe('');
    expect(lineText(terminal, 5)).toBe('C:\\Users\\46838>');
    expect(terminal.buffer.active.cursorX).toBe(15);
    expect(terminal.buffer.active.cursorY).toBe(5);

    await write(terminal, CMD_ECHO_30);
    expect(lineText(terminal, 5)).toBe('C:\\Users\\46838>foobar');
    expect(terminal.buffer.active.cursorX).toBe(21);
    expect(terminal.buffer.active.cursorY).toBe(5);

    const filter = await resizeWithRepaint(terminal, 100, 30, CMD_REPAINT_WIDEN_30);
    expect(lineText(terminal, 0)).toBe('Microsoft Windows [版本 10.0.26200.8875]');
    expect(lineText(terminal, 1)).toBe('(c) Microsoft Corporation。保留所有权利。');
    expect(lineText(terminal, 2)).toBe('');
    expect(lineText(terminal, 3)).toBe('C:\\Users\\46838>foobar');
    expect(terminal.buffer.active.cursorX).toBe(21);
    expect(terminal.buffer.active.cursorY).toBe(3);

    await write(terminal, filter.consume(CMD_TYPED_X_WIDE));
    expect(lineText(terminal, 3)).toBe('C:\\Users\\46838>foobarX');
    expect(terminal.buffer.active.cursorX).toBe(22);
  });

  it('heals a pre-resize echo that is parsed after the reflow', async () => {
    const terminal = makeCmd(30);
    await write(terminal, CMD_BOOT);

    // The two-phase path keeps writes frozen across the backend ack, so an
    // echo produced at the old geometry can be parsed AFTER xterm's reflow.
    // The repaint that follows (new geometry) must erase it: cursor-line
    // CUP + erase-to-end covers every row below the caret.
    terminal.resize(100, 30);
    await write(terminal, CMD_ECHO_30 + CMD_REPAINT_WIDEN_30);

    expect(lineText(terminal, 0)).toBe('Microsoft Windows [版本 10.0.26200.8875]');
    expect(lineText(terminal, 1)).toBe('(c) Microsoft Corporation。保留所有权利。');
    expect(lineText(terminal, 2)).toBe('');
    expect(lineText(terminal, 3)).toBe('C:\\Users\\46838>foobar');
    // The stale copy at the old row must not survive.
    expect(lineText(terminal, 5)).toBe('');
    expect(terminal.buffer.active.cursorX).toBe(21);
    expect(terminal.buffer.active.cursorY).toBe(3);
  });
});

describe('bundled ConPTY: wrapped cursor line grows with an \\e[K repaint', () => {
  it('re-joins the cursor group and the repaint re-anchors the caret', async () => {
    const terminal = makeCmd(18);
    await write(terminal, CMD_BOOT);
    await write(terminal, CMD_ECHO_18);

    // The prompt line itself wraps at 18 cols; the cursor sits on "bar".
    expect(lineText(terminal, 7)).toBe('C:\\Users\\46838>foo');
    expect(lineText(terminal, 8)).toBe('bar');
    expect(terminal.buffer.active.cursorX).toBe(3);
    expect(terminal.buffer.active.cursorY).toBe(8);

    const filter = await resizeWithRepaint(terminal, 100, 30, CMD_REPAINT_K);
    expect(lineText(terminal, 0)).toBe('Microsoft Windows [版本 10.0.26200.8875]');
    expect(lineText(terminal, 1)).toBe('(c) Microsoft Corporation。保留所有权利。');
    expect(lineText(terminal, 2)).toBe('');
    expect(lineText(terminal, 3)).toBe('C:\\Users\\46838>foobar');
    // xterm's reflow leaves the caret mid-group; the repaint re-anchors it.
    expect(terminal.buffer.active.cursorX).toBe(21);
    expect(terminal.buffer.active.cursorY).toBe(3);

    await write(terminal, filter.consume('\x1b[4;22HX\x1b[4;23H'));
    expect(lineText(terminal, 3)).toBe('C:\\Users\\46838>foobarX');
    expect(terminal.buffer.active.cursorX).toBe(22);
  });
});

describe('system ConPTY fallback: full screen reprint', () => {
  it('applies the reprint untouched and re-anchors the cursor for raw echo', async () => {
    const terminal = makeCmd(30);
    await write(terminal, SYS_BOOT);

    // The boot screen positions the prompt with an absolute CUP.
    expect(lineText(terminal, 5)).toBe('C:\\Users\\46838>');
    expect(terminal.buffer.active.cursorX).toBe(15);
    expect(terminal.buffer.active.cursorY).toBe(5);

    await write(terminal, 'foobar');
    expect(lineText(terminal, 5)).toBe('C:\\Users\\46838>foobar');
    expect(terminal.buffer.active.cursorX).toBe(21);

    // The reprint contains no `CUP \e[J CUP` framing: the filter passes it
    // through byte-for-byte and the window stays armed until the timeout.
    const filter = new ResizeRepaintFilter();
    filter.arm();
    expect(filter.consume(SYS_REPRINT)).toBe(SYS_REPRINT);
    expect(filter.takeCarry()).toBe('');
    terminal.resize(100, 30);
    await write(terminal, SYS_REPRINT);

    // The reprint rewrites the joined banner (without the boot-time split
    // wide char) and its final CUP re-anchors the cursor.
    expect(lineText(terminal, 0)).toBe('Microsoft Windows [版本 10.0.26200.8875]');
    expect(lineText(terminal, 1)).toBe('(c) Microsoft Corporation。保留所有权利。');
    expect(lineText(terminal, 2)).toBe('');
    expect(lineText(terminal, 3)).toBe('C:\\Users\\46838>foobar');
    expect(terminal.buffer.active.cursorX).toBe(21);
    expect(terminal.buffer.active.cursorY).toBe(3);

    // Raw echo has no CUP of its own: correctness depends entirely on the
    // reprint's final CUP having been applied in order.
    expect(filter.consume('X')).toBe('X');
    await write(terminal, 'X');
    expect(lineText(terminal, 3)).toBe('C:\\Users\\46838>foobarX');
    expect(terminal.buffer.active.cursorX).toBe(22);
    expect(filter.cancel()).toBe('');
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
