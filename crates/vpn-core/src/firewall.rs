//! Kill switch and leak protection policy.
//!
//! `compute` is a pure function from "what the tunnel is doing" plus
//! settings to the exact rule set that must be in force. Platform firewalls
//! (WFP, nftables, pf) only translate a `FirewallPolicy` into rules; they
//! make no decisions. That keeps the part that matters for leaks in one
//! small, exhaustively tested place.

use std::net::{IpAddr, SocketAddr};
use std::path::PathBuf;
use vpn_types::{InterfaceInfo, KillSwitchMode, Settings};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FirewallPolicy {
    /// Drop everything not explicitly allowed below. This is the kill switch.
    pub block_by_default: bool,
    /// Private ranges, link-local and multicast (printers, casting, NAS).
    pub allow_lan: bool,
    /// The VPN server endpoint, so the tunnel itself can be established.
    pub peer: Option<PeerEndpoint>,
    /// All traffic on the tunnel interface is allowed.
    pub tunnel: Option<InterfaceInfo>,
    /// DNS leak protection: port 53 is dropped everywhere except to these
    /// resolvers on the tunnel interface.
    pub dns_only_via_tunnel: Option<Vec<IpAddr>>,
    /// IPv6 leak protection when the tunnel carries only IPv4.
    pub block_ipv6_outside_tunnel: bool,
    /// Specific executables that may reach specific endpoints even while
    /// blocked (the service and the app talking to the account API).
    pub exceptions: Vec<AppException>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PeerEndpoint {
    pub addr: SocketAddr,
    pub transport: Transport,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Transport {
    Udp,
    Tcp,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AppException {
    pub app: PathBuf,
    pub remote: SocketAddr,
}

impl FirewallPolicy {
    pub fn open() -> Self {
        Self {
            block_by_default: false,
            allow_lan: true,
            peer: None,
            tunnel: None,
            dns_only_via_tunnel: None,
            block_ipv6_outside_tunnel: false,
            exceptions: Vec::new(),
        }
    }

    /// No rules at all.
    pub fn is_open(&self) -> bool {
        !self.block_by_default && self.dns_only_via_tunnel.is_none() && !self.block_ipv6_outside_tunnel
    }

    /// Short description for logs, diagnostics and the connection report.
    pub fn describe(&self) -> String {
        if self.is_open() {
            return "open".into();
        }
        let mut parts = Vec::new();
        if self.block_by_default {
            parts.push("block-all".to_string());
        }
        if self.peer.is_some() {
            parts.push("allow-peer".into());
        }
        if self.tunnel.is_some() {
            parts.push("allow-tunnel".into());
        }
        if self.allow_lan && self.block_by_default {
            parts.push("allow-lan".into());
        }
        if let Some(dns) = &self.dns_only_via_tunnel {
            parts.push(format!("dns-via-tunnel({})", dns.len()));
        }
        if self.block_ipv6_outside_tunnel {
            parts.push("block-ipv6-outside".into());
        }
        if !self.exceptions.is_empty() {
            parts.push(format!("api-exceptions({})", self.exceptions.len()));
        }
        parts.join(",")
    }
}

/// What the tunnel is doing, as far as the firewall is concerned.
#[derive(Debug, Clone, Copy)]
pub enum Phase<'a> {
    /// No tunnel and the user doesn't want one.
    Idle,
    /// Building (or rebuilding) a tunnel to `peer`. `tunnel` is set once the
    /// interface exists (or is being kept during a reconnect).
    Establishing {
        peer: PeerEndpoint,
        tunnel: Option<&'a InterfaceInfo>,
        dns: Option<&'a [IpAddr]>,
    },
    /// Tunnel verified.
    Established {
        peer: PeerEndpoint,
        tunnel: &'a InterfaceInfo,
        dns: &'a [IpAddr],
        ipv6_tunneled: bool,
    },
    /// The user wants the tunnel but there is none right now: waiting for
    /// the network, backing off between attempts, or failed.
    Holding,
}

pub fn compute(phase: Phase<'_>, settings: &Settings, exceptions: &[AppException]) -> FirewallPolicy {
    let kill_switch = settings.kill_switch;
    let blocked = || FirewallPolicy {
        block_by_default: true,
        allow_lan: settings.allow_lan,
        peer: None,
        tunnel: None,
        dns_only_via_tunnel: None,
        block_ipv6_outside_tunnel: false,
        exceptions: exceptions.to_vec(),
    };

    match phase {
        Phase::Idle => match kill_switch {
            KillSwitchMode::AlwaysOn => blocked(),
            _ => FirewallPolicy::open(),
        },
        Phase::Holding => match kill_switch {
            KillSwitchMode::Off => FirewallPolicy::open(),
            _ => blocked(),
        },
        Phase::Establishing { peer, tunnel, dns } => match kill_switch {
            KillSwitchMode::Off => FirewallPolicy::open(),
            _ => FirewallPolicy {
                peer: Some(peer),
                tunnel: tunnel.cloned(),
                dns_only_via_tunnel: dns_rule(settings, tunnel.and(dns)),
                ..blocked()
            },
        },
        Phase::Established { peer, tunnel, dns, ipv6_tunneled } => FirewallPolicy {
            block_by_default: kill_switch != KillSwitchMode::Off,
            allow_lan: settings.allow_lan,
            peer: Some(peer),
            tunnel: Some(tunnel.clone()),
            dns_only_via_tunnel: dns_rule(settings, Some(dns)),
            block_ipv6_outside_tunnel: settings.network.block_ipv6_leaks && !ipv6_tunneled,
            exceptions: if kill_switch == KillSwitchMode::Off { Vec::new() } else { exceptions.to_vec() },
        },
    }
}

fn dns_rule(settings: &Settings, dns: Option<&[IpAddr]>) -> Option<Vec<IpAddr>> {
    let servers = dns?;
    if !settings.dns.block_leaks || settings.dns.mode == vpn_types::DnsMode::System || servers.is_empty() {
        return None;
    }
    Some(servers.to_vec())
}

#[cfg(test)]
mod tests {
    use super::*;
    use vpn_types::{DnsMode, KillSwitchMode::*};

    fn settings(ks: KillSwitchMode) -> Settings {
        Settings { kill_switch: ks, ..Settings::default() }
    }

    fn iface() -> InterfaceInfo {
        InterfaceInfo { name: "Meridian".into(), index: Some(42), luid: Some(7) }
    }

    fn peer() -> PeerEndpoint {
        PeerEndpoint { addr: "185.65.134.10:51820".parse().unwrap(), transport: Transport::Udp }
    }

    const DNS: [IpAddr; 1] = [IpAddr::V4(std::net::Ipv4Addr::new(10, 64, 0, 1))];

    #[test]
    fn idle_is_open_unless_always_on() {
        assert!(compute(Phase::Idle, &settings(Off), &[]).is_open());
        assert!(compute(Phase::Idle, &settings(WhileConnected), &[]).is_open());
        let p = compute(Phase::Idle, &settings(AlwaysOn), &[]);
        assert!(p.block_by_default);
        assert!(p.peer.is_none() && p.tunnel.is_none());
    }

    #[test]
    fn holding_blocks_everything_but_lan_when_kill_switch_on() {
        for ks in [WhileConnected, AlwaysOn] {
            let p = compute(Phase::Holding, &settings(ks), &[]);
            assert!(p.block_by_default, "{ks:?}");
            assert!(p.peer.is_none());
            assert!(p.allow_lan);
        }
        assert!(compute(Phase::Holding, &settings(Off), &[]).is_open());
    }

    #[test]
    fn establishing_allows_only_the_peer() {
        let i = iface();
        let p = compute(
            Phase::Establishing { peer: peer(), tunnel: Some(&i), dns: Some(&DNS) },
            &settings(WhileConnected),
            &[],
        );
        assert!(p.block_by_default);
        assert_eq!(p.peer, Some(peer()));
        assert_eq!(p.tunnel, Some(iface()));
        assert_eq!(p.dns_only_via_tunnel, Some(DNS.to_vec()));
    }

    #[test]
    fn established_blocks_non_tunnel_and_dns_leaks() {
        let i = iface();
        let p = compute(
            Phase::Established { peer: peer(), tunnel: &i, dns: &DNS, ipv6_tunneled: false },
            &settings(WhileConnected),
            &[],
        );
        assert!(p.block_by_default);
        assert_eq!(p.dns_only_via_tunnel, Some(DNS.to_vec()));
        assert!(p.block_ipv6_outside_tunnel);
    }

    #[test]
    fn established_with_kill_switch_off_still_blocks_dns_and_ipv6_leaks() {
        let i = iface();
        let p = compute(
            Phase::Established { peer: peer(), tunnel: &i, dns: &DNS, ipv6_tunneled: false },
            &settings(Off),
            &[],
        );
        assert!(!p.block_by_default);
        assert!(p.dns_only_via_tunnel.is_some());
        assert!(p.block_ipv6_outside_tunnel);
        assert!(!p.is_open());
    }

    #[test]
    fn ipv6_is_not_blocked_when_tunneled_or_disabled() {
        let i = iface();
        let tunneled = compute(
            Phase::Established { peer: peer(), tunnel: &i, dns: &DNS, ipv6_tunneled: true },
            &settings(WhileConnected),
            &[],
        );
        assert!(!tunneled.block_ipv6_outside_tunnel);

        let mut s = settings(WhileConnected);
        s.network.block_ipv6_leaks = false;
        let off = compute(
            Phase::Established { peer: peer(), tunnel: &i, dns: &DNS, ipv6_tunneled: false },
            &s,
            &[],
        );
        assert!(!off.block_ipv6_outside_tunnel);
    }

    #[test]
    fn system_dns_mode_disables_dns_rule() {
        let i = iface();
        let mut s = settings(WhileConnected);
        s.dns.mode = DnsMode::System;
        let p = compute(
            Phase::Established { peer: peer(), tunnel: &i, dns: &DNS, ipv6_tunneled: false },
            &s,
            &[],
        );
        assert_eq!(p.dns_only_via_tunnel, None);
    }

    #[test]
    fn lan_setting_is_respected_when_blocking() {
        let mut s = settings(AlwaysOn);
        s.allow_lan = false;
        assert!(!compute(Phase::Idle, &s, &[]).allow_lan);
    }

    #[test]
    fn exceptions_only_apply_while_blocking() {
        let ex = vec![AppException { app: "C:/meridiand.exe".into(), remote: "203.0.113.5:443".parse().unwrap() }];
        assert_eq!(compute(Phase::Holding, &settings(WhileConnected), &ex).exceptions, ex);
        assert!(compute(Phase::Idle, &settings(WhileConnected), &ex).exceptions.is_empty());
    }

    #[test]
    fn describe_is_stable() {
        assert_eq!(FirewallPolicy::open().describe(), "open");
        assert_eq!(compute(Phase::Holding, &settings(AlwaysOn), &[]).describe(), "block-all,allow-lan");
    }
}
