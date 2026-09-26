//! Cross-language contract: a relay list produced and signed by the real
//! backend (`server/api`, fleet.test.ts with UPDATE_FIXTURES=1) must verify
//! and deserialize here. If the backend's JSON drifts from `vpn_types`, this
//! breaks.

use serde::Deserialize;
use vpn_core::relay::{RelayVerifier, TrustedKey};
use vpn_types::{ServerFeature, ServerStatus, SignedRelayList};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Fixture {
    public_key: String,
    signed: SignedRelayList,
}

fn fixture() -> Fixture {
    serde_json::from_str(include_str!("fixtures/relay_list_from_api.json")).expect("fixture parses")
}

#[test]
fn backend_signed_relay_list_verifies_and_deserializes() {
    let f = fixture();
    let verifier = RelayVerifier::new(vec![TrustedKey::from_base64("fleet-1", &f.public_key).unwrap()]);
    let list = verifier.verify_cached(&f.signed).expect("the backend's list verifies");

    let fra = list.server("de-fra-001").expect("server present");
    assert_eq!(fra.status, ServerStatus::Online);
    assert_eq!(fra.load, Some(30));
    assert_eq!(fra.features, vec![ServerFeature::Streaming, ServerFeature::P2p]);
    assert_eq!(fra.wireguard.as_ref().unwrap().ports, vec![51820, 443]);
    assert!(fra.health.as_ref().unwrap().wireguard_healthy.unwrap());
    assert_eq!(list.location("de-fra").unwrap().city, "Frankfurt");
    assert_eq!(list.server("nl-ams-001").unwrap().status, ServerStatus::Maintenance);
}

#[test]
fn tampering_with_the_backend_list_is_caught() {
    use base64::{engine::general_purpose::STANDARD, Engine};
    let mut f = fixture();
    let mut bytes = STANDARD.decode(&f.signed.payload).unwrap();
    let text = String::from_utf8(bytes.clone()).unwrap().replace("185.65.134.10", "185.65.134.66");
    bytes = text.into_bytes();
    f.signed.payload = STANDARD.encode(bytes);
    let verifier = RelayVerifier::new(vec![TrustedKey::from_base64("fleet-1", &f.public_key).unwrap()]);
    assert!(verifier.verify_cached(&f.signed).is_err());
}
