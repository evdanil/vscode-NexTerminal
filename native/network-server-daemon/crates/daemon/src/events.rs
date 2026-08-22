//! Everything the daemon pushes to the host, and the service-status bookkeeping
//! that drives it.
//!
//! Shapes are normative in `docs/network-server-daemon-protocol.md` §4–§5.

use nexus_rpc::{MessageWriter, Outgoing};
use serde_json::{json, Value};
use std::sync::{Arc, Mutex, PoisonError};

use crate::throttle::Throttle;

/// Lifecycle state of a service (protocol §5.1).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ServerStatus {
    Stopped,
    Starting,
    Running,
    Stopping,
    Error,
}

impl ServerStatus {
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Stopped => "stopped",
            Self::Starting => "starting",
            Self::Running => "running",
            Self::Stopping => "stopping",
            Self::Error => "error",
        }
    }
}

/// Where a client connection sits in its lifecycle (protocol §5.5).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConnectionPhase {
    Started,
    Completed,
    Failed,
}

impl ConnectionPhase {
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Started => "started",
            Self::Completed => "completed",
            Self::Failed => "failed",
        }
    }
}

/// One client-facing lifecycle edge.
///
/// `summary` is what a consumer *shows* and is pre-formatted here, because only
/// this layer knows the protocol's vocabulary. `id` / `resource` / `client` are
/// the same facts in a form a consumer can *store*: a transfer-history list
/// needs a filename on its own, and parsing it back out of a sentence assembled
/// for a human breaks the moment that sentence is reworded.
#[derive(Debug, Clone)]
pub struct ConnectionEvent {
    pub phase: ConnectionPhase,
    pub summary: String,
    pub detail: Option<String>,
    pub code: Option<String>,
    pub id: Option<String>,
    pub resource: Option<String>,
    pub client: Option<String>,
}

impl ConnectionEvent {
    fn to_json(&self) -> Value {
        let mut map = serde_json::Map::new();
        map.insert("phase".into(), json!(self.phase.as_str()));
        map.insert("summary".into(), json!(self.summary));
        // Optional members are omitted rather than sent as null: the host treats
        // "absent" as "this protocol does not have that fact", and a null would
        // render as an empty field instead of no field.
        for (key, value) in [
            ("detail", &self.detail),
            ("code", &self.code),
            ("id", &self.id),
            ("resource", &self.resource),
            ("client", &self.client),
        ] {
            if let Some(value) = value {
                map.insert(key.into(), json!(value));
            }
        }
        Value::Object(map)
    }
}

/// Publishes events to the host.
///
/// Cheap to clone, and every clone writes through the same lock, so an engine
/// thread and the request thread cannot interleave halves of a line.
#[derive(Clone)]
pub struct Emitter {
    writer: Arc<MessageWriter>,
    throttle: Throttle,
}

impl std::fmt::Debug for Emitter {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Emitter")
    }
}

impl Emitter {
    #[must_use]
    pub fn new(writer: Arc<MessageWriter>, throttle: Throttle) -> Self {
        Self { writer, throttle }
    }

    #[must_use]
    pub fn writer(&self) -> &Arc<MessageWriter> {
        &self.writer
    }

    /// Writes one message. Failures are dropped on purpose: if the host has gone
    /// away there is nothing to report to and nowhere to report it — the next
    /// stdin read returns EOF and the daemon shuts down.
    fn send(&self, message: &Outgoing) {
        let _ = self.writer.write(message);
    }

    pub fn respond(&self, message: &Outgoing) {
        self.send(message);
    }

    /// Announces readiness. Emitted exactly once, as the last step of start-up.
    pub fn ready(&self) {
        self.send(&Outgoing::event("ready", Value::Null));
    }

    pub fn status_change(&self, id: &str, status: ServerStatus, error: Option<&str>) {
        let mut data = serde_json::Map::new();
        data.insert("id".into(), json!(id));
        data.insert("status".into(), json!(status.as_str()));
        if let Some(error) = error {
            data.insert("error".into(), json!(error));
        }
        self.send(&Outgoing::event("statusChange", Value::Object(data)));
    }

    pub fn log(&self, id: &str, level: &str, message: &str) {
        self.send(&Outgoing::event(
            "log",
            json!({ "id": id, "level": level, "message": message }),
        ));
    }

    /// Records a runtime change. Coalesced; see [`crate::throttle`].
    pub fn runtime_update(&self, id: &str, terminal: bool) {
        self.throttle.push(id, terminal);
    }

    pub fn connection(&self, id: &str, event: &ConnectionEvent) {
        self.send(&Outgoing::event(
            "connection",
            json!({ "id": id, "connection": event.to_json() }),
        ));
    }
}

/// Shared lifecycle state for one service.
///
/// Shared because a service's status can change from two places: the request
/// thread, which drives `start` and `stop`, and the engine thread, which is the
/// only one that learns about a socket that failed underneath a running service.
/// Every transition goes through [`StatusHandle::set`], so the stored state and
/// the emitted `statusChange` can never disagree.
#[derive(Clone)]
pub struct StatusHandle {
    id: &'static str,
    inner: Arc<Mutex<(ServerStatus, Option<String>)>>,
    emitter: Emitter,
}

impl std::fmt::Debug for StatusHandle {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "StatusHandle({}, {:?})", self.id, self.get().0)
    }
}

impl StatusHandle {
    #[must_use]
    pub fn new(id: &'static str, emitter: Emitter) -> Self {
        Self {
            id,
            inner: Arc::new(Mutex::new((ServerStatus::Stopped, None))),
            emitter,
        }
    }

    #[must_use]
    pub fn get(&self) -> (ServerStatus, Option<String>) {
        self.inner
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone()
    }

    #[must_use]
    pub fn status(&self) -> ServerStatus {
        self.get().0
    }

    /// Records a transition and announces it.
    ///
    /// The lock is released before the write: holding it across a blocking pipe
    /// write would let a slow reader on the other end stall the engine thread.
    pub fn set(&self, status: ServerStatus, error: Option<String>) {
        let announced = error.clone();
        {
            let mut guard = self.inner.lock().unwrap_or_else(PoisonError::into_inner);
            *guard = (status, error);
        }
        self.emitter
            .status_change(self.id, status, announced.as_deref());
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::sync::Mutex as StdMutex;

    #[derive(Clone, Default)]
    struct Sink(Arc<StdMutex<Vec<u8>>>);

    impl Write for Sink {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            self.0.lock().unwrap().extend_from_slice(buf);
            Ok(buf.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    fn harness() -> (Emitter, Sink, crate::throttle::ThrottleWorker) {
        let sink = Sink::default();
        let writer = Arc::new(MessageWriter::new(Box::new(sink.clone())));
        let for_throttle = Arc::clone(&writer);
        let (throttle, worker) = crate::throttle::spawn(
            move |id| {
                let _ = for_throttle.write(&Outgoing::event(
                    "runtimeUpdate",
                    json!({ "id": id }),
                ));
            },
            crate::throttle::WINDOW,
        );
        (Emitter::new(writer, throttle), sink, worker)
    }

    fn lines(sink: &Sink) -> Vec<Value> {
        String::from_utf8(sink.0.lock().unwrap().clone())
            .unwrap()
            .lines()
            .map(|l| serde_json::from_str(l).unwrap())
            .collect()
    }

    #[test]
    fn the_ready_event_carries_an_explicit_null_data_member() {
        let (emitter, sink, _worker) = harness();
        emitter.ready();
        assert_eq!(lines(&sink)[0], json!({"event": "ready", "data": null}));
    }

    #[test]
    fn a_status_change_omits_the_error_member_unless_there_is_one() {
        let (emitter, sink, _worker) = harness();
        emitter.status_change("tftp", ServerStatus::Running, None);
        emitter.status_change("tftp", ServerStatus::Error, Some("port in use"));
        let out = lines(&sink);
        assert_eq!(
            out[0],
            json!({"event": "statusChange", "data": {"id": "tftp", "status": "running"}})
        );
        assert_eq!(out[1]["data"]["error"], json!("port in use"));
    }

    #[test]
    fn a_connection_event_omits_facts_the_protocol_does_not_have() {
        let (emitter, sink, _worker) = harness();
        emitter.connection(
            "tftp",
            &ConnectionEvent {
                phase: ConnectionPhase::Started,
                summary: "Download started".into(),
                detail: None,
                code: None,
                id: Some("127.0.0.1:9".into()),
                resource: Some("boot.img".into()),
                client: Some("127.0.0.1".into()),
            },
        );
        let connection = &lines(&sink)[0]["data"]["connection"];
        assert!(connection.get("detail").is_none());
        assert_eq!(connection["resource"], json!("boot.img"));
    }

    #[test]
    fn a_status_transition_is_recorded_as_well_as_announced() {
        let (emitter, sink, _worker) = harness();
        let handle = StatusHandle::new("tftp", emitter);
        handle.set(ServerStatus::Error, Some("boom".into()));
        assert_eq!(handle.status(), ServerStatus::Error);
        assert_eq!(handle.get().1.as_deref(), Some("boom"));
        assert_eq!(lines(&sink)[0]["data"]["status"], json!("error"));
    }
}
