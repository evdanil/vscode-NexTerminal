//! Fundamental TFTP types, constants and negotiable-option bounds.
//!
//! Clean-room implementation from the RFC text:
//!   * RFC 1350 — TFTP Revision 2: opcodes, packet layouts, error codes 0–7
//!   * RFC 2347 — Option Extension: OACK and the negotiation mechanism
//!   * RFC 2348 — `blksize` (8–65464)
//!   * RFC 2349 — `timeout` (1–255) and `tsize`
//!   * RFC 7440 — `windowsize` (1–65535)

/// Opcode of each TFTP message (RFC 1350 §4 + RFC 2347).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
#[repr(u16)]
pub enum Opcode {
    Rrq = 1,
    Wrq = 2,
    Data = 3,
    Ack = 4,
    Error = 5,
    Oack = 6,
}

impl Opcode {
    /// Maps a wire value onto a known opcode, or `None` for anything else.
    ///
    /// `None` is not an error at this layer: RFC 1350 has no "reserved opcode"
    /// behaviour, and the engine answers an unknown opcode by ignoring it
    /// rather than by tearing down a session that may be perfectly healthy.
    #[must_use]
    pub fn from_wire(value: u16) -> Option<Self> {
        match value {
            1 => Some(Self::Rrq),
            2 => Some(Self::Wrq),
            3 => Some(Self::Data),
            4 => Some(Self::Ack),
            5 => Some(Self::Error),
            6 => Some(Self::Oack),
            _ => None,
        }
    }

    #[must_use]
    pub fn to_wire(self) -> u16 {
        self as u16
    }
}

/// Standard error codes (RFC 1350 §5.1 + RFC 2347 §2).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u16)]
pub enum ErrorCode {
    NotDefined = 0,
    FileNotFound = 1,
    AccessViolation = 2,
    DiskFull = 3,
    IllegalOperation = 4,
    UnknownTransferId = 5,
    FileAlreadyExists = 6,
    NoSuchUser = 7,
    OptionNegotiation = 8,
}

impl ErrorCode {
    #[must_use]
    pub fn to_wire(self) -> u16 {
        self as u16
    }

    /// Default human-readable text for a code (RFC 1350 §5.1 wording).
    #[must_use]
    pub fn default_message(self) -> &'static str {
        match self {
            Self::NotDefined => "Not defined, see error message.",
            Self::FileNotFound => "File not found.",
            Self::AccessViolation => "Access violation.",
            Self::DiskFull => "Disk full or allocation exceeded.",
            Self::IllegalOperation => "Illegal TFTP operation.",
            Self::UnknownTransferId => "Unknown transfer ID.",
            Self::FileAlreadyExists => "File already exists.",
            Self::NoSuchUser => "No such user.",
            Self::OptionNegotiation => "Option negotiation failed.",
        }
    }
}

/// Transfer mode (RFC 1350 §1).
///
/// Only `Octet` exists as a variant on purpose. `netascii` is rejected during
/// parsing rather than represented here — see [`crate::protocol::parse_packet`]
/// for why accepting a mode whose transform is not implemented is worse than
/// refusing it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TransferMode {
    Octet,
}

impl TransferMode {
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Octet => "octet",
        }
    }
}

/// Default block size (RFC 1350) — 512 octets.
pub const DEFAULT_BLOCK_SIZE: u32 = 512;

/// Default window size (RFC 7440) — 1, i.e. classic stop-and-wait.
pub const DEFAULT_WINDOW_SIZE: u32 = 1;

/// Length of the DATA header: 2 bytes opcode + 2 bytes block number.
pub const DATA_HEADER_LEN: usize = 4;

/// Inclusive bounds of `blksize` (RFC 2348 §1).
pub const BLKSIZE_MIN: u32 = 8;
pub const BLKSIZE_MAX: u32 = 65464;

/// Inclusive bounds of `timeout`, in seconds (RFC 2349 §2).
pub const TIMEOUT_MIN: u32 = 1;
pub const TIMEOUT_MAX: u32 = 255;

/// Inclusive bounds of `windowsize` (RFC 7440 §3).
pub const WINDOWSIZE_MIN: u32 = 1;
pub const WINDOWSIZE_MAX: u32 = 65535;

/// Ceiling on `blksize * windowsize` — the bytes one session may hold in flight.
///
/// The two options are individually bounded by their RFCs but their PRODUCT is
/// not, and that product is what gets allocated: a windowed sender builds a
/// whole window of DATA buffers in memory before any of it goes out. At the RFC
/// maxima an unauthenticated client can ask for 65464 × 65535 ≈ 4.3 GB in a
/// single RRQ, and every session in the admission pool can ask for it — so the
/// option negotiation of one datagram is a remote out-of-memory.
///
/// 1 MiB is far above what any real client uses and far below what hurts: RFC
/// 7440 windows in the field are 4–64 blocks, and even a jumbo-frame `blksize`
/// of 8192 still leaves room for 128 of them. At the absolute maximum `blksize`
/// it still permits a 16-block window, so the clamp never degrades a transfer
/// to stop-and-wait. Worst case across the default 64-session pool is 64 MiB
/// rather than unbounded.
pub const MAX_IN_FLIGHT_BYTES: u32 = 1024 * 1024;

/// Size of the block-number space — block numbers are a 16-bit wire field.
pub const BLOCK_SPACE: u32 = 0x1_0000;

/// The four options this engine recognises. Anything else is ignored on receipt
/// (RFC 2347 §3: "options not recognized […] should be ignored").
///
/// A fixed struct rather than a map: it makes the set of understood options a
/// compile-time fact, gives OACK serialization a deterministic field order
/// without sorting, and removes any question of what an attacker-chosen option
/// *key* could do to a hash container.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct RawOptions {
    pub blksize: Option<String>,
    pub timeout: Option<String>,
    pub tsize: Option<String>,
    pub windowsize: Option<String>,
}

impl RawOptions {
    /// True when the peer sent no recognised option, i.e. no OACK is owed.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.blksize.is_none()
            && self.timeout.is_none()
            && self.tsize.is_none()
            && self.windowsize.is_none()
    }

    /// Stores a key/value pair if the key names a recognised option.
    ///
    /// Returns `true` when the pair was kept. Comparison is
    /// case-insensitive per RFC 2347 §2 ("case insensitive" option names).
    pub fn set(&mut self, key: &str, value: &str) -> bool {
        let slot = match key.to_ascii_lowercase().as_str() {
            "blksize" => &mut self.blksize,
            "timeout" => &mut self.timeout,
            "tsize" => &mut self.tsize,
            "windowsize" => &mut self.windowsize,
            _ => return false,
        };
        *slot = Some(value.to_owned());
        true
    }

    /// Field order is the OACK wire order; see [`RawOptions`] on why it is fixed.
    pub(crate) fn pairs(&self) -> impl Iterator<Item = (&'static str, &str)> {
        [
            ("blksize", self.blksize.as_deref()),
            ("timeout", self.timeout.as_deref()),
            ("tsize", self.tsize.as_deref()),
            ("windowsize", self.windowsize.as_deref()),
        ]
        .into_iter()
        .filter_map(|(k, v)| v.map(|v| (k, v)))
    }
}

/// Options after validation and clamping, in the numeric form the engine uses.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ValidatedOptions {
    pub blksize: u32,
    pub windowsize: u32,
    pub timeout: Option<u32>,
    pub tsize: Option<u64>,
}

impl Default for ValidatedOptions {
    fn default() -> Self {
        Self {
            blksize: DEFAULT_BLOCK_SIZE,
            windowsize: DEFAULT_WINDOW_SIZE,
            timeout: None,
            tsize: None,
        }
    }
}

/// An RRQ or WRQ, which share a payload layout and differ only in opcode.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Request {
    pub filename: String,
    pub mode: TransferMode,
    pub options: RawOptions,
}

/// A parsed TFTP datagram.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Packet {
    Rrq(Request),
    Wrq(Request),
    Data { block: u16, data: Vec<u8> },
    Ack { block: u16 },
    /// `code` is kept as the raw wire value: a peer may legitimately send a code
    /// this implementation has no variant for, and mapping it onto
    /// [`ErrorCode::NotDefined`] would lose what the peer actually said.
    Error { code: u16, message: String },
    Oack { options: RawOptions },
}

impl Packet {
    #[must_use]
    pub fn opcode(&self) -> Opcode {
        match self {
            Self::Rrq(_) => Opcode::Rrq,
            Self::Wrq(_) => Opcode::Wrq,
            Self::Data { .. } => Opcode::Data,
            Self::Ack { .. } => Opcode::Ack,
            Self::Error { .. } => Opcode::Error,
            Self::Oack { .. } => Opcode::Oack,
        }
    }
}
