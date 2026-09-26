//! WireGuardNT (`wireguard.dll`) bindings, loaded at runtime as the SDK
//! recommends. Struct layouts mirror `vendor/wireguard-nt/include/wireguard.h`.

use std::ffi::c_void;
use std::net::SocketAddr;
use std::path::Path;
use std::sync::Arc;

use ipnet::IpNet;
use vpn_core::PlatformError;
use vpn_types::ErrorKind;
use windows_sys::core::{BOOL, GUID, PCWSTR};
use windows_sys::Win32::Foundation::{ERROR_MORE_DATA, HMODULE};
use windows_sys::Win32::NetworkManagement::Ndis::NET_LUID_LH;
use windows_sys::Win32::Networking::WinSock::{AF_INET, AF_INET6, SOCKADDR_INET};
use windows_sys::Win32::System::LibraryLoader::{
    GetProcAddress, LoadLibraryExW, LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR, LOAD_LIBRARY_SEARCH_SYSTEM32,
};
use zeroize::Zeroize;

use super::util::{filetime_to_unix_ms, from_wide, last_error, platform_error, sockaddr_inet, wide};

type Handle = *mut c_void;
type LoggerCallback = unsafe extern "system" fn(level: i32, timestamp: u64, message: PCWSTR);

type FnCreateAdapter = unsafe extern "system" fn(PCWSTR, PCWSTR, *const GUID) -> Handle;
type FnCloseAdapter = unsafe extern "system" fn(Handle);
type FnGetAdapterLuid = unsafe extern "system" fn(Handle, *mut NET_LUID_LH);
type FnGetRunningDriverVersion = unsafe extern "system" fn() -> u32;
type FnSetLogger = unsafe extern "system" fn(Option<LoggerCallback>);
type FnSetAdapterLogging = unsafe extern "system" fn(Handle, i32) -> BOOL;
type FnSetAdapterState = unsafe extern "system" fn(Handle, i32) -> BOOL;
type FnSetConfiguration = unsafe extern "system" fn(Handle, *const WgInterface, u32) -> BOOL;
type FnGetConfiguration = unsafe extern "system" fn(Handle, *mut WgInterface, *mut u32) -> BOOL;

const ADAPTER_STATE_DOWN: i32 = 0;
const ADAPTER_STATE_UP: i32 = 1;
const ADAPTER_LOG_ON: i32 = 1;

const INTERFACE_HAS_PRIVATE_KEY: u32 = 1 << 1;
const INTERFACE_REPLACE_PEERS: u32 = 1 << 3;
const PEER_HAS_PUBLIC_KEY: u32 = 1 << 0;
const PEER_HAS_PERSISTENT_KEEPALIVE: u32 = 1 << 2;
const PEER_HAS_ENDPOINT: u32 = 1 << 3;
const PEER_REPLACE_ALLOWED_IPS: u32 = 1 << 5;

#[repr(C, align(8))]
#[derive(Clone, Copy)]
pub struct WgInterface {
    flags: u32,
    listen_port: u16,
    private_key: [u8; 32],
    public_key: [u8; 32],
    peers_count: u32,
}

#[repr(C, align(8))]
#[derive(Clone, Copy)]
struct WgPeer {
    flags: u32,
    reserved: u32,
    public_key: [u8; 32],
    preshared_key: [u8; 32],
    persistent_keepalive: u16,
    endpoint: SOCKADDR_INET,
    tx_bytes: u64,
    rx_bytes: u64,
    last_handshake: u64,
    allowed_ips_count: u32,
}

#[repr(C, align(8))]
#[derive(Clone, Copy)]
struct WgAllowedIp {
    address: [u8; 16],
    address_family: u16,
    cidr: u8,
    flags: u32,
}

pub struct WireGuardNt {
    _module: HMODULE,
    create: FnCreateAdapter,
    close: FnCloseAdapter,
    get_luid: FnGetAdapterLuid,
    running_version: FnGetRunningDriverVersion,
    set_logging: FnSetAdapterLogging,
    set_state: FnSetAdapterState,
    set_config: FnSetConfiguration,
    get_config: FnGetConfiguration,
}

// The WireGuardNT API is thread-safe; the module stays loaded for the
// lifetime of the process.
unsafe impl Send for WireGuardNt {}
unsafe impl Sync for WireGuardNt {}

impl WireGuardNt {
    /// Loads `wireguard.dll` from `dir` by absolute path (no DLL search-order
    /// hijacking), after verifying its signature when `require_signed`.
    pub fn load(dir: &Path, require_signed: bool) -> Result<Arc<Self>, PlatformError> {
        let path = dir.join("wireguard.dll");
        if !path.is_file() {
            return Err(PlatformError::new(
                ErrorKind::DriverUnavailable,
                format!("wireguard.dll not found in {}", dir.display()),
            ));
        }
        if require_signed {
            super::trust::verify_signer(&path, "WireGuard LLC")?;
        }
        let wpath = wide(&path.to_string_lossy());
        let module = unsafe {
            LoadLibraryExW(wpath.as_ptr(), std::ptr::null_mut(), LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR | LOAD_LIBRARY_SEARCH_SYSTEM32)
        };
        if module.is_null() {
            return Err(platform_error(ErrorKind::DriverUnavailable, "loading wireguard.dll", last_error()));
        }
        // Each export is cast to the exact signature named at the call site,
        // matching wireguard.h.
        macro_rules! sym {
            ($name:literal as $ty:ty) => {{
                let p = unsafe { GetProcAddress(module, concat!($name, "\0").as_ptr()) };
                match p {
                    Some(f) => unsafe { std::mem::transmute::<unsafe extern "system" fn() -> isize, $ty>(f) },
                    None => {
                        return Err(PlatformError::new(
                            ErrorKind::DriverUnavailable,
                            concat!("wireguard.dll lacks ", $name),
                        ))
                    }
                }
            }};
        }
        let set_logger = sym!("WireGuardSetLogger" as FnSetLogger);
        let nt = Arc::new(Self {
            _module: module,
            create: sym!("WireGuardCreateAdapter" as FnCreateAdapter),
            close: sym!("WireGuardCloseAdapter" as FnCloseAdapter),
            get_luid: sym!("WireGuardGetAdapterLUID" as FnGetAdapterLuid),
            running_version: sym!("WireGuardGetRunningDriverVersion" as FnGetRunningDriverVersion),
            set_logging: sym!("WireGuardSetAdapterLogging" as FnSetAdapterLogging),
            set_state: sym!("WireGuardSetAdapterState" as FnSetAdapterState),
            set_config: sym!("WireGuardSetConfiguration" as FnSetConfiguration),
            get_config: sym!("WireGuardGetConfiguration" as FnGetConfiguration),
        });
        unsafe { set_logger(Some(driver_log)) };
        Ok(nt)
    }

    /// `major.minor` of the loaded kernel driver, once an adapter exists.
    pub fn driver_version(&self) -> Option<String> {
        let v = unsafe { (self.running_version)() };
        (v != 0).then(|| format!("{}.{}", (v >> 16) & 0xffff, v & 0xffff))
    }
}

unsafe extern "system" fn driver_log(level: i32, _timestamp: u64, message: PCWSTR) {
    let msg = unsafe { from_wide(message) };
    match level {
        2 => tracing::error!(target: "wireguard_nt", "{msg}"),
        1 => tracing::warn!(target: "wireguard_nt", "{msg}"),
        _ => tracing::debug!(target: "wireguard_nt", "{msg}"),
    }
}

/// One WireGuardNT adapter. Dropping it removes the adapter.
pub struct Adapter {
    nt: Arc<WireGuardNt>,
    handle: Handle,
    luid: u64,
}

unsafe impl Send for Adapter {}
unsafe impl Sync for Adapter {}

pub struct PeerSettings {
    pub public_key: [u8; 32],
    pub endpoint: SocketAddr,
    pub persistent_keepalive: u16,
    pub allowed_ips: Vec<IpNet>,
}

#[derive(Debug, Clone, Copy, Default)]
pub struct PeerCounters {
    pub rx_bytes: u64,
    pub tx_bytes: u64,
    pub last_handshake_ms: Option<u64>,
}

impl Adapter {
    pub fn create(nt: &Arc<WireGuardNt>, name: &str, tunnel_type: &str, guid: &GUID) -> Result<Self, PlatformError> {
        let (wname, wtype) = (wide(name), wide(tunnel_type));
        let handle = unsafe { (nt.create)(wname.as_ptr(), wtype.as_ptr(), guid) };
        if handle.is_null() {
            return Err(platform_error(ErrorKind::TunnelFailure, "creating the WireGuard adapter", last_error()));
        }
        let mut luid: NET_LUID_LH = unsafe { std::mem::zeroed() };
        unsafe {
            (nt.get_luid)(handle, &mut luid);
            (nt.set_logging)(handle, ADAPTER_LOG_ON);
        }
        Ok(Self { nt: nt.clone(), handle, luid: unsafe { luid.Value } })
    }

    pub fn luid(&self) -> u64 {
        self.luid
    }

    pub fn configure(&self, private_key: &[u8; 32], peer: &PeerSettings) -> Result<(), PlatformError> {
        let iface = WgInterface {
            flags: INTERFACE_HAS_PRIVATE_KEY | INTERFACE_REPLACE_PEERS,
            listen_port: 0,
            private_key: *private_key,
            public_key: [0; 32],
            peers_count: 1,
        };
        let wg_peer = WgPeer {
            flags: PEER_HAS_PUBLIC_KEY | PEER_HAS_ENDPOINT | PEER_HAS_PERSISTENT_KEEPALIVE | PEER_REPLACE_ALLOWED_IPS,
            reserved: 0,
            public_key: peer.public_key,
            preshared_key: [0; 32],
            persistent_keepalive: peer.persistent_keepalive,
            endpoint: sockaddr_inet(peer.endpoint),
            tx_bytes: 0,
            rx_bytes: 0,
            last_handshake: 0,
            allowed_ips_count: peer.allowed_ips.len() as u32,
        };
        let allowed: Vec<WgAllowedIp> = peer.allowed_ips.iter().map(allowed_ip).collect();

        let mut buf = ConfigBuffer::new();
        buf.push(&iface);
        buf.push(&wg_peer);
        for a in &allowed {
            buf.push(a);
        }
        let mut iface = iface;
        iface.private_key.zeroize();

        let ok = unsafe { (self.nt.set_config)(self.handle, buf.as_ptr(), buf.len() as u32) };
        if ok == 0 {
            return Err(platform_error(ErrorKind::TunnelFailure, "applying the WireGuard configuration", last_error()));
        }
        Ok(())
    }

    pub fn set_up(&self, up: bool) -> Result<(), PlatformError> {
        let state = if up { ADAPTER_STATE_UP } else { ADAPTER_STATE_DOWN };
        if unsafe { (self.nt.set_state)(self.handle, state) } == 0 {
            return Err(platform_error(ErrorKind::TunnelFailure, "changing the adapter state", last_error()));
        }
        Ok(())
    }

    /// Counters of the (single) peer.
    pub fn counters(&self) -> Result<PeerCounters, PlatformError> {
        let mut size: u32 = 4096;
        loop {
            let mut buf = vec![0u64; (size as usize).div_ceil(8)];
            let mut bytes = (buf.len() * 8) as u32;
            let ok = unsafe { (self.nt.get_config)(self.handle, buf.as_mut_ptr().cast(), &mut bytes) };
            if ok == 0 {
                let err = last_error();
                if err == ERROR_MORE_DATA && bytes > size {
                    size = bytes;
                    continue;
                }
                return Err(platform_error(ErrorKind::TunnelFailure, "reading the WireGuard configuration", err));
            }
            let base = buf.as_ptr() as *const u8;
            let mut iface: WgInterface = unsafe { std::ptr::read(base.cast()) };
            let peer: Option<WgPeer> = (iface.peers_count > 0)
                .then(|| unsafe { std::ptr::read(base.add(std::mem::size_of::<WgInterface>()).cast()) });
            // The driver echoes the private key back; wipe every copy.
            iface.private_key.zeroize();
            buf.zeroize();
            let Some(peer) = peer else { return Ok(PeerCounters::default()) };
            return Ok(PeerCounters {
                rx_bytes: peer.rx_bytes,
                tx_bytes: peer.tx_bytes,
                last_handshake_ms: filetime_to_unix_ms(peer.last_handshake),
            });
        }
    }
}

impl Drop for Adapter {
    fn drop(&mut self) {
        unsafe { (self.nt.close)(self.handle) };
    }
}

fn allowed_ip(net: &IpNet) -> WgAllowedIp {
    let mut address = [0u8; 16];
    let (family, cidr) = match net {
        IpNet::V4(v4) => {
            address[..4].copy_from_slice(&v4.network().octets());
            (AF_INET, v4.prefix_len())
        }
        IpNet::V6(v6) => {
            address.copy_from_slice(&v6.network().octets());
            (AF_INET6, v6.prefix_len())
        }
    };
    WgAllowedIp { address, address_family: family, cidr, flags: 0 }
}

/// An 8-byte-aligned byte buffer that is wiped on drop (it carries the
/// private key).
struct ConfigBuffer {
    words: Vec<u64>,
    len: usize,
}

impl ConfigBuffer {
    fn new() -> Self {
        Self { words: Vec::new(), len: 0 }
    }

    fn push<T: Copy>(&mut self, value: &T) {
        let size = std::mem::size_of::<T>();
        debug_assert_eq!(size % 8, 0, "WireGuardNT structs are 8-byte aligned");
        self.words.resize((self.len + size) / 8, 0);
        unsafe {
            std::ptr::copy_nonoverlapping(
                (value as *const T).cast::<u8>(),
                (self.words.as_mut_ptr() as *mut u8).add(self.len),
                size,
            );
        }
        self.len += size;
    }

    fn as_ptr(&self) -> *const WgInterface {
        self.words.as_ptr().cast()
    }

    fn len(&self) -> usize {
        self.len
    }
}

impl Drop for ConfigBuffer {
    fn drop(&mut self) {
        self.words.zeroize();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn struct_layouts_match_wireguard_h() {
        // Derived from wireguard.h with MSVC packing and ALIGNED(8).
        assert_eq!(std::mem::size_of::<WgInterface>(), 80);
        assert_eq!(std::mem::size_of::<WgPeer>(), 136);
        assert_eq!(std::mem::size_of::<WgAllowedIp>(), 24);
        assert_eq!(std::mem::offset_of!(WgInterface, peers_count), 72);
        assert_eq!(std::mem::offset_of!(WgPeer, endpoint), 76);
        assert_eq!(std::mem::offset_of!(WgPeer, tx_bytes), 104);
        assert_eq!(std::mem::offset_of!(WgPeer, allowed_ips_count), 128);
        assert_eq!(std::mem::offset_of!(WgAllowedIp, address_family), 16);
        assert_eq!(std::mem::offset_of!(WgAllowedIp, flags), 20);
    }

    #[test]
    fn config_buffer_is_contiguous() {
        let mut b = ConfigBuffer::new();
        b.push(&WgInterface { flags: 1, listen_port: 0, private_key: [7; 32], public_key: [0; 32], peers_count: 1 });
        b.push(&allowed_ip(&"0.0.0.0/0".parse().unwrap()));
        assert_eq!(b.len(), 80 + 24);
    }
}
