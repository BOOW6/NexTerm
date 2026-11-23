import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearAllTerminalSnapshots,
  clearSnapshotsOutsideScope,
  storedSnapshotSessionIds,
  snapshotEnabledFor,
  type TerminalSnapshotMode,
  clearTerminalSnapshot,
  readTerminalSnapshot,
  trimSnapshot,
  writeTerminalSnapshot
} from './terminalSnapshot';

describe('terminalSnapshot', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('stores and clears a snapshot per session', () => {
    writeTerminalSnapshot('a', 'hello');
    writeTerminalSnapshot('b', 'world');
    expect(readTerminalSnapshot('a')).toBe('hello');
    expect(readTerminalSnapshot('b')).toBe('world');

    clearTerminalSnapshot('a');
    expect(readTerminalSnapshot('a')).toBeNull();
    expect(readTerminalSnapshot('b')).toBe('world');
  });

  it('drops oversized snapshots', () => {
    writeTerminalSnapshot('big', 'x'.repeat(512 * 1024 + 1));
    expect(readTerminalSnapshot('big')).toBeNull();
  });

  it('trims blank-row noise from snapshots', () => {
    expect(trimSnapshot('prompt\r\n\r\n\r\n')).toBe('prompt');
    expect(trimSnapshot('line1\nline2\n')).toBe('line1\nline2');
    expect(trimSnapshot('keep\n\ninner')).toBe('keep\n\ninner');
    expect(trimSnapshot('a\r\n\r\n\r\n\r\n\r\nb')).toBe('a\r\n\r\nb');

    writeTerminalSnapshot('blank', 'old output\r\n\r\n\r\n\r\n\r\n\r\n');
    expect(readTerminalSnapshot('blank')).toBe('old output');
  });

  it('evicts the least recently used sessions beyond the retention cap', () => {
    // MAX_SNAPSHOT_ENTRIES is 24: fill 25 sessions, the oldest must go.
    for (let i = 0; i < 25; i += 1) {
      writeTerminalSnapshot(`s${i}`, `content-${i}`);
    }
    expect(readTerminalSnapshot('s0')).toBeNull();
    expect(readTerminalSnapshot('s24')).toBe('content-24');

    // Reading refreshes recency: touch s1, then overflow with s25 — the
    // victim is s2 (the oldest untouched), not s1.
    expect(readTerminalSnapshot('s1')).toBe('content-1');
    writeTerminalSnapshot('s25', 'newest');
    expect(readTerminalSnapshot('s1')).toBe('content-1');
    expect(readTerminalSnapshot('s2')).toBeNull();
  });

  it('wipes every snapshot on the privacy cleanup entry point', () => {
    writeTerminalSnapshot('a', 'one');
    writeTerminalSnapshot('b', 'two');

    expect(clearAllTerminalSnapshots()).toBe(2);
    expect(readTerminalSnapshot('a')).toBeNull();
    expect(readTerminalSnapshot('b')).toBeNull();
    expect(clearAllTerminalSnapshots()).toBe(0);
  });
});

describe('snapshotEnabledFor', () => {
  const cases: Array<[TerminalSnapshotMode, string, boolean]> = [
    ['all', 'ssh', true],
    ['all', 'local', true],
    ['local', 'local', true],
    ['local', 'ssh', false],
    ['local', 'telnet', false],
    ['local', 'serial', false],
    ['off', 'local', false],
    ['off', 'ssh', false]
  ];
  it.each(cases)('mode %j + kind %s -> %j', (mode, kind, expected) => {
    expect(snapshotEnabledFor(mode, kind)).toBe(expected);
  });
});

describe('snapshot retention bookkeeping', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  const INDEX_KEY = 'nexterm.terminal.snapshot.index.v1';

  it('truncates the MRU index when the retention cap evicts entries', () => {
    for (let i = 0; i < 25; i += 1) {
      writeTerminalSnapshot(`s${i}`, `content-${i}`);
    }
    const index: string[] = JSON.parse(window.localStorage.getItem(INDEX_KEY) ?? '[]');
    // The index must track the storage, not the pre-eviction order: the old
    // code wrote 25 ids while evicting only the storage entry.
    expect(index).toHaveLength(24);
    expect(index).not.toContain('s0');
    expect(index[0]).toBe('s24');
    expect(window.localStorage.getItem('nexterm.terminal.snapshot.v1:s0')).toBeNull();
  });

  it('prunes stale index entries and finds legacy snapshots without an index', () => {
    // Simulate data written before the index existed.
    window.localStorage.setItem('nexterm.terminal.snapshot.v1:legacy', 'old output');
    expect(storedSnapshotSessionIds()).toContain('legacy');

    // A stale index entry (storage already gone) is dropped on the next write.
    window.localStorage.setItem(INDEX_KEY, JSON.stringify(['ghost']));
    writeTerminalSnapshot('s1', 'fresh');
    const index: string[] = JSON.parse(window.localStorage.getItem(INDEX_KEY) ?? '[]');
    expect(index).toEqual(['s1']);
  });

  it('clears snapshots the active scope excludes, including their sessions gone', () => {
    writeTerminalSnapshot('local-1', 'local output');
    writeTerminalSnapshot('ssh-1', 'remote output');
    // A snapshot whose session no longer exists must also go on a scan.
    window.localStorage.setItem('nexterm.terminal.snapshot.v1:deleted', 'orphan');
    const kinds: Record<string, string> = { 'local-1': 'local', 'ssh-1': 'ssh' };
    const kindOf = (id: string): string | undefined => kinds[id];

    expect(clearSnapshotsOutsideScope('local', kindOf)).toBe(2);
    expect(readTerminalSnapshot('local-1')).toBe('local output');
    expect(readTerminalSnapshot('ssh-1')).toBeNull();
    expect(storedSnapshotSessionIds()).toEqual(['local-1']);

    // Switching to "off" clears what the previous scope kept.
    expect(clearSnapshotsOutsideScope('off', kindOf)).toBe(1);
    expect(storedSnapshotSessionIds()).toEqual([]);
  });
});
