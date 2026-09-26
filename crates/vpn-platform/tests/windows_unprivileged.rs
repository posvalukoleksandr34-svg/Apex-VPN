//! Real Windows API checks that don't need administrator rights. The
//! privileged ones (adapter, WFP) live in `windows_privileged.rs` and are
//! `#[ignore]`d unless run elevated.
#![cfg(windows)]

use std::path::PathBuf;
use std::time::Duration;

fn vendor_dll_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../vendor/wireguard-nt/bin/amd64")
}

#[test]
fn vendored_wireguard_dll_is_signed_by_wireguard_llc() {
    let dll = vendor_dll_dir().join("wireguard.dll");
    vpn_platform::windows::trust::verify_signer(&dll, "WireGuard LLC").expect("signature");
}

#[test]
fn signature_check_rejects_wrong_signer_and_unsigned_files() {
    let dll = vendor_dll_dir().join("wireguard.dll");
    assert!(vpn_platform::windows::trust::verify_signer(&dll, "Someone Else").is_err());
    // A test binary is unsigned.
    let me = std::env::current_exe().unwrap();
    assert!(vpn_platform::windows::trust::verify_signer(&me, "WireGuard LLC").is_err());
}

#[test]
fn wireguard_dll_loads_and_exports_the_api() {
    let nt = vpn_platform::windows::wireguard_nt::WireGuardNt::load(&vendor_dll_dir(), true).expect("load");
    // No adapter yet, so no running driver version is fine either way.
    let _ = nt.driver_version();
}

#[test]
fn network_snapshot_describes_this_machine() {
    let (snap, _) = vpn_platform::windows::netmon::build_snapshot();
    // CI machines and laptops alike have at least one network when online.
    if snap.online {
        let primary = snap.primary.clone().expect("primary when online");
        assert!(primary.has_ipv4 || primary.has_ipv6);
        println!("primary: {} ({:?})", primary.interface_name, primary.medium);
        assert!(snap.networks.iter().all(|n| n.interface_name != "Meridian"));
    }
    println!("{snap:#?}");
}

#[test]
fn icmp_echo_to_loopback() {
    let rtt = vpn_platform::windows::icmp::echo(None, "127.0.0.1".parse().unwrap(), Duration::from_secs(1))
        .expect("loopback answers");
    assert!(rtt < Duration::from_millis(100));
}

#[test]
fn dpapi_roundtrip() {
    use vpn_platform::SecretStore;
    let store = vpn_platform::windows::keystore::DpapiStore;
    let sealed = store.seal(b"secret key bytes").unwrap();
    assert_ne!(&sealed[..], b"secret key bytes");
    assert_eq!(&store.open(&sealed).unwrap()[..], b"secret key bytes");
    let mut tampered = sealed.clone();
    let last = tampered.len() - 1;
    tampered[last] ^= 0xff;
    assert!(store.open(&tampered).is_err());
}

#[test]
fn installed_apps_are_real_executables() {
    for app in vpn_platform::apps::installed().iter().take(20) {
        assert!(std::path::Path::new(&app.path).is_file(), "{app:?}");
    }
}

#[tokio::test]
async fn dns_probe_reports_timeouts_honestly() {
    // TEST-NET-1 never answers.
    let r = vpn_platform::dns_probe::query_a("192.0.2.1".parse().unwrap(), "example.com", Duration::from_millis(300)).await;
    assert!(!r.ok);
    assert_eq!(r.outcome, "timeout");
    assert_eq!(r.rtt_ms, None);
}
