//! Product identity in one place. Renaming the product means editing this file
//! and `apps/desktop/src/brand.ts`, nothing else.

pub const PRODUCT_NAME: &str = "Meridian";
pub const SERVICE_NAME: &str = "MeridianVPN";
pub const SERVICE_DISPLAY_NAME: &str = "Meridian VPN Service";
pub const TUNNEL_ADAPTER_NAME: &str = "Meridian";
pub const TUNNEL_TYPE: &str = "Meridian";

/// Local IPC endpoint of the service.
#[cfg(windows)]
pub const IPC_PATH: &str = r"\\.\pipe\meridian";
#[cfg(not(windows))]
pub const IPC_PATH: &str = "/var/run/meridian/meridian.sock";

/// Bumped whenever a request/response/event changes incompatibly.
pub const IPC_PROTOCOL_VERSION: u32 = 1;
