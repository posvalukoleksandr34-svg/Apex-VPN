//! Platform-independent VPN logic.
//!
//! Nothing in this crate touches the OS. Platform effects (tunnel adapters,
//! firewall, DNS, network and power notifications) come in through the
//! traits in [`platform`], which makes every decision here unit-testable
//! with fakes, including the failure scenarios (network switch, sleep/wake,
//! server failure, DNS failure) that are hard to reproduce on a real machine.

pub mod autoconnect;
pub mod firewall;
pub mod geo;
pub mod keys;
pub mod platform;
pub mod protocol;
pub mod reconnect;
pub mod redact;
pub mod relay;
pub mod selection;
pub mod settings;
pub mod tunnel;

pub use platform::*;
