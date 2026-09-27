//! Local IPC between `apexyd` and its clients.
//!
//! One JSON document per line (`vpn_types::ipc`). The transport is a named
//! pipe on Windows and a Unix socket elsewhere, both restricted by OS
//! access control (see [`transport`]).

pub mod client;
pub mod server;
pub mod transport;

pub use client::{ClientError, IpcClient};
pub use server::{ConnectionInfo, Handler, Server};

use tokio_util::codec::LinesCodec;
use vpn_types::ipc::MAX_FRAME_BYTES;

pub(crate) fn codec() -> LinesCodec {
    LinesCodec::new_with_max_length(MAX_FRAME_BYTES)
}
