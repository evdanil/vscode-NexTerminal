//! The lease table: allocation, binding, expiry and static reservations.
//!
//! Deliberately free of sockets and of the filesystem, so that every allocation
//! boundary condition — a reservation inside the pool, a pool with one address
//! left, a lease that expired one millisecond ago — is a unit test rather than
//! something that needs a bench full of hardware to reproduce.
//!
//! # Two divergences from the reference implementation, both deliberate
//!
//! **Allocation is lowest-first, not random.** `dhcp@0.2.20` defaults
//! `randomIP` to true and picks a random free address. Random allocation buys
//! nothing on a lab network and costs reproducibility: the reference's own
//! integration test has to stub `Math.random` to make its assertions
//! deterministic, which is a signal that the behaviour under test was not
//! observable otherwise.
//!
//! **Leases expire while the server is running.** In the reference, an entry in
//! `_state` is never removed on expiry — it is only ever evicted when the pool
//! fills, and only reconciled against wall-clock time on the *next start*. A
//! bench that cycles through a hundred devices in a morning therefore reports a
//! full pool of leases that all read `remainingSec: 0`, and hands out no
//! addresses, until the daemon is restarted. Here [`LeaseTable::expire`] sweeps
//! on the engine's tick.

use std::collections::{BTreeMap, BTreeSet};
use std::net::Ipv4Addr;

use crate::net::{is_ip_in_pool, pool_size, MacKey};

/// Default window an OFFER holds an address before the client must claim it.
///
/// RFC 2131 does not name a number. Two minutes is long enough for a device that
/// is slow to answer an OFFER and short enough that a scanner sending a thousand
/// DISCOVERs cannot hold the whole pool hostage for a day — which is what
/// happens when an offer is treated as a full-length lease, as the reference
/// implementation does.
pub const DEFAULT_OFFER_SECS: u32 = 120;

/// How long a declined address is held out of the pool.
///
/// RFC 2131 §4.3.3: a DHCPDECLINE means the client probed the offered address
/// and found somebody already answering on it — a static host nobody told the
/// server about, or a second DHCP server. The RFC says the address "SHOULD" be
/// marked unusable. The reference implementation instead deletes the entry,
/// which puts the contested address straight back at the top of the free list,
/// so the very next client is handed the same conflict. Ten minutes is long
/// enough to cycle a bench through the rest of the pool first.
pub const DEFAULT_DECLINE_QUARANTINE_SECS: u32 = 600;

/// Where an entry sits in its lifecycle.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LeaseState {
    /// Offered in reply to a DISCOVER, not yet claimed.
    Offered,
    /// Claimed by a REQUEST and acknowledged.
    Bound,
    /// A placeholder holding a configured reservation's address out of the
    /// dynamic pool before its device has ever spoken.
    ///
    /// A state the wire protocol never produces, which is what makes it safe as
    /// the flag that tells a reservation apart from a real lease. Entries
    /// carrying it are filtered out of [`LeaseTable::active_leases`] and never
    /// persisted, so a reservation cannot inflate pool utilisation, appear in
    /// the sidebar's active leases, or come back from disk as a real lease on
    /// the next start.
    Reserved,
}

/// How a lease was arrived at. Mirrors the reference's `leaseType` verbatim,
/// because it is rendered in the sidebar.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LeaseType {
    Dynamic,
    Static,
    Renewed,
    Inform,
}

impl LeaseType {
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Dynamic => "dynamic",
            Self::Static => "static",
            Self::Renewed => "renewed",
            Self::Inform => "inform",
        }
    }

    #[must_use]
    pub fn from_str_lossy(text: &str) -> Option<Self> {
        match text {
            "dynamic" => Some(Self::Dynamic),
            "static" => Some(Self::Static),
            "renewed" => Some(Self::Renewed),
            "inform" => Some(Self::Inform),
            _ => None,
        }
    }
}

/// One entry of the table.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LeaseEntry {
    pub address: Ipv4Addr,
    pub state: LeaseState,
    /// Epoch ms of the first bind. `None` while an entry has only ever been
    /// offered or reserved — nothing is bound yet, and a timestamp here would
    /// make the eventual real bind read as a *renewal* of a lease that never
    /// existed.
    pub bound_at_ms: Option<u64>,
    /// Epoch ms at which the current claim lapses.
    pub expires_at_ms: u64,
    pub lease_secs: u32,
    pub hostname: Option<String>,
}

impl LeaseEntry {
    #[must_use]
    pub fn is_live(&self, now_ms: u64) -> bool {
        // A reservation has no clock: it holds its address for as long as it is
        // configured. Giving it an expiry would put the reserved address back in
        // the pool while the device it belongs to was merely switched off.
        self.state == LeaseState::Reserved || self.expires_at_ms > now_ms
    }
}

/// Immutable snapshot of one lease, in the shape the host renders and the lease
/// file stores.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LeaseInfo {
    pub mac: MacKey,
    pub ip: Ipv4Addr,
    pub bound_at: u64,
    pub lease_sec: u32,
    pub expires_at: u64,
    pub remaining_sec: u64,
    pub hostname: Option<String>,
    pub lease_type: LeaseType,
}

/// Pool size and current utilisation.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PoolInfo {
    pub range_start: Ipv4Addr,
    pub range_end: Ipv4Addr,
    pub pool_size: u32,
    pub active_count: usize,
    pub utilization_pct: f64,
    pub static_entry_count: usize,
}

/// What a bind did, so the caller can emit the right event.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BindOutcome {
    /// A device that was not holding this address before.
    Bound,
    /// The same device re-claiming the address it already held.
    Renewed,
}

/// Which reservations `seed_static_reservations` acted on.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SeedReport {
    /// Reservations that were newly held out of the pool.
    pub seeded: Vec<(MacKey, Ipv4Addr)>,
    /// Reservations outside the pool, which never compete with dynamic
    /// allocation and so need no placeholder.
    pub skipped: Vec<(MacKey, Ipv4Addr)>,
}

/// The whole lease table.
#[derive(Debug, Clone)]
pub struct LeaseTable {
    entries: BTreeMap<MacKey, LeaseEntry>,
    statics: BTreeMap<MacKey, Ipv4Addr>,
    /// Addresses a client declined, and the epoch ms they become usable again.
    quarantine: BTreeMap<Ipv4Addr, u64>,
    range_start: Ipv4Addr,
    range_end: Ipv4Addr,
    lease_secs: u32,
    offer_secs: u32,
    quarantine_secs: u32,
}

impl LeaseTable {
    #[must_use]
    pub fn new(
        range_start: Ipv4Addr,
        range_end: Ipv4Addr,
        lease_secs: u32,
        statics: BTreeMap<MacKey, Ipv4Addr>,
    ) -> Self {
        Self {
            entries: BTreeMap::new(),
            statics,
            quarantine: BTreeMap::new(),
            range_start,
            range_end,
            lease_secs,
            offer_secs: DEFAULT_OFFER_SECS,
            quarantine_secs: DEFAULT_DECLINE_QUARANTINE_SECS,
        }
    }

    #[must_use]
    pub fn with_offer_secs(mut self, offer_secs: u32) -> Self {
        self.offer_secs = offer_secs;
        self
    }

    /// Whether a declined address is still being held out of the pool.
    #[must_use]
    pub fn is_quarantined(&self, address: Ipv4Addr, now_ms: u64) -> bool {
        self.quarantine
            .get(&address)
            .is_some_and(|until| *until > now_ms)
    }

    #[must_use]
    pub fn lease_secs(&self) -> u32 {
        self.lease_secs
    }

    #[must_use]
    pub fn static_count(&self) -> usize {
        self.statics.len()
    }

    /// The address configured for this MAC, if any.
    #[must_use]
    pub fn reservation_for(&self, mac: &MacKey) -> Option<Ipv4Addr> {
        self.statics.get(mac).copied()
    }

    #[must_use]
    pub fn entry(&self, mac: &MacKey) -> Option<&LeaseEntry> {
        self.entries.get(mac)
    }

    #[must_use]
    pub fn len(&self) -> usize {
        self.entries.len()
    }

    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    // -- reservations --------------------------------------------------------

    /// Holds every configured reservation that falls inside the dynamic pool out
    /// of that pool, before a single packet has been processed.
    ///
    /// The problem this solves: the allocator walks the range and takes the first
    /// address not already claimed. A reservation lives in the configured map,
    /// which that scan does not consult — so until the reserved device happens to
    /// boot, its address is just another free slot, and whichever client
    /// DISCOVERs first walks away with it. The reserved device then arrives to
    /// find its own address in use.
    ///
    /// Reservations *outside* the range are skipped: they never compete with
    /// dynamic allocation, and a placeholder for one would only add a row to a
    /// table that is scanned on every packet.
    ///
    /// **Ordering matters.** This runs *after* the persisted table has been
    /// restored, so a restored lease is already present and can be inspected
    /// here. An entry that already holds the reserved address is left untouched,
    /// which is what lets a rebooted device keep the `bound_at` history the
    /// restore gave it. An entry holding a *different* address is overwritten: a
    /// reservation outranks a persisted dynamic lease.
    ///
    /// Idempotent by construction — running it twice changes nothing, because
    /// the decision derives purely from current configuration and from what the
    /// table already holds.
    pub fn seed_static_reservations(&mut self, now_ms: u64) -> SeedReport {
        let mut report = SeedReport::default();
        for (mac, address) in &self.statics {
            if !is_ip_in_pool(*address, self.range_start, self.range_end) {
                report.skipped.push((mac.clone(), *address));
                continue;
            }
            // Already holding the reserved address — either seeded by an earlier
            // pass or restored from disk with real bind history worth keeping.
            if self.entries.get(mac).is_some_and(|e| e.address == *address) {
                continue;
            }
            self.entries.insert(
                mac.clone(),
                LeaseEntry {
                    address: *address,
                    state: LeaseState::Reserved,
                    bound_at_ms: None,
                    // Never expires while it is a placeholder; `is_live` short-
                    // circuits on the state anyway.
                    expires_at_ms: now_ms,
                    lease_secs: self.lease_secs,
                    hostname: None,
                },
            );
            report.seeded.push((mac.clone(), *address));
        }
        report
    }

    /// Seeds the table from a reconciled set of persisted leases.
    pub fn restore(&mut self, leases: &[LeaseInfo]) {
        for lease in leases {
            self.entries.insert(
                lease.mac.clone(),
                LeaseEntry {
                    address: lease.ip,
                    state: LeaseState::Bound,
                    bound_at_ms: Some(lease.bound_at),
                    expires_at_ms: lease.expires_at,
                    lease_secs: lease.lease_sec,
                    hostname: lease.hostname.clone(),
                },
            );
        }
    }

    // -- allocation ----------------------------------------------------------

    /// Chooses the address to offer or acknowledge to `mac`.
    ///
    /// Precedence, highest first:
    /// 1. a configured reservation for this MAC — always wins, in pool or not;
    /// 2. the address this MAC already holds under a live entry;
    /// 3. the address the client asked for (option 50), if it is inside the pool
    ///    and nobody else holds it;
    /// 4. the lowest free address in the pool.
    ///
    /// `None` means the pool is exhausted.
    #[must_use]
    pub fn select_address(
        &self,
        mac: &MacKey,
        requested: Option<Ipv4Addr>,
        now_ms: u64,
    ) -> Option<Ipv4Addr> {
        if let Some(reserved) = self.statics.get(mac) {
            return Some(*reserved);
        }
        if let Some(entry) = self.entries.get(mac) {
            if entry.is_live(now_ms) {
                return Some(entry.address);
            }
        }
        if let Some(wanted) = requested {
            if is_ip_in_pool(wanted, self.range_start, self.range_end)
                && !self.is_taken_by_other(wanted, mac, now_ms)
            {
                return Some(wanted);
            }
        }
        self.lowest_free_address(mac, now_ms)
    }

    /// Whether some MAC other than `mac` has a live claim on `address`.
    #[must_use]
    fn is_taken_by_other(&self, address: Ipv4Addr, mac: &MacKey, now_ms: u64) -> bool {
        if self.is_quarantined(address, now_ms) {
            return true;
        }
        if self
            .statics
            .iter()
            .any(|(other, reserved)| *reserved == address && other != mac)
        {
            return true;
        }
        self.entries
            .iter()
            .any(|(other, entry)| other != mac && entry.address == address && entry.is_live(now_ms))
    }

    /// The lowest address in the pool nobody holds.
    ///
    /// Walks the *claims* rather than the pool, so the cost is proportional to
    /// the number of leases rather than to the size of the range. A pool
    /// configured as a whole /8 would otherwise make every allocation a scan of
    /// sixteen million addresses on the packet path.
    #[must_use]
    fn lowest_free_address(&self, mac: &MacKey, now_ms: u64) -> Option<Ipv4Addr> {
        let first = u32::from(self.range_start);
        let last = u32::from(self.range_end);
        if first > last {
            return None;
        }
        let mut taken: BTreeSet<u32> = self
            .entries
            .iter()
            .filter(|(other, entry)| *other != mac && entry.is_live(now_ms))
            .map(|(_, entry)| u32::from(entry.address))
            .collect();
        // Configured reservations count as taken even before their placeholder
        // exists — which is what keeps an out-of-pool-seeding edge case from
        // handing a reservation to somebody else.
        taken.extend(
            self.statics
                .iter()
                .filter(|(other, _)| *other != mac)
                .map(|(_, address)| u32::from(*address)),
        );
        taken.extend(
            self.quarantine
                .iter()
                .filter(|(_, until)| **until > now_ms)
                .map(|(address, _)| u32::from(*address)),
        );

        let mut candidate = first;
        for used in taken {
            if used < candidate {
                continue;
            }
            if used == candidate {
                candidate = candidate.checked_add(1)?;
            } else {
                break;
            }
        }
        if candidate > last {
            return None;
        }
        Some(Ipv4Addr::from(candidate))
    }

    // -- transitions ---------------------------------------------------------

    /// Records an OFFER. The address is held, but nothing is bound yet.
    pub fn offer(
        &mut self,
        mac: &MacKey,
        address: Ipv4Addr,
        hostname: Option<String>,
        now_ms: u64,
    ) {
        let previous = self.entries.get(mac);
        let bound_at_ms = previous.and_then(|e| e.bound_at_ms);
        // A device that already holds a bound lease keeps its full remaining
        // term: answering its DISCOVER must not shorten the lease it is still
        // holding to the length of an offer.
        let expires_at_ms = match previous {
            Some(entry) if entry.state == LeaseState::Bound && entry.address == address => {
                entry.expires_at_ms.max(now_ms + u64::from(self.offer_secs) * 1000)
            }
            _ => now_ms + u64::from(self.offer_secs) * 1000,
        };
        let state = if previous.is_some_and(|e| e.state == LeaseState::Bound && e.address == address)
        {
            LeaseState::Bound
        } else {
            LeaseState::Offered
        };
        self.entries.insert(
            mac.clone(),
            LeaseEntry {
                address,
                state,
                bound_at_ms,
                expires_at_ms,
                lease_secs: self.lease_secs,
                hostname: hostname.or_else(|| previous.and_then(|e| e.hostname.clone())),
            },
        );
    }

    /// Records an ACK. Returns whether this was a first bind or a renewal.
    pub fn bind(
        &mut self,
        mac: &MacKey,
        address: Ipv4Addr,
        hostname: Option<String>,
        now_ms: u64,
    ) -> BindOutcome {
        let previous = self.entries.get(mac);
        let already_bound = previous
            .is_some_and(|e| e.state == LeaseState::Bound && e.address == address && e.bound_at_ms.is_some());
        let bound_at_ms = if already_bound {
            previous.and_then(|e| e.bound_at_ms).unwrap_or(now_ms)
        } else {
            now_ms
        };
        let hostname = hostname.or_else(|| previous.and_then(|e| e.hostname.clone()));
        self.entries.insert(
            mac.clone(),
            LeaseEntry {
                address,
                state: LeaseState::Bound,
                bound_at_ms: Some(bound_at_ms),
                expires_at_ms: now_ms + u64::from(self.lease_secs) * 1000,
                lease_secs: self.lease_secs,
                hostname,
            },
        );
        if already_bound {
            BindOutcome::Renewed
        } else {
            BindOutcome::Bound
        }
    }

    /// Gives an address back on DHCPRELEASE. Returns the address released.
    ///
    /// A MAC that has a configured reservation drops back to the placeholder
    /// rather than out of the table: the reservation is configuration, and a
    /// client releasing its lease does not un-configure it.
    pub fn release(&mut self, mac: &MacKey, now_ms: u64) -> Option<Ipv4Addr> {
        let entry = self.entries.remove(mac)?;
        if let Some(reserved) = self.statics.get(mac).copied() {
            if is_ip_in_pool(reserved, self.range_start, self.range_end) {
                self.entries.insert(
                    mac.clone(),
                    LeaseEntry {
                        address: reserved,
                        state: LeaseState::Reserved,
                        bound_at_ms: None,
                        expires_at_ms: now_ms,
                        lease_secs: self.lease_secs,
                        hostname: None,
                    },
                );
            }
        }
        Some(entry.address)
    }

    /// Handles a DHCPDECLINE — the client probed the address it was given and
    /// found somebody else already answering on it.
    ///
    /// The entry is dropped *and* the address is quarantined. Dropping alone
    /// (what the reference does) returns the contested address to the top of the
    /// free list, so the next client to DISCOVER is handed the same conflict.
    pub fn decline(&mut self, mac: &MacKey, declined: Option<Ipv4Addr>, now_ms: u64) -> Option<Ipv4Addr> {
        let address = self.entries.remove(mac).map(|entry| entry.address).or(declined)?;
        if is_ip_in_pool(address, self.range_start, self.range_end) {
            self.quarantine
                .insert(address, now_ms + u64::from(self.quarantine_secs) * 1000);
        }
        Some(address)
    }

    /// Removes every claim whose term has run out. Returns what was removed.
    pub fn expire(&mut self, now_ms: u64) -> Vec<(MacKey, Ipv4Addr)> {
        self.quarantine.retain(|_, until| *until > now_ms);
        let dead: Vec<(MacKey, Ipv4Addr)> = self
            .entries
            .iter()
            .filter(|(_, entry)| !entry.is_live(now_ms))
            .map(|(mac, entry)| (mac.clone(), entry.address))
            .collect();
        for (mac, _) in &dead {
            self.entries.remove(mac);
        }
        // A reservation whose lease just expired goes back to being a
        // placeholder rather than back into the pool.
        if !dead.is_empty() {
            self.seed_static_reservations(now_ms);
        }
        dead
    }

    // -- views ---------------------------------------------------------------

    fn lease_type_for(&self, mac: &MacKey, address: Ipv4Addr) -> LeaseType {
        if self.statics.get(mac) == Some(&address) {
            LeaseType::Static
        } else {
            LeaseType::Dynamic
        }
    }

    fn info_for(&self, mac: &MacKey, entry: &LeaseEntry, now_ms: u64) -> LeaseInfo {
        let bound_at = entry.bound_at_ms.unwrap_or(now_ms);
        let expires_at = entry.expires_at_ms;
        let remaining_sec = expires_at.saturating_sub(now_ms) / 1000;
        LeaseInfo {
            mac: mac.clone(),
            ip: entry.address,
            bound_at,
            lease_sec: entry.lease_secs,
            expires_at,
            remaining_sec,
            hostname: entry.hostname.clone(),
            lease_type: self.lease_type_for(mac, entry.address),
        }
    }

    /// Everything a client currently holds — offers included, reservations not.
    ///
    /// Offers are included because they really do hold an address out of the
    /// pool, and pool utilisation that ignored them would under-report.
    /// Reservations are excluded because no device has claimed one.
    #[must_use]
    pub fn active_leases(&self, now_ms: u64) -> Vec<LeaseInfo> {
        self.entries
            .iter()
            .filter(|(_, entry)| entry.state != LeaseState::Reserved && entry.is_live(now_ms))
            .map(|(mac, entry)| self.info_for(mac, entry, now_ms))
            .collect()
    }

    /// The subset worth writing to disk.
    ///
    /// **Offers are excluded, unlike the reference implementation.** There, an
    /// OFFERED entry reaches the lease file and comes back on the next start as
    /// a BOUND lease — so a scanner that sends DISCOVERs and never answers can
    /// permanently consume the pool, and one DISCOVER from a device that is then
    /// switched off holds its address for a full lease term across every
    /// subsequent restart. An offer is a promise, not a claim, and only claims
    /// are worth surviving a restart.
    #[must_use]
    pub fn persistable_leases(&self, now_ms: u64) -> Vec<LeaseInfo> {
        self.entries
            .iter()
            .filter(|(_, entry)| entry.state == LeaseState::Bound && entry.is_live(now_ms))
            .map(|(mac, entry)| self.info_for(mac, entry, now_ms))
            .collect()
    }

    #[must_use]
    pub fn pool_info(&self, now_ms: u64) -> PoolInfo {
        let size = pool_size(self.range_start, self.range_end);
        let active_count = self.active_leases(now_ms).len();
        let utilization_pct = if size > 0 {
            (active_count as f64 / f64::from(size) * 100.0).min(100.0)
        } else {
            0.0
        };
        PoolInfo {
            range_start: self.range_start,
            range_end: self.range_end,
            pool_size: size,
            active_count,
            utilization_pct,
            static_entry_count: self.statics.len(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: u64 = 1_700_000_000_000;

    fn ip(text: &str) -> Ipv4Addr {
        text.parse().expect("test address parses")
    }

    fn mac(text: &str) -> MacKey {
        MacKey::parse_lossy(text)
    }

    fn table() -> LeaseTable {
        LeaseTable::new(ip("10.0.0.10"), ip("10.0.0.20"), 3600, BTreeMap::new())
    }

    fn table_with_statics(entries: &[(&str, &str)]) -> LeaseTable {
        let statics = entries
            .iter()
            .map(|(m, a)| (mac(m), ip(a)))
            .collect::<BTreeMap<_, _>>();
        LeaseTable::new(ip("10.0.0.10"), ip("10.0.0.20"), 3600, statics)
    }

    // -- allocation ----------------------------------------------------------

    #[test]
    fn the_first_client_gets_the_bottom_of_the_pool() {
        let t = table();
        assert_eq!(t.select_address(&mac("aa:00:00:00:00:01"), None, NOW), Some(ip("10.0.0.10")));
    }

    #[test]
    fn a_second_client_does_not_get_the_first_ones_address() {
        let mut t = table();
        let first = mac("aa:00:00:00:00:01");
        t.bind(&first, ip("10.0.0.10"), None, NOW);
        assert_eq!(
            t.select_address(&mac("aa:00:00:00:00:02"), None, NOW),
            Some(ip("10.0.0.11"))
        );
    }

    #[test]
    fn a_client_is_handed_back_the_address_it_already_holds() {
        let mut t = table();
        let client = mac("aa:00:00:00:00:01");
        t.bind(&client, ip("10.0.0.15"), None, NOW);
        assert_eq!(t.select_address(&client, None, NOW), Some(ip("10.0.0.15")));
    }

    #[test]
    fn a_requested_address_is_honoured_when_it_is_free_and_in_pool() {
        let t = table();
        assert_eq!(
            t.select_address(&mac("aa:00:00:00:00:01"), Some(ip("10.0.0.17")), NOW),
            Some(ip("10.0.0.17"))
        );
    }

    #[test]
    fn a_requested_address_someone_else_holds_is_refused() {
        let mut t = table();
        t.bind(&mac("aa:00:00:00:00:01"), ip("10.0.0.17"), None, NOW);
        assert_eq!(
            t.select_address(&mac("aa:00:00:00:00:02"), Some(ip("10.0.0.17")), NOW),
            Some(ip("10.0.0.10")),
            "a requested address in use must fall back to a free one, not be granted twice"
        );
    }

    #[test]
    fn a_requested_address_outside_the_pool_is_refused() {
        let t = table();
        assert_eq!(
            t.select_address(&mac("aa:00:00:00:00:01"), Some(ip("192.168.9.9")), NOW),
            Some(ip("10.0.0.10"))
        );
    }

    #[test]
    fn an_exhausted_pool_offers_nothing_rather_than_reusing_an_address() {
        let mut t = LeaseTable::new(ip("10.0.0.10"), ip("10.0.0.11"), 3600, BTreeMap::new());
        t.bind(&mac("aa:00:00:00:00:01"), ip("10.0.0.10"), None, NOW);
        t.bind(&mac("aa:00:00:00:00:02"), ip("10.0.0.11"), None, NOW);
        assert_eq!(t.select_address(&mac("aa:00:00:00:00:03"), None, NOW), None);
    }

    #[test]
    fn an_expired_lease_releases_its_address_back_to_the_pool() {
        let mut t = table();
        let gone = mac("aa:00:00:00:00:01");
        t.bind(&gone, ip("10.0.0.10"), None, NOW);
        let later = NOW + 3_600_001;
        assert_eq!(
            t.select_address(&mac("aa:00:00:00:00:02"), None, later),
            Some(ip("10.0.0.10")),
            "a lease whose term ran out must not keep holding its address"
        );
    }

    #[test]
    fn allocation_cost_does_not_scale_with_the_size_of_the_pool() {
        // A whole /8 configured as the pool. Walking the range would be sixteen
        // million iterations on the packet path; walking the claims is three.
        let mut t = LeaseTable::new(ip("10.0.0.0"), ip("10.255.255.255"), 3600, BTreeMap::new());
        t.bind(&mac("aa:00:00:00:00:01"), ip("10.0.0.0"), None, NOW);
        t.bind(&mac("aa:00:00:00:00:02"), ip("10.0.0.1"), None, NOW);
        assert_eq!(
            t.select_address(&mac("aa:00:00:00:00:03"), None, NOW),
            Some(ip("10.0.0.2"))
        );
    }

    // -- reservations --------------------------------------------------------

    #[test]
    fn an_in_pool_reservation_is_held_out_of_the_pool_before_its_device_boots() {
        // Without seeding, the first client to DISCOVER walks away with the
        // reserved address and the reserved device finds its own address taken.
        let mut t = table_with_statics(&[("aa:00:00:00:00:09", "10.0.0.10")]);
        t.seed_static_reservations(NOW);
        assert_eq!(
            t.select_address(&mac("bb:00:00:00:00:01"), None, NOW),
            Some(ip("10.0.0.11")),
            "the reserved address must not be offered to another client"
        );
        assert_eq!(
            t.select_address(&mac("aa:00:00:00:00:09"), None, NOW),
            Some(ip("10.0.0.10"))
        );
    }

    #[test]
    fn a_reservation_typed_with_colons_matches_a_mac_decoded_from_the_wire() {
        // The reference implementation keys the library's static map by the
        // operator's spelling while the library looks it up by the wire
        // spelling, so an out-of-pool reservation typed with colons is silently
        // never honoured.
        let t = table_with_statics(&[("aa:bb:cc:dd:ee:ff", "192.168.50.5")]);
        let from_wire = MacKey::from_hardware(&[0xAA, 0xBB, 0xCC, 0xDD, 0xEE, 0xFF]);
        assert_eq!(
            t.select_address(&from_wire, None, NOW),
            Some(ip("192.168.50.5")),
            "an out-of-pool reservation must be honoured whatever spelling it was typed in"
        );
    }

    #[test]
    fn seeding_is_idempotent_and_leaves_a_restored_lease_alone() {
        let mut t = table_with_statics(&[("aa:00:00:00:00:09", "10.0.0.12")]);
        let reserved_mac = mac("aa:00:00:00:00:09");
        // A restart restored this device's real lease first.
        t.restore(&[LeaseInfo {
            mac: reserved_mac.clone(),
            ip: ip("10.0.0.12"),
            bound_at: 111,
            lease_sec: 3600,
            expires_at: NOW + 1_000_000,
            remaining_sec: 1000,
            hostname: Some("bench".to_owned()),
            lease_type: LeaseType::Static,
        }]);

        let first = t.seed_static_reservations(NOW);
        assert!(first.seeded.is_empty(), "an entry already on its reserved address is left alone");
        let entry = t.entry(&reserved_mac).unwrap();
        assert_eq!(entry.bound_at_ms, Some(111), "the restored bind time must survive seeding");
        assert_eq!(entry.state, LeaseState::Bound);
        assert_eq!(entry.hostname.as_deref(), Some("bench"));

        // And a second pass changes nothing at all.
        let before = t.clone();
        let second = t.seed_static_reservations(NOW);
        assert!(second.seeded.is_empty());
        assert_eq!(t.entry(&reserved_mac), before.entry(&reserved_mac));
    }

    #[test]
    fn a_reservation_overrides_a_persisted_lease_on_a_different_address() {
        let mut t = table_with_statics(&[("aa:00:00:00:00:09", "10.0.0.12")]);
        let reserved_mac = mac("aa:00:00:00:00:09");
        t.restore(&[LeaseInfo {
            mac: reserved_mac.clone(),
            ip: ip("10.0.0.18"),
            bound_at: 111,
            lease_sec: 3600,
            expires_at: NOW + 1_000_000,
            remaining_sec: 1000,
            hostname: None,
            lease_type: LeaseType::Dynamic,
        }]);
        let report = t.seed_static_reservations(NOW);
        assert_eq!(report.seeded.len(), 1);
        assert_eq!(t.entry(&reserved_mac).unwrap().address, ip("10.0.0.12"));
    }

    #[test]
    fn an_out_of_pool_reservation_needs_no_placeholder() {
        let mut t = table_with_statics(&[("aa:00:00:00:00:09", "192.168.50.5")]);
        let report = t.seed_static_reservations(NOW);
        assert!(report.seeded.is_empty());
        assert_eq!(report.skipped.len(), 1);
        assert!(t.is_empty(), "a placeholder outside the pool would only be a row to scan");
    }

    #[test]
    fn a_reservation_placeholder_is_not_an_active_lease() {
        let mut t = table_with_statics(&[("aa:00:00:00:00:09", "10.0.0.12")]);
        t.seed_static_reservations(NOW);
        assert!(
            t.active_leases(NOW).is_empty(),
            "a device that has not booted must not appear in Active Leases"
        );
        assert!(
            t.persistable_leases(NOW).is_empty(),
            "a persisted reservation would come back as a real lease on the next start"
        );
        assert_eq!(t.pool_info(NOW).active_count, 0);
    }

    #[test]
    fn a_reservation_never_expires_while_it_is_configured() {
        let mut t = table_with_statics(&[("aa:00:00:00:00:09", "10.0.0.12")]);
        t.seed_static_reservations(NOW);
        let far_future = NOW + 400 * 24 * 3_600_000;
        assert!(t.expire(far_future).is_empty());
        assert_eq!(
            t.select_address(&mac("bb:00:00:00:00:01"), None, far_future),
            Some(ip("10.0.0.10")),
            "and it is still held out of the pool"
        );
        assert!(t.entry(&mac("aa:00:00:00:00:09")).is_some());
    }

    // -- transitions ---------------------------------------------------------

    #[test]
    fn an_offer_holds_the_address_but_is_not_a_bind() {
        let mut t = table();
        let client = mac("aa:00:00:00:00:01");
        t.offer(&client, ip("10.0.0.10"), None, NOW);
        assert_eq!(t.entry(&client).unwrap().state, LeaseState::Offered);
        assert_eq!(t.entry(&client).unwrap().bound_at_ms, None);
        assert_eq!(
            t.select_address(&mac("aa:00:00:00:00:02"), None, NOW),
            Some(ip("10.0.0.11")),
            "an offered address must not be offered to a second client"
        );
    }

    #[test]
    fn an_unclaimed_offer_lapses_long_before_a_lease_would() {
        // The reference gives an offer a full lease term and then persists it,
        // so a scanner sending DISCOVERs consumes the pool for a day.
        let mut t = table();
        t.offer(&mac("aa:00:00:00:00:01"), ip("10.0.0.10"), None, NOW);
        let after_offer = NOW + u64::from(DEFAULT_OFFER_SECS) * 1000 + 1;
        assert_eq!(t.expire(after_offer).len(), 1);
        assert_eq!(
            t.select_address(&mac("aa:00:00:00:00:02"), None, after_offer),
            Some(ip("10.0.0.10"))
        );
    }

    #[test]
    fn a_bind_after_an_offer_is_a_bind_and_a_second_one_is_a_renewal() {
        let mut t = table();
        let client = mac("aa:00:00:00:00:01");
        t.offer(&client, ip("10.0.0.10"), None, NOW);
        assert_eq!(t.bind(&client, ip("10.0.0.10"), None, NOW), BindOutcome::Bound);
        assert_eq!(
            t.bind(&client, ip("10.0.0.10"), None, NOW + 60_000),
            BindOutcome::Renewed
        );
        assert_eq!(
            t.entry(&client).unwrap().bound_at_ms,
            Some(NOW),
            "a renewal keeps the original bind time"
        );
    }

    #[test]
    fn a_bind_on_a_different_address_is_a_new_bind_not_a_renewal() {
        let mut t = table();
        let client = mac("aa:00:00:00:00:01");
        t.bind(&client, ip("10.0.0.10"), None, NOW);
        assert_eq!(
            t.bind(&client, ip("10.0.0.11"), None, NOW + 1000),
            BindOutcome::Bound
        );
        assert_eq!(t.entry(&client).unwrap().bound_at_ms, Some(NOW + 1000));
    }

    #[test]
    fn a_discover_from_a_bound_client_does_not_shorten_its_lease() {
        let mut t = table();
        let client = mac("aa:00:00:00:00:01");
        t.bind(&client, ip("10.0.0.10"), None, NOW);
        let expires = t.entry(&client).unwrap().expires_at_ms;
        t.offer(&client, ip("10.0.0.10"), None, NOW + 1000);
        assert_eq!(
            t.entry(&client).unwrap().expires_at_ms,
            expires,
            "re-offering the address a client already holds must not cut its term to an offer window"
        );
        assert_eq!(t.entry(&client).unwrap().state, LeaseState::Bound);
    }

    #[test]
    fn a_release_returns_the_address_to_the_pool() {
        let mut t = table();
        let client = mac("aa:00:00:00:00:01");
        t.bind(&client, ip("10.0.0.10"), None, NOW);
        assert_eq!(t.release(&client, NOW), Some(ip("10.0.0.10")));
        assert_eq!(
            t.select_address(&mac("aa:00:00:00:00:02"), None, NOW),
            Some(ip("10.0.0.10"))
        );
    }

    #[test]
    fn releasing_a_reserved_lease_leaves_the_reservation_standing() {
        let mut t = table_with_statics(&[("aa:00:00:00:00:09", "10.0.0.12")]);
        let reserved = mac("aa:00:00:00:00:09");
        t.seed_static_reservations(NOW);
        t.bind(&reserved, ip("10.0.0.12"), None, NOW);
        t.release(&reserved, NOW);
        assert_eq!(
            t.select_address(&mac("bb:00:00:00:00:01"), None, NOW),
            Some(ip("10.0.0.10")),
            "a client releasing its lease does not un-configure the reservation"
        );
        assert_eq!(t.entry(&reserved).unwrap().state, LeaseState::Reserved);
    }

    #[test]
    fn a_decline_drops_the_entry() {
        let mut t = table();
        let client = mac("aa:00:00:00:00:01");
        t.bind(&client, ip("10.0.0.10"), None, NOW);
        assert_eq!(t.decline(&client, None, NOW), Some(ip("10.0.0.10")));
        assert!(t.entry(&client).is_none());
    }

    #[test]
    fn a_declined_address_is_not_handed_straight_to_the_next_client() {
        // A DECLINE means a host nobody told us about is already answering on
        // that address. Returning it to the free list repeats the conflict
        // immediately, which is what the reference implementation does.
        let mut t = table();
        t.bind(&mac("aa:00:00:00:00:01"), ip("10.0.0.10"), None, NOW);
        t.decline(&mac("aa:00:00:00:00:01"), None, NOW);
        assert_eq!(
            t.select_address(&mac("bb:00:00:00:00:02"), None, NOW),
            Some(ip("10.0.0.11")),
            "the contested address must be skipped"
        );
        // Even if the next client asks for it by name.
        assert_eq!(
            t.select_address(&mac("bb:00:00:00:00:02"), Some(ip("10.0.0.10")), NOW),
            Some(ip("10.0.0.11"))
        );
    }

    #[test]
    fn a_quarantine_lapses_and_the_address_returns_to_the_pool() {
        let mut t = table();
        t.bind(&mac("aa:00:00:00:00:01"), ip("10.0.0.10"), None, NOW);
        t.decline(&mac("aa:00:00:00:00:01"), None, NOW);
        let after = NOW + u64::from(DEFAULT_DECLINE_QUARANTINE_SECS) * 1000 + 1;
        assert!(!t.is_quarantined(ip("10.0.0.10"), after));
        assert_eq!(
            t.select_address(&mac("bb:00:00:00:00:02"), None, after),
            Some(ip("10.0.0.10"))
        );
    }

    #[test]
    fn a_decline_from_a_client_with_no_entry_still_quarantines_what_it_names() {
        let mut t = table();
        assert_eq!(
            t.decline(&mac("aa:00:00:00:00:01"), Some(ip("10.0.0.14")), NOW),
            Some(ip("10.0.0.14"))
        );
        assert!(t.is_quarantined(ip("10.0.0.14"), NOW));
    }

    // -- views ---------------------------------------------------------------

    #[test]
    fn a_lease_snapshot_carries_what_the_sidebar_renders() {
        let mut t = table_with_statics(&[("aa:00:00:00:00:09", "10.0.0.12")]);
        let reserved = mac("aa:00:00:00:00:09");
        t.bind(&reserved, ip("10.0.0.12"), Some("bench-sw".to_owned()), NOW);
        let leases = t.active_leases(NOW + 600_000);
        assert_eq!(leases.len(), 1);
        let lease = &leases[0];
        assert_eq!(lease.ip, ip("10.0.0.12"));
        assert_eq!(lease.lease_type, LeaseType::Static);
        assert_eq!(lease.hostname.as_deref(), Some("bench-sw"));
        assert_eq!(lease.bound_at, NOW);
        assert_eq!(lease.expires_at, NOW + 3_600_000);
        assert_eq!(lease.remaining_sec, 3000);
    }

    #[test]
    fn utilisation_is_a_percentage_of_the_configured_pool() {
        let mut t = table(); // 10.0.0.10 - 10.0.0.20 is 11 addresses
        assert_eq!(t.pool_info(NOW).pool_size, 11);
        t.bind(&mac("aa:00:00:00:00:01"), ip("10.0.0.10"), None, NOW);
        let info = t.pool_info(NOW);
        assert_eq!(info.active_count, 1);
        assert!((info.utilization_pct - 100.0 / 11.0).abs() < 1e-9);
        assert_eq!(info.static_entry_count, 0);
    }

    #[test]
    fn an_inverted_pool_reports_no_utilisation_rather_than_dividing_by_zero() {
        let t = LeaseTable::new(ip("10.0.0.20"), ip("10.0.0.10"), 3600, BTreeMap::new());
        let info = t.pool_info(NOW);
        assert_eq!(info.pool_size, 0);
        assert!((info.utilization_pct - 0.0).abs() < f64::EPSILON);
    }
}
