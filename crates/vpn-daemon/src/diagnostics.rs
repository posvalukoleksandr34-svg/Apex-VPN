//! Diagnostics center checks. Each returns ✓ Working / ⚠ Warning / ✕ Failed
//! (or Skipped when not applicable) with a stable finding code; the app
//! maps codes to "what went wrong / likely causes / what to do".

use std::net::{IpAddr, Ipv4Addr};
use std::time::{Duration, Instant};

use serde_json::{json, Map, Value};
use vpn_types::{Availability, CheckId, CheckResult, CheckStatus, KillSwitchMode, TunnelState};

use crate::daemon::Daemon;

pub async fn run(d: &Daemon, only: Option<Vec<CheckId>>) -> Vec<CheckResult> {
    let ids: Vec<CheckId> = only
        .unwrap_or_else(|| CheckId::SERVICE_CHECKS.to_vec())
        .into_iter()
        .filter(|c| *c != CheckId::Authentication) // the app's check
        .collect();
    let mut out = Vec::with_capacity(ids.len());
    for id in ids {
        let started = Instant::now();
        let (status, finding, evidence) = match id {
            CheckId::Internet => internet(d).await,
            CheckId::Dns => dns(d).await,
            CheckId::Service => service(d),
            CheckId::ServerReachability => server_reachability(d).await,
            CheckId::Tunnel => tunnel(d).await,
            CheckId::Routing => routing(d),
            CheckId::KillSwitch => kill_switch(d).await,
            CheckId::Ipv6 => ipv6(d),
            CheckId::Authentication => unreachable!(),
        };
        out.push(CheckResult {
            id,
            status,
            finding: finding.into(),
            evidence: match evidence {
                Value::Object(m) => m,
                _ => Map::new(),
            },
            duration_ms: started.elapsed().as_millis() as u64,
        });
    }
    out
}

type Outcome = (CheckStatus, &'static str, Value);

async fn internet(d: &Daemon) -> Outcome {
    let net = d.platform.network.current();
    if !net.online {
        return (CheckStatus::Failed, "no_network", json!({ "networks": net.networks.len() }));
    }
    let primary = net.primary.as_ref().map(|p| p.interface_name.clone());
    match d.api.health().await {
        Ok(rtt) => (CheckStatus::Working, "online", json!({ "primary": primary, "apiRttMs": rtt.as_millis() as u64 })),
        Err(e) if d.state.borrow().is_blocking() => {
            (CheckStatus::Warning, "blocked_by_kill_switch", json!({ "primary": primary, "error": e.to_string() }))
        }
        Err(e) => (CheckStatus::Warning, "network_up_service_unreachable", json!({ "primary": primary, "error": e.to_string() })),
    }
}

async fn dns(d: &Daemon) -> Outcome {
    let results = d.test_dns(None).await;
    if results.is_empty() {
        return (CheckStatus::Failed, "no_resolvers", json!({}));
    }
    let ok = results.iter().filter(|r| r.ok).count();
    let evidence = json!({
        "resolvers": results.iter().map(|r| json!({ "outcome": r.outcome, "rttMs": r.rtt_ms })).collect::<Vec<_>>(),
    });
    match ok {
        0 => (CheckStatus::Failed, "resolvers_not_answering", evidence),
        n if n < results.len() => (CheckStatus::Warning, "some_resolvers_failing", evidence),
        _ => (CheckStatus::Working, "resolving", evidence),
    }
}

fn service(d: &Daemon) -> Outcome {
    let caps = d.capabilities();
    let wg = caps.protocols.iter().find(|p| p.protocol == vpn_types::Protocol::WireGuard);
    let evidence = json!({
        "version": caps.service_version,
        "uptimeSec": d.started.elapsed().as_secs(),
        "wireguard": wg.and_then(|w| w.implementation.clone()),
        "killSwitch": caps.kill_switch,
    });
    if !wg.is_some_and(|w| w.availability.is_available()) {
        return (CheckStatus::Failed, "tunnel_driver_missing", evidence);
    }
    if !caps.kill_switch.is_available() {
        return (CheckStatus::Failed, "firewall_unavailable", evidence);
    }
    (CheckStatus::Working, "running", evidence)
}

async fn server_reachability(d: &Daemon) -> Outcome {
    let status = d.relay_status();
    if status.version.is_none() {
        return (CheckStatus::Failed, "no_server_list", json!({ "lastError": status.last_error }));
    }
    // The connected server, else the default target's best few.
    let targets: Vec<(String, IpAddr)> = {
        let r = d.relays.read().expect("relays");
        let list = r.list.as_ref().expect("checked");
        let connected = match &*d.state.borrow() {
            TunnelState::Connected { details } => Some(details.relay.server_id.clone()),
            _ => None,
        };
        match connected.and_then(|id| list.server(&id)) {
            Some(s) => vec![(s.id.clone(), IpAddr::V4(s.ipv4))],
            None => list
                .servers
                .iter()
                .filter(|s| s.accepts_connections())
                .take(3)
                .map(|s| (s.id.clone(), IpAddr::V4(s.ipv4)))
                .collect(),
        }
    };
    let mut reached = Vec::new();
    for (id, ip) in &targets {
        if let Some(rtt) = d.platform.pinger.ping(*ip, Duration::from_secs(2)).await {
            reached.push(json!({ "server": id, "rttMs": rtt.as_millis() as u64 }));
        }
    }
    let evidence = json!({ "tried": targets.len(), "reached": reached, "listStale": status.stale });
    if reached.is_empty() {
        (CheckStatus::Failed, "servers_unreachable", evidence)
    } else if status.stale {
        (CheckStatus::Warning, "server_list_stale", evidence)
    } else {
        (CheckStatus::Working, "reachable", evidence)
    }
}

async fn tunnel(d: &Daemon) -> Outcome {
    let state = d.state.borrow().clone();
    let TunnelState::Connected { details } = state else {
        return (CheckStatus::Skipped, "not_connected", json!({}));
    };
    let stats = *d.stats.borrow();
    let handshake_age = stats
        .and_then(|s| s.last_handshake)
        .map(|h| vpn_types::time::now_millis().saturating_sub(h) / 1000);
    let evidence = json!({ "handshakeAgeSec": handshake_age, "rxBytes": stats.map(|s| s.rx_bytes), "txBytes": stats.map(|s| s.tx_bytes) });
    match handshake_age {
        Some(age) if age <= 180 => (CheckStatus::Working, "handshake_fresh", evidence),
        Some(_) => (CheckStatus::Warning, "handshake_stale", evidence),
        None => {
            let _ = details;
            (CheckStatus::Failed, "no_handshake", evidence)
        }
    }
}

fn routing(d: &Daemon) -> Outcome {
    let state = d.state.borrow().clone();
    let TunnelState::Connected { details } = state else {
        return (CheckStatus::Skipped, "not_connected", json!({}));
    };
    // Where would a packet to a public address go right now?
    let probe = IpAddr::V4(Ipv4Addr::new(1, 1, 1, 1));
    let best = vpn_platform::routing::best_route_luid(probe);
    let evidence = json!({ "tunnelLuid": details.interface.luid, "bestRouteLuid": best });
    match (best, details.interface.luid) {
        (Some(b), Some(t)) if b == t => (CheckStatus::Working, "default_route_via_tunnel", evidence),
        (Some(_), Some(_)) => (CheckStatus::Failed, "default_route_bypasses_tunnel", evidence),
        _ => (CheckStatus::Warning, "route_unknown", evidence),
    }
}

async fn kill_switch(d: &Daemon) -> Outcome {
    let mode = d.settings.read().expect("settings").kill_switch;
    if let Availability::Unavailable(reason) = &d.platform.kill_switch {
        return (CheckStatus::Failed, "firewall_unavailable", json!({ "reason": reason }));
    }
    let summary = d.platform.firewall.summary().await;
    let policy = d.policy.borrow().clone();
    let evidence = json!({
        "mode": mode,
        "policy": summary.policy,
        "filters": summary.filter_count,
        "verified": summary.verified,
        "lastApplyFailed": policy.last_apply_failed,
    });
    if policy.last_apply_failed || !summary.verified {
        return (CheckStatus::Failed, "rules_not_as_expected", evidence);
    }
    match mode {
        KillSwitchMode::Off => (CheckStatus::Warning, "kill_switch_off", evidence),
        _ => (CheckStatus::Working, "active", evidence),
    }
}

fn ipv6(d: &Daemon) -> Outcome {
    let has_v6 = d.platform.network.current().networks.iter().any(|n| n.has_ipv6);
    let state = d.state.borrow().clone();
    let evidence = json!({ "networkHasIpv6": has_v6 });
    match state {
        TunnelState::Connected { details } => {
            let p = details.protections;
            if p.ipv6_tunneled {
                (CheckStatus::Working, "ipv6_tunneled", evidence)
            } else if !has_v6 {
                (CheckStatus::Working, "no_ipv6_on_network", evidence)
            } else if p.ipv6_leak_blocking {
                (CheckStatus::Working, "ipv6_blocked_outside_tunnel", evidence)
            } else {
                (CheckStatus::Warning, "ipv6_may_leak", evidence)
            }
        }
        _ => (CheckStatus::Skipped, "not_connected", evidence),
    }
}
