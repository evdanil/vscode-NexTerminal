//! The TFTP service: lifecycle, the privileged-port fallback, and the
//! translation of engine events into the operator-facing vocabulary the host
//! renders.
//!
//! Nothing here re-implements protocol behaviour — that lives in `nexus_tftp`.
//! What lives here is everything the *product* needs and the protocol does not:
//! where the default root is, what happens when port 69 is refused, and how a
//! transfer is described to a human.

use nexus_tftp::engine::{Engine, EngineEvent, EngineOptions, EventSink, TransferInfo};
use nexus_tftp::Direction;
use serde_json::{json, Value};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::{Duration, Instant};

use crate::config::{TftpConfig, TFTP_DEFAULT_PORT, TFTP_FALLBACK_PORT};
use crate::events::{ConnectionEvent, ConnectionPhase, Emitter, ServerStatus, StatusHandle};

pub const SERVICE_ID: &str = "tftp";
const SERVICE_NAME: &str = "TFTP Server";

/// Minimum interval between progress log lines.
///
/// The engine emits a progress event per acknowledged window, which at a
/// stop-and-wait window is one per block. Logging each of them puts thousands of
/// JSON lines per second on the pipe during an ordinary firmware pull — the same
/// flood the `runtimeUpdate` coalescer exists to prevent, arriving through a
/// channel that has no coalescer. The reference implementation logged every one;
/// this gate is a deliberate divergence. Nothing is lost that matters: the
/// authoritative view is `getServiceRuntime`, and these lines are `debug`.
const PROGRESS_LOG_INTERVAL: Duration = Duration::from_secs(1);

/// What a *running* engine is actually serving under.
///
/// Distinct from `TftpConfig`, which is the configuration that will apply on the
/// next start. The two diverge the moment `configure` lands while the service is
/// running — and the runtime view must report this one, or the sidebar tells the
/// operator uploads are enabled while the live server is still refusing them.
struct ServingConfig {
    root: String,
    allow_write: bool,
}

pub struct TftpService {
    emitter: Emitter,
    status: StatusHandle,
    config: TftpConfig,
    engine: Option<Engine>,
    /// `Some` exactly while `engine` is `Some`.
    serving: Option<ServingConfig>,
    progress_gate: Arc<Mutex<Instant>>,
}

impl TftpService {
    #[must_use]
    pub fn new(emitter: Emitter) -> Self {
        let status = StatusHandle::new(SERVICE_ID, emitter.clone());
        Self {
            emitter,
            status,
            config: TftpConfig::default(),
            engine: None,
            serving: None,
            // Far enough in the past that the first progress line is not gated.
            progress_gate: Arc::new(Mutex::new(
                Instant::now()
                    .checked_sub(PROGRESS_LOG_INTERVAL)
                    .unwrap_or_else(Instant::now),
            )),
        }
    }

    /// Replaces the stored configuration.
    ///
    /// A running service is deliberately left serving under the configuration it
    /// started with: silently rebuilding it would drop in-flight transfers the
    /// operator did not ask to lose. The new values take effect on the next
    /// start, because `start` reads this field rather than a cached instance —
    /// which is what makes the "stale configuration survives a restart" class of
    /// bug unrepresentable here.
    pub fn set_config(&mut self, config: TftpConfig) {
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

        let address = match self.config.bind_address() {
            Ok(address) => address,
            Err(message) => return Err(self.fail(message)),
        };
        let root = self.config.root_path();
        let root_display = self.config.root_display();
        let allow_write = self.config.allow_write();
        let configured = self.config.port();
        self.log(
            "info",
            &format!(
                "Starting on UDP {address}:{configured} · root={} · allowWrite={allow_write}",
                root.display()
            ),
        );

        let mut options = EngineOptions::new(root);
        options.address = address;
        options.port = configured;
        options.allow_write = allow_write;

        match Engine::start(&options, self.make_sink()) {
            Ok(engine) => {
                self.engine = Some(engine);
                self.serving = Some(ServingConfig {
                    root: root_display,
                    allow_write,
                });
                self.status.set(ServerStatus::Running, None);
                Ok(())
            }
            Err(error) if error.is_permission_denied() && configured == TFTP_DEFAULT_PORT => {
                // Only for exactly port 69, and only for a permission failure.
                // Silently moving a port the operator chose themselves would be
                // a worse outcome than a clear error.
                self.log(
                    "warn",
                    &format!(
                        "Port {TFTP_DEFAULT_PORT} requires elevated privileges. \
                         Retrying on port {TFTP_FALLBACK_PORT}…"
                    ),
                );
                options.port = TFTP_FALLBACK_PORT;
                match Engine::start(&options, self.make_sink()) {
                    Ok(engine) => {
                        self.engine = Some(engine);
                        self.serving = Some(ServingConfig {
                            root: root_display,
                            allow_write,
                        });
                        self.status.set(ServerStatus::Running, None);
                        self.log(
                            "info",
                            &format!(
                                "Running on alternate UDP port {TFTP_FALLBACK_PORT}. \
                                 Re-run as Administrator to use port {TFTP_DEFAULT_PORT}."
                            ),
                        );
                        Ok(())
                    }
                    Err(alt) => Err(self.fail(format!(
                        "Failed to start (port {TFTP_DEFAULT_PORT} denied, \
                         fallback {TFTP_FALLBACK_PORT} failed: {alt})"
                    ))),
                }
            }
            Err(error) if error.is_address_in_use() => {
                Err(self.fail(format!("UDP port {configured} is already in use.")))
            }
            Err(error) => Err(self.fail(format!("Failed to start: {error}"))),
        }
    }

    /// Stops the service, releasing the socket and every open file.
    pub fn stop(&mut self) {
        if matches!(
            self.status.status(),
            ServerStatus::Stopped | ServerStatus::Stopping
        ) {
            // Still drop any engine that outlived a failed start.
            self.engine = None;
            self.serving = None;
            return;
        }
        self.status.set(ServerStatus::Stopping, None);
        self.log("info", "Stopping…");
        if let Some(mut engine) = self.engine.take() {
            engine.stop();
        }
        self.serving = None;
        self.status.set(ServerStatus::Stopped, None);
        self.log("info", "Service stopped.");
    }

    /// Aborts one transfer. `false` means it had already finished.
    #[must_use]
    pub fn cancel_transfer(&self, transfer_id: &str) -> bool {
        self.engine
            .as_ref()
            .is_some_and(|engine| engine.cancel_transfer(transfer_id))
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

    #[must_use]
    pub fn runtime(&self) -> Value {
        let transfers: Vec<Value> = self
            .engine
            .as_ref()
            .map(Engine::active_transfers)
            .unwrap_or_default()
            .iter()
            .map(transfer_to_json)
            .collect();
        json!({
            "snapshot": self.snapshot(),
            "transfers": transfers,
            // A running service reports what it is actually serving under, not
            // what a `configure` has queued for its next start. Reporting the
            // pending value would have the sidebar claim uploads are enabled
            // while the live socket still answers WRQ with AccessViolation.
            "root": self
                .serving
                .as_ref()
                .map_or_else(|| self.config.root_display(), |s| s.root.clone()),
            "allowWrite": self
                .serving
                .as_ref()
                .map_or_else(|| self.config.allow_write(), |s| s.allow_write),
            // Falls back to the configured port when stopped, so the UI has a
            // number to show rather than a blank.
            "boundPort": self
                .engine
                .as_ref()
                .map_or_else(|| self.config.port(), Engine::bound_port),
        })
    }

    fn fail(&self, message: String) -> String {
        // Both halves matter. The status is what the sidebar renders; the
        // returned error is what makes the RPC reject, and every layer above
        // depends on that — the host turns the rejection into a user-visible
        // failure. Setting the status and answering success (which is what this
        // replaced upstream) told the user the service had started while the
        // sidebar showed an error.
        self.status.set(ServerStatus::Error, Some(message.clone()));
        self.log("error", &message);
        message
    }

    fn log(&self, level: &str, message: &str) {
        self.emitter.log(SERVICE_ID, level, message);
    }

    /// Builds the sink the engine thread pushes events through.
    fn make_sink(&self) -> EventSink {
        let emitter = self.emitter.clone();
        let status = self.status.clone();
        let gate = Arc::clone(&self.progress_gate);
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
            EngineEvent::TransferStart(info) => on_transfer_start(&emitter, &info),
            EngineEvent::TransferProgress(info) => {
                if let Some(line) = progress_line(&info, &gate) {
                    emitter.log(SERVICE_ID, "debug", &line);
                }
                emitter.runtime_update(SERVICE_ID, false);
            }
            EngineEvent::TransferComplete(info) => on_transfer_complete(&emitter, &info),
            EngineEvent::TransferError { info, error, code } => {
                on_transfer_error(&emitter, &info, error, code);
            }
            EngineEvent::Stopped { reason } => {
                // A reason means the socket loop died on its own. An orderly
                // stop carries none, and its status transition is owned by
                // `TftpService::stop`.
                if let Some(reason) = reason {
                    status.set(ServerStatus::Error, Some(reason));
                }
            }
        })
    }
}

impl Drop for TftpService {
    fn drop(&mut self) {
        if let Some(mut engine) = self.engine.take() {
            engine.stop();
        }
    }
}

/// A transfer opened. One log line, one connection edge, one runtime hint.
fn on_transfer_start(emitter: &Emitter, info: &TransferInfo) {
    emitter.log(
        SERVICE_ID,
        "info",
        &format!(
            "{} started: {} ({}) · blksize={}, window={}",
            describe_direction(info.direction),
            info.filename,
            info.id,
            info.block_size,
            info.window_size
        ),
    );
    emitter.connection(
        SERVICE_ID,
        &ConnectionEvent {
            phase: ConnectionPhase::Started,
            summary: format!(
                "{} started from {} · {}",
                describe_direction(info.direction),
                info.peer_address,
                info.filename
            ),
            detail: None,
            code: None,
            id: Some(info.id.clone()),
            resource: Some(info.filename.clone()),
            client: Some(info.peer_address.clone()),
        },
    );
    emitter.runtime_update(SERVICE_ID, false);
}

fn on_transfer_complete(emitter: &Emitter, info: &TransferInfo) {
    let elapsed = format_duration(info.elapsed_sec);
    // The average over the whole transfer, not the instantaneous rate: a
    // transfer that finished is better described by what it achieved than by
    // whatever the last window happened to measure.
    let average = if info.elapsed_sec > 0 {
        info.bytes as f64 / info.elapsed_sec as f64
    } else {
        info.speed_bps
    };
    emitter.log(
        SERVICE_ID,
        "info",
        &format!(
            "{} {}: {} B · {} · took {elapsed}",
            past_tense(info.direction),
            info.filename,
            info.bytes,
            format_speed(average)
        ),
    );
    emitter.connection(
        SERVICE_ID,
        &ConnectionEvent {
            phase: ConnectionPhase::Completed,
            summary: format!(
                "{} finished from {} · {} ({} B in {elapsed})",
                describe_direction(info.direction),
                info.peer_address,
                info.filename,
                info.bytes
            ),
            detail: None,
            code: None,
            id: Some(info.id.clone()),
            resource: Some(info.filename.clone()),
            client: Some(info.peer_address.clone()),
        },
    );
    // Terminal: the transfer has just left the runtime, and that disappearance
    // must not wait out a coalescing window that later pushes keep extending.
    emitter.runtime_update(SERVICE_ID, true);
}

fn on_transfer_error(
    emitter: &Emitter,
    info: &TransferInfo,
    error: String,
    code: Option<String>,
) {
    // No `warn` log here: the engine already logged the failure with its own
    // detail, and duplicating it would show the operator the same fault twice.
    emitter.connection(
        SERVICE_ID,
        &ConnectionEvent {
            phase: ConnectionPhase::Failed,
            summary: format!(
                "{} failed from {} · {}",
                describe_direction(info.direction),
                info.peer_address,
                info.filename
            ),
            detail: Some(error),
            code,
            id: Some(info.id.clone()),
            resource: Some(info.filename.clone()),
            client: Some(info.peer_address.clone()),
        },
    );
    emitter.runtime_update(SERVICE_ID, true);
}

fn progress_line(info: &TransferInfo, gate: &Mutex<Instant>) -> Option<String> {
    {
        let mut last = gate.lock().unwrap_or_else(PoisonError::into_inner);
        if last.elapsed() < PROGRESS_LOG_INTERVAL {
            return None;
        }
        *last = Instant::now();
    }
    let percent = match info.total_bytes {
        Some(total) if total > 0 => {
            format!("{}%", (info.bytes as f64 / total as f64 * 100.0).round())
        }
        _ => "—".to_owned(),
    };
    let eta = info.eta_sec.map_or_else(
        || "ETA —".to_owned(),
        |eta| format!("ETA {}", format_duration(eta.ceil().max(0.0) as u64)),
    );
    let total = info
        .total_bytes
        .map_or_else(|| "?".to_owned(), |t| t.to_string());
    Some(format!(
        "{} {}: {}/{total} B {percent} · {} · {eta}",
        info.direction.as_str().to_uppercase(),
        info.filename,
        info.bytes,
        format_speed(info.speed_bps)
    ))
}

/// One transfer in the shape protocol §5.2 defines.
fn transfer_to_json(info: &TransferInfo) -> Value {
    json!({
        "id": info.id,
        "peer": { "address": info.peer_address, "port": info.peer_port },
        "direction": info.direction.as_str(),
        "filename": info.filename,
        "bytes": info.bytes,
        "totalBytes": info.total_bytes,
        "blockSize": info.block_size,
        "windowSize": info.window_size,
        // `json!` maps a non-finite float to null rather than producing invalid
        // JSON, so a degenerate rate cannot corrupt the stream.
        "speedBps": info.speed_bps,
        "etaSec": info.eta_sec,
        "startedAt": info.started_at_epoch_ms,
        // Reverse DNS is not implemented in this build; the host renders
        // `client` verbatim, so the bare address degrades cleanly.
        "clientHostname": Value::Null,
        "client": info.peer_address,
    })
}

/// Names a direction from the *client's* point of view — the one an operator
/// watching a device boot is thinking in.
fn describe_direction(direction: Direction) -> &'static str {
    match direction {
        Direction::Read => "Download",
        Direction::Write => "Upload",
    }
}

fn past_tense(direction: Direction) -> &'static str {
    match direction {
        Direction::Read => "Downloaded",
        Direction::Write => "Uploaded",
    }
}

const UNITS: [&str; 4] = ["B/s", "KB/s", "MB/s", "GB/s"];

fn format_speed(bytes_per_sec: f64) -> String {
    if !bytes_per_sec.is_finite() || bytes_per_sec <= 0.0 {
        return "0 B/s".to_owned();
    }
    let mut value = bytes_per_sec;
    let mut unit = 0usize;
    while value >= 1024.0 && unit < UNITS.len() - 1 {
        value /= 1024.0;
        unit += 1;
    }
    let precision = usize::from(value < 10.0) + 1;
    format!("{value:.precision$} {}", UNITS[unit])
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

    #[test]
    fn speed_is_scaled_to_a_readable_unit() {
        assert_eq!(format_speed(0.0), "0 B/s");
        assert_eq!(format_speed(-1.0), "0 B/s");
        assert_eq!(format_speed(f64::NAN), "0 B/s");
        assert_eq!(format_speed(512.0), "512.0 B/s");
        assert_eq!(format_speed(2048.0), "2.00 KB/s");
        assert_eq!(format_speed(5.0 * 1024.0 * 1024.0), "5.00 MB/s");
    }

    #[test]
    fn durations_read_as_time_not_as_a_number_of_seconds() {
        assert_eq!(format_duration(0), "0s");
        assert_eq!(format_duration(59), "59s");
        assert_eq!(format_duration(75), "1m 15s");
        assert_eq!(format_duration(3725), "1h 2m 5s");
    }

    #[test]
    fn a_transfer_serialises_to_the_shape_the_protocol_defines() {
        let info = TransferInfo {
            id: "192.168.2.7:52001".into(),
            peer_address: "192.168.2.7".into(),
            peer_port: 52001,
            direction: Direction::Read,
            filename: "boot.img".into(),
            bytes: 4096,
            total_bytes: Some(8192),
            block_size: 1400,
            window_size: 8,
            speed_bps: 1234.5,
            eta_sec: Some(3.0),
            started_at_epoch_ms: 1_700_000_000_000,
            elapsed_sec: 3,
        };
        let value = transfer_to_json(&info);
        assert_eq!(value["peer"]["port"], json!(52001));
        assert_eq!(value["direction"], json!("rrq"));
        assert_eq!(value["totalBytes"], json!(8192));
        assert_eq!(value["clientHostname"], Value::Null);
        assert_eq!(value["client"], json!("192.168.2.7"));
        for key in [
            "id",
            "peer",
            "direction",
            "filename",
            "bytes",
            "totalBytes",
            "blockSize",
            "windowSize",
            "speedBps",
            "etaSec",
            "startedAt",
            "clientHostname",
            "client",
        ] {
            assert!(value.get(key).is_some(), "missing member {key}");
        }
    }

    #[test]
    fn an_unknown_total_serialises_as_null_not_as_a_missing_member() {
        let info = TransferInfo {
            id: "127.0.0.1:1".into(),
            peer_address: "127.0.0.1".into(),
            peer_port: 1,
            direction: Direction::Write,
            filename: "up.bin".into(),
            bytes: 0,
            total_bytes: None,
            block_size: 512,
            window_size: 1,
            speed_bps: f64::INFINITY,
            eta_sec: None,
            started_at_epoch_ms: 0,
            elapsed_sec: 0,
        };
        let value = transfer_to_json(&info);
        assert_eq!(value["totalBytes"], Value::Null);
        assert_eq!(value["etaSec"], Value::Null);
        assert_eq!(
            value["speedBps"],
            Value::Null,
            "a non-finite rate must not become invalid JSON"
        );
    }

    #[test]
    fn progress_logging_is_rate_limited() {
        let gate = Mutex::new(
            Instant::now()
                .checked_sub(PROGRESS_LOG_INTERVAL)
                .expect("the process has been up for at least one second"),
        );
        let info = TransferInfo {
            id: "127.0.0.1:1".into(),
            peer_address: "127.0.0.1".into(),
            peer_port: 1,
            direction: Direction::Read,
            filename: "boot.img".into(),
            bytes: 1024,
            total_bytes: Some(4096),
            block_size: 512,
            window_size: 1,
            speed_bps: 1000.0,
            eta_sec: Some(3.0),
            started_at_epoch_ms: 0,
            elapsed_sec: 1,
        };
        assert!(progress_line(&info, &gate).is_some());
        // Without the gate, a stop-and-wait transfer produces one of these per
        // block — thousands of JSON lines a second on the control pipe.
        for _ in 0..1000 {
            assert!(progress_line(&info, &gate).is_none());
        }
    }
}
