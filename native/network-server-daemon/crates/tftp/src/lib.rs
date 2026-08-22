//! TFTP protocol codec, filesystem sandbox and transfer engine.
//!
//! Clean-room implementation of RFC 1350 with the option extensions
//! RFC 2347 (OACK), RFC 2348 (`blksize`), RFC 2349 (`timeout`/`tsize`) and
//! RFC 7440 (`windowsize`).
//!
//! # Layout
//!
//! | Module | Responsibility |
//! | --- | --- |
//! | [`types`] | Wire constants, option bounds, packet shapes |
//! | [`protocol`] | Encode / decode / option validation — no I/O |
//! | [`path_guard`] | The filesystem sandbox every client path passes through |
//! | [`session`] | Per-transfer state machine — no socket |
//! | [`engine`] | Socket, session table, admission, retransmission, reaping |
//!
//! The split is what makes the protocol testable without a network: everything
//! outside [`engine`] is pure enough to drive from a unit test, and [`engine`]
//! itself can be driven through a recording [`engine::Datagram`] instead of a
//! real socket.
//!
//! # Safety
//!
//! This crate contains no `unsafe` code, and the lint below makes that a
//! compile error rather than a convention.

#![forbid(unsafe_code)]
#![warn(clippy::pedantic)]
// The pedantic lints below fire on shapes that are deliberate here.
#![allow(clippy::missing_errors_doc)]
#![allow(clippy::missing_panics_doc)]
#![allow(clippy::module_name_repetitions)]
#![allow(clippy::cast_precision_loss)]
#![allow(clippy::cast_possible_truncation)]

pub mod engine;
pub mod path_guard;
pub mod protocol;
pub mod session;
pub mod testsupport;
pub mod types;

pub use engine::{
    Engine, EngineEvent, EngineOptions, EventSink, LogLevel, StartError, TransferInfo,
};
pub use path_guard::{GuardError, PathGuard, RootError};
pub use session::{Direction, Phase, TransferSession};
pub use types::{ErrorCode, Opcode, Packet, RawOptions, ValidatedOptions};
