import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

export interface TelnetOutputPayload {
  id: string;
  data: string;
}

export interface TelnetConnectOptions {
  id: string;
  host: string;
  port: number;
  /** Append-mode file the backend tees decoded output into. */
  logPath?: string;
}

export async function connectTelnet(options: TelnetConnectOptions): Promise<string> {
  return invoke<string>('telnet_connect', {
    id: options.id,
    host: options.host,
    port: options.port,
    logPath: options.logPath ?? null
  });
}

export async function writeTelnet(id: string, data: string): Promise<void> {
  await invoke('telnet_write', { id, data });
}

export async function resizeTelnet(id: string, cols: number, rows: number): Promise<void> {
  await invoke('telnet_resize', { id, cols, rows });
}

export async function disconnectTelnet(id: string): Promise<void> {
  await invoke('telnet_disconnect', { id });
}

export async function listenTelnetOutput(
  id: string,
  onOutput: (payload: TelnetOutputPayload) => void
): Promise<() => void> {
  return listen<TelnetOutputPayload>(`telnet-output-${id}`, (event) => {
    onOutput(event.payload);
  });
}

export async function listenTelnetClosed(id: string, onClosed: () => void): Promise<() => void> {
  return listen(`telnet-closed-${id}`, () => {
    onClosed();
  });
}
