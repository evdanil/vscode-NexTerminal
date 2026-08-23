//! Out-of-process supervisor for the Nexus embedded network services.
//!
//! The binary in `main.rs` is a thin shell around this library: it owns stdio
//! and nothing else. Everything with behaviour lives here so it can be tested
//! without spawning a process.
//!
//! The wire contract is `docs/network-server-daemon-protocol.md`.

#![forbid(unsafe_code)]
#![warn(clippy::pedantic)]
#![allow(clippy::missing_errors_doc)]
#![allow(clippy::missing_panics_doc)]
#![allow(clippy::module_name_repetitions)]
#![allow(clippy::cast_precision_loss)]
#![allow(clippy::cast_possible_truncation)]
#![allow(clippy::cast_sign_loss)]

pub mod config;
pub mod daemon;
pub mod dhcp_service;
pub mod events;
pub mod tftp_service;
pub mod throttle;

pub use daemon::Daemon;
pub use events::{Emitter, ServerStatus};
