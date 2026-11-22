import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

export interface PtyOutputPayload {
  id: string;
  data: string;
}

export interface PtyPlatformInfo {
  backend: 'conpty' | 'winpty' | null;
  buildNumber: number | null;
  /** Windows only: whether the bundled ConPTY redistributable is in use. */
  bundled: boolean | null;
}

let platformInfoPromise: Promise<PtyPlatformInfo> | null = null;

/**
 * ConPTY behaves differently from a Unix PTY on resize. xterm.js needs the
 * actual backend/build number to enable its Windows resize heuristics,
 * otherwise rows are dropped from the scrollback when the window grows.
 */
export function getPtyPlatformInfo(): Promise<PtyPlatformInfo> {
  if (!platformInfoPromise) {
    platformInfoPromise = invoke<PtyPlatformInfo>('pty_platform_info').catch(() => {
      // Do not cache a transport failure; a later terminal may retry.
      platformInfoPromise = null;
      return { backend: null, buildNumber: null, bundled: null };
    });
  }
  return platformInfoPromise;
}

export interface PtySpawnCommand {
  command: string;
  args?: string[];
}

export async function createPtySession(
  id: string,
  cols: number,
  rows: number,
  logPath?: string,
  shell?: PtySpawnCommand
): Promise<string> {
  return invoke<string>('create_pty_session', {
    id,
    cols,
    rows,
    logPath: logPath ?? null,
    command: shell?.command ?? null,
    args: shell?.args ?? null
  });
}

export async function writePty(id: string, data: string): Promise<void> {
  await invoke('write_pty', { id, data });
}

export async function resizePty(id: string, cols: number, rows: number): Promise<void> {
  await invoke('resize_pty', { id, cols, rows });
}

export async function closePtySession(id: string): Promise<void> {
  await invoke('close_pty_session', { id });
}

export async function listenPtyOutput(
  id: string,
  onOutput: (payload: PtyOutputPayload) => void
): Promise<() => void> {
  return listen<PtyOutputPayload>(`pty-output-${id}`, (event) => {
    onOutput(event.payload);
  });
}

export interface PtyClosedPayload {
  /** Known when the backend reaped the child before emitting; `null` means
   * the reader-EOF path won the finalize race (Unix fast exit). */
  exitStatus?: number | null;
}

export async function listenPtyClosed(
  id: string,
  onClosed: (payload: PtyClosedPayload) => void
): Promise<() => void> {
  return listen<PtyClosedPayload>(`pty-closed-${id}`, (event) => {
    // Older backends emit a unit payload; default to an unknown exit status.
    onClosed(event.payload ?? {});
  });
}
