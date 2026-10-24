const SNAPSHOT_PREFIX = 'nexterm.terminal.snapshot.v1:';
const MAX_SNAPSHOT_CHARS = 512 * 1024;

function storageKey(sessionId: string): string {
  return `${SNAPSHOT_PREFIX}${sessionId}`;
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
    return data ? trimSnapshot(data) : data;
  } catch {
    return null;
  }
}

export function writeTerminalSnapshot(sessionId: string, data: string): void {
  try {
    const trimmed = trimSnapshot(data);
    if (!trimmed || trimmed.length > MAX_SNAPSHOT_CHARS) {
      window.localStorage.removeItem(storageKey(sessionId));
      return;
    }
    window.localStorage.setItem(storageKey(sessionId), trimmed);
  } catch {
    /* quota exceeded or storage unavailable */
  }
}

export function clearTerminalSnapshot(sessionId: string): void {
  try {
    window.localStorage.removeItem(storageKey(sessionId));
  } catch {
    /* storage unavailable */
  }
}
