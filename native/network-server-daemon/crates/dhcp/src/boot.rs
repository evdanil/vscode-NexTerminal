//! Zero-Touch-Provisioning options: 43, 60, 66, 67 and the Cisco 150.
//!
//! Everything here is byte-level encoding and input validation with no socket
//! and no lease table, which is what makes it testable in isolation — and that
//! matters most for [`encode_vendor_specific_info`], where a single off-by-one
//! in a length byte produces a packet the device silently ignores. No log line,
//! no error, no boot.
//!
//! # Trust
//!
//! These inputs come from operator configuration, not from the network. They get
//! the same length discipline anyway, for two reasons: the failure mode is
//! invisible (see above), and "configuration" here includes a hand-edited
//! `settings.json` and a synced profile from another machine.

use std::fmt;
use std::net::Ipv4Addr;

use crate::constants::{
    MAX_OPTION_VALUE_BYTES, OPTION_BOOTFILE_NAME, OPTION_CISCO_TFTP_SERVERS,
    OPTION_TFTP_SERVER_NAME, OPTION_VENDOR_SPECIFIC,
};
use crate::protocol::{EncodeError, OptionsBuilder};

/// One TLV entry inside option 43.
///
/// `value` is either a hex literal (`0x0A0B`, with `:`, `-`, `_` and spaces
/// tolerated) or, when it does not start with `0x`, a plain string encoded as
/// UTF-8 bytes.
///
/// `sub_option` is an `i64` rather than a `u8` on purpose: the value arrives
/// from JSON, where `0`, `255`, `256` and `-1` are all expressible, and each
/// must be *rejected by name* rather than becoming unrepresentable at the type
/// boundary and failing as an opaque deserialisation error.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VendorEntry {
    pub sub_option: i64,
    pub value: String,
}

/// Why a boot option could not be encoded.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BootOptionError {
    /// 0 is PAD and 255 is END; neither can carry a value.
    InvalidSubOptionCode(i64),
    /// A `0x` literal with a character that is not a hex digit.
    NonHexDigits(String),
    /// A `0x` literal with an odd number of digits — half a byte would be
    /// invented or dropped.
    OddHexDigits { raw: String, digits: usize },
    /// One sub-option's value is longer than its length byte can describe.
    SubOptionTooLong { sub_option: i64, len: usize },
    /// The concatenated payload cannot fit in a single DHCP option.
    PayloadTooLong(usize),
    /// The surrounding option itself could not be written.
    Encode(EncodeError),
}

impl fmt::Display for BootOptionError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidSubOptionCode(code) => write!(
                f,
                "invalid option 43 sub-option code {code}: expected an integer between 1 and 254 \
                 (0 is PAD, 255 is END)"
            ),
            Self::NonHexDigits(raw) => write!(
                f,
                "invalid hex value \"{raw}\": only 0-9 and a-f are allowed after the 0x prefix"
            ),
            Self::OddHexDigits { raw, digits } => write!(
                f,
                "invalid hex value \"{raw}\": {digits} digits is not a whole number of bytes"
            ),
            Self::SubOptionTooLong { sub_option, len } => write!(
                f,
                "option 43 sub-option {sub_option} is {len} bytes; the length field carries at \
                 most {MAX_OPTION_VALUE_BYTES}"
            ),
            Self::PayloadTooLong(len) => write!(
                f,
                "option 43 payload is {len} bytes; a single DHCP option carries at most \
                 {MAX_OPTION_VALUE_BYTES}. Remove or shorten sub-options."
            ),
            Self::Encode(e) => write!(f, "{e}"),
        }
    }
}

impl std::error::Error for BootOptionError {}

impl From<EncodeError> for BootOptionError {
    fn from(value: EncodeError) -> Self {
        Self::Encode(value)
    }
}

/// Sub-option codes 0 and 255 are reserved by the option encoding itself.
#[must_use]
pub fn is_valid_sub_option_code(code: i64) -> bool {
    (1..=254).contains(&code)
}

/// Converts a configured option value into the bytes that go on the wire.
pub fn parse_vendor_option_value(raw: &str) -> Result<Vec<u8>, BootOptionError> {
    let Some(body) = raw.strip_prefix("0x").or_else(|| raw.strip_prefix("0X")) else {
        return Ok(raw.as_bytes().to_vec());
    };
    let digits: String = body
        .chars()
        .filter(|c| !matches!(c, ':' | '-' | '_') && !c.is_whitespace())
        .collect();
    if !digits.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err(BootOptionError::NonHexDigits(raw.to_owned()));
    }
    if digits.len() % 2 == 1 {
        return Err(BootOptionError::OddHexDigits {
            raw: raw.to_owned(),
            digits: digits.len(),
        });
    }
    let mut bytes = Vec::with_capacity(digits.len() / 2);
    let chars: Vec<char> = digits.chars().collect();
    let (pairs, remainder) = chars.as_chunks::<2>();
    debug_assert!(remainder.is_empty(), "odd hex digit count was checked above");
    for [high_char, low_char] in pairs {
        // Both digits are proven hex above, so this parse cannot fail; it is
        // still handled rather than unwrapped, so a future edit to the filter
        // above degrades to an error instead of a panic.
        let high = high_char.to_digit(16).ok_or_else(|| BootOptionError::NonHexDigits(raw.to_owned()))?;
        let low = low_char.to_digit(16).ok_or_else(|| BootOptionError::NonHexDigits(raw.to_owned()))?;
        bytes.push(u8::try_from(high * 16 + low).unwrap_or(0));
    }
    Ok(bytes)
}

/// Encodes option 43's payload as the repeated `[code][length][value…]`
/// sequence of RFC 2132 §8.4.
///
/// There is no envelope around the sequence: the option code and the overall
/// length byte belong to the surrounding DHCP option header, which
/// [`OptionsBuilder::put`] adds — and which performs the same 255-byte check
/// again from the other side.
pub fn encode_vendor_specific_info(entries: &[VendorEntry]) -> Result<Vec<u8>, BootOptionError> {
    let mut encoded = Vec::new();
    for entry in entries {
        if !is_valid_sub_option_code(entry.sub_option) {
            return Err(BootOptionError::InvalidSubOptionCode(entry.sub_option));
        }
        let value = parse_vendor_option_value(&entry.value)?;
        if value.len() > MAX_OPTION_VALUE_BYTES {
            return Err(BootOptionError::SubOptionTooLong {
                sub_option: entry.sub_option,
                len: value.len(),
            });
        }
        // Proven in 1..=254 above, and the length in 0..=255 just above.
        encoded.push(u8::try_from(entry.sub_option).unwrap_or(0));
        encoded.push(u8::try_from(value.len()).unwrap_or(0));
        encoded.extend_from_slice(&value);
    }
    if encoded.len() > MAX_OPTION_VALUE_BYTES {
        return Err(BootOptionError::PayloadTooLong(encoded.len()));
    }
    Ok(encoded)
}

/// Decides whether the boot options apply to the client behind a request.
///
/// **Deliberate limitation carried over from the reference implementation:** a
/// single global vendor class, not a set of per-vendor profiles. Empty means
/// every client gets the boot options; set means only clients whose option 60
/// matches do, and everyone else gets an address and nothing else.
///
/// The comparison is trimmed and case-insensitive but otherwise exact — `Cisco`
/// does not match `Cisco Systems, Inc.`. The observed value is logged on every
/// DISCOVER so the exact string can be copied out of the log.
#[must_use]
pub fn matches_vendor_class(configured: Option<&str>, observed: Option<&str>) -> bool {
    let expected = configured.map(str::trim).filter(|s| !s.is_empty());
    let Some(expected) = expected else {
        return true;
    };
    let Some(observed) = observed else {
        return false;
    };
    observed.trim().eq_ignore_ascii_case(expected)
}

/// The ZTP settings, validated once at construction.
///
/// Validating here rather than per packet is deliberate: a mistyped option 43
/// should produce one error the operator can read at start-up, not one per
/// DISCOVER on a bench full of booting hardware.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct BootOptions {
    /// Option 66 — the TFTP server clients fetch the bootfile from.
    pub next_server: Option<String>,
    /// Option 67 — the bootfile a PXE/ZTP client should fetch.
    pub boot_file_name: Option<String>,
    /// Option 150 — Cisco's TFTP server address list.
    pub tftp_server_addresses: Vec<Ipv4Addr>,
    /// Option 60 of the *incoming* request to match before serving the rest.
    pub vendor_class_id: Option<String>,
    /// Option 43 payload, already TLV-encoded. Empty means "do not send".
    vendor_specific: Vec<u8>,
}

impl BootOptions {
    /// Builds the set, encoding option 43 up front.
    pub fn new(
        next_server: Option<String>,
        boot_file_name: Option<String>,
        tftp_server_addresses: Vec<Ipv4Addr>,
        vendor_class_id: Option<String>,
        vendor_entries: &[VendorEntry],
    ) -> Result<Self, BootOptionError> {
        Ok(Self {
            next_server: next_server.filter(|s| !s.trim().is_empty()),
            boot_file_name: boot_file_name.filter(|s| !s.trim().is_empty()),
            tftp_server_addresses,
            vendor_class_id: vendor_class_id.filter(|s| !s.trim().is_empty()),
            vendor_specific: encode_vendor_specific_info(vendor_entries)?,
        })
    }

    /// Whether anything at all would be served.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.next_server.is_none()
            && self.boot_file_name.is_none()
            && self.tftp_server_addresses.is_empty()
            && self.vendor_specific.is_empty()
    }

    /// Names of the options this set would serve, for the start-up log line.
    #[must_use]
    pub fn served_option_names(&self) -> Vec<String> {
        let mut names = Vec::new();
        if self.next_server.is_some() {
            names.push("66 (tftp-server-name)".to_owned());
        }
        if self.boot_file_name.is_some() {
            names.push("67 (bootfile-name)".to_owned());
        }
        if !self.tftp_server_addresses.is_empty() {
            names.push("150 (cisco-tftp-servers)".to_owned());
        }
        if !self.vendor_specific.is_empty() {
            names.push("43 (vendor-specific)".to_owned());
        }
        names
    }

    /// Writes the boot options into a reply, if this client qualifies.
    ///
    /// The gate is option 60 of the *request*. Unlike the reference
    /// implementation, these options are always written when the gate passes
    /// rather than only when the client listed them in its parameter request
    /// list (option 55): plenty of ZTP-capable hardware expects the boot
    /// information unsolicited. That is what the reference achieved with the
    /// library's `forceOptions`, expressed here as the default.
    pub fn write_into(
        &self,
        out: &mut OptionsBuilder,
        observed_vendor_class: Option<&str>,
    ) -> Result<bool, BootOptionError> {
        if !matches_vendor_class(self.vendor_class_id.as_deref(), observed_vendor_class) {
            return Ok(false);
        }
        if let Some(server) = &self.next_server {
            out.put_text(OPTION_TFTP_SERVER_NAME, server)?;
        }
        if let Some(file) = &self.boot_file_name {
            out.put_text(OPTION_BOOTFILE_NAME, file)?;
        }
        if !self.tftp_server_addresses.is_empty() {
            out.put_ipv4_list(OPTION_CISCO_TFTP_SERVERS, &self.tftp_server_addresses)?;
        }
        if !self.vendor_specific.is_empty() {
            out.put(OPTION_VENDOR_SPECIFIC, &self.vendor_specific)?;
        }
        Ok(true)
    }

    /// The encoded option 43 payload. Test and diagnostic use.
    #[must_use]
    pub fn vendor_specific_bytes(&self) -> &[u8] {
        &self.vendor_specific
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::constants::OPTION_VENDOR_CLASS_ID;

    fn entry(sub_option: i64, value: &str) -> VendorEntry {
        VendorEntry { sub_option, value: value.to_owned() }
    }

    // -- option 43 -----------------------------------------------------------

    #[test]
    fn a_single_text_sub_option_encodes_as_code_length_value() {
        assert_eq!(
            encode_vendor_specific_info(&[entry(1, "ztp")]).unwrap(),
            vec![0x01, 0x03, 0x7a, 0x74, 0x70]
        );
    }

    #[test]
    fn entries_concatenate_in_order_each_with_its_own_header() {
        // A header written one byte early or late shifts everything after it.
        assert_eq!(
            encode_vendor_specific_info(&[entry(1, "a"), entry(242, "0x0A0B")]).unwrap(),
            vec![0x01, 0x01, 0x61, 0xf2, 0x02, 0x0a, 0x0b]
        );
    }

    #[test]
    fn a_hex_literal_is_written_as_raw_bytes_not_as_its_text() {
        // Text encoding would produce 10 bytes of ASCII digits instead of 4.
        assert_eq!(
            encode_vendor_specific_info(&[entry(43, "0xC0A80201")]).unwrap(),
            vec![0x2b, 0x04, 0xc0, 0xa8, 0x02, 0x01]
        );
    }

    #[test]
    fn lengths_count_bytes_not_characters() {
        assert_eq!(
            encode_vendor_specific_info(&[entry(5, "é")]).unwrap(),
            vec![0x05, 0x02, 0xc3, 0xa9]
        );
    }

    #[test]
    fn a_zero_length_entry_is_emitted_rather_than_dropped() {
        assert_eq!(encode_vendor_specific_info(&[entry(7, "")]).unwrap(), vec![0x07, 0x00]);
    }

    #[test]
    fn no_entries_produce_an_empty_payload() {
        assert!(encode_vendor_specific_info(&[]).unwrap().is_empty());
    }

    #[test]
    fn the_boundary_sub_option_codes_are_accepted() {
        assert_eq!(
            encode_vendor_specific_info(&[entry(1, "x")]).unwrap(),
            vec![0x01, 0x01, 0x78]
        );
        assert_eq!(
            encode_vendor_specific_info(&[entry(254, "x")]).unwrap(),
            vec![0xfe, 0x01, 0x78]
        );
    }

    #[test]
    fn the_reserved_and_out_of_range_sub_option_codes_are_refused() {
        for code in [0i64, 255, 256, -1, i64::MAX, i64::MIN] {
            assert_eq!(
                encode_vendor_specific_info(&[entry(code, "x")]),
                Err(BootOptionError::InvalidSubOptionCode(code)),
                "sub-option {code} must be refused"
            );
        }
    }

    #[test]
    fn a_payload_that_cannot_fit_one_option_is_refused() {
        // 2 header bytes + 200 value bytes, twice = 404 > 255.
        let entries = [entry(1, &"a".repeat(200)), entry(2, &"b".repeat(200))];
        assert_eq!(
            encode_vendor_specific_info(&entries),
            Err(BootOptionError::PayloadTooLong(404))
        );
    }

    #[test]
    fn a_single_value_longer_than_its_length_byte_is_refused() {
        assert_eq!(
            encode_vendor_specific_info(&[entry(1, &"a".repeat(256))]),
            Err(BootOptionError::SubOptionTooLong { sub_option: 1, len: 256 })
        );
    }

    #[test]
    fn exactly_255_bytes_of_payload_is_accepted() {
        let encoded = encode_vendor_specific_info(&[entry(1, &"a".repeat(253))]).unwrap();
        assert_eq!(encoded.len(), 255);
        assert_eq!(encoded[1], 253);
    }

    // -- value parsing -------------------------------------------------------

    #[test]
    fn an_unprefixed_value_is_text() {
        assert_eq!(parse_vendor_option_value("0A").unwrap(), vec![0x30, 0x41]);
    }

    #[test]
    fn separators_inside_a_hex_literal_are_ignored() {
        assert_eq!(
            parse_vendor_option_value("0xAA:BB-CC_DD EE").unwrap(),
            vec![0xaa, 0xbb, 0xcc, 0xdd, 0xee]
        );
    }

    #[test]
    fn an_odd_number_of_hex_digits_is_refused() {
        assert_eq!(
            parse_vendor_option_value("0xABC"),
            Err(BootOptionError::OddHexDigits { raw: "0xABC".to_owned(), digits: 3 })
        );
    }

    #[test]
    fn a_non_hex_character_after_the_prefix_is_refused() {
        assert!(matches!(
            parse_vendor_option_value("0xZZ"),
            Err(BootOptionError::NonHexDigits(_))
        ));
    }

    // -- option 60 gate ------------------------------------------------------

    #[test]
    fn every_client_is_served_when_no_vendor_class_is_configured() {
        assert!(matches_vendor_class(None, Some("Cisco Systems, Inc.")));
        assert!(matches_vendor_class(Some("   "), None));
    }

    #[test]
    fn the_match_ignores_case_and_surrounding_whitespace() {
        assert!(matches_vendor_class(Some("ArubaInstantAP"), Some(" arubainstantap ")));
    }

    #[test]
    fn a_different_identifier_including_a_prefix_of_it_does_not_match() {
        assert!(!matches_vendor_class(Some("Cisco"), Some("Cisco Systems, Inc.")));
        assert!(!matches_vendor_class(Some("Cisco"), Some("Aruba")));
    }

    #[test]
    fn a_client_that_sent_no_option_60_is_refused_when_a_class_is_configured() {
        assert!(!matches_vendor_class(Some("Cisco"), None));
    }

    // -- writing into a reply ------------------------------------------------

    #[test]
    fn the_gate_decides_whether_anything_is_written_at_all() {
        let boot = BootOptions::new(
            Some("10.0.0.1".to_owned()),
            Some("ios.bin".to_owned()),
            vec![Ipv4Addr::new(10, 0, 0, 1)],
            Some("Cisco".to_owned()),
            &[entry(1, "0xAB")],
        )
        .unwrap();

        let mut matching = OptionsBuilder::new();
        assert!(boot.write_into(&mut matching, Some("cisco")).unwrap());
        assert!(!matching.is_empty());

        let mut other = OptionsBuilder::new();
        assert!(!boot.write_into(&mut other, Some("Aruba")).unwrap());
        assert!(
            other.is_empty(),
            "a non-matching client must get an address and nothing else"
        );
    }

    #[test]
    fn the_written_options_decode_back_to_what_was_configured() {
        let boot = BootOptions::new(
            Some("boot.example".to_owned()),
            Some("ios-image.bin".to_owned()),
            vec![Ipv4Addr::new(10, 0, 0, 5), Ipv4Addr::new(10, 0, 0, 6)],
            None,
            &[entry(1, "0xC0A80201")],
        )
        .unwrap();
        let mut builder = OptionsBuilder::new();
        boot.write_into(&mut builder, None).unwrap();
        let region = builder.finish();

        let mut options = crate::protocol::Options::new();
        crate::protocol::parse_options(&mut crate::protocol::Reader::new(&region), &mut options)
            .expect("our own option region must parse");
        assert_eq!(
            options.text(OPTION_TFTP_SERVER_NAME).as_deref(),
            Some("boot.example")
        );
        assert_eq!(
            options.text(OPTION_BOOTFILE_NAME).as_deref(),
            Some("ios-image.bin")
        );
        assert_eq!(
            options.ipv4_list(OPTION_CISCO_TFTP_SERVERS),
            vec![Ipv4Addr::new(10, 0, 0, 5), Ipv4Addr::new(10, 0, 0, 6)]
        );
        assert_eq!(
            options.get(OPTION_VENDOR_SPECIFIC),
            Some(&[0x01, 0x04, 0xc0, 0xa8, 0x02, 0x01][..])
        );
        assert!(
            !options.contains(OPTION_VENDOR_CLASS_ID),
            "option 60 is a request field; a server does not echo it"
        );
    }

    #[test]
    fn a_bad_option_43_is_refused_at_construction_not_at_send_time() {
        // One error the operator reads at start-up, rather than one per DISCOVER
        // on a bench full of booting hardware.
        assert_eq!(
            BootOptions::new(None, None, Vec::new(), None, &[entry(0, "x")]),
            Err(BootOptionError::InvalidSubOptionCode(0))
        );
    }

    #[test]
    fn a_blank_setting_is_treated_as_unset() {
        let boot = BootOptions::new(
            Some("   ".to_owned()),
            Some(String::new()),
            Vec::new(),
            Some("  ".to_owned()),
            &[],
        )
        .unwrap();
        assert!(boot.is_empty(), "whitespace must not advertise an empty boot server");
        assert!(boot.served_option_names().is_empty());
    }
}
