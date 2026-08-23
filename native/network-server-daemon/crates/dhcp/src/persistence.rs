//! The on-disk lease table.
//!
//! # Why this exists
//!
//! The lease table lives in memory. A daemon restart — crash, extension reload,
//! editor restart — therefore starts with an empty one, and the very next
//! DISCOVER can be handed an address a device on the bench is still holding
//! under an unexpired lease. Two devices, one IP: exactly the failure a lab DHCP
//! server exists to avoid.
//!
//! # Why the file is written the way it is
//!
//! - **Atomic.** The write goes to a temp file *in the same directory*, is
//!   flushed to the filesystem, and is then renamed over the target. A crash
//!   mid-write leaves either the previous complete file or an orphan temp file —
//!   never a truncated lease table, which is worse than no file at all because
//!   it silently restores a partial view of who owns what. Same directory
//!   matters: `rename` is only atomic within a filesystem.
//! - **Flushed before the rename.** The TypeScript original writes and renames
//!   without an `fsync`, so a machine that loses power just after the rename can
//!   come back to a file whose directory entry exists and whose contents do not.
//!   `sync_all` closes that window.
//! - **Debounced, but not here.** The reference needed its own timer because it
//!   ran on an event loop with nothing else to pace it. This engine already has
//!   a tick, so the debounce lives there and this module stays a pure
//!   read/write/reconcile surface.
//!
//! # Format
//!
//! Byte-compatible with the TypeScript implementation's file, deliberately: the
//! two can be swapped underneath the same extension without a device losing its
//! address.

use std::fs;
use std::io::{self, Write};
use std::net::Ipv4Addr;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};

use crate::constants::{MAX_DHCP_FIELD_BYTES, MAX_DHCP_POOL_SIZE, MAX_STATIC_RESERVATIONS};
use crate::lease::{LeaseInfo, LeaseType};
use crate::net::{is_ip_in_pool, MacKey};

/// Schema version of the on-disk file.
///
/// A file written by a different version is discarded rather than migrated: the
/// whole table is rebuilt within one renewal cycle anyway, so the cost of
/// dropping it is far below the cost of mis-reading it.
pub const LEASE_STORE_VERSION: u64 = 1;

/// Upper bound on one pretty-printed lease record.
///
/// The measured worst case is 793 bytes: a 17-character MAC, a 15-character
/// address, `u64::MAX` timestamps, and a hostname at the sanitizer's 255-byte
/// ceiling made entirely of characters JSON escapes to two bytes each. Rounded
/// up to leave room for a field being added without silently invalidating every
/// file already on disk.
const MAX_LEASE_RECORD_BYTES: u64 = 1024;

/// Every lease the writer can be asked to persist at once.
///
/// One bound lease occupies one address, so the dynamic pool caps the count —
/// except that a static reservation may sit outside the range and add to it.
const MAX_PERSISTED_LEASES: u64 =
    MAX_DHCP_POOL_SIZE as u64 + MAX_STATIC_RESERVATIONS as u64;

/// Refuses to read a lease file larger than this.
///
/// It exists so that a corrupt or hostile file cannot make start-up allocate
/// without bound, on a path that runs before the socket is serving. It is
/// *derived* rather than chosen: a limit below what `save_leases` can produce
/// makes the daemon silently discard its own file, forget every still-valid
/// lease, and hand out addresses that clients are still using — the failure is
/// invisible because a rejected file is indistinguishable from no file at all.
/// The previous fixed 8 MiB was roughly a sixth of what a fully-populated
/// supported pool writes.
pub const MAX_LEASE_FILE_BYTES: u64 = MAX_PERSISTED_LEASES * MAX_LEASE_RECORD_BYTES + 4096;

/// Why a persisted lease was not restored.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DropReason {
    Expired,
    StaticConflict,
    OutOfPool,
}

impl DropReason {
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Expired => "expired",
            Self::StaticConflict => "static-conflict",
            Self::OutOfPool => "out-of-pool",
        }
    }
}

/// A persisted lease reconciliation refused to restore, and why.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DroppedLease {
    pub lease: LeaseInfo,
    pub reason: DropReason,
}

/// Outcome of [`reconcile`].
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ReconcileResult {
    pub restored: Vec<LeaseInfo>,
    pub dropped: Vec<DroppedLease>,
}

/// The configuration a persisted lease has to still agree with.
#[derive(Debug, Clone)]
pub struct ReconcileContext<'a> {
    pub statics: &'a std::collections::BTreeMap<MacKey, Ipv4Addr>,
    pub range_start: Ipv4Addr,
    pub range_end: Ipv4Addr,
    /// Epoch ms used to decide expiry — injected so tests are deterministic.
    pub now_ms: u64,
}

/// Reads the persisted lease table.
///
/// Every failure mode — absent file, unreadable file, malformed JSON, wrong
/// schema version, junk entries — degrades to "no leases restored" rather than
/// failing: a DHCP server that refuses to start because of a bad cache file is
/// strictly worse than one that starts with a cold table.
///
/// Junk is filtered *per record*, so one malformed entry does not discard the
/// rest of a file that is otherwise fine.
#[must_use]
pub fn load_leases(path: &Path) -> Vec<LeaseInfo> {
    let Ok(metadata) = fs::metadata(path) else {
        return Vec::new();
    };
    if metadata.len() > MAX_LEASE_FILE_BYTES {
        return Vec::new();
    }
    let Ok(raw) = fs::read_to_string(path) else {
        return Vec::new();
    };
    let Ok(parsed) = serde_json::from_str::<Value>(&raw) else {
        return Vec::new();
    };
    if parsed.get("version").and_then(Value::as_u64) != Some(LEASE_STORE_VERSION) {
        return Vec::new();
    }
    let Some(entries) = parsed.get("leases").and_then(Value::as_array) else {
        return Vec::new();
    };
    // Bounded as well as filtered. A file holding more live records than the
    // writer could have produced — corruption, a hand edit, a file from a
    // differently configured pool — otherwise restores them all, and
    // `reconcile` does not collapse records that share an address. The surplus
    // reaches the runtime snapshot, where the host bounds the lease array at
    // the same figure and reads anything longer as a malformed response,
    // retiring the daemon. Truncating keeps the server running on as much of
    // its cache as the protocol can actually carry, which is the same
    // degrade-rather-than-fail choice the rest of this function makes.
    entries
        .iter()
        .filter_map(lease_from_json)
        .take(MAX_PERSISTED_LEASES as usize)
        .collect()
}

/// Rejects anything that is not a complete, well-typed lease record.
fn lease_from_json(value: &Value) -> Option<LeaseInfo> {
    // `MacKey::parse_lossy` keeps whatever it cannot parse, so an oversized
    // `mac` here would survive into the lease and be echoed straight back out
    // by `lease_to_json` — past the host's per-field ceiling, which costs the
    // whole response and the daemon with it. From a file, that recurs on every
    // start until somebody edits it.
    let mac = value
        .get("mac")?
        .as_str()
        .filter(|s| !s.is_empty() && s.len() <= MAX_DHCP_FIELD_BYTES)?;
    let ip: Ipv4Addr = value.get("ip")?.as_str()?.parse().ok()?;
    let bound_at = finite_ms(value.get("boundAt")?)?;
    let lease_sec = value.get("leaseSec").and_then(Value::as_f64)?;
    if !lease_sec.is_finite() || lease_sec < 0.0 {
        return None;
    }
    let expires_at = finite_ms(value.get("expiresAt")?)?;
    let hostname = match value.get("hostname") {
        None | Some(Value::Null) => None,
        Some(Value::String(text)) => Some(crate::protocol::sanitize_text(text)),
        Some(_) => return None,
    };
    let lease_type = LeaseType::from_str_lossy(value.get("leaseType")?.as_str()?)?;
    // Proven finite and non-negative above; the cast is a clamp, not a
    // reinterpretation.
    #[allow(clippy::cast_sign_loss, reason = "the value is checked non-negative above")]
    let lease_sec = lease_sec as u32;
    Some(LeaseInfo {
        mac: MacKey::parse_lossy(mac),
        ip,
        bound_at,
        lease_sec,
        expires_at,
        remaining_sec: expires_at.saturating_sub(bound_at) / 1000,
        hostname,
        lease_type,
    })
}

/// Accepts a JSON number that is a finite, non-negative epoch-millisecond value.
fn finite_ms(value: &Value) -> Option<u64> {
    let number = value.as_f64()?;
    if !number.is_finite() || number < 0.0 {
        return None;
    }
    #[allow(clippy::cast_sign_loss, reason = "the value is checked non-negative above")]
    let millis = number as u64;
    Some(millis)
}

/// Writes the lease table atomically.
///
/// The parent directory is created on demand — on a fresh install the
/// extension's global storage folder may not exist yet.
pub fn save_leases(path: &Path, leases: &[LeaseInfo]) -> io::Result<()> {
    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() {
            fs::create_dir_all(parent)?;
        }
    }
    let payload = json!({
        "version": LEASE_STORE_VERSION,
        "savedAt": now_epoch_ms(),
        "leases": leases.iter().map(lease_to_json).collect::<Vec<_>>(),
    });
    let text = serde_json::to_string_pretty(&payload)
        .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;

    let temp = temp_path(path);
    // The temp file is written, flushed and closed before the rename, so the
    // rename can only ever publish complete content.
    {
        let mut file = fs::File::create(&temp)?;
        file.write_all(text.as_bytes())?;
        file.sync_all()?;
    }
    match fs::rename(&temp, path) {
        Ok(()) => Ok(()),
        Err(error) => {
            // Leaving the temp file behind would accumulate one orphan per
            // failed write, in the directory the next read scans.
            let _ = fs::remove_file(&temp);
            Err(error)
        }
    }
}

/// The temp file's path: same directory (so `rename` stays atomic), and named
/// after this process so two daemons cannot collide on it.
fn temp_path(path: &Path) -> PathBuf {
    let mut name = path.file_name().unwrap_or_default().to_os_string();
    name.push(format!(".{}.tmp", std::process::id()));
    path.with_file_name(name)
}

fn lease_to_json(lease: &LeaseInfo) -> Value {
    json!({
        "mac": lease.mac.as_str(),
        "ip": lease.ip.to_string(),
        "boundAt": lease.bound_at,
        "leaseSec": lease.lease_sec,
        "expiresAt": lease.expires_at,
        "remainingSec": lease.remaining_sec,
        "hostname": lease.hostname,
        "leaseType": lease.lease_type.as_str(),
    })
}

#[must_use]
pub fn now_epoch_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX))
}

/// Decides which persisted leases may be restored under the configuration
/// currently in effect.
///
/// Configuration always wins over the file, because the file describes a world
/// that may be several edits old:
///
/// - **Expired** leases are dropped — the device no longer has a claim.
/// - A MAC that now has a **static reservation** must take the reserved address.
///   Restoring a persisted dynamic one instead would defeat the reservation for
///   as long as the client kept renewing.
/// - A lease on an address now **reserved for a different MAC** is dropped for
///   the same reason in reverse: keeping it re-creates the IP conflict this
///   module exists to prevent.
/// - A dynamic lease now **outside the pool** is dropped — the range was
///   re-pointed at a different subnet since the file was written.
///
/// A lease whose MAC still holds the same reservation is kept, so a reserved
/// device keeps its bind time and hostname across a restart.
#[must_use]
pub fn reconcile(leases: &[LeaseInfo], context: &ReconcileContext<'_>) -> ReconcileResult {
    let mut result = ReconcileResult::default();
    for lease in leases {
        if lease.expires_at <= context.now_ms {
            result.dropped.push(DroppedLease { lease: lease.clone(), reason: DropReason::Expired });
            continue;
        }
        // The lookup is by canonical key on both sides — a reservation typed
        // with colons and a lease keyed off the wire must meet.
        if let Some(reserved) = context.statics.get(&lease.mac) {
            if *reserved == lease.ip {
                result.restored.push(LeaseInfo { lease_type: LeaseType::Static, ..lease.clone() });
            } else {
                result.dropped.push(DroppedLease {
                    lease: lease.clone(),
                    reason: DropReason::StaticConflict,
                });
            }
            continue;
        }
        if context.statics.values().any(|reserved| *reserved == lease.ip) {
            result.dropped.push(DroppedLease {
                lease: lease.clone(),
                reason: DropReason::StaticConflict,
            });
            continue;
        }
        if !is_ip_in_pool(lease.ip, context.range_start, context.range_end) {
            result
                .dropped
                .push(DroppedLease { lease: lease.clone(), reason: DropReason::OutOfPool });
            continue;
        }
        result.restored.push(LeaseInfo { lease_type: LeaseType::Dynamic, ..lease.clone() });
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testsupport::TempDir;
    use std::collections::BTreeMap;

    const NOW: u64 = 1_700_000_000_000;

    fn ip(text: &str) -> Ipv4Addr {
        text.parse().expect("test address parses")
    }

    fn lease(mac: &str, address: &str, expires_at: u64) -> LeaseInfo {
        LeaseInfo {
            mac: MacKey::parse_lossy(mac),
            ip: ip(address),
            bound_at: NOW,
            lease_sec: 3600,
            expires_at,
            remaining_sec: expires_at.saturating_sub(NOW) / 1000,
            hostname: Some("bench".to_owned()),
            lease_type: LeaseType::Dynamic,
        }
    }

    fn statics(entries: &[(&str, &str)]) -> BTreeMap<MacKey, Ipv4Addr> {
        entries
            .iter()
            .map(|(m, a)| (MacKey::parse_lossy(m), ip(a)))
            .collect()
    }

    fn context(map: &BTreeMap<MacKey, Ipv4Addr>) -> ReconcileContext<'_> {
        ReconcileContext {
            statics: map,
            range_start: ip("10.0.0.10"),
            range_end: ip("10.0.0.20"),
            now_ms: NOW,
        }
    }

    // -- round trip ----------------------------------------------------------

    #[test]
    fn a_saved_table_reads_back_identical() {
        let dir = TempDir::new("dhcp-persist");
        let path = dir.path().join("nested").join("dhcp-leases.json");
        let leases = vec![lease("aa:bb:cc:dd:ee:ff", "10.0.0.10", NOW + 3_600_000)];
        save_leases(&path, &leases).expect("the parent directory is created on demand");

        let loaded = load_leases(&path);
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].mac.as_str(), "AA-BB-CC-DD-EE-FF");
        assert_eq!(loaded[0].ip, ip("10.0.0.10"));
        assert_eq!(loaded[0].bound_at, NOW);
        assert_eq!(loaded[0].expires_at, NOW + 3_600_000);
        assert_eq!(loaded[0].hostname.as_deref(), Some("bench"));
    }

    #[test]
    fn the_file_is_the_shape_the_typescript_implementation_writes() {
        // The two implementations share this file. A field renamed on one side
        // silently costs every device its address on the next swap.
        let dir = TempDir::new("dhcp-format");
        let path = dir.path().join("dhcp-leases.json");
        save_leases(&path, &[lease("aa:bb:cc:dd:ee:ff", "10.0.0.10", NOW + 1000)]).unwrap();
        let value: Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(value["version"], json!(1));
        assert!(value["savedAt"].is_number());
        let record = &value["leases"][0];
        for key in [
            "mac",
            "ip",
            "boundAt",
            "leaseSec",
            "expiresAt",
            "remainingSec",
            "hostname",
            "leaseType",
        ] {
            assert!(record.get(key).is_some(), "missing member {key}");
        }
        assert_eq!(record["leaseType"], json!("dynamic"));
        assert_eq!(record["ip"], json!("10.0.0.10"));
    }

    // -- atomicity -----------------------------------------------------------

    #[test]
    fn a_write_never_leaves_a_temp_file_behind() {
        let dir = TempDir::new("dhcp-atomic");
        let path = dir.path().join("dhcp-leases.json");
        for round in 0..5u64 {
            save_leases(&path, &[lease("aa:bb:cc:dd:ee:ff", "10.0.0.10", NOW + round + 1)]).unwrap();
        }
        let strays: Vec<_> = fs::read_dir(dir.path())
            .unwrap()
            .filter_map(Result::ok)
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|name| name.to_lowercase().ends_with(".tmp"))
            .collect();
        assert!(strays.is_empty(), "left temp files behind: {strays:?}");
    }

    #[test]
    fn an_interrupted_write_leaves_the_previous_table_intact() {
        // The atomicity property, made observable: the new content is staged in
        // a temp file and only becomes visible at the rename. Making the temp
        // path unusable stands in for the crash — the write fails, and the table
        // that was already on disk is still exactly what it was.
        //
        // A write that went straight at the target would instead have replaced
        // it, which is the whole failure this design exists to prevent: a
        // half-written lease table silently restores a partial view of who owns
        // what, and that is worse than having no file at all.
        let dir = TempDir::new("dhcp-interrupted");
        let path = dir.path().join("dhcp-leases.json");
        save_leases(&path, &[lease("aa:00:00:00:00:01", "10.0.0.10", NOW + 3_600_000)]).unwrap();

        // Occupy the temp path with a directory, which cannot be opened as a file.
        fs::create_dir(temp_path(&path)).unwrap();
        let result = save_leases(&path, &[lease("bb:00:00:00:00:02", "10.0.0.11", NOW + 3_600_000)]);
        assert!(result.is_err(), "the staged write could not have succeeded");

        let survivors = load_leases(&path);
        assert_eq!(survivors.len(), 1);
        assert_eq!(
            survivors[0].ip,
            ip("10.0.0.10"),
            "the previous lease table must have survived untouched"
        );
    }

    #[test]
    fn the_temp_file_lives_in_the_same_directory_as_the_target() {
        // `rename` is only atomic within one filesystem. A temp file in the
        // system temp directory would silently degrade to a copy — and a copy
        // can be interrupted half-written.
        let target = Path::new("/var/lib/nexus/dhcp-leases.json");
        assert_eq!(temp_path(target).parent(), target.parent());
        assert!(temp_path(target)
            .file_name()
            .unwrap()
            .to_string_lossy()
            .starts_with("dhcp-leases.json."));
    }

    #[test]
    fn an_overwrite_replaces_the_previous_content_rather_than_appending() {
        let dir = TempDir::new("dhcp-overwrite");
        let path = dir.path().join("dhcp-leases.json");
        save_leases(&path, &[lease("aa:00:00:00:00:01", "10.0.0.10", NOW + 1000)]).unwrap();
        save_leases(&path, &[lease("aa:00:00:00:00:02", "10.0.0.11", NOW + 1000)]).unwrap();
        let loaded = load_leases(&path);
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].ip, ip("10.0.0.11"));
    }

    // -- reading junk --------------------------------------------------------

    #[test]
    fn an_absent_file_is_an_empty_table_not_a_failure() {
        let dir = TempDir::new("dhcp-absent");
        assert!(load_leases(&dir.path().join("nothing-here.json")).is_empty());
    }

    #[test]
    fn a_malformed_or_wrong_version_file_is_discarded_whole() {
        let dir = TempDir::new("dhcp-junk");
        for (name, content) in [
            ("garbage.json", "not json at all"),
            ("array.json", "[1,2,3]"),
            ("version.json", r#"{"version":2,"leases":[]}"#),
            ("noleases.json", r#"{"version":1}"#),
            ("leasesnotarray.json", r#"{"version":1,"leases":{}}"#),
        ] {
            let path = dir.path().join(name);
            fs::write(&path, content).unwrap();
            assert!(load_leases(&path).is_empty(), "{name} should have been discarded");
        }
    }

    #[test]
    fn one_junk_record_does_not_discard_the_rest_of_the_file() {
        let dir = TempDir::new("dhcp-mixed");
        let path = dir.path().join("dhcp-leases.json");
        let payload = json!({
            "version": 1,
            "savedAt": NOW,
            "leases": [
                {"mac": "AA-00-00-00-00-01", "ip": "10.0.0.10", "boundAt": NOW,
                 "leaseSec": 3600, "expiresAt": NOW + 1000, "hostname": null,
                 "leaseType": "dynamic"},
                {"mac": "", "ip": "10.0.0.11", "boundAt": NOW, "leaseSec": 3600,
                 "expiresAt": NOW + 1000, "hostname": null, "leaseType": "dynamic"},
                {"mac": "AA-00-00-00-00-03", "ip": "not-an-address", "boundAt": NOW,
                 "leaseSec": 3600, "expiresAt": NOW + 1000, "hostname": null,
                 "leaseType": "dynamic"},
                {"mac": "AA-00-00-00-00-04", "ip": "10.0.0.13", "boundAt": NOW,
                 "leaseSec": 3600, "expiresAt": NOW + 1000, "hostname": 42,
                 "leaseType": "dynamic"},
                {"mac": "AA-00-00-00-00-05", "ip": "10.0.0.14", "boundAt": NOW,
                 "leaseSec": 3600, "expiresAt": NOW + 1000, "hostname": null,
                 "leaseType": "teleported"},
                {"mac": "AA-00-00-00-00-06", "ip": "10.0.0.15", "boundAt": NOW,
                 "leaseSec": 3600, "expiresAt": NOW + 1000, "hostname": "ok",
                 "leaseType": "static"}
            ]
        });
        fs::write(&path, serde_json::to_string(&payload).unwrap()).unwrap();
        let loaded = load_leases(&path);
        assert_eq!(loaded.len(), 2, "only the two well-formed records survive");
        assert_eq!(loaded[0].ip, ip("10.0.0.10"));
        assert_eq!(loaded[1].ip, ip("10.0.0.15"));
    }

    #[test]
    fn more_records_than_the_runtime_protocol_carries_are_not_all_restored() {
        use std::fmt::Write as _;
        // A cache holding more live records than the writer could ever have
        // produced — corruption, a hand edit, a file from a differently
        // configured pool — was restored whole. `reconcile` does not collapse
        // records sharing an IP, so the surplus survives into the runtime
        // snapshot, where the host bounds the lease array at
        // MAX_DHCP_RUNTIME_LEASES and treats anything longer as a malformed
        // response, terminating the daemon.
        let dir = TempDir::new("dhcp-too-many");
        let path = dir.path().join("dhcp-leases.json");
        let surplus = MAX_PERSISTED_LEASES as usize + 16;
        let mut records = String::from("[");
        for i in 0..surplus {
            if i > 0 {
                records.push(',');
            }
            // Distinct MACs so nothing dedupes them away for the wrong reason.
            let mac = format!("AA-BB-CC-{:02X}-{:02X}-{:02X}", (i >> 16) & 0xFF, (i >> 8) & 0xFF, i & 0xFF);
            write!(
                records,
                r#"{{"mac":"{mac}","ip":"10.0.0.1","boundAt":{NOW},"leaseSec":3600,"expiresAt":{},"remainingSec":3600,"hostname":null,"leaseType":"dynamic"}}"#,
                NOW + 3_600_000
            )
            .unwrap();
        }
        records.push(']');
        fs::write(&path, format!(r#"{{"version":1,"savedAt":{NOW},"leases":{records}}}"#)).unwrap();

        let loaded = load_leases(&path);

        assert!(
            loaded.len() as u64 <= MAX_PERSISTED_LEASES,
            "restored {} records; the runtime protocol carries at most {MAX_PERSISTED_LEASES}",
            loaded.len()
        );
    }

    #[test]
    fn a_persisted_mac_too_long_for_the_runtime_protocol_is_dropped() {
        // `MacKey::parse_lossy` keeps whatever it cannot parse, so an oversized
        // `mac` in the file survives into the lease and is echoed straight back
        // out by `lease_to_json`. The host bounds every DHCP lease field at 255
        // bytes and rejects the whole response above it, taking the daemon down
        // with it — from a file, so it recurs on every start.
        let dir = TempDir::new("dhcp-long-mac");
        let path = dir.path().join("dhcp-leases.json");
        let payload = json!({
            "version": 1, "savedAt": NOW,
            "leases": [
                {"mac": "Z".repeat(300), "ip": "10.0.0.10", "boundAt": NOW,
                 "leaseSec": 3600, "expiresAt": NOW + 3_600_000, "remainingSec": 3600,
                 "hostname": null, "leaseType": "dynamic"},
                {"mac": "AA-00-00-00-00-01", "ip": "10.0.0.11", "boundAt": NOW,
                 "leaseSec": 3600, "expiresAt": NOW + 3_600_000, "remainingSec": 3600,
                 "hostname": null, "leaseType": "dynamic"}
            ]
        });
        fs::write(&path, serde_json::to_string(&payload).unwrap()).unwrap();

        let loaded = load_leases(&path);

        assert_eq!(loaded.len(), 1, "the oversized record must not be restored");
        assert_eq!(
            loaded[0].ip,
            ip("10.0.0.11"),
            "and the sound record beside it still is"
        );
    }

    #[test]
    fn the_read_limit_admits_the_largest_file_the_writer_can_produce() {
        // A read limit below what `save_leases` can write makes the daemon
        // discard its own file on the next start. Nothing reports that: a
        // rejected file is indistinguishable from no file, so the server simply
        // forgets every still-valid lease and starts handing out addresses that
        // clients are still using.
        let dir = TempDir::new("dhcp-file-ceiling");
        let worst = LeaseInfo {
            mac: MacKey::from_hardware(&[0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff]),
            ip: Ipv4Addr::BROADCAST,
            bound_at: u64::MAX,
            lease_sec: u32::MAX,
            expires_at: u64::MAX,
            remaining_sec: u64::MAX,
            // The sanitizer's ceiling, of a character JSON escapes to two bytes.
            hostname: Some("\"".repeat(crate::protocol::MAX_ECHOED_TEXT_BYTES)),
            lease_type: LeaseType::Dynamic,
        };

        let one_path = dir.path().join("one.json");
        let many_path = dir.path().join("many.json");
        save_leases(&one_path, std::slice::from_ref(&worst)).unwrap();
        save_leases(&many_path, &vec![worst; 257]).unwrap();
        let one = fs::metadata(&one_path).unwrap().len();
        let many = fs::metadata(&many_path).unwrap().len();

        // The file is a fixed envelope plus a constant cost per record, and
        // every record here is identical, so the difference over 256 of them is
        // the per-record cost exactly rather than an estimate.
        let per_record = (many - one) / 256;
        let envelope = one - per_record;
        let largest = envelope + per_record * MAX_PERSISTED_LEASES;

        assert!(
            largest <= MAX_LEASE_FILE_BYTES,
            "the reader must not reject what the writer produces: {MAX_PERSISTED_LEASES} \
             leases need {largest} bytes, the limit is {MAX_LEASE_FILE_BYTES}"
        );
    }

    #[test]
    fn an_oversized_file_is_refused_without_reading_it() {
        let dir = TempDir::new("dhcp-huge");
        let path = dir.path().join("dhcp-leases.json");
        let filler = "x".repeat(1024);
        let mut content = String::with_capacity(MAX_LEASE_FILE_BYTES as usize + 4096);
        while content.len() as u64 <= MAX_LEASE_FILE_BYTES {
            content.push_str(&filler);
        }
        fs::write(&path, &content).unwrap();
        assert!(load_leases(&path).is_empty());
    }

    #[test]
    fn a_hostile_hostname_is_sanitised_on_the_way_in() {
        // The file is on disk, but it is written from data a client supplied.
        let dir = TempDir::new("dhcp-hostile");
        let path = dir.path().join("dhcp-leases.json");
        let payload = json!({
            "version": 1, "savedAt": NOW,
            "leases": [{"mac": "AA-00-00-00-00-01", "ip": "10.0.0.10", "boundAt": NOW,
                        "leaseSec": 3600, "expiresAt": NOW + 1000,
                        "hostname": "evil\u{1b}[31m", "leaseType": "dynamic"}]
        });
        fs::write(&path, serde_json::to_string(&payload).unwrap()).unwrap();
        let loaded = load_leases(&path);
        assert!(!loaded[0].hostname.as_ref().unwrap().contains('\u{1b}'));
    }

    // -- reconciliation ------------------------------------------------------

    #[test]
    fn an_expired_lease_is_not_a_claim_on_its_address() {
        let map = statics(&[]);
        let result = reconcile(&[lease("aa:00:00:00:00:01", "10.0.0.10", NOW - 1)], &context(&map));
        assert!(result.restored.is_empty());
        assert_eq!(result.dropped[0].reason, DropReason::Expired);
    }

    #[test]
    fn a_lease_matching_its_reservation_keeps_its_history() {
        let map = statics(&[("aa:00:00:00:00:01", "10.0.0.12")]);
        let result =
            reconcile(&[lease("aa:00:00:00:00:01", "10.0.0.12", NOW + 1000)], &context(&map));
        assert_eq!(result.restored.len(), 1);
        assert_eq!(result.restored[0].lease_type, LeaseType::Static);
        assert_eq!(result.restored[0].bound_at, NOW);
        assert_eq!(result.restored[0].hostname.as_deref(), Some("bench"));
    }

    #[test]
    fn a_lease_that_contradicts_a_new_reservation_is_dropped() {
        // Restoring it would shadow the reservation for as long as the client
        // kept renewing.
        let map = statics(&[("aa:00:00:00:00:01", "10.0.0.12")]);
        let result =
            reconcile(&[lease("aa:00:00:00:00:01", "10.0.0.18", NOW + 1000)], &context(&map));
        assert!(result.restored.is_empty());
        assert_eq!(result.dropped[0].reason, DropReason::StaticConflict);
    }

    #[test]
    fn a_lease_on_an_address_now_reserved_for_someone_else_is_dropped() {
        let map = statics(&[("bb:00:00:00:00:09", "10.0.0.13")]);
        let result =
            reconcile(&[lease("aa:00:00:00:00:01", "10.0.0.13", NOW + 1000)], &context(&map));
        assert!(result.restored.is_empty());
        assert_eq!(result.dropped[0].reason, DropReason::StaticConflict);
    }

    #[test]
    fn a_reservation_typed_with_colons_is_still_matched_after_a_restart() {
        // Persisted leases carry wire-format keys; the configured map carries
        // whatever the operator typed. A raw comparison misses every reservation
        // written with colons and silently restores the stale dynamic lease the
        // reservation was meant to beat.
        let map = statics(&[("aa:bb:cc:dd:ee:ff", "10.0.0.12")]);
        let result =
            reconcile(&[lease("AA-BB-CC-DD-EE-FF", "10.0.0.12", NOW + 1000)], &context(&map));
        assert_eq!(result.restored.len(), 1);
        assert_eq!(result.restored[0].lease_type, LeaseType::Static);
    }

    #[test]
    fn a_lease_outside_the_current_pool_is_dropped() {
        let map = statics(&[]);
        let result =
            reconcile(&[lease("aa:00:00:00:00:01", "192.168.9.9", NOW + 1000)], &context(&map));
        assert!(result.restored.is_empty());
        assert_eq!(result.dropped[0].reason, DropReason::OutOfPool);
    }

    #[test]
    fn a_healthy_dynamic_lease_survives() {
        let map = statics(&[]);
        let result =
            reconcile(&[lease("aa:00:00:00:00:01", "10.0.0.15", NOW + 1000)], &context(&map));
        assert_eq!(result.restored.len(), 1);
        assert_eq!(result.restored[0].lease_type, LeaseType::Dynamic);
        assert!(result.dropped.is_empty());
    }
}
