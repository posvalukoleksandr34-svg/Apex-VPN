//! Windows implementation.

pub mod apps;
pub mod dns;
pub mod icmp;
pub mod keystore;
pub mod routing;
pub mod netmon;
pub mod trust;
pub mod tunnel;
pub mod util;
pub mod wfp;
pub mod wireguard_nt;
pub mod wlan;

use std::sync::Arc;

use vpn_core::{Firewall, PlatformError};
use vpn_types::{Availability, ErrorKind, Protocol, UnavailableReason};

use crate::unavailable::{UnavailableDriver, UnavailableFirewall};
use crate::{InitOptions, Platform};

pub fn init(options: InitOptions) -> Result<Platform, PlatformError> {
    let nt = wireguard_nt::WireGuardNt::load(&options.driver_dir, options.require_signed_driver);

    let (firewall, kill_switch): (Arc<dyn Firewall>, Availability) = match wfp::WfpFirewall::open() {
        Ok(fw) => (Arc::new(fw), Availability::Available),
        Err(e) => {
            tracing::error!("Windows Filtering Platform unavailable: {e}");
            let reason = if e.kind == ErrorKind::PermissionDenied {
                UnavailableReason::PermissionDenied
            } else {
                UnavailableReason::UnsupportedPlatform
            };
            (Arc::new(UnavailableFirewall(e)), Availability::Unavailable(reason))
        }
    };

    let network = netmon::WindowsNetworkMonitor::start();
    let wifi_detection = match network.wlan_status() {
        wlan::WlanStatus::AccessDenied => Availability::Unavailable(UnavailableReason::PermissionDenied),
        _ => Availability::Available,
    };

    Ok(Platform {
        drivers: vec![
            Arc::new(tunnel::WireGuardNtDriver::new(nt)),
            // Integration points: an OpenVPN (ovpn-dco-win) driver and an
            // IKEv2 (RasMan) driver would slot in here.
            Arc::new(UnavailableDriver { protocol: Protocol::OpenVpn, reason: UnavailableReason::NotBundled }),
            Arc::new(UnavailableDriver { protocol: Protocol::Ikev2, reason: UnavailableReason::NotBundled }),
        ],
        firewall,
        dns: Arc::new(dns::WindowsDns::new()),
        pinger: Arc::new(icmp::IcmpPinger),
        network: Arc::new(network),
        secrets: Arc::new(keystore::DpapiStore),
        kill_switch,
        // Per-app routing on Windows needs a WFP callout driver (kernel
        // mode, separately signed). Not part of this build.
        split_tunnel: Availability::Unavailable(UnavailableReason::DriverMissing),
        wifi_detection,
    })
}

/// Removes every filter we own. For the uninstaller and for recovering a
/// machine left blocked by a service that no longer exists.
pub fn reset_firewall() -> Result<(), PlatformError> {
    wfp::WfpFirewall::open()?.remove_all()
}
