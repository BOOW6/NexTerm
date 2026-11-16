import { describe, expect, it } from 'vitest';
import headless from '@xterm/headless';
import { buildCursorGroupResizePlan, buildCursorRestore } from './terminalCursorReflow';

const { Terminal } = headless;

const BOOT =
  '\x1b[1t\x1b[c\x1b[?1004h\x1b[?9001h\x1b[?7l\x1b[?7hMicrosoft Windows [版本 10.0.26200.8875]\r\n' +
  '(c) Microsoft Corporation。保留所有权利。\r\n\r\nC:\\Users\\46838>';

function makeTerminal(cols: number, rows = 30) {
  return new Terminal({
    allowProposedApi: true,
    cols,
    rows,
    scrollback: 1000,
    windowsPty: { backend: 'conpty', buildNumber: 26200 }
  });
}

type HeadlessTerminal = ReturnType<typeof makeTerminal>;

function write(terminal: HeadlessTerminal, data: string): Promise<void> {
  return new Promise((resolve) => terminal.write(data, resolve));
}

/** Apply the park plan (when present) and resize, mirroring XtermCanvas' order. */
async function resizeWithPark(terminal: HeadlessTerminal, cols: number): Promise<boolean> {
  const plan = buildCursorGroupResizePlan(terminal.buffer.active, cols, terminal.rows);
  if (plan) {
    await write(terminal, plan.before);
  }
  terminal.resize(cols, terminal.rows);
  await write(terminal, '');
  if (plan) {
    const restore = buildCursorRestore(terminal.buffer.active, plan, terminal.rows);
    if (restore) {
      await write(terminal, restore);
    }
  }
  return plan !== null;
}

function lineText(terminal: HeadlessTerminal, y: number): string {
  return terminal.buffer.active.getLine(y)?.translateToString(true) ?? '';
}

describe('buildCursorGroupResizePlan', () => {
  it('splits the cursor line on shrink instead of truncating it', async () => {
    const terminal = makeTerminal(100);
    await write(terminal, 'C:\\Users\\46838>');

    const parked = await resizeWithPark(terminal, 12);

    expect(parked).toBe(true);
    expect(lineText(terminal, 0)).toBe('C:\\Users\\468');
    expect(lineText(terminal, 1)).toBe('38>');
    expect(terminal.buffer.active.getLine(1)?.isWrapped).toBe(true);
    expect(terminal.buffer.active.cursorX).toBe(3);
    expect(terminal.buffer.active.cursorY).toBe(1);
  });

  it('rejoins the wrapped cursor group on grow', async () => {
    const terminal = makeTerminal(100);
    await write(terminal, 'C:\\Users\\46838>');
    await resizeWithPark(terminal, 12);

    await resizeWithPark(terminal, 100);

    expect(lineText(terminal, 0)).toBe('C:\\Users\\46838>');
    expect(terminal.buffer.active.cursorX).toBe(15);
    expect(terminal.buffer.active.cursorY).toBe(0);
  });

  it('keeps xterm aligned with the ConPTY resize byte stream end to end', async () => {
    // Byte stream captured by conpty_resize_byte_stream_probe: ConPTY emits
    // nothing on resize, then absolute cursor positions based on its own
    // greedy rewrap of the screen.
    const terminal = makeTerminal(100);
    await write(terminal, BOOT);

    await resizeWithPark(terminal, 12);
    // xterm's reflow expanded the banner rows; the prompt now sits at 9/10.
    // ConPTY for "typed X at 12 cols": \e[11;4H X \e[11;5H (1-based).
    await write(terminal, '\x1b[11;4HX\x1b[11;5H');
    expect(lineText(terminal, 9)).toBe('C:\\Users\\468');
    expect(lineText(terminal, 10)).toBe('38>X');
    expect(terminal.buffer.active.cursorX).toBe(4);
    expect(terminal.buffer.active.cursorY).toBe(10);

    await resizeWithPark(terminal, 100);
    // ConPTY on grow-back: \e[4;16H \e[J \e[4;16H X \e[4;17H (1-based).
    await write(terminal, '\x1b[4;16H\x1b[J\x1b[4;16HX\x1b[4;17H');
    expect(lineText(terminal, 3)).toBe('C:\\Users\\46838>X');
    expect(terminal.buffer.active.cursorX).toBe(16);
    expect(terminal.buffer.active.cursorY).toBe(3);
  });

  it('wraps wide characters without splitting them', async () => {
    const terminal = makeTerminal(20);
    await write(terminal, '中文提示符>');

    await resizeWithPark(terminal, 6);

    expect(lineText(terminal, 0)).toBe('中文提');
    expect(lineText(terminal, 1)).toBe('示符>');
    expect(terminal.buffer.active.cursorX).toBe(5);
    expect(terminal.buffer.active.cursorY).toBe(1);

    await resizeWithPark(terminal, 20);
    expect(lineText(terminal, 0)).toBe('中文提示符>');
    expect(terminal.buffer.active.cursorX).toBe(11);
  });

  it('maps a mid-line cursor to the wrapped continuation', async () => {
    const terminal = makeTerminal(100);
    await write(terminal, 'C:\\Users\\46838>');
    // Move the cursor onto the "6" (0-based col 10) like an arrow-left run.
    await write(terminal, '\x1b[1;11H');

    await resizeWithPark(terminal, 12);

    expect(lineText(terminal, 0)).toBe('C:\\Users\\468');
    expect(lineText(terminal, 1)).toBe('38>');
    expect(terminal.buffer.active.cursorX).toBe(10);
    expect(terminal.buffer.active.cursorY).toBe(0);
  });

  it('returns null when the layout already matches the target width', async () => {
    const terminal = makeTerminal(100);
    await write(terminal, 'C:\\Users\\46838>');

    expect(buildCursorGroupResizePlan(terminal.buffer.active, 100, terminal.rows)).toBeNull();
    expect(buildCursorGroupResizePlan(terminal.buffer.active, 40, terminal.rows)).toBeNull();
  });

  it('returns null for the alternate buffer', async () => {
    const terminal = makeTerminal(100);
    await write(terminal, '\x1b[?1049h\x1b[2J\x1b[Happ\x1b[3;1H');

    expect(buildCursorGroupResizePlan(terminal.buffer.active, 12, terminal.rows)).toBeNull();
  });

  it('returns null when content follows below the cursor group', async () => {
    const terminal = makeTerminal(100);
    await write(terminal, 'C:\\Users\\46838>\r\noutput below');

    expect(buildCursorGroupResizePlan(terminal.buffer.active, 12, terminal.rows)).toBeNull();
  });

  it('still parks an indented output row whose content would be truncated', async () => {
    // Guards the prompt-tail exception: an indented line that is *not* the
    // tail of a wrapped run is ordinary content and must keep its park, or a
    // shrink would silently truncate it in the scrollback.
    const terminal = makeTerminal(40);
    await write(terminal, '    drwxr-xr-x  4 root root  4096 .conf');
    expect(lineText(terminal, 0)).toBe('    drwxr-xr-x  4 root root  4096 .conf');

    expect(buildCursorGroupResizePlan(terminal.buffer.active, 12, terminal.rows)).not.toBeNull();
  });
});
