const SNAPSHOT_PREFIX = 'nexterm.terminal.snapshot.v1:';
const SNAPSHOT_INDEX_KEY = 'nexterm.terminal.snapshot.index.v1';
const MAX_SNAPSHOT_CHARS = 512 * 1024;
// Retention cap: scrollback is plaintext session content in localStorage, so
// it must not accumulate forever. Evicted LRU-first; per-session deletion
// still happens when the session is removed.
const MAX_SNAPSHOT_ENTRIES = 24;

/** Which sessions persist plaintext scrollback snapshots. */
export type TerminalSnapshotMode = 'all' | 'local' | 'off';

/** Whether the given session kind may save/restore a snapshot under the
 * mode. Snapshots are plaintext terminal output in localStorage; remote
 * output (SSH/Telnet/Serial) defaults to staying off disk. */
export function snapshotEnabledFor(mode: TerminalSnapshotMode, kind: string): boolean {
  if (mode === 'off') {
    return false;
  }
  if (mode === 'all') {
    return true;
  }
  return kind === 'local';
}

function storageKey(sessionId: string): string {
  return `${SNAPSHOT_PREFIX}${sessionId}`;
}

/** MRU-ordered session ids of stored snapshots; tolerated missing/corrupt. */
function readIndex(): string[] {
  try {
    const raw = window.localStorage.getItem(SNAPSHOT_INDEX_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === 'string')
      : [];
  } catch {
    return [];
  }
}

function writeIndex(ids: string[]): void {
  try {
    if (ids.length === 0) {
      window.localStorage.removeItem(SNAPSHOT_INDEX_KEY);
    } else {
      window.localStorage.setItem(SNAPSHOT_INDEX_KEY, JSON.stringify(ids));
    }
  } catch {
    /* storage unavailable */
  }
}

function touchIndex(sessionId: string): string[] {
  const next = [sessionId, ...readIndex().filter((id) => id !== sessionId)];
  writeIndex(next);
  return next;
}

/**
 * Remove blank-row noise from a serialized snapshot. Older versions pushed a
 * whole viewport of line feeds on every restore/reconnect, which left long
 * runs of empty lines in persisted scrollback. Keep up to two consecutive
 * blank lines (normal output) but collapse longer runs, then drop trailing
 * line feeds entirely.
 */
export function trimSnapshot(data: string): string {
  return data.replace(/(?:\r?\n){4,}/g, '\r\n\r\n').replace(/(?:\r?\n)+$/g, '');
}

export function readTerminalSnapshot(sessionId: string): string | null {
  try {
    const data = window.localStorage.getItem(storageKey(sessionId));
    if (data) {
      // Reading counts as use: keep the entry at the MRU end.
      touchIndex(sessionId);
      return trimSnapshot(data);
    }
    return data;
  } catch {
    return null;
  }
}

export function writeTerminalSnapshot(sessionId: string, data: string): void {
  try {
    const trimmed = trimSnapshot(data);
    if (!trimmed || trimmed.length > MAX_SNAPSHOT_CHARS) {
      window.localStorage.removeItem(storageKey(sessionId));
      writeIndex(readIndex().filter((id) => id !== sessionId));
      return;
    }
    window.localStorage.setItem(storageKey(sessionId), trimmed);
    // Evict the least recently used snapshots beyond the retention cap.
    const mru = touchIndex(sessionId);
    for (const evicted of mru.slice(MAX_SNAPSHOT_ENTRIES)) {
      window.localStorage.removeItem(storageKey(evicted));
    }
  } catch {
    /* quota exceeded or storage unavailable */
  }
}

export function clearTerminalSnapshot(sessionId: string): void {
  try {
    window.localStorage.removeItem(storageKey(sessionId));
    writeIndex(readIndex().filter((id) => id !== sessionId));
  } catch {
    /* storage unavailable */
  }
}

/** Wipe every stored snapshot (settings: privacy cleanup). Returns the
 * number of session snapshots removed. */
export function clearAllTerminalSnapshots(): number {
  let removed = 0;
  try {
    for (let i = window.localStorage.length - 1; i >= 0; i -= 1) {
      const key = window.localStorage.key(i);
      if (key !== null && key.startsWith(SNAPSHOT_PREFIX)) {
        window.localStorage.removeItem(key);
        removed += 1;
      }
    }
    writeIndex([]);
  } catch {
    /* storage unavailable */
  }
  return removed;
}
