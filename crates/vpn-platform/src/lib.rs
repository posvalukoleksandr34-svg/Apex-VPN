//! Operating-system integration.
//!
//! * **Windows** is implemented: WireGuardNT tunnel, Windows Filtering
//!   Platform kill switch, interface DNS, network and Wi-Fi monitoring, ICMP
//!   probes and DPAPI-sealed secrets.
//! * **macOS and Linux** are integration points. Every component exists and
//!   reports itself as unavailable (`UnsupportedPlatform`) instead of
//!   pretending to work. See `docs/VPN_CORE.md` for what each needs.

use std::path::PathBuf;
use std::sync::Arc;

use vpn_core::{DnsConfigurator, Firewall, Pinger, PlatformError, TunnelDriver};
use vpn_types::{Availability, NetworkSnapshot};
use zeroize::Zeroizing;

pub mod apps;
pub mod dns_probe;
pub mod os;
pub mod routing;
pub mod unavailable;

#[cfg(windows)]
pub mod windows;

#[cfg(not(windows))]
mod unsupported;

/// Watches the physical networks (never the tunnel itself).
pub trait NetworkMonitor: Send + Sync {
    fn current(&self) -> NetworkSnapshot;
    /// Receives a new snapshot whenever the set of networks, the primary
    /// network, or connectivity changes (debounced).
    fn subscribe(&self) -> tokio::sync::watch::Receiver<NetworkSnapshot>;
}

/// Seals small secrets (the device private key) to this machine.
pub trait SecretStore: Send + Sync {
    fn seal(&self, plaintext: &[u8]) -> Result<Vec<u8>, PlatformError>;
    fn open(&self, sealed: &[u8]) -> Result<Zeroizing<Vec<u8>>, PlatformError>;
}

pub struct Platform {
    pub drivers: Vec<Arc<dyn TunnelDriver>>,
    pub firewall: Arc<dyn Firewall>,
    pub dns: Arc<dyn DnsConfigurator>,
    pub pinger: Arc<dyn Pinger>,
    pub network: Arc<dyn NetworkMonitor>,
    pub secrets: Arc<dyn SecretStore>,
    pub kill_switch: Availability,
    pub split_tunnel: Availability,
    pub wifi_detection: Availability,
}

pub struct InitOptions {
    /// Directory holding `wireguard.dll` (next to the service binary in
    /// installed builds).
    pub driver_dir: PathBuf,
    /// Refuse a driver that isn't Authenticode-signed by WireGuard LLC.
    /// Only a development build may turn this off.
    pub require_signed_driver: bool,
}

/// Builds the platform for this OS. Must run inside a tokio runtime.
pub fn init(options: InitOptions) -> Result<Platform, PlatformError> {
    #[cfg(windows)]
    {
        windows::init(options)
    }
    #[cfg(not(windows))]
    {
        unsupported::init(options)
    }
}
