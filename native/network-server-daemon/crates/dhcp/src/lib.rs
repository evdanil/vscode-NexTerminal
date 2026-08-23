//! DHCP packet codec, lease store and DORA engine.
//!
//! Clean-room implementation of RFC 2131 (the DHCP message format and the
//! DISCOVER/OFFER/REQUEST/ACK exchange) with the RFC 2132 option encoding, plus
//! the Zero-Touch-Provisioning options 43, 60, 66, 67 and the Cisco-proprietary
//! 150.
//!
//! # Layout
//!
//! | Module | Responsibility |
//! | --- | --- |
//! | [`constants`] | Ports, defaults, option codes, message-type names |
//! | [`net`] | IPv4 arithmetic and the canonical MAC key |
//! | [`protocol`] | Encode / decode — no I/O, no allocation of trust |
//! | [`boot`] | ZTP option encoders (43 / 60 / 66 / 67 / 150) |
//! | [`lease`] | The lease table: allocation, expiry, reservations |
//! | [`persistence`] | The on-disk lease file and its reconciliation |
//! | [`engine`] | Socket, DORA state machine, event sink |
//!
//! # Why the codec is hand-rolled
//!
//! The implementation this replaces used `dhcp@0.2.20`, unmaintained since 2020,
//! to parse packets that arrive unauthenticated from the LAN. An audit of that
//! library found an option-length byte used to drive a numeric read with no
//! prior bounds check — safe only because Node's `Buffer.readUInt16BE` happens
//! to throw on a short buffer, and because two layers of `try`/`catch` happened
//! to be in the way. Safety by accident of runtime, not by construction.
//!
//! This crate makes the same class of bug unrepresentable: every read of network
//! bytes goes through [`protocol::Reader`], which returns `Result` and never
//! indexes a slice directly, and every option's declared length is compared
//! against the bytes actually remaining *before* the value is touched. A
//! malformed packet produces a named [`protocol::DecodeError`], never a panic.
//!
//! # Safety
//!
//! This crate contains no `unsafe` code, and the lint below makes that a compile
//! error rather than a convention.

#![forbid(unsafe_code)]
#![warn(clippy::pedantic)]
// The pedantic lints below fire on shapes that are deliberate here.
#![allow(clippy::missing_errors_doc)]
#![allow(clippy::missing_panics_doc)]
#![allow(clippy::module_name_repetitions)]
#![allow(clippy::cast_precision_loss)]
#![allow(clippy::cast_possible_truncation)]

pub mod boot;
pub mod constants;
pub mod engine;
pub mod lease;
pub mod net;
pub mod persistence;
pub mod protocol;
pub mod testsupport;

pub use boot::{BootOptions, BootOptionError, VendorEntry};
pub use engine::{Engine, EngineEvent, EngineOptions, EventSink, LogLevel, StartError};
pub use lease::{LeaseInfo, LeaseState, LeaseTable, LeaseType, PoolInfo};
pub use net::{broadcast_address, is_ip_in_pool, pool_size, MacKey};
pub use protocol::{DecodeError, EncodeError, Message, MessageType, Options};
