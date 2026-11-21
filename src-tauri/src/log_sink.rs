//! Session output logging shared by the PTY, SSH, Telnet and serial
//! transports.
//!
//! A sink holds at most one append-mode file. Callers hand decoded output to
//! a background writer thread over a bounded channel: read loops running on
//! the tokio runtime never block on disk IO, and the single writer keeps the
//! log strictly ordered like the output stream. `set_path` still feels
//! synchronous to the caller (it waits for the writer to swap the file), so
//! toggling logging mid-session keeps its append semantics. Sessions with
//! logging off never spawn the writer thread at all.

use std::{
    fs::{File, OpenOptions},
    io::{BufWriter, Write},
    path::Path,
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc::{sync_channel, Receiver, RecvTimeoutError, SyncSender, TrySendError},
        Arc, Mutex,
    },
    thread::JoinHandle,
    time::Duration,
};

use serde::Serialize;

/// Buffered messages the writer accepts before `write` starts degrading the
/// sink. Logging is a terminal-output side channel: losing new chunks under
/// disk backpressure is preferable to stalling the read loop that produced
/// them.
const CHANNEL_CAPACITY: usize = 512;

/// How long the writer waits for more data before flushing the buffer, so a
/// quiet session's log is promptly readable without paying a flush per
/// packet.
const IDLE_FLUSH: Duration = Duration::from_millis(200);

/// Reported through `with_error_callback` (or stderr when no callback is
/// installed) so the frontend can tell the user recording stopped; without
/// it a silently disabled sink would leave the user believing they are
/// still capturing output.
type ErrorCallback = Arc<dyn Fn(&str) + Send + Sync>;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionLogErrorPayload {
    pub session_id: String,
    pub error: String,
}

enum Message {
    Write(String),
    SetPath {
        path: Option<String>,
        ack: std::sync::mpsc::Sender<()>,
    },
}

struct WorkerHandle {
    sender: SyncSender<Message>,
    join: JoinHandle<()>,
}

pub struct LogSink {
    /// File opened at construction, handed to the writer thread when it
    /// first starts. Keeping it in the sink keeps `LogSink::new`
    /// synchronous, like the pre-thread version.
    pending_file: Mutex<Option<BufWriter<File>>>,
    worker: Mutex<Option<WorkerHandle>>,
    /// A path is configured; writes are worth channeling.
    active: AtomicBool,
    /// An error was reported; skip writing until the next successful
    /// `set_path` re-arms the sink, so one failing disk does not turn into
    /// one failed report per output chunk.
    degraded: Arc<AtomicBool>,
    on_error: Option<ErrorCallback>,
}

impl LogSink {
    pub fn new(path: Option<&str>) -> Self {
        Self::with_error_callback(path, None)
    }

    pub fn with_error_callback(path: Option<&str>, on_error: Option<ErrorCallback>) -> Self {
        let pending_file = Mutex::new(path.and_then(|path| open_path(Path::new(path), &on_error)));
        Self {
            pending_file,
            worker: Mutex::new(None),
            active: AtomicBool::new(path.is_some()),
            degraded: Arc::new(AtomicBool::new(false)),
            on_error,
        }
    }

    /// Point the sink at a new file (or none). Re-pointing to the same path
    /// reopens in append mode, which is what the UI expects when toggling.
    /// Waits for the writer to swap the file, so logging done before the
    /// switch is durably in the old file when this returns.
    pub fn set_path(&self, path: Option<&str>) {
        let Some(sender) = self.ensure_worker() else {
            return;
        };
        let (ack, ack_receiver) = std::sync::mpsc::channel();
        if sender
            .send(Message::SetPath {
                path: path.map(str::to_owned),
                ack,
            })
            .is_err()
        {
            return;
        }
        if ack_receiver.recv().is_ok() {
            self.active.store(path.is_some(), Ordering::SeqCst);
            self.degraded.store(false, Ordering::SeqCst);
        }
    }

    /// Append decoded terminal output. A failed write (or a full channel)
    /// degrades the sink instead of retrying on every read; the next
    /// successful `set_path` re-arms it.
    pub fn write(&self, data: &str) {
        if !self.active.load(Ordering::Relaxed) || self.degraded.load(Ordering::Relaxed) {
            return;
        }
        let Some(sender) = self.ensure_worker() else {
            return;
        };
        if let Err(error) = sender.try_send(Message::Write(data.to_owned())) {
            let message = match error {
                TrySendError::Full(_) => "log writer queue full, logging disabled".to_string(),
                TrySendError::Disconnected(_) => "log writer stopped, logging disabled".to_string(),
            };
            report_degraded(&self.degraded, &self.on_error, &message);
        }
    }

    /// Start the writer thread on first use.
    fn ensure_worker(&self) -> Option<SyncSender<Message>> {
        let mut guard = lock(&self.worker);
        if let Some(handle) = guard.as_ref() {
            return Some(handle.sender.clone());
        }
        let (sender, receiver) = sync_channel(CHANNEL_CAPACITY);
        let file = lock(&self.pending_file).take();
        let on_error = self.on_error.clone();
        let degraded = Arc::clone(&self.degraded);
        let join = std::thread::Builder::new()
            .name("session-log-writer".to_string())
            .spawn(move || run_writer(receiver, file, on_error, degraded))
            .ok()?;
        *guard = Some(WorkerHandle {
            sender: sender.clone(),
            join,
        });
        Some(sender)
    }
}

impl Drop for LogSink {
    fn drop(&mut self) {
        // Dropping the sender lets the worker drain the remaining messages,
        // flush and exit; joining guarantees the tail of the log is on disk
        // before the file closes.
        if let Some(handle) = lock(&self.worker).take() {
            drop(handle.sender);
            let _ = handle.join.join();
        }
        // `pending_file` closes with self afterwards and flushes on drop.
    }
}

fn run_writer(
    receiver: Receiver<Message>,
    mut file: Option<BufWriter<File>>,
    on_error: Option<ErrorCallback>,
    degraded: Arc<AtomicBool>,
) {
    loop {
        match receiver.recv_timeout(IDLE_FLUSH) {
            Ok(Message::Write(data)) => {
                if let Some(file) = file.as_mut() {
                    // Flush per message so the file stays current for external
                    // tailing; the flush is a plain write syscall, not fsync,
                    // and it runs on this dedicated thread instead of the
                    // read loop.
                    if let Err(error) = file.write_all(data.as_bytes()).and_then(|()| file.flush())
                    {
                        report_degraded(
                            &degraded,
                            &on_error,
                            &format!("write failed, logging disabled: {error}"),
                        );
                    }
                }
            }
            Ok(Message::SetPath { path, ack }) => {
                // Dropping the previous writer flushes it, so everything
                // logged before the switch lands in the old file.
                file = path
                    .as_deref()
                    .and_then(|path| open_path(Path::new(path), &on_error));
                let _ = ack.send(());
            }
            Err(RecvTimeoutError::Timeout) => {
                if let Some(file) = file.as_mut() {
                    let _ = file.flush();
                }
            }
            // The channel empties before `Disconnected` is reported, so the
            // trailing flush below covers every accepted message.
            Err(RecvTimeoutError::Disconnected) => break,
        }
    }
    if let Some(file) = file.as_mut() {
        let _ = file.flush();
    }
}

fn report_degraded(degraded: &AtomicBool, on_error: &Option<ErrorCallback>, message: &str) {
    if !degraded.swap(true, Ordering::SeqCst) {
        if let Some(on_error) = on_error {
            on_error(message);
        } else {
            eprintln!("[session-log] {message}");
        }
    }
}

fn open_path(path: &Path, on_error: &Option<ErrorCallback>) -> Option<BufWriter<File>> {
    match OpenOptions::new().create(true).append(true).open(path) {
        Ok(file) => Some(BufWriter::new(file)),
        Err(error) => {
            // Rare and user-triggered (construction, toggling): report every
            // time instead of through the once-per-degradation latch.
            let message = format!("failed to open {}: {error}", path.display());
            match on_error {
                Some(on_error) => on_error(&message),
                None => eprintln!("[session-log] {message}"),
            }
            None
        }
    }
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poison| poison.into_inner())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;

    fn temp_path(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("nexterm-log-sink-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        dir.join(name)
    }

    #[test]
    fn writes_and_appends_across_reopen() {
        let path = temp_path("append.log");
        let _ = std::fs::remove_file(&path);

        {
            let sink = LogSink::new(path.to_str());
            sink.write("hello ");
            sink.write("world\n");
        }

        // Reopen (the reconnect case): content must append, not truncate.
        // Writes drain asynchronously; dropping the sink joins the writer
        // and flushes, which is what makes the content readable here.
        {
            let sink = LogSink::new(path.to_str());
            sink.write("again\n");
        }

        let content = std::fs::read_to_string(&path).unwrap();
        assert_eq!(content, "hello world\nagain\n");
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn set_path_switches_target_and_none_disables() {
        let first = temp_path("first.log");
        let second = temp_path("second.log");
        let _ = std::fs::remove_file(&first);
        let _ = std::fs::remove_file(&second);

        let sink = LogSink::new(None);
        sink.write("dropped\n");
        sink.set_path(first.to_str());
        sink.write("one\n");
        sink.set_path(second.to_str());
        sink.write("two\n");
        sink.set_path(None);
        sink.write("dropped\n");

        assert_eq!(std::fs::read_to_string(&first).unwrap(), "one\n");
        assert_eq!(std::fs::read_to_string(&second).unwrap(), "two\n");
        let _ = std::fs::remove_file(&first);
        let _ = std::fs::remove_file(&second);
    }

    #[test]
    fn unwritable_path_disables_without_panicking() {
        // A directory cannot be opened for append; the sink must stay inert.
        let dir = temp_path("not-a-file");
        std::fs::create_dir_all(&dir).unwrap();
        let sink = LogSink::new(dir.to_str());
        sink.write("ignored\n");
    }

    #[test]
    fn open_failure_reports_once_and_writes_stay_inert() {
        let dir = temp_path("still-not-a-file");
        std::fs::create_dir_all(&dir).unwrap();
        let failures = Arc::new(AtomicUsize::new(0));
        let failures_for_callback = Arc::clone(&failures);
        let sink = LogSink::with_error_callback(
            dir.to_str(),
            Some(Arc::new(move |_error: &str| {
                failures_for_callback.fetch_add(1, Ordering::SeqCst);
            })),
        );

        // Every write after the failed open is dropped silently: the
        // user was already told once.
        for _ in 0..4 {
            sink.write("ignored\n");
        }
        assert_eq!(failures.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn successful_set_path_rearms_the_report() {
        let good = temp_path("good.log");
        let bad = temp_path("bad-dir-name");
        std::fs::create_dir_all(&bad).unwrap();
        let _ = std::fs::remove_file(&good);
        let failures = Arc::new(AtomicUsize::new(0));
        let failures_for_callback = Arc::clone(&failures);
        let sink = LogSink::with_error_callback(
            good.to_str(),
            Some(Arc::new(move |_error: &str| {
                failures_for_callback.fetch_add(1, Ordering::SeqCst);
            })),
        );

        sink.set_path(bad.to_str());
        assert_eq!(failures.load(Ordering::SeqCst), 1);
        sink.set_path(good.to_str());
        sink.write("after rearm\n");
        // The reopened sink works and nothing new was reported.
        assert_eq!(failures.load(Ordering::SeqCst), 1);
        drop(sink);
        assert_eq!(std::fs::read_to_string(&good).unwrap(), "after rearm\n");
        let _ = std::fs::remove_file(&good);
    }
}
