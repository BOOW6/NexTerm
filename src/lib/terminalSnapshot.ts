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

/** Move `sessionId` to the MRU end of the index and drop entries whose
 * storage no longer exists. Returns the reordered list without trimming —
 * only writes enforce the retention cap. */
function reorderIndex(sessionId: string): string[] {
  const order = [sessionId, ...readIndex().filter((id) => id !== sessionId)];
  return order.filter((id) => window.localStorage.getItem(storageKey(id)) !== null);
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
      writeIndex(reorderIndex(sessionId));
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
    // Retention cap: keep the MRU window, evict the rest from storage AND
    // from the index. Writing the pre-eviction order (the old behaviour) let
    // the index grow without bound even though the storage entries were
    // gone.
    const order = reorderIndex(sessionId);
    for (const evicted of order.slice(MAX_SNAPSHOT_ENTRIES)) {
      window.localStorage.removeItem(storageKey(evicted));
    }
    writeIndex(order.slice(0, MAX_SNAPSHOT_ENTRIES));
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

/** Every session id that currently has a stored snapshot. Scans storage
 * rather than the MRU index so snapshots written before the index existed
 * are still found (cleanup must not miss legacy leftovers). */
export function storedSnapshotSessionIds(): string[] {
  const ids: string[] = [];
  try {
    for (let i = 0; i < window.localStorage.length; i += 1) {
      const key = window.localStorage.key(i);
      if (key !== null && key.startsWith(SNAPSHOT_PREFIX)) {
        ids.push(key.slice(SNAPSHOT_PREFIX.length));
      }
    }
  } catch {
    return [];
  }
  return ids;
}

/** Delete snapshots the current scope excludes: remote sessions (and
 * snapshots whose session no longer exists) must not linger as plaintext
 * after a mode switch. Returns how many were removed. */
export function clearSnapshotsOutsideScope(
  mode: TerminalSnapshotMode,
  kindOf: (sessionId: string) => string | undefined
): number {
  let removed = 0;
  for (const sessionId of storedSnapshotSessionIds()) {
    const kind = kindOf(sessionId);
    if (kind === undefined || !snapshotEnabledFor(mode, kind)) {
      clearTerminalSnapshot(sessionId);
      removed += 1;
    }
  }
  return removed;
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
