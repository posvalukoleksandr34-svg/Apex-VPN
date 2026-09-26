//! The connection log: structured events for Diagnostics → Logs.
//!
//! What goes in: connection attempts, disconnects, server and protocol
//! changes, network changes, DNS and firewall problems, reconnects. What
//! never goes in: traffic, visited hosts, DNS queries. Messages are
//! redacted (IPs masked, keys removed) unless diagnostic mode is on, before
//! they reach memory or disk.

use std::collections::VecDeque;
use std::io::Write;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicU8, Ordering};
use std::sync::Mutex;

use tokio::sync::broadcast;
use vpn_core::redact::redact;
use vpn_core::tunnel::ConnectionLog;
use vpn_types::ipc::Event;
use vpn_types::time::now_millis;
use vpn_types::{LogCategory, LogEntry, LogLevel, LogQuery};

const MEMORY_ENTRIES: usize = 5_000;
const FILE_MAX_BYTES: u64 = 5 * 1024 * 1024;
const FILE_KEEP: usize = 5;

pub struct LogBook {
    entries: Mutex<VecDeque<LogEntry>>,
    seq: AtomicU64,
    level: AtomicU8,
    diagnostic_mode: AtomicBool,
    file: Mutex<Option<std::fs::File>>,
    path: PathBuf,
    events: broadcast::Sender<Event>,
}

fn level_rank(l: LogLevel) -> u8 {
    match l {
        LogLevel::Error => 0,
        LogLevel::Warn => 1,
        LogLevel::Info => 2,
        LogLevel::Debug => 3,
    }
}

impl LogBook {
    pub fn new(dir: PathBuf, events: broadcast::Sender<Event>) -> Self {
        let path = dir.join("connection.log");
        let file = std::fs::OpenOptions::new().create(true).append(true).open(&path).ok();
        let book = Self {
            entries: Mutex::new(VecDeque::with_capacity(MEMORY_ENTRIES)),
            seq: AtomicU64::new(1),
            level: AtomicU8::new(level_rank(LogLevel::Info)),
            diagnostic_mode: AtomicBool::new(false),
            file: Mutex::new(file),
            path,
            events,
        };
        book.load_tail();
        book
    }

    pub fn configure(&self, level: LogLevel, diagnostic_mode: bool) {
        self.level.store(level_rank(level), Ordering::Relaxed);
        self.diagnostic_mode.store(diagnostic_mode, Ordering::Relaxed);
    }

    pub fn diagnostic_mode(&self) -> bool {
        self.diagnostic_mode.load(Ordering::Relaxed)
    }

    /// Restores recent history after a restart.
    fn load_tail(&self) {
        let Ok(text) = std::fs::read_to_string(&self.path) else { return };
        let mut entries = self.entries.lock().expect("log");
        for line in text.lines().rev().take(MEMORY_ENTRIES).collect::<Vec<_>>().into_iter().rev() {
            if let Ok(e) = serde_json::from_str::<LogEntry>(line) {
                self.seq.fetch_max(e.seq + 1, Ordering::Relaxed);
                entries.push_back(e);
            }
        }
    }

    pub fn query(&self, q: &LogQuery) -> Vec<LogEntry> {
        let entries = self.entries.lock().expect("log");
        let limit = q.limit.unwrap_or(500).min(MEMORY_ENTRIES as u32) as usize;
        let mut out: Vec<LogEntry> = entries
            .iter()
            .rev()
            .filter(|e| q.after_seq.is_none_or(|s| e.seq > s))
            .filter(|e| q.min_level.is_none_or(|l| level_rank(e.level) <= level_rank(l)))
            .filter(|e| q.category.is_none_or(|c| e.category == c))
            .take(limit)
            .cloned()
            .collect();
        out.reverse();
        out
    }

    pub fn export_text(&self, header: &str) -> String {
        let entries = self.entries.lock().expect("log");
        let mut out = String::from(header);
        out.push('\n');
        for e in entries.iter() {
            out.push_str(&format!(
                "{} {:5} {:10} {:28} {}\n",
                format_time(e.at),
                format!("{:?}", e.level).to_uppercase(),
                format!("{:?}", e.category).to_lowercase(),
                e.event,
                e.message
            ));
        }
        out
    }

    pub fn clear(&self) {
        self.entries.lock().expect("log").clear();
        if let Ok(mut f) = self.file.lock() {
            *f = std::fs::File::create(&self.path).ok();
        }
    }

    fn rotate_if_needed(&self, file: &mut Option<std::fs::File>) {
        let big = file.as_ref().and_then(|f| f.metadata().ok()).is_some_and(|m| m.len() > FILE_MAX_BYTES);
        if !big {
            return;
        }
        *file = None;
        for i in (1..FILE_KEEP).rev() {
            let from = self.path.with_extension(format!("log.{i}"));
            let to = self.path.with_extension(format!("log.{}", i + 1));
            let _ = std::fs::rename(from, to);
        }
        let _ = std::fs::rename(&self.path, self.path.with_extension("log.1"));
        *file = std::fs::OpenOptions::new().create(true).append(true).open(&self.path).ok();
    }
}

impl ConnectionLog for LogBook {
    fn record(&self, level: LogLevel, category: LogCategory, event: &'static str, message: String) {
        if level_rank(level) > self.level.load(Ordering::Relaxed) {
            return;
        }
        let message = if self.diagnostic_mode() { message } else { redact(&message) };
        let entry = LogEntry { seq: self.seq.fetch_add(1, Ordering::Relaxed), at: now_millis(), level, category, event: event.to_string(), message };
        match level {
            LogLevel::Error => tracing::error!(category = ?entry.category, event = entry.event, "{}", entry.message),
            LogLevel::Warn => tracing::warn!(category = ?entry.category, event = entry.event, "{}", entry.message),
            LogLevel::Info => tracing::info!(category = ?entry.category, event = entry.event, "{}", entry.message),
            LogLevel::Debug => tracing::debug!(category = ?entry.category, event = entry.event, "{}", entry.message),
        }
        {
            let mut entries = self.entries.lock().expect("log");
            if entries.len() == MEMORY_ENTRIES {
                entries.pop_front();
            }
            entries.push_back(entry.clone());
        }
        if let Ok(mut file) = self.file.lock() {
            self.rotate_if_needed(&mut file);
            if let Some(f) = file.as_mut() {
                let _ = writeln!(f, "{}", serde_json::to_string(&entry).expect("entries serialize"));
            }
        }
        let _ = self.events.send(Event::Log(entry));
    }
}

fn format_time(ms: u64) -> String {
    // UTC, ISO-8601 without pulling in a date crate.
    let secs = (ms / 1000) as i64;
    let (days, rem) = (secs.div_euclid(86_400), secs.rem_euclid(86_400));
    let (h, m, s) = (rem / 3600, (rem % 3600) / 60, rem % 60);
    let (y, mo, d) = civil_from_days(days);
    format!("{y:04}-{mo:02}-{d:02}T{h:02}:{m:02}:{s:02}.{:03}Z", ms % 1000)
}

/// Howard Hinnant's days → civil date.
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn book() -> (LogBook, tempfile::TempDir) {
        let dir = tempfile::tempdir().unwrap();
        let (tx, _) = broadcast::channel(8);
        (LogBook::new(dir.path().to_path_buf(), tx), dir)
    }

    #[test]
    fn redacts_unless_diagnostic_mode() {
        let (b, _d) = book();
        b.record(LogLevel::Info, LogCategory::Connection, "connect.attempt", "endpoint 185.65.134.10:51820".into());
        assert_eq!(b.query(&LogQuery::default())[0].message, "endpoint 185.x.x.x:51820");
        b.configure(LogLevel::Info, true);
        b.record(LogLevel::Info, LogCategory::Connection, "connect.attempt", "endpoint 185.65.134.10:51820".into());
        assert_eq!(b.query(&LogQuery::default())[1].message, "endpoint 185.65.134.10:51820");
    }

    #[test]
    fn level_filter_and_query() {
        let (b, _d) = book();
        b.record(LogLevel::Debug, LogCategory::Firewall, "firewall.applied", "x".into());
        assert!(b.query(&LogQuery::default()).is_empty(), "debug is off by default");
        b.record(LogLevel::Warn, LogCategory::Dns, "dns.apply_failed", "y".into());
        b.record(LogLevel::Info, LogCategory::Network, "network.changed", "z".into());
        let warn_only = b.query(&LogQuery { min_level: Some(LogLevel::Warn), ..Default::default() });
        assert_eq!(warn_only.len(), 1);
        let after = b.query(&LogQuery { after_seq: Some(warn_only[0].seq), ..Default::default() });
        assert_eq!(after.len(), 1);
        assert_eq!(after[0].event, "network.changed");
    }

    #[test]
    fn survives_restart() {
        let dir = tempfile::tempdir().unwrap();
        let (tx, _) = broadcast::channel(8);
        {
            let b = LogBook::new(dir.path().to_path_buf(), tx.clone());
            b.record(LogLevel::Info, LogCategory::Service, "service.start", "hello".into());
        }
        let b = LogBook::new(dir.path().to_path_buf(), tx);
        assert_eq!(b.query(&LogQuery::default()).len(), 1);
        b.record(LogLevel::Info, LogCategory::Service, "service.start", "again".into());
        let all = b.query(&LogQuery::default());
        assert!(all[1].seq > all[0].seq);
    }

    #[test]
    fn time_format() {
        assert_eq!(format_time(1_609_459_200_123), "2021-01-01T00:00:00.123Z");
        assert_eq!(format_time(951_782_400_000), "2000-02-29T00:00:00.000Z");
    }
}
