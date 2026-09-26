//! Settings validation, patching, migration and change impact.

use std::collections::HashSet;
use std::net::IpAddr;
use vpn_types::{DnsMode, Settings, SettingsPatch, MTU_MAX, MTU_MIN, SETTINGS_SCHEMA_VERSION};

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum SettingsError {
    #[error("{field}: {reason}")]
    Invalid { field: &'static str, reason: String },
    #[error("settings are from a newer version ({0}) of the service")]
    FromNewerVersion(u32),
    #[error("settings could not be parsed: {0}")]
    Unparseable(String),
}

fn invalid(field: &'static str, reason: impl Into<String>) -> SettingsError {
    SettingsError::Invalid { field, reason: reason.into() }
}

pub fn validate(s: &Settings) -> Result<(), SettingsError> {
    if let Some(mtu) = s.network.mtu {
        if !(MTU_MIN..=MTU_MAX).contains(&mtu) {
            return Err(invalid("network.mtu", format!("must be between {MTU_MIN} and {MTU_MAX}")));
        }
    }
    if s.network.persistent_keepalive > 600 {
        return Err(invalid("network.persistentKeepalive", "must be 0–600 seconds"));
    }
    let r = &s.network.reconnect;
    if r.max_attempts > 1000 {
        return Err(invalid("network.reconnect.maxAttempts", "must be 0–1000"));
    }
    if !(1..=20).contains(&r.switch_server_after) {
        return Err(invalid("network.reconnect.switchServerAfter", "must be 1–20"));
    }

    if s.dns.custom_servers.len() > 4 {
        return Err(invalid("dns.customServers", "at most 4 servers"));
    }
    if s.dns.mode == DnsMode::Custom && s.dns.custom_servers.is_empty() {
        return Err(invalid("dns.customServers", "custom DNS needs at least one server"));
    }
    for ip in &s.dns.custom_servers {
        if !usable_resolver(*ip) {
            return Err(invalid("dns.customServers", format!("{ip} can't be used as a resolver")));
        }
    }

    if s.split_tunnel.apps.len() > 256 {
        return Err(invalid("splitTunnel.apps", "at most 256 apps"));
    }
    for app in &s.split_tunnel.apps {
        if app.path.len() > 1024 || !is_absolute_path(&app.path) {
            return Err(invalid("splitTunnel.apps", "paths must be absolute"));
        }
        if app.name.chars().count() > 128 {
            return Err(invalid("splitTunnel.apps", "name too long"));
        }
    }

    if s.trusted_networks.len() > 100 {
        return Err(invalid("trustedNetworks", "at most 100 networks"));
    }
    let mut ids = HashSet::new();
    for n in &s.trusted_networks {
        if !ids.insert(&n.id) {
            return Err(invalid("trustedNetworks", "duplicate id"));
        }
        let len = n.name.chars().count();
        if len == 0 || len > 64 {
            return Err(invalid("trustedNetworks.name", "1–64 characters"));
        }
        if n.ssid.as_ref().is_some_and(|ssid| ssid.is_empty() || ssid.len() > 32) {
            return Err(invalid("trustedNetworks.ssid", "SSIDs are 1–32 bytes"));
        }
    }
    Ok(())
}

fn usable_resolver(ip: IpAddr) -> bool {
    !(ip.is_unspecified() || ip.is_multicast() || ip.is_loopback())
}

fn is_absolute_path(p: &str) -> bool {
    let b = p.as_bytes();
    // `C:\...`, `\\server\share\...`, or `/...`
    (b.len() > 2 && b[0].is_ascii_alphabetic() && b[1] == b':' && (b[2] == b'\\' || b[2] == b'/'))
        || p.starts_with(r"\\")
        || p.starts_with('/')
}

/// Applies a patch and validates the result. The current settings are left
/// untouched on error.
pub fn apply_patch(current: &Settings, patch: SettingsPatch) -> Result<Settings, SettingsError> {
    let mut next = current.clone();
    let SettingsPatch {
        protocol,
        kill_switch,
        allow_lan,
        dns,
        network,
        split_tunnel,
        auto_connect,
        trusted_networks,
        default_target,
        logging,
    } = patch;
    if let Some(v) = protocol {
        next.protocol = v;
    }
    if let Some(v) = kill_switch {
        next.kill_switch = v;
    }
    if let Some(v) = allow_lan {
        next.allow_lan = v;
    }
    if let Some(v) = dns {
        next.dns = v;
    }
    if let Some(v) = network {
        next.network = v;
    }
    if let Some(v) = split_tunnel {
        next.split_tunnel = v;
    }
    if let Some(v) = auto_connect {
        next.auto_connect = v;
    }
    if let Some(v) = trusted_networks {
        next.trusted_networks = v;
    }
    if let Some(v) = default_target {
        next.default_target = v;
    }
    if let Some(v) = logging {
        next.logging = v;
    }
    validate(&next)?;
    Ok(next)
}

/// Loads settings from stored JSON, upgrading older schemas. Unknown fields
/// are ignored and missing ones take their defaults, so a newer app build
/// can add settings without breaking older files.
pub fn load(json: &[u8]) -> Result<Settings, SettingsError> {
    let value: serde_json::Value =
        serde_json::from_slice(json).map_err(|e| SettingsError::Unparseable(e.to_string()))?;
    let version = value.get("schemaVersion").and_then(|v| v.as_u64()).unwrap_or(1) as u32;
    if version > SETTINGS_SCHEMA_VERSION {
        return Err(SettingsError::FromNewerVersion(version));
    }
    // Future migrations: `if version < 2 { value = v1_to_v2(value) }` …
    let mut settings: Settings =
        serde_json::from_value(value).map_err(|e| SettingsError::Unparseable(e.to_string()))?;
    settings.schema_version = SETTINGS_SCHEMA_VERSION;
    validate(&settings)?;
    Ok(settings)
}

/// How a settings change affects a live tunnel.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum ChangeImpact {
    None,
    /// Firewall rules must be recomputed (kill switch, LAN, leak options).
    Firewall,
    /// The tunnel must be rebuilt (protocol, DNS, MTU, IPv6, split tunnel).
    Reconnect,
}

pub fn impact(old: &Settings, new: &Settings) -> ChangeImpact {
    if old.protocol != new.protocol
        || old.dns.mode != new.dns.mode
        || old.dns.custom_servers != new.dns.custom_servers
        || old.network.mtu != new.network.mtu
        || old.network.enable_ipv6 != new.network.enable_ipv6
        || old.network.persistent_keepalive != new.network.persistent_keepalive
        || old.split_tunnel != new.split_tunnel
    {
        ChangeImpact::Reconnect
    } else if old.kill_switch != new.kill_switch
        || old.allow_lan != new.allow_lan
        || old.dns.block_leaks != new.dns.block_leaks
        || old.network.block_ipv6_leaks != new.network.block_ipv6_leaks
    {
        ChangeImpact::Firewall
    } else {
        ChangeImpact::None
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use vpn_types::*;

    #[test]
    fn defaults_are_valid_and_secure() {
        let s = Settings::default();
        validate(&s).unwrap();
        assert_eq!(s.kill_switch, KillSwitchMode::WhileConnected);
        assert!(s.dns.block_leaks);
        assert!(s.network.block_ipv6_leaks);
    }

    #[test]
    fn rejects_bad_values() {
        let mut s = Settings::default();
        s.network.mtu = Some(9000);
        assert!(validate(&s).is_err());

        let mut s = Settings::default();
        s.dns.mode = DnsMode::Custom;
        assert!(validate(&s).is_err(), "custom DNS without servers");
        s.dns.custom_servers = vec!["127.0.0.1".parse().unwrap()];
        assert!(validate(&s).is_err(), "loopback resolver");
        s.dns.custom_servers = vec!["9.9.9.9".parse().unwrap()];
        validate(&s).unwrap();

        let mut s = Settings::default();
        s.split_tunnel.apps.push(SplitTunnelApp { path: "relative.exe".into(), name: "x".into(), enabled: true });
        assert!(validate(&s).is_err());
    }

    #[test]
    fn patch_is_atomic() {
        let s = Settings::default();
        let bad = SettingsPatch {
            kill_switch: Some(KillSwitchMode::AlwaysOn),
            network: Some(NetworkSettings { mtu: Some(100), ..NetworkSettings::default() }),
            ..Default::default()
        };
        assert!(apply_patch(&s, bad).is_err());

        let good = SettingsPatch { kill_switch: Some(KillSwitchMode::AlwaysOn), ..Default::default() };
        let next = apply_patch(&s, good).unwrap();
        assert_eq!(next.kill_switch, KillSwitchMode::AlwaysOn);
        assert_eq!(next.dns, s.dns);
    }

    #[test]
    fn load_fills_defaults_and_rejects_future_versions() {
        let s = load(br#"{"schemaVersion":1,"killSwitch":"always_on","someFutureField":1}"#).unwrap();
        assert_eq!(s.kill_switch, KillSwitchMode::AlwaysOn);
        assert_eq!(s.dns, DnsSettings::default());
        assert_eq!(load(br#"{"schemaVersion":99}"#), Err(SettingsError::FromNewerVersion(99)));
        assert!(matches!(load(b"{not json"), Err(SettingsError::Unparseable(_))));
    }

    #[test]
    fn change_impact() {
        let a = Settings::default();
        let mut b = a.clone();
        b.kill_switch = KillSwitchMode::AlwaysOn;
        assert_eq!(impact(&a, &b), ChangeImpact::Firewall);
        b.network.mtu = Some(1380);
        assert_eq!(impact(&a, &b), ChangeImpact::Reconnect);
        let mut c = a.clone();
        c.logging.level = LogLevel::Debug;
        assert_eq!(impact(&a, &c), ChangeImpact::None);
    }
}
