//! Leak tests. Each verdict comes from an observation made now; when the
//! evidence isn't there, the verdict is `UnableToVerify` and the finding
//! code says why. (WebRTC is tested by the app, in its browser engine.)

use std::net::IpAddr;
use std::time::Duration;

use vpn_types::time::now_millis;
use vpn_types::{ConnectedDetails, DnsMode, IpcErrorKind, LeakTest, LeakTestResult, LeakVerdict, TunnelState};

use crate::daemon::Daemon;

fn result(test: LeakTest, verdict: LeakVerdict, finding: &str, observed: Vec<IpAddr>, expected: Vec<IpAddr>) -> LeakTestResult {
    LeakTestResult { test, verdict, finding: finding.into(), observed, expected, tested_at: now_millis() }
}

pub async fn run(d: &Daemon) -> Vec<LeakTestResult> {
    let state = d.state.borrow().clone();
    let TunnelState::Connected { details } = state else {
        return [LeakTest::Ipv4, LeakTest::Ipv6, LeakTest::Dns]
            .into_iter()
            .map(|t| result(t, LeakVerdict::UnableToVerify, "not_connected", vec![], vec![]))
            .collect();
    };
    vec![ipv4(d, &details).await, ipv6(d, &details).await, dns(d, &details).await]
}

async fn ipv4(d: &Daemon, details: &ConnectedDetails) -> LeakTestResult {
    let server_ip = d
        .relays
        .read()
        .expect("relays")
        .list
        .as_ref()
        .and_then(|l| l.server(&details.relay.server_id))
        .map(|s| IpAddr::V4(s.ipv4));
    let expected: Vec<IpAddr> = server_ip.into_iter().collect();
    let observed = match d.check_ip().await {
        Ok(o) => o.ip,
        // The check service answered with a local address: it runs on this
        // machine or network (development), so it can't see the public one.
        Err(e) if e.kind == IpcErrorKind::Unsupported => {
            return result(LeakTest::Ipv4, LeakVerdict::UnableToVerify, "ip_check_not_public", vec![], expected)
        }
        Err(_) => return result(LeakTest::Ipv4, LeakVerdict::UnableToVerify, "ip_service_unreachable", vec![], expected),
    };
    let own_ip = d.ip_observations().unprotected.map(|o| o.ip);
    if expected.contains(&observed) {
        result(LeakTest::Ipv4, LeakVerdict::Protected, "exit_is_vpn_server", vec![observed], expected)
    } else if own_ip == Some(observed) {
        // Traffic reaches the internet from the user's own address. With a
        // server on the local network this is expected; either way the
        // address is not hidden, and we say so.
        result(LeakTest::Ipv4, LeakVerdict::PotentialLeak, "exit_is_your_own_ip", vec![observed], expected)
    } else {
        // Some fleets NAT through a different exit address than the endpoint.
        result(LeakTest::Ipv4, LeakVerdict::UnableToVerify, "exit_differs_from_server", vec![observed], expected)
    }
}

async fn ipv6(d: &Daemon, details: &ConnectedDetails) -> LeakTestResult {
    let p = &details.protections;
    let network_has_v6 = d.platform.network.current().networks.iter().any(|n| n.has_ipv6);
    if p.ipv6_tunneled {
        // Verifying tunneled IPv6 needs an IPv6-only check endpoint.
        return result(LeakTest::Ipv6, LeakVerdict::UnableToVerify, "no_ipv6_check_endpoint", vec![], vec![]);
    }
    if !network_has_v6 {
        return result(LeakTest::Ipv6, LeakVerdict::Protected, "no_ipv6_on_network", vec![], vec![]);
    }
    let firewall = d.platform.firewall.summary().await;
    if p.ipv6_leak_blocking && firewall.verified {
        result(LeakTest::Ipv6, LeakVerdict::Protected, "ipv6_blocked_outside_tunnel", vec![], vec![])
    } else if p.ipv6_leak_blocking {
        result(LeakTest::Ipv6, LeakVerdict::UnableToVerify, "firewall_not_verified", vec![], vec![])
    } else {
        result(LeakTest::Ipv6, LeakVerdict::PotentialLeak, "ipv6_not_blocked", vec![], vec![])
    }
}

async fn dns(d: &Daemon, details: &ConnectedDetails) -> LeakTestResult {
    let expected = details.dns_servers.clone();
    if details.dns_mode == DnsMode::System {
        return result(LeakTest::Dns, LeakVerdict::PotentialLeak, "system_dns_in_use", vec![], expected);
    }
    if !details.protections.dns_leak_blocking {
        return result(LeakTest::Dns, LeakVerdict::PotentialLeak, "dns_leak_protection_off", vec![], expected);
    }

    // Active check: ask the local network's own resolvers directly. With
    // leak protection working, the firewall drops these queries.
    let outside: Vec<IpAddr> = d
        .platform
        .network
        .current()
        .networks
        .iter()
        .flat_map(|n| n.dns_servers.clone())
        .filter(|ip| !expected.contains(ip))
        .take(3)
        .collect();
    let mut answered = Vec::new();
    for ip in &outside {
        let r = vpn_platform::dns_probe::query_a(*ip, &d.cfg.dns_test_name, Duration::from_millis(1500)).await;
        if r.rtt_ms.is_some() {
            answered.push(*ip);
        }
    }
    if !answered.is_empty() {
        return result(LeakTest::Dns, LeakVerdict::PotentialLeak, "resolver_outside_tunnel_answered", answered, expected);
    }

    // Configuration check: what Windows reports for the tunnel interface.
    let effective = d.platform.dns.effective(&details.interface).await;
    if effective.is_empty() {
        return result(LeakTest::Dns, LeakVerdict::UnableToVerify, "dns_config_unreadable", vec![], expected);
    }
    if effective.iter().all(|ip| expected.contains(ip)) {
        let finding = if outside.is_empty() { "dns_config_verified" } else { "dns_only_via_tunnel" };
        result(LeakTest::Dns, LeakVerdict::Protected, finding, effective, expected)
    } else {
        result(LeakTest::Dns, LeakVerdict::PotentialLeak, "unexpected_tunnel_resolver", effective, expected)
    }
}
