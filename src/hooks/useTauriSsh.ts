import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

export interface SshOutputPayload {
  id: string;
  data: string;
}

export interface SshConnectOptions {
  host: string;
  port: number;
  username: string;
  authMethod: 'password' | 'key';
  password?: string;
  privateKeyPath?: string;
  passphrase?: string;
  cols: number;
  rows: number;
}

export interface HostKeyPromptPayload {
  request_id: string;
  host: string;
  port: number;
  fingerprint: string;
  algorithm: string;
}

export interface HostKeyMismatchPayload {
  host: string;
  expected: string;
  actual: string;
}

export interface KnownHost {
  host: string;
  algorithm: string;
  fingerprint: string;
  added_at: number;
}

export interface SftpEntry {
  name: string;
  path: string;
  is_dir: boolean;
  size: number;
  mtime: number;
  permissions: number | null;
}

export interface SftpProgressPayload {
  transfer_id: string;
  direction: string;
  name: string;
  transferred: number;
  total: number;
}

export interface SftpTransferDonePayload {
  transfer_id: string;
  direction: string;
  name: string;
  success: boolean;
  error: string | null;
  transferred: number;
  total: number;
}

export async function connectSsh(options: SshConnectOptions): Promise<string> {
  return invoke<string>('ssh_connect', {
    host: options.host,
    port: options.port,
    username: options.username,
    authMethod: options.authMethod,
    password: options.password ?? '',
    privateKeyPath: options.privateKeyPath ?? null,
    passphrase: options.passphrase ?? null,
    cols: options.cols,
    rows: options.rows
  });
}

export async function respondHostKey(requestId: string, accept: boolean): Promise<void> {
  await invoke('ssh_host_key_response', { requestId, accept });
}

export async function listKnownHosts(): Promise<KnownHost[]> {
  return invoke<KnownHost[]>('known_hosts_list');
}

export async function removeKnownHost(host: string): Promise<void> {
  await invoke('known_hosts_remove', { host });
}

export async function writeSsh(id: string, data: string): Promise<void> {
  await invoke('ssh_write', { id, data });
}

export async function resizeSsh(id: string, cols: number, rows: number): Promise<void> {
  await invoke('ssh_resize', { id, cols, rows });
}

export async function disconnectSsh(id: string): Promise<void> {
  await invoke('ssh_disconnect', { id });
}

export async function listSftp(id: string, path: string): Promise<SftpEntry[]> {
  return invoke<SftpEntry[]>('sftp_list', { id, path });
}

export async function listenSshOutput(
  id: string,
  onOutput: (payload: SshOutputPayload) => void
): Promise<() => void> {
  return listen<SshOutputPayload>(`ssh-output-${id}`, (event) => {
    onOutput(event.payload);
  });
}

export async function listenSshClosed(
  id: string,
  onClosed: () => void
): Promise<() => void> {
  return listen(`ssh-closed-${id}`, () => {
    onClosed();
  });
}

export async function uploadSftp(
  id: string,
  localPath: string,
  remotePath: string
): Promise<string> {
  return invoke<string>('sftp_upload', { id, localPath, remotePath });
}

export async function downloadSftp(
  id: string,
  remotePath: string,
  localPath: string
): Promise<string> {
  return invoke<string>('sftp_download', { id, remotePath, localPath });
}

export async function removeSftp(
  id: string,
  path: string,
  isDir: boolean
): Promise<void> {
  await invoke('sftp_remove', { id, path, isDir });
}

export async function renameSftp(
  id: string,
  from: string,
  to: string
): Promise<void> {
  await invoke('sftp_rename', { id, from, to });
}

export async function mkdirSftp(id: string, path: string): Promise<void> {
  await invoke('sftp_mkdir', { id, path });
}

export async function listenSftpProgress(
  onProgress: (payload: SftpProgressPayload) => void
): Promise<() => void> {
  return listen<SftpProgressPayload>('sftp-progress', (event) => {
    onProgress(event.payload);
  });
}

export async function listenSftpTransferDone(
  onDone: (payload: SftpTransferDonePayload) => void
): Promise<() => void> {
  return listen<SftpTransferDonePayload>('sftp-transfer-done', (event) => {
    onDone(event.payload);
  });
}

export async function listenHostKeyPrompt(
  onPrompt: (payload: HostKeyPromptPayload) => void
): Promise<() => void> {
  return listen<HostKeyPromptPayload>('ssh-host-key', (event) => {
    onPrompt(event.payload);
  });
}

export async function listenHostKeyMismatch(
  onMismatch: (payload: HostKeyMismatchPayload) => void
): Promise<() => void> {
  return listen<HostKeyMismatchPayload>('ssh-host-key-mismatch', (event) => {
    onMismatch(event.payload);
  });
}
