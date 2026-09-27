//! Product identity for the service, CLI and app core. The UI's name comes
//! from the `app.name` string in each locale.

pub const PRODUCT_NAME: &str = "Apexy VPN";
pub const SERVICE_NAME: &str = "ApexyVPN";
pub const SERVICE_DISPLAY_NAME: &str = "Apexy VPN Service";
pub const TUNNEL_ADAPTER_NAME: &str = "Apexy VPN";
/// WireGuardNT's internal tunnel type (not shown to users).
pub const TUNNEL_TYPE: &str = "Apexy";

/// Local IPC endpoint of the service.
#[cfg(windows)]
pub const IPC_PATH: &str = r"\\.\pipe\apexy";
#[cfg(not(windows))]
pub const IPC_PATH: &str = "/var/run/apexy/apexy.sock";

/// Bumped whenever a request/response/event changes incompatibly.
pub const IPC_PROTOCOL_VERSION: u32 = 1;
