import { useEffect } from 'react';
import { useSettingsStore } from '../stores/settingsStore';
import { useSessionStore } from '../stores/sessionStore';
import { clearSnapshotsOutsideScope } from '../lib/terminalSnapshot';

/**
 * Enforce the snapshot scope whenever the mode changes (and once at
 * startup): snapshots of sessions the current scope excludes are deleted
 * instead of lingering as plaintext leftovers — switching to "local only"
 * or "off" must also clean up what the previous mode already stored.
 */
export function useTerminalSnapshotScope(): void {
  const terminalSnapshots = useSettingsStore((state) => state.terminalSnapshots);

  useEffect(() => {
    clearSnapshotsOutsideScope(
      terminalSnapshots,
      (sessionId) => useSessionStore.getState().getSession(sessionId)?.kind
    );
  }, [terminalSnapshots]);
}
