import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

export interface SerialPortInfo {
  name: string;
  kind: string;
}

export interface SerialConnectOptions {
  id: string;
  portName: string;
  baud: number;
  dataBits?: string;
  parity?: string;
  stopBits?: string;
  flowControl?: string;
  logPath?: string;
}

export async function listSerialPorts(): Promise<SerialPortInfo[]> {
  return invoke<SerialPortInfo[]>('serial_list');
}

export async function connectSerial(options: SerialConnectOptions): Promise<string> {
  return invoke<string>('serial_connect', {
    id: options.id,
    portName: options.portName,
    baud: options.baud,
    dataBits: options.dataBits ?? null,
    parity: options.parity ?? null,
    stopBits: options.stopBits ?? null,
    flowControl: options.flowControl ?? null,
    logPath: options.logPath ?? null
  });
}

export async function writeSerial(id: string, data: string): Promise<void> {
  await invoke('serial_write', { id, data });
}

export async function disconnectSerial(id: string): Promise<void> {
  await invoke('serial_disconnect', { id });
}

export async function listenSerialOutput(
  id: string,
  onOutput: (payload: { id: string; data: string }) => void
): Promise<() => void> {
  return listen<{ id: string; data: string }>(`serial-output-${id}`, (event) => {
    onOutput(event.payload);
  });
}

export async function listenSerialClosed(id: string, onClosed: () => void): Promise<() => void> {
  return listen(`serial-closed-${id}`, () => {
    onClosed();
  });
}
