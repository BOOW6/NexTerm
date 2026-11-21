/**
 * Shared `.catch` tail for `listen(...)` registration promises.
 *
 * Outside the Tauri shell (plain browser, vitest) every listen call rejects
 * because the IPC bridge is missing; that rejection is expected and stays
 * silent. Inside the shell a rejected registration means that event stream
 * is dead until the next mount, which at minimum deserves a console trace
 * instead of disappearing without any record.
 */
export function swallowListenError(reason: unknown): void {
  if (typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window) {
    console.warn('[events] listener registration failed:', reason);
  }
}
