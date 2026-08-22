//! End-to-end tests over a real UDP socket.
//!
//! Everything below drives the engine the way a network device does: a real
//! socket, real datagrams, real files on disk. The unit tests prove the state
//! machine in isolation; these prove that the socket loop, the sandbox and the
//! machine are wired to each other correctly, which no amount of unit testing
//! can show.

use nexus_tftp::engine::{Engine, EngineEvent, EngineOptions, TransferInfo};
use nexus_tftp::protocol::{
    encode_ack, encode_error, encode_rrq, encode_wrq, parse_packet, validated_to_raw,
};
use nexus_tftp::testsupport::TempDir;
use nexus_tftp::types::{ErrorCode, Packet, RawOptions, ValidatedOptions};
use std::net::{Ipv4Addr, SocketAddr, UdpSocket};
use std::sync::{Arc, Mutex};
use std::time::Duration;

const RECV_TIMEOUT: Duration = Duration::from_secs(5);

/// Records every event the engine emits, so a test can assert on the lifecycle
/// the host would see rather than only on the bytes.
#[derive(Clone, Default)]
struct Events(Arc<Mutex<Vec<EngineEvent>>>);

impl Events {
    fn sink(&self) -> nexus_tftp::engine::EventSink {
        let store = Arc::clone(&self.0);
        Box::new(move |event| store.lock().unwrap().push(event))
    }

    fn completed(&self) -> Vec<TransferInfo> {
        self.0
            .lock()
            .unwrap()
            .iter()
            .filter_map(|e| match e {
                EngineEvent::TransferComplete(info) => Some((**info).clone()),
                _ => None,
            })
            .collect()
    }

    fn failures(&self) -> Vec<String> {
        self.0
            .lock()
            .unwrap()
            .iter()
            .filter_map(|e| match e {
                EngineEvent::TransferError { error, .. } => Some(error.clone()),
                _ => None,
            })
            .collect()
    }

    fn started(&self) -> usize {
        self.0
            .lock()
            .unwrap()
            .iter()
            .filter(|e| matches!(e, EngineEvent::TransferStart(_)))
            .count()
    }
}

struct Harness {
    engine: Engine,
    events: Events,
    _root: TempDir,
    root: std::path::PathBuf,
}

impl Harness {
    fn start(allow_write: bool) -> Self {
        Self::start_with(allow_write, |_| {})
    }

    fn start_with(allow_write: bool, tweak: impl FnOnce(&mut EngineOptions)) -> Self {
        let temp = TempDir::new("tftp-e2e");
        let root = temp.path().to_path_buf();
        let mut options = EngineOptions::new(&root);
        options.address = Ipv4Addr::LOCALHOST.into();
        options.port = 0;
        options.allow_write = allow_write;
        // Fast enough that a retransmission test does not take a minute.
        options.gc_interval = Duration::from_millis(200);
        tweak(&mut options);
        let events = Events::default();
        let engine = Engine::start(&options, events.sink()).expect("engine starts");
        Self {
            engine,
            events,
            _root: temp,
            root,
        }
    }

    fn addr(&self) -> SocketAddr {
        SocketAddr::new(Ipv4Addr::LOCALHOST.into(), self.engine.bound_port())
    }

    fn client(&self) -> Client {
        Client::new(self.addr())
    }

    /// Waits for a condition the engine thread satisfies asynchronously.
    fn wait_until(&self, what: &str, mut predicate: impl FnMut() -> bool) {
        let deadline = std::time::Instant::now() + RECV_TIMEOUT;
        while std::time::Instant::now() < deadline {
            if predicate() {
                return;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        panic!("timed out waiting for {what}");
    }
}

struct Client {
    socket: UdpSocket,
    server: SocketAddr,
}

impl Client {
    fn new(server: SocketAddr) -> Self {
        let socket = UdpSocket::bind((Ipv4Addr::LOCALHOST, 0)).expect("client socket");
        socket.set_read_timeout(Some(RECV_TIMEOUT)).unwrap();
        Self { socket, server }
    }

    fn send(&self, bytes: &[u8]) {
        self.socket.send_to(bytes, self.server).expect("send");
    }

    fn recv(&self) -> Packet {
        self.try_recv().expect("a reply within the timeout")
    }

    fn try_recv(&self) -> Option<Packet> {
        let mut buf = vec![0u8; 65_536];
        let (len, _) = self.socket.recv_from(&mut buf).ok()?;
        parse_packet(&buf[..len]).expect("server sent a well-formed packet")
    }

    fn local_id(&self) -> String {
        self.socket.local_addr().unwrap().to_string()
    }

    /// Downloads a file, acknowledging each DATA packet as it arrives.
    fn download(&self, filename: &str, options: &RawOptions) -> Vec<u8> {
        self.send(&encode_rrq(filename, "octet", options));
        let mut received = Vec::new();
        let mut blksize = 512usize;
        if !options.is_empty() {
            match self.recv() {
                Packet::Oack { options } => {
                    if let Some(value) = options.blksize {
                        blksize = value.parse().unwrap();
                    }
                }
                other => panic!("expected OACK, got {other:?}"),
            }
            self.send(&encode_ack(0));
        }
        loop {
            match self.recv() {
                Packet::Data { block, data } => {
                    let last = data.len() < blksize;
                    received.extend_from_slice(&data);
                    self.send(&encode_ack(block));
                    if last {
                        return received;
                    }
                }
                other => panic!("expected DATA, got {other:?}"),
            }
        }
    }

    /// Uploads a file, one block at a time.
    fn upload(&self, filename: &str, payload: &[u8], options: &RawOptions) {
        self.send(&encode_wrq(filename, "octet", options));
        let mut blksize = 512usize;
        match self.recv() {
            Packet::Oack { options } => {
                if let Some(value) = options.blksize {
                    blksize = value.parse().unwrap();
                }
            }
            Packet::Ack { block } => assert_eq!(block, 0),
            other => panic!("expected OACK or ACK(0), got {other:?}"),
        }
        let mut block = 1u16;
        let mut offset = 0usize;
        loop {
            let end = (offset + blksize).min(payload.len());
            let chunk = &payload[offset..end];
            self.send(&nexus_tftp::protocol::encode_data(block, chunk));
            match self.recv() {
                Packet::Ack { block: acked } => assert_eq!(acked, block),
                other => panic!("expected ACK({block}), got {other:?}"),
            }
            if chunk.len() < blksize {
                return;
            }
            offset = end;
            block = if block == u16::MAX { 1 } else { block + 1 };
        }
    }
}

fn payload(len: usize) -> Vec<u8> {
    // Deterministic and non-repeating enough that an off-by-one block boundary
    // shows up as a content mismatch rather than as identical bytes.
    (0..len).map(|i| ((i * 31 + i / 251) % 256) as u8).collect()
}

fn options(pairs: &[(&str, &str)]) -> RawOptions {
    let mut o = RawOptions::default();
    for (k, v) in pairs {
        assert!(o.set(k, v));
    }
    o
}

// ---------------------------------------------------------------------------

#[test]
fn a_read_serves_the_whole_file_byte_for_byte() {
    let h = Harness::start(false);
    let expected = payload(1578); // 3 full blocks plus a short one
    std::fs::write(h.root.join("boot.img"), &expected).unwrap();

    let got = h.client().download("boot.img", &RawOptions::default());
    assert_eq!(got, expected);

    h.wait_until("the completion event", || h.events.completed().len() == 1);
    let info = &h.events.completed()[0];
    assert_eq!(info.bytes, expected.len() as u64);
    assert_eq!(info.total_bytes, Some(expected.len() as u64));
    assert_eq!(info.filename, "boot.img");
}

#[test]
fn an_empty_file_is_served_as_a_single_empty_block() {
    let h = Harness::start(false);
    std::fs::write(h.root.join("empty.bin"), b"").unwrap();
    assert!(h.client().download("empty.bin", &RawOptions::default()).is_empty());
    h.wait_until("completion", || h.events.completed().len() == 1);
}

#[test]
fn a_file_whose_size_is_an_exact_multiple_of_the_block_size_still_terminates() {
    // The classic TFTP off-by-one: without a trailing empty DATA packet the
    // client waits forever for a short block that never comes.
    let h = Harness::start(false);
    let expected = payload(512 * 3);
    std::fs::write(h.root.join("exact.bin"), &expected).unwrap();
    assert_eq!(h.client().download("exact.bin", &RawOptions::default()), expected);
}

#[test]
fn a_negotiated_block_and_window_carry_a_large_file() {
    let h = Harness::start(false);
    let expected = payload(300_000);
    std::fs::write(h.root.join("large.bin"), &expected).unwrap();
    let negotiated = options(&[("blksize", "1400"), ("windowsize", "8"), ("tsize", "0")]);
    assert_eq!(h.client().download("large.bin", &negotiated), expected);
}

#[test]
fn the_oack_reports_the_size_the_server_filled_in() {
    let h = Harness::start(false);
    let expected = payload(4096);
    std::fs::write(h.root.join("sized.bin"), &expected).unwrap();
    let client = h.client();
    client.send(&encode_rrq("sized.bin", "octet", &options(&[("tsize", "0")])));
    match client.recv() {
        // RFC 2349 §3: `tsize` of 0 on a read asks the server for the size.
        Packet::Oack { options } => assert_eq!(options.tsize.as_deref(), Some("4096")),
        other => panic!("expected OACK, got {other:?}"),
    }
}

#[test]
fn an_oversized_window_is_answered_with_the_value_the_server_will_actually_use() {
    // The allocation bound is only real if the client is told about it: an OACK
    // echoing the requested window would leave the two ends disagreeing about
    // how many blocks may be outstanding for the whole transfer.
    let h = Harness::start(false);
    std::fs::write(h.root.join("big.bin"), payload(100_000)).unwrap();
    let client = h.client();
    client.send(&encode_rrq(
        "big.bin",
        "octet",
        &options(&[("blksize", "512"), ("windowsize", "65535")]),
    ));
    let Packet::Oack { options } = client.recv() else {
        panic!("expected OACK");
    };
    let echoed: u32 = options.windowsize.as_deref().unwrap().parse().unwrap();
    let budget = validated_to_raw(&ValidatedOptions::default());
    assert!(budget.is_empty(), "sanity: defaults are not echoed");
    assert!(
        echoed < 65535,
        "the server echoed the requested window, so the clamp bought nothing"
    );
    assert!(
        echoed * 512 <= 1024 * 1024,
        "the negotiated window exceeds the in-flight budget"
    );
}

#[test]
fn a_write_lands_on_disk_byte_for_byte() {
    let h = Harness::start(true);
    let expected = payload(5000);
    h.client().upload("up/load.bin", &expected, &RawOptions::default());
    h.wait_until("completion", || h.events.completed().len() == 1);
    // Parent directories a PXE client assumes exist are created for it.
    assert_eq!(std::fs::read(h.root.join("up").join("load.bin")).unwrap(), expected);
}

#[test]
fn a_negotiated_write_lands_on_disk_byte_for_byte() {
    // RFC 2347 has a write client answer the OACK with DATA(1) rather than with
    // ACK(0). A server that waits for the ACK drops that DATA and every
    // retransmission of it, so this whole transfer never completes.
    let h = Harness::start(true);
    let expected = payload(20_000);
    h.client()
        .upload("neg.bin", &expected, &options(&[("blksize", "1400"), ("tsize", "20000")]));
    h.wait_until("completion", || h.events.completed().len() == 1);
    assert_eq!(std::fs::read(h.root.join("neg.bin")).unwrap(), expected);
}

#[test]
fn a_write_is_refused_when_uploads_are_disabled() {
    let h = Harness::start(false);
    let client = h.client();
    client.send(&encode_wrq("up.bin", "octet", &RawOptions::default()));
    match client.recv() {
        Packet::Error { code, .. } => assert_eq!(code, ErrorCode::AccessViolation.to_wire()),
        other => panic!("expected ERROR, got {other:?}"),
    }
    assert!(!h.root.join("up.bin").exists());
}

#[test]
fn a_write_over_an_existing_file_is_refused_and_leaves_it_untouched() {
    let h = Harness::start(true);
    std::fs::write(h.root.join("keep.bin"), b"original").unwrap();
    let client = h.client();
    client.send(&encode_wrq("keep.bin", "octet", &RawOptions::default()));
    match client.recv() {
        Packet::Error { code, .. } => assert_eq!(code, ErrorCode::FileAlreadyExists.to_wire()),
        other => panic!("expected ERROR, got {other:?}"),
    }
    assert_eq!(std::fs::read(h.root.join("keep.bin")).unwrap(), b"original");
}

#[test]
fn a_traversal_attempt_never_reaches_the_filesystem() {
    let h = Harness::start(true);
    let client = h.client();
    for attempt in ["../escape.bin", "..\\escape.bin", "/../../etc/passwd", "a/b/../../../x"] {
        client.send(&encode_rrq(attempt, "octet", &RawOptions::default()));
        match client.recv() {
            Packet::Error { code, .. } => assert_eq!(
                code,
                ErrorCode::AccessViolation.to_wire(),
                "{attempt} was not refused as an access violation"
            ),
            other => panic!("{attempt}: expected ERROR, got {other:?}"),
        }
    }
    assert_eq!(h.events.started(), 0, "no session may be created for a refused path");
}

#[test]
fn a_missing_file_is_answered_with_file_not_found() {
    let h = Harness::start(false);
    let client = h.client();
    client.send(&encode_rrq("nope.bin", "octet", &RawOptions::default()));
    match client.recv() {
        Packet::Error { code, .. } => assert_eq!(code, ErrorCode::FileNotFound.to_wire()),
        other => panic!("expected ERROR, got {other:?}"),
    }
}

#[test]
fn a_stray_acknowledgement_gets_unknown_transfer_id() {
    let h = Harness::start(false);
    let client = h.client();
    client.send(&encode_ack(1));
    match client.recv() {
        Packet::Error { code, .. } => assert_eq!(code, ErrorCode::UnknownTransferId.to_wire()),
        other => panic!("expected ERROR, got {other:?}"),
    }
}

#[test]
fn netascii_is_refused_on_the_wire() {
    let h = Harness::start(false);
    std::fs::write(h.root.join("readme.txt"), b"line\n").unwrap();
    let client = h.client();
    client.send(&encode_rrq("readme.txt", "netascii", &RawOptions::default()));
    match client.recv() {
        Packet::Error { code, message } => {
            assert_eq!(code, ErrorCode::IllegalOperation.to_wire());
            assert!(message.contains("octet"), "the client must be told what to retry with");
        }
        other => panic!("expected ERROR, got {other:?}"),
    }
}

#[test]
fn a_transfer_appears_in_the_live_snapshot_while_it_is_running() {
    let h = Harness::start(false);
    std::fs::write(h.root.join("slow.bin"), payload(200_000)).unwrap();
    let client = h.client();
    client.send(&encode_rrq("slow.bin", "octet", &RawOptions::default()));
    let Packet::Data { .. } = client.recv() else {
        panic!("expected DATA");
    };
    let live = h.engine.active_transfers();
    assert_eq!(live.len(), 1);
    assert_eq!(live[0].filename, "slow.bin");
    assert_eq!(live[0].id, client.local_id());
    assert_eq!(live[0].total_bytes, Some(200_000));
    assert!(live[0].started_at_epoch_ms > 0);
}

#[test]
fn cancelling_a_live_transfer_sends_an_error_and_drops_the_session() {
    let h = Harness::start(false);
    std::fs::write(h.root.join("slow.bin"), payload(200_000)).unwrap();
    let client = h.client();
    client.send(&encode_rrq("slow.bin", "octet", &RawOptions::default()));
    let Packet::Data { .. } = client.recv() else {
        panic!("expected DATA");
    };

    assert!(h.engine.cancel_transfer(&client.local_id()));
    // RFC 1350 §2 gives a server exactly one way to abort: an ERROR packet.
    match client.recv() {
        Packet::Error { code, message } => {
            assert_eq!(code, ErrorCode::NotDefined.to_wire());
            assert!(message.to_lowercase().contains("cancel"), "got {message}");
        }
        other => panic!("expected ERROR, got {other:?}"),
    }
    h.wait_until("the failure event", || h.events.failures().len() == 1);
    assert!(h.engine.active_transfers().is_empty());
    assert!(
        !h.engine.cancel_transfer(&client.local_id()),
        "cancelling a finished transfer is false, not an error"
    );
}

#[test]
fn a_client_error_tears_the_session_down() {
    let h = Harness::start(false);
    std::fs::write(h.root.join("slow.bin"), payload(200_000)).unwrap();
    let client = h.client();
    client.send(&encode_rrq("slow.bin", "octet", &RawOptions::default()));
    let Packet::Data { .. } = client.recv() else {
        panic!("expected DATA");
    };
    client.send(&encode_error(ErrorCode::NotDefined, Some("client gave up")));
    h.wait_until("the session to be reaped", || {
        h.engine.active_transfers().is_empty()
    });
    assert_eq!(h.events.failures().len(), 1);
}

#[test]
fn a_client_that_vanishes_is_reaped_rather_than_leaking_its_slot() {
    // A client that simply stops answering is the second way a transfer dies.
    // Reaping it silently would leave a ghost row in the UI forever, since the
    // peer is gone and no later event would ever refresh it away.
    let h = Harness::start_with(false, |options| {
        options.gc_interval = Duration::from_millis(50);
        options.max_transfers = 4;
    });
    std::fs::write(h.root.join("slow.bin"), payload(200_000)).unwrap();
    {
        let client = h.client();
        // RFC 2349's `timeout` option, negotiated down to one second purely so
        // this test finishes in seconds rather than in half a minute. It is the
        // real mechanism, not a test hook: the reap schedule is derived from the
        // session's negotiated timeout.
        client.send(&encode_rrq(
            "slow.bin",
            "octet",
            &options(&[("timeout", "1")]),
        ));
        let Packet::Oack { .. } = client.recv() else {
            panic!("expected OACK");
        };
        client.send(&encode_ack(0));
        let Packet::Data { .. } = client.recv() else {
            panic!("expected DATA");
        };
        assert_eq!(h.engine.active_transfers().len(), 1);
    } // client socket dropped; it will never acknowledge anything again

    let deadline = std::time::Instant::now() + Duration::from_secs(45);
    while std::time::Instant::now() < deadline {
        if h.engine.active_transfers().is_empty() {
            assert_eq!(h.events.failures().len(), 1, "the reap must be announced");
            return;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    panic!("an abandoned transfer was never reaped");
}

#[test]
fn a_burst_of_requests_over_the_wire_cannot_exceed_the_session_cap() {
    let h = Harness::start_with(false, |options| options.max_transfers = 3);
    std::fs::write(h.root.join("boot.bin"), payload(200_000)).unwrap();
    let clients: Vec<Client> = (0..10).map(|_| h.client()).collect();
    for client in &clients {
        client.send(&encode_rrq("boot.bin", "octet", &RawOptions::default()));
    }
    // Let every request land before sampling.
    h.wait_until("the cap to be reached", || {
        h.engine.active_transfers().len() >= 3
    });
    std::thread::sleep(Duration::from_millis(100));
    assert_eq!(
        h.engine.active_transfers().len(),
        3,
        "ten simultaneous requests must not exceed a cap of three"
    );
    let busy = clients
        .iter()
        .filter(|c| {
            matches!(
                c.try_recv(),
                Some(Packet::Error { code, .. }) if code == ErrorCode::IllegalOperation.to_wire()
            )
        })
        .count();
    assert!(busy >= 1, "the refused clients must be told, not left to time out");
}

#[test]
fn stopping_the_engine_releases_the_port() {
    let mut h = Harness::start(false);
    let addr = h.addr();
    h.engine.stop();
    assert!(
        UdpSocket::bind(addr).is_ok(),
        "the socket was still held after stop"
    );
}
