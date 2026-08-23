//! The DHCP wire codec: RFC 2131 fixed header, RFC 2132 options.
//!
//! # The rule this module exists to enforce
//!
//! Every byte here arrives unauthenticated from the LAN. There is therefore
//! exactly one way to read one: through [`Reader`], which owns the cursor,
//! compares the requested length against the bytes actually remaining, and
//! returns [`DecodeError`] when they do not fit. No slice is indexed directly,
//! nothing is `unwrap`ped, and no arithmetic on a length taken from the packet
//! is performed before that length has been checked.
//!
//! That is a deliberate departure from the shape of the library this replaces.
//! `dhcp@0.2.20` reads an option's declared length and then immediately performs
//! a multi-byte numeric read at the cursor, with no comparison against what is
//! left in the buffer. It does not corrupt memory — Node's `Buffer` accessors
//! throw on a short read, and the library catches that — but the safety comes
//! from the runtime's accessors and two layers of `try`/`catch`, not from the
//! parser. Remove any one of those three accidents and it is an out-of-bounds
//! read driven by an attacker-supplied byte.
//!
//! Here, [`parse_options`] compares `declared` against `remaining` *before*
//! taking the value, and names the failure
//! ([`DecodeError::OptionTruncated`]) when they disagree.
//!
//! # Layout
//!
//! ```text
//! 0      1      2      3      4                                  bytes
//! +------+------+------+------+
//! |  op  |htype | hlen | hops |
//! +------+------+------+------+
//! |            xid            |
//! +-------------+-------------+
//! |    secs     |    flags    |
//! +-------------+-------------+
//! |           ciaddr          |   yiaddr, siaddr, giaddr follow
//! +---------------------------+
//! |      chaddr (16 bytes)    |
//! |      sname  (64 bytes)    |
//! |      file   (128 bytes)   |
//! +---------------------------+   = 236 bytes
//! |    magic cookie (4)       |   0x63 0x82 0x53 0x63
//! +---------------------------+
//! |  options … 0xFF (END)     |
//! ```

use std::collections::BTreeMap;
use std::fmt;
use std::net::Ipv4Addr;

use crate::constants::{
    ETHERNET_HLEN, HTYPE_ETHERNET, MAX_OPTION_VALUE_BYTES, OPTION_END, OPTION_MESSAGE_TYPE,
    OPTION_OVERLOAD, OPTION_PAD, OP_BOOTREPLY, OP_BOOTREQUEST,
};

/// The four bytes that separate a DHCP message from a plain BOOTP one
/// (RFC 2131 §3, "magic cookie").
pub const MAGIC_COOKIE: [u8; 4] = [0x63, 0x82, 0x53, 0x63];

/// Size of the fixed header, before the magic cookie.
pub const FIXED_HEADER_LEN: usize = 236;

/// Smallest packet that can carry a single option: header + cookie.
pub const MIN_PACKET_LEN: usize = FIXED_HEADER_LEN + MAGIC_COOKIE.len();

/// Length a reply is padded up to.
///
/// RFC 951 §3 makes 300 bytes the smallest BOOTP message, and some client
/// firmware and relay agents still drop anything shorter. Padding costs 60 bytes
/// on the wire and removes a failure mode that is invisible from this side —
/// the client simply never answers.
pub const MIN_REPLY_LEN: usize = 300;

/// Largest `chaddr` the fixed header can carry.
pub const MAX_HARDWARE_LEN: usize = 16;

/// Cap on text lifted out of a packet and shown to an operator.
///
/// A client controls its own `hostname` and vendor class, and both are echoed
/// into log lines that cross a pipe and land in the UI. Truncating here keeps
/// one hostile datagram from becoming an unbounded write to that pipe.
pub const MAX_ECHOED_TEXT: usize = 200;

/// Byte ceiling for the same text, which is the bound that actually matters.
///
/// [`MAX_ECHOED_TEXT`] counts `char`s, and a `char` is up to four bytes —
/// `String::from_utf8_lossy` turns every invalid byte into U+FFFD, three bytes
/// apiece, so a 200-`char` cap still admits 600 bytes. The extension host parses
/// a lease `hostname` against a 255-byte bound and treats an over-long value as
/// a malformed RPC result, which terminates the daemon; without a byte bound one
/// unauthenticated option 12 of invalid bytes stops the DHCP service. 255 is
/// that host bound, and every text this module echoes goes through the same
/// gate, so no field can drift past it.
pub const MAX_ECHOED_TEXT_BYTES: usize = 255;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/// Why a packet could not be decoded.
///
/// Every variant names *what* was wrong and *where*, because these are the lines
/// an operator reads when a device on the bench will not boot. A parser that
/// answered `None` for all of them would be indistinguishable from a parser that
/// dropped the packet for a reason nobody can see.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DecodeError {
    /// The buffer ran out mid-field.
    TooShort { field: &'static str, needed: usize, available: usize },
    /// Present but not `0x63825363` — a BOOTP packet, not a DHCP one.
    BadMagicCookie([u8; 4]),
    /// Neither `BOOTREQUEST` nor `BOOTREPLY`.
    BadOperation(u8),
    /// `hlen` claims more hardware address than the field can hold, or none.
    BadHardwareLength(u8),
    /// An option's length byte is present but its value runs off the end.
    ///
    /// This is the variant the whole module is built around: it is what the
    /// reference library never produced, because it never made the comparison.
    OptionTruncated { code: u8, declared: usize, available: usize },
    /// An option code was followed by end-of-buffer where its length byte
    /// should have been.
    OptionMissingLength { code: u8 },
}

impl fmt::Display for DecodeError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::TooShort { field, needed, available } => write!(
                f,
                "packet truncated at {field}: needed {needed} more byte(s), {available} available"
            ),
            Self::BadMagicCookie(bytes) => write!(
                f,
                "not a DHCP packet: magic cookie was {bytes:02X?}, expected 63 82 53 63"
            ),
            Self::BadOperation(op) => write!(f, "unknown BOOTP operation {op}, expected 1 or 2"),
            Self::BadHardwareLength(hlen) => write!(
                f,
                "hlen {hlen} is not a usable hardware address length (expected 1..={MAX_HARDWARE_LEN})"
            ),
            Self::OptionTruncated { code, declared, available } => write!(
                f,
                "option {code} declares {declared} byte(s) but only {available} remain"
            ),
            Self::OptionMissingLength { code } => {
                write!(f, "option {code} has no length byte")
            }
        }
    }
}

impl std::error::Error for DecodeError {}

/// Why a packet could not be encoded.
///
/// Encoding inputs come from operator configuration rather than from the
/// network, but they get the same treatment: a value that cannot be described by
/// a one-byte length field is refused by name, not silently truncated into a
/// packet the device ignores without saying why.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EncodeError {
    /// A value longer than a single-byte length field can describe.
    OptionTooLong { code: u8, len: usize },
    /// `0` is PAD and `255` is END; neither can carry a value.
    ReservedOptionCode(u8),
    /// More addresses than one option can hold.
    TooManyAddresses { code: u8, count: usize },
}

impl fmt::Display for EncodeError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::OptionTooLong { code, len } => write!(
                f,
                "option {code} value is {len} bytes; the length field carries at most {MAX_OPTION_VALUE_BYTES}"
            ),
            Self::ReservedOptionCode(code) => write!(
                f,
                "option code {code} is reserved by the encoding itself (0 is PAD, 255 is END)"
            ),
            Self::TooManyAddresses { code, count } => write!(
                f,
                "option {code} would carry {count} addresses ({} bytes); at most {} fit",
                count * 4,
                MAX_OPTION_VALUE_BYTES / 4
            ),
        }
    }
}

impl std::error::Error for EncodeError {}

// ---------------------------------------------------------------------------
// Reader
// ---------------------------------------------------------------------------

/// A cursor over a received packet that cannot read past the end.
///
/// Every accessor returns `Result`. There is deliberately no `Index` impl, no
/// `peek_unchecked`, and no method that takes a length without checking it —
/// the type is the enforcement mechanism, so that "bounds-checked before the
/// read" is a property of the code shape rather than of reviewer discipline.
#[derive(Debug)]
pub struct Reader<'a> {
    buf: &'a [u8],
    pos: usize,
}

impl<'a> Reader<'a> {
    #[must_use]
    pub fn new(buf: &'a [u8]) -> Self {
        Self { buf, pos: 0 }
    }

    /// Bytes not yet consumed.
    #[must_use]
    pub fn remaining(&self) -> usize {
        self.buf.len().saturating_sub(self.pos)
    }

    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.remaining() == 0
    }

    /// Consumes exactly `n` bytes, or fails naming the field that wanted them.
    pub fn take(&mut self, n: usize, field: &'static str) -> Result<&'a [u8], DecodeError> {
        let available = self.remaining();
        if n > available {
            return Err(DecodeError::TooShort { field, needed: n, available });
        }
        // Both bounds are already proven in range by the check above, so this
        // slice cannot panic — but it is still expressed with `get` so that a
        // future edit to the arithmetic above degrades to an error rather than
        // to a panic.
        let end = self.pos + n;
        let slice = self
            .buf
            .get(self.pos..end)
            .ok_or(DecodeError::TooShort { field, needed: n, available })?;
        self.pos = end;
        Ok(slice)
    }

    pub fn u8(&mut self, field: &'static str) -> Result<u8, DecodeError> {
        Ok(self.take(1, field)?[0])
    }

    pub fn u16(&mut self, field: &'static str) -> Result<u16, DecodeError> {
        let bytes = self.take(2, field)?;
        Ok(u16::from_be_bytes([bytes[0], bytes[1]]))
    }

    pub fn u32(&mut self, field: &'static str) -> Result<u32, DecodeError> {
        let bytes = self.take(4, field)?;
        Ok(u32::from_be_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]))
    }

    pub fn ipv4(&mut self, field: &'static str) -> Result<Ipv4Addr, DecodeError> {
        Ok(Ipv4Addr::from(self.u32(field)?))
    }
}

// ---------------------------------------------------------------------------
// Message types
// ---------------------------------------------------------------------------

/// The DHCP message types of RFC 2131 §3 (option 53).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum MessageType {
    Discover,
    Offer,
    Request,
    Decline,
    Ack,
    Nak,
    Release,
    Inform,
}

impl MessageType {
    #[must_use]
    pub fn from_wire(code: u8) -> Option<Self> {
        match code {
            1 => Some(Self::Discover),
            2 => Some(Self::Offer),
            3 => Some(Self::Request),
            4 => Some(Self::Decline),
            5 => Some(Self::Ack),
            6 => Some(Self::Nak),
            7 => Some(Self::Release),
            8 => Some(Self::Inform),
            _ => None,
        }
    }

    #[must_use]
    pub fn as_wire(self) -> u8 {
        match self {
            Self::Discover => 1,
            Self::Offer => 2,
            Self::Request => 3,
            Self::Decline => 4,
            Self::Ack => 5,
            Self::Nak => 6,
            Self::Release => 7,
            Self::Inform => 8,
        }
    }

    #[must_use]
    pub fn as_str(self) -> &'static str {
        crate::constants::message_type_name(self.as_wire())
    }
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/// The decoded option set of one packet.
///
/// Values are stored as raw bytes and interpreted only on access, so an option
/// whose value is the wrong length for its code (a four-byte lease time sent as
/// three) reads as absent rather than as a wrong number.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Options(BTreeMap<u8, Vec<u8>>);

impl Options {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    #[must_use]
    pub fn get(&self, code: u8) -> Option<&[u8]> {
        self.0.get(&code).map(Vec::as_slice)
    }

    #[must_use]
    pub fn contains(&self, code: u8) -> bool {
        self.0.contains_key(&code)
    }

    #[must_use]
    pub fn codes(&self) -> Vec<u8> {
        self.0.keys().copied().collect()
    }

    /// A single-byte option value, or `None` when the length is not exactly 1.
    #[must_use]
    pub fn u8(&self, code: u8) -> Option<u8> {
        match self.get(code) {
            Some([byte]) => Some(*byte),
            _ => None,
        }
    }

    /// A four-byte big-endian option value, or `None` when the length is not
    /// exactly 4.
    ///
    /// This is the accessor the reference library's shape got wrong: it read
    /// four bytes at the cursor because the *option code* implied a number,
    /// without checking that the *declared length* actually delivered four.
    #[must_use]
    pub fn u32(&self, code: u8) -> Option<u32> {
        match self.get(code) {
            Some([a, b, c, d]) => Some(u32::from_be_bytes([*a, *b, *c, *d])),
            _ => None,
        }
    }

    #[must_use]
    pub fn ipv4(&self, code: u8) -> Option<Ipv4Addr> {
        self.u32(code).map(Ipv4Addr::from)
    }

    /// Every address in a list-of-addresses option. A trailing partial address
    /// is dropped rather than padded into an address nobody sent.
    #[must_use]
    pub fn ipv4_list(&self, code: u8) -> Vec<Ipv4Addr> {
        self.get(code)
            .map(|value| {
                let (addresses, _) = value.as_chunks::<4>();
                addresses
                    .iter()
                    .map(|c| Ipv4Addr::new(c[0], c[1], c[2], c[3]))
                    .collect()
            })
            .unwrap_or_default()
    }

    /// A text option, sanitised for display.
    ///
    /// Trailing NULs are dropped (plenty of firmware NUL-terminates), control
    /// characters are replaced, and the result is truncated: this string reaches
    /// a log line and the UI.
    #[must_use]
    pub fn text(&self, code: u8) -> Option<String> {
        let raw = self.get(code)?;
        let last = raw.iter().rposition(|b| *b != 0)?;
        let trimmed: &[u8] = &raw[..=last];
        Some(sanitize_text(&String::from_utf8_lossy(trimmed)))
    }

    /// A text option decoded in full for protocol decisions.
    ///
    /// The display-facing [`Self::text`] truncates hostile client-controlled
    /// strings before they reach logs and the UI. Protocol gates need the
    /// complete value the client sent.
    #[must_use]
    pub fn text_full(&self, code: u8) -> Option<String> {
        let raw = self.get(code)?;
        let last = raw.iter().rposition(|b| *b != 0)?;
        let trimmed: &[u8] = &raw[..=last];
        Some(String::from_utf8_lossy(trimmed).into_owned())
    }

    #[must_use]
    pub fn message_type(&self) -> Option<MessageType> {
        MessageType::from_wire(self.u8(OPTION_MESSAGE_TYPE)?)
    }

    /// Records a value, concatenating with any previous instance of the same
    /// code (RFC 3396 splits a long option across several instances).
    fn append(&mut self, code: u8, value: &[u8]) {
        self.0.entry(code).or_default().extend_from_slice(value);
    }

    /// Inserts a value outright. Test and builder use only.
    pub fn set(&mut self, code: u8, value: impl Into<Vec<u8>>) {
        self.0.insert(code, value.into());
    }
}

/// Replaces control characters and truncates operator-facing text.
#[must_use]
pub fn sanitize_text(text: &str) -> String {
    let mut out = String::new();
    for c in text.chars().take(MAX_ECHOED_TEXT) {
        // Substituted before it is measured: U+FFFD is three bytes where the
        // control character it replaces was one, so accounting for the original
        // would under-count exactly the hostile case this bound exists for.
        let c = if c.is_control() { '\u{fffd}' } else { c };
        if out.len() + c.len_utf8() > MAX_ECHOED_TEXT_BYTES {
            break;
        }
        out.push(c);
    }
    out
}

/// Parses an option region.
///
/// The contract, stated as an invariant rather than as a comment on one line:
/// **no byte of a value is read until its declared length has been compared
/// against the bytes that remain.** `Reader::take` performs that comparison and
/// is the only way a value is obtained.
///
/// A truncated option is an error, not a silent stop. Stopping silently is
/// attractive — it keeps a slightly-malformed packet usable — but it also lets a
/// crafted packet hide options behind a bad length byte, and it turns "the
/// device is sending us something we cannot parse" into "the device is not
/// sending it at all", which nobody can diagnose from a log.
pub fn parse_options(reader: &mut Reader<'_>, into: &mut Options) -> Result<(), DecodeError> {
    loop {
        if reader.is_empty() {
            // Running out without an END marker is common enough in the wild
            // (the field is simply not padded) that refusing here would reject
            // working hardware. Everything already parsed stands.
            return Ok(());
        }
        let code = reader.u8("option code")?;
        match code {
            OPTION_PAD => continue,
            OPTION_END => return Ok(()),
            _ => {}
        }
        if reader.is_empty() {
            return Err(DecodeError::OptionMissingLength { code });
        }
        let declared = usize::from(reader.u8("option length")?);
        // The check. `declared` came off the wire; `remaining` is ground truth.
        let available = reader.remaining();
        if declared > available {
            return Err(DecodeError::OptionTruncated { code, declared, available });
        }
        let value = reader.take(declared, "option value")?;
        into.append(code, value);
    }
}

// ---------------------------------------------------------------------------
// Message
// ---------------------------------------------------------------------------

/// A decoded DHCP message.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Message {
    pub op: u8,
    pub htype: u8,
    pub hops: u8,
    pub xid: u32,
    pub secs: u16,
    pub flags: u16,
    pub ciaddr: Ipv4Addr,
    pub yiaddr: Ipv4Addr,
    pub siaddr: Ipv4Addr,
    pub giaddr: Ipv4Addr,
    /// Exactly `hlen` bytes — the hardware address, without the field's padding.
    pub chaddr: Vec<u8>,
    /// Server host name. Empty unless option overload put options here.
    pub sname: Vec<u8>,
    /// Boot file name.
    pub file: Vec<u8>,
    pub options: Options,
}

impl Message {
    /// Decodes a datagram.
    ///
    /// Fails rather than guessing on every malformed shape, and never panics:
    /// this is the entry point for unauthenticated LAN traffic.
    pub fn decode(buf: &[u8]) -> Result<Self, DecodeError> {
        let mut reader = Reader::new(buf);

        let op = reader.u8("op")?;
        if op != OP_BOOTREQUEST && op != OP_BOOTREPLY {
            return Err(DecodeError::BadOperation(op));
        }
        let htype = reader.u8("htype")?;
        let hlen = reader.u8("hlen")?;
        let hops = reader.u8("hops")?;
        let xid = reader.u32("xid")?;
        let secs = reader.u16("secs")?;
        let flags = reader.u16("flags")?;
        let ciaddr = reader.ipv4("ciaddr")?;
        let yiaddr = reader.ipv4("yiaddr")?;
        let siaddr = reader.ipv4("siaddr")?;
        let giaddr = reader.ipv4("giaddr")?;

        // `hlen` is a length byte from the packet, so it is bounded before it is
        // used to slice anything — the same rule as an option's length.
        let hardware_len = usize::from(hlen);
        if hlen == 0 || hardware_len > MAX_HARDWARE_LEN {
            return Err(DecodeError::BadHardwareLength(hlen));
        }
        let hardware_field = reader.take(MAX_HARDWARE_LEN, "chaddr")?;
        let hardware = hardware_field
            .get(..hardware_len)
            .ok_or(DecodeError::BadHardwareLength(hlen))?
            .to_vec();

        let sname = reader.take(64, "sname")?.to_vec();
        let file = reader.take(128, "file")?.to_vec();

        let cookie = reader.take(MAGIC_COOKIE.len(), "magic cookie")?;
        if cookie != MAGIC_COOKIE {
            let mut seen = [0u8; 4];
            seen.copy_from_slice(cookie);
            return Err(DecodeError::BadMagicCookie(seen));
        }

        let mut options = Options::new();
        parse_options(&mut reader, &mut options)?;

        // RFC 2131 §4.1.3: option 52 says the `file` and/or `sname` fields carry
        // options too. The overload byte is read only from the main region, so a
        // packet cannot point the parser at a region it has already consumed.
        let overload = options.u8(OPTION_OVERLOAD).unwrap_or(0);
        if overload & 0b01 != 0 {
            parse_options(&mut Reader::new(&file), &mut options)?;
        }
        if overload & 0b10 != 0 {
            parse_options(&mut Reader::new(&sname), &mut options)?;
        }

        Ok(Self {
            op,
            htype,
            hops,
            xid,
            secs,
            flags,
            ciaddr,
            yiaddr,
            siaddr,
            giaddr,
            chaddr: hardware,
            sname,
            file,
            options,
        })
    }

    /// Whether the client asked for its reply to be broadcast, either by setting
    /// the broadcast flag or by having no address to be unicast to yet.
    #[must_use]
    pub fn wants_broadcast(&self) -> bool {
        self.flags & crate::constants::FLAG_BROADCAST != 0 || self.ciaddr.is_unspecified()
    }

    #[must_use]
    pub fn hardware_key(&self) -> crate::net::MacKey {
        crate::net::MacKey::from_hardware(&self.chaddr)
    }
}

// ---------------------------------------------------------------------------
// Encoding
// ---------------------------------------------------------------------------

/// Builds an option region with the same length discipline as the parser.
#[derive(Debug, Default)]
pub struct OptionsBuilder {
    buf: Vec<u8>,
}

impl OptionsBuilder {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Appends `[code][len][value…]`.
    ///
    /// Refuses a value the length field cannot describe instead of truncating
    /// it. A truncated option is worse than a missing one: the device parses
    /// whatever the short value happens to say, and nothing anywhere reports a
    /// problem.
    pub fn put(&mut self, code: u8, value: &[u8]) -> Result<&mut Self, EncodeError> {
        if code == OPTION_PAD || code == OPTION_END {
            return Err(EncodeError::ReservedOptionCode(code));
        }
        if value.len() > MAX_OPTION_VALUE_BYTES {
            return Err(EncodeError::OptionTooLong { code, len: value.len() });
        }
        self.buf.push(code);
        // Proven to fit by the check above.
        self.buf.push(value.len() as u8);
        self.buf.extend_from_slice(value);
        Ok(self)
    }

    pub fn put_u8(&mut self, code: u8, value: u8) -> Result<&mut Self, EncodeError> {
        self.put(code, &[value])
    }

    pub fn put_u32(&mut self, code: u8, value: u32) -> Result<&mut Self, EncodeError> {
        self.put(code, &value.to_be_bytes())
    }

    pub fn put_ipv4(&mut self, code: u8, value: Ipv4Addr) -> Result<&mut Self, EncodeError> {
        self.put(code, &value.octets())
    }

    /// Appends a list-of-addresses option, refusing a list that cannot fit.
    pub fn put_ipv4_list(
        &mut self,
        code: u8,
        values: &[Ipv4Addr],
    ) -> Result<&mut Self, EncodeError> {
        if values.is_empty() {
            return Ok(self);
        }
        if values.len() * 4 > MAX_OPTION_VALUE_BYTES {
            return Err(EncodeError::TooManyAddresses { code, count: values.len() });
        }
        let mut bytes = Vec::with_capacity(values.len() * 4);
        for value in values {
            bytes.extend_from_slice(&value.octets());
        }
        self.put(code, &bytes)
    }

    /// Appends a text option, as UTF-8 bytes with no NUL terminator.
    pub fn put_text(&mut self, code: u8, value: &str) -> Result<&mut Self, EncodeError> {
        self.put(code, value.as_bytes())
    }

    #[must_use]
    pub fn finish(mut self) -> Vec<u8> {
        self.buf.push(OPTION_END);
        self.buf
    }

    #[must_use]
    pub fn len(&self) -> usize {
        self.buf.len()
    }

    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.buf.is_empty()
    }
}

/// A reply under construction: the fixed header plus a built option region.
#[derive(Debug)]
pub struct ReplyBuilder {
    pub xid: u32,
    pub secs: u16,
    pub flags: u16,
    pub ciaddr: Ipv4Addr,
    pub yiaddr: Ipv4Addr,
    pub siaddr: Ipv4Addr,
    pub giaddr: Ipv4Addr,
    pub chaddr: Vec<u8>,
}

impl ReplyBuilder {
    /// Seeds a reply from the request it answers, per RFC 2131 §4.3.
    #[must_use]
    pub fn for_request(request: &Message) -> Self {
        Self {
            xid: request.xid,
            secs: 0,
            flags: request.flags,
            ciaddr: Ipv4Addr::UNSPECIFIED,
            yiaddr: Ipv4Addr::UNSPECIFIED,
            siaddr: Ipv4Addr::UNSPECIFIED,
            giaddr: request.giaddr,
            chaddr: request.chaddr.clone(),
        }
    }

    /// Serialises the reply.
    ///
    /// `sname` and `file` are left zeroed: this server carries boot information
    /// in options 66/67, which is the only mechanism a client is guaranteed to
    /// read when the fields might be overloaded.
    #[must_use]
    pub fn encode(&self, options: &[u8]) -> Vec<u8> {
        let mut out = Vec::with_capacity(MIN_REPLY_LEN.max(MIN_PACKET_LEN + options.len()));
        out.push(OP_BOOTREPLY);
        out.push(HTYPE_ETHERNET);
        // The hardware length echoed back is the one actually carried, clamped
        // to the field — never a number taken from the request unchecked.
        let hlen = self.chaddr.len().min(MAX_HARDWARE_LEN);
        out.push(u8::try_from(hlen).unwrap_or(ETHERNET_HLEN));
        out.push(0); // hops: a server never sets this
        out.extend_from_slice(&self.xid.to_be_bytes());
        out.extend_from_slice(&self.secs.to_be_bytes());
        out.extend_from_slice(&self.flags.to_be_bytes());
        out.extend_from_slice(&self.ciaddr.octets());
        out.extend_from_slice(&self.yiaddr.octets());
        out.extend_from_slice(&self.siaddr.octets());
        out.extend_from_slice(&self.giaddr.octets());

        let mut hardware = [0u8; MAX_HARDWARE_LEN];
        for (slot, byte) in hardware.iter_mut().zip(self.chaddr.iter()) {
            *slot = *byte;
        }
        out.extend_from_slice(&hardware);
        out.extend_from_slice(&[0u8; 64]); // sname
        out.extend_from_slice(&[0u8; 128]); // file
        out.extend_from_slice(&MAGIC_COOKIE);
        out.extend_from_slice(options);
        if out.len() < MIN_REPLY_LEN {
            out.resize(MIN_REPLY_LEN, 0);
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::constants::{
        OPTION_HOSTNAME, OPTION_LEASE_TIME, OPTION_REQUESTED_IP, OPTION_SERVER_ID,
    };
    use crate::testsupport::PacketBuilder;

    #[test]
    fn a_well_formed_discover_round_trips_its_fields() {
        let packet = PacketBuilder::new(&[0xAA, 0xBB, 0xCC, 0x00, 0x00, 0x0A])
            .xid(0x1234_5678)
            .message_type(1)
            .option(OPTION_HOSTNAME, b"bench-switch")
            .build();
        let message = Message::decode(&packet).expect("a well-formed packet decodes");
        assert_eq!(message.op, OP_BOOTREQUEST);
        assert_eq!(message.xid, 0x1234_5678);
        assert_eq!(message.chaddr, vec![0xAA, 0xBB, 0xCC, 0x00, 0x00, 0x0A]);
        assert_eq!(message.options.message_type(), Some(MessageType::Discover));
        assert_eq!(message.options.text(OPTION_HOSTNAME).as_deref(), Some("bench-switch"));
        assert_eq!(message.hardware_key().as_str(), "AA-BB-CC-00-00-0A");
    }

    // -- the hardening property ---------------------------------------------

    #[test]
    fn an_option_length_longer_than_the_buffer_is_a_named_error_not_a_panic() {
        // The exact shape audited in `dhcp@0.2.20`: a length byte that promises
        // more than the packet contains, in front of an option whose code
        // implies a numeric read.
        let mut packet = PacketBuilder::new(&[1, 2, 3, 4, 5, 6]).message_type(1).build();
        // Replace the END marker with `[code 51][len 4]` and stop — the four
        // bytes of lease time are simply not there.
        let end = packet
            .iter()
            .rposition(|b| *b == OPTION_END)
            .expect("the builder wrote an END marker");
        packet.truncate(end);
        packet.push(OPTION_LEASE_TIME);
        packet.push(4);

        let error = Message::decode(&packet).expect_err("a truncated option must not decode");
        assert_eq!(
            error,
            DecodeError::OptionTruncated { code: OPTION_LEASE_TIME, declared: 4, available: 0 }
        );
    }

    #[test]
    fn an_option_length_that_overruns_by_one_byte_is_caught() {
        let mut packet = PacketBuilder::new(&[1, 2, 3, 4, 5, 6]).message_type(1).build();
        let end = packet.iter().rposition(|b| *b == OPTION_END).unwrap();
        packet.truncate(end);
        packet.push(OPTION_REQUESTED_IP);
        packet.push(4);
        packet.extend_from_slice(&[10, 0, 0]); // one byte short

        assert_eq!(
            Message::decode(&packet),
            Err(DecodeError::OptionTruncated { code: OPTION_REQUESTED_IP, declared: 4, available: 3 })
        );
    }

    #[test]
    fn an_option_code_with_no_length_byte_is_caught() {
        let mut packet = PacketBuilder::new(&[1, 2, 3, 4, 5, 6]).message_type(1).build();
        let end = packet.iter().rposition(|b| *b == OPTION_END).unwrap();
        packet.truncate(end);
        packet.push(OPTION_HOSTNAME);
        assert_eq!(
            Message::decode(&packet),
            Err(DecodeError::OptionMissingLength { code: OPTION_HOSTNAME })
        );
    }

    #[test]
    fn a_maximum_length_option_is_accepted_exactly_at_the_boundary() {
        let value = vec![b'x'; MAX_OPTION_VALUE_BYTES];
        let packet = PacketBuilder::new(&[1, 2, 3, 4, 5, 6])
            .message_type(1)
            .option(OPTION_HOSTNAME, &value)
            .build();
        let message = Message::decode(&packet).expect("255 bytes is a legal option value");
        assert_eq!(message.options.get(OPTION_HOSTNAME).map(<[u8]>::len), Some(255));
    }

    #[test]
    fn every_truncation_of_a_valid_packet_errors_rather_than_panicking() {
        // Fuzzing-style: a valid packet cut at every possible length must either
        // decode or return an error. Neither a panic nor a hang is acceptable.
        let packet = PacketBuilder::new(&[0xDE, 0xAD, 0xBE, 0xEF, 0x00, 0x01])
            .message_type(3)
            .option(OPTION_REQUESTED_IP, &[10, 0, 0, 7])
            .option(OPTION_SERVER_ID, &[10, 0, 0, 1])
            .option(OPTION_HOSTNAME, b"device")
            .build();
        for cut in 0..packet.len() {
            let _ = Message::decode(&packet[..cut]);
        }
    }

    #[test]
    fn arbitrary_bytes_never_panic_the_decoder() {
        // A cheap deterministic sweep over shapes a scanner produces: random-ish
        // payloads, all-zero, all-0xFF, and every single-byte packet.
        let mut seed = 0x1234_5678u32;
        for size in [0usize, 1, 4, 63, 236, 239, 240, 241, 300, 512, 1500] {
            for _ in 0..64 {
                let mut buf = vec![0u8; size];
                for byte in &mut buf {
                    // xorshift — deterministic, no dependency.
                    seed ^= seed << 13;
                    seed ^= seed >> 17;
                    seed ^= seed << 5;
                    *byte = (seed & 0xFF) as u8;
                }
                let _ = Message::decode(&buf);
            }
            let _ = Message::decode(&vec![0u8; size]);
            let _ = Message::decode(&vec![0xFFu8; size]);
        }
        for byte in 0..=255u8 {
            let _ = Message::decode(&[byte]);
        }
    }

    #[test]
    fn a_packet_without_the_magic_cookie_is_refused() {
        let mut packet = PacketBuilder::new(&[1, 2, 3, 4, 5, 6]).message_type(1).build();
        packet[FIXED_HEADER_LEN] = 0x00;
        assert!(matches!(
            Message::decode(&packet),
            Err(DecodeError::BadMagicCookie(_))
        ));
    }

    #[test]
    fn an_impossible_hardware_length_is_refused_before_it_slices_anything() {
        for hlen in [0u8, 17, 200, 255] {
            let mut packet = PacketBuilder::new(&[1, 2, 3, 4, 5, 6]).message_type(1).build();
            packet[2] = hlen;
            assert_eq!(
                Message::decode(&packet),
                Err(DecodeError::BadHardwareLength(hlen)),
                "hlen {hlen} must be refused"
            );
        }
    }

    #[test]
    fn an_unknown_bootp_operation_is_refused() {
        let mut packet = PacketBuilder::new(&[1, 2, 3, 4, 5, 6]).message_type(1).build();
        packet[0] = 9;
        assert_eq!(Message::decode(&packet), Err(DecodeError::BadOperation(9)));
    }

    #[test]
    fn a_numeric_option_of_the_wrong_length_reads_as_absent_not_as_a_wrong_number() {
        // Both directions matter, and the long one is the easier to get wrong:
        // reading the first four bytes of a six-byte value yields a number that
        // looks entirely plausible and is not the one the client sent.
        for value in [&[0u8, 0, 30][..], &[0, 0, 0, 30, 99, 99][..], &[][..], &[7][..]] {
            let packet = PacketBuilder::new(&[1, 2, 3, 4, 5, 6])
                .message_type(1)
                .option(OPTION_LEASE_TIME, value)
                .build();
            let message = Message::decode(&packet).expect("the packet itself is well formed");
            assert_eq!(
                message.options.u32(OPTION_LEASE_TIME),
                None,
                "{} bytes must not be read as a lease time",
                value.len()
            );
        }
        // And exactly four is read.
        let packet = PacketBuilder::new(&[1, 2, 3, 4, 5, 6])
            .message_type(1)
            .option(OPTION_LEASE_TIME, &[0, 0, 0, 30])
            .build();
        assert_eq!(
            Message::decode(&packet).unwrap().options.u32(OPTION_LEASE_TIME),
            Some(30)
        );
    }

    #[test]
    fn pad_bytes_are_skipped_and_end_stops_the_parse() {
        let mut region = vec![OPTION_PAD, OPTION_PAD];
        region.extend_from_slice(&[OPTION_HOSTNAME, 2, b'h', b'i']);
        region.push(OPTION_END);
        // Anything after END must not be parsed.
        region.extend_from_slice(&[OPTION_LEASE_TIME, 4, 9, 9, 9, 9]);
        let mut options = Options::new();
        parse_options(&mut Reader::new(&region), &mut options).expect("parses");
        assert_eq!(options.text(OPTION_HOSTNAME).as_deref(), Some("hi"));
        assert!(!options.contains(OPTION_LEASE_TIME), "bytes after END are not options");
    }

    #[test]
    fn a_split_option_is_reassembled_rather_than_last_write_wins() {
        // RFC 3396: a value too long for one instance arrives as several.
        let region = vec![
            OPTION_HOSTNAME, 3, b'a', b'b', b'c',
            OPTION_HOSTNAME, 2, b'd', b'e',
            OPTION_END,
        ];
        let mut options = Options::new();
        parse_options(&mut Reader::new(&region), &mut options).expect("parses");
        assert_eq!(options.text(OPTION_HOSTNAME).as_deref(), Some("abcde"));
    }

    #[test]
    fn overloaded_file_and_sname_fields_are_parsed_as_options() {
        let mut packet = PacketBuilder::new(&[1, 2, 3, 4, 5, 6])
            .message_type(1)
            .option(OPTION_OVERLOAD, &[3])
            .build();
        // `file` starts at 44 + 64 = 108; `sname` at 44.
        let sname_at = 44;
        let file_at = sname_at + 64;
        packet[file_at..file_at + 7]
            .copy_from_slice(&[OPTION_REQUESTED_IP, 4, 10, 0, 0, 9, OPTION_END]);
        packet[sname_at..sname_at + 5].copy_from_slice(&[OPTION_HOSTNAME, 2, b'o', b'k', OPTION_END]);

        let message = Message::decode(&packet).expect("overloaded fields decode");
        assert_eq!(
            message.options.ipv4(OPTION_REQUESTED_IP),
            Some(Ipv4Addr::new(10, 0, 0, 9))
        );
        assert_eq!(message.options.text(OPTION_HOSTNAME).as_deref(), Some("ok"));
    }

    #[test]
    fn a_truncated_option_inside_an_overloaded_field_is_caught_too() {
        let mut packet = PacketBuilder::new(&[1, 2, 3, 4, 5, 6])
            .message_type(1)
            .option(OPTION_OVERLOAD, &[1])
            .build();
        let file_at = 44 + 64;
        // A length byte promising more than the 128-byte field can deliver.
        packet[file_at] = OPTION_HOSTNAME;
        packet[file_at + 1] = 255;
        assert_eq!(
            Message::decode(&packet),
            Err(DecodeError::OptionTruncated {
                code: OPTION_HOSTNAME,
                declared: 255,
                available: 126
            })
        );
    }

    #[test]
    fn hostile_text_is_stripped_of_control_characters_and_truncated() {
        let mut value = b"lab\x07\x1b[31mred".to_vec();
        value.extend_from_slice(&vec![b'z'; 400]);
        let packet = PacketBuilder::new(&[1, 2, 3, 4, 5, 6])
            .message_type(1)
            .option(OPTION_HOSTNAME, &value[..200])
            .build();
        let message = Message::decode(&packet).unwrap();
        let text = message.options.text(OPTION_HOSTNAME).unwrap();
        assert!(!text.contains('\x1b'), "an escape sequence must not reach the log");
        assert!(text.chars().count() <= MAX_ECHOED_TEXT);
    }

    #[test]
    fn sanitized_text_fits_the_byte_bound_the_host_parses_it_with() {
        // `from_utf8_lossy` expands every invalid byte to U+FFFD, which is three
        // bytes, so a cap counted in `char`s admits 200 of them — 600 bytes. The
        // extension host parses a lease hostname with a 255-byte bound and treats
        // anything longer as a malformed RPC result, which terminates the running
        // daemon. A single option 12 of invalid bytes would therefore stop the
        // DHCP service from off the LAN, unauthenticated.
        let packet = PacketBuilder::new(&[1, 2, 3, 4, 5, 6])
            .message_type(1)
            .option(OPTION_HOSTNAME, &[0xffu8; 255])
            .build();
        let message = Message::decode(&packet).unwrap();
        let text = message.options.text(OPTION_HOSTNAME).unwrap();
        assert!(
            text.len() <= MAX_ECHOED_TEXT_BYTES,
            "sanitized text must fit the host's DHCP field bound; got {} bytes",
            text.len()
        );
        assert!(!text.is_empty(), "a bounded hostname is still worth showing");
    }

    #[test]
    fn a_byte_bounded_hostname_is_cut_on_a_character_boundary() {
        // Bounding by bytes must not split a multi-byte character: a `String`
        // cannot hold half of one, and truncating to a byte index inside a
        // sequence would panic rather than shorten.
        let wide = "\u{1f600}".repeat(120); // 4 bytes each, 480 bytes total
        let text = sanitize_text(&wide);
        assert!(text.len() <= MAX_ECHOED_TEXT_BYTES);
        assert!(
            text.chars().all(|c| c == '\u{1f600}'),
            "every retained character must have survived whole"
        );
    }

    // -- encoding ------------------------------------------------------------

    #[test]
    fn an_option_value_too_long_for_its_length_byte_is_refused() {
        let mut builder = OptionsBuilder::new();
        let error = builder
            .put(OPTION_HOSTNAME, &vec![0u8; 256])
            .expect_err("256 bytes cannot be length-prefixed by one byte");
        assert_eq!(error, EncodeError::OptionTooLong { code: OPTION_HOSTNAME, len: 256 });
        // And exactly 255 is fine.
        assert!(builder.put(OPTION_HOSTNAME, &vec![0u8; 255]).is_ok());
    }

    #[test]
    fn the_structural_option_codes_cannot_be_written_as_data() {
        let mut builder = OptionsBuilder::new();
        assert_eq!(
            builder.put(OPTION_PAD, b"x").map(|_| ()),
            Err(EncodeError::ReservedOptionCode(OPTION_PAD))
        );
        assert_eq!(
            builder.put(OPTION_END, b"x").map(|_| ()),
            Err(EncodeError::ReservedOptionCode(OPTION_END))
        );
    }

    #[test]
    fn an_address_list_that_cannot_fit_is_refused_rather_than_clipped() {
        let mut builder = OptionsBuilder::new();
        let many: Vec<Ipv4Addr> = (0..64).map(|i| Ipv4Addr::new(10, 0, 0, i)).collect();
        assert_eq!(
            builder.put_ipv4_list(crate::constants::OPTION_DNS, &many).map(|_| ()),
            Err(EncodeError::TooManyAddresses { code: crate::constants::OPTION_DNS, count: 64 })
        );
        // 63 addresses is 252 bytes and fits.
        assert!(builder.put_ipv4_list(crate::constants::OPTION_DNS, &many[..63]).is_ok());
    }

    #[test]
    fn a_reply_is_padded_to_the_bootp_minimum_and_decodes_again() {
        let request = Message::decode(
            &PacketBuilder::new(&[0xAA, 0xBB, 0xCC, 0xDD, 0xEE, 0xFF])
                .xid(7)
                .message_type(1)
                .build(),
        )
        .unwrap();
        let mut reply = ReplyBuilder::for_request(&request);
        reply.yiaddr = Ipv4Addr::new(10, 0, 0, 42);
        let mut options = OptionsBuilder::new();
        options.put_u8(OPTION_MESSAGE_TYPE, MessageType::Offer.as_wire()).unwrap();
        options.put_ipv4(OPTION_SERVER_ID, Ipv4Addr::new(10, 0, 0, 1)).unwrap();
        let bytes = reply.encode(&options.finish());

        assert!(bytes.len() >= MIN_REPLY_LEN, "short replies are dropped by some firmware");
        let decoded = Message::decode(&bytes).expect("our own reply must decode");
        assert_eq!(decoded.op, OP_BOOTREPLY);
        assert_eq!(decoded.xid, 7);
        assert_eq!(decoded.yiaddr, Ipv4Addr::new(10, 0, 0, 42));
        assert_eq!(decoded.options.message_type(), Some(MessageType::Offer));
        assert_eq!(decoded.chaddr, vec![0xAA, 0xBB, 0xCC, 0xDD, 0xEE, 0xFF]);
    }
}
