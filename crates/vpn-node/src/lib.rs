//! `apexy-node`: runs on every VPN node, next to kernel WireGuard.
//!
//! It keeps the interface's peers identical to the API's peer set: the
//! devices of accounts that have access and aren't banned. A key is added
//! when its device is enrolled and removed the moment its account loses
//! access, which ends the tunnel at once. It reports health and which keys
//! have a recent handshake, and nothing about where users connect from.
//!
//! It logs counts, never keys or addresses.

pub mod agent;
pub mod api;
pub mod peers;
pub mod wg;
