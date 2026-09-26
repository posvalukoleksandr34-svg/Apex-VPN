//! DNS on the tunnel interface via `SetInterfaceDnsSettings` (Windows 10
//! 2004+). Leak prevention is the firewall's job (it drops port 53 to
//! anything but these servers); this makes Windows *use* them.

use std::net::IpAddr;
use std::sync::Mutex;

use async_trait::async_trait;
use vpn_core::{DnsConfigurator, PlatformError, PlatformResult};
use vpn_types::{ErrorKind, InterfaceInfo};
use windows_sys::core::GUID;
use windows_sys::Win32::NetworkManagement::IpHelper::{
    ConvertInterfaceLuidToGuid, FreeInterfaceDnsSettings, GetInterfaceDnsSettings, SetInterfaceDnsSettings,
    DNS_INTERFACE_SETTINGS, DNS_INTERFACE_SETTINGS_VERSION1, DNS_SETTING_IPV6, DNS_SETTING_NAMESERVER,
};
use windows_sys::Win32::NetworkManagement::Ndis::NET_LUID_LH;
use windows_sys::Win32::System::LibraryLoader::{GetProcAddress, LoadLibraryExW, LOAD_LIBRARY_SEARCH_SYSTEM32};

use super::util::{from_wide, platform_error, wide};

pub struct WindowsDns {
    configured: Mutex<Option<GUID>>,
}

impl WindowsDns {
    pub fn new() -> Self {
        Self { configured: Mutex::new(None) }
    }
}

#[async_trait]
impl DnsConfigurator for WindowsDns {
    async fn apply(&self, tunnel: &InterfaceInfo, servers: &[IpAddr]) -> PlatformResult<()> {
        if crate::os::windows_build().is_some_and(|b| b < 19041) {
            return Err(PlatformError::new(ErrorKind::UnsupportedPlatform, "per-interface DNS needs Windows 10 version 2004 or later"));
        }
        let guid = interface_guid(tunnel)?;
        let (v4, v6): (Vec<IpAddr>, Vec<IpAddr>) = servers.iter().partition(|s| s.is_ipv4());
        set_servers(guid, &v4, false)?;
        if !v6.is_empty() {
            set_servers(guid, &v6, true)?;
        }
        *self.configured.lock().expect("dns state") = Some(guid);
        flush_resolver_cache();
        Ok(())
    }

    async fn reset(&self) -> PlatformResult<()> {
        if let Some(guid) = self.configured.lock().expect("dns state").take() {
            // The adapter usually no longer exists (its settings went with
            // it), so failures here are expected and harmless.
            let _ = set_servers(guid, &[], false);
            let _ = set_servers(guid, &[], true);
        }
        flush_resolver_cache();
        Ok(())
    }

    async fn effective(&self, tunnel: &InterfaceInfo) -> Vec<IpAddr> {
        let Ok(guid) = interface_guid(tunnel) else { return Vec::new() };
        let mut out = read_servers(guid, false);
        out.extend(read_servers(guid, true));
        out
    }
}

fn interface_guid(tunnel: &InterfaceInfo) -> PlatformResult<GUID> {
    let luid = tunnel.luid.ok_or_else(|| PlatformError::new(ErrorKind::DnsFailure, "tunnel interface has no LUID"))?;
    let mut guid: GUID = unsafe { std::mem::zeroed() };
    let rc = unsafe { ConvertInterfaceLuidToGuid(&NET_LUID_LH { Value: luid }, &mut guid) };
    if rc != 0 {
        return Err(platform_error(ErrorKind::DnsFailure, "resolving the tunnel interface", rc));
    }
    Ok(guid)
}

fn set_servers(guid: GUID, servers: &[IpAddr], ipv6: bool) -> PlatformResult<()> {
    let list = servers.iter().map(|s| s.to_string()).collect::<Vec<_>>().join(",");
    let mut wlist = wide(&list);
    let mut settings: DNS_INTERFACE_SETTINGS = unsafe { std::mem::zeroed() };
    settings.Version = DNS_INTERFACE_SETTINGS_VERSION1;
    settings.Flags = (DNS_SETTING_NAMESERVER | if ipv6 { DNS_SETTING_IPV6 } else { 0 }) as u64;
    settings.NameServer = wlist.as_mut_ptr();
    let rc = unsafe { SetInterfaceDnsSettings(guid, &settings) };
    if rc != 0 {
        return Err(platform_error(ErrorKind::DnsFailure, "setting DNS servers on the tunnel", rc));
    }
    Ok(())
}

fn read_servers(guid: GUID, ipv6: bool) -> Vec<IpAddr> {
    let mut settings: DNS_INTERFACE_SETTINGS = unsafe { std::mem::zeroed() };
    settings.Version = DNS_INTERFACE_SETTINGS_VERSION1;
    settings.Flags = if ipv6 { DNS_SETTING_IPV6 as u64 } else { 0 };
    if unsafe { GetInterfaceDnsSettings(guid, &mut settings) } != 0 {
        return Vec::new();
    }
    let list = unsafe { from_wide(settings.NameServer) };
    unsafe { FreeInterfaceDnsSettings(&mut settings) };
    list.split([',', ' ']).filter_map(|s| s.trim().parse().ok()).collect()
}

/// `DnsFlushResolverCache` is exported by dnsapi.dll but not in the SDK
/// headers, so it's resolved at runtime.
fn flush_resolver_cache() {
    let name = wide("dnsapi.dll");
    unsafe {
        let module = LoadLibraryExW(name.as_ptr(), std::ptr::null_mut(), LOAD_LIBRARY_SEARCH_SYSTEM32);
        if module.is_null() {
            return;
        }
        if let Some(f) = GetProcAddress(module, c"DnsFlushResolverCache".as_ptr().cast()) {
            let flush: unsafe extern "system" fn() -> i32 = std::mem::transmute(f);
            if flush() == 0 {
                tracing::warn!("DnsFlushResolverCache failed");
            }
        }
    }
}
