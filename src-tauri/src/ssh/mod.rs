//! SSH connection manager backed by `russh`, plus SFTP directory listing and
//! file transfers used by the file browser.

use std::{
    collections::HashMap,
    net::{Ipv4Addr, Ipv6Addr},
    path::{Path, PathBuf},
    pin::Pin,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex, MutexGuard,
    },
    time::{Duration, Instant, UNIX_EPOCH},
};

use std::future::Future;

use anyhow::{anyhow, Context};
use russh::{
    client,
    keys::{
        agent::{
            client::{AgentClient, AgentStream},
            AgentIdentity,
        },
        HashAlg, PublicKeyOrCertificate,
    },
    Channel, ChannelMsg, ChannelWriteHalf, Disconnect,
};
use russh_sftp::{client::SftpSession, protocol::OpenFlags};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, Runtime, Wry};

use crate::zmodem::{Action as ZmodemAction, BatchStartScanner, ZmodemReceiver};
use tokio::{
    io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt, SeekFrom},
    net::{TcpListener, TcpStream},
    sync::{oneshot, watch},
};
use uuid::Uuid;
use walkdir::WalkDir;

use crate::log_sink::{LogSink, SessionLogErrorPayload};

pub(crate) mod host_keys;
use host_keys::{
    classify_server_key, format_openssh_known_hosts, parse_openssh_known_hosts, HostKeyCheck,
    HostKeyState,
};
pub use host_keys::{KnownHost, KnownHostsExportResult, KnownHostsImportResult};

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poison| poison.into_inner())
}

/// Expand `~/` (and `~\` on Windows) so imported OpenSSH configs work as-is.
fn expand_path(path: &str) -> PathBuf {
    if let Some(rest) = path.strip_prefix("~/").or_else(|| path.strip_prefix("~\\")) {
        if let Some(home) = home_dir() {
            return home.join(rest);
        }
    }
    PathBuf::from(path)
}

fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .filter(|value| !value.is_empty())
        .or_else(|| std::env::var_os("USERPROFILE").filter(|value| !value.is_empty()))
        .map(PathBuf::from)
}

/// Connection parameters of the jump (bastion) host a session tunnels
/// through, resolved by the frontend from the referenced jump session.
#[derive(Clone, Deserialize)]
pub struct JumpTarget {
    pub host: String,
    pub port: u16,
    pub username: String,
    pub auth_method: String,
    #[serde(default)]
    pub password: String,
    #[serde(default)]
    pub private_key_path: Option<String>,
    #[serde(default)]
    pub cert_path: Option<String>,
    #[serde(default)]
    pub passphrase: Option<String>,
}

/// Cancellation shared by the jump and target handshakes: `ssh_disconnect`
/// flips the flag once and every leg can subscribe independently. A one-shot
/// receiver would be consumed by whichever handshake reaches the host-key
/// wait first, leaving the other leg's decision uninterruptible.
#[derive(Clone)]
struct SharedCancel {
    tx: Arc<watch::Sender<bool>>,
    rx: watch::Receiver<bool>,
}

impl SharedCancel {
    fn new() -> Self {
        let (tx, rx) = watch::channel(false);
        Self {
            tx: Arc::new(tx),
            rx,
        }
    }

    fn cancel(&self) {
        let _ = self.tx.send(true);
    }

    fn is_cancelled(&self) -> bool {
        *self.rx.borrow()
    }

    async fn cancelled(&self) {
        let mut rx = self.rx.clone();
        loop {
            if *rx.borrow_and_update() {
                return;
            }
            if rx.changed().await.is_err() {
                // Sender dropped (app shutting down) counts as cancellation.
                return;
            }
        }
    }
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
    pub conflict: ConflictPolicy,
}

fn default_true() -> bool {
    true
}

fn default_conflict() -> ConflictPolicy {
    // An omitted policy must not default to destroying the target file:
    // fall back to asking (which skips after an unanswered timeout) instead.
    ConflictPolicy::Ask
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

/// Remote forwards keyed by (bind address, bind port) → (target host, port).
type RemoteForwardMap = HashMap<(String, u32), (String, u16)>;

pub struct SshManager {
    sessions: Arc<Mutex<HashMap<String, Arc<SshConnection>>>>,
    host_keys: Arc<HostKeyState>,
    forwards: Arc<Mutex<HashMap<String, ForwardHandle>>>,
    transfers: Arc<Mutex<HashMap<String, Arc<TransferControl>>>>,
    conflicts: Arc<ConflictPendingMap>,
    /// Handshakes still in flight, keyed by session id. Reserving the id
    /// keeps duplicate connects out and lets `ssh_disconnect` cancel an
    /// attempt that is waiting for a host-key decision instead of letting it
    /// finish into an authenticated session nobody watches.
    connecting: Mutex<HashMap<String, ConnectHandle>>,
    /// In-flight ZMODEM receive machines keyed by session id.
    zmodem: Arc<Mutex<HashMap<String, Arc<std::sync::Mutex<ZmodemReceiver>>>>>,
}

struct ConnectHandle {
    cancel: SharedCancel,
    cancelled: Arc<AtomicBool>,
}

/// Removes the connecting reservation on every exit path of `connect`,
/// including the many `?` early returns.
struct ConnectReservation<'a> {
    connecting: &'a Mutex<HashMap<String, ConnectHandle>>,
    id: String,
}

impl Drop for ConnectReservation<'_> {
    fn drop(&mut self) {
        if let Ok(mut connecting) = self.connecting.lock() {
            connecting.remove(&self.id);
        }
    }
}

/// Cached SFTP subsystem channel of a connection plus when its health was
/// last verified. Generic over the handle type so the resolution state
/// machine (including the dead-channel path) is unit-testable without a live
/// SSH connection; production stores `Arc<SftpSession>`.
struct SftpChannelCache<T> {
    inner: tokio::sync::Mutex<SftpCacheSlot<T>>,
}

struct SftpCacheSlot<T> {
    session: Option<T>,
    verified_at: Option<Instant>,
}

impl<T> Default for SftpChannelCache<T> {
    fn default() -> Self {
        Self {
            inner: tokio::sync::Mutex::new(SftpCacheSlot {
                session: None,
                verified_at: None,
            }),
        }
    }
}

impl<T: Clone> SftpChannelCache<T> {
    async fn snapshot(&self) -> Option<(T, Option<Instant>)> {
        let guard = self.inner.lock().await;
        guard
            .session
            .clone()
            .map(|session| (session, guard.verified_at))
    }

    async fn existing(&self) -> Option<T> {
        self.inner.lock().await.session.clone()
    }

    async fn store(&self, session: T) {
        let mut guard = self.inner.lock().await;
        guard.session = Some(session);
        guard.verified_at = Some(Instant::now());
    }

    #[cfg(test)]
    async fn store_verified(&self, session: T, verified_at: Option<Instant>) {
        let mut guard = self.inner.lock().await;
        guard.session = Some(session);
        guard.verified_at = verified_at;
    }

    /// Refresh the verification timestamp, but only while the slot still
    /// holds the handle that was just probed (another task may have rebuilt
    /// it meanwhile).
    async fn bless(&self, session: &T, same: impl Fn(&T, &T) -> bool) {
        let mut guard = self.inner.lock().await;
        if guard
            .session
            .as_ref()
            .map(|current| same(current, session))
            .unwrap_or(false)
        {
            guard.verified_at = Some(Instant::now());
        }
    }

    /// Drop the slot if it still holds the failed handle. This is the part
    /// that keeps a dead channel from being handed out again by the reopen
    /// path.
    async fn invalidate(&self, session: &T, same: impl Fn(&T, &T) -> bool) {
        let mut guard = self.inner.lock().await;
        let still_same = guard
            .session
            .as_ref()
            .map(|current| same(current, session))
            .unwrap_or(false);
        if still_same {
            guard.session = None;
            guard.verified_at = None;
        }
    }
}

/// How long a cached SFTP channel is trusted without re-probing.
const SFTP_HEALTH_INTERVAL: Duration = Duration::from_secs(5);
/// Upper bound for the stale-path health probe.
const SFTP_PROBE_TIMEOUT: Duration = Duration::from_secs(10);

/// Resolve the cached channel: fast-path a recently verified handle, probe a
/// stale one without any lock held, and rebuild when the probe fails. A
/// failed probe invalidates the cached handle first — the old code fell
/// through to the reopen path, found the same dead handle still cached and
/// returned it as if it had just been rebuilt.
async fn resolve_cached_channel<T: Clone>(
    cache: &SftpChannelCache<T>,
    same: impl Fn(&T, &T) -> bool,
    probe_alive: impl Fn(T) -> Pin<Box<dyn Future<Output = bool> + Send>>,
    rebuild: impl FnOnce() -> Pin<Box<dyn Future<Output = anyhow::Result<T>> + Send>>,
) -> anyhow::Result<T> {
    if let Some((session, verified_at)) = cache.snapshot().await {
        let fresh = verified_at
            .map(|at| at.elapsed() < SFTP_HEALTH_INTERVAL)
            .unwrap_or(false);
        if fresh {
            return Ok(session);
        }
        if probe_alive(session.clone()).await {
            cache.bless(&session, same).await;
            return Ok(session);
        }
        eprintln!("[ssh] cached SFTP channel is no longer usable; reopening");
        cache.invalidate(&session, same).await;
    }

    // Another task may have rebuilt the channel while we were probing; a
    // handle present at this point is necessarily new (ours was invalidated
    // or absent), so trusting it is safe.
    if let Some(existing) = cache.existing().await {
        return Ok(existing);
    }

    let session = rebuild().await?;
    cache.store(session.clone()).await;
    Ok(session)
}

struct SshConnection {
    handle: Arc<client::Handle<Client>>,
    writer: Arc<ChannelWriteHalf<client::Msg>>,
    sftp: SftpChannelCache<Arc<SftpSession>>,
    remote_forwards: Arc<Mutex<RemoteForwardMap>>,
    /// Session output log shared with the read loop; dropping the connection
    /// closes the file.
    log: Arc<LogSink>,
    /// The jump-host transport the target connection tunnels through. Held
    /// for the lifetime of the session: dropping it closes the tunnel and
    /// with it the target connection.
    jump_handle: Option<Arc<client::Handle<Client>>>,
}

struct ForwardHandle {
    info: PortForwardInfo,
    task: Option<tokio::task::JoinHandle<()>>,
    handle: Arc<client::Handle<Client>>,
    remote_forwards: Arc<Mutex<RemoteForwardMap>>,
}

#[derive(Default)]
struct TransferControl {
    cancelled: AtomicBool,
    paused: AtomicBool,
    /// Decision picked with "apply to all" in the conflict dialog, reused for
    /// the remaining files of this transfer.
    decision: Mutex<Option<ConflictDecision>>,
}

/// Generic over the Tauri runtime so tests can drive `check_server_key`
/// against a mock `AppHandle`; production always uses the default `Wry`.
pub struct Client<R: Runtime = Wry> {
    host_key: Arc<HostKeyState>,
    app: AppHandle<R>,
    host: String,
    port: u16,
    host_label: String,
    remote_forwards: Arc<Mutex<RemoteForwardMap>>,
    /// Cancels the fingerprint wait when the session is disconnected while
    /// the dialog is open. Consumed by `check_server_key`; shared with the
    /// jump-host handshake so both legs honor the same disconnect.
    cancel: SharedCancel,
}

impl<R: Runtime> client::Handler for Client<R> {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        server_public_key: &PublicKeyOrCertificate,
    ) -> Result<bool, Self::Error> {
        let key = server_public_key.public_key();
        let fingerprint = key.fingerprint(HashAlg::Sha256).to_string();
        let algorithm = key.algorithm().to_string();

        match classify_server_key(&self.host_key, &self.host_label, &fingerprint) {
            HostKeyCheck::KnownOk => {
                // Backfill keys recorded before OpenSSH export support.
                // Metadata backfill only: not worth failing the handshake
                // over, but keep it visible in logs.
                if let Err(error) = self
                    .host_key
                    .backfill_public_key(&self.host_label, key.to_openssh().ok())
                {
                    eprintln!("[known_hosts] backfill persist failed: {error:#}");
                }
                return Ok(true);
            }
            HostKeyCheck::Mismatch { expected } => {
                let _ = self.app.emit(
                    "ssh-host-key-mismatch",
                    HostKeyMismatchPayload {
                        host: self.host_label.clone(),
                        expected,
                        actual: fingerprint,
                    },
                );
                return Ok(false);
            }
            HostKeyCheck::Unknown => {}
        }

        let request_id = Uuid::new_v4().to_string();
        let (sender, receiver) = oneshot::channel::<bool>();
        self.host_key.insert_pending(request_id.clone(), sender);

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

        let response = async { receiver.await.unwrap_or_default() };

        // The dialog waits for the user's answer, a disconnect while it is
        // open, or its 120s timeout — whichever comes first.
        let accepted = tokio::select! {
            accepted = response => accepted,
            _ = self.cancel.cancelled() => false,
            _ = tokio::time::sleep(Duration::from_secs(120)) => {
                // Tell every window: the late "trust" click would otherwise be
                // silently dropped while the dialog stays open.
                let _ = self.app.emit(
                    "ssh-host-key-timeout",
                    HostKeyTimeoutPayload {
                        request_id: request_id.clone(),
                        host: self.host.clone(),
                        port: self.port,
                    },
                );
                false
            }
        };

        self.host_key.take_pending(&request_id);

        if accepted {
            // A cancel that races the user's "trust" click must not leave a
            // TOFU record behind for a connection nobody is going to use.
            if self.cancel.is_cancelled() {
                return Ok(false);
            }
            if let Err(error) = self.host_key.add(
                self.host_label.clone(),
                algorithm,
                fingerprint,
                key.to_openssh().ok(),
            ) {
                // The accepted connection itself stays fine; warn so the user
                // understands why the next connect re-asks for this
                // fingerprint instead of suspecting a security problem.
                let _ = self.app.emit(
                    "ssh-host-key-persist-failed",
                    HostKeyPersistFailedPayload {
                        host: self.host_label.clone(),
                        error: error.to_string(),
                    },
                );
            }
            Ok(true)
        } else {
            Ok(false)
        }
    }

    async fn server_channel_open_forwarded_tcpip(
        &mut self,
        channel: Channel<russh::client::Msg>,
        connected_address: &str,
        connected_port: u32,
        _originator_address: &str,
        _originator_port: u32,
        reply: client::ChannelOpenHandle,
        _session: &mut russh::client::Session,
    ) -> Result<(), Self::Error> {
        // Match on (bind address, port): two forwards may share a port with
        // different bind addresses. Some servers report a different address
        // form than the one bound, so fall back to a port-only match when it
        // is unambiguous.
        let target = {
            let map = lock(&self.remote_forwards);
            map.get(&(connected_address.to_string(), connected_port))
                .cloned()
                .or_else(|| {
                    let matches: Vec<_> = map
                        .iter()
                        .filter(|((_, port), _)| *port == connected_port)
                        .collect();
                    (matches.len() == 1).then(|| matches[0].1.clone())
                })
        };

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
struct HostKeyTimeoutPayload {
    request_id: String,
    host: String,
    port: u16,
}

#[derive(Clone, Serialize)]
struct HostKeyPersistFailedPayload {
    host: String,
    error: String,
}

#[derive(Clone, Serialize)]
struct SshOutputPayload {
    id: String,
    data: String,
}

/// Why a session's read loop ended. `exit` means the remote shell ended on its
/// own (`exit`, logout, killed login shell) and the UI must not reconnect;
/// `dropped` is a transport failure the reconnect logic should handle.
#[derive(Clone, Serialize)]
pub struct SshClosedPayload {
    pub reason: &'static str,
    pub exit_status: Option<u32>,
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
    /// The transfer failed because the SSH connection itself dropped; the
    /// frontend keeps such entries resumable instead of plain failures.
    disconnected: bool,
    error: Option<String>,
    transferred: u64,
    total: u64,
    files_done: usize,
    files_total: usize,
}

#[derive(Clone, Serialize)]
struct SftpConflictPayload {
    request_id: String,
    transfer_id: String,
    direction: String,
    name: String,
    source_size: u64,
    source_mtime: u64,
    target_size: u64,
    target_mtime: u64,
}

/// Local side of an in-flight ZMODEM receive: the download file plus the
/// transfer-queue bookkeeping (progress reuses the SFTP payload shapes, so
/// the queue UI renders ZMODEM transfers natively).
struct ZmodemFile {
    file: Option<tokio::fs::File>,
    /// `<final>.part` while the transfer runs. Only renamed onto `final_path`
    /// once every byte arrived, so a cancelled or dropped transfer never
    /// leaves a truncated file under the real name.
    part_path: PathBuf,
    final_path: PathBuf,
    name: String,
    size: u64,
    transferred: u64,
    last_emitted: u64,
    transfer_id: String,
}

fn sanitize_filename(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric()
                || matches!(c, '.' | '-' | '_' | '(' | ')' | ' ')
                || !c.is_ascii()
            {
                c
            } else {
                '_'
            }
        })
        .collect();
    let trimmed = cleaned.trim();
    if trimmed.is_empty() {
        "file".to_string()
    } else {
        trimmed.to_string()
    }
}

/// Per-file receive cap. The remote peer picks the file name and starts
/// sending bytes without any user prompt, so the receive side must be able
/// to refuse on its own: a hostile or runaway `sz` must not be able to fill
/// the download disk indefinitely.
const ZMODEM_MAX_FILE_BYTES: u64 = 2 * 1024 * 1024 * 1024;
/// Cumulative cap for one SSH session's receive batch (all files combined).
const ZMODEM_MAX_BATCH_BYTES: u64 = 8 * 1024 * 1024 * 1024;

/// Decide whether a ZMODEM receive may start. `None` sizes (sender did not
/// announce one) pass here and are enforced mid-transfer instead.
fn zmodem_receive_allowed(size: Option<u64>, batch_bytes: u64) -> Result<(), String> {
    let size = size.unwrap_or(0);
    if size > ZMODEM_MAX_FILE_BYTES {
        return Err("ZMODEM file too large (limit 2 GiB)".to_string());
    }
    if batch_bytes.saturating_add(size) > ZMODEM_MAX_BATCH_BYTES {
        return Err("ZMODEM batch exceeds the 8 GiB receive limit".to_string());
    }
    Ok(())
}

/// Abort an in-flight receive: mark the machine aborted so terminal output
/// resumes, then write the ZMODEM cancel sequence so the remote `sz` stops.
async fn send_zmodem_cancel(
    app: &AppHandle,
    event_id: &str,
    machine: &std::sync::Mutex<ZmodemReceiver>,
) {
    let bytes = machine
        .lock()
        .unwrap_or_else(|poison| poison.into_inner())
        .cancel();
    let manager = app.state::<SshManager>();
    if let Err(err) = manager.write(event_id, &bytes).await {
        eprintln!("[zmodem] cancel write failed: {err}");
    }
}

/// Report a receive that never produced a queue entry (quota refusal or
/// local file creation failure) so the transfer queue shows the failure
/// instead of the sender's bytes simply disappearing.
fn emit_zmodem_failure(
    app: &AppHandle,
    event_id: &str,
    name: &str,
    size: Option<u64>,
    error: &str,
) {
    emit_done(
        app,
        &SftpTransferDonePayload {
            transfer_id: ZmodemFile::transfer_id(event_id),
            direction: "download".to_string(),
            name: name.to_string(),
            success: false,
            cancelled: false,
            disconnected: false,
            error: Some(error.to_string()),
            transferred: 0,
            total: size.unwrap_or(0),
            files_done: 0,
            files_total: 1,
        },
    );
}

impl ZmodemFile {
    fn transfer_id(event_id: &str) -> String {
        format!("zmodem-{}", event_id)
    }

    async fn start(
        app: &AppHandle,
        event_id: &str,
        name: String,
        size: Option<u64>,
    ) -> anyhow::Result<Self> {
        let dir = app
            .path()
            .download_dir()
            .or_else(|_| app.path().home_dir())
            .context("failed to resolve download directory")?;
        let safe = sanitize_filename(&name);
        let stem = PathBuf::from(&safe);
        let file_stem = stem
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or(&safe)
            .to_string();
        let ext = stem
            .extension()
            .and_then(|s| s.to_str())
            .map(|s| format!(".{}", s))
            .unwrap_or_default();
        let mut final_path = dir.join(&safe);
        let mut n = 1;
        while final_path.exists() {
            final_path = dir.join(format!("{} ({}){}", file_stem, n, ext));
            n += 1;
        }
        let part_path = PathBuf::from(format!("{}.part", final_path.display()));
        let file = tokio::fs::File::create(&part_path).await?;
        let transfer_id = Self::transfer_id(event_id);
        emit_progress(
            app,
            &SftpProgressPayload {
                transfer_id: transfer_id.clone(),
                direction: "download".to_string(),
                name: safe.clone(),
                transferred: 0,
                total: size.unwrap_or(0),
                files_done: 0,
                files_total: 1,
            },
        );
        Ok(Self {
            file: Some(file),
            part_path,
            final_path,
            name: safe,
            size: size.unwrap_or(0),
            transferred: 0,
            last_emitted: 0,
            transfer_id,
        })
    }

    async fn write_data(&mut self, app: &AppHandle, data: &[u8]) -> anyhow::Result<()> {
        if let Some(file) = self.file.as_mut() {
            file.write_all(data).await?;
        }
        self.transferred += data.len() as u64;
        if self.transferred - self.last_emitted >= 64 * 1024 {
            self.last_emitted = self.transferred;
            self.emit_progress(app);
        }
        Ok(())
    }

    fn emit_progress(&self, app: &AppHandle) {
        emit_progress(
            app,
            &SftpProgressPayload {
                transfer_id: self.transfer_id.clone(),
                direction: "download".to_string(),
                name: self.name.clone(),
                transferred: self.transferred,
                total: self.size,
                files_done: 0,
                files_total: 1,
            },
        );
    }

    #[allow(clippy::too_many_arguments)]
    async fn finish(
        &mut self,
        app: &AppHandle,
        success: bool,
        cancelled: bool,
        disconnected: bool,
        error: Option<String>,
    ) {
        self.file.take(); // close

        let mut success = success;
        let mut error = error;
        if success {
            if let Err(err) = tokio::fs::rename(&self.part_path, &self.final_path).await {
                success = false;
                error = Some(format!("failed to finalize download: {err}"));
            }
        } else {
            // No resume for ZMODEM: a partial .part is noise, and the final
            // name must never hold truncated content.
            let _ = tokio::fs::remove_file(&self.part_path).await;
        }

        emit_done(
            app,
            &SftpTransferDonePayload {
                transfer_id: self.transfer_id.clone(),
                direction: "download".to_string(),
                name: self.name.clone(),
                success,
                cancelled,
                disconnected,
                error,
                transferred: self.transferred,
                total: self.size,
                files_done: usize::from(success),
                files_total: 1,
            },
        );
    }
}

#[allow(clippy::too_many_arguments)]
/// Receive-confirmation policy shared by all SSH sessions: whether incoming
/// ZMODEM batches start downloading automatically, plus the in-flight user
/// decisions (same shape as the host-key pending map). The frontend mirrors
/// the toggle via `set_zmodem_auto_receive` and answers prompts through
/// `zmodem_receive_response`.
#[derive(Default)]
pub struct ZmodemConfirmState {
    auto_receive: Mutex<bool>,
    pending: Mutex<HashMap<String, oneshot::Sender<bool>>>,
}

impl ZmodemConfirmState {
    pub fn set_auto_receive(&self, enabled: bool) {
        *lock(&self.auto_receive) = enabled;
    }

    fn auto_receive(&self) -> bool {
        *lock(&self.auto_receive)
    }

    fn insert_pending(&self, request_id: String, sender: oneshot::Sender<bool>) {
        lock(&self.pending).insert(request_id, sender);
    }

    pub(crate) fn take_pending(&self, request_id: &str) -> Option<oneshot::Sender<bool>> {
        lock(&self.pending).remove(request_id)
    }
}

/// Ask the user whether to accept an incoming ZMODEM batch (receive-confirm
/// mode). Resolves through the `zmodem_receive_response` command; an
/// unanswered dialog counts as a rejection so the read loop can never wedge.
async fn ask_zmodem_receive(app: &AppHandle, session_id: &str) -> bool {
    let state = app.state::<ZmodemConfirmState>();
    let request_id = Uuid::new_v4().to_string();
    let (sender, receiver) = oneshot::channel();
    state.insert_pending(request_id.clone(), sender);
    let _ = app.emit(
        "zmodem-receive-request",
        serde_json::json!({
            "requestId": request_id,
            "sessionId": session_id,
        }),
    );
    // Same bound as the host-key dialog.
    let decision = tokio::time::timeout(Duration::from_secs(120), receiver).await;
    state.take_pending(&request_id);
    matches!(decision, Ok(Ok(true)))
}

/// Return the receiver to a clean scan state after the user rejected a
/// batch: the cancel sequence is already on its way to the sender, so the
/// machine must drop its cancellation flags (a fresh machine is in the same
/// scan state, since nothing was fed while the dialog was open) and the
/// sticky confirmation scanner must re-arm — otherwise the next ordinary
/// echo chunk would re-open the dialog. Only a fresh ZRQINIT may prompt.
fn reset_after_zmodem_reject(
    machine: &std::sync::Mutex<ZmodemReceiver>,
    scanner: &mut BatchStartScanner,
) {
    *machine.lock().unwrap_or_else(|poison| poison.into_inner()) = ZmodemReceiver::new();
    scanner.reset();
}

#[allow(clippy::too_many_arguments)]
async fn handle_zmodem_action(
    app: &AppHandle,
    event_id: &str,
    action: ZmodemAction,
    cancelled_by_user: bool,
    state: &mut Option<ZmodemFile>,
    batch_bytes: &mut u64,
    machine: &std::sync::Mutex<ZmodemReceiver>,
) {
    match action {
        ZmodemAction::WriteToRemote { data } => {
            let manager = app.state::<SshManager>();
            if let Err(err) = manager.write(event_id, &data).await {
                eprintln!("[zmodem] handshake write failed: {err}");
            }
        }
        ZmodemAction::FileStart { name, size } => {
            // A previous file that never saw its ZEOF still needs closing.
            if let Some(prev) = state.as_mut() {
                prev.finish(app, false, false, false, None).await;
            }
            *state = None;

            if let Err(error) = zmodem_receive_allowed(size, *batch_bytes) {
                // Refuse without creating anything, make the failure visible
                // in the queue, and stop the sender.
                eprintln!("[zmodem] refusing receive of {name}: {error}");
                emit_zmodem_failure(app, event_id, &name, size, &error);
                send_zmodem_cancel(app, event_id, machine).await;
                return;
            }

            match ZmodemFile::start(app, event_id, name.clone(), size).await {
                Ok(file) => {
                    *state = Some(file);
                    let _ = app.emit(
                        "zmodem-start",
                        serde_json::json!({
                            "sessionId": event_id,
                            "name": name,
                            "size": size.unwrap_or(0),
                        }),
                    );
                }
                Err(err) => {
                    let error = format!("failed to create ZMODEM download file: {err}");
                    eprintln!("[zmodem] {error}");
                    emit_zmodem_failure(app, event_id, &name, size, &error);
                    send_zmodem_cancel(app, event_id, machine).await;
                }
            }
        }
        ZmodemAction::FileData { data } => {
            if let Some(file) = state.as_mut() {
                let next = file.transferred.saturating_add(data.len() as u64);
                // Unknown or lying senders are caught here: the announced
                // size never gets trusted past the bytes actually received.
                let limit_error = if next > ZMODEM_MAX_FILE_BYTES {
                    Some("ZMODEM file too large (limit 2 GiB)".to_string())
                } else if batch_bytes.saturating_add(next) > ZMODEM_MAX_BATCH_BYTES {
                    Some("ZMODEM batch exceeds the 8 GiB receive limit".to_string())
                } else {
                    None
                };
                if let Some(error) = limit_error {
                    eprintln!("[zmodem] refusing further data for {}: {error}", file.name);
                    file.finish(app, false, false, false, Some(error)).await;
                    *state = None;
                    send_zmodem_cancel(app, event_id, machine).await;
                } else if let Err(err) = file.write_data(app, &data).await {
                    // A write failure is terminal: close the file, drop the
                    // partial data, report the queue entry as failed and stop
                    // the sender. This used to be only logged, so the batch
                    // could still finish "successfully" and rename a
                    // truncated file under the final name.
                    eprintln!("[zmodem] write failed: {err}");
                    let error = format!("failed to write ZMODEM download: {err}");
                    file.finish(app, false, false, false, Some(error)).await;
                    *state = None;
                    send_zmodem_cancel(app, event_id, machine).await;
                }
            }
        }
        ZmodemAction::FileEnd {
            bytes,
            complete: success,
        } => {
            if let Some(file) = state.as_mut() {
                file.transferred = bytes;
                let cancelled = !success && cancelled_by_user;
                let error = if success || cancelled {
                    None
                } else {
                    Some("ZMODEM transfer interrupted".to_string())
                };
                file.finish(app, success, cancelled, false, error).await;
                if success {
                    // Only kept files count toward the batch quota; failed
                    // ones are deleted, so their bytes are not retained.
                    *batch_bytes = batch_bytes.saturating_add(bytes);
                }
            }
            *state = None;
        }
        ZmodemAction::BatchDone => {}
    }
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

/// Spawn a transfer task with a panic backstop: the done event and the
/// transfers-map cleanup must happen even if the task panics, or the queue
/// would list the transfer as running forever and pause/cancel would act on
/// a dead entry.
fn spawn_transfer_task(
    app_handle: AppHandle,
    controls: Arc<Mutex<HashMap<String, Arc<TransferControl>>>>,
    event_id: String,
    direction: &'static str,
    name: String,
    task: tokio::task::JoinHandle<SftpTransferDonePayload>,
) {
    tokio::spawn(async move {
        let payload = match task.await {
            Ok(payload) => payload,
            Err(join_error) => {
                eprintln!("[sftp] transfer task aborted: {join_error}");
                SftpTransferDonePayload {
                    transfer_id: event_id.clone(),
                    direction: direction.to_string(),
                    name,
                    success: false,
                    cancelled: false,
                    disconnected: false,
                    error: Some("transfer task terminated abnormally".to_string()),
                    transferred: 0,
                    total: 0,
                    files_done: 0,
                    files_total: 0,
                }
            }
        };
        emit_done(&app_handle, &payload);
        lock(&controls).remove(&event_id);
    });
}

/// Stop every port forward bound to session `id` and notify the frontend.
///
/// Shared by the explicit disconnect path and the read loop's connection-died
/// path, so local listeners never outlive their transport. The remote-side
/// cancel is best-effort: in the connection-died path the handle is already
/// dead and the server-side forward dies with it.
async fn stop_session_forwards(
    forwards: &Mutex<HashMap<String, ForwardHandle>>,
    app: &AppHandle,
    id: &str,
) {
    let active_forwards: Vec<String> = lock(forwards)
        .iter()
        .filter(|(_, forward)| forward.info.ssh_id == id)
        .map(|(forward_id, _)| forward_id.clone())
        .collect();
    let had_forwards = !active_forwards.is_empty();

    for forward_id in active_forwards {
        let forward = lock(forwards).remove(&forward_id);
        if let Some(forward) = forward {
            if let Some(task) = forward.task {
                task.abort();
            }
            if forward.info.kind == "remote" {
                lock(&forward.remote_forwards).remove(&(
                    forward.info.bind_host.clone(),
                    forward.info.bind_port as u32,
                ));
                let _ = forward
                    .handle
                    .cancel_tcpip_forward(
                        forward.info.bind_host.clone(),
                        forward.info.bind_port as u32,
                    )
                    .await;
            }
        }
    }

    if had_forwards {
        let _ = app.emit("port-forwards-changed", ());
    }
}

/// Whether an auth method consumes the `password` field at all. Agent, key
/// and certificate authentication do not, so callers may omit it.
pub(crate) fn auth_method_uses_password(auth_method: &str) -> bool {
    !matches!(auth_method, "agent" | "key" | "certificate")
}

/// Authenticate an established SSH transport with the given credentials.
/// Shared by the direct and the jump-host connection path.
async fn authenticate(
    handle: &mut client::Handle<Client>,
    username: &str,
    auth_method: &str,
    password: &str,
    private_key_path: Option<&str>,
    cert_path: Option<&str>,
    passphrase: Option<&str>,
) -> anyhow::Result<()> {
    match auth_method {
        "key" => {
            let key_path = private_key_path.ok_or_else(|| anyhow!("select a private key file"))?;
            let key_path = expand_path(key_path);
            let key_pair = russh::keys::load_secret_key(&key_path, passphrase)
                .with_context(|| format!("failed to load private key: {}", key_path.display()))?;
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
                return Err(anyhow!(
                    "SSH key authentication failed, check the private key or username"
                ));
            }
        }
        // OpenSSH user certificate: the certified private key signs, the
        // `*-cert.pub` blob proves the CA endorsement.
        "certificate" => {
            let key_path = private_key_path.ok_or_else(|| anyhow!("select a private key file"))?;
            let key_path = expand_path(key_path);
            let cert_path = cert_path.ok_or_else(|| anyhow!("select a certificate file"))?;
            let cert_path = expand_path(cert_path);
            let key_pair = russh::keys::load_secret_key(&key_path, passphrase)
                .with_context(|| format!("failed to load private key: {}", key_path.display()))?;
            let cert = russh::keys::load_openssh_certificate(&cert_path)
                .with_context(|| format!("failed to load certificate: {}", cert_path.display()))?;

            let auth = handle
                .authenticate_openssh_cert(username, Arc::new(key_pair), cert)
                .await
                .context("SSH certificate authentication failed")?;

            if !auth.success() {
                return Err(anyhow!("SSH certificate authentication failed, check the certificate, private key or username"));
            }
        }
        "agent" => {
            authenticate_with_agent(handle, username).await?;
        }
        _ => {
            let auth = handle
                .authenticate_password(username, password)
                .await
                .context("SSH authentication failed")?;

            if !auth.success() {
                return Err(anyhow!(
                    "SSH authentication failed, check the username or password"
                ));
            }
        }
    }

    Ok(())
}

impl SshManager {
    pub fn new(known_hosts_path: Option<PathBuf>) -> Self {
        Self {
            sessions: Arc::new(Mutex::new(HashMap::new())),
            host_keys: Arc::new(HostKeyState::new(known_hosts_path)),
            forwards: Arc::new(Mutex::new(HashMap::new())),
            transfers: Arc::new(Mutex::new(HashMap::new())),
            conflicts: Arc::new(Mutex::new(HashMap::new())),
            connecting: Mutex::new(HashMap::new()),
            zmodem: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    fn host_keys(&self) -> Arc<HostKeyState> {
        self.host_keys.clone()
    }

    pub fn known_hosts(&self) -> anyhow::Result<Vec<KnownHost>> {
        Ok(self.host_keys().list())
    }

    pub fn remove_known_host(&self, host: &str) -> anyhow::Result<()> {
        self.host_keys().remove(host)
    }

    pub fn resolve_host_key(&self, request_id: &str, accept: bool) {
        let host_keys = self.host_keys();
        if let Some(sender) = host_keys.take_pending(request_id) {
            let _ = sender.send(accept);
        }
    }

    pub fn resolve_sftp_conflict(&self, request_id: &str, action: &str, apply_to_all: bool) {
        let sender = lock(&self.conflicts).remove(request_id);
        if let Some(sender) = sender {
            let _ = sender.send(ConflictResponse {
                action: parse_conflict_action(action),
                apply_to_all,
            });
        }
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn connect(
        &self,
        app: AppHandle,
        id: String,
        host: String,
        port: u16,
        username: String,
        auth_method: String,
        password: String,
        private_key_path: Option<String>,
        cert_path: Option<String>,
        passphrase: Option<String>,
        jump: Option<JumpTarget>,
        log_path: Option<String>,
        cols: u16,
        rows: u16,
    ) -> anyhow::Result<String> {
        // The frontend generates the id so it can attach output/close
        // listeners before the shell starts and never lose the first prompt.
        if id.is_empty() || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
            return Err(anyhow!("invalid SSH session id"));
        }
        // Fail fast instead of waiting for the server to reject an empty
        // password; agent / key / certificate auth never reads this field.
        if auth_method_uses_password(&auth_method) && password.is_empty() {
            return Err(anyhow!("password required"));
        }
        if self
            .sessions
            .lock()
            .map_err(|_| anyhow!("failed to lock SSH sessions"))?
            .contains_key(&id)
        {
            return Err(anyhow!("SSH session id already exists"));
        }

        let cancel_handle = SharedCancel::new();
        {
            let mut connecting = lock(&self.connecting);
            if connecting.contains_key(&id) {
                return Err(anyhow!("SSH session is already connecting"));
            }
            connecting.insert(
                id.clone(),
                ConnectHandle {
                    cancel: cancel_handle.clone(),
                    cancelled: Arc::new(AtomicBool::new(false)),
                },
            );
        }
        let _reservation = ConnectReservation {
            connecting: &self.connecting,
            id: id.clone(),
        };

        // Handshake timeouts, outermost first:
        // - TCP: 15s, so a host that accepts nothing fails fast.
        // - CONNECT_DEADLINE: outer bound for the handshake and for a server
        //   that accepts TCP but never sends its SSH banner. 150s = the 120s
        //   host-key dialog + handshake slack.
        //
        // No `inactivity_timeout`: russh arms it for the whole transport
        // lifetime, not just the handshake. With it set to the same 30s as
        // `keepalive_interval`, an idle-but-healthy session died at exactly
        // the first keepalive tick — the two timers expire together and the
        // inactivity branch wins, disconnecting a terminal that merely sat
        // untouched for half a minute. Liveness is detected by the keepalive
        // probes alone: 30s interval x 3 unanswered = ~90s, the same budget
        // OpenSSH uses for ServerAliveInterval/ServerAliveCountMax.
        const TCP_CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
        const CONNECT_DEADLINE: Duration = Duration::from_secs(150);

        let config = Arc::new(client::Config {
            inactivity_timeout: None,
            keepalive_interval: Some(Duration::from_secs(30)),
            keepalive_max: 3,
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
            cancel: cancel_handle.clone(),
        };

        // With a jump host the target handshake runs over a direct-tcpip
        // channel of the jump connection (the `ssh -J` tunnel). The jump
        // transport is kept alive alongside the session for as long as the
        // target connection lives.
        let (mut handle, jump_handle) = match jump {
            None => {
                let stream = tokio::time::timeout(
                    TCP_CONNECT_TIMEOUT,
                    TcpStream::connect((host.as_str(), port)),
                )
                .await
                .map_err(|_| {
                    anyhow!(
                        "TCP connection to {host}:{port} timed out after {TCP_CONNECT_TIMEOUT:?}"
                    )
                })?
                .with_context(|| format!("failed to connect to {host}:{port}"))?;
                let handle = tokio::time::timeout(
                    CONNECT_DEADLINE,
                    client::connect_stream(config, stream, client),
                )
                .await
                .map_err(|_| anyhow!("SSH handshake with {host}:{port} timed out"))?
                .with_context(|| format!("failed to connect to {host}:{port}"))?;
                (handle, None)
            }
            Some(jump) => {
                let jump_stream = tokio::time::timeout(
                    TCP_CONNECT_TIMEOUT,
                    TcpStream::connect((jump.host.as_str(), jump.port)),
                )
                .await
                .map_err(|_| {
                    anyhow!(
                        "TCP connection to jump host {}:{} timed out after {TCP_CONNECT_TIMEOUT:?}",
                        jump.host,
                        jump.port
                    )
                })?
                .with_context(|| {
                    format!("failed to connect to jump host {}:{}", jump.host, jump.port)
                })?;
                let jump_client = Client {
                    host_key: self.host_keys(),
                    app: app.clone(),
                    host: jump.host.clone(),
                    port: jump.port,
                    host_label: format!("{}:{}", jump.host, jump.port),
                    remote_forwards: Arc::new(Mutex::new(HashMap::new())),
                    cancel: client.cancel.clone(),
                };
                let mut jump_connection = tokio::time::timeout(
                    CONNECT_DEADLINE,
                    client::connect_stream(config.clone(), jump_stream, jump_client),
                )
                .await
                .map_err(|_| {
                    anyhow!(
                        "SSH handshake with jump host {}:{} timed out",
                        jump.host,
                        jump.port
                    )
                })?
                .with_context(|| {
                    format!("failed to connect to jump host {}:{}", jump.host, jump.port)
                })?;

                authenticate(
                    &mut jump_connection,
                    &jump.username,
                    &jump.auth_method,
                    &jump.password,
                    jump.private_key_path.as_deref(),
                    jump.cert_path.as_deref(),
                    jump.passphrase.as_deref(),
                )
                .await
                .with_context(|| format!("jump host authentication failed: {}", jump.host))?;

                let channel = jump_connection
                    .channel_open_direct_tcpip(host.clone(), port as u32, "127.0.0.1", 0)
                    .await
                    .context("failed to open tunnel through jump host")?;

                let handle = tokio::time::timeout(
                    CONNECT_DEADLINE,
                    client::connect_stream(config, channel.into_stream(), client),
                )
                .await
                .map_err(|_| anyhow!("SSH handshake with {host}:{port} timed out"))?
                .with_context(|| format!("failed to connect to {host}:{port} through jump host"))?;
                (handle, Some(Arc::new(jump_connection)))
            }
        };

        authenticate(
            &mut handle,
            &username,
            &auth_method,
            &password,
            private_key_path.as_deref(),
            cert_path.as_deref(),
            passphrase.as_deref(),
        )
        .await?;

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
        let writer = Arc::new(write_half);
        let handle = Arc::new(handle);

        let event_id = id.clone();
        let app_handle = app.clone();
        let reap_forwards = self.forwards.clone();
        let reap_sessions = self.sessions.clone();
        let zmodem_map = self.zmodem.clone();
        let log_app = app.clone();
        let log_session = id.clone();
        let log = Arc::new(LogSink::with_error_callback(
            log_path.as_deref(),
            Some(Arc::new(move |error: &str| {
                let _ = log_app.emit(
                    "session-log-error",
                    SessionLogErrorPayload {
                        session_id: log_session.clone(),
                        error: error.to_string(),
                    },
                );
            })),
        ));
        let read_log = log.clone();

        // Clones for the panic backstop: the read loop owns the originals.
        let watchdog_app = app.clone();
        let watchdog_id = id.clone();
        let watchdog_forwards = self.forwards.clone();
        let watchdog_sessions = self.sessions.clone();
        let watchdog_zmodem = self.zmodem.clone();

        let reader_task = tokio::spawn(async move {
            // Separate decoders per stream: a stderr packet must not complete
            // (or corrupt) a stdout sequence that is still missing bytes.
            let mut output_decoder = crate::text_stream::Utf8StreamDecoder::new();
            let mut stderr_decoder = crate::text_stream::Utf8StreamDecoder::new();

            // ZMODEM receive: raw stdout is intercepted before UTF-8 decode
            // so an sz transfer never reaches the terminal or the log.
            let zmachine = Arc::new(std::sync::Mutex::new(ZmodemReceiver::new()));
            if let Ok(mut map) = zmodem_map.lock() {
                map.insert(event_id.clone(), zmachine.clone());
            }
            let mut zfile: Option<ZmodemFile> = None;
            // Bytes retained by completed ZMODEM files of this session,
            // for the cumulative receive quota.
            let mut zmodem_batch_bytes: u64 = 0;
            // Receive-confirmation flow (auto_receive off): the scanner
            // watches the raw stream for the ZRQINIT sentinel before the
            // machine answers the handshake. While the dialog is open the
            // read loop simply waits on the decision — `sz` only sends
            // ZRQINIT retries until it sees our ZRINIT, so there is no file
            // data in flight to buffer, and the triggering chunk is dropped.
            let mut zscanner = BatchStartScanner::new();
            let mut zbatch_active = false;

            // Distinguishes a remote shell that ended on its own (the user
            // typed `exit`, or the login shell was killed) from a transport
            // that dropped. The frontend must not auto-reconnect after the
            // former: re-opening a shell the user just closed is wrong.
            let mut exited_normally = false;
            let mut exit_status: Option<u32> = None;
            while let Some(message) = read_half.wait().await {
                match message {
                    ChannelMsg::Data { data } => {
                        // Receive-confirmation gate (auto_receive off): watch
                        // the raw bytes for a batch start before the machine
                        // answers the handshake.
                        if !app_handle.state::<ZmodemConfirmState>().auto_receive()
                            && !zbatch_active
                            && zscanner.feed(&data)
                        {
                            let accepted = ask_zmodem_receive(&app_handle, &event_id).await;
                            if accepted {
                                // Disarm until the batch ends; the next
                                // ZRQINIT retry drives the normal handshake.
                                zbatch_active = true;
                            } else {
                                // Stop the sender, then return the receiver
                                // to a clean scan state: cancel() flags the
                                // machine aborted, and the sticky scanner
                                // must re-arm so only a NEW ZRQINIT can
                                // prompt again (not ordinary echo bytes).
                                let cancel = {
                                    let mut machine = zmachine
                                        .lock()
                                        .unwrap_or_else(|poison| poison.into_inner());
                                    machine.cancel()
                                };
                                let manager = app_handle.state::<SshManager>();
                                if let Err(err) = manager.write(&event_id, &cancel).await {
                                    eprintln!("[zmodem] cancel write failed: {err}");
                                }
                                reset_after_zmodem_reject(&zmachine, &mut zscanner);
                            }
                            continue;
                        }
                        let (passthrough, actions, cancelled_by_user, done_or_aborted) = {
                            let mut machine =
                                zmachine.lock().unwrap_or_else(|poison| poison.into_inner());
                            let feed = machine.feed(&data);
                            (
                                feed.passthrough,
                                feed.actions,
                                feed.cancelled,
                                feed.done || feed.aborted,
                            )
                        };
                        if done_or_aborted {
                            // Batch ended (cleanly or aborted): re-arm the
                            // confirmation scanner for the next one.
                            zbatch_active = false;
                            zscanner.reset();
                        }
                        if !passthrough.is_empty() {
                            let decoded = output_decoder.feed(&passthrough);
                            read_log.write(&decoded);
                            let payload = SshOutputPayload {
                                id: event_id.clone(),
                                data: decoded,
                            };
                            let _ = app_handle.emit(&format!("ssh-output-{}", event_id), payload);
                        }
                        for action in actions {
                            handle_zmodem_action(
                                &app_handle,
                                &event_id,
                                action,
                                cancelled_by_user,
                                &mut zfile,
                                &mut zmodem_batch_bytes,
                                &zmachine,
                            )
                            .await;
                        }
                    }
                    ChannelMsg::ExtendedData { data, .. } => {
                        let decoded = stderr_decoder.feed(&data);
                        read_log.write(&decoded);
                        let payload = SshOutputPayload {
                            id: event_id.clone(),
                            data: decoded,
                        };
                        let _ = app_handle.emit(&format!("ssh-output-{}", event_id), payload);
                    }
                    ChannelMsg::ExitStatus { exit_status: code } => {
                        exited_normally = true;
                        exit_status = Some(code);
                        break;
                    }
                    // Eof/Close without an exit-status still means the remote
                    // side ended the session deliberately (e.g. a shell that
                    // exec'd away). A dropped transport ends the `wait()`
                    // stream instead of producing these messages.
                    ChannelMsg::Eof | ChannelMsg::Close => {
                        exited_normally = true;
                        break;
                    }
                    _ => continue,
                }
            }

            if let Ok(mut map) = zmodem_map.lock() {
                map.remove(&event_id);
            }
            // A transfer cut short by the connection dropping still needs its
            // queue entry closed.
            if let Some(state) = zfile.as_mut() {
                state.finish(&app_handle, false, false, true, None).await;
            }

            let _ = app_handle.emit(
                &format!("ssh-closed-{}", event_id),
                SshClosedPayload {
                    reason: if exited_normally { "exit" } else { "dropped" },
                    exit_status,
                },
            );

            // The connection died on its own (network drop, server restart):
            // release its port forwards and drop the dead session entry so
            // local listeners are freed and the UI stops listing them.
            stop_session_forwards(&reap_forwards, &app_handle, &event_id).await;
            lock(&reap_sessions).remove(&event_id);
        });

        // A panicking read loop (typically a russh internal) would otherwise
        // leave a dead session listed with no reader and no closed event:
        // repeat the cleanup a normal shutdown performs.
        tokio::spawn(async move {
            if let Err(join_error) = reader_task.await {
                eprintln!("[ssh] {watchdog_id}: read loop aborted: {join_error}");
                if let Ok(mut map) = watchdog_zmodem.lock() {
                    map.remove(&watchdog_id);
                }
                let _ = watchdog_app.emit(
                    &format!("ssh-closed-{}", watchdog_id),
                    SshClosedPayload {
                        reason: "dropped",
                        exit_status: None,
                    },
                );
                stop_session_forwards(&watchdog_forwards, &watchdog_app, &watchdog_id).await;
                lock(&watchdog_sessions).remove(&watchdog_id);
            }
        });

        // A disconnect during the auth/handshake phases may have given up on
        // this attempt; never register a session nobody is watching anymore.
        // Holding the `connecting` lock across the check AND the insert closes
        // the old check-then-insert TOCTOU window (same pattern as the PTY
        // manager): `disconnect` removes the reservation under the same lock,
        // so it either lands before the check (we observe `cancelled` and
        // bail) or after the insert (it then finds the live session in
        // `sessions` and shuts it down) — never in between.
        {
            let connecting = lock(&self.connecting);
            if connecting
                .get(&id)
                .map(|handle| handle.cancelled.load(Ordering::SeqCst))
                .unwrap_or(true)
            {
                return Err(anyhow!("SSH connection cancelled"));
            }
            self.sessions
                .lock()
                .map_err(|_| anyhow!("failed to lock SSH sessions"))?
                .insert(
                    id.clone(),
                    Arc::new(SshConnection {
                        handle,
                        writer,
                        sftp: SftpChannelCache::default(),
                        remote_forwards,
                        log,
                        jump_handle,
                    }),
                );
        }

        Ok(id)
    }

    /// Cancel an in-flight ZMODEM receive: write the cancel sequence and
    /// mark the machine aborted so terminal output resumes.
    pub async fn cancel_zmodem(&self, session_id: &str) -> anyhow::Result<()> {
        let machine = lock(&self.zmodem).get(session_id).cloned();
        let Some(machine) = machine else {
            return Err(anyhow!("ZMODEM session not found"));
        };
        let bytes = machine
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .cancel();
        self.write(session_id, &bytes).await
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
        // A connect still in its handshake (typically waiting for a host-key
        // decision) has no live session yet — cancel it outright.
        if let Some(handle) = lock(&self.connecting).remove(id) {
            handle.cancelled.store(true, Ordering::SeqCst);
            handle.cancel.cancel();
            return Ok(());
        }

        stop_session_forwards(&self.forwards, &app, id).await;

        // In-progress SFTP transfers are deliberately NOT cancelled here.
        // Their tasks hold their own SFTP channel and fail on their own the
        // moment the connection drops; the done payload then carries
        // `disconnected: true`, which the frontend turns into a resumable
        // entry and resumes from the `.part` sidecar after a reconnect.
        // Cancelling from here would break that resume chain.

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
            // The jump transport exists only to carry this session's tunnel.
            if let Some(jump) = &connection.jump_handle {
                let _ = jump.disconnect(Disconnect::ByApplication, "", "en").await;
            }
        }

        Ok(())
    }

    /// Re-point the session's output log mid-flight. Called when the user
    /// toggles session logging while connections are already alive.
    pub fn set_log(&self, id: &str, path: Option<&str>) -> anyhow::Result<()> {
        let connection = self.connection(id)?;
        connection.log.set_path(path);
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
        let weak_handle = Arc::downgrade(&self.connection(id)?.handle);
        let sftp = self.open_sftp(id).await?;
        let (transfer_id, control) = self.register_transfer()?;
        let event_id = transfer_id.clone();
        let name = basename(&remote_path);
        let app_handle = app.clone();
        let controls = self.transfers.clone();
        let conflicts = self.conflicts.clone();

        let task = {
            let direction = "download".to_string();
            let name = name.clone();
            let event_id = event_id.clone();
            let app_handle = app_handle.clone();
            tokio::spawn(async move {
                let result = run_download(
                    sftp,
                    &app_handle,
                    &event_id,
                    &name,
                    &remote_path,
                    &local_path,
                    options,
                    control.clone(),
                    conflicts,
                )
                .await;
                let cancelled = control.cancelled.load(Ordering::SeqCst);
                let disconnected = result.is_err()
                    && !cancelled
                    && weak_handle
                        .upgrade()
                        .map(|handle| handle.is_closed())
                        .unwrap_or(true);

                match result {
                    Ok(report) => SftpTransferDonePayload {
                        transfer_id: event_id,
                        direction,
                        name,
                        success: true,
                        cancelled: false,
                        disconnected: false,
                        error: None,
                        transferred: report.transferred,
                        total: report.total,
                        files_done: report.files_done,
                        files_total: report.files_total,
                    },
                    Err(failure) => SftpTransferDonePayload {
                        transfer_id: event_id,
                        direction,
                        name,
                        success: false,
                        cancelled,
                        disconnected,
                        error: Some(failure.error.to_string()),
                        transferred: failure.report.transferred,
                        total: failure.report.total,
                        files_done: failure.report.files_done,
                        files_total: failure.report.files_total,
                    },
                }
            })
        };
        spawn_transfer_task(app_handle, controls, event_id, "download", name, task);

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
        let weak_handle = Arc::downgrade(&self.connection(id)?.handle);
        let sftp = self.open_sftp(id).await?;
        let (transfer_id, control) = self.register_transfer()?;
        let event_id = transfer_id.clone();
        let name = basename(&local_path);
        let app_handle = app.clone();
        let controls = self.transfers.clone();
        let conflicts = self.conflicts.clone();

        let task = {
            let direction = "upload".to_string();
            let name = name.clone();
            let event_id = event_id.clone();
            let app_handle = app_handle.clone();
            tokio::spawn(async move {
                let result = run_upload(
                    sftp,
                    &app_handle,
                    &event_id,
                    &name,
                    &local_path,
                    &remote_path,
                    options,
                    control.clone(),
                    conflicts,
                )
                .await;
                let cancelled = control.cancelled.load(Ordering::SeqCst);
                let disconnected = result.is_err()
                    && !cancelled
                    && weak_handle
                        .upgrade()
                        .map(|handle| handle.is_closed())
                        .unwrap_or(true);

                match result {
                    Ok(report) => SftpTransferDonePayload {
                        transfer_id: event_id,
                        direction,
                        name,
                        success: true,
                        cancelled: false,
                        disconnected: false,
                        error: None,
                        transferred: report.transferred,
                        total: report.total,
                        files_done: report.files_done,
                        files_total: report.files_total,
                    },
                    Err(failure) => SftpTransferDonePayload {
                        transfer_id: event_id,
                        direction,
                        name,
                        success: false,
                        cancelled,
                        disconnected,
                        error: Some(failure.error.to_string()),
                        transferred: failure.report.transferred,
                        total: failure.report.total,
                        files_done: failure.report.files_done,
                        files_total: failure.report.files_total,
                    },
                }
            })
        };
        spawn_transfer_task(app_handle, controls, event_id, "upload", name, task);

        Ok(transfer_id)
    }

    /// Upload and wait for the transfer to actually finish. The command-shaped
    /// `sftp_upload` only returns a transfer id (the UI tracks completion via
    /// events), which cannot tell the remote-edit watcher whether a save
    /// landed; advancing its baseline on a transfer id would silently drop
    /// failed saves. Queue progress and the done event are still emitted, so
    /// the upload stays visible in the transfer queue.
    pub(crate) async fn sftp_upload_and_wait(
        &self,
        app: AppHandle,
        id: &str,
        local_path: String,
        remote_path: String,
        options: SftpTransferOptions,
    ) -> anyhow::Result<()> {
        let handle = self.connection(id)?.handle.clone();
        let sftp = self.open_sftp(id).await?;
        let (transfer_id, control) = self.register_transfer()?;
        let name = basename(&local_path);
        let result = run_upload(
            sftp,
            &app,
            &transfer_id,
            &name,
            &local_path,
            &remote_path,
            options,
            control.clone(),
            self.conflicts.clone(),
        )
        .await;

        let cancelled = control.cancelled.load(Ordering::SeqCst);
        let disconnected = result.is_err() && !cancelled && handle.is_closed();
        let payload = match &result {
            Ok(report) => SftpTransferDonePayload {
                transfer_id: transfer_id.clone(),
                direction: "upload".to_string(),
                name,
                success: true,
                cancelled: false,
                disconnected: false,
                error: None,
                transferred: report.transferred,
                total: report.total,
                files_done: report.files_done,
                files_total: report.files_total,
            },
            Err(failure) => SftpTransferDonePayload {
                transfer_id: transfer_id.clone(),
                direction: "upload".to_string(),
                name,
                success: false,
                cancelled,
                disconnected,
                error: Some(failure.error.to_string()),
                transferred: failure.report.transferred,
                total: failure.report.total,
                files_done: failure.report.files_done,
                files_total: failure.report.files_total,
            },
        };
        emit_done(&app, &payload);
        lock(&self.transfers).remove(&transfer_id);

        result.map(|_| ()).map_err(|failure| failure.error)
    }

    pub fn set_transfer_paused(&self, transfer_id: &str, paused: bool) -> anyhow::Result<()> {
        let transfers = lock(&self.transfers);
        let control = transfers
            .get(transfer_id)
            .ok_or_else(|| anyhow!("transfer task not found"))?;
        control.paused.store(paused, Ordering::SeqCst);
        Ok(())
    }

    pub fn cancel_transfer(&self, transfer_id: &str) -> anyhow::Result<()> {
        let transfers = lock(&self.transfers);
        let control = transfers
            .get(transfer_id)
            .ok_or_else(|| anyhow!("transfer task not found"))?;
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

        // Merge in one pass and persist once: upsert-per-entry rewrote the
        // whole file for every line of the imported file.
        self.host_keys.merge_and_persist(entries)?;

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
                    return Err(anyhow!("target host is required"));
                }

                let listener = TcpListener::bind((bind_host.as_str(), bind_port))
                    .await
                    .with_context(|| format!("failed to bind {bind_host}:{bind_port}"))?;
                let actual_port = listener
                    .local_addr()
                    .context("failed to read bind address")?
                    .port();
                let task = spawn_forward_listener(
                    app.clone(),
                    self.forwards.clone(),
                    id.clone(),
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
                    return Err(anyhow!("target host is required"));
                }

                let actual_port = connection
                    .handle
                    .tcpip_forward(bind_host.clone(), bind_port as u32)
                    .await
                    .context("failed to request remote forwarding")?;
                let actual_port = u16::try_from(actual_port).unwrap_or(0);
                lock(&connection.remote_forwards).insert(
                    (bind_host.clone(), actual_port as u32),
                    (target_host.clone(), target_port),
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
                    None,
                )
            }
            _ => return Err(anyhow!("unsupported port forward kind")),
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
            .ok_or_else(|| anyhow!("port forward not found"))?;

        if let Some(task) = forward.task {
            task.abort();
        }

        if forward.info.kind == "remote" {
            lock(&forward.remote_forwards).remove(&(
                forward.info.bind_host.clone(),
                forward.info.bind_port as u32,
            ));
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
    pub(crate) async fn open_sftp(&self, id: &str) -> anyhow::Result<Arc<SftpSession>> {
        let connection = self.connection(id)?;
        resolve_cached_channel(
            &connection.sftp,
            Arc::ptr_eq,
            |session| {
                Box::pin(async move {
                    // Stale-or-never-verified handle: probe without holding the
                    // cache lock, so one slow channel cannot serialize the
                    // session's other SFTP operations.
                    matches!(
                        tokio::time::timeout(SFTP_PROBE_TIMEOUT, session.metadata(".")).await,
                        Ok(Ok(_))
                    )
                })
            },
            || {
                let handle = connection.handle.clone();
                Box::pin(async move {
                    let channel = handle
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
                    Ok(session)
                })
            },
        )
        .await
    }

    /// Whether a live connection exists for the session (used by features
    /// that outlive a single command call, e.g. the remote-edit watcher).
    pub(crate) fn has_connection(&self, id: &str) -> bool {
        self.connection(id).is_ok()
    }

    fn connection(&self, id: &str) -> anyhow::Result<Arc<SshConnection>> {
        let sessions = self
            .sessions
            .lock()
            .map_err(|_| anyhow!("failed to lock SSH sessions"))?;
        sessions.get(id).cloned().ok_or_else(|| {
            // Surfaced by SFTP, port forwarding and remote edit alike; tell the
            // user what to do instead of just that the lookup missed.
            anyhow!("SSH session is disconnected or missing, reconnect and try again")
        })
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

/// Conflict policy for SFTP transfers. Deserialized directly from the IPC
/// payload so an unrecognized value is rejected at the boundary instead of
/// silently degrading to overwrite.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ConflictPolicy {
    Overwrite,
    Skip,
    Rename,
    /// Ask the user for every conflicting file (with an apply-to-all option).
    Ask,
    /// Overwrite only when the source is newer or the size differs.
    Newer,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum ConflictDecision {
    Overwrite,
    Skip,
    Rename,
    Cancel,
}

fn parse_conflict_action(value: &str) -> ConflictDecision {
    match value {
        "overwrite" => ConflictDecision::Overwrite,
        "skip" => ConflictDecision::Skip,
        "rename" => ConflictDecision::Rename,
        _ => ConflictDecision::Cancel,
    }
}

struct ConflictResponse {
    action: ConflictDecision,
    apply_to_all: bool,
}

type ConflictPendingMap = Mutex<HashMap<String, oneshot::Sender<ConflictResponse>>>;

fn split_file_name(name: &str) -> (&str, Option<&str>) {
    match name.rsplit_once('.') {
        Some((stem, extension)) if !stem.is_empty() => (stem, Some(extension)),
        _ => (name, None),
    }
}

/// Returns a free local path, or `None` when every rename candidate is
/// taken. `None` must fail the transfer: falling back to the original path
/// would overwrite the file the rename policy exists to avoid.
fn unique_local_path(path: &Path) -> Option<PathBuf> {
    if !path.exists() {
        return Some(path.to_path_buf());
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
            return Some(candidate);
        }
    }

    None
}

/// Same probe for remote targets. Inconclusive existence probes keep the
/// search going but can never produce the original path: exhaustion returns
/// `None` so the caller fails the transfer instead of overwriting.
async fn unique_remote_path(sftp: &SftpSession, path: &str) -> Option<String> {
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

        match sftp.try_exists(&candidate).await {
            Ok(false) => return Some(candidate),
            Ok(true) => {}
            Err(error) => {
                // An inconclusive probe must not hand out a name that may
                // already exist for overwrite; keep searching (harmless) and
                // surface the anomaly.
                eprintln!("[sftp] failed to probe {candidate}: {error}");
            }
        }
    }

    None
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

        match sftp.try_exists(&current).await {
            Ok(true) => {}
            Ok(false) => {
                if let Err(error) = sftp.create_dir(&current).await {
                    // A sibling transfer may have created it in the race
                    // window; only a directory that is still missing is a
                    // real failure. Continuing silently here used to defer
                    // the error into a confusing file-open failure later.
                    if !matches!(sftp.try_exists(&current).await, Ok(true)) {
                        return Err(anyhow!(
                            "failed to create remote directory {current}: {error}"
                        ));
                    }
                }
            }
            Err(error) => {
                // Probe failed: attempt the create anyway and surface the
                // failure instead of leaving it to a confusing open error.
                if let Err(create_error) = sftp.create_dir(&current).await {
                    if !matches!(sftp.try_exists(&current).await, Ok(true)) {
                        return Err(anyhow!(
                            "failed to create remote directory {current}: {create_error} (probe failed: {error})"
                        ));
                    }
                }
            }
        }
    }

    Ok(())
}

struct RemoteFile {
    remote: String,
    relative: String,
    size: u64,
}

/// SFTP READDIR names are server-controlled and russh-sftp does not
/// canonicalize them. Before a recursive download joins `relative` onto the
/// local root, require a plain, traversal-free relative name: no separators
/// other than the `/` we joined with, no `.`/`..` components, no absolute
/// paths, no Windows drive/ADS colons and no reserved device names. Anything
/// else is skipped (with a warning) rather than materialized.
fn is_safe_remote_relative(relative: &str) -> bool {
    if relative.is_empty()
        || relative.starts_with('/')
        || relative.starts_with('\\')
        || relative.contains('\\')
        || relative.contains(':')
    {
        return false;
    }
    relative.split('/').all(is_safe_remote_file_name)
}

fn is_safe_remote_file_name(name: &str) -> bool {
    if name.is_empty() || name == "." || name == ".." || name.chars().any(char::is_control) {
        return false;
    }
    // "nul.txt" and friends are devices on Windows regardless of extension.
    let stem = name.split('.').next().unwrap_or(name);
    !matches!(
        stem.to_ascii_uppercase().as_str(),
        "CON"
            | "PRN"
            | "AUX"
            | "NUL"
            | "COM1"
            | "COM2"
            | "COM3"
            | "COM4"
            | "COM5"
            | "COM6"
            | "COM7"
            | "COM8"
            | "COM9"
            | "LPT1"
            | "LPT2"
            | "LPT3"
            | "LPT4"
            | "LPT5"
            | "LPT6"
            | "LPT7"
            | "LPT8"
            | "LPT9"
    )
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

            if !is_safe_remote_relative(&relative) {
                eprintln!(
                    "[sftp] skipping entry with unsafe server-provided name in {directory}: {name:?}"
                );
                continue;
            }

            if entry.file_type().is_dir() {
                stack.push((entry.path(), relative));
            } else if entry.file_type().is_file() {
                out.push(RemoteFile {
                    remote: entry.path(),
                    relative,
                    size: entry.metadata().size.unwrap_or(0),
                });
            } else if entry.file_type().is_symlink() {
                // Follow links that point at files; skip links to directories
                // (cycle risk) and dangling links instead of dropping every
                // symlink indiscriminately.
                if let Ok(target) = sftp.metadata(entry.path()).await {
                    if target.file_type().is_file() {
                        out.push(RemoteFile {
                            remote: entry.path(),
                            relative,
                            size: target.size.unwrap_or(0),
                        });
                    }
                }
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
        let file_type = entry.file_type();
        if file_type.is_file() {
            files.push(LocalFile {
                local: entry.path().to_path_buf(),
                relative: entry.path().strip_prefix(root)?.to_path_buf(),
                size: entry.metadata()?.len(),
            });
        } else if file_type.is_symlink() {
            // Follow links that point at files; skip directory links (cycle
            // risk) and dangling ones.
            if let Ok(target) = entry.path().metadata() {
                if target.is_file() {
                    files.push(LocalFile {
                        local: entry.path().to_path_buf(),
                        relative: entry.path().strip_prefix(root)?.to_path_buf(),
                        size: target.len(),
                    });
                }
            }
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
    conflicts: Arc<ConflictPendingMap>,
) -> Result<TransferReport, TransferFailure> {
    let metadata = sftp
        .metadata(remote_path)
        .await
        .map_err(TransferFailure::new)?;
    let is_dir = metadata.is_dir();
    let mut files = Vec::new();

    if is_dir {
        if !options.recursive {
            return Err(TransferFailure::new(anyhow!(
                "target is a directory, enable recursive download"
            )));
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

    let policy = options.conflict;
    let local_root = PathBuf::from(local_path);

    let result: anyhow::Result<()> = async {
        for file in &files {
            control.checkpoint().await?;

            let target = if is_dir {
                // Defense in depth: `files` comes from `collect_remote_files`
                // which already filters, but re-validate before joining a
                // server-controlled string onto the local root.
                if !is_safe_remote_relative(&file.relative) {
                    eprintln!(
                        "[sftp] refusing to materialize unsafe remote relative path: {:?}",
                        file.relative
                    );
                    continue;
                }
                local_root.join(Path::new(&file.relative))
            } else {
                local_root.clone()
            };

            if let Some(parent) = target.parent() {
                tokio::fs::create_dir_all(parent).await?;
            }

            let mut target = target;
            if !resolve_download_conflict(
                &sftp,
                app,
                transfer_id,
                name,
                &mut target,
                policy,
                &control,
                &mut progress,
                file,
                &conflicts,
            )
            .await
            .map_err(|failure| failure.error)?
            {
                continue;
            }

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
    conflicts: Arc<ConflictPendingMap>,
) -> Result<TransferReport, TransferFailure> {
    let root = PathBuf::from(local_path);
    let metadata = tokio::fs::symlink_metadata(&root)
        .await
        .map_err(TransferFailure::new)?;
    let is_dir = metadata.is_dir();

    if is_dir && !options.recursive {
        return Err(TransferFailure::new(anyhow!(
            "target is a directory, enable recursive upload"
        )));
    }

    let files = tokio::task::spawn_blocking(move || collect_local_files(&root))
        .await
        .map_err(|error| TransferFailure::new(anyhow!(error)))?
        .map_err(TransferFailure::new)?;

    let total = files.iter().map(|file| file.size).sum();
    let mut progress =
        TransferProgress::new(app.clone(), transfer_id, "upload", name, total, files.len());
    progress.emit(true);

    let policy = options.conflict;

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

            let mut target = target;
            if !resolve_upload_conflict(
                &sftp,
                app,
                transfer_id,
                name,
                &mut target,
                policy,
                &control,
                &mut progress,
                file,
                &conflicts,
            )
            .await
            .map_err(|failure| failure.error)?
            {
                continue;
            }

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

#[derive(Serialize, Deserialize)]
struct UploadResumeMeta {
    size: u64,
    mtime_ms: Option<u64>,
}

#[derive(Serialize, Deserialize)]
struct DownloadResumeMeta {
    source: String,
    size: u64,
    mtime: Option<u32>,
}

fn local_mtime_millis(metadata: &std::fs::Metadata) -> Option<u64> {
    metadata
        .modified()
        .ok()?
        .duration_since(UNIX_EPOCH)
        .ok()
        .map(|elapsed| elapsed.as_millis() as u64)
}

/// A partial upload may only be resumed when its sidecar proves the partial
/// data came from the exact same local file (size + mtime); anything else
/// restarts from zero so a stale prefix can never be spliced onto changed
/// source content. A missing local mtime disables resuming entirely.
fn upload_resume_offset_from(
    meta: Option<UploadResumeMeta>,
    part_len: Option<u64>,
    expected_size: u64,
    mtime_ms: Option<u64>,
) -> u64 {
    let Some(meta) = meta else {
        return 0;
    };
    if meta.size != expected_size {
        return 0;
    }
    match (meta.mtime_ms, mtime_ms) {
        (Some(stored), Some(current)) if stored == current => {}
        _ => return 0,
    }
    match part_len {
        Some(len) if len <= expected_size => len,
        _ => 0,
    }
}

/// Same rule for downloads against the remote source. Servers that report no
/// mtime fall back to source path + size matching.
fn download_resume_offset_from(
    meta: Option<DownloadResumeMeta>,
    part_len: Option<u64>,
    source: &str,
    expected_size: u64,
    mtime: Option<u32>,
) -> u64 {
    let Some(meta) = meta else {
        return 0;
    };
    if meta.source != source || meta.size != expected_size || meta.mtime != mtime {
        return 0;
    }
    match part_len {
        Some(len) if len <= expected_size => len,
        _ => 0,
    }
}

async fn read_remote_file(sftp: &SftpSession, path: &str) -> anyhow::Result<Vec<u8>> {
    let mut remote = sftp
        .open_with_flags(path, OpenFlags::READ)
        .await
        .with_context(|| format!("failed to open remote file: {path}"))?;
    let mut buffer = Vec::new();
    remote
        .read_to_end(&mut buffer)
        .await
        .with_context(|| format!("failed to read remote file: {path}"))?;
    Ok(buffer)
}

async fn write_remote_file(sftp: &SftpSession, path: &str, data: &[u8]) -> anyhow::Result<()> {
    let flags = OpenFlags::CREATE | OpenFlags::WRITE | OpenFlags::TRUNCATE;
    let mut remote = sftp
        .open_with_flags(path, flags)
        .await
        .with_context(|| format!("failed to create remote file: {path}"))?;
    remote
        .write_all(data)
        .await
        .with_context(|| format!("failed to write remote file: {path}"))?;
    remote
        .flush()
        .await
        .with_context(|| format!("failed to flush remote file: {path}"))?;
    remote
        .close()
        .await
        .with_context(|| format!("failed to close remote file: {path}"))?;
    Ok(())
}

async fn upload_resume_offset(
    sftp: &SftpSession,
    part_path: &str,
    meta_path: &str,
    expected_size: u64,
    mtime_ms: Option<u64>,
) -> u64 {
    let meta = read_remote_file(sftp, meta_path)
        .await
        .ok()
        .and_then(|bytes| serde_json::from_slice::<UploadResumeMeta>(&bytes).ok());
    let part_len = sftp
        .metadata(part_path)
        .await
        .ok()
        .and_then(|metadata| metadata.size);
    upload_resume_offset_from(meta, part_len, expected_size, mtime_ms)
}

/// Move a finished upload from its part file onto the final path.
///
/// Plain `SSH_FXP_RENAME` fails on servers that reject renaming over an
/// existing file (OpenSSH), so the old file is swapped out through a backup
/// name and only deleted once the new content is in place; on failure the
/// previous file is restored and the target stays intact.
async fn finalize_remote_upload(
    sftp: &SftpSession,
    part_path: &str,
    target: &str,
) -> anyhow::Result<()> {
    if sftp
        .rename(part_path.to_string(), target.to_string())
        .await
        .is_ok()
    {
        return Ok(());
    }

    if let Ok(metadata) = sftp.metadata(target).await {
        if metadata.is_dir() {
            anyhow::bail!("remote target is a directory, cannot overwrite with a file: {target}");
        }
    }

    let backup = format!("{target}.nexterm-bak");
    let _ = sftp.remove_file(backup.as_str()).await;
    sftp.rename(target.to_string(), backup.clone())
        .await
        .context("failed to back up existing remote file")?;
    match sftp.rename(part_path.to_string(), target.to_string()).await {
        Ok(()) => {
            let _ = sftp.remove_file(backup.as_str()).await;
            Ok(())
        }
        Err(error) => {
            let _ = sftp.rename(backup, target.to_string()).await;
            Err(anyhow::Error::new(error).context("failed to finalize remote upload"))
        }
    }
}

fn record_skipped(progress: &mut TransferProgress, size: u64) {
    progress.add(size);
    progress.file_done();
    progress.emit(false);
}

/// FileZilla-style "overwrite if newer": replace unless the target already
/// matches the source size and is not older than it. Mtimes are in seconds.
fn overwrite_if_newer(
    source_size: u64,
    source_mtime: u64,
    target_size: u64,
    target_mtime: u64,
) -> bool {
    source_size != target_size || source_mtime > target_mtime
}

fn mtime_secs(metadata: &std::fs::Metadata) -> u64 {
    metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_secs())
        .unwrap_or(0)
}

/// Ask the user how to handle one conflicting file. Resolves through the
/// pending map once the frontend answers; reuses an earlier "apply to all"
/// decision, falls back to skip if the dialog is lost, and honours cancel.
#[allow(clippy::too_many_arguments)]
async fn wait_for_conflict_decision(
    app: &AppHandle,
    transfer_id: &str,
    direction: &str,
    name: &str,
    control: &TransferControl,
    conflicts: &ConflictPendingMap,
    source_size: u64,
    source_mtime: u64,
    target_size: u64,
    target_mtime: u64,
) -> Result<ConflictDecision, TransferFailure> {
    if let Some(decision) = *lock(&control.decision) {
        return Ok(decision);
    }

    let request_id = Uuid::new_v4().to_string();
    let (sender, mut receiver) = oneshot::channel();
    lock(conflicts).insert(request_id.clone(), sender);

    let _ = app.emit(
        "sftp-conflict",
        SftpConflictPayload {
            request_id: request_id.clone(),
            transfer_id: transfer_id.to_string(),
            direction: direction.to_string(),
            name: name.to_string(),
            source_size,
            source_mtime,
            target_size,
            target_mtime,
        },
    );

    // Unanswered dialogs fall back to skipping after ten minutes so a lost
    // frontend can never wedge the transfer queue permanently.
    let deadline = Instant::now() + Duration::from_secs(600);
    let decision = loop {
        tokio::select! {
            response = &mut receiver => {
                break match response {
                    Ok(response) => response,
                    Err(_) => ConflictResponse {
                        action: ConflictDecision::Skip,
                        apply_to_all: false,
                    },
                };
            }
            _ = tokio::time::sleep(Duration::from_millis(200)) => {
                if control.cancelled.load(Ordering::SeqCst) {
                    lock(conflicts).remove(&request_id);
                    return Err(TransferFailure::new(TransferCancelled));
                }
                if Instant::now() >= deadline {
                    lock(conflicts).remove(&request_id);
                    return Ok(ConflictDecision::Skip);
                }
            }
        }
    };
    lock(conflicts).remove(&request_id);

    if decision.apply_to_all && decision.action != ConflictDecision::Cancel {
        *lock(&control.decision) = Some(decision.action);
    }

    Ok(decision.action)
}

/// Decide how to proceed when the upload target already exists. Returns
/// `false` when the file is skipped (bookkeeping already recorded).
#[allow(clippy::too_many_arguments)]
async fn resolve_upload_conflict(
    sftp: &SftpSession,
    app: &AppHandle,
    transfer_id: &str,
    name: &str,
    target: &mut String,
    policy: ConflictPolicy,
    control: &TransferControl,
    progress: &mut TransferProgress,
    source: &LocalFile,
    conflicts: &ConflictPendingMap,
) -> Result<bool, TransferFailure> {
    let target_metadata = sftp.metadata(target.as_str()).await.ok();
    if policy == ConflictPolicy::Overwrite || target_metadata.is_none() {
        return Ok(true);
    }

    let source_metadata = tokio::fs::metadata(&source.local)
        .await
        .map_err(TransferFailure::new)?;

    match policy {
        ConflictPolicy::Overwrite => Ok(true),
        ConflictPolicy::Skip => {
            record_skipped(progress, source.size);
            Ok(false)
        }
        ConflictPolicy::Rename => {
            *target = unique_remote_path(sftp, target.as_str())
                .await
                .ok_or_else(|| {
                    TransferFailure::new(anyhow!("no available rename target for {name}"))
                })?;
            Ok(true)
        }
        ConflictPolicy::Newer => {
            let overwrite = overwrite_if_newer(
                source_metadata.len(),
                mtime_secs(&source_metadata),
                target_metadata
                    .as_ref()
                    .and_then(|metadata| metadata.size)
                    .unwrap_or(0),
                target_metadata
                    .as_ref()
                    .and_then(|metadata| metadata.mtime)
                    .map(|value| value as u64)
                    .unwrap_or(0),
            );
            if overwrite {
                Ok(true)
            } else {
                record_skipped(progress, source.size);
                Ok(false)
            }
        }
        ConflictPolicy::Ask => {
            let decision = wait_for_conflict_decision(
                app,
                transfer_id,
                "upload",
                name,
                control,
                conflicts,
                source_metadata.len(),
                mtime_secs(&source_metadata),
                target_metadata
                    .as_ref()
                    .and_then(|metadata| metadata.size)
                    .unwrap_or(0),
                target_metadata
                    .as_ref()
                    .and_then(|metadata| metadata.mtime)
                    .map(|value| value as u64)
                    .unwrap_or(0),
            )
            .await?;
            match decision {
                ConflictDecision::Overwrite => Ok(true),
                ConflictDecision::Rename => {
                    *target = unique_remote_path(sftp, target.as_str())
                        .await
                        .ok_or_else(|| {
                            TransferFailure::new(anyhow!("no available rename target for {name}"))
                        })?;
                    Ok(true)
                }
                ConflictDecision::Skip => {
                    record_skipped(progress, source.size);
                    Ok(false)
                }
                ConflictDecision::Cancel => {
                    control.cancelled.store(true, Ordering::SeqCst);
                    Err(TransferFailure::new(TransferCancelled))
                }
            }
        }
    }
}

/// Same decision for downloads against a local target. Returns `false` when
/// the file is skipped (bookkeeping already recorded).
#[allow(clippy::too_many_arguments)]
async fn resolve_download_conflict(
    sftp: &SftpSession,
    app: &AppHandle,
    transfer_id: &str,
    name: &str,
    target: &mut PathBuf,
    policy: ConflictPolicy,
    control: &TransferControl,
    progress: &mut TransferProgress,
    source: &RemoteFile,
    conflicts: &ConflictPendingMap,
) -> Result<bool, TransferFailure> {
    let target_metadata = tokio::fs::metadata(target.as_path()).await.ok();
    if policy == ConflictPolicy::Overwrite || target_metadata.is_none() {
        return Ok(true);
    }

    let source_metadata = sftp
        .metadata(source.remote.as_str())
        .await
        .map_err(TransferFailure::new)?;
    let source_size = source_metadata.size.unwrap_or(0);
    let source_mtime = source_metadata.mtime.map(|value| value as u64).unwrap_or(0);

    match policy {
        ConflictPolicy::Overwrite => Ok(true),
        ConflictPolicy::Skip => {
            record_skipped(progress, source.size);
            Ok(false)
        }
        ConflictPolicy::Rename => {
            *target = unique_local_path(target).ok_or_else(|| {
                TransferFailure::new(anyhow!("no available rename target for {name}"))
            })?;
            Ok(true)
        }
        ConflictPolicy::Newer => {
            let overwrite = overwrite_if_newer(
                source_size,
                source_mtime,
                target_metadata
                    .as_ref()
                    .map(|metadata| metadata.len())
                    .unwrap_or(0),
                target_metadata.as_ref().map(mtime_secs).unwrap_or(0),
            );
            if overwrite {
                Ok(true)
            } else {
                record_skipped(progress, source.size);
                Ok(false)
            }
        }
        ConflictPolicy::Ask => {
            let decision = wait_for_conflict_decision(
                app,
                transfer_id,
                "download",
                name,
                control,
                conflicts,
                source_size,
                source_mtime,
                target_metadata
                    .as_ref()
                    .map(|metadata| metadata.len())
                    .unwrap_or(0),
                target_metadata.as_ref().map(mtime_secs).unwrap_or(0),
            )
            .await?;
            match decision {
                ConflictDecision::Overwrite => Ok(true),
                ConflictDecision::Rename => {
                    *target = unique_local_path(target).ok_or_else(|| {
                        TransferFailure::new(anyhow!("no available rename target for {name}"))
                    })?;
                    Ok(true)
                }
                ConflictDecision::Skip => {
                    record_skipped(progress, source.size);
                    Ok(false)
                }
                ConflictDecision::Cancel => {
                    control.cancelled.store(true, Ordering::SeqCst);
                    Err(TransferFailure::new(TransferCancelled))
                }
            }
        }
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
    let mtime = metadata.mtime;
    let part_path = PathBuf::from(format!("{}.part", local_path.display()));
    let meta_path = PathBuf::from(format!("{}.part.meta", local_path.display()));

    let mut offset = 0u64;
    if resume {
        let meta = tokio::fs::read(&meta_path)
            .await
            .ok()
            .and_then(|bytes| serde_json::from_slice::<DownloadResumeMeta>(&bytes).ok());
        let part_len = tokio::fs::metadata(&part_path)
            .await
            .ok()
            .map(|part_metadata| part_metadata.len());
        offset = download_resume_offset_from(meta, part_len, remote_path, size, mtime);
    }

    if offset == 0 {
        let _ = tokio::fs::remove_file(&part_path).await;
        let _ = tokio::fs::remove_file(&meta_path).await;
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

    let meta = DownloadResumeMeta {
        source: remote_path.to_string(),
        size,
        mtime,
    };
    let meta_json =
        serde_json::to_vec(&meta).context("failed to serialize download resume meta")?;
    tokio::fs::write(&meta_path, meta_json)
        .await
        .context("failed to write download resume meta")?;

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

    // std/tokio rename already replaces an existing target on every platform
    // (MOVEFILE_REPLACE_EXISTING on Windows); the previous pre-delete created
    // a pointless window where the target is missing if the rename fails.
    tokio::fs::rename(&part_path, local_path)
        .await
        .context("failed to finalize local file")?;
    let _ = tokio::fs::remove_file(&meta_path).await;

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

    // The upload goes to a sidecar-marked part file and is renamed into place
    // on completion, so the final path only ever holds complete content and a
    // remote file is never modified in place by an interrupted transfer.
    let part_path = format!("{remote_path}.nexterm-part");
    let meta_path = format!("{part_path}.meta");

    let mtime_ms = local_mtime_millis(&metadata);
    let mut offset = 0u64;
    if resume && size > 0 {
        offset = upload_resume_offset(sftp, part_path.as_str(), meta_path.as_str(), size, mtime_ms)
            .await;
    }
    if offset == 0 {
        let _ = sftp.remove_file(part_path.as_str()).await;
        let _ = sftp.remove_file(meta_path.as_str()).await;
    }

    let meta = UploadResumeMeta { size, mtime_ms };
    let meta_json = serde_json::to_vec(&meta).context("failed to serialize upload resume meta")?;
    write_remote_file(sftp, meta_path.as_str(), &meta_json).await?;

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
        .open_with_flags(part_path.as_str(), flags)
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
    drop(local);

    finalize_remote_upload(sftp, part_path.as_str(), remote_path).await?;
    let _ = sftp.remove_file(meta_path.as_str()).await;

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
        return Err(anyhow!("no usable identities in the SSH agent"));
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
        Some(error) => anyhow!("SSH agent authentication failed: {error}"),
        None => anyhow!("SSH agent authentication failed"),
    })
}

#[allow(clippy::too_many_arguments)]
fn spawn_forward_listener<R: Runtime>(
    app: AppHandle<R>,
    forwards: Arc<Mutex<HashMap<String, ForwardHandle>>>,
    forward_id: String,
    listener: TcpListener,
    handle: Arc<client::Handle<Client<R>>>,
    dynamic: bool,
    target_host: String,
    target_port: u16,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        loop {
            let (mut socket, peer) = match listener.accept().await {
                Ok(accepted) => accepted,
                Err(error) => {
                    // A listener that dies (fd exhaustion, external close)
                    // must not leave the forward listed as active while
                    // nothing is listening on the port.
                    eprintln!("[port-forward] {forward_id} listener failed: {error}");
                    if lock(&forwards).remove(&forward_id).is_some() {
                        let _ = app.emit("port-forwards-changed", ());
                    }
                    break;
                }
            };

            let handle = handle.clone();
            let target_host = target_host.clone();

            tokio::spawn(async move {
                let (host, port) = if dynamic {
                    // An idle local process must not be able to pin a task
                    // (and a socket) forever by never speaking SOCKS5.
                    match tokio::time::timeout(
                        Duration::from_secs(10),
                        socks5_handshake(&mut socket),
                    )
                    .await
                    {
                        Ok(Ok(target)) => target,
                        _ => {
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

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn only_password_auth_consumes_the_password_field() {
        // Agent / key / certificate logins must accept callers that omit the
        // field entirely (ssh_connect takes `password: Option<String>`).
        assert!(!auth_method_uses_password("agent"));
        assert!(!auth_method_uses_password("key"));
        assert!(!auth_method_uses_password("certificate"));
        assert!(auth_method_uses_password("password"));
        // Anything unrecognised goes down the password branch in `authenticate`.
        assert!(auth_method_uses_password("keyboard-interactive"));
        assert!(auth_method_uses_password(""));
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
    fn safe_remote_relative_accepts_plain_names() {
        assert!(is_safe_remote_relative("a.txt"));
        assert!(is_safe_remote_relative("dir/a.txt"));
        assert!(is_safe_remote_relative("a/b/c.tar.gz"));
        assert!(is_safe_remote_relative(".hidden"));
        assert!(is_safe_remote_relative("数据.csv"));
    }

    #[test]
    fn safe_remote_relative_rejects_traversal_and_absolute_paths() {
        assert!(!is_safe_remote_relative(""));
        assert!(!is_safe_remote_relative("."));
        assert!(!is_safe_remote_relative(".."));
        assert!(!is_safe_remote_relative("../etc/passwd"));
        assert!(!is_safe_remote_relative("a/../b"));
        assert!(!is_safe_remote_relative("a/../../b"));
        assert!(!is_safe_remote_relative("dir/./x"));
        assert!(!is_safe_remote_relative("a/"));
        assert!(!is_safe_remote_relative("/etc/passwd"));
        assert!(!is_safe_remote_relative(r"\server\share"));
        assert!(!is_safe_remote_relative(r"C:\Users\x"));
        assert!(!is_safe_remote_relative("a\\b"));
        assert!(!is_safe_remote_relative("backup:notes"));
        assert!(!is_safe_remote_relative("dir/with:colon/x"));
    }

    #[test]
    fn safe_remote_relative_rejects_windows_device_and_control_names() {
        assert!(!is_safe_remote_relative("NUL"));
        assert!(!is_safe_remote_relative("nul.txt"));
        assert!(!is_safe_remote_relative("COM1.log"));
        assert!(!is_safe_remote_relative("lpt9"));
        assert!(!is_safe_remote_relative("bad\u{0}name"));
        assert!(!is_safe_remote_relative("bad\nname"));
    }

    #[test]
    fn resolve_host_key_forwards_the_decision() {
        let dir = tempdir().unwrap();
        let manager = SshManager::new(Some(dir.path().join("known_hosts.json")));
        let (sender, mut receiver) = oneshot::channel::<bool>();
        manager.host_keys.insert_pending("request-1".into(), sender);

        manager.resolve_host_key("request-1", true);

        assert_eq!(receiver.try_recv(), Ok(true));
        assert!(manager.host_keys.pending_is_empty());
    }

    #[test]
    fn missing_session_reports_an_actionable_error() {
        let dir = tempdir().unwrap();
        let manager = SshManager::new(Some(dir.path().join("known_hosts.json")));

        // SFTP / port forwarding / remote edit all resolve their session here;
        // the message must tell the user to reconnect rather than just "not
        // found".
        let error = manager
            .connection("gone")
            .err()
            .expect("unknown session must be an error")
            .to_string();
        assert!(error.contains("reconnect"), "unexpected message: {error}");
    }

    #[test]
    fn resolve_host_key_ignores_unknown_requests() {
        let dir = tempdir().unwrap();
        let manager = SshManager::new(Some(dir.path().join("known_hosts.json")));

        manager.resolve_host_key("missing", false);

        assert!(manager.host_keys.pending_is_empty());
    }

    #[test]
    fn unique_local_path_skips_existing_names() {
        let dir = tempdir().unwrap();
        let first = dir.path().join("report.txt");
        std::fs::write(&first, b"one").unwrap();
        std::fs::write(dir.path().join("report (1).txt"), b"two").unwrap();

        assert_eq!(
            unique_local_path(&first).unwrap(),
            dir.path().join("report (2).txt")
        );
    }

    #[test]
    fn unique_local_path_gives_up_instead_of_returning_the_original() {
        // Exhausting every rename candidate must surface `None` so the
        // transfer fails: the historical fallback returned the original
        // path, which overwrites the file rename was meant to protect.
        let dir = tempdir().unwrap();
        let first = dir.path().join("report.txt");
        std::fs::write(&first, b"one").unwrap();
        for index in 1..1000 {
            std::fs::write(dir.path().join(format!("report ({index}).txt")), b"x").unwrap();
        }

        assert_eq!(unique_local_path(&first), None);
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

    #[test]
    fn upload_resume_requires_matching_provenance() {
        let mtime: u64 = 1_700_000_000_000;
        let meta = |size: u64, mtime_ms: Option<u64>| UploadResumeMeta { size, mtime_ms };

        // Matching size + mtime resumes at the recorded part length.
        assert_eq!(
            upload_resume_offset_from(Some(meta(100, Some(mtime))), Some(40), 100, Some(mtime)),
            40
        );

        // A changed source file (new mtime, same size) must restart from zero.
        assert_eq!(
            upload_resume_offset_from(Some(meta(100, Some(mtime))), Some(40), 100, Some(mtime + 1)),
            0
        );

        // No sidecar, no part file, or a part longer than the source never resumes.
        assert_eq!(
            upload_resume_offset_from(None, Some(40), 100, Some(mtime)),
            0
        );
        assert_eq!(
            upload_resume_offset_from(Some(meta(100, Some(mtime))), None, 100, Some(mtime)),
            0
        );
        assert_eq!(
            upload_resume_offset_from(Some(meta(100, Some(mtime))), Some(120), 100, Some(mtime)),
            0
        );

        // A source without mtime cannot be proven fresh, so never resume.
        assert_eq!(
            upload_resume_offset_from(Some(meta(100, None)), Some(40), 100, None),
            0
        );
    }

    #[test]
    fn download_resume_requires_matching_source() {
        let meta = |source: &str, size: u64, mtime: Option<u32>| DownloadResumeMeta {
            source: source.to_string(),
            size,
            mtime,
        };

        assert_eq!(
            download_resume_offset_from(
                Some(meta("/remote/a.bin", 100, Some(123))),
                Some(40),
                "/remote/a.bin",
                100,
                Some(123)
            ),
            40
        );

        // A .part left by a different remote file, or by an updated one, must
        // be discarded instead of spliced onto new content.
        assert_eq!(
            download_resume_offset_from(
                Some(meta("/remote/a.bin", 100, Some(123))),
                Some(40),
                "/remote/b.bin",
                100,
                Some(123)
            ),
            0
        );
        assert_eq!(
            download_resume_offset_from(
                Some(meta("/remote/a.bin", 100, Some(123))),
                Some(40),
                "/remote/a.bin",
                100,
                Some(456)
            ),
            0
        );

        // Servers without mtime fall back to source path + size.
        assert_eq!(
            download_resume_offset_from(
                Some(meta("/remote/a.bin", 100, None)),
                Some(40),
                "/remote/a.bin",
                100,
                None
            ),
            40
        );
    }

    #[test]
    fn conflict_policies_reject_unknown_values_at_the_boundary() {
        // Unknown policies must fail deserialization instead of degrading
        // to overwrite: the caller gets an explicit error, never a silent
        // destructive default.
        assert!(serde_json::from_str::<SftpTransferOptions>(r#"{"conflict":"whatever"}"#).is_err());
        assert!(serde_json::from_str::<SftpTransferOptions>(r#"{"conflict":""}"#).is_err());
        assert!(serde_json::from_str::<SftpTransferOptions>(r#"{"conflict":null}"#).is_err());

        let options =
            serde_json::from_str::<SftpTransferOptions>(r#"{"conflict":"newer"}"#).unwrap();
        assert_eq!(options.conflict, ConflictPolicy::Newer);
        let options =
            serde_json::from_str::<SftpTransferOptions>(r#"{"conflict":"overwrite"}"#).unwrap();
        assert_eq!(options.conflict, ConflictPolicy::Overwrite);
    }

    #[test]
    fn missing_conflict_policy_defaults_to_ask() {
        let options = serde_json::from_str::<SftpTransferOptions>("{}").unwrap();
        assert_eq!(options.conflict, ConflictPolicy::Ask);
        assert_eq!(SftpTransferOptions::default().conflict, ConflictPolicy::Ask);
    }

    #[test]
    fn zmodem_receive_quota_rejects_oversized_files_and_batches() {
        assert!(zmodem_receive_allowed(Some(1024), 0).is_ok());
        // Unknown sizes pass the start check and are enforced mid-transfer.
        assert!(zmodem_receive_allowed(None, 0).is_ok());

        assert_eq!(
            zmodem_receive_allowed(Some(ZMODEM_MAX_FILE_BYTES + 1), 0).unwrap_err(),
            "ZMODEM file too large (limit 2 GiB)"
        );
        assert!(zmodem_receive_allowed(Some(ZMODEM_MAX_FILE_BYTES), 0).is_ok());

        assert_eq!(
            zmodem_receive_allowed(Some(1024), ZMODEM_MAX_BATCH_BYTES).unwrap_err(),
            "ZMODEM batch exceeds the 8 GiB receive limit"
        );
        // Exactly at the combined limit is still allowed; one byte more is not.
        assert!(zmodem_receive_allowed(
            Some(ZMODEM_MAX_FILE_BYTES),
            ZMODEM_MAX_BATCH_BYTES - ZMODEM_MAX_FILE_BYTES
        )
        .is_ok());
        assert_eq!(
            zmodem_receive_allowed(
                Some(ZMODEM_MAX_FILE_BYTES),
                ZMODEM_MAX_BATCH_BYTES - ZMODEM_MAX_FILE_BYTES + 1
            )
            .unwrap_err(),
            "ZMODEM batch exceeds the 8 GiB receive limit"
        );
    }

    #[test]
    fn conflict_actions_parse_with_cancel_fallback() {
        assert_eq!(
            parse_conflict_action("overwrite"),
            ConflictDecision::Overwrite
        );
        assert_eq!(parse_conflict_action("skip"), ConflictDecision::Skip);
        assert_eq!(parse_conflict_action("rename"), ConflictDecision::Rename);
        assert_eq!(parse_conflict_action("cancel"), ConflictDecision::Cancel);
        assert_eq!(parse_conflict_action("junk"), ConflictDecision::Cancel);
    }

    #[test]
    fn overwrite_if_newer_matches_filezilla_semantics() {
        // Same size, same mtime: target already matches, skip.
        assert!(!overwrite_if_newer(100, 50, 100, 50));
        // Size differs: overwrite regardless of mtimes.
        assert!(overwrite_if_newer(120, 50, 100, 90));
        // Source strictly newer: overwrite.
        assert!(overwrite_if_newer(100, 51, 100, 50));
        // Target newer but same size: keep the target.
        assert!(!overwrite_if_newer(100, 40, 100, 60));
        // Unknown target mtime (0): a source with a real timestamp wins.
        assert!(overwrite_if_newer(100, 1, 100, 0));
    }

    #[tokio::test]
    async fn fresh_cached_channel_is_returned_without_probing() {
        let cache: SftpChannelCache<u32> = SftpChannelCache::default();
        cache.store_verified(1, Some(Instant::now())).await;
        let probed = Arc::new(AtomicBool::new(false));
        let rebuilt = Arc::new(AtomicBool::new(false));
        let probed_probe = probed.clone();
        let rebuilt_flag = rebuilt.clone();
        let result = resolve_cached_channel(
            &cache,
            |a, b| a == b,
            move |_session| -> Pin<Box<dyn Future<Output = bool> + Send>> {
                let probed = probed_probe.clone();
                Box::pin(async move {
                    probed.store(true, Ordering::SeqCst);
                    true
                })
            },
            move || -> Pin<Box<dyn Future<Output = anyhow::Result<u32>> + Send>> {
                rebuilt_flag.store(true, Ordering::SeqCst);
                Box::pin(async { Ok(2) })
            },
        )
        .await
        .unwrap();
        assert_eq!(result, 1);
        assert!(!probed.load(Ordering::SeqCst));
        assert!(!rebuilt.load(Ordering::SeqCst));
    }

    #[tokio::test]
    async fn stale_but_alive_cached_channel_is_reblessed() {
        let cache: SftpChannelCache<u32> = SftpChannelCache::default();
        cache
            .store_verified(1, Some(Instant::now() - Duration::from_secs(60)))
            .await;
        let result = resolve_cached_channel(
            &cache,
            |a, b| a == b,
            |_session| -> Pin<Box<dyn Future<Output = bool> + Send>> { Box::pin(async { true }) },
            || -> Pin<Box<dyn Future<Output = anyhow::Result<u32>> + Send>> {
                Box::pin(async { panic!("a verified channel must not be rebuilt") })
            },
        )
        .await
        .unwrap();
        assert_eq!(result, 1);
        // The verification timestamp was refreshed: the next resolution takes
        // the fast path again.
        let (_, verified_at) = cache.snapshot().await.unwrap();
        assert!(verified_at.unwrap().elapsed() < SFTP_HEALTH_INTERVAL);
    }

    #[tokio::test]
    async fn dead_cached_channel_is_invalidated_and_rebuilt_instead_of_returned() {
        let cache: SftpChannelCache<u32> = SftpChannelCache::default();
        cache
            .store_verified(1, Some(Instant::now() - Duration::from_secs(60)))
            .await;
        let rebuilt = resolve_cached_channel(
            &cache,
            |a, b| a == b,
            |_session| -> Pin<Box<dyn Future<Output = bool> + Send>> {
                // The probe proves the cached handle unusable.
                Box::pin(async { false })
            },
            || -> Pin<Box<dyn Future<Output = anyhow::Result<u32>> + Send>> {
                Box::pin(async { Ok(2) })
            },
        )
        .await
        .unwrap();
        // Regression: the old code fell through to the reopen path, found the
        // same dead handle still cached and returned it as if rebuilt.
        assert_eq!(rebuilt, 2, "the dead cached handle must never be returned");
        assert_eq!(cache.existing().await, Some(2));
        let (session, verified_at) = cache.snapshot().await.unwrap();
        assert_eq!(session, 2);
        assert!(verified_at.unwrap().elapsed() < SFTP_HEALTH_INTERVAL);
    }

    #[tokio::test]
    async fn a_concurrent_rebuild_is_reused_instead_of_duplicated() {
        let cache = Arc::new(SftpChannelCache::<u32>::default());
        cache
            .store_verified(1, Some(Instant::now() - Duration::from_secs(60)))
            .await;
        let probe_cache = cache.clone();
        let rebuilt = Arc::new(AtomicBool::new(false));
        let rebuilt_flag = rebuilt.clone();
        let result = resolve_cached_channel(
            &cache,
            |a, b| a == b,
            move |_session| -> Pin<Box<dyn Future<Output = bool> + Send>> {
                let cache = probe_cache.clone();
                Box::pin(async move {
                    // Another task rebuilds while our probe runs; our probe
                    // still reports the old handle dead.
                    cache.store_verified(3, Some(Instant::now())).await;
                    false
                })
            },
            move || -> Pin<Box<dyn Future<Output = anyhow::Result<u32>> + Send>> {
                rebuilt_flag.store(true, Ordering::SeqCst);
                Box::pin(async { Ok(4) })
            },
        )
        .await
        .unwrap();
        assert_eq!(result, 3, "the concurrent rebuild must be reused");
        assert!(!rebuilt.load(Ordering::SeqCst));
        assert_eq!(cache.existing().await, Some(3));
    }

    #[test]
    fn rejected_batch_rearms_the_scanner_and_clears_cancellation() {
        let machine = std::sync::Mutex::new(ZmodemReceiver::new());
        let mut scanner = BatchStartScanner::new();
        let sentinel = [b'*', b'*', 0x18, b'B', b'0', b'0'];

        // Detection fires on the ZRQINIT announcement.
        assert!(scanner.feed(&sentinel));

        // The reject path writes the cancel sequence (marking the machine
        // aborted) and then resets the local state.
        let cancel = {
            let mut guard = machine.lock().unwrap();
            guard.cancel()
        };
        assert!(!cancel.is_empty());
        reset_after_zmodem_reject(&machine, &mut scanner);

        // Regression: ordinary echo output must not re-open the dialog (the
        // sticky scanner used to keep reporting a batch start)...
        assert!(!scanner.feed(b"user@host:~$ echo hi\r\n"));
        // ...and the machine must not emit abort actions for it.
        let feed = machine.lock().unwrap().feed(b"user@host:~$ echo hi\r\n");
        assert!(!feed.done, "echo must not end a batch");
        assert!(!feed.aborted, "echo must not be reported as an abort");
        assert!(
            !feed.cancelled,
            "the rejection must not leak into later output"
        );
        assert!(feed.actions.is_empty(), "echo must not emit zmodem actions");
        assert_eq!(feed.passthrough, b"user@host:~$ echo hi\r\n");

        // A genuinely new transfer is still detected and prompts again.
        assert!(scanner.feed(&sentinel));
    }

    #[test]
    fn accepting_a_batch_keeps_the_scanner_disarmed_until_batch_end() {
        // The read loop disarms via zbatch_active; this pins the scanner
        // contract that acceptance does NOT re-arm on its own: the sticky
        // flag is only cleared by the explicit reset when the batch ends.
        let mut scanner = BatchStartScanner::new();
        let sentinel = [b'*', b'*', 0x18, b'B', b'0', b'0'];
        assert!(scanner.feed(&sentinel));
        // The loop keeps the scanner armed-but-unused via zbatch_active; the
        // batch-end reset is the only place that clears it.
        scanner.reset();
        assert!(!scanner.feed(b"plain output"));
    }
}
