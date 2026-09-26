//! Auto-connect and trusted-network decisions.
//!
//! Decisions are only made when the *primary network changes* (joining a
//! different Wi-Fi, plugging in a cable). That means a user who manually
//! disconnects on an untrusted network isn't immediately reconnected: the
//! rule applies again on the next network change.

use vpn_types::{
    KillSwitchMode, NetworkSnapshot, PhysicalNetwork, Settings, TrustedNetwork,
    TrustedNetworkPolicy, WifiSecurity,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AutoAction {
    Connect,
    Disconnect,
    Nothing,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Reason {
    TrustedRequiresVpn,
    TrustedBypass,
    UntrustedNetwork,
    OpenWifi,
}

pub fn on_network_change(
    previous: Option<&NetworkSnapshot>,
    next: &NetworkSnapshot,
    settings: &Settings,
    wants_tunnel: bool,
) -> (AutoAction, Option<Reason>) {
    let Some(primary) = next.primary.as_ref().filter(|_| next.online) else {
        return (AutoAction::Nothing, None);
    };
    let changed = previous
        .and_then(|p| p.primary.as_ref().filter(|_| p.online))
        .is_none_or(|prev| identity(prev) != identity(primary));
    if !changed {
        return (AutoAction::Nothing, None);
    }

    let rule = matching_rule(&settings.trusted_networks, primary);
    let open_wifi = primary.wifi_security == Some(WifiSecurity::Open);
    let connect = |reason| {
        if wants_tunnel { (AutoAction::Nothing, None) } else { (AutoAction::Connect, Some(reason)) }
    };

    match rule.map(|r| r.policy) {
        Some(TrustedNetworkPolicy::RequireVpn) => connect(Reason::TrustedRequiresVpn),
        _ if open_wifi && settings.auto_connect.on_open_wifi => connect(Reason::OpenWifi),
        Some(TrustedNetworkPolicy::Bypass) => {
            // Bypass never overrides an Always-On kill switch: the user asked
            // for traffic to never leave unprotected.
            if wants_tunnel && settings.kill_switch != KillSwitchMode::AlwaysOn {
                (AutoAction::Disconnect, Some(Reason::TrustedBypass))
            } else {
                (AutoAction::Nothing, None)
            }
        }
        Some(TrustedNetworkPolicy::Optional) => (AutoAction::Nothing, None),
        None if settings.auto_connect.on_untrusted_network => connect(Reason::UntrustedNetwork),
        None => (AutoAction::Nothing, None),
    }
}

fn identity(n: &PhysicalNetwork) -> (&str, Option<&str>) {
    (n.id.as_str(), n.ssid.as_deref())
}

fn matching_rule<'a>(rules: &'a [TrustedNetwork], n: &PhysicalNetwork) -> Option<&'a TrustedNetwork> {
    match &n.ssid {
        Some(ssid) => rules.iter().find(|r| r.ssid.as_deref() == Some(ssid.as_str())),
        // Wired networks are matched by interface identity.
        None => rules.iter().find(|r| r.ssid.is_none() && r.id == n.id),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use vpn_types::*;

    fn wifi(ssid: &str, security: WifiSecurity) -> NetworkSnapshot {
        NetworkSnapshot {
            online: true,
            primary: Some(PhysicalNetwork {
                id: "wlan0".into(),
                interface_name: "Wi-Fi".into(),
                medium: NetworkMedium::Wifi,
                ssid: Some(ssid.into()),
                wifi_security: Some(security),
                has_ipv4: true,
                has_ipv6: false,
                dns_servers: vec![],
                gateway: None,
            }),
            networks: vec![],
            observed_at: 0,
        }
    }

    fn rule(ssid: &str, policy: TrustedNetworkPolicy) -> TrustedNetwork {
        TrustedNetwork {
            id: ssid.into(),
            name: ssid.into(),
            ssid: Some(ssid.into()),
            policy,
            kind: NetworkKind::Home,
        }
    }

    #[test]
    fn untrusted_network_connects_when_enabled() {
        let mut s = Settings::default();
        let n = wifi("Cafe", WifiSecurity::Protected);
        assert_eq!(on_network_change(None, &n, &s, false).0, AutoAction::Nothing);
        s.auto_connect.on_untrusted_network = true;
        assert_eq!(on_network_change(None, &n, &s, false), (AutoAction::Connect, Some(Reason::UntrustedNetwork)));
        assert_eq!(on_network_change(None, &n, &s, true).0, AutoAction::Nothing, "already connected");
    }

    #[test]
    fn open_wifi_connects_even_when_listed_optional() {
        let mut s = Settings::default();
        s.trusted_networks.push(rule("Airport", TrustedNetworkPolicy::Optional));
        let n = wifi("Airport", WifiSecurity::Open);
        assert_eq!(on_network_change(None, &n, &s, false), (AutoAction::Connect, Some(Reason::OpenWifi)));
    }

    #[test]
    fn bypass_disconnects_but_never_with_always_on() {
        let mut s = Settings::default();
        s.trusted_networks.push(rule("Home", TrustedNetworkPolicy::Bypass));
        let n = wifi("Home", WifiSecurity::Protected);
        assert_eq!(on_network_change(None, &n, &s, true).0, AutoAction::Disconnect);
        s.kill_switch = KillSwitchMode::AlwaysOn;
        assert_eq!(on_network_change(None, &n, &s, true).0, AutoAction::Nothing);
    }

    #[test]
    fn require_vpn_connects() {
        let mut s = Settings::default();
        s.trusted_networks.push(rule("Office", TrustedNetworkPolicy::RequireVpn));
        let n = wifi("Office", WifiSecurity::Protected);
        assert_eq!(on_network_change(None, &n, &s, false).0, AutoAction::Connect);
    }

    #[test]
    fn no_decision_without_a_network_change() {
        let mut s = Settings::default();
        s.auto_connect.on_untrusted_network = true;
        let n = wifi("Cafe", WifiSecurity::Protected);
        assert_eq!(on_network_change(Some(&n), &n, &s, false).0, AutoAction::Nothing);
        let other = wifi("Library", WifiSecurity::Protected);
        assert_eq!(on_network_change(Some(&n), &other, &s, false).0, AutoAction::Connect);
    }

    #[test]
    fn offline_does_nothing() {
        let s = Settings::default();
        let mut n = wifi("Cafe", WifiSecurity::Open);
        n.online = false;
        assert_eq!(on_network_change(None, &n, &s, false).0, AutoAction::Nothing);
    }
}
