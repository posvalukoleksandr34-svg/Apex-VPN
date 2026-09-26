//! WireGuard (Curve25519) keys.

use base64::{engine::general_purpose::STANDARD, Engine};
use rand::rngs::OsRng;
use zeroize::{Zeroize, ZeroizeOnDrop};

pub const KEY_LEN: usize = 32;

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum KeyError {
    #[error("key is not valid base64")]
    Base64,
    #[error("key must be 32 bytes")]
    Length,
}

/// A private key. Zeroed on drop; `Debug` never prints the key.
#[derive(Clone, Zeroize, ZeroizeOnDrop)]
pub struct PrivateKey([u8; KEY_LEN]);

impl PrivateKey {
    pub fn generate() -> Self {
        let secret = x25519_dalek::StaticSecret::random_from_rng(OsRng);
        Self(secret.to_bytes())
    }

    pub fn from_bytes(bytes: [u8; KEY_LEN]) -> Self {
        // Clamping happens inside X25519; WireGuard stores keys clamped, so do
        // it here too for byte-identical interop with `wg genkey`.
        let mut b = bytes;
        b[0] &= 248;
        b[31] &= 127;
        b[31] |= 64;
        Self(b)
    }

    pub fn as_bytes(&self) -> &[u8; KEY_LEN] {
        &self.0
    }

    pub fn public_key(&self) -> PublicKey {
        let secret = x25519_dalek::StaticSecret::from(self.0);
        PublicKey(x25519_dalek::PublicKey::from(&secret).to_bytes())
    }
}

impl std::fmt::Debug for PrivateKey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("PrivateKey(<redacted>)")
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Hash)]
pub struct PublicKey([u8; KEY_LEN]);

impl PublicKey {
    pub fn from_bytes(bytes: [u8; KEY_LEN]) -> Self {
        Self(bytes)
    }

    pub fn from_base64(s: &str) -> Result<Self, KeyError> {
        Ok(Self(decode_key(s)?))
    }

    pub fn as_bytes(&self) -> &[u8; KEY_LEN] {
        &self.0
    }

    pub fn to_base64(&self) -> String {
        STANDARD.encode(self.0)
    }
}

impl std::fmt::Debug for PublicKey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "PublicKey({})", self.to_base64())
    }
}

pub fn decode_key(s: &str) -> Result<[u8; KEY_LEN], KeyError> {
    let v = STANDARD.decode(s.trim()).map_err(|_| KeyError::Base64)?;
    v.try_into().map_err(|_| KeyError::Length)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn public_key_matches_rfc7748_vector() {
        // RFC 7748 §6.1, Alice.
        let sk = hex("77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a");
        let pk = hex("8520f0098930a754748b7ddcb43ef75a0dbf3a0d26381af4eba4a98eaa9b4e6a");
        assert_eq!(PrivateKey::from_bytes(sk).public_key().as_bytes(), &pk);
    }

    #[test]
    fn generated_keys_differ_and_roundtrip() {
        let a = PrivateKey::generate();
        let b = PrivateKey::generate();
        assert_ne!(a.as_bytes(), b.as_bytes());
        let pk = a.public_key();
        assert_eq!(PublicKey::from_base64(&pk.to_base64()).unwrap(), pk);
    }

    #[test]
    fn debug_never_prints_private_key() {
        let k = PrivateKey::generate();
        assert_eq!(format!("{k:?}"), "PrivateKey(<redacted>)");
    }

    #[test]
    fn rejects_bad_keys() {
        assert_eq!(PublicKey::from_base64("!!!"), Err(KeyError::Base64));
        assert_eq!(PublicKey::from_base64("AAAA"), Err(KeyError::Length));
    }

    fn hex(s: &str) -> [u8; 32] {
        let mut out = [0u8; 32];
        for i in 0..32 {
            out[i] = u8::from_str_radix(&s[i * 2..i * 2 + 2], 16).unwrap();
        }
        out
    }
}
