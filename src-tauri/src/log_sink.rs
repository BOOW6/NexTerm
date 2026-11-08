//! Session output logging shared by the PTY and SSH transports.
//!
//! A sink holds at most one append-mode file; the read loops of both
//! transports write their decoded output through it without any extra IPC.
//! Opening the file lazily per path keeps "logging off" free and lets the
//! setting be flipped mid-session via `set_path`.

use std::{
    fs::{File, OpenOptions},
    io::{BufWriter, Write},
    path::Path,
    sync::Mutex,
};

pub struct LogSink {
    file: Mutex<Option<BufWriter<File>>>,
}

impl LogSink {
    pub fn new(path: Option<&str>) -> Self {
        let file = Mutex::new(path.and_then(Self::open));
        Self { file }
    }

    fn open(path: &str) -> Option<BufWriter<File>> {
        match OpenOptions::new()
            .create(true)
            .append(true)
            .open(Path::new(path))
        {
            Ok(file) => Some(BufWriter::new(file)),
            Err(error) => {
                eprintln!("[session-log] failed to open {path}: {error}");
                None
            }
        }
    }

    /// Point the sink at a new file (or none). Re-pointing to the same path
    /// reopens in append mode, which is what the UI expects when toggling.
    pub fn set_path(&self, path: Option<&str>) {
        *lock(&self.file) = path.and_then(Self::open);
    }

    /// Append decoded terminal output. A failed write disables the sink for
    /// the rest of the session instead of retrying on every read.
    pub fn write(&self, data: &str) {
        let mut guard = lock(&self.file);
        if let Some(file) = guard.as_mut() {
            if let Err(error) = file.write_all(data.as_bytes()).and_then(|()| file.flush()) {
                guard.take();
                // A silently disabled recording is worse than an aborted one:
                // the user believes they are still capturing output.
                eprintln!("[session-log] write failed, logging disabled: {error}");
            }
        }
    }
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poison| poison.into_inner())
}

#[cfg(test)]
mod tests {
    use super::*;

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
        let sink = LogSink::new(path.to_str());
        sink.write("again\n");

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
}
