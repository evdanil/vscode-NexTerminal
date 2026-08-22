//! Binary encoding and parsing of TFTP packets.
//!
//! Per RFC 1350 §4 every multi-byte integer is network byte order (big endian)
//! and every string is NUL-terminated:
//!
//! ```text
//! RRQ/WRQ  [2B opcode] filename 0 mode 0 (opt 0 value 0)*
//! DATA     [2B opcode] [2B block#] data…
//! ACK      [2B opcode] [2B block#]
//! ERROR    [2B opcode] [2B code] message 0
//! OACK     [2B opcode] (opt 0 value 0)*        (RFC 2347 §3)
//! ```

use crate::types::{
    ErrorCode, Opcode, Packet, RawOptions, Request, TransferMode, ValidatedOptions, BLKSIZE_MAX,
    BLKSIZE_MIN, DATA_HEADER_LEN, DEFAULT_BLOCK_SIZE, DEFAULT_WINDOW_SIZE, MAX_IN_FLIGHT_BYTES,
    TIMEOUT_MAX, TIMEOUT_MIN, WINDOWSIZE_MAX, WINDOWSIZE_MIN,
};
use std::fmt;

/// A received packet violates the TFTP wire format.
///
/// This is a wire-level fault, not a transfer-state one: the engine answers it
/// with ERROR(IllegalOperation) — or ERROR(OptionNegotiation) for the option
/// validator — and abandons the session.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProtocolError(pub String);

impl fmt::Display for ProtocolError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for ProtocolError {}

impl ProtocolError {
    fn new(message: impl Into<String>) -> Self {
        Self(message.into())
    }
}

type Result<T> = std::result::Result<T, ProtocolError>;

/// Upper bound on a client-supplied filename, in bytes.
///
/// Not from any RFC — RFC 1350 leaves the filename length open, bounded only by
/// the datagram. The cap exists because the filename is *echoed*: it lands in
/// `log` and `connection` events that cross the stdout pipe and end up in the
/// host's output channel and in user-facing notifications. Without a cap, one
/// bogus 60 KB RRQ becomes 60 KB of log traffic per request — an amplification
/// into the UI that costs the attacker a single datagram. 1024 bytes is far
/// above any real path a network device boots from (`PATH_MAX` is 4096 on Linux
/// and 260 on default Windows) and far below anything that hurts.
pub const MAX_FILENAME_BYTES: usize = 1024;

/// Splits a byte slice into NUL-separated strings.
///
/// Trailing bytes with no NUL terminator are returned as a final token, which
/// keeps a truncated-but-otherwise-valid request parseable (the caller's own
/// field-count check decides whether it is usable).
///
/// Strings are required to be valid UTF-8. This is stricter than the reference
/// implementation, which decoded as "ascii" and silently masked the high bit of
/// every byte — turning `0xC0` into `@` and thereby aliasing distinct wire
/// filenames onto the same string. Refusing is both simpler to reason about and
/// impossible to smuggle anything through.
fn split_nul_strings(buf: &[u8]) -> Result<Vec<String>> {
    let mut parts = Vec::new();
    let mut start = 0usize;
    for (i, byte) in buf.iter().enumerate() {
        if *byte == 0 {
            parts.push(decode_ascii_field(&buf[start..i])?);
            start = i + 1;
        }
    }
    if start < buf.len() {
        parts.push(decode_ascii_field(&buf[start..])?);
    }
    // A well-formed request ends with a NUL, which yields no trailing token.
    // A peer that appends a stray NUL produces one empty trailing token; drop
    // it so the caller's "odd number of option tokens" check stays meaningful.
    if parts.last().is_some_and(String::is_empty) {
        parts.pop();
    }
    Ok(parts)
}

fn decode_ascii_field(bytes: &[u8]) -> Result<String> {
    std::str::from_utf8(bytes)
        .map(str::to_owned)
        .map_err(|_| ProtocolError::new("Field is not valid UTF-8"))
}

fn write_nul_string(out: &mut Vec<u8>, value: &str) {
    out.extend_from_slice(value.as_bytes());
    out.push(0);
}

fn write_option_pairs(out: &mut Vec<u8>, options: &RawOptions) {
    for (key, value) in options.pairs() {
        write_nul_string(out, key);
        write_nul_string(out, value);
    }
}

/// Reads the opcode (first two big-endian bytes) of a raw datagram.
///
/// Returns `None` for a datagram shorter than the opcode itself.
#[must_use]
pub fn peek_opcode(buf: &[u8]) -> Option<u16> {
    match buf {
        [hi, lo, ..] => Some(u16::from_be_bytes([*hi, *lo])),
        _ => None,
    }
}

#[must_use]
pub fn encode_rrq(filename: &str, mode: &str, options: &RawOptions) -> Vec<u8> {
    encode_request(Opcode::Rrq, filename, mode, options)
}

#[must_use]
pub fn encode_wrq(filename: &str, mode: &str, options: &RawOptions) -> Vec<u8> {
    encode_request(Opcode::Wrq, filename, mode, options)
}

fn encode_request(opcode: Opcode, filename: &str, mode: &str, options: &RawOptions) -> Vec<u8> {
    let mut out = Vec::with_capacity(2 + filename.len() + mode.len() + 2);
    out.extend_from_slice(&opcode.to_wire().to_be_bytes());
    write_nul_string(&mut out, filename);
    write_nul_string(&mut out, mode);
    write_option_pairs(&mut out, options);
    out
}

/// Encodes a DATA packet. A payload shorter than the negotiated `blksize`
/// signals the last block of the transfer (RFC 1350 §9).
#[must_use]
pub fn encode_data(block: u16, data: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(DATA_HEADER_LEN + data.len());
    out.extend_from_slice(&Opcode::Data.to_wire().to_be_bytes());
    out.extend_from_slice(&block.to_be_bytes());
    out.extend_from_slice(data);
    out
}

#[must_use]
pub fn encode_ack(block: u16) -> Vec<u8> {
    let mut out = Vec::with_capacity(4);
    out.extend_from_slice(&Opcode::Ack.to_wire().to_be_bytes());
    out.extend_from_slice(&block.to_be_bytes());
    out
}

/// Encodes an ERROR packet, defaulting the text to the RFC 1350 §5.1 wording.
#[must_use]
pub fn encode_error(code: ErrorCode, message: Option<&str>) -> Vec<u8> {
    let text = message.unwrap_or_else(|| code.default_message());
    let mut out = Vec::with_capacity(5 + text.len());
    out.extend_from_slice(&Opcode::Error.to_wire().to_be_bytes());
    out.extend_from_slice(&code.to_wire().to_be_bytes());
    write_nul_string(&mut out, text);
    out
}

/// Encodes an OACK (RFC 2347 §3) carrying only the options the server accepted.
#[must_use]
pub fn encode_oack(options: &RawOptions) -> Vec<u8> {
    let mut out = Vec::with_capacity(16);
    out.extend_from_slice(&Opcode::Oack.to_wire().to_be_bytes());
    write_option_pairs(&mut out, options);
    out
}

/// Parses a complete datagram.
///
/// `Ok(None)` means the opcode is not one this implementation knows; that is
/// deliberately not an error (see [`Opcode::from_wire`]).
pub fn parse_packet(buf: &[u8]) -> Result<Option<Packet>> {
    let Some(raw_opcode) = peek_opcode(buf) else {
        return Err(ProtocolError::new("Packet too short"));
    };
    let payload = &buf[2..];
    let Some(opcode) = Opcode::from_wire(raw_opcode) else {
        return Ok(None);
    };
    let packet = match opcode {
        Opcode::Rrq => Packet::Rrq(parse_request(payload, "RRQ")?),
        Opcode::Wrq => Packet::Wrq(parse_request(payload, "WRQ")?),
        Opcode::Data => {
            let (block, rest) = split_block_number(payload, "DATA")?;
            Packet::Data {
                block,
                data: rest.to_vec(),
            }
        }
        Opcode::Ack => {
            let (block, _) = split_block_number(payload, "ACK")?;
            Packet::Ack { block }
        }
        Opcode::Error => {
            let (code, rest) = split_block_number(payload, "ERROR")?;
            // The message is not required to be NUL-terminated by every peer in
            // the field, so accept the remainder either way.
            let end = rest.iter().position(|b| *b == 0).unwrap_or(rest.len());
            Packet::Error {
                code,
                message: String::from_utf8_lossy(&rest[..end]).into_owned(),
            }
        }
        Opcode::Oack => Packet::Oack {
            options: parse_option_pairs(payload)?,
        },
    };
    Ok(Some(packet))
}

fn split_block_number<'a>(payload: &'a [u8], label: &str) -> Result<(u16, &'a [u8])> {
    if payload.len() < 2 {
        return Err(ProtocolError::new(format!("{label} too short")));
    }
    Ok((
        u16::from_be_bytes([payload[0], payload[1]]),
        &payload[2..],
    ))
}

fn parse_option_pairs(payload: &[u8]) -> Result<RawOptions> {
    let tokens = split_nul_strings(payload)?;
    collect_options(&tokens)
}

fn collect_options(tokens: &[String]) -> Result<RawOptions> {
    if !tokens.len().is_multiple_of(2) {
        return Err(ProtocolError::new(
            "Malformed option list (odd token count)",
        ));
    }
    let mut options = RawOptions::default();
    for pair in tokens.chunks_exact(2) {
        // Unrecognised keys are dropped, per RFC 2347 §3.
        options.set(&pair[0], &pair[1]);
    }
    Ok(options)
}

fn parse_request(payload: &[u8], label: &str) -> Result<Request> {
    let tokens = split_nul_strings(payload)?;
    if tokens.len() < 2 {
        return Err(ProtocolError::new(format!("{label} too short")));
    }
    let filename = tokens[0].clone();
    if filename.is_empty() {
        return Err(ProtocolError::new("Empty filename"));
    }
    if filename.len() > MAX_FILENAME_BYTES {
        return Err(ProtocolError::new(format!(
            "Filename exceeds {MAX_FILENAME_BYTES} bytes"
        )));
    }
    let mode = tokens[1].to_ascii_lowercase();
    let mode = match mode.as_str() {
        "octet" => TransferMode::Octet,
        // `netascii` (RFC 1350 §2) is a transform, not a label: the sender
        // rewrites its host line endings to CR/LF on the wire and the receiver
        // rewrites them back. This engine does neither — RRQ and WRQ are raw
        // byte operations end to end — so accepting the mode corrupted every
        // text transfer between hosts with different line conventions,
        // silently, with both sides believing it had succeeded.
        //
        // Refusing is the honest answer and costs nothing here: network devices
        // fetch and store images and configs in `octet`, and a client told
        // specifically that only `octet` is supported can retry in binary,
        // which is what it wanted anyway.
        "netascii" => {
            return Err(ProtocolError::new(
                "Unsupported mode: netascii (this server implements octet only)",
            ))
        }
        other => return Err(ProtocolError::new(format!("Unknown mode: {other}"))),
    };
    let options = collect_options(&tokens[2..])?;
    Ok(Request {
        filename,
        mode,
        options,
    })
}

/// Parses one option value: trimmed ASCII decimal, no sign, no suffix.
///
/// Stricter than the reference implementation's `parseInt`, which accepted
/// `"1400junk"` as 1400 and `"0x10"` as 0. RFC 2349 §2 specifies the value as
/// ASCII decimal digits; anything else is a client bug, and answering it with a
/// clean ERROR(8) is more useful than silently agreeing to a number the client
/// never wrote. Values are parsed into `u64` so that an absurd digit string
/// fails the range check below rather than overflowing into a plausible one.
fn parse_option_value(name: &str, raw: &str) -> Result<u64> {
    let trimmed = raw.trim();
    if trimmed.is_empty() || !trimmed.bytes().all(|b| b.is_ascii_digit()) {
        return Err(ProtocolError::new(format!("Invalid {name}: {raw}")));
    }
    trimmed
        .parse::<u64>()
        .map_err(|_| ProtocolError::new(format!("Invalid {name}: {raw}")))
}

fn parse_bounded(name: &str, raw: &str, min: u32, max: u32) -> Result<u32> {
    let value = parse_option_value(name, raw)?;
    if value < u64::from(min) || value > u64::from(max) {
        return Err(ProtocolError::new(format!(
            "Invalid {name}: {raw} ({min}-{max})"
        )));
    }
    // Bounded above by `max`, itself a `u32`.
    Ok(value as u32)
}

/// Validates raw option strings into the numeric form the engine uses, applying
/// the RFC bounds and this implementation's in-flight-byte budget.
pub fn validate_options(raw: &RawOptions, defaults: ValidatedOptions) -> Result<ValidatedOptions> {
    let mut out = defaults;
    if let Some(value) = &raw.blksize {
        out.blksize = parse_bounded("blksize", value, BLKSIZE_MIN, BLKSIZE_MAX)?;
    }
    if let Some(value) = &raw.timeout {
        out.timeout = Some(parse_bounded("timeout", value, TIMEOUT_MIN, TIMEOUT_MAX)?);
    }
    if let Some(value) = &raw.tsize {
        out.tsize = Some(parse_option_value("tsize", value)?);
    }
    if let Some(value) = &raw.windowsize {
        out.windowsize = parse_bounded("windowsize", value, WINDOWSIZE_MIN, WINDOWSIZE_MAX)?;
    }
    // RFC 2347 §2 lets the server answer an option with a value the client must
    // then use, and RFC 7440 §3 names `windowsize` explicitly as one the server
    // may lower. So a window whose bytes exceed the in-flight budget is clamped
    // here rather than refused: the transfer still runs, just with a window the
    // server can afford to allocate. Clamping `windowsize` and not `blksize` is
    // deliberate — `blksize` is what a client picks to match its MTU, and
    // shrinking it below that would fragment every datagram of the transfer.
    //
    // This is the single place option values become numbers, so the clamp lands
    // before anything can read them — including `validated_to_raw`, which is
    // what the OACK is built from. Clamping later (in the engine, say) would
    // answer the client with the value it asked for and then use a different
    // one, and the two ends would disagree about the window for the whole
    // transfer.
    let max_window = (MAX_IN_FLIGHT_BYTES / out.blksize).max(1);
    if out.windowsize > max_window {
        out.windowsize = max_window;
    }
    Ok(out)
}

/// Converts validated options back to the string form an OACK carries.
///
/// Options left at their protocol default are omitted: RFC 2347 §3 says the
/// OACK carries the options the server *accepted*, and echoing a default the
/// client never asked for invites a client to believe it negotiated something.
#[must_use]
pub fn validated_to_raw(opts: &ValidatedOptions) -> RawOptions {
    RawOptions {
        blksize: (opts.blksize != DEFAULT_BLOCK_SIZE).then(|| opts.blksize.to_string()),
        timeout: opts.timeout.map(|v| v.to_string()),
        tsize: opts.tsize.map(|v| v.to_string()),
        windowsize: (opts.windowsize != DEFAULT_WINDOW_SIZE).then(|| opts.windowsize.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn opts(pairs: &[(&str, &str)]) -> RawOptions {
        let mut o = RawOptions::default();
        for (k, v) in pairs {
            assert!(o.set(k, v), "test used an unrecognised option key {k}");
        }
        o
    }

    #[test]
    fn rrq_round_trips_without_options() {
        let encoded = encode_rrq("firmware.bin", "octet", &RawOptions::default());
        let Some(Packet::Rrq(req)) = parse_packet(&encoded).unwrap() else {
            panic!("expected RRQ");
        };
        assert_eq!(req.filename, "firmware.bin");
        assert_eq!(req.mode, TransferMode::Octet);
        assert!(req.options.is_empty());
    }

    #[test]
    fn wrq_round_trips_with_options() {
        let sent = opts(&[("blksize", "1400"), ("windowsize", "8"), ("tsize", "3000")]);
        let encoded = encode_wrq("up/load.bin", "octet", &sent);
        let Some(Packet::Wrq(req)) = parse_packet(&encoded).unwrap() else {
            panic!("expected WRQ");
        };
        assert_eq!(req.filename, "up/load.bin");
        assert_eq!(req.options, sent);
    }

    #[test]
    fn ack_and_data_round_trip_at_the_wrap_boundary() {
        for block in [0u16, 1, 65535] {
            let Some(Packet::Ack { block: got }) = parse_packet(&encode_ack(block)).unwrap() else {
                panic!("expected ACK");
            };
            assert_eq!(got, block);
        }
        let payload = vec![0xABu8; 512];
        let Some(Packet::Data { block, data }) = parse_packet(&encode_data(65535, &payload)).unwrap()
        else {
            panic!("expected DATA");
        };
        assert_eq!(block, 65535);
        assert_eq!(data, payload);
    }

    #[test]
    fn error_round_trips_with_and_without_custom_text() {
        let Some(Packet::Error { code, message }) =
            parse_packet(&encode_error(ErrorCode::DiskFull, Some("no room"))).unwrap()
        else {
            panic!("expected ERROR");
        };
        assert_eq!(code, 3);
        assert_eq!(message, "no room");

        let Some(Packet::Error { code, message }) =
            parse_packet(&encode_error(ErrorCode::AccessViolation, None)).unwrap()
        else {
            panic!("expected ERROR");
        };
        assert_eq!(code, 2);
        assert_eq!(message, ErrorCode::AccessViolation.default_message());
    }

    #[test]
    fn oack_round_trips_and_empty_oack_is_valid() {
        let sent = opts(&[("blksize", "1400"), ("timeout", "3")]);
        let Some(Packet::Oack { options }) = parse_packet(&encode_oack(&sent)).unwrap() else {
            panic!("expected OACK");
        };
        assert_eq!(options, sent);

        let Some(Packet::Oack { options }) =
            parse_packet(&encode_oack(&RawOptions::default())).unwrap()
        else {
            panic!("expected OACK");
        };
        assert!(options.is_empty());
    }

    #[test]
    fn short_and_malformed_packets_are_protocol_errors() {
        assert!(parse_packet(&[0x00]).is_err());
        assert!(parse_packet(&[0x00, 0x01, b'f', 0]).is_err(), "RRQ with no mode");
        assert!(parse_packet(&[0x00, 0x03, 0x01]).is_err(), "DATA with half a block number");
        assert!(parse_packet(&[0x00, 0x04, 0x01]).is_err(), "ACK too short");
        assert!(parse_packet(&[0x00, 0x05, 0x01]).is_err(), "ERROR too short");
    }

    #[test]
    fn unknown_opcode_parses_to_none_rather_than_erroring() {
        assert_eq!(parse_packet(&[0x00, 0x63]).unwrap(), None);
    }

    #[test]
    fn empty_filename_is_rejected() {
        let encoded = encode_rrq("", "octet", &RawOptions::default());
        assert!(parse_packet(&encoded).is_err());
    }

    #[test]
    fn overlong_filename_is_rejected_before_it_can_be_echoed() {
        let long = "a".repeat(MAX_FILENAME_BYTES + 1);
        let encoded = encode_rrq(&long, "octet", &RawOptions::default());
        assert!(parse_packet(&encoded).is_err());
        // One byte under the cap still parses, so the bound is the documented
        // one and not an off-by-one that rejects legitimate deep paths.
        let ok = "a".repeat(MAX_FILENAME_BYTES);
        assert!(parse_packet(&encode_rrq(&ok, "octet", &RawOptions::default())).is_ok());
    }

    #[test]
    fn netascii_is_refused_for_both_directions() {
        for encoded in [
            encode_rrq("readme.txt", "netascii", &RawOptions::default()),
            encode_wrq("readme.txt", "netascii", &RawOptions::default()),
        ] {
            let err = parse_packet(&encoded).unwrap_err();
            assert!(
                err.0.contains("octet"),
                "the refusal must name the mode the client should retry with, got {err}"
            );
        }
    }

    #[test]
    fn unknown_mode_is_refused() {
        assert!(parse_packet(&encode_rrq("x", "badmode", &RawOptions::default())).is_err());
    }

    #[test]
    fn odd_option_token_count_is_malformed() {
        let mut raw = encode_rrq("x", "octet", &RawOptions::default());
        raw.extend_from_slice(b"blksize\0");
        assert!(parse_packet(&raw).is_err());
    }

    #[test]
    fn non_utf8_fields_are_refused_rather_than_masked() {
        let mut raw = vec![0x00, 0x01];
        raw.extend_from_slice(&[0xC0, 0xAF]); // overlong-encoded '/' — invalid UTF-8
        raw.push(0);
        raw.extend_from_slice(b"octet\0");
        assert!(parse_packet(&raw).is_err());
    }

    #[test]
    fn unrecognised_options_are_ignored_not_rejected() {
        let mut raw = encode_rrq("x", "octet", &RawOptions::default());
        // `\x00` rather than `\0`: `\0` immediately followed by digits reads as
        // an octal escape, which Rust does not have.
        raw.extend_from_slice(b"multicast\x00224.0.0.1,1758,1\x00");
        let Some(Packet::Rrq(req)) = parse_packet(&raw).unwrap() else {
            panic!("expected RRQ");
        };
        assert!(req.options.is_empty(), "RFC 2347 §3: ignore unknown options");
    }

    #[test]
    fn option_defaults_apply_when_nothing_is_negotiated() {
        let v = validate_options(&RawOptions::default(), ValidatedOptions::default()).unwrap();
        assert_eq!(v.blksize, DEFAULT_BLOCK_SIZE);
        assert_eq!(v.windowsize, DEFAULT_WINDOW_SIZE);
        assert_eq!(v.timeout, None);
        assert_eq!(v.tsize, None);
    }

    #[test]
    fn options_outside_their_rfc_bounds_are_refused() {
        for bad in [
            opts(&[("blksize", "7")]),
            opts(&[("blksize", "65465")]),
            opts(&[("blksize", "not-a-number")]),
            opts(&[("timeout", "0")]),
            opts(&[("timeout", "256")]),
            opts(&[("windowsize", "0")]),
            opts(&[("tsize", "-1")]),
        ] {
            assert!(
                validate_options(&bad, ValidatedOptions::default()).is_err(),
                "{bad:?} must not be accepted"
            );
        }
    }

    #[test]
    fn option_values_with_trailing_junk_are_refused_not_silently_truncated() {
        // `parseInt("1400junk")` is 1400. Accepting that means negotiating a
        // block size the client never asked for.
        assert!(validate_options(&opts(&[("blksize", "1400junk")]), ValidatedOptions::default())
            .is_err());
        assert!(validate_options(&opts(&[("blksize", "0x10")]), ValidatedOptions::default())
            .is_err());
        // Surrounding whitespace is still tolerated — that much is a plausible
        // encoder quirk rather than a different number.
        let v =
            validate_options(&opts(&[("blksize", " 1400 ")]), ValidatedOptions::default()).unwrap();
        assert_eq!(v.blksize, 1400);
    }

    #[test]
    fn a_digit_string_too_large_for_the_field_is_refused_not_wrapped() {
        // 20 nines overflows u64 itself; the parse must fail rather than
        // wrapping into a value that would pass the range check.
        assert!(validate_options(
            &opts(&[("blksize", "99999999999999999999")]),
            ValidatedOptions::default()
        )
        .is_err());
    }

    // --- in-flight byte budget ------------------------------------------------
    //
    // These are the tests that fail if the `MAX_IN_FLIGHT_BYTES` clamp is
    // removed: without it, `validate_options` returns the requested window
    // verbatim and each assertion below sees the RFC maximum instead.

    #[test]
    fn windowsize_is_clamped_so_the_window_never_exceeds_the_budget() {
        let v = validate_options(
            &opts(&[("blksize", "65464"), ("windowsize", "65535")]),
            ValidatedOptions::default(),
        )
        .unwrap();
        assert!(
            v.windowsize < 65535,
            "an unclamped window would allocate ~4.3 GB from one datagram"
        );
        assert!(v.blksize * v.windowsize <= MAX_IN_FLIGHT_BYTES);
        assert!(v.windowsize >= 1, "the clamp must never degrade below one block");
        assert_eq!(v.blksize, 65464, "blksize must not be clamped");
    }

    #[test]
    fn windowsize_is_clamped_at_ordinary_block_sizes_too() {
        let v = validate_options(
            &opts(&[("blksize", "1400"), ("windowsize", "65535")]),
            ValidatedOptions::default(),
        )
        .unwrap();
        assert_eq!(v.windowsize, MAX_IN_FLIGHT_BYTES / 1400);
        assert!(v.blksize * v.windowsize <= MAX_IN_FLIGHT_BYTES);
    }

    #[test]
    fn a_window_that_already_fits_the_budget_is_left_alone() {
        let v = validate_options(
            &opts(&[("blksize", "1400"), ("windowsize", "16")]),
            ValidatedOptions::default(),
        )
        .unwrap();
        assert_eq!(v.windowsize, 16);
    }

    #[test]
    fn the_oack_reports_the_clamped_window_not_the_requested_one() {
        // The clamp is worthless if the OACK still promises the client the
        // window it asked for: the two ends would then disagree about how many
        // blocks may be outstanding for the whole transfer.
        let v = validate_options(
            &opts(&[("blksize", "512"), ("windowsize", "65535")]),
            ValidatedOptions::default(),
        )
        .unwrap();
        let echoed = validated_to_raw(&v);
        assert_eq!(echoed.windowsize.as_deref(), Some(v.windowsize.to_string().as_str()));
        assert_ne!(echoed.windowsize.as_deref(), Some("65535"));
    }

    #[test]
    fn validated_to_raw_omits_protocol_defaults() {
        let raw = validated_to_raw(&ValidatedOptions::default());
        assert!(raw.is_empty(), "defaults must not be echoed as negotiated");

        let raw = validated_to_raw(&ValidatedOptions {
            blksize: 1400,
            windowsize: 4,
            timeout: Some(3),
            tsize: Some(2048),
        });
        assert_eq!(raw.blksize.as_deref(), Some("1400"));
        assert_eq!(raw.windowsize.as_deref(), Some("4"));
        assert_eq!(raw.timeout.as_deref(), Some("3"));
        assert_eq!(raw.tsize.as_deref(), Some("2048"));
    }

    #[test]
    fn peek_opcode_needs_two_bytes() {
        assert_eq!(peek_opcode(&[]), None);
        assert_eq!(peek_opcode(&[0x00]), None);
        assert_eq!(peek_opcode(&[0x00, 0x06]), Some(6));
    }
}
