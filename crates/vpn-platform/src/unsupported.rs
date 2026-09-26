//! macOS and Linux: integration points.
//!
//! What each platform needs (see docs/VPN_CORE.md):
//! * Linux: kernel WireGuard via netlink (`wireguard` genl family), routes
//!   via rtnetlink with a dedicated table + fwmark, nftables for the kill
//!   switch, systemd-resolved (D-Bus `SetLinkDNS`) for DNS, cgroup v2 +
//!   fwmark for split tunnelling.
//! * macOS: a NetworkExtension packet-tunnel provider (system extension)
//!   running a userspace WireGuard (boringtun), `includeAllNetworks` +
//!   pf anchors for the kill switch, `NEDNSSettings` for DNS.
//!
//! Until they exist, every component reports `UnsupportedPlatform`.

use std::sync::Arc;

use tokio::sync::watch;
use vpn_core::PlatformError;
use vpn_types::time::now_millis;
use vpn_types::{Availability, NetworkSnapshot, Protocol, UnavailableReason};
use zeroize::Zeroizing;

use crate::unavailable::{NoPinger, UnavailableDns, UnavailableDriver, UnavailableFirewall};
use crate::{InitOptions, NetworkMonitor, Platform, SecretStore};

pub fn init(_options: InitOptions) -> Result<Platform, PlatformError> {
    let unsupported = || PlatformError::unsupported("this component");
    let unavailable = Availability::Unavailable(UnavailableReason::UnsupportedPlatform);
    Ok(Platform {
        drivers: [Protocol::WireGuard, Protocol::OpenVpn, Protocol::Ikev2]
            .into_iter()
            .map(|protocol| {
                Arc::new(UnavailableDriver { protocol, reason: UnavailableReason::UnsupportedPlatform })
                    as Arc<dyn vpn_core::TunnelDriver>
            })
            .collect(),
        firewall: Arc::new(UnavailableFirewall(unsupported())),
        dns: Arc::new(UnavailableDns(unsupported())),
        pinger: Arc::new(NoPinger),
        network: Arc::new(StaticNetwork::new()),
        secrets: Arc::new(NoSecrets),
        kill_switch: unavailable.clone(),
        split_tunnel: unavailable.clone(),
        wifi_detection: unavailable,
    })
}

/// Reports "online, no details": without a monitor we can't know better,
/// and blocking connects on a guess would be worse.
struct StaticNetwork(watch::Sender<NetworkSnapshot>);

impl StaticNetwork {
    fn new() -> Self {
        let (tx, _) = watch::channel(NetworkSnapshot { online: true, primary: None, networks: vec![], observed_at: now_millis() });
        Self(tx)
    }
}

impl NetworkMonitor for StaticNetwork {
    fn current(&self) -> NetworkSnapshot {
        self.0.borrow().clone()
    }

    fn subscribe(&self) -> watch::Receiver<NetworkSnapshot> {
        self.0.subscribe()
    }
}

struct NoSecrets;

impl SecretStore for NoSecrets {
    fn seal(&self, _plaintext: &[u8]) -> Result<Vec<u8>, PlatformError> {
        Err(PlatformError::unsupported("secret storage"))
    }

    fn open(&self, _sealed: &[u8]) -> Result<Zeroizing<Vec<u8>>, PlatformError> {
        Err(PlatformError::unsupported("secret storage"))
    }
}
