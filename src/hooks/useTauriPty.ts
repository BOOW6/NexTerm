import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

export interface PtyOutputPayload {
  id: string;
  data: string;
}

export async function createPtySession(cols: number, rows: number): Promise<string> {
  return invoke<string>('create_pty_session', { cols, rows });
}

export async function writePty(id: string, data: string): Promise<void> {
  await invoke('write_pty', { id, data });
}

export async function resizePty(id: string, cols: number, rows: number): Promise<void> {
  await invoke('resize_pty', { id, cols, rows });
}

export async function listenPtyOutput(
  id: string,
  onOutput: (payload: PtyOutputPayload) => void
): Promise<() => void> {
  return listen<PtyOutputPayload>(`pty-output-${id}`, (event) => {
    onOutput(event.payload);
  });
}
