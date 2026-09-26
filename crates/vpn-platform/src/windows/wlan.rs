//! Current Wi-Fi connections (SSID and whether the network is protected).
//!
//! Since Windows 11 24H2, reading SSIDs can require location access. When
//! Windows refuses, we report Wi-Fi detection as unavailable rather than
//! guessing.

use std::collections::HashMap;

use windows_sys::Win32::Foundation::{ERROR_ACCESS_DENIED, HANDLE};
use windows_sys::Win32::NetworkManagement::WiFi::{
    wlan_interface_state_connected, wlan_intf_opcode_current_connection, WlanCloseHandle, WlanEnumInterfaces,
    WlanFreeMemory, WlanOpenHandle, WlanQueryInterface, WLAN_CONNECTION_ATTRIBUTES, WLAN_INTERFACE_INFO,
    WLAN_INTERFACE_INFO_LIST,
};

use super::util::guid_string;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WifiConnection {
    pub ssid: String,
    pub secured: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WlanStatus {
    Ok,
    /// No WLAN service (no Wi-Fi hardware) — nothing to detect.
    NoService,
    AccessDenied,
}

/// Keyed by interface GUID string (`{XXXXXXXX-…}`, upper case), matching
/// `IP_ADAPTER_ADDRESSES.AdapterName`.
pub fn connections() -> (HashMap<String, WifiConnection>, WlanStatus) {
    let mut out = HashMap::new();
    let mut version = 0u32;
    let mut client: HANDLE = std::ptr::null_mut();
    if unsafe { WlanOpenHandle(2, std::ptr::null(), &mut version, &mut client) } != 0 {
        return (out, WlanStatus::NoService);
    }
    let mut status = WlanStatus::Ok;
    let mut list: *mut WLAN_INTERFACE_INFO_LIST = std::ptr::null_mut();
    if unsafe { WlanEnumInterfaces(client, std::ptr::null(), &mut list) } == 0 && !list.is_null() {
        let count = unsafe { (*list).dwNumberOfItems } as usize;
        let first = unsafe { (*list).InterfaceInfo.as_ptr() };
        for i in 0..count {
            let info: &WLAN_INTERFACE_INFO = unsafe { &*first.add(i) };
            if info.isState != wlan_interface_state_connected {
                continue;
            }
            let mut size = 0u32;
            let mut data: *mut core::ffi::c_void = std::ptr::null_mut();
            let rc = unsafe {
                WlanQueryInterface(
                    client,
                    &info.InterfaceGuid,
                    wlan_intf_opcode_current_connection,
                    std::ptr::null(),
                    &mut size,
                    &mut data,
                    std::ptr::null_mut(),
                )
            };
            if rc == ERROR_ACCESS_DENIED {
                status = WlanStatus::AccessDenied;
                continue;
            }
            if rc != 0 || data.is_null() {
                continue;
            }
            let attrs = unsafe { &*(data as *const WLAN_CONNECTION_ATTRIBUTES) };
            let ssid = &attrs.wlanAssociationAttributes.dot11Ssid;
            let len = (ssid.uSSIDLength as usize).min(32);
            out.insert(
                guid_string(&info.InterfaceGuid),
                WifiConnection {
                    ssid: String::from_utf8_lossy(&ssid.ucSSID[..len]).into_owned(),
                    secured: attrs.wlanSecurityAttributes.bSecurityEnabled != 0,
                },
            );
            unsafe { WlanFreeMemory(data) };
        }
        unsafe { WlanFreeMemory(list.cast()) };
    }
    unsafe { WlanCloseHandle(client, std::ptr::null()) };
    (out, status)
}
