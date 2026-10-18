//! SSH connection manager backed by `russh`, plus SFTP directory listing and
//! file transfers used by the file browser.

use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{Arc, Mutex, MutexGuard},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use anyhow::{anyhow, Context};
use russh::{
    client,
    keys::{HashAlg, PublicKeyOrCertificate},
    ChannelMsg, ChannelWriteHalf, Disconnect,
};
use russh_sftp::{client::SftpSession, protocol::OpenFlags};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    sync::oneshot,
};
use uuid::Uuid;

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

    fn add(&self, host: String, algorithm: String, fingerprint: String) {
        let mut known = lock(&self.known);
        known.insert(
            host.clone(),
            KnownHost {
                host,
                algorithm,
                fingerprint,
                added_at: now_unix(),
            },
        );
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
    sessions: Mutex<HashMap<String, SshConnection>>,
    host_keys: Arc<HostKeyState>,
}

struct SshConnection {
    handle: Arc<client::Handle<Client>>,
    writer: Arc<ChannelWriteHalf<client::Msg>>,
}

pub struct Client {
    host_key: Arc<HostKeyState>,
    app: AppHandle,
    host: String,
    port: u16,
    host_label: String,
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
            let known = lock(&self.host_key.known);
            if let Some(entry) = known.get(&self.host_label) {
                if entry.fingerprint == fingerprint {
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
            self.host_key
                .add(self.host_label.clone(), algorithm, fingerprint);
            Ok(true)
        } else {
            Ok(false)
        }
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
}

#[derive(Clone, Serialize)]
struct SftpTransferDonePayload {
    transfer_id: String,
    direction: String,
    name: String,
    success: bool,
    error: Option<String>,
    transferred: u64,
    total: u64,
}

fn basename(path: &str) -> String {
    path.rsplit(|c| c == '/' || c == '\\')
        .next()
        .unwrap_or(path)
        .to_string()
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

        let client = Client {
            host_key: self.host_keys(),
            app: app.clone(),
            host: host.clone(),
            port,
            host_label: format!("{host}:{port}"),
        };

        let mut handle = client::connect(config, (host.as_str(), port), client)
            .await
            .with_context(|| format!("failed to connect to {host}:{port}"))?;

        if auth_method == "key" {
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
        } else {
            let auth = handle
                .authenticate_password(username, password)
                .await
                .context("SSH authentication failed")?;

            if !auth.success() {
                return Err(anyhow!("SSH 认证失败，请检查用户名或密码"));
            }
        }

        let channel = handle
            .channel_open_session()
            .await
            .context("failed to open SSH channel")?;

        channel
            .request_pty(
                true,
                "xterm-256color",
                cols as u32,
                rows as u32,
                0,
                0,
                &[],
            )
            .await
            .context("failed to request PTY")?;

        channel.request_shell(true).await.context("failed to request shell")?;

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
            .insert(id.clone(), SshConnection { handle, writer });

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

    pub async fn disconnect(&self, id: &str) -> anyhow::Result<()> {
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
    ) -> anyhow::Result<String> {
        let sftp = self.open_sftp(id).await?;
        let transfer_id = Uuid::new_v4().to_string();
        let event_id = transfer_id.clone();
        let name = basename(&remote_path);
        let app_handle = app.clone();

        tokio::spawn(async move {
            let direction = "download".to_string();
            let result = download_inner(
                &app_handle,
                &event_id,
                &direction,
                &name,
                sftp,
                remote_path,
                local_path,
            )
            .await;

            let payload = match result {
                Ok((transferred, total)) => SftpTransferDonePayload {
                    transfer_id: event_id,
                    direction,
                    name,
                    success: true,
                    error: None,
                    transferred,
                    total,
                },
                Err(error) => SftpTransferDonePayload {
                    transfer_id: event_id,
                    direction,
                    name,
                    success: false,
                    error: Some(error.to_string()),
                    transferred: 0,
                    total: 0,
                },
            };
            emit_done(&app_handle, &payload);
        });

        Ok(transfer_id)
    }

    pub async fn sftp_upload(
        &self,
        app: AppHandle,
        id: &str,
        local_path: String,
        remote_path: String,
    ) -> anyhow::Result<String> {
        let sftp = self.open_sftp(id).await?;
        let transfer_id = Uuid::new_v4().to_string();
        let event_id = transfer_id.clone();
        let name = basename(&local_path);
        let app_handle = app.clone();

        tokio::spawn(async move {
            let direction = "upload".to_string();
            let result = upload_inner(
                &app_handle,
                &event_id,
                &direction,
                &name,
                sftp,
                local_path,
                remote_path,
            )
            .await;

            let payload = match result {
                Ok((transferred, total)) => SftpTransferDonePayload {
                    transfer_id: event_id,
                    direction,
                    name,
                    success: true,
                    error: None,
                    transferred,
                    total,
                },
                Err(error) => SftpTransferDonePayload {
                    transfer_id: event_id,
                    direction,
                    name,
                    success: false,
                    error: Some(error.to_string()),
                    transferred: 0,
                    total: 0,
                },
            };
            emit_done(&app_handle, &payload);
        });

        Ok(transfer_id)
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

    async fn open_sftp(&self, id: &str) -> anyhow::Result<SftpSession> {
        let handle = {
            let sessions = self
                .sessions
                .lock()
                .map_err(|_| anyhow!("failed to lock SSH sessions"))?;
            sessions
                .get(id)
                .map(|connection| connection.handle.clone())
                .ok_or_else(|| anyhow!("SSH session not found"))?
        };

        let channel = handle
            .channel_open_session()
            .await
            .context("failed to open SFTP channel")?;
        channel
            .request_subsystem(true, "sftp")
            .await
            .context("failed to start SFTP subsystem")?;

        SftpSession::new(channel.into_stream())
            .await
            .context("failed to initialize SFTP session")
    }

    fn writer(&self, id: &str) -> anyhow::Result<Arc<ChannelWriteHalf<client::Msg>>> {
        let sessions = self
            .sessions
            .lock()
            .map_err(|_| anyhow!("failed to lock SSH sessions"))?;
        sessions
            .get(id)
            .map(|connection| connection.writer.clone())
            .ok_or_else(|| anyhow!("SSH session not found"))
    }
}

async fn download_inner(
    app: &AppHandle,
    transfer_id: &str,
    direction: &str,
    name: &str,
    sftp: SftpSession,
    remote_path: String,
    local_path: String,
) -> anyhow::Result<(u64, u64)> {
    let metadata = sftp
        .metadata(remote_path.clone())
        .await
        .context("failed to read remote file metadata")?;
    let total = metadata.size.unwrap_or(0);

    let mut remote = sftp
        .open_with_flags(remote_path, OpenFlags::READ)
        .await
        .context("failed to open remote file")?;
    let mut local = tokio::fs::File::create(&local_path)
        .await
        .with_context(|| format!("failed to create local file: {local_path}"))?;

    let mut buffer = vec![0u8; 64 * 1024];
    let mut transferred = 0u64;
    let mut last_emit = Instant::now() - Duration::from_secs(1);

    loop {
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
        transferred += read as u64;

        let now = Instant::now();
        if transferred == total || now.duration_since(last_emit) >= Duration::from_millis(150) {
            last_emit = now;
            emit_progress(
                app,
                &SftpProgressPayload {
                    transfer_id: transfer_id.to_string(),
                    direction: direction.to_string(),
                    name: name.to_string(),
                    transferred,
                    total,
                },
            );
        }
    }

    local.flush().await.context("failed to flush local file")?;
    emit_progress(
        app,
        &SftpProgressPayload {
            transfer_id: transfer_id.to_string(),
            direction: direction.to_string(),
            name: name.to_string(),
            transferred,
            total,
        },
    );

    Ok((transferred, total))
}

async fn upload_inner(
    app: &AppHandle,
    transfer_id: &str,
    direction: &str,
    name: &str,
    sftp: SftpSession,
    local_path: String,
    remote_path: String,
) -> anyhow::Result<(u64, u64)> {
    let metadata = tokio::fs::metadata(&local_path)
        .await
        .with_context(|| format!("failed to read local file: {local_path}"))?;
    let total = metadata.len();

    let mut local = tokio::fs::File::open(&local_path)
        .await
        .with_context(|| format!("failed to open local file: {local_path}"))?;
    let mut remote = sftp
        .open_with_flags(
            remote_path,
            OpenFlags::CREATE | OpenFlags::TRUNCATE | OpenFlags::WRITE,
        )
        .await
        .context("failed to open remote file for writing")?;

    let mut buffer = vec![0u8; 64 * 1024];
    let mut transferred = 0u64;
    let mut last_emit = Instant::now() - Duration::from_secs(1);

    loop {
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
        transferred += read as u64;

        let now = Instant::now();
        if transferred == total || now.duration_since(last_emit) >= Duration::from_millis(150) {
            last_emit = now;
            emit_progress(
                app,
                &SftpProgressPayload {
                    transfer_id: transfer_id.to_string(),
                    direction: direction.to_string(),
                    name: name.to_string(),
                    transferred,
                    total,
                },
            );
        }
    }

    remote.flush().await.context("failed to flush remote file")?;
    emit_progress(
        app,
        &SftpProgressPayload {
            transfer_id: transfer_id.to_string(),
            direction: direction.to_string(),
            name: name.to_string(),
            transferred,
            total,
        },
    );

    Ok((transferred, total))
}
