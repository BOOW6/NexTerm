import { describe, expect, it } from 'vitest';
import headless from '@xterm/headless';
import { shouldCommitConptyPendingWrap } from './terminalResizePendingWrap';

const { Terminal } = headless;
type HeadlessTerminal = InstanceType<typeof Terminal>;

function write(terminal: HeadlessTerminal, data: string): Promise<void> {
  return new Promise((resolve) => (data.length ? terminal.write(data, resolve) : resolve()));
}

async function makeTerminal(cols: number, text: string, rows = 30): Promise<HeadlessTerminal> {
  const terminal = new Terminal({
    allowProposedApi: true,
    cols,
    rows,
    scrollback: 1000,
    windowsPty: { backend: 'conpty', buildNumber: 26200 }
  });
  // Put the text on the last row so the cursor ends there.
  await write(terminal, `\x1b[${rows};1H${text}`);
  return terminal;
}

describe('shouldCommitConptyPendingWrap', () => {
  it('detects a prompt that exactly fills the bottom row', async () => {
    const terminal = await makeTerminal(15, 'C:\\Users\\46838>');
    expect(
      shouldCommitConptyPendingWrap(terminal.buffer.active, terminal.cols, terminal.rows)
    ).toBe(true);
  });

  it('detects the same prompt before a shrink to the fill width', async () => {
    const terminal = await makeTerminal(100, 'C:\\Users\\46838>');
    expect(
      shouldCommitConptyPendingWrap(terminal.buffer.active, terminal.cols, terminal.rows, 15)
    ).toBe(true);
  });

  it('does not commit when the cursor is sitting on the last glyph', async () => {
    const terminal = await makeTerminal(20, 'C:\\Users\\46838>');
    await write(terminal, '\x1b[30;15H');
    expect(terminal.buffer.active.cursorX).toBe(14);
    expect(
      shouldCommitConptyPendingWrap(terminal.buffer.active, terminal.cols, terminal.rows, 15)
    ).toBe(false);
  });

  it('does not commit when the bottom row still has a free cell', async () => {
    const terminal = await makeTerminal(16, 'C:\\Users\\46838>');
    expect(
      shouldCommitConptyPendingWrap(terminal.buffer.active, terminal.cols, terminal.rows)
    ).toBe(false);
  });

  it('does not commit when the cursor is not on the last column', async () => {
    const terminal = await makeTerminal(15, 'C:\\Users\\46838');
    expect(
      shouldCommitConptyPendingWrap(terminal.buffer.active, terminal.cols, terminal.rows)
    ).toBe(false);
  });

  it('commits a wide-character row that exactly fills, including the width-0 tail', async () => {
    const terminal = await makeTerminal(8, '你好世界', 4);
    expect(terminal.buffer.active.cursorX).toBe(8);
    expect(
      shouldCommitConptyPendingWrap(terminal.buffer.active, terminal.cols, terminal.rows)
    ).toBe(true);
  });

  it('does not commit for the alternate buffer', async () => {
    const terminal = await makeTerminal(15, 'C:\\Users\\46838>');
    await write(terminal, '\x1b[?1049h\x1b[30;1HC:\\Users\\46838>');
    expect(terminal.buffer.active.type).toBe('alternate');
    expect(
      shouldCommitConptyPendingWrap(terminal.buffer.active, terminal.cols, terminal.rows)
    ).toBe(false);
  });
});
