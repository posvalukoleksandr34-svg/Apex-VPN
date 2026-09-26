//! The tunnel state machine: the single source of truth for the VPN state.
//!
//! One task owns the tunnel, the firewall policy and the published state.
//! Everything that changes them arrives as a [`Command`] and is processed in
//! order, so the kill switch and the tunnel can't race each other. Long
//! waits (opening an adapter, waiting for a handshake, backing off) are
//! interruptible: a Disconnect or a network change arriving mid-attempt
//! cancels the attempt cleanly, and it's handled next.

mod machine;

#[cfg(test)]
mod tests;

pub use machine::*;
