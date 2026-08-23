//! The daemon's configuration store.
//!
//! The daemon cannot read the editor's settings itself — it is a bare process,
//! deliberately, so that it can run at a different privilege level than the
//! extension host. Every value therefore arrives from outside: once through the
//! spawn-time environment seed, and thereafter through the `configure` RPC and
//! the optional `config` that rides along with `start` / `restart`.
//!
//! Both routes feed this one store, so there is a single code path that applies
//! configuration regardless of how it arrived.

use nexus_dhcp::boot::{BootOptions, VendorEntry};
use nexus_dhcp::constants::{MAX_OPTION_VALUE_BYTES, MAX_STATIC_RESERVATIONS};
use nexus_dhcp::engine::EngineOptions as DhcpEngineOptions;
use nexus_dhcp::net::{broadcast_address, MacKey};
use serde::{Deserialize, Deserializer};
use serde_json::{Map, Value};
use std::collections::BTreeMap;
use std::net::{IpAddr, Ipv4Addr};
use std::path::PathBuf;

/// Environment variable carrying the spawn-time configuration seed.
pub const CONFIG_ENV_VAR: &str = "NEXUS_NETWORK_SERVERS_CONFIG";

/// IANA TFTP port. Privileged on every supported platform.
pub const TFTP_DEFAULT_PORT: u16 = 69;
/// Unprivileged fallback used when 69 is refused for lack of privilege.
pub const TFTP_FALLBACK_PORT: u16 = 1069;
/// IANA DHCP server port. Privileged on every supported platform.
pub const DHCP_DEFAULT_PORT: u16 = 67;
/// Unprivileged fallback used when 67 is refused for lack of privilege.
///
/// Worth stating plainly: unlike TFTP's fallback, this one does not produce a
/// working service on its own. A DHCP client broadcasts to port 67 and nothing
/// else, so a server on 1067 is reachable only through a relay agent configured
/// to forward there. It exists so the operator sees a running service and a log
/// line naming the real remedy, rather than a bind error with no path forward.
pub const DHCP_FALLBACK_PORT: u16 = 1067;
const IPV4_BYTES_PER_DHCP_OPTION_ENTRY: usize = 4;
const MAX_IPV4_ADDRESSES_PER_DHCP_OPTION: usize =
    MAX_OPTION_VALUE_BYTES / IPV4_BYTES_PER_DHCP_OPTION_ENTRY;
const MAX_PATH_BYTES: usize = 4_096;
const MIN_DHCP_LEASE_SECONDS: u32 = 60;
const MAX_DHCP_LEASE_SECONDS: u32 = 604_800;

/// Deserializes an optional field that, when present, may not be `null`.
///
/// `Option<T>` maps an absent field and an explicit `null` to the same `None`,
/// so `{"port": null}` deserialized cleanly and the service quietly used its
/// default — while the DTO declares an integer and the host-side ingress
/// rejects null outright. Paired with `#[serde(default)]`, which supplies
/// `None` when the key is absent, this runs only when the key *is* present, so
/// a null there fails as the type error it is.
fn present_but_not_null<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    T::deserialize(deserializer).map(Some)
}

/// TFTP settings, as the host sends them. Every field is optional.
#[derive(Debug, Clone, Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TftpConfig {
    #[serde(default, deserialize_with = "present_but_not_null")]
    pub root: Option<String>,
    #[serde(default, deserialize_with = "present_but_not_null")]
    pub port: Option<u16>,
    #[serde(default, deserialize_with = "present_but_not_null")]
    pub allow_write: Option<bool>,
    /// Which local address serves TFTP. Omitted means every interface.
    #[serde(default, deserialize_with = "present_but_not_null")]
    pub interface: Option<String>,
}

impl TftpConfig {
    #[must_use]
    pub fn port(&self) -> u16 {
        self.port.unwrap_or(TFTP_DEFAULT_PORT)
    }

    #[must_use]
    pub fn allow_write(&self) -> bool {
        self.allow_write.unwrap_or(false)
    }

    /// The sandbox root as the operator sees it — used both for the filesystem
    /// and for display, so the UI never shows a canonicalised path the operator
    /// did not type (on Windows that would carry a `\\?\` prefix).
    #[must_use]
    pub fn root_display(&self) -> String {
        match &self.root {
            Some(root) if !root.trim().is_empty() => root.clone(),
            _ => default_root().display().to_string(),
        }
    }

    #[must_use]
    pub fn root_path(&self) -> PathBuf {
        PathBuf::from(self.root_display())
    }

    fn validate_root(&self) -> Result<(), String> {
        if let Some(root) = &self.root {
            let bytes = root.len();
            if bytes > MAX_PATH_BYTES {
                return Err(format!(
                    "Root is {bytes} bytes; the maximum is {MAX_PATH_BYTES}."
                ));
            }
        }
        Ok(())
    }

    /// Parses the configured interface into an address to bind.
    ///
    /// Returning an error rather than falling back to "all interfaces" is
    /// deliberate: a typo in this setting would otherwise expose the service on
    /// every interface of a multi-homed machine, which is the opposite of what
    /// the operator asked for and is invisible until someone notices.
    pub fn bind_address(&self) -> Result<IpAddr, String> {
        match &self.interface {
            None => Ok(IpAddr::V4(Ipv4Addr::UNSPECIFIED)),
            Some(raw) if raw.trim().is_empty() => Ok(IpAddr::V4(Ipv4Addr::UNSPECIFIED)),
            Some(raw) => raw.trim().parse::<IpAddr>().map_err(|_| {
                format!(
                    "'{raw}' is not a valid IP address for the TFTP interface setting. \
                     Leave it empty to serve on all interfaces."
                )
            }),
        }
    }
}

/// The default sandbox root, `<home>/Nexus/tftp-root`, created if missing.
///
/// Only the *default* root is created. A root the operator configured
/// explicitly is never created on their behalf: a typo there should be an error
/// they can see, not a new empty directory in an unexpected place that quietly
/// serves nothing.
#[must_use]
pub fn default_root() -> PathBuf {
    let home = home_dir();
    let candidate = home.join("Nexus").join("tftp-root");
    if candidate.is_dir() {
        return candidate;
    }
    if std::fs::create_dir_all(&candidate).is_ok() {
        return candidate;
    }
    std::env::temp_dir()
}

fn home_dir() -> PathBuf {
    let key = if cfg!(windows) { "USERPROFILE" } else { "HOME" };
    std::env::var_os(key)
        .map(PathBuf::from)
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or_else(std::env::temp_dir)
}

/// One option 43 sub-option, as the host sends it.
///
/// `sub_option` is an `i64` and not a `u8` so that an out-of-range code reaches
/// the encoder and is refused *by name* ("0 is PAD, 255 is END"), rather than
/// failing here as an opaque deserialisation error against a field the operator
/// would then have to guess at.
#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VendorOptionConfig {
    pub sub_option: i64,
    pub value: String,
}

/// DHCP settings, as the host sends them. Every field is optional.
///
/// Note `bindAddress` rather than TFTP's `interface`: the two services have
/// always spelled this differently on the host side, and renaming one of them
/// here would silently drop the operator's setting.
#[derive(Debug, Clone, Default, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DhcpConfig {
    #[serde(default, deserialize_with = "present_but_not_null")]
    pub port: Option<u16>,
    #[serde(default, deserialize_with = "present_but_not_null")]
    pub range_start: Option<String>,
    #[serde(default, deserialize_with = "present_but_not_null")]
    pub range_end: Option<String>,
    #[serde(default, deserialize_with = "present_but_not_null")]
    pub subnet: Option<String>,
    #[serde(default, deserialize_with = "present_but_not_null")]
    pub gateway: Option<String>,
    #[serde(default, deserialize_with = "present_but_not_null")]
    pub dns: Option<Vec<String>>,
    #[serde(default, deserialize_with = "present_but_not_null")]
    pub lease_time_sec: Option<u32>,
    #[serde(default, deserialize_with = "present_but_not_null")]
    pub server_id: Option<String>,
    #[serde(default, deserialize_with = "present_but_not_null")]
    pub broadcast: Option<String>,
    /// MAC → IP reservations, keyed as the operator typed them.
    #[serde(default, rename = "static", deserialize_with = "present_but_not_null")]
    pub statics: Option<BTreeMap<String, String>>,
    /// Which local address serves DHCP. Omitted means every interface.
    #[serde(default, deserialize_with = "present_but_not_null")]
    pub bind_address: Option<String>,
    /// Where the lease table is mirrored. Omitted keeps leases in memory only.
    #[serde(default, deserialize_with = "present_but_not_null")]
    pub lease_store_path: Option<String>,
    #[serde(default, deserialize_with = "present_but_not_null")]
    pub boot_file_name: Option<String>,
    #[serde(default, deserialize_with = "present_but_not_null")]
    pub next_server: Option<String>,
    #[serde(default, deserialize_with = "present_but_not_null")]
    pub tftp_server_addresses: Option<Vec<String>>,
    #[serde(default, deserialize_with = "present_but_not_null")]
    pub vendor_class_id: Option<String>,
    #[serde(default, deserialize_with = "present_but_not_null")]
    pub vendor_specific_options: Option<Vec<VendorOptionConfig>>,
    /// Serve requests that name a relay agent in `giaddr`. Off by default: the
    /// field is unauthenticated, so honouring it on a service with no relayed
    /// segments turns any LAN peer into a reflector.
    #[serde(default, deserialize_with = "present_but_not_null")]
    pub allow_relay_agents: Option<bool>,
}

impl DhcpConfig {
    #[must_use]
    pub fn port(&self) -> u16 {
        self.port.unwrap_or(DHCP_DEFAULT_PORT)
    }

    /// Turns the payload into engine options, or explains why it cannot.
    ///
    /// Every fallible conversion happens here, once, at configuration time —
    /// the same reasoning as `TftpConfig::bind_address`. A malformed address
    /// that instead fell back to a default would be reported by the sidebar as
    /// the configuration in force while the service served something else, and
    /// nothing anywhere would say so.
    pub fn resolve(&self) -> Result<DhcpEngineOptions, String> {
        let mut options = DhcpEngineOptions {
            port: self.port(),
            ..DhcpEngineOptions::default()
        };
        options.address = match &self.bind_address {
            None => IpAddr::V4(Ipv4Addr::UNSPECIFIED),
            Some(raw) if raw.trim().is_empty() => IpAddr::V4(Ipv4Addr::UNSPECIFIED),
            Some(raw) => IpAddr::V4(raw.trim().parse::<Ipv4Addr>().map_err(|_| {
                format!(
                    "'{raw}' is not a valid IPv4 address for the DHCP interface setting. \
                     Leave it empty to serve on all interfaces."
                )
            })?),
        };
        if let Some(value) = parse_optional_ipv4(self.range_start.as_deref(), "Pool Start")? {
            options.range_start = value;
        }
        if let Some(value) = parse_optional_ipv4(self.range_end.as_deref(), "Pool End")? {
            options.range_end = value;
        }
        if let Some(value) = parse_optional_ipv4(self.subnet.as_deref(), "Subnet Mask")? {
            if !nexus_dhcp::net::is_contiguous_mask(value) {
                return Err(format!(
                    "Subnet Mask ('{value}') is not a netmask — its set bits must be contiguous."
                ));
            }
            options.subnet = value;
        }
        if let Some(value) = parse_optional_ipv4(self.gateway.as_deref(), "Gateway")? {
            options.gateway = value;
        }
        if let Some(value) = parse_optional_ipv4(self.server_id.as_deref(), "Server Identifier")? {
            options.server_id = value;
        }
        // Derived from gateway and subnet unless the operator set it, so that
        // moving the pool to another subnet does not keep advertising the
        // packaged broadcast address for the old one.
        options.broadcast = match parse_optional_ipv4(self.broadcast.as_deref(), "Broadcast")? {
            Some(value) => value,
            None => broadcast_address(options.gateway, options.subnet),
        };
        if let Some(list) = &self.dns {
            options.dns = parse_ipv4_list(list, "DNS server")?;
        }
        if let Some(seconds) = self.lease_time_sec {
            if !(MIN_DHCP_LEASE_SECONDS..=MAX_DHCP_LEASE_SECONDS).contains(&seconds) {
                return Err(format!(
                    "Lease time must be between {MIN_DHCP_LEASE_SECONDS} and \
                     {MAX_DHCP_LEASE_SECONDS} seconds."
                ));
            }
            options.lease_secs = seconds;
        }
        if let Some(map) = &self.statics {
            options.statics = parse_static_reservations(map)?;
        }
        let lease_store_path = self
            .lease_store_path
            .as_ref()
            .map(|p| p.trim().to_owned())
            .filter(|p| !p.is_empty());
        // Bounded for the same reason the TFTP root is, and against the same
        // limit the host-side parser applies. An unusable path is not inert
        // here: DHCP keeps ACKing leases while every write fails, so the
        // acknowledged leases are absent after a restart and their addresses go
        // out again to different clients. Refusing the configuration is the last
        // point at which that is visible to whoever set it.
        if let Some(path) = &lease_store_path {
            let bytes = path.len();
            if bytes > MAX_PATH_BYTES {
                return Err(format!(
                    "Lease store path is {bytes} bytes; the maximum is {MAX_PATH_BYTES}."
                ));
            }
        }
        options.lease_store_path = lease_store_path.map(PathBuf::from);
        options.allow_relay_agents = self.allow_relay_agents.unwrap_or(false);

        let tftp_servers = match &self.tftp_server_addresses {
            Some(list) => parse_ipv4_list(list, "TFTP server address")?,
            None => Vec::new(),
        };
        let vendor_entries: Vec<VendorEntry> = self
            .vendor_specific_options
            .as_ref()
            .map(|entries| {
                entries
                    .iter()
                    .map(|e| VendorEntry { sub_option: e.sub_option, value: e.value.clone() })
                    .collect()
            })
            .unwrap_or_default();
        options.boot = BootOptions::new(
            self.next_server.clone(),
            self.boot_file_name.clone(),
            tftp_servers,
            self.vendor_class_id.clone(),
            &vendor_entries,
        )
        .map_err(|e| format!("invalid DHCP boot options: {e}"))?;

        // The pool is checked here as well as in the engine, so a bad edit is
        // reported against the edit that introduced it rather than at the next
        // start.
        options.validate()?;
        Ok(options)
    }
}

fn parse_optional_ipv4(raw: Option<&str>, label: &str) -> Result<Option<Ipv4Addr>, String> {
    match raw {
        None => Ok(None),
        Some(text) if text.trim().is_empty() => Ok(None),
        Some(text) => text
            .trim()
            .parse::<Ipv4Addr>()
            .map(Some)
            .map_err(|_| format!("{label} ('{text}') is not a valid IPv4 address.")),
    }
}

fn parse_ipv4_list(values: &[String], label: &str) -> Result<Vec<Ipv4Addr>, String> {
    let parsed = values
        .iter()
        .filter(|text| !text.trim().is_empty())
        .map(|text| {
            text.trim()
                .parse::<Ipv4Addr>()
                .map_err(|_| format!("{label} ('{text}') is not a valid IPv4 address."))
        })
        .collect::<Result<Vec<_>, _>>()?;
    if parsed.len() > MAX_IPV4_ADDRESSES_PER_DHCP_OPTION {
        let count = parsed.len();
        return Err(format!(
            "{label} list has {count} address(es); DHCP options can carry at most \
             {MAX_IPV4_ADDRESSES_PER_DHCP_OPTION}."
        ));
    }
    Ok(parsed)
}

fn parse_static_reservations(
    map: &BTreeMap<String, String>,
) -> Result<BTreeMap<MacKey, Ipv4Addr>, String> {
    if map.len() > MAX_STATIC_RESERVATIONS as usize {
        return Err(format!(
            "Static reservations has {} entries; the maximum is {MAX_STATIC_RESERVATIONS}.",
            map.len()
        ));
    }
    let mut statics = BTreeMap::new();
    let mut address_owners: BTreeMap<Ipv4Addr, MacKey> = BTreeMap::new();
    for (mac, address) in map {
        let parsed = address.trim().parse::<Ipv4Addr>().map_err(|_| {
            format!("Static reservation for '{mac}' is not a valid IPv4 address: '{address}'.")
        })?;
        let parsed_mac = MacKey::parse(mac).ok_or_else(|| {
            format!(
                "Static reservation MAC address '{mac}' is not a canonicalizable six-octet address."
            )
        })?;
        if statics.contains_key(&parsed_mac) {
            return Err(format!(
                "Static reservation for '{mac}' duplicates a reservation this MAC already has."
            ));
        }
        if let Some(owner) = address_owners.insert(parsed, parsed_mac.clone()) {
            return Err(format!(
                "Static reservation address '{parsed}' is already reserved by {owner}."
            ));
        }
        // Canonicalised here, once. The reference implementation kept the
        // operator's spelling and looked it up by the wire spelling, so a
        // reservation typed with colons was never matched.
        statics.insert(parsed_mac, parsed);
    }
    Ok(statics)
}

/// The stored configuration for both services.
#[derive(Debug, Default)]
pub struct ConfigStore {
    tftp_raw: Option<Value>,
    tftp: TftpConfig,
    dhcp_raw: Option<Value>,
    dhcp: DhcpConfig,
}

/// Why a `configure` payload was refused.
#[derive(Debug)]
pub struct ConfigError(pub String);

impl ConfigStore {
    #[must_use]
    pub fn tftp(&self) -> &TftpConfig {
        &self.tftp
    }

    #[must_use]
    pub fn dhcp(&self) -> &DhcpConfig {
        &self.dhcp
    }

    #[must_use]
    pub fn dhcp_port(&self) -> u16 {
        self.dhcp.port()
    }

    /// Merges a `{tftp?, dhcp?}` payload, returning the ids that actually
    /// changed.
    ///
    /// Absent keys are left alone: a `start` carrying only TFTP configuration
    /// must not clobber the stored DHCP settings.
    pub fn apply(&mut self, configs: &Map<String, Value>) -> Result<Vec<String>, ConfigError> {
        for key in configs.keys() {
            if key != "tftp" && key != "dhcp" {
                return Err(ConfigError(format!("unknown service configuration: {key}")));
            }
        }
        let tftp_update = if let Some(incoming) = configs.get("tftp") {
            if self.tftp_raw.as_ref() == Some(incoming) {
                None
            } else {
                let parsed: TftpConfig = serde_json::from_value(incoming.clone())
                    .map_err(|e| ConfigError(format!("invalid tftp configuration: {e}")))?;
                // Validated here rather than at start, so a bad interface is
                // reported against the edit that introduced it.
                parsed.bind_address().map_err(ConfigError)?;
                parsed.validate_root().map_err(ConfigError)?;
                Some((parsed, incoming.clone()))
            }
        } else {
            None
        };
        let dhcp_update = if let Some(incoming) = configs.get("dhcp") {
            if self.dhcp_raw.as_ref() == Some(incoming) {
                None
            } else {
                let parsed: DhcpConfig = serde_json::from_value(incoming.clone())
                    .map_err(|e| ConfigError(format!("invalid dhcp configuration: {e}")))?;
                // Validated here rather than at start, so a bad pool or a
                // mistyped reservation is reported against the edit that
                // introduced it — and so a rejected value is never stored.
                parsed.resolve().map_err(ConfigError)?;
                Some((parsed, incoming.clone()))
            }
        } else {
            None
        };

        let mut changed = Vec::new();
        if let Some((parsed, raw)) = tftp_update {
            self.tftp = parsed;
            self.tftp_raw = Some(raw);
            changed.push("tftp".to_owned());
        }
        if let Some((parsed, raw)) = dhcp_update {
            self.dhcp = parsed;
            self.dhcp_raw = Some(raw);
            changed.push("dhcp".to_owned());
        }
        Ok(changed)
    }

    /// Applies a single service's configuration, as sent inline with `start`.
    pub fn apply_one(&mut self, id: &str, config: &Value) -> Result<Vec<String>, ConfigError> {
        let mut map = Map::new();
        map.insert(id.to_owned(), config.clone());
        self.apply(&map)
    }

    /// Applies the spawn-time environment seed, if the host provided one.
    ///
    /// A malformed or absent seed is not fatal: the daemon starts on defaults
    /// and waits for `configure`. Returns a message to log when the seed had to
    /// be ignored.
    pub fn apply_env_seed(&mut self) -> Option<String> {
        let raw = std::env::var(CONFIG_ENV_VAR).ok()?;
        if raw.trim().is_empty() {
            return None;
        }
        let parsed: Value = match serde_json::from_str(&raw) {
            Ok(value) => value,
            Err(e) => return Some(format!("Ignored malformed {CONFIG_ENV_VAR}: {e}")),
        };
        let Some(map) = parsed.as_object() else {
            return Some(format!("Ignored {CONFIG_ENV_VAR}: not a JSON object"));
        };
        match self.apply(map) {
            Ok(_) => None,
            Err(ConfigError(message)) => {
                Some(format!("Ignored {CONFIG_ENV_VAR}: {message}"))
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn configs(value: &Value) -> Map<String, Value> {
        value.as_object().unwrap().clone()
    }

    #[test]
    fn an_absent_key_leaves_the_other_service_alone() {
        let mut store = ConfigStore::default();
        store
            .apply(&configs(&json!({"dhcp": {"port": 6700}})))
            .unwrap();
        assert_eq!(store.dhcp_port(), 6700);
        store
            .apply(&configs(&json!({"tftp": {"port": 6900}})))
            .unwrap();
        assert_eq!(store.dhcp_port(), 6700, "a tftp-only apply must not clobber dhcp");
        assert_eq!(store.tftp().port(), 6900);
    }

    #[test]
    fn a_combined_apply_is_atomic_when_one_service_config_is_invalid() {
        let mut store = ConfigStore::default();
        let err = store
            .apply(&configs(&json!({
                "tftp": {"port": 6900},
                "dhcp": {"dns": ["not-an-ip"]}
            })))
            .unwrap_err();
        assert!(err.0.contains("DNS server"), "got {}", err.0);
        assert_eq!(
            store.tftp().port(),
            TFTP_DEFAULT_PORT,
            "a rejected combined payload must not partially store the valid tftp half"
        );
        assert!(store.tftp_raw.is_none(), "raw tftp config must remain unchanged");
    }

    #[test]
    fn re_sending_the_same_values_reports_no_change() {
        let mut store = ConfigStore::default();
        let payload = configs(&json!({"tftp": {"port": 6900, "allowWrite": true}}));
        assert_eq!(store.apply(&payload).unwrap(), vec!["tftp".to_owned()]);
        assert!(store.apply(&payload).unwrap().is_empty());
    }

    #[test]
    fn defaults_apply_to_absent_fields() {
        let store = ConfigStore::default();
        assert_eq!(store.tftp().port(), TFTP_DEFAULT_PORT);
        assert!(!store.tftp().allow_write());
        assert_eq!(store.dhcp_port(), DHCP_DEFAULT_PORT);
        assert_eq!(
            store.tftp().bind_address().unwrap(),
            IpAddr::V4(Ipv4Addr::UNSPECIFIED)
        );
    }

    #[test]
    fn a_bad_interface_is_refused_at_configure_time() {
        // Falling back to "all interfaces" would expose the service on every
        // NIC of a multi-homed machine — the opposite of what was configured,
        // and invisible until someone notices.
        let mut store = ConfigStore::default();
        let err = store
            .apply(&configs(&json!({"tftp": {"interface": "not-an-address"}})))
            .unwrap_err();
        assert!(err.0.contains("not a valid IP address"), "got {}", err.0);
        assert_eq!(
            store.tftp().bind_address().unwrap(),
            IpAddr::V4(Ipv4Addr::UNSPECIFIED),
            "the rejected value must not have been stored"
        );
    }

    #[test]
    fn a_valid_interface_is_bound_verbatim() {
        let mut store = ConfigStore::default();
        store
            .apply(&configs(&json!({"tftp": {"interface": "192.168.2.1"}})))
            .unwrap();
        assert_eq!(
            store.tftp().bind_address().unwrap().to_string(),
            "192.168.2.1"
        );
    }

    #[test]
    fn an_explicit_null_is_refused_rather_than_read_as_absent() {
        // serde maps both an absent field and an explicit `null` to `None`, so
        // {"port": null} deserialized cleanly, `configure` reported success, and
        // the service quietly ran on the default port — while the DTO declares
        // an integer and the host-side ingress rejects null outright. A setting
        // that is silently ignored is worse than one that is refused.
        for (service, payload) in [
            ("tftp", json!({"tftp": {"port": null}})),
            ("tftp", json!({"tftp": {"root": null}})),
            ("dhcp", json!({"dhcp": {"leaseTimeSec": null}})),
            ("dhcp", json!({"dhcp": {"dns": null}})),
            ("dhcp", json!({"dhcp": {"static": null}})),
        ] {
            let mut store = ConfigStore::default();
            let Err(err) = store.apply(&configs(&payload)) else {
                panic!("{payload} must be refused");
            };
            assert!(
                err.0.contains(service),
                "the error should name the section it came from: {}",
                err.0
            );
        }
    }

    #[test]
    fn oversized_tftp_roots_are_refused_before_startup() {
        let mut store = ConfigStore::default();
        let err = store
            .apply(&configs(&json!({"tftp": {"root": "x".repeat(4097)}})))
            .unwrap_err();
        assert!(err.0.contains("Root"), "got {}", err.0);
        assert!(err.0.contains("4096") || err.0.contains("4,096"), "got {}", err.0);
        assert!(
            store.tftp().root.is_none(),
            "the rejected TFTP root must not be stored for a later runtime snapshot"
        );
        assert!(store.tftp_raw.is_none(), "raw tftp config must remain unchanged");
    }

    #[test]
    fn an_oversized_lease_store_path_is_refused_before_startup() {
        // The TFTP root is bounded here; the lease store was not. A path the
        // platform cannot use is accepted and reported as configured, DHCP goes
        // on ACKing leases, and every persistence attempt fails — so the leases
        // are gone after a restart and their addresses can be handed to somebody
        // else. Rejecting the configuration is the only point at which that is
        // still visible to whoever set it.
        let mut store = ConfigStore::default();
        let err = store
            .apply(&configs(&json!({"dhcp": {"leaseStorePath": "x".repeat(4097)}})))
            .unwrap_err();
        assert!(err.0.contains("Lease store path"), "got {}", err.0);
        assert!(err.0.contains("4096") || err.0.contains("4,096"), "got {}", err.0);
        assert!(
            store.dhcp().lease_store_path.is_none(),
            "the rejected path must not be stored for a later start"
        );
        assert!(store.dhcp_raw.is_none(), "raw dhcp config must remain unchanged");
    }

    #[test]
    fn a_port_outside_the_wire_range_is_refused() {
        let mut store = ConfigStore::default();
        assert!(store
            .apply(&configs(&json!({"tftp": {"port": 70000}})))
            .is_err());
    }

    #[test]
    fn dhcp_configuration_round_trips_unchanged() {
        // The raw payload is kept verbatim as well as parsed, so idempotence is
        // decided against the exact accepted DTO rather than a normalized copy.
        let mut store = ConfigStore::default();
        let payload = json!({"dhcp": {"port": 67, "rangeStart": "192.168.2.10"}});
        store.apply(&configs(&payload)).unwrap();
        assert_eq!(store.dhcp_raw.as_ref().unwrap(), &payload["dhcp"]);
        assert_eq!(store.dhcp().range_start.as_deref(), Some("192.168.2.10"));
    }

    #[test]
    fn a_dhcp_pool_that_could_never_serve_is_refused_at_configure_time() {
        // Reported against the edit that introduced it, not at the next start —
        // and the rejected value is not stored, so the service keeps a
        // configuration it could actually run.
        let mut store = ConfigStore::default();
        let err = store
            .apply(&configs(
                &json!({"dhcp": {"rangeStart": "10.0.0.20", "rangeEnd": "10.0.0.10"}}),
            ))
            .unwrap_err();
        assert!(err.0.contains("empty"), "got {}", err.0);
        assert!(store.dhcp().range_start.is_none(), "the rejected value must not be stored");
    }

    #[test]
    fn an_oversized_dhcp_pool_is_refused_at_configure_time() {
        let mut store = ConfigStore::default();
        let err = store
            .apply(&configs(
                &json!({"dhcp": {"rangeStart": "10.0.0.1", "rangeEnd": "10.1.0.1"}}),
            ))
            .unwrap_err();
        assert!(err.0.contains("65,536"), "got {}", err.0);
        assert!(store.dhcp().range_start.is_none(), "the rejected value must not be stored");
    }

    #[test]
    fn every_malformed_dhcp_address_is_refused_by_name() {
        // Falling back to a default would paint the bad value into the sidebar
        // as the configuration in force while the service served something else.
        let cases = [
            (json!({"bindAddress": "not-an-address"}), "DHCP interface"),
            (json!({"rangeStart": "192.168.2."}), "Pool Start"),
            (json!({"rangeEnd": "999.1.1.1"}), "Pool End"),
            (json!({"gateway": "gateway"}), "Gateway"),
            (json!({"serverId": ""}), ""),
            (json!({"subnet": "255.0.255.0"}), "contiguous"),
            (json!({"dns": ["8.8.8.8", "nope"]}), "DNS server"),
            (json!({"tftpServerAddresses": ["nope"]}), "TFTP server address"),
            (json!({"bindAddress": "::1"}), "DHCP interface"),
        ];
        for (payload, expected) in cases {
            let mut store = ConfigStore::default();
            let result = store.apply(&configs(&json!({"dhcp": payload})));
            if expected.is_empty() {
                // An empty string means "unset", not "malformed".
                assert!(result.is_ok(), "{payload} should have been accepted as unset");
                continue;
            }
            let err = result.unwrap_err();
            assert!(
                err.0.contains(expected),
                "{payload} should have named {expected}; got {}",
                err.0
            );
        }
    }

    #[test]
    fn oversized_dhcp_address_lists_are_refused_before_startup() {
        let dns: Vec<String> = (1..=64).map(|i| format!("10.0.0.{i}")).collect();
        let mut store = ConfigStore::default();
        let err = store
            .apply(&configs(&json!({"dhcp": {"dns": dns}})))
            .unwrap_err();
        assert!(err.0.contains("DNS server"), "got {}", err.0);
        assert!(err.0.contains("at most 63"), "got {}", err.0);
        assert!(
            store.dhcp().dns.is_none(),
            "the rejected DNS list must not be stored for a later start"
        );
    }

    #[test]
    fn oversized_boot_option_strings_are_refused_before_startup() {
        let too_long = "x".repeat(MAX_OPTION_VALUE_BYTES + 1);
        for (payload, label) in [
            (json!({"bootFileName": too_long.clone()}), "Boot File Name"),
            (json!({"nextServer": too_long.clone()}), "Next Server"),
        ] {
            let mut store = ConfigStore::default();
            let err = store
                .apply(&configs(&json!({"dhcp": payload})))
                .unwrap_err();
            assert!(err.0.contains(label), "got {}", err.0);
            assert!(err.0.contains("255"), "got {}", err.0);
            assert!(
                store.dhcp().boot_file_name.is_none() && store.dhcp().next_server.is_none(),
                "the rejected boot option must not be stored for a later start"
            );
        }
    }

    #[test]
    fn unsupported_dhcp_lease_intervals_are_refused_before_startup() {
        for seconds in [1, 7, 59, 604_801] {
            let mut store = ConfigStore::default();
            let err = store
                .apply(&configs(&json!({"dhcp": {"leaseTimeSec": seconds}})))
                .unwrap_err();
            assert!(err.0.contains("Lease time"), "got {}", err.0);
            assert!(store.dhcp().lease_time_sec.is_none(), "the rejected lease time must not be stored");
        }
    }

    #[test]
    fn a_dhcp_payload_of_the_wrong_shape_is_refused_rather_than_defaulted() {
        // Distinct from a semantically bad value: these fail to deserialise at
        // all. Falling back to defaults here would silently discard everything
        // the operator wrote in that section, and report success for it.
        for payload in [
            json!({"port": "sixty-seven"}),
            json!({"leaseTimeSec": "forever"}),
            json!({"dns": "8.8.8.8"}),
            json!({"static": ["aa:bb:cc:dd:ee:ff"]}),
            json!({"vendorSpecificOptions": [{"subOption": "one", "value": "x"}]}),
            json!({"rangeStart": 42}),
        ] {
            let mut store = ConfigStore::default();
            let err = store
                .apply(&configs(&json!({"dhcp": payload})))
                .unwrap_err();
            assert!(
                err.0.contains("invalid dhcp configuration"),
                "{payload} should have been refused; got {}",
                err.0
            );
            assert_eq!(
                store.dhcp(),
                &DhcpConfig::default(),
                "{payload} must not have been stored"
            );
        }
    }

    #[test]
    fn a_reservation_is_canonicalised_to_the_spelling_the_wire_uses() {
        // The reference implementation stored the operator spelling and looked
        // it up by the wire spelling, so a reservation typed with colons was
        // silently never honoured outside the dynamic pool.
        let mut store = ConfigStore::default();
        store
            .apply(&configs(&json!({"dhcp": {
                "static": {"aa:bb:cc:dd:ee:ff": "192.168.2.5"}
            }})))
            .unwrap();
        let resolved = store.dhcp().resolve().unwrap();
        let wire = MacKey::from_hardware(&[0xAA, 0xBB, 0xCC, 0xDD, 0xEE, 0xFF]);
        assert_eq!(
            resolved.statics.get(&wire),
            Some(&Ipv4Addr::new(192, 168, 2, 5))
        );
    }

    #[test]
    fn a_malformed_reservation_address_is_refused_rather_than_skipped() {
        let mut store = ConfigStore::default();
        let err = store
            .apply(&configs(&json!({"dhcp": {
                "static": {"aa:bb:cc:dd:ee:ff": "192.168.2"}
            }})))
            .unwrap_err();
        assert!(err.0.contains("Static reservation"), "got {}", err.0);
    }

    #[test]
    fn malformed_static_reservation_mac_keys_are_refused() {
        let mut store = ConfigStore::default();
        let err = store
            .apply(&configs(&json!({"dhcp": {
                "static": {"not-a-mac": "172.28.1.50"}
            }})))
            .unwrap_err();
        assert!(err.0.contains("MAC"), "got {}", err.0);
        assert!(store.dhcp().statics.is_none(), "the rejected reservations must not be stored");
    }

    #[test]
    fn oversized_static_reservation_maps_are_refused() {
        let mut reservations = Map::new();
        for i in 0..=1024u16 {
            reservations.insert(
                format!("02:00:00:00:{:02x}:{:02x}", i / 256, i % 256),
                json!(format!("10.{}.{}.1", i / 256, i % 256)),
            );
        }
        let mut store = ConfigStore::default();
        let err = store
            .apply(&configs(&json!({"dhcp": {"static": reservations}})))
            .unwrap_err();
        assert!(err.0.contains("1,024") || err.0.contains("1024"), "got {}", err.0);
        assert!(store.dhcp().statics.is_none(), "the rejected reservations must not be stored");
    }

    #[test]
    fn duplicate_static_reservation_addresses_are_refused() {
        let mut store = ConfigStore::default();
        let err = store
            .apply(&configs(&json!({"dhcp": {
                "static": {
                    "aa:bb:cc:dd:ee:01": "172.28.1.50",
                    "aa:bb:cc:dd:ee:02": "172.28.1.50"
                }
            }})))
            .unwrap_err();
        assert!(err.0.contains("already reserved"), "got {}", err.0);
        assert!(store.dhcp().statics.is_none(), "the rejected reservations must not be stored");
    }

    #[test]
    fn duplicate_static_reservation_mac_aliases_are_refused() {
        let mut store = ConfigStore::default();
        let err = store
            .apply(&configs(&json!({"dhcp": {
                "static": {
                    "aa:bb:cc:dd:ee:ff": "172.28.1.50",
                    "aabb.ccdd.eeff": "172.28.1.51"
                }
            }})))
            .unwrap_err();
        assert!(err.0.contains("already has"), "got {}", err.0);
        assert!(store.dhcp().statics.is_none(), "the rejected reservations must not be stored");
    }

    #[test]
    fn the_broadcast_address_follows_the_configured_subnet() {
        // Hardcoding the packaged default here is the bug this replaces: an
        // operator who moved the pool kept advertising 192.168.2.255.
        let mut store = ConfigStore::default();
        store
            .apply(&configs(&json!({"dhcp": {
                "rangeStart": "10.4.0.10", "rangeEnd": "10.4.0.20",
                "gateway": "10.4.0.1", "subnet": "255.255.0.0"
            }})))
            .unwrap();
        assert_eq!(
            store.dhcp().resolve().unwrap().broadcast,
            Ipv4Addr::new(10, 4, 255, 255)
        );
    }

    #[test]
    fn an_explicit_broadcast_wins_over_the_derived_one() {
        let mut store = ConfigStore::default();
        store
            .apply(&configs(&json!({"dhcp": {"broadcast": "10.9.9.9"}})))
            .unwrap();
        assert_eq!(
            store.dhcp().resolve().unwrap().broadcast,
            Ipv4Addr::new(10, 9, 9, 9)
        );
    }

    #[test]
    fn a_bad_option_43_sub_option_is_refused_where_it_is_written() {
        for code in [0, 255, 256, -1] {
            let mut store = ConfigStore::default();
            let err = store
                .apply(&configs(&json!({"dhcp": {
                    "vendorSpecificOptions": [{"subOption": code, "value": "x"}]
                }})))
                .unwrap_err();
            assert!(
                err.0.contains("sub-option code"),
                "sub-option {code} should have been named; got {}",
                err.0
            );
        }
    }

    #[test]
    fn boot_options_survive_the_trip_into_engine_options() {
        let mut store = ConfigStore::default();
        store
            .apply(&configs(&json!({"dhcp": {
                "nextServer": "10.0.0.1",
                "bootFileName": "ios-image.bin",
                "tftpServerAddresses": ["10.0.0.1", "10.0.0.2"],
                "vendorClassId": "Cisco",
                "vendorSpecificOptions": [{"subOption": 1, "value": "0xC0A80201"}]
            }})))
            .unwrap();
        let boot = store.dhcp().resolve().unwrap().boot;
        assert_eq!(boot.next_server.as_deref(), Some("10.0.0.1"));
        assert_eq!(boot.boot_file_name.as_deref(), Some("ios-image.bin"));
        assert_eq!(boot.tftp_server_addresses.len(), 2);
        assert_eq!(boot.vendor_class_id.as_deref(), Some("Cisco"));
        assert_eq!(boot.vendor_specific_bytes(), &[0x01, 0x04, 0xc0, 0xa8, 0x02, 0x01]);
    }

    #[test]
    fn an_absent_lease_store_path_keeps_leases_in_memory() {
        let store = ConfigStore::default();
        assert!(store.dhcp().resolve().unwrap().lease_store_path.is_none());
    }

    #[test]
    fn a_blank_lease_store_path_is_treated_as_absent_not_as_the_current_directory() {
        let mut store = ConfigStore::default();
        store
            .apply(&configs(&json!({"dhcp": {"leaseStorePath": "   "}})))
            .unwrap();
        assert!(store.dhcp().resolve().unwrap().lease_store_path.is_none());
    }

    #[test]
    fn an_unknown_field_is_refused_to_match_the_closed_host_contract() {
        // The extension host uses exact DTO validation and treats unknown
        // daemon output as a protocol failure. Rust must keep the same closed
        // contract on input instead of accepting a shape TypeScript rejects.
        let mut store = ConfigStore::default();
        let err = store
            .apply(&configs(&json!({"tftp": {"port": 6900, "somethingNew": true}})))
            .unwrap_err();
        assert!(
            err.0.contains("unknown field"),
            "unknown field should be refused by serde; got {}",
            err.0
        );
        assert_eq!(store.tftp().port(), TFTP_DEFAULT_PORT);
    }
}
