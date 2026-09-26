//! Protocol selection ("Automatic") and availability.

use vpn_types::{Protocol, ProtocolPreference, Server};

/// Order "Automatic" tries protocols in. WireGuard is fastest and simplest;
/// OpenVPN over TCP is the fallback for networks that block UDP; IKEv2 is
/// last because some networks filter IPsec too.
pub const AUTOMATIC_ORDER: [Protocol; 3] = [Protocol::WireGuard, Protocol::OpenVpn, Protocol::Ikev2];

/// After this many consecutive handshake timeouts with a UDP protocol,
/// "Automatic" assumes UDP is filtered and moves to the next protocol.
pub const UDP_FAILURES_BEFORE_FALLBACK: u32 = 2;

#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum ProtocolChoiceError {
    /// The fixed protocol isn't in this build / on this machine.
    #[error("protocol not available in this build")]
    NotAvailable,
    /// The server doesn't offer any usable protocol.
    #[error("server offers no usable protocol")]
    NotOnServer,
}

/// Picks the protocol for `server`.
///
/// * `available`: protocols this build can run here.
/// * `udp_failures`: consecutive handshake timeouts in this connect attempt.
pub fn choose(
    preference: ProtocolPreference,
    server: &Server,
    available: &[Protocol],
    udp_failures: u32,
) -> Result<Protocol, ProtocolChoiceError> {
    if let Some(fixed) = preference.fixed() {
        if !available.contains(&fixed) {
            return Err(ProtocolChoiceError::NotAvailable);
        }
        return if server.supports(fixed) { Ok(fixed) } else { Err(ProtocolChoiceError::NotOnServer) };
    }
    let usable: Vec<Protocol> = AUTOMATIC_ORDER
        .into_iter()
        .filter(|p| available.contains(p) && server.supports(*p))
        .collect();
    let first = *usable.first().ok_or(ProtocolChoiceError::NotOnServer)?;
    if udp_failures >= UDP_FAILURES_BEFORE_FALLBACK {
        // Prefer anything that isn't WireGuard (UDP-only); stay on
        // WireGuard if nothing else is usable, rather than fail.
        if let Some(p) = usable.iter().copied().find(|p| *p != Protocol::WireGuard) {
            return Ok(p);
        }
    }
    Ok(first)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::relay::tests::sample_list;
    use vpn_types::OpenVpnEndpoint;

    fn server_with_openvpn() -> Server {
        let mut s = sample_list(1, 10).servers.remove(0);
        s.openvpn = Some(OpenVpnEndpoint { udp_ports: vec![1194], tcp_ports: vec![443], ca_sha256: "x".into() });
        s
    }

    #[test]
    fn automatic_prefers_wireguard() {
        let s = server_with_openvpn();
        let all = [Protocol::WireGuard, Protocol::OpenVpn];
        assert_eq!(choose(ProtocolPreference::Automatic, &s, &all, 0), Ok(Protocol::WireGuard));
    }

    #[test]
    fn automatic_falls_back_when_udp_looks_blocked() {
        let s = server_with_openvpn();
        let all = [Protocol::WireGuard, Protocol::OpenVpn];
        assert_eq!(choose(ProtocolPreference::Automatic, &s, &all, 2), Ok(Protocol::OpenVpn));
        // With only WireGuard in this build, keep trying WireGuard.
        assert_eq!(
            choose(ProtocolPreference::Automatic, &s, &[Protocol::WireGuard], 5),
            Ok(Protocol::WireGuard)
        );
    }

    #[test]
    fn fixed_protocol_must_be_available_and_on_server() {
        let s = sample_list(1, 10).servers.remove(0); // WireGuard only
        assert_eq!(
            choose(ProtocolPreference::OpenVpn, &s, &[Protocol::WireGuard], 0),
            Err(ProtocolChoiceError::NotAvailable)
        );
        assert_eq!(
            choose(ProtocolPreference::OpenVpn, &s, &[Protocol::WireGuard, Protocol::OpenVpn], 0),
            Err(ProtocolChoiceError::NotOnServer)
        );
    }
}
