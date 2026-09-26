//! Wire types shared by the privileged service (`meridiand`), the desktop app
//! and the CLI.
//!
//! Everything here is plain data: no I/O, no platform code. Types derive
//! `ts_rs::TS`, and `cargo test -p vpn-types` regenerates their TypeScript
//! mirror under `apps/desktop/src/protocol/generated`, so the UI is compiled
//! against the exact shapes the service sends.

pub mod brand;
pub mod capabilities;
pub mod device;
pub mod diagnostics;
pub mod error;
pub mod ipc;
pub mod logs;
pub mod network;
pub mod relay;
pub mod settings;
pub mod state;
pub mod stats;
pub mod time;

pub use capabilities::*;
pub use device::*;
pub use diagnostics::*;
pub use error::*;
pub use logs::*;
pub use network::*;
pub use relay::*;
pub use settings::*;
pub use state::*;
pub use stats::*;
pub use time::UnixMillis;
