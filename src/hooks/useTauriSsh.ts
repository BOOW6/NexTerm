import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

export interface SshOutputPayload {
  id: string;
  data: string;
}

export interface SshConnectOptions {
  id: string;
  host: string;
  port: number;
  username: string;
  authMethod: 'password' | 'key' | 'agent' | 'certificate';
  password?: string;
  privateKeyPath?: string;
  /** OpenSSH user certificate (`*-cert.pub`) for certificate auth. */
  certPath?: string;
  passphrase?: string;
  /** Optional jump (bastion) host the connection tunnels through. */
  jump?: SshJumpOptions;
  /** Append-mode file the backend tees decoded output into. */
  logPath?: string;
  cols: number;
  rows: number;
}

export type SshJumpOptions = Pick<
  SshConnectOptions,
  | 'host'
  | 'port'
  | 'username'
  | 'authMethod'
  | 'password'
  | 'privateKeyPath'
  | 'certPath'
  | 'passphrase'
>;

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

export interface HostKeyTimeoutPayload {
  request_id: string;
  host: string;
  port: number;
}

export interface KnownHost {
  host: string;
  algorithm: string;
  fingerprint: string;
  added_at: number;
  public_key?: string | null;
}

export interface KnownHostsImportResult {
  imported: number;
  skipped: number;
  invalid: number;
}

export interface KnownHostsExportResult {
  exported: number;
  skipped: number;
}

export type PortForwardKind = 'local' | 'remote' | 'dynamic';

export interface PortForwardInfo {
  id: string;
  ssh_id: string;
  kind: PortForwardKind;
  bind_host: string;
  bind_port: number;
  target_host: string;
  target_port: number;
}

export interface StartPortForwardOptions {
  sshId: string;
  kind: PortForwardKind;
  bindHost: string;
  bindPort: number;
  targetHost: string;
  targetPort: number;
}

export interface SftpEntry {
  name: string;
  path: string;
  is_dir: boolean;
  size: number;
  mtime: number;
  permissions: number | null;
}

export type SftpConflictPolicy = 'ask' | 'overwrite' | 'skip' | 'rename' | 'newer';

export interface SftpTransferOptions {
  recursive: boolean;
  resume: boolean;
  conflict: SftpConflictPolicy;
}

export interface SftpProgressPayload {
  transfer_id: string;
  direction: string;
  name: string;
  transferred: number;
  total: number;
  files_done: number;
  files_total: number;
}

export interface SftpTransferDonePayload {
  transfer_id: string;
  direction: string;
  name: string;
  success: boolean;
  cancelled: boolean;
  /** The failure was caused by the SSH connection dropping, not the file. */
  disconnected: boolean;
  error: string | null;
  transferred: number;
  total: number;
  files_done: number;
  files_total: number;
}

export interface SftpConflictPayload {
  request_id: string;
  transfer_id: string;
  direction: string;
  name: string;
  source_size: number;
  source_mtime: number;
  target_size: number;
  target_mtime: number;
}

export async function connectSsh(options: SshConnectOptions): Promise<string> {
  return invoke<string>('ssh_connect', {
    id: options.id,
    host: options.host,
    port: options.port,
    username: options.username,
    authMethod: options.authMethod,
    // Optional on the backend (`Option<String>`); agent / key / certificate
    // auth never reads it. Kept as a null-defaulted field so the payload shape
    // stays uniform across auth methods.
    password: options.password ?? null,
    privateKeyPath: options.privateKeyPath ?? null,
    certPath: options.certPath ?? null,
    passphrase: options.passphrase ?? null,
    jump: options.jump
      ? {
          host: options.jump.host,
          port: options.jump.port,
          username: options.jump.username,
          authMethod: options.jump.authMethod,
          password: options.jump.password ?? '',
          privateKeyPath: options.jump.privateKeyPath ?? null,
          certPath: options.jump.certPath ?? null,
          passphrase: options.jump.passphrase ?? null
        }
      : null,
    logPath: options.logPath ?? null,
    cols: options.cols,
    rows: options.rows
  });
}

/** Re-point the output log of a live session (SSH or local PTY). */
export async function setSessionLog(id: string, logPath: string | null): Promise<void> {
  await invoke('set_session_log', { id, logPath });
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

/** Why the backend read loop ended for a session. */
export interface SshClosedPayload {
  /**
   * `exit`: the remote shell ended on its own (user typed `exit`/logout) —
   * the UI must not auto-reconnect. `dropped`: transport failure.
   */
  reason: 'exit' | 'dropped';
  exit_status?: number | null;
}

export async function listenSshClosed(
  id: string,
  onClosed: (payload: SshClosedPayload) => void
): Promise<() => void> {
  return listen<SshClosedPayload>(`ssh-closed-${id}`, (event) => {
    // Older backends emitted a unit payload; treat that as a drop so the
    // reconnect behavior is unchanged if the two sides ever skew.
    onClosed(event.payload ?? { reason: 'dropped' });
  });
}

export async function uploadSftp(
  id: string,
  localPath: string,
  remotePath: string,
  options: SftpTransferOptions
): Promise<string> {
  return invoke<string>('sftp_upload', { id, localPath, remotePath, options });
}

export async function downloadSftp(
  id: string,
  remotePath: string,
  localPath: string,
  options: SftpTransferOptions
): Promise<string> {
  return invoke<string>('sftp_download', { id, remotePath, localPath, options });
}

export async function pauseSftpTransfer(transferId: string, paused: boolean): Promise<void> {
  await invoke('sftp_pause_transfer', { transferId, paused });
}

export async function cancelSftpTransfer(transferId: string): Promise<void> {
  await invoke('sftp_cancel_transfer', { transferId });
}

export type SftpConflictAction = 'overwrite' | 'skip' | 'rename' | 'cancel';

export async function respondSftpConflict(
  requestId: string,
  action: SftpConflictAction,
  applyToAll: boolean
): Promise<void> {
  await invoke('sftp_conflict_response', { requestId, action, applyToAll });
}

export async function listenSftpConflict(
  onConflict: (payload: SftpConflictPayload) => void
): Promise<() => void> {
  return listen<SftpConflictPayload>('sftp-conflict', (event) => {
    onConflict(event.payload);
  });
}

export async function importKnownHosts(path: string): Promise<KnownHostsImportResult> {
  return invoke<KnownHostsImportResult>('known_hosts_import', { path });
}

export async function exportKnownHosts(
  path: string,
  hashHosts: boolean
): Promise<KnownHostsExportResult> {
  return invoke<KnownHostsExportResult>('known_hosts_export', { path, hashHosts });
}

export async function listPortForwards(): Promise<PortForwardInfo[]> {
  return invoke<PortForwardInfo[]>('port_forward_list');
}

export async function startPortForward(options: StartPortForwardOptions): Promise<PortForwardInfo> {
  return invoke<PortForwardInfo>('port_forward_start', { ...options });
}

export async function stopPortForward(id: string): Promise<void> {
  await invoke('port_forward_stop', { id });
}

export async function listenPortForwardsChanged(onChange: () => void): Promise<() => void> {
  return listen('port-forwards-changed', () => {
    onChange();
  });
}

export async function removeSftp(id: string, path: string, isDir: boolean): Promise<void> {
  await invoke('sftp_remove', { id, path, isDir });
}

export async function renameSftp(id: string, from: string, to: string): Promise<void> {
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

export async function listenHostKeyTimeout(
  onTimeout: (payload: HostKeyTimeoutPayload) => void
): Promise<() => void> {
  return listen<HostKeyTimeoutPayload>('ssh-host-key-timeout', (event) => {
    onTimeout(event.payload);
  });
}

export interface RemoteEditSession {
  tempPath: string;
  size: number;
}

export async function remoteEditOpen(id: string, remotePath: string): Promise<RemoteEditSession> {
  return invoke<RemoteEditSession>('remote_edit_open', { id, remotePath });
}

export async function remoteEditStop(id: string, remotePath: string): Promise<void> {
  return invoke<void>('remote_edit_stop', { id, remotePath });
}
