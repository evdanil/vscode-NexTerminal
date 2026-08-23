//! IPv4 arithmetic and the canonical MAC key.
//!
//! Everything here is pure: no socket, no filesystem, no configuration. The
//! reference implementation kept the same split (`dhcpNetworkUtils.ts`), and for
//! the same reason — the pool boundary conditions are exactly the arithmetic a
//! unit test can pin down and a running server cannot.
//!
//! # Signedness
//!
//! The TypeScript original does its address arithmetic with `<<`, which in
//! JavaScript yields a *signed* 32-bit value. `ipToInt("192.168.2.10")` is
//! therefore negative, and `computePoolSize` compares two such values with `<`.
//! For a pool that lies entirely above or entirely below `128.0.0.0` that works
//! by luck; for a pool that spans the boundary — `127.0.0.0` to `128.0.0.255` —
//! the end compares as *smaller* than the start and the pool is reported empty.
//! Its two siblings, `isIpInPool` and `computeRangeEnd`, coerce back with
//! `>>> 0` and get it right, so the three disagree.
//!
//! Here every address is a `u32` from the start, which makes the whole class
//! unrepresentable rather than merely fixed.

use std::collections::BTreeMap;
use std::fmt;
use std::net::Ipv4Addr;

/// A MAC address in the one spelling the lease table is keyed by:
/// uppercase hex pairs joined by dashes, `AA-BB-CC-DD-EE-FF`.
///
/// The canonical form is not a style preference. Configuration is typed by hand
/// and usually colon-separated (`aa:bb:cc:dd:ee:ff`), while `chaddr` arrives off
/// the wire as six raw bytes. A reservation keyed by one spelling and looked up
/// by the other silently does not exist — which is exactly the failure mode
/// found in the reference implementation, where an out-of-pool reservation typed
/// with colons was never honoured (see the crate-level report).
///
/// Making the key a distinct type, constructible only through the two
/// canonicalising constructors, is what stops a raw `String` from being used as
/// a key by accident.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct MacKey(String);

impl MacKey {
    /// Builds the key from the raw `chaddr` bytes of a packet.
    #[must_use]
    pub fn from_hardware(bytes: &[u8]) -> Self {
        const HEX: &[u8; 16] = b"0123456789ABCDEF";
        let mut out = String::with_capacity(bytes.len() * 3);
        for (index, byte) in bytes.iter().enumerate() {
            if index > 0 {
                out.push('-');
            }
            out.push(char::from(HEX[usize::from(byte >> 4)]));
            out.push(char::from(HEX[usize::from(byte & 0x0F)]));
        }
        Self(out)
    }

    /// Accepts only a key [`Self::from_hardware`] could have produced.
    ///
    /// [`Self::parse_lossy`] keeps whatever it cannot canonicalise, which is
    /// right for a value an operator typed — a reservation should not vanish
    /// over punctuation — and wrong for one read back out of the lease cache.
    /// No packet can produce `NOT-A-MAC`, so an entry filed under it belongs to
    /// no client that will ever appear, yet it holds an address out of the pool
    /// until it expires, and gets written back on the next save.
    ///
    /// The length is bounded by `hlen` rather than fixed at six: `chaddr`
    /// carries 1..=16 bytes, so a client whose hardware address is not
    /// Ethernet-shaped still has a key this must accept.
    #[must_use]
    pub fn from_wire_key(raw: &str) -> Option<Self> {
        let mut octets = 0usize;
        for pair in raw.split('-') {
            let bytes = pair.as_bytes();
            let hex = |b: &u8| b.is_ascii_digit() || (b'A'..=b'F').contains(b);
            if bytes.len() != 2 || !bytes.iter().all(hex) {
                return None;
            }
            octets += 1;
        }
        (1..=crate::protocol::MAX_HARDWARE_LEN)
            .contains(&octets)
            .then(|| Self(raw.to_owned()))
    }

    /// Canonicalises a MAC as an operator may have typed it.
    ///
    /// Accepts `aa:bb:cc:dd:ee:ff`, `AA-BB-…`, `aabb.ccdd.eeff` and bare
    /// `aabbccddeeff`. A string that does not contain exactly twelve hex digits
    /// is passed through trimmed and upper-cased rather than reshaped: a
    /// malformed entry that looks malformed is far easier to diagnose than one
    /// silently rewritten into a valid-looking address nobody configured.
    #[must_use]
    pub fn parse_lossy(raw: &str) -> Self {
        Self::parse(raw).unwrap_or_else(|| Self(raw.trim().to_uppercase()))
    }

    /// Canonicalises a configured MAC address, rejecting values that cannot map
    /// to the six octets carried on the wire.
    #[must_use]
    pub fn parse(raw: &str) -> Option<Self> {
        let hex: String = raw.chars().filter(char::is_ascii_hexdigit).collect();
        if hex.len() != 12 {
            return None;
        }
        let upper = hex.to_uppercase();
        let pairs: Vec<String> = upper
            .as_bytes()
            .chunks(2)
            .map(|pair| String::from_utf8_lossy(pair).into_owned())
            .collect();
        Some(Self(pairs.join("-")))
    }

    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for MacKey {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

/// Canonicalises a whole configured reservation map in one pass.
///
/// Every consumer that lines a configured reservation up against the lease table
/// goes through this, so a MAC typed with colons in settings matches a MAC
/// decoded from six bytes on the wire.
#[must_use]
pub fn normalize_static_map<'a, I>(entries: I) -> BTreeMap<MacKey, Ipv4Addr>
where
    I: IntoIterator<Item = (&'a str, Ipv4Addr)>,
{
    entries
        .into_iter()
        .map(|(mac, ip)| (MacKey::parse_lossy(mac), ip))
        .collect()
}

/// Number of addresses in the inclusive range `[start, end]`, or `0` when the
/// range is inverted.
#[must_use]
pub fn pool_size(start: Ipv4Addr, end: Ipv4Addr) -> u32 {
    let first = u32::from(start);
    let last = u32::from(end);
    if last < first {
        return 0;
    }
    // Saturating rather than `+ 1`: the full IPv4 space is 2^32 addresses, one
    // more than a u32 can hold. A range of `0.0.0.0`-`255.255.255.255` is not a
    // pool anyone configures, but it must not wrap to zero if they do.
    (last - first).saturating_add(1)
}

/// Whether `ip` falls inside the inclusive dynamic pool.
///
/// This is the question "does this reservation collide with the pool?" — an
/// address inside the range can be handed to another client by the allocator, so
/// it has to be held out up front, while one outside never competes.
#[must_use]
pub fn is_ip_in_pool(ip: Ipv4Addr, start: Ipv4Addr, end: Ipv4Addr) -> bool {
    let address = u32::from(ip);
    let first = u32::from(start);
    let last = u32::from(end);
    if first > last {
        return false;
    }
    address >= first && address <= last
}

/// The address `offset` positions after `start`, if it is still inside the pool.
#[must_use]
pub fn pool_address_at(start: Ipv4Addr, end: Ipv4Addr, offset: u32) -> Option<Ipv4Addr> {
    let first = u32::from(start);
    let last = u32::from(end);
    let candidate = first.checked_add(offset)?;
    if candidate > last {
        return None;
    }
    Some(Ipv4Addr::from(candidate))
}

/// Derives the broadcast address as `(gateway & mask) | !mask`.
///
/// The reference implementation originally hardcoded the packaged default here,
/// so an operator who moved `gateway`/`subnet` to another subnet kept
/// advertising `192.168.2.255`. Deriving it is that fix, carried over.
#[must_use]
pub fn broadcast_address(gateway: Ipv4Addr, netmask: Ipv4Addr) -> Ipv4Addr {
    let g = u32::from(gateway);
    let m = u32::from(netmask);
    if g == 0 || m == 0 {
        return crate::constants::DEFAULT_BROADCAST;
    }
    Ipv4Addr::from((g & m) | !m)
}

/// Whether a mask's set bits are contiguous from the top. `255.0.255.0` is not
/// a subnet mask.
#[must_use]
pub fn is_contiguous_mask(mask: Ipv4Addr) -> bool {
    let value = u32::from(mask);
    let inverted = !value;
    // `wrapping_add` rather than `checked_add`: the all-zero mask inverts to
    // `u32::MAX`, whose successor legitimately wraps to 0 — and 0 is exactly the
    // answer that says "contiguous".
    inverted.wrapping_add(1) & inverted == 0
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ip(text: &str) -> Ipv4Addr {
        text.parse().expect("test address parses")
    }

    #[test]
    fn a_mac_from_the_wire_and_one_typed_by_hand_produce_the_same_key() {
        let from_wire = MacKey::from_hardware(&[0xAA, 0xBB, 0xCC, 0xDD, 0xEE, 0xFF]);
        for spelling in [
            "aa:bb:cc:dd:ee:ff",
            "AA-BB-CC-DD-EE-FF",
            "aabb.ccdd.eeff",
            "aabbccddeeff",
            "  AA:bb:CC:dd:EE:ff  ",
        ] {
            assert_eq!(
                MacKey::parse_lossy(spelling),
                from_wire,
                "{spelling} must canonicalise to the wire key"
            );
        }
    }

    #[test]
    fn a_malformed_mac_is_passed_through_rather_than_reshaped() {
        // Reshaping "aa:bb:cc" into a valid-looking address would invent three
        // octets the operator never configured.
        assert_eq!(MacKey::parse_lossy(" aa:bb:cc ").as_str(), "AA:BB:CC");
    }

    #[test]
    fn a_pool_spanning_the_signed_boundary_is_not_reported_empty() {
        // The JavaScript original computes this with signed shifts: the end
        // compares as smaller than the start and the pool reads as size 0,
        // which means the server allocates nothing at all.
        // 127.255.255.255, 128.0.0.0, 128.0.0.1 — three addresses, not zero.
        assert_eq!(pool_size(ip("127.255.255.255"), ip("128.0.0.1")), 3);
        assert!(is_ip_in_pool(ip("128.0.0.0"), ip("127.255.255.255"), ip("128.0.0.1")));
    }

    #[test]
    fn pool_size_counts_inclusively_and_refuses_an_inverted_range() {
        assert_eq!(pool_size(ip("192.168.2.10"), ip("192.168.2.199")), 190);
        assert_eq!(pool_size(ip("10.0.0.5"), ip("10.0.0.5")), 1);
        assert_eq!(pool_size(ip("10.0.0.9"), ip("10.0.0.1")), 0);
    }

    #[test]
    fn the_whole_address_space_does_not_wrap_to_zero() {
        assert_eq!(pool_size(ip("0.0.0.0"), ip("255.255.255.255")), u32::MAX);
    }

    #[test]
    fn an_inverted_range_contains_nothing() {
        assert!(!is_ip_in_pool(ip("10.0.0.5"), ip("10.0.0.9"), ip("10.0.0.1")));
    }

    #[test]
    fn the_broadcast_is_derived_from_the_configured_subnet() {
        assert_eq!(
            broadcast_address(ip("10.4.0.1"), ip("255.255.0.0")),
            ip("10.4.255.255"),
            "a hardcoded default would advertise 192.168.2.255 on a 10.4/16 network"
        );
        assert_eq!(
            broadcast_address(ip("192.168.2.1"), ip("255.255.255.0")),
            ip("192.168.2.255")
        );
    }

    #[test]
    fn an_unusable_mask_falls_back_to_the_packaged_broadcast() {
        assert_eq!(
            broadcast_address(ip("10.0.0.1"), ip("0.0.0.0")),
            crate::constants::DEFAULT_BROADCAST
        );
    }

    #[test]
    fn a_mask_with_holes_is_rejected() {
        assert!(is_contiguous_mask(ip("255.255.255.0")));
        assert!(is_contiguous_mask(ip("255.255.255.255")));
        assert!(is_contiguous_mask(ip("0.0.0.0")));
        assert!(!is_contiguous_mask(ip("255.0.255.0")));
    }

    #[test]
    fn pool_addresses_stop_at_the_end_rather_than_wrapping() {
        let start = ip("10.0.0.250");
        let end = ip("10.0.0.252");
        assert_eq!(pool_address_at(start, end, 0), Some(ip("10.0.0.250")));
        assert_eq!(pool_address_at(start, end, 2), Some(ip("10.0.0.252")));
        assert_eq!(pool_address_at(start, end, 3), None);
        // And at the very top of the space, the add must not wrap around to 0.
        assert_eq!(
            pool_address_at(ip("255.255.255.255"), ip("255.255.255.255"), 1),
            None
        );
    }

    #[test]
    fn a_configured_map_is_re_keyed_to_the_wire_spelling() {
        let map = normalize_static_map([("aa:bb:cc:dd:ee:ff", ip("10.0.0.5"))]);
        let wire = MacKey::from_hardware(&[0xAA, 0xBB, 0xCC, 0xDD, 0xEE, 0xFF]);
        assert_eq!(map.get(&wire), Some(&ip("10.0.0.5")));
    }
}
