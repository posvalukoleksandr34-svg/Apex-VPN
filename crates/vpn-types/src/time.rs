use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// Milliseconds since the Unix epoch. Timestamps cross the IPC boundary as
/// plain numbers (exact in JavaScript up to year 287 396).
pub type UnixMillis = u64;

pub fn now_millis() -> UnixMillis {
    to_millis(SystemTime::now())
}

pub fn to_millis(t: SystemTime) -> UnixMillis {
    t.duration_since(UNIX_EPOCH).unwrap_or(Duration::ZERO).as_millis() as UnixMillis
}

pub fn from_millis(ms: UnixMillis) -> SystemTime {
    UNIX_EPOCH + Duration::from_millis(ms)
}
