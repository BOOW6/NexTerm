import { describe, expect, it } from 'vitest';
import { Terminal } from '@xterm/xterm';
import { terminalTranscript, transcriptFileName } from './terminalTranscript';

function writeAsync(term: Terminal, data: string): Promise<void> {
  return new Promise((resolve) => {
    term.write(data, resolve);
  });
}

describe('terminalTranscript', () => {
  it('dumps scrollback and viewport as plain text, trailing blanks dropped', async () => {
    const term = new Terminal({ cols: 40, rows: 6, scrollback: 100 });
    await writeAsync(term, 'first\r\n');
    await writeAsync(term, 'second with trailing spaces   \r\n');
    await writeAsync(term, '\x1b[31mred\x1b[0m plain');
    expect(terminalTranscript(term.buffer)).toBe('first\nsecond with trailing spaces\nred plain');
  });

  it('keeps wide characters whole across their cell pairs', async () => {
    const term = new Terminal({ cols: 20, rows: 2, scrollback: 10 });
    await writeAsync(term, '中文提示\r\n');
    expect(terminalTranscript(term.buffer).split('\n')[0]).toBe('中文提示');
  });

  it('returns an empty string for an untouched buffer', () => {
    const term = new Terminal({ cols: 20, rows: 2, scrollback: 10 });
    expect(terminalTranscript(term.buffer)).toBe('');
  });
});

describe('transcriptFileName', () => {
  it('appends a local timestamp to the session title', () => {
    expect(transcriptFileName('dietpi@host', new Date(2026, 10, 22, 15, 4, 9))).toBe(
      'dietpi@host-20261122-150409.txt'
    );
  });

  it('collapses characters Windows forbids in file names', () => {
    expect(transcriptFileName('a<b>:c/d', new Date(2026, 0, 2, 3, 4, 5))).toBe(
      'a-b-c-d-20260102-030405.txt'
    );
  });

  it('falls back to a generic name without a title', () => {
    expect(transcriptFileName('   ', new Date(2026, 0, 2, 3, 4, 5))).toBe(
      'terminal-20260102-030405.txt'
    );
  });
});
