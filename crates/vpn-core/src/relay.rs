//! Relay list verification.
//!
//! The service only connects to servers from a list signed by the fleet
//! key. That limits what a compromised backend cache, a MITM on the API, or
//! local malware talking to the service's IPC can do: they can't point the
//! tunnel at an attacker's server. Metadata is validated too, because a
//! "server" at 127.0.0.1 or a LAN address could be abused to punch holes in
//! the kill switch.

use base64::{engine::general_purpose::STANDARD, Engine};
use ed25519_dalek::{Signature, VerifyingKey};
use std::collections::HashSet;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};
use vpn_types::{RelayList, SignedRelayList, UnixMillis};

use crate::keys::decode_key;

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum RelayError {
    #[error("relay list signed with unknown key `{0}`")]
    UnknownKey(String),
    #[error("relay list encoding invalid")]
    Encoding,
    #[error("relay list signature invalid")]
    BadSignature,
    #[error("relay list malformed: {0}")]
    Malformed(String),
    #[error("relay list expired")]
    Expired,
    #[error("relay list version {got} is older than the one in use ({have})")]
    Rollback { have: u64, got: u64 },
    #[error("relay list rejected: {0}")]
    Invalid(String),
}

#[derive(Clone)]
pub struct TrustedKey {
    pub id: String,
    pub key: VerifyingKey,
}

impl TrustedKey {
    pub fn from_base64(id: impl Into<String>, public_key_b64: &str) -> Result<Self, RelayError> {
        let bytes = decode_key(public_key_b64).map_err(|_| RelayError::Encoding)?;
        let key = VerifyingKey::from_bytes(&bytes).map_err(|_| RelayError::Encoding)?;
        Ok(Self { id: id.into(), key })
    }
}

#[derive(Clone)]
pub struct RelayVerifier {
    keys: Vec<TrustedKey>,
    /// Development fleets (e.g. a WireGuard container on this machine) live
    /// on private addresses. Production verifiers reject them.
    allow_private_endpoints: bool,
}

impl RelayVerifier {
    pub fn new(keys: Vec<TrustedKey>) -> Self {
        Self { keys, allow_private_endpoints: false }
    }

    pub fn allowing_private_endpoints(mut self) -> Self {
        self.allow_private_endpoints = true;
        self
    }

    /// Verifies signature, freshness, monotonic version and content.
    /// `current_version` is the version already in use, if any.
    pub fn verify(
        &self,
        signed: &SignedRelayList,
        now: UnixMillis,
        current_version: Option<u64>,
    ) -> Result<RelayList, RelayError> {
        let list = self.verify_signature_and_parse(signed)?;
        if list.expires_at <= now {
            return Err(RelayError::Expired);
        }
        if let Some(have) = current_version {
            if list.version < have {
                return Err(RelayError::Rollback { have, got: list.version });
            }
        }
        self.validate(&list)?;
        Ok(list)
    }

    /// For the on-disk cache: signature and content only. An expired cached
    /// list is still useful to render the server list while offline, but
    /// the tunnel refuses to use it (see `Selection`).
    pub fn verify_cached(&self, signed: &SignedRelayList) -> Result<RelayList, RelayError> {
        let list = self.verify_signature_and_parse(signed)?;
        self.validate(&list)?;
        Ok(list)
    }

    fn verify_signature_and_parse(&self, signed: &SignedRelayList) -> Result<RelayList, RelayError> {
        let key = self
            .keys
            .iter()
            .find(|k| k.id == signed.key_id)
            .ok_or_else(|| RelayError::UnknownKey(signed.key_id.clone()))?;
        let payload = STANDARD.decode(&signed.payload).map_err(|_| RelayError::Encoding)?;
        let sig_bytes: [u8; 64] = STANDARD
            .decode(&signed.signature)
            .map_err(|_| RelayError::Encoding)?
            .try_into()
            .map_err(|_| RelayError::Encoding)?;
        key.key
            .verify_strict(&payload, &Signature::from_bytes(&sig_bytes))
            .map_err(|_| RelayError::BadSignature)?;
        // Only now, with authenticated bytes, do we parse.
        serde_json::from_slice(&payload).map_err(|e| RelayError::Malformed(e.to_string()))
    }

    fn validate(&self, list: &RelayList) -> Result<(), RelayError> {
        let invalid = |m: String| Err(RelayError::Invalid(m));
        if list.servers.len() > 20_000 || list.locations.len() > 5_000 {
            return invalid("list too large".into());
        }
        let mut location_ids = HashSet::new();
        for l in &list.locations {
            if !location_ids.insert(l.id.as_str()) {
                return invalid(format!("duplicate location {}", l.id));
            }
            if l.country_code.len() != 2 || !l.country_code.chars().all(|c| c.is_ascii_uppercase()) {
                return invalid(format!("bad country code for {}", l.id));
            }
            if !(-90.0..=90.0).contains(&l.latitude) || !(-180.0..=180.0).contains(&l.longitude) {
                return invalid(format!("bad coordinates for {}", l.id));
            }
        }
        let mut server_ids = HashSet::new();
        for s in &list.servers {
            if !server_ids.insert(s.id.as_str()) {
                return invalid(format!("duplicate server {}", s.id));
            }
            if !is_valid_id(&s.id) || !is_valid_hostname(&s.hostname) {
                return invalid(format!("bad id/hostname for {}", s.id));
            }
            if !location_ids.contains(s.location_id.as_str()) {
                return invalid(format!("server {} references unknown location", s.id));
            }
            if s.load.is_some_and(|l| l > 100) {
                return invalid(format!("load out of range for {}", s.id));
            }
            if !self.endpoint_allowed(IpAddr::V4(s.ipv4)) {
                return invalid(format!("server {} has a non-public IPv4 endpoint", s.id));
            }
            if let Some(v6) = s.ipv6 {
                if !self.endpoint_allowed(IpAddr::V6(v6)) {
                    return invalid(format!("server {} has a non-public IPv6 endpoint", s.id));
                }
            }
            if let Some(wg) = &s.wireguard {
                if decode_key(&wg.public_key).is_err() {
                    return invalid(format!("server {} has a bad WireGuard key", s.id));
                }
                if wg.ports.is_empty() || wg.ports.contains(&0) {
                    return invalid(format!("server {} has bad WireGuard ports", s.id));
                }
                // The gateway is inside the tunnel and must be private.
                if !wg.gateway_ipv4.is_private() && !is_cgnat(wg.gateway_ipv4) {
                    return invalid(format!("server {} has a public tunnel gateway", s.id));
                }
                // A named resolver may be public (reached through the tunnel),
                // but never this machine or a broadcast/multicast address.
                if let Some(dns) = wg.dns_ipv4 {
                    if dns.is_loopback() || dns.is_unspecified() || dns.is_broadcast() || dns.is_multicast() || dns.is_link_local() {
                        return invalid(format!("server {} names an unusable DNS resolver", s.id));
                    }
                }
            }
        }
        Ok(())
    }

    fn endpoint_allowed(&self, ip: IpAddr) -> bool {
        if ip.is_unspecified() || ip.is_multicast() {
            return false;
        }
        self.allow_private_endpoints || is_global(ip)
    }
}

fn is_valid_id(s: &str) -> bool {
    !s.is_empty() && s.len() <= 64 && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

fn is_valid_hostname(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 253
        && s.split('.').all(|label| {
            !label.is_empty()
                && label.len() <= 63
                && label.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
                && !label.starts_with('-')
                && !label.ends_with('-')
        })
}

fn is_cgnat(ip: Ipv4Addr) -> bool {
    let o = ip.octets();
    o[0] == 100 && (64..128).contains(&o[1])
}

/// Stable-Rust approximation of `IpAddr::is_global`.
pub fn is_global(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            !(v4.is_private()
                || v4.is_loopback()
                || v4.is_link_local()
                || v4.is_broadcast()
                || v4.is_documentation()
                || v4.is_unspecified()
                || is_cgnat(v4)
                || v4.octets()[0] == 0
                || v4.octets()[0] >= 240)
        }
        IpAddr::V6(v6) => {
            let seg0 = v6.segments()[0];
            !(v6.is_loopback()
                || v6.is_unspecified()
                || v6.is_multicast()
                || (seg0 & 0xfe00) == 0xfc00 // unique local
                || (seg0 & 0xffc0) == 0xfe80 // link local
                || (seg0 == 0x2001 && v6.segments()[1] == 0x0db8) // documentation
                || v6 == Ipv6Addr::UNSPECIFIED)
        }
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};
    use vpn_types::*;

    pub fn signing_key() -> SigningKey {
        SigningKey::from_bytes(&[7u8; 32])
    }

    pub fn verifier() -> RelayVerifier {
        let vk = signing_key().verifying_key();
        RelayVerifier::new(vec![TrustedKey { id: "fleet-1".into(), key: vk }])
    }

    pub fn sample_list(version: u64, expires_at: u64) -> RelayList {
        RelayList {
            version,
            generated_at: 1_000,
            expires_at,
            locations: vec![Location {
                id: "de-fra".into(),
                country_code: "DE".into(),
                country: "Germany".into(),
                city: "Frankfurt".into(),
                latitude: 50.11,
                longitude: 8.68,
            }],
            servers: vec![Server {
                id: "de-fra-001".into(),
                hostname: "de-fra-001.relays.example.net".into(),
                location_id: "de-fra".into(),
                status: ServerStatus::Online,
                load: Some(40),
                capacity: 500,
                features: vec![ServerFeature::Streaming],
                ipv4: "185.65.134.10".parse().unwrap(),
                ipv6: None,
                wireguard: Some(WireGuardEndpoint {
                    public_key: STANDARD.encode([9u8; 32]),
                    ports: vec![51820],
                    gateway_ipv4: "10.64.0.1".parse().unwrap(),
                    gateway_ipv6: None,
                    dns_ipv4: None,
                }),
                openvpn: None,
                ikev2: None,
                health: None,
            }],
        }
    }

    pub fn sign(list: &RelayList) -> SignedRelayList {
        let bytes = serde_json::to_vec(list).unwrap();
        let sig = signing_key().sign(&bytes);
        SignedRelayList {
            payload: STANDARD.encode(&bytes),
            signature: STANDARD.encode(sig.to_bytes()),
            key_id: "fleet-1".into(),
        }
    }

    #[test]
    fn accepts_valid_list() {
        let list = sample_list(3, 10_000);
        assert_eq!(verifier().verify(&sign(&list), 5_000, Some(2)).unwrap(), list);
    }

    #[test]
    fn rejects_tampered_payload() {
        let mut signed = sign(&sample_list(3, 10_000));
        let mut tampered = sample_list(3, 10_000);
        tampered.servers[0].ipv4 = "203.0.113.66".parse().unwrap();
        signed.payload = STANDARD.encode(serde_json::to_vec(&tampered).unwrap());
        assert_eq!(verifier().verify(&signed, 5_000, None), Err(RelayError::BadSignature));
    }

    #[test]
    fn rejects_unknown_key_and_expired_and_rollback() {
        let mut signed = sign(&sample_list(3, 10_000));
        signed.key_id = "other".into();
        assert!(matches!(verifier().verify(&signed, 0, None), Err(RelayError::UnknownKey(_))));

        let signed = sign(&sample_list(3, 10_000));
        assert_eq!(verifier().verify(&signed, 10_000, None), Err(RelayError::Expired));
        assert_eq!(
            verifier().verify(&signed, 0, Some(4)),
            Err(RelayError::Rollback { have: 4, got: 3 })
        );
    }

    #[test]
    fn rejects_loopback_and_private_endpoints_in_production() {
        for ip in ["127.0.0.1", "192.168.1.10", "10.0.0.2", "100.64.1.1"] {
            let mut list = sample_list(1, 10_000);
            list.servers[0].ipv4 = ip.parse().unwrap();
            assert!(
                matches!(verifier().verify(&sign(&list), 0, None), Err(RelayError::Invalid(_))),
                "{ip}"
            );
        }
        let mut list = sample_list(1, 10_000);
        list.servers[0].ipv4 = "192.168.1.10".parse().unwrap();
        assert!(verifier().allowing_private_endpoints().verify(&sign(&list), 0, None).is_ok());
    }

    #[test]
    fn rejects_bad_metadata() {
        let mut list = sample_list(1, 10_000);
        list.servers[0].location_id = "nowhere".into();
        assert!(verifier().verify(&sign(&list), 0, None).is_err());

        let mut list = sample_list(1, 10_000);
        list.servers[0].hostname = "evil host".into();
        assert!(verifier().verify(&sign(&list), 0, None).is_err());

        let mut list = sample_list(1, 10_000);
        list.servers[0].load = Some(250);
        assert!(verifier().verify(&sign(&list), 0, None).is_err());

        let mut list = sample_list(1, 10_000);
        list.servers[0].wireguard.as_mut().unwrap().gateway_ipv4 = "8.8.8.8".parse().unwrap();
        assert!(verifier().verify(&sign(&list), 0, None).is_err());

        // A public resolver through the tunnel is fine; this machine isn't.
        let mut list = sample_list(1, 10_000);
        list.servers[0].wireguard.as_mut().unwrap().dns_ipv4 = Some("1.1.1.1".parse().unwrap());
        assert!(verifier().verify(&sign(&list), 0, None).is_ok());
        list.servers[0].wireguard.as_mut().unwrap().dns_ipv4 = Some("127.0.0.1".parse().unwrap());
        assert!(verifier().verify(&sign(&list), 0, None).is_err());
    }
}
