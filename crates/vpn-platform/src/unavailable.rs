//! Stand-ins for components that can't run here. They fail loudly and
//! consistently instead of pretending: `capability()` says why, and every
//! operation returns the reason as an error.

use std::net::IpAddr;
use std::time::Duration;

use async_trait::async_trait;
use vpn_core::firewall::FirewallPolicy;
use vpn_core::{DnsConfigurator, Firewall, Pinger, PlatformError, PlatformResult, Tunnel, TunnelConfig, TunnelDriver};
use vpn_types::ipc::FirewallSummary;
use vpn_types::{Availability, ErrorKind, InterfaceInfo, Protocol, ProtocolCapability, UnavailableReason};

pub struct UnavailableDriver {
    pub protocol: Protocol,
    pub reason: UnavailableReason,
}

#[async_trait]
impl TunnelDriver for UnavailableDriver {
    fn protocol(&self) -> Protocol {
        self.protocol
    }

    fn capability(&self) -> ProtocolCapability {
        ProtocolCapability { protocol: self.protocol, availability: Availability::Unavailable(self.reason), implementation: None }
    }

    async fn open(&self, _config: TunnelConfig) -> PlatformResult<Box<dyn Tunnel>> {
        Err(PlatformError::new(ErrorKind::ProtocolUnavailable, format!("{:?} is not available in this build", self.protocol)))
    }
}

/// A firewall that could not be initialised (e.g. the service isn't
/// elevated). Every apply fails, so the state machine refuses to connect
/// with a kill switch it can't enforce — and says so.
pub struct UnavailableFirewall(pub PlatformError);

#[async_trait]
impl Firewall for UnavailableFirewall {
    async fn apply(&self, policy: &FirewallPolicy) -> PlatformResult<()> {
        if policy.is_open() {
            // Nothing to enforce, nothing to fail.
            return Ok(());
        }
        Err(self.0.clone())
    }

    async fn summary(&self) -> FirewallSummary {
        FirewallSummary { policy: format!("unavailable: {}", self.0.detail), verified: false, filter_count: 0 }
    }
}

pub struct UnavailableDns(pub PlatformError);

#[async_trait]
impl DnsConfigurator for UnavailableDns {
    async fn apply(&self, _tunnel: &InterfaceInfo, _servers: &[IpAddr]) -> PlatformResult<()> {
        Err(self.0.clone())
    }

    async fn reset(&self) -> PlatformResult<()> {
        Ok(())
    }

    async fn effective(&self, _tunnel: &InterfaceInfo) -> Vec<IpAddr> {
        Vec::new()
    }
}

pub struct NoPinger;

#[async_trait]
impl Pinger for NoPinger {
    async fn ping(&self, _target: IpAddr, _timeout: Duration) -> Option<Duration> {
        None
    }
}
