//! SSH connection manager backed by `russh`, plus SFTP directory listing and
//! file transfers used by the file browser.

use std::{
    collections::HashMap,
    net::{Ipv4Addr, Ipv6Addr},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex, MutexGuard,
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use anyhow::{anyhow, Context};
use base64::{engine::general_purpose::STANDARD_NO_PAD, Engine as _};
use hmac::{Hmac, Mac};
use russh::{
    client,
    keys::{
        agent::{
            client::{AgentClient, AgentStream},
            AgentIdentity,
        },
        HashAlg, PublicKey, PublicKeyOrCertificate,
    },
    Channel, ChannelMsg, ChannelWriteHalf, Disconnect,
};
use russh_sftp::{client::SftpSession, protocol::OpenFlags};
use serde::{Deserialize, Serialize};
use sha1::Sha1;
use tauri::{AppHandle, Emitter};
use tokio::{
    io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt, SeekFrom},
    net::{TcpListener, TcpStream},
    sync::oneshot,
};
use uuid::Uuid;
use walkdir::WalkDir;

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poison| poison.into_inner())
}

fn now_unix() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0)
}

#[derive(Clone, Serialize, Deserialize)]
pub struct KnownHost {
    pub host: String,
    pub algorithm: String,
    pub fingerprint: String,
    pub added_at: u64,
    /// OpenSSH public key blob (`algorithm base64`), used for known_hosts export.
    #[serde(default)]
    pub public_key: Option<String>,
}

#[derive(Clone, Serialize)]
pub struct KnownHostsImportResult {
    pub imported: usize,
    pub skipped: usize,
    pub invalid: usize,
}

#[derive(Clone, Serialize)]
pub struct KnownHostsExportResult {
    pub exported: usize,
    pub skipped: usize,
}

#[derive(Clone, Serialize)]
pub struct PortForwardInfo {
    pub id: String,
    pub ssh_id: String,
    pub kind: String,
    pub bind_host: String,
    pub bind_port: u16,
    pub target_host: String,
    pub target_port: u16,
}

#[derive(Clone, Deserialize)]
pub struct SftpTransferOptions {
    #[serde(default)]
    pub recursive: bool,
    #[serde(default = "default_true")]
    pub resume: bool,
    #[serde(default = "default_conflict")]
    pub conflict: String,
}

fn default_true() -> bool {
    true
}

fn default_conflict() -> String {
    "overwrite".to_string()
}

impl Default for SftpTransferOptions {
    fn default() -> Self {
        Self {
            recursive: false,
            resume: true,
            conflict: default_conflict(),
        }
    }
}

pub struct HostKeyState {
    path: PathBuf,
    known: Mutex<HashMap<String, KnownHost>>,
    pending: Mutex<HashMap<String, oneshot::Sender<bool>>>,
}

impl HostKeyState {
    fn new(path: PathBuf) -> Self {
        let known = std::fs::read(&path)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Vec<KnownHost>>(&bytes).ok())
            .unwrap_or_default()
            .into_iter()
            .map(|entry| (entry.host.clone(), entry))
            .collect();

        Self {
            path,
            known: Mutex::new(known),
            pending: Mutex::new(HashMap::new()),
        }
    }

    fn list(&self) -> Vec<KnownHost> {
        let mut entries: Vec<KnownHost> = lock(&self.known).values().cloned().collect();
        entries.sort_by(|a, b| a.host.cmp(&b.host));
        entries
    }

    fn remove(&self, host: &str) {
        let mut known = lock(&self.known);
        known.remove(host);
        self.persist(&known);
    }

    fn add(
        &self,
        host: String,
        algorithm: String,
        fingerprint: String,
        public_key: Option<String>,
    ) {
        let mut known = lock(&self.known);
        known.insert(
            host.clone(),
            KnownHost {
                host,
                algorithm,
                fingerprint,
                added_at: now_unix(),
                public_key,
            },
        );
        self.persist(&known);
    }

    fn upsert(&self, entry: KnownHost) {
        let mut known = lock(&self.known);
        known.insert(entry.host.clone(), entry);
        self.persist(&known);
    }

    fn persist(&self, known: &HashMap<String, KnownHost>) {
        let entries: Vec<&KnownHost> = known.values().collect();
        if let Ok(json) = serde_json::to_vec_pretty(&entries) {
            if let Some(parent) = self.path.parent() {
                let _ = std::fs::create_dir_all(parent);
            }
            let _ = std::fs::write(&self.path, json);
        }
    }
}

pub struct SshManager {
    sessions: Mutex<HashMap<String, Arc<SshConnection>>>,
    host_keys: Arc<HostKeyState>,
    forwards: Mutex<HashMap<String, ForwardHandle>>,
    transfers: Arc<Mutex<HashMap<String, Arc<TransferControl>>>>,
}

struct SshConnection {
    handle: Arc<client::Handle<Client>>,
    writer: Arc<ChannelWriteHalf<client::Msg>>,
    sftp: tokio::sync::Mutex<Option<Arc<SftpSession>>>,
    remote_forwards: Arc<Mutex<HashMap<u32, (String, u16)>>>,
}

struct ForwardHandle {
    info: PortForwardInfo,
    task: Option<tokio::task::JoinHandle<()>>,
    handle: Arc<client::Handle<Client>>,
    remote_forwards: Arc<Mutex<HashMap<u32, (String, u16)>>>,
}

#[derive(Default)]
struct TransferControl {
    cancelled: AtomicBool,
    paused: AtomicBool,
}

pub struct Client {
    host_key: Arc<HostKeyState>,
    app: AppHandle,
    host: String,
    port: u16,
    host_label: String,
    remote_forwards: Arc<Mutex<HashMap<u32, (String, u16)>>>,
}

impl client::Handler for Client {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        server_public_key: &PublicKeyOrCertificate,
    ) -> Result<bool, Self::Error> {
        let key = server_public_key.public_key();
        let fingerprint = key.fingerprint(HashAlg::Sha256).to_string();
        let algorithm = format!("{:?}", key.algorithm());

        {
            let mut known = lock(&self.host_key.known);
            if let Some(entry) = known.get_mut(&self.host_label) {
                if entry.fingerprint == fingerprint {
                    if entry.public_key.is_none() {
                        // Backfill keys recorded before OpenSSH export support.
                        entry.public_key = key.to_openssh().ok();
                        self.host_key.persist(&known);
                    }
                    return Ok(true);
                }

                let _ = self.app.emit(
                    "ssh-host-key-mismatch",
                    HostKeyMismatchPayload {
                        host: self.host_label.clone(),
                        expected: entry.fingerprint.clone(),
                        actual: fingerprint,
                    },
                );
                return Ok(false);
            }
        }

        let request_id = Uuid::new_v4().to_string();
        let (sender, receiver) = oneshot::channel::<bool>();
        lock(&self.host_key.pending).insert(request_id.clone(), sender);

        let _ = self.app.emit(
            "ssh-host-key",
            HostKeyPromptPayload {
                request_id: request_id.clone(),
                host: self.host.clone(),
                port: self.port,
                fingerprint: fingerprint.clone(),
                algorithm: algorithm.clone(),
            },
        );

        let accepted = tokio::time::timeout(Duration::from_secs(120), receiver)
            .await
            .ok()
            .and_then(|result| result.ok())
            .unwrap_or(false);

        lock(&self.host_key.pending).remove(&request_id);

        if accepted {
            self.host_key.add(
                self.host_label.clone(),
                algorithm,
                fingerprint,
                key.to_openssh().ok(),
            );
            Ok(true)
        } else {
            Ok(false)
        }
    }

    async fn server_channel_open_forwarded_tcpip(
        &mut self,
        channel: Channel<russh::client::Msg>,
        _connected_address: &str,
        connected_port: u32,
        _originator_address: &str,
        _originator_port: u32,
        reply: client::ChannelOpenHandle,
        _session: &mut russh::client::Session,
    ) -> Result<(), Self::Error> {
        let target = lock(&self.remote_forwards).get(&connected_port).cloned();

        match target {
            Some((host, port)) => {
                reply.accept().await;
                tokio::spawn(async move {
                    if let Ok(mut stream) = TcpStream::connect((host.as_str(), port)).await {
                        let mut channel_stream = channel.into_stream();
                        let _ =
                            tokio::io::copy_bidirectional(&mut stream, &mut channel_stream).await;
                    }
                });
            }
            None => {
                reply
                    .reject(russh::ChannelOpenFailure::AdministrativelyProhibited)
                    .await;
            }
        }

        Ok(())
    }
}

#[derive(Clone, Serialize)]
struct HostKeyPromptPayload {
    request_id: String,
    host: String,
    port: u16,
    fingerprint: String,
    algorithm: String,
}

#[derive(Clone, Serialize)]
struct HostKeyMismatchPayload {
    host: String,
    expected: String,
    actual: String,
}

#[derive(Clone, Serialize)]
struct SshOutputPayload {
    id: String,
    data: String,
}

#[derive(Clone, Serialize)]
pub struct SftpEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub size: u64,
    pub mtime: u64,
    pub permissions: Option<u32>,
}

#[derive(Clone, Serialize)]
struct SftpProgressPayload {
    transfer_id: String,
    direction: String,
    name: String,
    transferred: u64,
    total: u64,
    files_done: usize,
    files_total: usize,
}

#[derive(Clone, Serialize)]
struct SftpTransferDonePayload {
    transfer_id: String,
    direction: String,
    name: String,
    success: bool,
    cancelled: bool,
    error: Option<String>,
    transferred: u64,
    total: u64,
    files_done: usize,
    files_total: usize,
}

fn basename(path: &str) -> String {
    path.rsplit(['/', '\\']).next().unwrap_or(path).to_string()
}

fn emit_progress(app: &AppHandle, payload: &SftpProgressPayload) {
    let _ = app.emit("sftp-progress", payload.clone());
}

fn emit_done(app: &AppHandle, payload: &SftpTransferDonePayload) {
    let _ = app.emit("sftp-transfer-done", payload.clone());
}

impl SshManager {
    pub fn new(known_hosts_path: PathBuf) -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
            host_keys: Arc::new(HostKeyState::new(known_hosts_path)),
            forwards: Mutex::new(HashMap::new()),
            transfers: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    fn host_keys(&self) -> Arc<HostKeyState> {
        self.host_keys.clone()
    }

    pub fn known_hosts(&self) -> anyhow::Result<Vec<KnownHost>> {
        Ok(self.host_keys().list())
    }

    pub fn remove_known_host(&self, host: &str) -> anyhow::Result<()> {
        self.host_keys().remove(host);
        Ok(())
    }

    pub fn resolve_host_key(&self, request_id: &str, accept: bool) {
        let host_keys = self.host_keys();
        let mut pending = lock(&host_keys.pending);
        if let Some(sender) = pending.remove(request_id) {
            let _ = sender.send(accept);
        }
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn connect(
        &self,
        app: AppHandle,
        host: String,
        port: u16,
        username: String,
        auth_method: String,
        password: String,
        private_key_path: Option<String>,
        passphrase: Option<String>,
        cols: u16,
        rows: u16,
    ) -> anyhow::Result<String> {
        let config = Arc::new(client::Config {
            inactivity_timeout: None,
            ..Default::default()
        });

        let remote_forwards = Arc::new(Mutex::new(HashMap::new()));
        let client = Client {
            host_key: self.host_keys(),
            app: app.clone(),
            host: host.clone(),
            port,
            host_label: format!("{host}:{port}"),
            remote_forwards: remote_forwards.clone(),
        };

        let mut handle = client::connect(config, (host.as_str(), port), client)
            .await
            .with_context(|| format!("failed to connect to {host}:{port}"))?;

        match auth_method.as_str() {
            "key" => {
                let key_path = private_key_path
                    .as_deref()
                    .ok_or_else(|| anyhow!("请选择私钥文件"))?;
                let key_pair = russh::keys::load_secret_key(key_path, passphrase.as_deref())
                    .with_context(|| format!("failed to load private key: {key_path}"))?;
                let hash = handle
                    .best_supported_rsa_hash()
                    .await
                    .context("failed to query RSA hash algorithm")?
                    .flatten();

                let auth = handle
                    .authenticate_publickey(
                        username,
                        russh::keys::PrivateKeyWithHashAlg::new(Arc::new(key_pair), hash),
                    )
                    .await
                    .context("SSH key authentication failed")?;

                if !auth.success() {
                    return Err(anyhow!("SSH 密钥认证失败，请检查私钥或用户名"));
                }
            }
            "agent" => {
                authenticate_with_agent(&mut handle, &username).await?;
            }
            _ => {
                let auth = handle
                    .authenticate_password(username, password)
                    .await
                    .context("SSH authentication failed")?;

                if !auth.success() {
                    return Err(anyhow!("SSH 认证失败，请检查用户名或密码"));
                }
            }
        }

        let channel = handle
            .channel_open_session()
            .await
            .context("failed to open SSH channel")?;

        channel
            .request_pty(true, "xterm-256color", cols as u32, rows as u32, 0, 0, &[])
            .await
            .context("failed to request PTY")?;

        channel
            .request_shell(true)
            .await
            .context("failed to request shell")?;

        let (mut read_half, write_half) = channel.split();
        let id = Uuid::new_v4().to_string();
        let writer = Arc::new(write_half);
        let handle = Arc::new(handle);

        let event_id = id.clone();
        let app_handle = app.clone();

        tokio::spawn(async move {
            while let Some(message) = read_half.wait().await {
                match message {
                    ChannelMsg::Data { data } | ChannelMsg::ExtendedData { data, .. } => {
                        let payload = SshOutputPayload {
                            id: event_id.clone(),
                            data: String::from_utf8_lossy(&data).to_string(),
                        };
                        let _ = app_handle.emit(&format!("ssh-output-{}", event_id), payload);
                    }
                    ChannelMsg::ExitStatus { .. } => break,
                    ChannelMsg::Eof | ChannelMsg::Close => break,
                    _ => {}
                }
            }

            let _ = app_handle.emit(&format!("ssh-closed-{}", event_id), ());
        });

        self.sessions
            .lock()
            .map_err(|_| anyhow!("failed to lock SSH sessions"))?
            .insert(
                id.clone(),
                Arc::new(SshConnection {
                    handle,
                    writer,
                    sftp: tokio::sync::Mutex::new(None),
                    remote_forwards,
                }),
            );

        Ok(id)
    }

    pub async fn write(&self, id: &str, data: &[u8]) -> anyhow::Result<()> {
        let writer = self.writer(id)?;
        writer
            .data_bytes(data.to_vec())
            .await
            .context("failed to write SSH data")?;
        Ok(())
    }

    pub async fn resize(&self, id: &str, cols: u16, rows: u16) -> anyhow::Result<()> {
        let writer = self.writer(id)?;
        writer
            .window_change(cols as u32, rows as u32, 0, 0)
            .await
            .context("failed to resize SSH PTY")?;
        Ok(())
    }

    pub async fn disconnect(&self, app: AppHandle, id: &str) -> anyhow::Result<()> {
        let active_forwards: Vec<String> = lock(&self.forwards)
            .iter()
            .filter(|(_, forward)| forward.info.ssh_id == id)
            .map(|(forward_id, _)| forward_id.clone())
            .collect();
        let had_forwards = !active_forwards.is_empty();

        for forward_id in active_forwards {
            let _ = self.stop_forward_inner(&forward_id).await;
        }

        if had_forwards {
            let _ = app.emit("port-forwards-changed", ());
        }

        let connection = self
            .sessions
            .lock()
            .map_err(|_| anyhow!("failed to lock SSH sessions"))?
            .remove(id);

        if let Some(connection) = connection {
            let _ = connection.writer.close().await;
            let _ = connection
                .handle
                .disconnect(Disconnect::ByApplication, "", "en")
                .await;
        }

        Ok(())
    }

    pub async fn sftp_list(&self, id: &str, path: String) -> anyhow::Result<Vec<SftpEntry>> {
        let sftp = self.open_sftp(id).await?;

        let directory = sftp
            .read_dir(path)
            .await
            .context("failed to read remote directory")?;

        let mut entries = Vec::new();
        for entry in directory {
            let metadata = entry.metadata();
            entries.push(SftpEntry {
                name: entry.file_name(),
                path: entry.path(),
                is_dir: entry.file_type().is_dir(),
                size: metadata.size.unwrap_or(0),
                mtime: metadata.mtime.unwrap_or(0) as u64,
                permissions: metadata.permissions,
            });
        }

        entries.sort_by(|a, b| {
            b.is_dir
                .cmp(&a.is_dir)
                .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
        });

        Ok(entries)
    }

    pub async fn sftp_download(
        &self,
        app: AppHandle,
        id: &str,
        remote_path: String,
        local_path: String,
        options: SftpTransferOptions,
    ) -> anyhow::Result<String> {
        let sftp = self.open_sftp(id).await?;
        let (transfer_id, control) = self.register_transfer()?;
        let event_id = transfer_id.clone();
        let name = basename(&remote_path);
        let app_handle = app.clone();
        let controls = self.transfers.clone();

        tokio::spawn(async move {
            let direction = "download".to_string();
            let result = run_download(
                sftp,
                &app_handle,
                &event_id,
                &name,
                &remote_path,
                &local_path,
                options,
                control.clone(),
            )
            .await;
            let cancelled = control.cancelled.load(Ordering::SeqCst);

            let payload = match result {
                Ok(report) => SftpTransferDonePayload {
                    transfer_id: event_id.clone(),
                    direction,
                    name,
                    success: true,
                    cancelled: false,
                    error: None,
                    transferred: report.transferred,
                    total: report.total,
                    files_done: report.files_done,
                    files_total: report.files_total,
                },
                Err(failure) => SftpTransferDonePayload {
                    transfer_id: event_id.clone(),
                    direction,
                    name,
                    success: false,
                    cancelled,
                    error: Some(failure.error.to_string()),
                    transferred: failure.report.transferred,
                    total: failure.report.total,
                    files_done: failure.report.files_done,
                    files_total: failure.report.files_total,
                },
            };
            emit_done(&app_handle, &payload);
            lock(&controls).remove(&event_id);
        });

        Ok(transfer_id)
    }

    pub async fn sftp_upload(
        &self,
        app: AppHandle,
        id: &str,
        local_path: String,
        remote_path: String,
        options: SftpTransferOptions,
    ) -> anyhow::Result<String> {
        let sftp = self.open_sftp(id).await?;
        let (transfer_id, control) = self.register_transfer()?;
        let event_id = transfer_id.clone();
        let name = basename(&local_path);
        let app_handle = app.clone();
        let controls = self.transfers.clone();

        tokio::spawn(async move {
            let direction = "upload".to_string();
            let result = run_upload(
                sftp,
                &app_handle,
                &event_id,
                &name,
                &local_path,
                &remote_path,
                options,
                control.clone(),
            )
            .await;
            let cancelled = control.cancelled.load(Ordering::SeqCst);

            let payload = match result {
                Ok(report) => SftpTransferDonePayload {
                    transfer_id: event_id.clone(),
                    direction,
                    name,
                    success: true,
                    cancelled: false,
                    error: None,
                    transferred: report.transferred,
                    total: report.total,
                    files_done: report.files_done,
                    files_total: report.files_total,
                },
                Err(failure) => SftpTransferDonePayload {
                    transfer_id: event_id.clone(),
                    direction,
                    name,
                    success: false,
                    cancelled,
                    error: Some(failure.error.to_string()),
                    transferred: failure.report.transferred,
                    total: failure.report.total,
                    files_done: failure.report.files_done,
                    files_total: failure.report.files_total,
                },
            };
            emit_done(&app_handle, &payload);
            lock(&controls).remove(&event_id);
        });

        Ok(transfer_id)
    }

    pub fn set_transfer_paused(&self, transfer_id: &str, paused: bool) -> anyhow::Result<()> {
        let transfers = lock(&self.transfers);
        let control = transfers
            .get(transfer_id)
            .ok_or_else(|| anyhow!("传输任务不存在"))?;
        control.paused.store(paused, Ordering::SeqCst);
        Ok(())
    }

    pub fn cancel_transfer(&self, transfer_id: &str) -> anyhow::Result<()> {
        let transfers = lock(&self.transfers);
        let control = transfers
            .get(transfer_id)
            .ok_or_else(|| anyhow!("传输任务不存在"))?;
        control.paused.store(false, Ordering::SeqCst);
        control.cancelled.store(true, Ordering::SeqCst);
        Ok(())
    }

    fn register_transfer(&self) -> anyhow::Result<(String, Arc<TransferControl>)> {
        let transfer_id = Uuid::new_v4().to_string();
        let control = Arc::new(TransferControl::default());
        lock(&self.transfers).insert(transfer_id.clone(), control.clone());
        Ok((transfer_id, control))
    }

    pub async fn sftp_remove(&self, id: &str, path: String, is_dir: bool) -> anyhow::Result<()> {
        let sftp = self.open_sftp(id).await?;
        let result = if is_dir {
            sftp.remove_dir(path).await
        } else {
            sftp.remove_file(path).await
        };
        result.context("failed to remove remote entry")
    }

    pub async fn sftp_rename(&self, id: &str, from: String, to: String) -> anyhow::Result<()> {
        let sftp = self.open_sftp(id).await?;
        sftp.rename(from, to)
            .await
            .context("failed to rename remote entry")
    }

    pub async fn sftp_mkdir(&self, id: &str, path: String) -> anyhow::Result<()> {
        let sftp = self.open_sftp(id).await?;
        sftp.create_dir(path)
            .await
            .context("failed to create remote directory")
    }

    pub fn import_known_hosts(&self, path: &str) -> anyhow::Result<KnownHostsImportResult> {
        let content = std::fs::read_to_string(path)
            .with_context(|| format!("failed to read known_hosts file: {path}"))?;
        let (entries, result) = parse_openssh_known_hosts(&content);

        for entry in entries {
            self.host_keys.upsert(entry);
        }

        Ok(result)
    }

    pub fn export_known_hosts(
        &self,
        path: &str,
        hash_hosts: bool,
    ) -> anyhow::Result<KnownHostsExportResult> {
        let entries = self.host_keys.list();
        let (content, result) = format_openssh_known_hosts(&entries, hash_hosts);
        std::fs::write(path, content)
            .with_context(|| format!("failed to write known_hosts file: {path}"))?;
        Ok(result)
    }

    pub fn list_port_forwards(&self) -> Vec<PortForwardInfo> {
        let mut forwards: Vec<PortForwardInfo> = lock(&self.forwards)
            .values()
            .map(|forward| forward.info.clone())
            .collect();
        forwards.sort_by(|a, b| {
            a.bind_port
                .cmp(&b.bind_port)
                .then_with(|| a.kind.cmp(&b.kind))
        });
        forwards
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn start_port_forward(
        &self,
        app: AppHandle,
        ssh_id: String,
        kind: String,
        bind_host: String,
        bind_port: u16,
        target_host: String,
        target_port: u16,
    ) -> anyhow::Result<PortForwardInfo> {
        let connection = self.connection(&ssh_id)?;
        let id = Uuid::new_v4().to_string();
        let bind_host = if bind_host.trim().is_empty() {
            "127.0.0.1".to_string()
        } else {
            bind_host.trim().to_string()
        };

        let (info, task) = match kind.as_str() {
            "local" | "dynamic" => {
                if kind == "local" && target_host.trim().is_empty() {
                    return Err(anyhow!("请填写目标主机"));
                }

                let listener = TcpListener::bind((bind_host.as_str(), bind_port))
                    .await
                    .with_context(|| format!("failed to bind {bind_host}:{bind_port}"))?;
                let actual_port = listener
                    .local_addr()
                    .context("failed to read bind address")?
                    .port();
                let task = spawn_forward_listener(
                    listener,
                    connection.handle.clone(),
                    kind == "dynamic",
                    target_host.clone(),
                    target_port,
                );

                (
                    PortForwardInfo {
                        id: id.clone(),
                        ssh_id: ssh_id.clone(),
                        kind: kind.clone(),
                        bind_host: bind_host.clone(),
                        bind_port: actual_port,
                        target_host: target_host.clone(),
                        target_port,
                    },
                    Some(task),
                )
            }
            "remote" => {
                if target_host.trim().is_empty() {
                    return Err(anyhow!("请填写目标主机"));
                }

                let actual_port = connection
                    .handle
                    .tcpip_forward(bind_host.clone(), bind_port as u32)
                    .await
                    .context("failed to request remote forwarding")?;
                let actual_port = u16::try_from(actual_port).unwrap_or(0);
                lock(&connection.remote_forwards)
                    .insert(actual_port as u32, (target_host.clone(), target_port));

                (
                    PortForwardInfo {
                        id: id.clone(),
                        ssh_id: ssh_id.clone(),
                        kind: kind.clone(),
                        bind_host: bind_host.clone(),
                        bind_port: actual_port,
                        target_host: target_host.clone(),
                        target_port,
                    },
                    None,
                )
            }
            _ => return Err(anyhow!("不支持的端口转发类型")),
        };

        lock(&self.forwards).insert(
            id,
            ForwardHandle {
                info: info.clone(),
                task,
                handle: connection.handle.clone(),
                remote_forwards: connection.remote_forwards.clone(),
            },
        );
        let _ = app.emit("port-forwards-changed", ());

        Ok(info)
    }

    pub async fn stop_port_forward(&self, app: AppHandle, id: &str) -> anyhow::Result<()> {
        self.stop_forward_inner(id).await?;
        let _ = app.emit("port-forwards-changed", ());
        Ok(())
    }

    async fn stop_forward_inner(&self, id: &str) -> anyhow::Result<()> {
        let forward = lock(&self.forwards)
            .remove(id)
            .ok_or_else(|| anyhow!("端口转发不存在"))?;

        if let Some(task) = forward.task {
            task.abort();
        }

        if forward.info.kind == "remote" {
            lock(&forward.remote_forwards).remove(&(forward.info.bind_port as u32));
            let _ = forward
                .handle
                .cancel_tcpip_forward(
                    forward.info.bind_host.clone(),
                    forward.info.bind_port as u32,
                )
                .await;
        }

        Ok(())
    }
    async fn open_sftp(&self, id: &str) -> anyhow::Result<Arc<SftpSession>> {
        let connection = self.connection(id)?;
        let mut cached = connection.sftp.lock().await;

        if let Some(session) = cached.as_ref() {
            return Ok(session.clone());
        }

        let channel = connection
            .handle
            .channel_open_session()
            .await
            .context("failed to open SFTP channel")?;
        channel
            .request_subsystem(true, "sftp")
            .await
            .context("failed to start SFTP subsystem")?;

        let session = Arc::new(
            SftpSession::new(channel.into_stream())
                .await
                .context("failed to initialize SFTP session")?,
        );
        *cached = Some(session.clone());

        Ok(session)
    }

    fn connection(&self, id: &str) -> anyhow::Result<Arc<SshConnection>> {
        let sessions = self
            .sessions
            .lock()
            .map_err(|_| anyhow!("failed to lock SSH sessions"))?;
        sessions
            .get(id)
            .cloned()
            .ok_or_else(|| anyhow!("SSH session not found"))
    }

    fn writer(&self, id: &str) -> anyhow::Result<Arc<ChannelWriteHalf<client::Msg>>> {
        Ok(self.connection(id)?.writer.clone())
    }
}

#[derive(Debug)]
struct TransferCancelled;

impl std::fmt::Display for TransferCancelled {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "transfer cancelled")
    }
}

impl std::error::Error for TransferCancelled {}

#[derive(Default, Clone, Copy)]
struct TransferReport {
    transferred: u64,
    total: u64,
    files_done: usize,
    files_total: usize,
}

struct TransferFailure {
    error: anyhow::Error,
    report: TransferReport,
}

impl TransferFailure {
    fn new(error: impl Into<anyhow::Error>) -> Self {
        Self {
            error: error.into(),
            report: TransferReport::default(),
        }
    }
}

impl TransferControl {
    async fn checkpoint(&self) -> anyhow::Result<()> {
        loop {
            if self.cancelled.load(Ordering::SeqCst) {
                return Err(TransferCancelled.into());
            }
            if !self.paused.load(Ordering::SeqCst) {
                return Ok(());
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    }
}

struct TransferProgress {
    app: AppHandle,
    transfer_id: String,
    direction: &'static str,
    name: String,
    report: TransferReport,
    last_emit: Instant,
}

impl TransferProgress {
    fn new(
        app: AppHandle,
        transfer_id: &str,
        direction: &'static str,
        name: &str,
        total: u64,
        files_total: usize,
    ) -> Self {
        Self {
            app,
            transfer_id: transfer_id.to_string(),
            direction,
            name: name.to_string(),
            report: TransferReport {
                total,
                files_total,
                ..Default::default()
            },
            last_emit: Instant::now() - Duration::from_secs(1),
        }
    }

    fn add(&mut self, bytes: u64) {
        self.report.transferred += bytes;
    }

    fn file_done(&mut self) {
        self.report.files_done += 1;
    }

    fn emit(&mut self, force: bool) {
        let now = Instant::now();
        if !force && now.duration_since(self.last_emit) < Duration::from_millis(150) {
            return;
        }
        self.last_emit = now;
        emit_progress(
            &self.app,
            &SftpProgressPayload {
                transfer_id: self.transfer_id.clone(),
                direction: self.direction.to_string(),
                name: self.name.clone(),
                transferred: self.report.transferred,
                total: self.report.total,
                files_done: self.report.files_done,
                files_total: self.report.files_total,
            },
        );
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum ConflictPolicy {
    Overwrite,
    Skip,
    Rename,
}

impl ConflictPolicy {
    fn parse(value: &str) -> Self {
        match value {
            "skip" => Self::Skip,
            "rename" => Self::Rename,
            _ => Self::Overwrite,
        }
    }
}

fn split_file_name(name: &str) -> (&str, Option<&str>) {
    match name.rsplit_once('.') {
        Some((stem, extension)) if !stem.is_empty() => (stem, Some(extension)),
        _ => (name, None),
    }
}

fn unique_local_path(path: &Path) -> PathBuf {
    if !path.exists() {
        return path.to_path_buf();
    }

    let parent = path.parent().unwrap_or_else(|| Path::new(""));
    let name = path
        .file_name()
        .map(|value| value.to_string_lossy().to_string())
        .unwrap_or_default();
    let (stem, extension) = split_file_name(&name);

    for index in 1..1000 {
        let candidate = match extension {
            Some(extension) => format!("{stem} ({index}).{extension}"),
            None => format!("{stem} ({index})"),
        };
        let candidate = parent.join(candidate);
        if !candidate.exists() {
            return candidate;
        }
    }

    path.to_path_buf()
}

async fn unique_remote_path(sftp: &SftpSession, path: &str) -> String {
    let (directory, name) = match path.rsplit_once('/') {
        Some((directory, name)) => (directory, name),
        None => ("", path),
    };
    let (stem, extension) = split_file_name(name);

    for index in 1..1000 {
        let candidate_name = match extension {
            Some(extension) => format!("{stem} ({index}).{extension}"),
            None => format!("{stem} ({index})"),
        };
        let candidate = if directory.is_empty() {
            candidate_name
        } else if directory == "/" {
            format!("/{candidate_name}")
        } else {
            format!("{directory}/{candidate_name}")
        };

        if !sftp.try_exists(&candidate).await.unwrap_or(false) {
            return candidate;
        }
    }

    path.to_string()
}

fn remote_join(base: &str, relative: &Path) -> String {
    let relative = relative.to_string_lossy().replace('\\', "/");
    let relative = relative.trim_start_matches('/');
    if base.ends_with('/') {
        format!("{base}{relative}")
    } else {
        format!("{base}/{relative}")
    }
}

async fn ensure_remote_dir(sftp: &SftpSession, path: &str) -> anyhow::Result<()> {
    if path.is_empty() || path == "/" {
        return Ok(());
    }

    let mut current = String::new();
    for part in path.split('/').filter(|part| !part.is_empty()) {
        if current.is_empty() {
            if path.starts_with('/') {
                current.push('/');
            }
            current.push_str(part);
        } else if current == "/" {
            current.push_str(part);
        } else {
            current.push('/');
            current.push_str(part);
        }

        if !sftp.try_exists(&current).await.unwrap_or(false) {
            let _ = sftp.create_dir(&current).await;
        }
    }

    Ok(())
}

struct RemoteFile {
    remote: String,
    relative: String,
    size: u64,
}

async fn collect_remote_files(
    sftp: &SftpSession,
    root: &str,
    out: &mut Vec<RemoteFile>,
) -> anyhow::Result<()> {
    let mut stack = vec![(root.to_string(), String::new())];

    while let Some((directory, relative_base)) = stack.pop() {
        let mut entries = sftp.read_dir(&directory).await?;

        for entry in entries.by_ref() {
            let name = entry.file_name();
            let relative = if relative_base.is_empty() {
                name.clone()
            } else {
                format!("{relative_base}/{name}")
            };

            if entry.file_type().is_dir() {
                stack.push((entry.path(), relative));
            } else if entry.file_type().is_file() {
                out.push(RemoteFile {
                    remote: entry.path(),
                    relative,
                    size: entry.metadata().size.unwrap_or(0),
                });
            }
        }
    }

    Ok(())
}

struct LocalFile {
    local: PathBuf,
    relative: PathBuf,
    size: u64,
}

fn collect_local_files(root: &Path) -> anyhow::Result<Vec<LocalFile>> {
    let mut files = Vec::new();
    let metadata = std::fs::symlink_metadata(root)?;

    if metadata.is_file() {
        files.push(LocalFile {
            local: root.to_path_buf(),
            relative: root.file_name().map(PathBuf::from).unwrap_or_default(),
            size: metadata.len(),
        });
        return Ok(files);
    }

    for entry in WalkDir::new(root).follow_links(false) {
        let entry = entry?;
        if entry.file_type().is_file() {
            files.push(LocalFile {
                local: entry.path().to_path_buf(),
                relative: entry.path().strip_prefix(root)?.to_path_buf(),
                size: entry.metadata()?.len(),
            });
        }
    }

    Ok(files)
}

#[allow(clippy::too_many_arguments)]
async fn run_download(
    sftp: Arc<SftpSession>,
    app: &AppHandle,
    transfer_id: &str,
    name: &str,
    remote_path: &str,
    local_path: &str,
    options: SftpTransferOptions,
    control: Arc<TransferControl>,
) -> Result<TransferReport, TransferFailure> {
    let metadata = sftp
        .metadata(remote_path)
        .await
        .map_err(TransferFailure::new)?;
    let is_dir = metadata.is_dir();
    let mut files = Vec::new();

    if is_dir {
        if !options.recursive {
            return Err(TransferFailure::new(anyhow!("目标是目录，请开启递归下载")));
        }
        collect_remote_files(&sftp, remote_path, &mut files)
            .await
            .map_err(TransferFailure::new)?;
    } else {
        files.push(RemoteFile {
            remote: remote_path.to_string(),
            relative: basename(remote_path),
            size: metadata.size.unwrap_or(0),
        });
    }

    let total = files.iter().map(|file| file.size).sum();
    let mut progress = TransferProgress::new(
        app.clone(),
        transfer_id,
        "download",
        name,
        total,
        files.len(),
    );
    progress.emit(true);

    let policy = ConflictPolicy::parse(&options.conflict);
    let local_root = PathBuf::from(local_path);

    let result: anyhow::Result<()> = async {
        for file in &files {
            control.checkpoint().await?;

            let target = if is_dir {
                local_root.join(Path::new(&file.relative))
            } else {
                local_root.clone()
            };

            if let Some(parent) = target.parent() {
                tokio::fs::create_dir_all(parent).await?;
            }

            let target = match policy {
                ConflictPolicy::Skip if target.exists() => {
                    progress.add(file.size);
                    progress.file_done();
                    progress.emit(false);
                    continue;
                }
                ConflictPolicy::Rename => unique_local_path(&target),
                _ => target,
            };

            download_file(
                &sftp,
                &file.remote,
                target.as_path(),
                options.resume,
                &control,
                &mut progress,
            )
            .await?;
        }
        Ok(())
    }
    .await;

    match result {
        Ok(()) => Ok(progress.report),
        Err(error) => Err(TransferFailure {
            error,
            report: progress.report,
        }),
    }
}

#[allow(clippy::too_many_arguments)]
async fn run_upload(
    sftp: Arc<SftpSession>,
    app: &AppHandle,
    transfer_id: &str,
    name: &str,
    local_path: &str,
    remote_path: &str,
    options: SftpTransferOptions,
    control: Arc<TransferControl>,
) -> Result<TransferReport, TransferFailure> {
    let root = PathBuf::from(local_path);
    let metadata = tokio::fs::symlink_metadata(&root)
        .await
        .map_err(TransferFailure::new)?;
    let is_dir = metadata.is_dir();

    if is_dir && !options.recursive {
        return Err(TransferFailure::new(anyhow!("目标是目录，请开启递归上传")));
    }

    let files = tokio::task::spawn_blocking(move || collect_local_files(&root))
        .await
        .map_err(|error| TransferFailure::new(anyhow!(error)))?
        .map_err(TransferFailure::new)?;

    let total = files.iter().map(|file| file.size).sum();
    let mut progress =
        TransferProgress::new(app.clone(), transfer_id, "upload", name, total, files.len());
    progress.emit(true);

    let policy = ConflictPolicy::parse(&options.conflict);

    let result: anyhow::Result<()> = async {
        for file in &files {
            control.checkpoint().await?;

            let target = if is_dir {
                remote_join(remote_path, &file.relative)
            } else {
                remote_path.to_string()
            };

            if let Some((parent, _)) = target.rsplit_once('/') {
                ensure_remote_dir(&sftp, parent).await?;
            }

            let target = match policy {
                ConflictPolicy::Skip if sftp.try_exists(&target).await.unwrap_or(false) => {
                    progress.add(file.size);
                    progress.file_done();
                    progress.emit(false);
                    continue;
                }
                ConflictPolicy::Rename => unique_remote_path(&sftp, &target).await,
                _ => target,
            };

            upload_file(
                &sftp,
                file.local.as_path(),
                &target,
                options.resume,
                &control,
                &mut progress,
            )
            .await?;
        }
        Ok(())
    }
    .await;

    match result {
        Ok(()) => Ok(progress.report),
        Err(error) => Err(TransferFailure {
            error,
            report: progress.report,
        }),
    }
}

async fn download_file(
    sftp: &SftpSession,
    remote_path: &str,
    local_path: &Path,
    resume: bool,
    control: &TransferControl,
    progress: &mut TransferProgress,
) -> anyhow::Result<()> {
    control.checkpoint().await?;

    let metadata = sftp
        .metadata(remote_path)
        .await
        .context("failed to read remote file metadata")?;
    let size = metadata.size.unwrap_or(0);
    let part_path = PathBuf::from(format!("{}.part", local_path.display()));

    let mut offset = 0u64;
    if resume {
        if let Ok(metadata) = tokio::fs::metadata(&part_path).await {
            let length = metadata.len();
            if length <= size {
                offset = length;
            }
        }
    }

    if offset == 0 {
        let _ = tokio::fs::remove_file(&part_path).await;
    }

    let mut remote = sftp
        .open_with_flags(remote_path, OpenFlags::READ)
        .await
        .context("failed to open remote file")?;
    if offset > 0 {
        remote
            .seek(SeekFrom::Start(offset))
            .await
            .context("failed to seek remote file")?;
    }

    let mut local = tokio::fs::OpenOptions::new()
        .create(true)
        .write(true)
        .append(offset > 0)
        .truncate(offset == 0)
        .open(&part_path)
        .await
        .with_context(|| format!("failed to create local file: {}", part_path.display()))?;

    progress.add(offset);

    let mut buffer = vec![0u8; 64 * 1024];
    loop {
        control.checkpoint().await?;

        let read = remote
            .read(&mut buffer)
            .await
            .context("failed to read remote file")?;
        if read == 0 {
            break;
        }

        local
            .write_all(&buffer[..read])
            .await
            .context("failed to write local file")?;
        progress.add(read as u64);
        progress.emit(false);
    }

    local.flush().await.context("failed to flush local file")?;
    drop(local);
    drop(remote);

    let _ = tokio::fs::remove_file(local_path).await;
    tokio::fs::rename(&part_path, local_path)
        .await
        .context("failed to finalize local file")?;

    progress.file_done();
    progress.emit(false);

    Ok(())
}

async fn upload_file(
    sftp: &SftpSession,
    local_path: &Path,
    remote_path: &str,
    resume: bool,
    control: &TransferControl,
    progress: &mut TransferProgress,
) -> anyhow::Result<()> {
    control.checkpoint().await?;

    let metadata = tokio::fs::metadata(local_path)
        .await
        .with_context(|| format!("failed to read local file: {}", local_path.display()))?;
    let size = metadata.len();

    let remote_size = sftp
        .metadata(remote_path)
        .await
        .ok()
        .and_then(|metadata| metadata.size)
        .unwrap_or(0);

    if resume && size > 0 && remote_size == size {
        progress.add(size);
        progress.file_done();
        progress.emit(false);
        return Ok(());
    }

    let offset = if resume && remote_size > 0 && remote_size < size {
        remote_size
    } else {
        0
    };

    let mut local = tokio::fs::File::open(local_path)
        .await
        .with_context(|| format!("failed to open local file: {}", local_path.display()))?;
    if offset > 0 {
        local
            .seek(SeekFrom::Start(offset))
            .await
            .context("failed to seek local file")?;
    }

    let mut flags = OpenFlags::CREATE | OpenFlags::WRITE;
    if offset == 0 {
        flags |= OpenFlags::TRUNCATE;
    }

    let mut remote = sftp
        .open_with_flags(remote_path, flags)
        .await
        .context("failed to open remote file for writing")?;
    if offset > 0 {
        remote
            .seek(SeekFrom::Start(offset))
            .await
            .context("failed to seek remote file")?;
    }

    progress.add(offset);

    let mut buffer = vec![0u8; 64 * 1024];
    loop {
        control.checkpoint().await?;

        let read = local
            .read(&mut buffer)
            .await
            .context("failed to read local file")?;
        if read == 0 {
            break;
        }

        remote
            .write_all(&buffer[..read])
            .await
            .context("failed to write remote file")?;
        progress.add(read as u64);
        progress.emit(false);
    }

    remote
        .flush()
        .await
        .context("failed to flush remote file")?;
    remote
        .close()
        .await
        .context("failed to close remote file")?;

    progress.file_done();
    progress.emit(false);

    Ok(())
}
async fn connect_agent() -> anyhow::Result<AgentClient<Box<dyn AgentStream + Send + Unpin>>> {
    #[cfg(unix)]
    {
        let client = AgentClient::connect_env()
            .await
            .context("SSH_AUTH_SOCK is not available")?;
        Ok(client.dynamic())
    }

    #[cfg(windows)]
    {
        if let Ok(client) = AgentClient::connect_named_pipe(r"\\.\pipe\openssh-ssh-agent").await {
            return Ok(client.dynamic());
        }

        let client = AgentClient::connect_pageant()
            .await
            .context("Windows OpenSSH agent / Pageant is not running")?;
        Ok(client.dynamic())
    }

    #[cfg(not(any(unix, windows)))]
    {
        Err(anyhow!("SSH agent is not supported on this platform"))
    }
}

async fn authenticate_with_agent(
    handle: &mut client::Handle<Client>,
    username: &str,
) -> anyhow::Result<()> {
    let mut agent = connect_agent().await?;
    let identities = agent
        .request_identities()
        .await
        .context("failed to list SSH agent identities")?;

    if identities.is_empty() {
        return Err(anyhow!("SSH agent 中没有可用身份"));
    }

    let hash = handle
        .best_supported_rsa_hash()
        .await
        .context("failed to query RSA hash algorithm")?
        .flatten();
    let mut last_error = None;

    for identity in identities {
        let result = match identity {
            AgentIdentity::PublicKey { key, .. } => {
                handle
                    .authenticate_publickey_with(username.to_string(), key, hash, &mut agent)
                    .await
            }
            AgentIdentity::Certificate { certificate, .. } => {
                handle
                    .authenticate_certificate_with(
                        username.to_string(),
                        certificate,
                        hash,
                        &mut agent,
                    )
                    .await
            }
        };

        match result {
            Ok(auth) if auth.success() => return Ok(()),
            Ok(_) => {}
            Err(error) => last_error = Some(error.to_string()),
        }
    }

    Err(match last_error {
        Some(error) => anyhow!("SSH agent 认证失败：{error}"),
        None => anyhow!("SSH agent 认证失败"),
    })
}

fn spawn_forward_listener(
    listener: TcpListener,
    handle: Arc<client::Handle<Client>>,
    dynamic: bool,
    target_host: String,
    target_port: u16,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        loop {
            let Ok((mut socket, peer)) = listener.accept().await else {
                break;
            };

            let handle = handle.clone();
            let target_host = target_host.clone();

            tokio::spawn(async move {
                let (host, port) = if dynamic {
                    match socks5_handshake(&mut socket).await {
                        Ok(target) => target,
                        Err(_) => {
                            let _ = socket.write_all(&[5, 7, 0, 1, 0, 0, 0, 0, 0, 0]).await;
                            return;
                        }
                    }
                } else {
                    (target_host, target_port)
                };

                match handle
                    .channel_open_direct_tcpip(
                        host,
                        port as u32,
                        peer.ip().to_string(),
                        peer.port() as u32,
                    )
                    .await
                {
                    Ok(channel) => {
                        if dynamic
                            && socket
                                .write_all(&[5, 0, 0, 1, 0, 0, 0, 0, 0, 0])
                                .await
                                .is_err()
                        {
                            return;
                        }

                        let mut stream = channel.into_stream();
                        let _ = tokio::io::copy_bidirectional(&mut socket, &mut stream).await;
                    }
                    Err(_) if dynamic => {
                        let _ = socket.write_all(&[5, 5, 0, 1, 0, 0, 0, 0, 0, 0]).await;
                    }
                    Err(_) => {}
                }
            });
        }
    })
}

async fn socks5_handshake(socket: &mut TcpStream) -> anyhow::Result<(String, u16)> {
    let mut header = [0u8; 2];
    socket.read_exact(&mut header).await?;
    if header[0] != 5 {
        return Err(anyhow!("unsupported SOCKS version"));
    }

    let mut methods = vec![0u8; header[1] as usize];
    socket.read_exact(&mut methods).await?;
    socket.write_all(&[5, 0]).await?;

    let mut request = [0u8; 4];
    socket.read_exact(&mut request).await?;
    if request[0] != 5 || request[1] != 1 {
        return Err(anyhow!("unsupported SOCKS command"));
    }

    let host = match request[3] {
        1 => {
            let mut address = [0u8; 4];
            socket.read_exact(&mut address).await?;
            Ipv4Addr::from(address).to_string()
        }
        3 => {
            let mut length = [0u8; 1];
            socket.read_exact(&mut length).await?;
            let mut address = vec![0u8; length[0] as usize];
            socket.read_exact(&mut address).await?;
            String::from_utf8(address)?
        }
        4 => {
            let mut address = [0u8; 16];
            socket.read_exact(&mut address).await?;
            Ipv6Addr::from(address).to_string()
        }
        _ => return Err(anyhow!("unsupported SOCKS address type")),
    };

    let mut port = [0u8; 2];
    socket.read_exact(&mut port).await?;

    Ok((host, u16::from_be_bytes(port)))
}

fn parse_openssh_known_hosts(content: &str) -> (Vec<KnownHost>, KnownHostsImportResult) {
    let mut entries = Vec::new();
    let mut result = KnownHostsImportResult {
        imported: 0,
        skipped: 0,
        invalid: 0,
    };

    for line in content.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }

        let mut parts = line.split_whitespace();
        let Some(hosts) = parts.next() else {
            continue;
        };

        if hosts.starts_with('@') {
            result.skipped += 1;
            continue;
        }

        let (Some(key_type), Some(key_data)) = (parts.next(), parts.next()) else {
            result.invalid += 1;
            continue;
        };

        let key = match PublicKey::from_openssh(&format!("{key_type} {key_data}")) {
            Ok(key) => key,
            Err(_) => {
                result.invalid += 1;
                continue;
            }
        };
        let algorithm = format!("{:?}", key.algorithm());
        let fingerprint = key.fingerprint(HashAlg::Sha256).to_string();
        let public_key = key.to_openssh().ok();

        for pattern in hosts.split(',') {
            match openssh_host_to_label(pattern) {
                Some(host) => {
                    entries.push(KnownHost {
                        host,
                        algorithm: algorithm.clone(),
                        fingerprint: fingerprint.clone(),
                        added_at: now_unix(),
                        public_key: public_key.clone(),
                    });
                    result.imported += 1;
                }
                None => result.skipped += 1,
            }
        }
    }

    (entries, result)
}

fn openssh_host_to_label(pattern: &str) -> Option<String> {
    if pattern.is_empty()
        || pattern.starts_with('|')
        || pattern.starts_with('!')
        || pattern.contains('*')
        || pattern.contains('?')
    {
        return None;
    }

    let (host, port) = if let Some(rest) = pattern.strip_prefix('[') {
        match rest.split_once("]:") {
            Some((host, port)) => (host, port.parse::<u16>().ok()?),
            None => (rest.strip_suffix(']')?, 22),
        }
    } else if let Some((host, port)) = pattern.rsplit_once(':') {
        match port.parse::<u16>() {
            Ok(port) => (host, port),
            Err(_) => (pattern, 22),
        }
    } else {
        (pattern, 22)
    };

    if host.is_empty() {
        return None;
    }

    Some(format!("{host}:{port}"))
}

fn openssh_host_field(label: &str) -> Option<String> {
    let (host, port) = match label.rsplit_once(':') {
        Some((host, port)) => (host, port.parse::<u16>().ok()?),
        None => (label, 22),
    };

    if host.is_empty() {
        return None;
    }

    if port == 22 && !host.contains(':') {
        Some(host.to_string())
    } else {
        Some(format!("[{host}]:{port}"))
    }
}

fn hash_openssh_host(host: &str) -> String {
    let salt: [u8; 20] = rand::random();
    let mut mac = Hmac::<Sha1>::new_from_slice(&salt).expect("HMAC accepts any key size");
    mac.update(host.as_bytes());
    let digest = mac.finalize().into_bytes();

    format!(
        "|1|{}|{}",
        STANDARD_NO_PAD.encode(salt),
        STANDARD_NO_PAD.encode(digest)
    )
}

fn format_openssh_known_hosts(
    entries: &[KnownHost],
    hash_hosts: bool,
) -> (String, KnownHostsExportResult) {
    let mut lines = Vec::new();
    let mut result = KnownHostsExportResult {
        exported: 0,
        skipped: 0,
    };

    for entry in entries {
        let Some(public_key) = entry
            .public_key
            .as_deref()
            .filter(|value| !value.is_empty())
        else {
            result.skipped += 1;
            continue;
        };
        let Some(host_field) = openssh_host_field(&entry.host) else {
            result.skipped += 1;
            continue;
        };

        let host_field = if hash_hosts {
            hash_openssh_host(&host_field)
        } else {
            host_field
        };
        lines.push(format!("{host_field} {public_key}"));
        result.exported += 1;
    }

    let content = if lines.is_empty() {
        String::new()
    } else {
        format!("{}\n", lines.join("\n"))
    };

    (content, result)
}
#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn read_known_hosts(path: &std::path::Path) -> Vec<KnownHost> {
        let bytes = std::fs::read(path).expect("known_hosts file should exist");
        serde_json::from_slice(&bytes).expect("known_hosts should be valid JSON")
    }

    #[test]
    fn basename_handles_both_separators() {
        assert_eq!(basename("/home/user/file.txt"), "file.txt");
        assert_eq!(basename(r"C:\Users\user\file.txt"), "file.txt");
        assert_eq!(basename("/home/user/dir/"), "");
        assert_eq!(basename("plain"), "plain");
        assert_eq!(basename(""), "");
    }

    #[test]
    fn known_hosts_starts_empty_when_file_is_missing() {
        let dir = tempdir().unwrap();
        let state = HostKeyState::new(dir.path().join("known_hosts.json"));

        assert!(state.list().is_empty());
    }

    #[test]
    fn known_hosts_ignores_corrupted_json() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("known_hosts.json");
        std::fs::write(&path, b"not json").unwrap();

        let state = HostKeyState::new(path);

        assert!(state.list().is_empty());
    }

    #[test]
    fn add_persists_entries_and_sorts_them_by_host() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("nested").join("known_hosts.json");
        let state = HostKeyState::new(path.clone());

        state.add("zeta:22".into(), "Rsa".into(), "SHA256:zeta".into(), None);
        state.add(
            "alpha:22".into(),
            "Ed25519".into(),
            "SHA256:alpha".into(),
            None,
        );

        let entries = state.list();
        assert_eq!(
            entries
                .iter()
                .map(|entry| entry.host.as_str())
                .collect::<Vec<_>>(),
            vec!["alpha:22", "zeta:22"]
        );
        assert_eq!(entries[0].algorithm, "Ed25519");
        assert!(entries[0].added_at > 0);

        let persisted = read_known_hosts(&path);
        assert_eq!(persisted.len(), 2);
    }

    #[test]
    fn add_replaces_an_existing_host_entry() {
        let dir = tempdir().unwrap();
        let state = HostKeyState::new(dir.path().join("known_hosts.json"));

        state.add("host:22".into(), "Rsa".into(), "SHA256:old".into(), None);
        state.add("host:22".into(), "Rsa".into(), "SHA256:new".into(), None);

        let entries = state.list();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].fingerprint, "SHA256:new");
    }

    #[test]
    fn remove_deletes_and_persists_the_change() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("known_hosts.json");
        let state = HostKeyState::new(path.clone());
        state.add("keep:22".into(), "Rsa".into(), "SHA256:keep".into(), None);
        state.add("drop:22".into(), "Rsa".into(), "SHA256:drop".into(), None);

        state.remove("drop:22");

        assert_eq!(state.list().len(), 1);
        let reloaded = HostKeyState::new(path);
        let entries = reloaded.list();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].host, "keep:22");
    }

    #[test]
    fn loads_previously_persisted_entries() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("known_hosts.json");
        let saved = vec![KnownHost {
            host: "saved:2222".into(),
            algorithm: "Ed25519".into(),
            fingerprint: "SHA256:saved".into(),
            added_at: 42,
            public_key: None,
        }];
        std::fs::write(&path, serde_json::to_vec(&saved).unwrap()).unwrap();

        let state = HostKeyState::new(path);
        let entries = state.list();

        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].host, "saved:2222");
        assert_eq!(entries[0].added_at, 42);
    }

    #[test]
    fn resolve_host_key_forwards_the_decision() {
        let dir = tempdir().unwrap();
        let manager = SshManager::new(dir.path().join("known_hosts.json"));
        let (sender, mut receiver) = oneshot::channel::<bool>();
        lock(&manager.host_keys.pending).insert("request-1".into(), sender);

        manager.resolve_host_key("request-1", true);

        assert_eq!(receiver.try_recv(), Ok(true));
        assert!(lock(&manager.host_keys.pending).is_empty());
    }

    #[test]
    fn resolve_host_key_ignores_unknown_requests() {
        let dir = tempdir().unwrap();
        let manager = SshManager::new(dir.path().join("known_hosts.json"));

        manager.resolve_host_key("missing", false);

        assert!(lock(&manager.host_keys.pending).is_empty());
    }

    const TEST_KEY: &str = "AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl";

    fn known_host(host: &str, public_key: Option<&str>) -> KnownHost {
        KnownHost {
            host: host.to_string(),
            algorithm: "Ed25519".to_string(),
            fingerprint: "SHA256:test".to_string(),
            added_at: 1,
            public_key: public_key.map(str::to_string),
        }
    }

    #[test]
    fn openssh_host_labels_round_trip() {
        assert_eq!(
            openssh_host_to_label("example.com").as_deref(),
            Some("example.com:22")
        );
        assert_eq!(
            openssh_host_to_label("[example.com]:2222").as_deref(),
            Some("example.com:2222")
        );
        assert_eq!(openssh_host_to_label("[::1]:22").as_deref(), Some("::1:22"));
        assert_eq!(openssh_host_to_label("|1|salt|hash"), None);
        assert_eq!(openssh_host_to_label("*.example.com"), None);
        assert_eq!(openssh_host_to_label("!bad.example.com"), None);

        assert_eq!(
            openssh_host_field("example.com:22").as_deref(),
            Some("example.com")
        );
        assert_eq!(
            openssh_host_field("example.com:2222").as_deref(),
            Some("[example.com]:2222")
        );
        assert_eq!(openssh_host_field("::1:22").as_deref(), Some("[::1]:22"));
    }

    #[test]
    fn parses_openssh_known_hosts_entries() {
        let content = format!(
            "# comment\n\
             example.com ssh-ed25519 {TEST_KEY}\n\
             [example.com]:2222 ssh-ed25519 {TEST_KEY}\n\
             |1|salt|hash ssh-ed25519 {TEST_KEY}\n\
             @revoked * ssh-ed25519 {TEST_KEY}\n\
             *.example.com ssh-ed25519 {TEST_KEY}\n\
             not-a-valid-line\n"
        );

        let (entries, result) = parse_openssh_known_hosts(&content);

        assert_eq!(result.imported, 2);
        assert_eq!(result.skipped, 3);
        assert_eq!(result.invalid, 1);
        assert_eq!(entries.len(), 2);
        assert!(entries.iter().any(|entry| entry.host == "example.com:22"));
        assert!(entries.iter().any(|entry| entry.host == "example.com:2222"));
        assert!(entries.iter().all(|entry| entry.public_key.is_some()));
        assert!(entries
            .iter()
            .all(|entry| entry.fingerprint.starts_with("SHA256:")));
    }

    #[test]
    fn formats_openssh_known_hosts_entries() {
        let entries = vec![
            known_host("example.com:22", Some(&format!("ssh-ed25519 {TEST_KEY}"))),
            known_host("example.com:2222", Some(&format!("ssh-ed25519 {TEST_KEY}"))),
            known_host("missing-key:22", None),
        ];

        let (content, result) = format_openssh_known_hosts(&entries, false);

        assert_eq!(result.exported, 2);
        assert_eq!(result.skipped, 1);
        assert!(content.contains(&format!("example.com ssh-ed25519 {TEST_KEY}")));
        assert!(content.contains(&format!("[example.com]:2222 ssh-ed25519 {TEST_KEY}")));
    }

    #[test]
    fn formats_hashed_known_hosts_entries() {
        let entries = vec![known_host(
            "example.com:22",
            Some(&format!("ssh-ed25519 {TEST_KEY}")),
        )];
        let (content, result) = format_openssh_known_hosts(&entries, true);

        assert_eq!(result.exported, 1);
        let host_field = content.split_whitespace().next().unwrap();
        let parts: Vec<&str> = host_field.split('|').collect();
        assert_eq!(parts.len(), 4, "expected |1|salt|hash");
        assert_eq!(parts[1], "1");
        assert!(!parts[2].is_empty());
        assert!(!parts[3].is_empty());
        assert!(!content.contains("example.com"));
    }

    #[test]
    fn unique_local_path_skips_existing_names() {
        let dir = tempdir().unwrap();
        let first = dir.path().join("report.txt");
        std::fs::write(&first, b"one").unwrap();
        std::fs::write(dir.path().join("report (1).txt"), b"two").unwrap();

        assert_eq!(unique_local_path(&first), dir.path().join("report (2).txt"));
    }

    #[test]
    fn split_file_name_handles_dotted_names() {
        assert_eq!(split_file_name("report.txt"), ("report", Some("txt")));
        assert_eq!(
            split_file_name("archive.tar.gz"),
            ("archive.tar", Some("gz"))
        );
        assert_eq!(split_file_name("README"), ("README", None));
        assert_eq!(split_file_name(".env"), (".env", None));
    }

    #[test]
    fn remote_join_normalizes_windows_separators() {
        assert_eq!(
            remote_join("/home/user", Path::new("dir/file.txt")),
            "/home/user/dir/file.txt"
        );
        assert_eq!(remote_join("/", Path::new("dir/file.txt")), "/dir/file.txt");
        assert_eq!(remote_join("/base/", Path::new("dir")), "/base/dir");
    }

    #[tokio::test]
    async fn transfer_checkpoint_respects_pause_and_cancel() {
        let control = TransferControl::default();
        control.paused.store(true, Ordering::SeqCst);

        assert!(
            tokio::time::timeout(Duration::from_millis(50), control.checkpoint())
                .await
                .is_err()
        );

        control.cancelled.store(true, Ordering::SeqCst);

        assert!(
            tokio::time::timeout(Duration::from_millis(200), control.checkpoint())
                .await
                .expect("checkpoint should return once cancelled")
                .is_err()
        );
    }
}
