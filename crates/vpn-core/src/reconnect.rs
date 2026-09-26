//! Reconnect pacing.

use std::time::Duration;

const MAX_DELAY: Duration = Duration::from_secs(30);

/// Delay before attempt `n` (1-based). The first retry is immediate, because
/// most drops (a Wi-Fi roam, a missed handshake) recover on the first try.
/// After that the delay doubles up to 30 s, so a dead network isn't hammered.
/// `jitter` in `[0, 1)` spreads clients that failed at the same moment,
/// e.g. after a node restart.
pub fn delay(attempt: u32, jitter: f64) -> Duration {
    if attempt <= 1 {
        return Duration::ZERO;
    }
    let base = Duration::from_millis(500).saturating_mul(1u32 << (attempt - 1).min(10));
    let base = base.min(MAX_DELAY);
    base.mul_f64(1.0 + 0.2 * jitter.clamp(0.0, 1.0)).min(MAX_DELAY)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn schedule() {
        assert_eq!(delay(1, 0.0), Duration::ZERO);
        assert_eq!(delay(2, 0.0), Duration::from_secs(1));
        assert_eq!(delay(3, 0.0), Duration::from_secs(2));
        assert_eq!(delay(4, 0.0), Duration::from_secs(4));
        assert_eq!(delay(10, 0.0), MAX_DELAY);
        assert_eq!(delay(1000, 0.9), MAX_DELAY);
    }

    #[test]
    fn jitter_is_bounded() {
        let d = delay(3, 0.999);
        assert!(d > Duration::from_secs(2) && d < Duration::from_millis(2400));
    }
}
