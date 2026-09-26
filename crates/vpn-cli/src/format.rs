//! Human-readable output. The wording mirrors the desktop app's status
//! model, so both describe a state the same way.

use std::collections::HashMap;

use vpn_types::ipc::{ConnectionReport, IpObservations};
use vpn_types::time::now_millis;
use vpn_types::*;

pub fn state(s: &TunnelState) -> String {
    match s {
        TunnelState::Disconnected { locked_down: false } => "○ Unprotected — not connected".into(),
        TunnelState::Disconnected { locked_down: true } => {
            "■ Blocked — the always-on kill switch blocks all traffic until you connect".into()
        }
        TunnelState::Connecting { relay, phase, attempt, last_error, retry_at, blocking, .. } => {
            let mut line = format!("◌ Connecting{} — {}", on(relay), phase_text(*phase));
            if *attempt > 1 {
                line.push_str(&format!(" (attempt {attempt})"));
            }
            if let (Some(e), Some(at)) = (last_error, retry_at) {
                line.push_str(&format!("; last attempt: {}; retrying in {}s", e.code(), at.saturating_sub(now_millis()) / 1000));
            }
            if *blocking {
                line.push_str(" [traffic blocked]");
            }
            line
        }
        TunnelState::Connected { details } => {
            let d = details;
            format!(
                "● Protected — {} ({}, {}) via {:?}\n  VPN address {}  ·  DNS {}  ·  kill switch {}  ·  since {}",
                d.relay.hostname,
                d.relay.city,
                d.relay.country,
                d.relay.protocol,
                d.tunnel_ipv4.map(|i| i.to_string()).unwrap_or_else(|| "—".into()),
                d.dns_servers.iter().map(|s| s.to_string()).collect::<Vec<_>>().join(", "),
                if d.protections.kill_switch { "on" } else { "off" },
                duration(now_millis().saturating_sub(d.connected_at)),
            )
        }
        TunnelState::Reconnecting { relay, cause, phase, .. } => {
            format!("◌ Reconnecting{} — {} ({})", on(relay), cause_text(*cause), phase_text(*phase))
        }
        TunnelState::WaitingForNetwork { blocking, .. } => format!(
            "◌ No internet connection — will reconnect when it returns{}",
            if *blocking { " [traffic blocked]" } else { "" }
        ),
        TunnelState::Disconnecting { .. } => "◌ Disconnecting…".into(),
        TunnelState::Error { error, blocking } => format!(
            "✕ Error: {}{}{}",
            error.kind,
            error.detail.as_ref().map(|d| format!(" — {d}")).unwrap_or_default(),
            if *blocking { "\n  Traffic is blocked to protect you. Retry with `meridian reconnect`, or `meridian disconnect` to unblock." } else { "" }
        ),
    }
}

fn on(relay: &Option<RelaySummary>) -> String {
    relay.as_ref().map(|r| format!(" to {} ({})", r.hostname, r.city)).unwrap_or_default()
}

fn phase_text(p: ConnectPhase) -> &'static str {
    match p {
        ConnectPhase::WaitingToRetry => "waiting to retry",
        ConnectPhase::SelectingServer => "choosing a server",
        ConnectPhase::CreatingInterface => "creating the tunnel",
        ConnectPhase::ConfiguringNetwork => "configuring the network",
        ConnectPhase::Handshaking => "handshaking with the server",
        ConnectPhase::VerifyingTunnel => "verifying traffic flows",
        ConnectPhase::CheckingTunnel => "checking the tunnel",
    }
}

fn cause_text(c: ReconnectCause) -> &'static str {
    match c {
        ReconnectCause::NetworkChanged => "network changed",
        ReconnectCause::NetworkRestored => "network restored",
        ReconnectCause::WokeFromSleep => "woke from sleep",
        ReconnectCause::HandshakeStale => "server stopped responding",
        ReconnectCause::ServerUnavailable => "server unavailable",
        ReconnectCause::TunnelFailure => "connection lost",
        ReconnectCause::SettingsChanged => "settings changed",
        ReconnectCause::UserRequested => "requested",
    }
}

pub fn duration(ms: u64) -> String {
    let s = ms / 1000;
    match (s / 3600, (s % 3600) / 60, s % 60) {
        (0, 0, s) => format!("{s}s"),
        (0, m, s) => format!("{m}m {s:02}s"),
        (h, m, _) => format!("{h}h {m:02}m"),
    }
}

pub fn servers(list: &RelayList, latencies: &[LatencySample], country: Option<&str>) -> String {
    let lat: HashMap<&str, &LatencySample> = latencies.iter().map(|l| (l.server_id.as_str(), l)).collect();
    let mut rows = Vec::new();
    for s in &list.servers {
        let Some(loc) = list.location(&s.location_id) else { continue };
        if country.is_some_and(|c| !loc.country_code.eq_ignore_ascii_case(c)) {
            continue;
        }
        rows.push(format!(
            "{:<16} {:<3} {:<16} {:>7} {:>5}  {:<11} {}",
            s.id,
            loc.country_code,
            loc.city,
            lat.get(s.id.as_str()).and_then(|l| l.rtt_ms).map(|r| format!("{r} ms")).unwrap_or_else(|| "—".into()),
            s.load.map(|l| format!("{l}%")).unwrap_or_else(|| "—".into()),
            format!("{:?}", s.status).to_lowercase(),
            s.features.iter().map(|f| format!("{f:?}").to_lowercase()).collect::<Vec<_>>().join(",")
        ));
    }
    format!(
        "{:<16} {:<3} {:<16} {:>7} {:>5}  {:<11} {}\n{}\n(server list v{}, {} servers; latency \"—\" = not measured)",
        "ID", "CC", "CITY", "PING", "LOAD", "STATUS", "FEATURES",
        rows.join("\n"),
        list.version,
        list.servers.len()
    )
}

pub fn checks(checks: &[CheckResult]) -> String {
    checks
        .iter()
        .map(|c| {
            let mark = match c.status {
                CheckStatus::Working => "✓",
                CheckStatus::Warning => "⚠",
                CheckStatus::Failed => "✕",
                CheckStatus::Skipped => "–",
            };
            format!("{mark} {:<20} {:<32} {}", format!("{:?}", c.id), c.finding, serde_json::Value::Object(c.evidence.clone()))
        })
        .collect::<Vec<_>>()
        .join("\n")
}

pub fn leaks(results: &[LeakTestResult]) -> String {
    results
        .iter()
        .map(|r| {
            let verdict = match r.verdict {
                LeakVerdict::Protected => "Protected",
                LeakVerdict::PotentialLeak => "Potential leak",
                LeakVerdict::UnableToVerify => "Unable to verify",
            };
            format!("{:<6} {:<17} {}", format!("{:?}", r.test).to_uppercase(), verdict, r.finding)
        })
        .collect::<Vec<_>>()
        .join("\n")
}

pub fn ip(obs: &IpObservation, all: &IpObservations) -> String {
    let place = [obs.city.as_deref(), obs.country.as_deref()].into_iter().flatten().collect::<Vec<_>>().join(", ");
    let mut s = format!(
        "{} {}{}",
        obs.ip,
        if obs.via_tunnel { "(through the VPN)" } else { "(not through the VPN)" },
        if place.is_empty() { String::new() } else { format!(" — {place}") }
    );
    if let Some(org) = &obs.organization {
        s.push_str(&format!("\n  network: {org}{}", obs.asn.map(|a| format!(" (AS{a})")).unwrap_or_default()));
    }
    if let (true, Some(u)) = (obs.via_tunnel, &all.unprotected) {
        s.push_str(&format!("\n  your own address when last unprotected: {}", u.ip));
    }
    s
}

pub fn log(e: &LogEntry) -> String {
    format!("{:>6} {:<5} {:<24} {}", e.seq, format!("{:?}", e.level).to_uppercase(), e.event, e.message)
}

pub fn details(r: &ConnectionReport) -> String {
    let TunnelState::Connected { details: d } = &r.state else {
        return format!("{}\n(no active tunnel)", state(&r.state));
    };
    let stats = r.stats.map(|s| format!("↓ {} B  ↑ {} B", s.rx_bytes, s.tx_bytes)).unwrap_or_default();
    format!(
        "Protocol        {:?} ({} / {} / {})\nServer          {} — {}\nEndpoint        {}\nInterface       {} (index {:?})\nVPN address     {}{}\nDNS (applied)   {}\nDNS (reported)  {}\nMTU             {}\nTraffic         {}\nLast handshake  {}\nFirewall        {} ({} filters, {})\nRoutes          {}",
        d.relay.protocol,
        d.cipher.handshake,
        d.cipher.data,
        d.cipher.key_exchange,
        d.relay.hostname,
        d.relay.city,
        d.endpoint,
        d.interface.name,
        d.interface.index,
        d.tunnel_ipv4.map(|i| i.to_string()).unwrap_or_default(),
        d.tunnel_ipv6.map(|i| format!(", {i}")).unwrap_or_default(),
        d.dns_servers.iter().map(|s| s.to_string()).collect::<Vec<_>>().join(", "),
        r.effective_dns.iter().map(|s| s.to_string()).collect::<Vec<_>>().join(", "),
        d.mtu,
        stats,
        d.last_handshake.map(|h| format!("{} ago", duration(now_millis().saturating_sub(h)))).unwrap_or_else(|| "never".into()),
        r.firewall.policy,
        r.firewall.filter_count,
        if r.firewall.verified { "verified" } else { "NOT verified" },
        r.routes.iter().map(|x| x.destination.clone()).collect::<Vec<_>>().join(", "),
    )
}
