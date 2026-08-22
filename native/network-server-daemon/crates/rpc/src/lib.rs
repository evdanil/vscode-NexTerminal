//! Newline-delimited JSON-RPC over stdio.
//!
//! The wire contract is specified in `docs/network-server-daemon-protocol.md`;
//! this crate is that document in code, and nothing here knows anything about
//! TFTP, DHCP, or services in general.
//!
//! # Why stdio and not a socket
//!
//! A pipe never collides with a port a user already occupies and never raises a
//! host firewall prompt. Its lifecycle is coupled to the parent for free: when
//! the extension host goes away, the daemon's stdin reaches EOF and it shuts
//! down, releasing whatever privileged UDP ports it held. And every byte of it
//! is human-readable, which means the daemon can be driven by hand from a
//! terminal when something is wrong.
//!
//! # Why a thread rather than an async runtime
//!
//! There is exactly one stdin to read and one stdout to write. A blocking read
//! on the caller's own thread is the whole implementation; an async runtime
//! would add a dependency tree under a component whose value is that it can be
//! read end to end.

#![forbid(unsafe_code)]
#![warn(clippy::pedantic)]
#![allow(clippy::missing_errors_doc)]
#![allow(clippy::module_name_repetitions)]

pub mod framing;
pub mod message;

pub use framing::{Line, LineReader, MessageWriter, MAX_LINE_BYTES};
pub use message::{ErrorBody, ErrorCode, Outgoing, Request, RequestError};
