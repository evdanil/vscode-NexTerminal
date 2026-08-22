//! End-to-end tests against the real daemon binary, driven exactly the way the
//! extension host drives it: spawn the process, speak newline-delimited JSON
//! over its stdio, and serve a real file over a real UDP socket.
//!
//! These are the only tests that exercise the actual entry point — process
//! start-up, the environment seed, the ready handshake, and the stdin-EOF
//! shutdown. Everything else in the workspace is tested in-process.

use nexus_tftp::protocol::{encode_ack, encode_rrq, encode_wrq, parse_packet};
use nexus_tftp::testsupport::TempDir;
use nexus_tftp::types::{Packet, RawOptions};
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Write};
use std::net::{Ipv4Addr, SocketAddr, UdpSocket};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError};
use std::time::Duration;

const TIMEOUT: Duration = Duration::from_secs(10);

/// A spawned daemon, with its stdout drained on a background thread so a read
/// here can never deadlock against a write the daemon is blocked on.
struct Daemon {
    child: Child,
    stdin: Option<ChildStdin>,
    lines: Receiver<Value>,
    seen: Vec<Value>,
    next_id: i64,
}

impl Daemon {
    fn spawn(seed: Option<Value>) -> Self {
        Self::spawn_raw(seed.map(|v| v.to_string()).as_deref())
    }

    fn spawn_raw(seed: Option<&str>) -> Self {
        let mut command = Command::new(env!("CARGO_BIN_EXE_nexus-network-server-daemon"));
        command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        if let Some(seed) = seed {
            command.env("NEXUS_NETWORK_SERVERS_CONFIG", seed);
        } else {
            command.env_remove("NEXUS_NETWORK_SERVERS_CONFIG");
        }
        let mut child = command.spawn().expect("daemon binary starts");
        let stdin = child.stdin.take().expect("piped stdin");
        let stdout = child.stdout.take().expect("piped stdout");
        let (tx, rx) = mpsc::channel();
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                let Ok(line) = line else { break };
                if line.trim().is_empty() {
                    continue;
                }
                let value: Value = serde_json::from_str(&line)
                    .unwrap_or_else(|e| panic!("daemon wrote a non-JSON line {line:?}: {e}"));
                if tx.send(value).is_err() {
                    break;
                }
            }
        });
        Self {
            child,
            stdin: Some(stdin),
            lines: rx,
            seen: Vec::new(),
            next_id: 1,
        }
    }

    fn next(&mut self) -> Value {
        match self.lines.recv_timeout(TIMEOUT) {
            Ok(value) => {
                self.seen.push(value.clone());
                value
            }
            Err(RecvTimeoutError::Timeout) => panic!("daemon went quiet; saw {:#?}", self.seen),
            Err(RecvTimeoutError::Disconnected) => {
                panic!("daemon closed stdout; saw {:#?}", self.seen)
            }
        }
    }

    fn await_ready(&mut self) {
        loop {
            let message = self.next();
            if message["event"] == json!("ready") {
                assert!(
                    message.as_object().unwrap().contains_key("data"),
                    "`ready` must carry an explicit data member or the host drops it"
                );
                return;
            }
        }
    }

    /// Sends a request and returns its response, collecting the events that
    /// arrive in the meantime.
    fn call(&mut self, method: &str, params: Value) -> Value {
        let id = self.next_id;
        self.next_id += 1;
        let line = json!({ "id": id, "method": method, "params": params }).to_string();
        let stdin = self.stdin.as_mut().expect("stdin still open");
        writeln!(stdin, "{line}").expect("write request");
        stdin.flush().expect("flush request");
        loop {
            let message = self.next();
            if message["id"] == json!(id) {
                return message;
            }
        }
    }

    fn write_raw(&mut self, line: &str) {
        let stdin = self.stdin.as_mut().expect("stdin still open");
        stdin.write_all(line.as_bytes()).expect("write raw");
        stdin.flush().expect("flush raw");
    }

    /// Waits for an event matching `predicate`, from what has already been seen
    /// or from what arrives next.
    fn await_event(&mut self, what: &str, predicate: impl Fn(&Value) -> bool) -> Value {
        if let Some(found) = self.seen.iter().find(|v| predicate(v)).cloned() {
            return found;
        }
        let deadline = std::time::Instant::now() + TIMEOUT;
        while std::time::Instant::now() < deadline {
            let message = self.next();
            if predicate(&message) {
                return message;
            }
        }
        panic!("never saw {what}; saw {:#?}", self.seen)
    }

    /// Closes stdin and waits for the exit that must follow.
    fn shutdown(&mut self) -> i32 {
        self.stdin.take(); // dropping the handle is the EOF
        let deadline = std::time::Instant::now() + TIMEOUT;
        while std::time::Instant::now() < deadline {
            if let Some(status) = self.child.try_wait().expect("try_wait") {
                return status.code().unwrap_or(-1);
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        let _ = self.child.kill();
        panic!("daemon did not exit after stdin EOF");
    }
}

impl Drop for Daemon {
    fn drop(&mut self) {
        self.stdin.take();
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn tftp_config(root: &TempDir) -> Value {
    json!({
        "root": root.path().to_string_lossy(),
        "port": 0,
        "interface": "127.0.0.1",
        "allowWrite": true
    })
}

fn bound_port(runtime: &Value) -> u16 {
    u16::try_from(runtime["result"]["boundPort"].as_u64().expect("boundPort")).unwrap()
}

fn client_for(port: u16) -> (UdpSocket, SocketAddr) {
    let socket = UdpSocket::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
    socket.set_read_timeout(Some(TIMEOUT)).unwrap();
    (socket, SocketAddr::new(Ipv4Addr::LOCALHOST.into(), port))
}

fn recv_packet(socket: &UdpSocket) -> Packet {
    let mut buf = vec![0u8; 65_536];
    let (len, _) = socket.recv_from(&mut buf).expect("a reply");
    parse_packet(&buf[..len]).expect("well-formed").expect("known opcode")
}

// ---------------------------------------------------------------------------

#[test]
fn the_daemon_announces_ready_and_lists_both_services() {
    let mut daemon = Daemon::spawn(None);
    daemon.await_ready();
    let services = daemon.call("list", json!({}));
    let list = services["result"].as_array().expect("an array of snapshots");
    let ids: Vec<&str> = list.iter().map(|s| s["id"].as_str().unwrap()).collect();
    assert_eq!(ids, vec!["tftp", "dhcp"]);
    assert_eq!(list[0]["port"], json!(69), "the IANA default when unconfigured");
    assert_eq!(daemon.shutdown(), 0);
}

#[test]
fn the_environment_seed_is_applied_before_ready_is_announced() {
    // The host may fire `list` the instant it sees `ready`. If the seed were
    // applied afterwards, that first snapshot would show the default port for a
    // service the operator had moved — a wrong port rendered in the UI before
    // anything has started.
    let root = TempDir::new("daemon-seed");
    let mut daemon = Daemon::spawn(Some(json!({ "tftp": tftp_config(&root) })));
    daemon.await_ready();
    let services = daemon.call("list", json!({}));
    assert_eq!(services["result"][0]["port"], json!(0));
    let runtime = daemon.call("getServiceRuntime", json!({"id": "tftp"}));
    assert_eq!(runtime["result"]["allowWrite"], json!(true));
    assert_eq!(
        runtime["result"]["root"],
        json!(root.path().to_string_lossy()),
        "the configured path is echoed, not a canonicalised one"
    );
    assert_eq!(daemon.shutdown(), 0);
}

#[test]
fn a_seed_the_daemon_cannot_use_leaves_it_on_defaults_rather_than_killing_it() {
    // A daemon that dies on a bad environment variable is a daemon the host
    // cannot start at all, with the failure showing only as a spawn timeout.
    for seed in [
        "{not json",
        "\"not-an-object\"",
        "{\"tftp\": {\"interface\": \"nope\"}}",
        "",
    ] {
        let mut daemon = Daemon::spawn_raw(Some(seed));
        daemon.await_ready();
        let services = daemon.call("list", json!({}));
        assert_eq!(
            services["result"][0]["port"],
            json!(69),
            "seed {seed:?} should have been ignored, leaving defaults in place"
        );
        assert_eq!(daemon.shutdown(), 0, "seed {seed:?} must not be fatal");
    }
}

#[test]
fn a_real_file_is_served_over_a_real_socket_end_to_end() {
    let root = TempDir::new("daemon-rrq");
    let payload: Vec<u8> = (0..30_000u32).map(|i| (i % 251) as u8).collect();
    std::fs::write(root.path().join("boot.img"), &payload).unwrap();

    let mut daemon = Daemon::spawn(Some(json!({ "tftp": tftp_config(&root) })));
    daemon.await_ready();
    assert_eq!(daemon.call("start", json!({"id": "tftp"}))["result"]["ok"], json!(true));

    let runtime = daemon.call("getServiceRuntime", json!({"id": "tftp"}));
    assert_eq!(runtime["result"]["snapshot"]["status"], json!("running"));
    let (socket, server) = client_for(bound_port(&runtime));

    let mut options = RawOptions::default();
    assert!(options.set("blksize", "1400"));
    assert!(options.set("windowsize", "4"));
    socket
        .send_to(&encode_rrq("boot.img", "octet", &options), server)
        .unwrap();
    let Packet::Oack { .. } = recv_packet(&socket) else {
        panic!("expected OACK");
    };
    socket.send_to(&encode_ack(0), server).unwrap();

    let mut received = Vec::new();
    loop {
        match recv_packet(&socket) {
            Packet::Data { block, data } => {
                let last = data.len() < 1400;
                received.extend_from_slice(&data);
                socket.send_to(&encode_ack(block), server).unwrap();
                if last {
                    break;
                }
            }
            other => panic!("expected DATA, got {other:?}"),
        }
    }
    assert_eq!(received, payload, "the served bytes must match the file exactly");

    // The lifecycle edges the host surfaces to the user, one per transfer.
    let completed = daemon.await_event("a completed connection event", |m| {
        m["event"] == json!("connection") && m["data"]["connection"]["phase"] == json!("completed")
    });
    assert_eq!(completed["data"]["id"], json!("tftp"));
    assert_eq!(
        completed["data"]["connection"]["resource"],
        json!("boot.img"),
        "a history row needs the filename on its own, not parsed out of a sentence"
    );

    assert_eq!(daemon.call("stop", json!({"id": "tftp"}))["result"]["ok"], json!(true));
    assert_eq!(daemon.shutdown(), 0);
}

#[test]
fn a_real_upload_lands_on_disk_and_a_traversal_does_not() {
    let root = TempDir::new("daemon-wrq");
    let mut daemon = Daemon::spawn(Some(json!({ "tftp": tftp_config(&root) })));
    daemon.await_ready();
    daemon.call("start", json!({"id": "tftp"}));
    let runtime = daemon.call("getServiceRuntime", json!({"id": "tftp"}));
    let (socket, server) = client_for(bound_port(&runtime));

    // A path that escapes the sandbox is refused before anything is created.
    socket
        .send_to(
            &encode_wrq("../escaped.bin", "octet", &RawOptions::default()),
            server,
        )
        .unwrap();
    match recv_packet(&socket) {
        Packet::Error { code, .. } => assert_eq!(code, 2, "expected AccessViolation"),
        other => panic!("expected ERROR, got {other:?}"),
    }
    assert!(!root.path().parent().unwrap().join("escaped.bin").exists());

    // A legitimate upload into a directory that does not exist yet.
    let payload: Vec<u8> = (0..1200u32).map(|i| (i % 97) as u8).collect();
    socket
        .send_to(
            &encode_wrq("pxe/cfg/boot.cfg", "octet", &RawOptions::default()),
            server,
        )
        .unwrap();
    match recv_packet(&socket) {
        Packet::Ack { block } => assert_eq!(block, 0),
        other => panic!("expected ACK(0), got {other:?}"),
    }
    for (block, chunk) in (1u16..).zip(payload.chunks(512)) {
        socket
            .send_to(&nexus_tftp::protocol::encode_data(block, chunk), server)
            .unwrap();
        match recv_packet(&socket) {
            Packet::Ack { block: acked } => assert_eq!(acked, block),
            other => panic!("expected ACK, got {other:?}"),
        }
    }
    // 1200 bytes is 2 full blocks plus 176, so the last chunk already ended it.
    assert_eq!(
        std::fs::read(root.path().join("pxe").join("cfg").join("boot.cfg")).unwrap(),
        payload
    );
    assert_eq!(daemon.shutdown(), 0);
}

#[test]
fn a_start_that_cannot_bind_is_answered_with_an_error_not_with_success() {
    let root = TempDir::new("daemon-inuse");
    let holder = UdpSocket::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
    let taken = holder.local_addr().unwrap().port();

    let mut daemon = Daemon::spawn(None);
    daemon.await_ready();
    let response = daemon.call(
        "start",
        json!({"id": "tftp", "config": {
            "root": root.path().to_string_lossy(),
            "port": taken,
            "interface": "127.0.0.1"
        }}),
    );
    assert_eq!(response["error"]["code"], json!("INTERNAL_ERROR"));
    assert!(
        response["error"]["message"].as_str().unwrap().contains("already in use"),
        "got {}",
        response["error"]["message"]
    );
    // And the status the sidebar renders agrees with the answer the caller got.
    let status = daemon.call("getStatus", json!({"id": "tftp"}));
    assert_eq!(status["result"]["status"], json!("error"));
    assert_eq!(daemon.shutdown(), 0);
}

#[test]
fn dhcp_is_listed_and_starts_over_the_real_stdio_bridge() {
    let mut daemon = Daemon::spawn(None);
    daemon.await_ready();

    // Stopped, but already answering with the shape the host renders.
    let idle = daemon.call("getServiceRuntime", json!({"id": "dhcp"}));
    assert_eq!(idle["result"]["leases"], json!([]));
    assert_eq!(idle["result"]["boundPort"], Value::Null);

    let started = daemon.call(
        "start",
        json!({"id": "dhcp", "config": {
            "port": 0, "bindAddress": "127.0.0.1",
            "rangeStart": "10.0.0.10", "rangeEnd": "10.0.0.20",
            "gateway": "10.0.0.1", "serverId": "10.0.0.1", "broadcast": "127.0.0.1"
        }}),
    );
    assert_eq!(started["result"]["ok"], json!(true));

    let runtime = daemon.call("getServiceRuntime", json!({"id": "dhcp"}));
    assert_eq!(runtime["result"]["snapshot"]["status"], json!("running"));
    assert_ne!(runtime["result"]["boundPort"], Value::Null);
    assert_eq!(runtime["result"]["poolInfo"]["poolSize"], json!(11));

    assert_eq!(daemon.call("stop", json!({"id": "dhcp"}))["result"]["ok"], json!(true));
    assert_eq!(daemon.shutdown(), 0);
}

#[test]
fn garbage_on_stdin_is_survived_rather_than_fatal() {
    let mut daemon = Daemon::spawn(None);
    daemon.await_ready();

    daemon.write_raw("this is not json\n");
    daemon.write_raw("\n");
    daemon.write_raw("{\"method\":\"list\"}\n"); // no id: unanswerable by design
    daemon.write_raw("{\"id\":\"seven\",\"method\":\"list\"}\n");
    daemon.write_raw("[1,2,3]\n");

    // Still serving.
    let response = daemon.call("list", json!({}));
    assert!(response["result"].is_array());
    assert_eq!(daemon.shutdown(), 0);
}

#[test]
fn an_oversized_line_is_discarded_without_killing_the_daemon() {
    // Without a bounded reader this is an out-of-memory abort of a process that
    // may be holding privileged UDP sockets.
    let mut daemon = Daemon::spawn(None);
    daemon.await_ready();
    let huge = "x".repeat(9 * 1024 * 1024);
    daemon.write_raw(&format!("{huge}\n"));
    let warning = daemon.await_event("the oversized-line warning", |m| {
        m["event"] == json!("log")
            && m["data"]["message"]
                .as_str()
                .is_some_and(|s| s.contains("oversized"))
    });
    assert_eq!(warning["data"]["level"], json!("warn"));
    let response = daemon.call("list", json!({}));
    assert!(response["result"].is_array(), "framing must survive");
    assert_eq!(daemon.shutdown(), 0);
}

#[test]
fn closing_stdin_stops_the_service_and_exits_zero() {
    // The graceful shutdown path: EOF, stop everything, exit 0. If the socket
    // were not released the next session would fail to bind with no visible
    // cause.
    let root = TempDir::new("daemon-shutdown");
    let mut daemon = Daemon::spawn(Some(json!({ "tftp": tftp_config(&root) })));
    daemon.await_ready();
    daemon.call("start", json!({"id": "tftp"}));
    let runtime = daemon.call("getServiceRuntime", json!({"id": "tftp"}));
    let port = bound_port(&runtime);

    assert_eq!(daemon.shutdown(), 0);
    assert!(
        UdpSocket::bind((Ipv4Addr::LOCALHOST, port)).is_ok(),
        "the daemon exited while still holding UDP {port}"
    );
}

#[test]
fn a_configure_while_running_takes_effect_on_restart_and_not_before() {
    let root = TempDir::new("daemon-reconfig");
    let mut daemon = Daemon::spawn(Some(json!({ "tftp": tftp_config(&root) })));
    daemon.await_ready();
    daemon.call("start", json!({"id": "tftp"}));
    let before = daemon.call("getServiceRuntime", json!({"id": "tftp"}));
    assert_eq!(before["result"]["allowWrite"], json!(true));
    let port_before = bound_port(&before);

    let mut config = tftp_config(&root);
    config["allowWrite"] = json!(false);
    let changed = daemon.call("configure", json!({"configs": {"tftp": config}}));
    assert_eq!(changed["result"]["changed"], json!(["tftp"]));
    // The live engine keeps serving: silently rebuilding it would drop
    // in-flight transfers the operator did not ask to lose.
    assert_eq!(
        daemon.call("getServiceRuntime", json!({"id": "tftp"}))["result"]["snapshot"]["status"],
        json!("running")
    );

    daemon.call("restart", json!({"id": "tftp"}));
    let after = daemon.call("getServiceRuntime", json!({"id": "tftp"}));
    assert_eq!(after["result"]["allowWrite"], json!(false));
    assert_eq!(after["result"]["snapshot"]["status"], json!("running"));
    assert_ne!(
        bound_port(&after),
        port_before,
        "an ephemeral rebind proves the engine really was replaced"
    );
    assert_eq!(daemon.shutdown(), 0);
}
