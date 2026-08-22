//! The DHCP service: lifecycle, the privileged-port fallback, and the
//! translation of engine events into the operator-facing vocabulary the host
//! renders.
//!
//! Nothing here re-implements protocol behaviour — that lives in `nexus_dhcp`.
//! What lives here is everything the *product* needs and the protocol does not:
//! what happens when port 67 is refused, and how a lease is described to a
//! human. Deliberately the same shape as `tftp_service`, so that the two
//! services cannot drift apart in how they report themselves.

use nexus_dhcp::engine::{
    Engine, EngineEvent, EventSink, PacketCounters, ReleaseReason, RuntimeSnapshot,
};
use nexus_dhcp::lease::{LeaseInfo, PoolInfo};
use serde_json::{json, Value};

use crate::config::{DhcpConfig, DHCP_DEFAULT_PORT, DHCP_FALLBACK_PORT};
use crate::events::{ConnectionEvent, ConnectionPhase, Emitter, ServerStatus, StatusHandle};

pub const SERVICE_ID: &str = "dhcp";
const SERVICE_NAME: &str = "DHCP Server";

pub struct DhcpService {
    emitter: Emitter,
    status: StatusHandle,
    config: DhcpConfig,
    engine: Option<Engine>,
}

impl DhcpService {
    #[must_use]
    pub fn new(emitter: Emitter) -> Self {
        let status = StatusHandle::new(SERVICE_ID, emitter.clone());
        Self { emitter, status, config: DhcpConfig::default(), engine: None }
    }

    /// Replaces the stored configuration.
    ///
    /// A running service keeps serving under the configuration it started with:
    /// silently rebuilding it would drop the lease table, and every device on
    /// the bench would have to re-DISCOVER. The new values take effect on the
    /// next start, because `start` reads this field rather than a cached engine.
    pub fn set_config(&mut self, config: DhcpConfig) {
        self.config = config;
    }

    #[must_use]
    pub fn status(&self) -> ServerStatus {
        self.status.status()
    }

    #[must_use]
    pub fn is_active(&self) -> bool {
        matches!(
            self.status.status(),
            ServerStatus::Running | ServerStatus::Starting
        )
    }

    /// Starts the service, falling back from the privileged port if refused.
    pub fn start(&mut self) -> Result<(), String> {
        if self.is_active() {
            return Ok(());
        }
        self.status.set(ServerStatus::Starting, None);

        // Configuration first, socket second — the same ordering the TFTP
        // service uses for its sandbox root, and for the same reason: a service
        // that binds and then serves nothing is the worst way to report a typo.
        let mut options = match self.config.resolve() {
            Ok(options) => options,
            Err(message) => return Err(self.fail(message)),
        };
        let configured = options.port;
        self.log(
            "info",
            &format!(
                "Starting on UDP {}:{configured} · pool {} → {} · gateway={} · lease={}s",
                options.address, options.range_start, options.range_end, options.gateway,
                options.lease_secs
            ),
        );

        match Engine::start(&options, self.make_sink()) {
            Ok(engine) => {
                self.engine = Some(engine);
                self.status.set(ServerStatus::Running, None);
                Ok(())
            }
            Err(error) if error.is_permission_denied() && configured == DHCP_DEFAULT_PORT => {
                // Only for exactly port 67, and only for a permission failure.
                // Silently moving a port the operator chose themselves would be
                // a worse outcome than a clear error.
                self.log(
                    "warn",
                    &format!(
                        "Port {DHCP_DEFAULT_PORT} requires elevated privileges. \
                         Retrying on port {DHCP_FALLBACK_PORT}…"
                    ),
                );
                options.port = DHCP_FALLBACK_PORT;
                match Engine::start(&options, self.make_sink()) {
                    Ok(engine) => {
                        self.engine = Some(engine);
                        self.status.set(ServerStatus::Running, None);
                        self.log(
                            "info",
                            &format!(
                                "Running on alternate UDP port {DHCP_FALLBACK_PORT}. \
                                 Clients broadcasting to {DHCP_DEFAULT_PORT} will not reach it — \
                                 re-run as Administrator to use the standard port."
                            ),
                        );
                        Ok(())
                    }
                    Err(alt) => Err(self.fail(format!(
                        "Failed to start (port {DHCP_DEFAULT_PORT} denied, \
                         fallback {DHCP_FALLBACK_PORT} failed: {alt})"
                    ))),
                }
            }
            Err(error) if error.is_address_in_use() => Err(self.fail(format!(
                "UDP port {configured} is already in use. Stop any other DHCP server first."
            ))),
            Err(error) => Err(self.fail(format!("Failed to start: {error}"))),
        }
    }

    /// Stops the service, releasing the socket and flushing the lease file.
    pub fn stop(&mut self) {
        if matches!(
            self.status.status(),
            ServerStatus::Stopped | ServerStatus::Stopping
        ) {
            // Still drop any engine that outlived a failed start.
            self.engine = None;
            return;
        }
        self.status.set(ServerStatus::Stopping, None);
        self.log("info", "Stopping…");
        if let Some(mut engine) = self.engine.take() {
            engine.stop();
        }
        self.status.set(ServerStatus::Stopped, None);
        self.log("info", "Service stopped.");
    }

    #[must_use]
    pub fn snapshot(&self) -> Value {
        let (status, error) = self.status.get();
        let mut map = serde_json::Map::new();
        map.insert("id".into(), json!(SERVICE_ID));
        map.insert("name".into(), json!(SERVICE_NAME));
        // The *configured* port, which for a running service may differ from
        // the one actually held; `boundPort` in the runtime view is the truth.
        map.insert("port".into(), json!(self.config.port()));
        map.insert("status".into(), json!(status.as_str()));
        if let Some(error) = error {
            map.insert("errorMessage".into(), json!(error));
        }
        Value::Object(map)
    }

    /// The §5.3 payload.
    ///
    /// Answering with the right shape matters even when stopped: the host
    /// renders this directly, and an error here would surface as a failure
    /// notification every time the sidebar refreshed.
    #[must_use]
    pub fn runtime(&self) -> Value {
        let runtime = self.engine.as_ref().and_then(Engine::runtime);
        let (leases, counters, pool) = match runtime {
            Some(RuntimeSnapshot { leases, counters, pool }) => (leases, counters, Some(pool)),
            None => (Vec::new(), PacketCounters::default(), None),
        };
        json!({
            "snapshot": self.snapshot(),
            "leases": leases.iter().map(lease_to_json).collect::<Vec<_>>(),
            "packetCounters": counters_to_json(&counters),
            "poolInfo": pool.as_ref().map_or_else(
                || self.stopped_pool_info(),
                pool_to_json,
            ),
            // Unlike TFTP, `null` when stopped: a service that has never bound
            // anything has no port to fall back to that would mean anything.
            // Protocol §5.2 requires the host to accept either.
            "boundPort": self.engine.as_ref().map_or(Value::Null, |e| json!(e.bound_port())),
        })
    }

    /// Pool figures from configuration alone, so a stopped service still shows
    /// the operator the range they configured rather than blanks.
    fn stopped_pool_info(&self) -> Value {
        let (start, end, statics) = self.config.resolve().map_or_else(
            |_| (Value::Null, Value::Null, 0),
            |options| {
                (
                    json!(options.range_start.to_string()),
                    json!(options.range_end.to_string()),
                    options.statics.len(),
                )
            },
        );
        let size = self
            .config
            .resolve()
            .map_or(0, |o| nexus_dhcp::net::pool_size(o.range_start, o.range_end));
        json!({
            "rangeStart": start,
            "rangeEnd": end,
            "poolSize": size,
            "activeCount": 0,
            "utilizationPct": 0.0,
            "staticEntryCount": statics,
        })
    }

    fn fail(&self, message: String) -> String {
        // Both halves matter. The status is what the sidebar renders; the
        // returned error is what makes the RPC reject, and the host turns that
        // rejection into a user-visible failure. Setting the status and
        // answering success told the user the service had started while the
        // sidebar showed an error.
        self.status.set(ServerStatus::Error, Some(message.clone()));
        self.log("error", &message);
        message
    }

    fn log(&self, level: &str, message: &str) {
        self.emitter.log(SERVICE_ID, level, message);
    }

    /// Builds the sink the engine thread pushes events through.
    ///
    /// Each arm is one line long by design: the formatting lives in the free
    /// functions below, the same split `tftp_service` uses, so that what a lease
    /// event *says* can be reviewed without re-reading the lifecycle plumbing.
    fn make_sink(&self) -> EventSink {
        let emitter = self.emitter.clone();
        let status = self.status.clone();
        Box::new(move |event| match event {
            EngineEvent::Listening { address, port } => {
                emitter.log(
                    SERVICE_ID,
                    "info",
                    &format!("Listening on UDP {address}:{port}"),
                );
            }
            EngineEvent::Log { level, message } => {
                emitter.log(SERVICE_ID, level.as_str(), &message);
            }
            EngineEvent::LeaseBound(lease) => on_lease_bound(&emitter, &lease),
            EngineEvent::LeaseRenewed(lease) => on_lease_renewed(&emitter, &lease),
            EngineEvent::LeaseReleased { mac, ip, reason } => {
                on_lease_released(&emitter, &mac, ip, reason);
            }
            EngineEvent::LeaseDeclined { mac, ip } => on_lease_declined(&emitter, &mac, ip),
            EngineEvent::Stopped { reason } => {
                // A reason means the socket loop died on its own. An orderly
                // stop carries none, and its status transition is owned by
                // `DhcpService::stop`.
                if let Some(reason) = reason {
                    status.set(ServerStatus::Error, Some(reason));
                }
            }
        })
    }
}

/// A device took an address. One log line, one connection edge, one runtime hint.
fn on_lease_bound(emitter: &Emitter, lease: &LeaseInfo) {
    let hostname = lease
        .hostname
        .as_deref()
        .map(|h| format!(", hostname={h}"))
        .unwrap_or_default();
    emitter.log(
        SERVICE_ID,
        "info",
        &format!(
            "LEASE BOUND {} \u{2192} {} ({}, {}{hostname})",
            lease.mac,
            lease.ip,
            lease.lease_type.as_str(),
            format_duration(u64::from(lease.lease_sec))
        ),
    );
    // The whole DORA exchange has completed by the time a lease binds, so this
    // is both the start of the client connection and its outcome — hence one
    // event here and none on renewal, which would otherwise repeat for the life
    // of every device on the bench.
    emitter.connection(
        SERVICE_ID,
        &ConnectionEvent {
            phase: ConnectionPhase::Started,
            summary: format!(
                "lease granted {} to {}{}",
                lease.ip,
                lease.mac,
                lease
                    .hostname
                    .as_deref()
                    .map(|h| format!(" ({h})"))
                    .unwrap_or_default()
            ),
            detail: None,
            code: None,
            id: Some(lease.mac.to_string()),
            resource: Some(lease.ip.to_string()),
            client: Some(lease.mac.to_string()),
        },
    );
    emitter.runtime_update(SERVICE_ID, false);
}

fn on_lease_renewed(emitter: &Emitter, lease: &LeaseInfo) {
    emitter.log(
        SERVICE_ID,
        "info",
        &format!(
            "LEASE RENEWED {} \u{2192} {} (remaining {} of {})",
            lease.mac,
            lease.ip,
            format_duration(lease.remaining_sec),
            format_duration(u64::from(lease.lease_sec))
        ),
    );
    emitter.runtime_update(SERVICE_ID, false);
}

fn on_lease_released(
    emitter: &Emitter,
    mac: &str,
    ip: Option<std::net::Ipv4Addr>,
    reason: ReleaseReason,
) {
    emitter.log(
        SERVICE_ID,
        "info",
        &format!(
            "LEASE {} {mac}{}",
            reason.as_str().to_uppercase(),
            ip.map(|a| format!(" (was {a})")).unwrap_or_default()
        ),
    );
    // Terminal: the lease has just left the runtime, and that disappearance
    // must not wait out a coalescing window that later pushes keep extending.
    emitter.runtime_update(SERVICE_ID, true);
}

fn on_lease_declined(emitter: &Emitter, mac: &str, ip: Option<std::net::Ipv4Addr>) {
    let address = ip.map(|a| a.to_string());
    emitter.log(
        SERVICE_ID,
        "warn",
        &format!(
            "LEASE DECLINED by {mac}{}",
            address
                .as_deref()
                .map(|a| format!(" (offered {a})"))
                .unwrap_or_default()
        ),
    );
    emitter.connection(
        SERVICE_ID,
        &ConnectionEvent {
            phase: ConnectionPhase::Failed,
            summary: format!("lease declined by {mac}"),
            detail: Some(address.as_deref().map_or_else(
                || {
                    "Client refused the offered address \u{2014} usually another host is already \
                     answering on it."
                        .to_owned()
                },
                |a| {
                    format!(
                        "Client refused {a} \u{2014} usually another host is already answering on \
                         that address. It is held out of the pool for now."
                    )
                },
            )),
            code: Some("DHCPDECLINE".to_owned()),
            id: Some(mac.to_owned()),
            resource: address,
            client: Some(mac.to_owned()),
        },
    );
    emitter.runtime_update(SERVICE_ID, true);
}

impl Drop for DhcpService {
    fn drop(&mut self) {
        if let Some(mut engine) = self.engine.take() {
            engine.stop();
        }
    }
}

/// One lease in the shape the host renders — field for field what the
/// TypeScript implementation produced, because the sidebar reads these names.
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

fn counters_to_json(counters: &PacketCounters) -> Value {
    json!({
        "packetsReceived": counters.packets_received,
        // Kept under the reference's name because the host reads it, but it is
        // no longer an estimate: these are packets this server actually sent.
        "packetsSentEstimate": counters.packets_sent,
        "discoverCount": counters.discover_count,
        "offerCount": counters.offer_count,
        "requestCount": counters.request_count,
        "declineCount": counters.decline_count,
        "ackCount": counters.ack_count,
        "nakCount": counters.nak_count,
        "releaseCount": counters.release_count,
        "informCount": counters.inform_count,
        // Not in the reference at all, and the one number that says "something
        // on this network is speaking nonsense at us".
        "malformedCount": counters.malformed_count,
    })
}

fn pool_to_json(pool: &PoolInfo) -> Value {
    json!({
        "rangeStart": pool.range_start.to_string(),
        "rangeEnd": pool.range_end.to_string(),
        "poolSize": pool.pool_size,
        "activeCount": pool.active_count,
        "utilizationPct": pool.utilization_pct,
        "staticEntryCount": pool.static_entry_count,
    })
}

fn format_duration(seconds: u64) -> String {
    match seconds {
        s if s < 60 => format!("{s}s"),
        s if s < 3600 => format!("{}m {}s", s / 60, s % 60),
        s => format!("{}h {}m {}s", s / 3600, (s % 3600) / 60, s % 60),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use nexus_dhcp::lease::LeaseType;
    use nexus_dhcp::net::MacKey;
    use nexus_rpc::MessageWriter;
    use std::io::Write;
    use std::net::Ipv4Addr;
    use std::sync::{Arc, Mutex};

    #[derive(Clone, Default)]
    struct Sink(Arc<Mutex<Vec<u8>>>);

    impl Write for Sink {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            self.0.lock().unwrap().extend_from_slice(buf);
            Ok(buf.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    fn service() -> (DhcpService, crate::throttle::ThrottleWorker) {
        let writer = Arc::new(MessageWriter::new(Box::new(Sink::default())));
        let (throttle, worker) = crate::throttle::spawn(|_| {}, crate::throttle::WINDOW);
        (DhcpService::new(Emitter::new(writer, throttle)), worker)
    }

    #[test]
    fn a_stopped_service_still_reports_the_shape_the_host_renders() {
        let (service, _worker) = service();
        let runtime = service.runtime();
        for key in ["snapshot", "leases", "packetCounters", "poolInfo", "boundPort"] {
            assert!(runtime.get(key).is_some(), "missing member {key}");
        }
        assert_eq!(runtime["leases"], json!([]));
        assert_eq!(runtime["boundPort"], Value::Null);
        assert_eq!(runtime["snapshot"]["status"], json!("stopped"));
        assert_eq!(runtime["snapshot"]["port"], json!(67));
        // The packaged pool, so the sidebar shows a range rather than blanks.
        assert_eq!(runtime["poolInfo"]["rangeStart"], json!("192.168.2.10"));
        assert_eq!(runtime["poolInfo"]["poolSize"], json!(190));
        assert_eq!(runtime["poolInfo"]["activeCount"], json!(0));
    }

    #[test]
    fn the_configured_port_is_reflected_before_anything_starts() {
        let (mut service, _worker) = service();
        service.set_config(DhcpConfig { port: Some(6700), ..DhcpConfig::default() });
        assert_eq!(service.snapshot()["port"], json!(6700));
    }

    #[test]
    fn a_lease_serialises_to_the_names_the_sidebar_reads() {
        let lease = LeaseInfo {
            mac: MacKey::parse_lossy("aa:bb:cc:dd:ee:ff"),
            ip: Ipv4Addr::new(10, 0, 0, 10),
            bound_at: 1_700_000_000_000,
            lease_sec: 3600,
            expires_at: 1_700_000_003_600,
            remaining_sec: 3000,
            hostname: Some("bench-switch".to_owned()),
            lease_type: LeaseType::Static,
        };
        let value = lease_to_json(&lease);
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
            assert!(value.get(key).is_some(), "missing member {key}");
        }
        assert_eq!(value["mac"], json!("AA-BB-CC-DD-EE-FF"));
        assert_eq!(value["ip"], json!("10.0.0.10"));
        assert_eq!(value["leaseType"], json!("static"));
    }

    #[test]
    fn a_lease_without_a_hostname_serialises_it_as_null_not_as_a_missing_member() {
        let lease = LeaseInfo {
            mac: MacKey::parse_lossy("aa:bb:cc:dd:ee:ff"),
            ip: Ipv4Addr::new(10, 0, 0, 10),
            bound_at: 0,
            lease_sec: 60,
            expires_at: 60_000,
            remaining_sec: 60,
            hostname: None,
            lease_type: LeaseType::Dynamic,
        };
        assert_eq!(lease_to_json(&lease)["hostname"], Value::Null);
    }

    #[test]
    fn a_configuration_that_cannot_serve_fails_the_start_rather_than_binding() {
        let (mut service, _worker) = service();
        service.set_config(DhcpConfig {
            range_start: Some("10.0.0.20".to_owned()),
            range_end: Some("10.0.0.10".to_owned()),
            port: Some(0),
            bind_address: Some("127.0.0.1".to_owned()),
            ..DhcpConfig::default()
        });
        let error = service.start().expect_err("an inverted pool cannot serve");
        assert!(error.contains("empty"), "got {error}");
        assert_eq!(service.status(), ServerStatus::Error);
    }

    #[test]
    fn a_real_start_stop_cycle_holds_and_releases_the_port() {
        let (mut service, _worker) = service();
        service.set_config(DhcpConfig {
            port: Some(0),
            bind_address: Some("127.0.0.1".to_owned()),
            range_start: Some("10.0.0.10".to_owned()),
            range_end: Some("10.0.0.20".to_owned()),
            ..DhcpConfig::default()
        });
        service.start().expect("an ephemeral port binds");
        assert_eq!(service.status(), ServerStatus::Running);
        let runtime = service.runtime();
        let bound = runtime["boundPort"].as_u64().expect("a running service reports its port");
        assert_ne!(bound, 0);
        assert_eq!(runtime["poolInfo"]["poolSize"], json!(11));

        service.stop();
        assert_eq!(service.status(), ServerStatus::Stopped);
        assert!(
            std::net::UdpSocket::bind(("127.0.0.1", u16::try_from(bound).unwrap())).is_ok(),
            "the port was still held after stop"
        );
    }

    #[test]
    fn starting_twice_is_idempotent() {
        let (mut service, _worker) = service();
        service.set_config(DhcpConfig {
            port: Some(0),
            bind_address: Some("127.0.0.1".to_owned()),
            ..DhcpConfig::default()
        });
        service.start().unwrap();
        service.start().expect("a second start must not fail on its own socket");
        service.stop();
        service.stop();
    }

    #[test]
    fn durations_read_as_time_not_as_a_number_of_seconds() {
        assert_eq!(format_duration(0), "0s");
        assert_eq!(format_duration(59), "59s");
        assert_eq!(format_duration(75), "1m 15s");
        assert_eq!(format_duration(86_400), "24h 0m 0s");
    }
}
