import { currentSshId, transportIds, useConnectionStore } from '../stores/connectionStore';
import { isSshBackedSession } from './sessionVisuals';
import { writePty } from '../hooks/useTauriPty';
import { writeSsh } from '../hooks/useTauriSsh';
import { writeTelnet } from '../hooks/useTauriTelnet';
import { writeSerial } from '../hooks/useTauriSerial';
import { useSessionStore } from '../stores/sessionStore';
import type { ConnectionEntry } from '../stores/connectionStore';

/** Write `data` into every live transport of the session. Transport write
 * failures are swallowed (the session's own pane surfaces reconnects);
 * returns whether anything was written. */
export function writeToSession(sessionId: string, data: string): boolean {
  const session = useSessionStore.getState().sessions.find((item) => item.id === sessionId);
  if (!session || session.status !== 'connected') {
    return false;
  }
  const entry: ConnectionEntry | undefined = useConnectionStore.getState().connections[sessionId];
  let wrote = false;

  const tryWrite = (promise: Promise<void>) => {
    wrote = true;
    void promise.catch(() => {});
  };

  if (isSshBackedSession(session.kind)) {
    const sshId = currentSshId(entry);
    if (sshId) {
      tryWrite(writeSsh(sshId, data));
    }
  } else if (session.kind === 'local') {
    for (const id of transportIds(entry, 'pty')) {
      tryWrite(writePty(id, data));
    }
  } else if (session.kind === 'telnet') {
    for (const id of transportIds(entry, 'telnet')) {
      tryWrite(writeTelnet(id, data));
    }
  } else if (session.kind === 'serial') {
    for (const id of transportIds(entry, 'serial')) {
      tryWrite(writeSerial(id, data));
    }
  }
  return wrote;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

/** Replay a recorded macro into the session, honoring per-step delays. */
export async function replayMacro(
  sessionId: string,
  steps: Array<{ data: string; delayMs: number }>
): Promise<void> {
  for (const step of steps) {
    if (step.delayMs > 0) {
      await sleep(step.delayMs);
    }
    writeToSession(sessionId, step.data);
  }
}
