//! The TFTP engine: UDP socket, session table, filesystem I/O, and the
//! periodic tick that retransmits and reaps.
//!
//! # Concurrency model, and why it is not async
//!
//! One thread owns the socket and every session. Inbound datagrams arrive
//! through a blocking `recv_from` with a read timeout; that timeout is also what
//! paces the maintenance tick and what makes control commands (stop, cancel,
//! snapshot) land promptly. Nothing is shared, so there is no lock around the
//! session table and no `Arc` anywhere in the hot path.
//!
//! An async runtime was considered and rejected. It would buy nothing here: the
//! service owns exactly one socket, the file I/O is one block at a time, and
//! there is no fan-out to thousands of connections that would make a reactor pay
//! for itself. It would cost a large dependency tree under a component whose
//! entire purpose is to be auditable, plus the cancellation-safety reasoning
//! that comes with every `await` point in a state machine.
//!
//! That choice has a security consequence worth stating plainly: because a
//! datagram is handled to completion before the next one is read, the
//! check-then-act race that the admission reservation defends against cannot
//! occur *today*. The reservation is kept anyway, and tested on its own, so the
//! invariant is enforced by the type rather than by an accident of the runtime —
//! a future move to threads or async cannot silently reintroduce the hole.

use crate::path_guard::{GuardError, PathGuard, RootError};
use crate::protocol::{encode_error, parse_packet, peek_opcode, ProtocolError};
use crate::session::{block_distance, Direction, Phase, TransferInit, TransferSession};
use crate::types::{ErrorCode, Opcode, Packet};
use std::collections::HashMap;
use std::fmt;
use std::fs::{File, OpenOptions};
use std::io::{self, Write};
use std::net::{IpAddr, Ipv4Addr, SocketAddr, UdpSocket};
use std::path::PathBuf;
use std::sync::mpsc::{self, Receiver, Sender, SyncSender, TryRecvError};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

/// Maintenance tick interval.
///
/// The reference implementation used 15 s and orphaned sessions therefore sat in
/// the table for up to `15 s × (retries + 1)` ≈ 90 s after a client vanished.
/// With a 64-session pool that is easy to exhaust, and valid clients then get
/// "Server busy" from a server doing nothing at all.
pub const DEFAULT_GC_INTERVAL: Duration = Duration::from_secs(2);

/// Concurrent session ceiling.
pub const DEFAULT_MAX_TRANSFERS: usize = 64;

/// How long a socket read blocks before the loop checks its other work. Bounds
/// the latency of a `stop` or `cancelTransfer` command.
const POLL_INTERVAL: Duration = Duration::from_millis(100);

/// Receive buffer: the largest payload a UDP datagram can carry.
const RECV_BUFFER: usize = 65_536;

/// Consecutive unexpected socket errors tolerated before the loop gives up.
///
/// Without a bound, a socket wedged in a permanently-failing state spins a core
/// at 100% forever. With one, the service dies visibly and the supervisor can
/// report it.
const MAX_CONSECUTIVE_SOCKET_ERRORS: u32 = 100;

/// Cap on operator-facing text lifted from a peer.
///
/// A client controls its own ERROR message and its own filename, and both are
/// echoed into log and connection events that cross a pipe and land in the UI.
/// Truncating here keeps one hostile datagram from turning into an unbounded
/// write to that pipe.
const MAX_ECHOED_TEXT: usize = 200;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LogLevel {
    Trace,
    Debug,
    Info,
    Warn,
    Error,
}

impl LogLevel {
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Trace => "trace",
            Self::Debug => "debug",
            Self::Info => "info",
            Self::Warn => "warn",
            Self::Error => "error",
        }
    }
}

/// A snapshot of one in-flight transfer, as published outside the engine.
#[derive(Debug, Clone, PartialEq)]
pub struct TransferInfo {
    pub id: String,
    pub peer_address: String,
    pub peer_port: u16,
    pub direction: Direction,
    /// Display-safe: control characters replaced and the length bounded when the
    /// struct is built, because every consumer of this field emits it. The
    /// unmodified name lives on the session, where the filesystem work is.
    pub filename: String,
    pub bytes: u64,
    pub total_bytes: Option<u64>,
    pub block_size: u32,
    pub window_size: u32,
    pub speed_bps: f64,
    pub eta_sec: Option<f64>,
    pub started_at_epoch_ms: u64,
    /// Wall time the transfer has been running, in whole seconds.
    pub elapsed_sec: u64,
}

/// Everything the engine tells the outside world.
#[derive(Debug, Clone)]
pub enum EngineEvent {
    Listening { address: String, port: u16 },
    Log { level: LogLevel, message: String },
    TransferStart(Box<TransferInfo>),
    TransferProgress(Box<TransferInfo>),
    TransferComplete(Box<TransferInfo>),
    TransferError {
        info: Box<TransferInfo>,
        error: String,
        /// Machine-readable classification, when one exists.
        code: Option<String>,
    },
    /// The socket loop stopped on its own, which only happens on an
    /// unrecoverable socket fault.
    Stopped { reason: Option<String> },
}

/// Sink for engine events. Called on the engine thread, so it must not block.
pub type EventSink = Box<dyn Fn(EngineEvent) + Send>;

/// Why a service could not start.
#[derive(Debug)]
pub enum StartError {
    Root(RootError),
    Bind(io::Error),
}

impl fmt::Display for StartError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Root(e) => write!(f, "{e}"),
            Self::Bind(e) => write!(f, "{e}"),
        }
    }
}

impl std::error::Error for StartError {}

impl StartError {
    /// True when the bind was refused for lack of privilege — the condition the
    /// privileged-port fallback exists for.
    #[must_use]
    pub fn is_permission_denied(&self) -> bool {
        matches!(self, Self::Bind(e) if e.kind() == io::ErrorKind::PermissionDenied)
    }

    /// True when something else already holds the port.
    #[must_use]
    pub fn is_address_in_use(&self) -> bool {
        matches!(self, Self::Bind(e) if e.kind() == io::ErrorKind::AddrInUse)
    }
}

/// Engine construction parameters.
#[derive(Debug, Clone)]
pub struct EngineOptions {
    /// Local address to bind.
    ///
    /// An [`IpAddr`], not a string, on purpose. Binding to a `(&str, u16)` runs
    /// the string through name resolution, so a typo in the operator's
    /// "interface" setting would turn service startup into a blocking DNS
    /// lookup on the request path — and a hostile value into an outbound query.
    /// Requiring a parsed address makes that unreachable and moves the failure
    /// to configuration time, where it can be explained.
    pub address: IpAddr,
    pub port: u16,
    pub root: PathBuf,
    pub allow_write: bool,
    pub gc_interval: Duration,
    pub max_transfers: usize,
}

impl EngineOptions {
    #[must_use]
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self {
            address: IpAddr::V4(Ipv4Addr::UNSPECIFIED),
            port: 69,
            root: root.into(),
            allow_write: false,
            gc_interval: DEFAULT_GC_INTERVAL,
            max_transfers: DEFAULT_MAX_TRANSFERS,
        }
    }
}

// ---------------------------------------------------------------------------
// Admission
// ---------------------------------------------------------------------------

/// The concurrent-session cap, as a reservation rather than a check.
///
/// A slot must be *reserved* at the moment the decision is made and released
/// only when the request is finished with — not merely counted from the session
/// table. Counting the table is a check-then-act: everything between the check
/// and the registration (path resolution, `stat`, directory creation, opening a
/// file) is work during which the session is not yet in the table, so a burst of
/// requests from distinct source ports can all pass the check before any of them
/// registers. The cap is then bypassed by an unauthenticated client, which is
/// the entire thing it exists to prevent.
///
/// See the module header for why that window is currently closed by the
/// threading model as well; this type is what keeps it closed if that changes.
#[derive(Debug)]
pub struct Admission {
    max: usize,
    reserved: usize,
}

impl Admission {
    #[must_use]
    pub fn new(max: usize) -> Self {
        Self { max, reserved: 0 }
    }

    /// Reserves a slot, counting both registered sessions and slots already
    /// handed out but not yet registered.
    pub fn try_reserve(&mut self, registered: usize) -> bool {
        if registered + self.reserved >= self.max {
            return false;
        }
        self.reserved += 1;
        true
    }

    /// Returns a slot.
    ///
    /// Must run on **every** path out of the request — including the many
    /// failure paths. A reservation leaked on failure is a slot the engine never
    /// gets back, so a handful of requests for files that do not exist would
    /// wedge the service at "Server busy" permanently. By the time a successful
    /// request releases, its session is counted in the table instead; the brief
    /// overlap where it is counted twice only ever rejects one extra request.
    pub fn release(&mut self) {
        self.reserved = self.reserved.saturating_sub(1);
    }

    #[must_use]
    pub fn reserved(&self) -> usize {
        self.reserved
    }
}

// ---------------------------------------------------------------------------
// Wire
// ---------------------------------------------------------------------------

/// Anything that can put a datagram on the wire.
///
/// Exists so the core can be driven by a test harness that records packets
/// instead of sending them — the alternative being to bind a real socket for
/// every unit test of the state transitions.
pub trait Datagram {
    fn send_to(&self, buf: &[u8], peer: SocketAddr) -> io::Result<usize>;
}

impl Datagram for UdpSocket {
    fn send_to(&self, buf: &[u8], peer: SocketAddr) -> io::Result<usize> {
        UdpSocket::send_to(self, buf, peer)
    }
}

/// The socket plus the event sink.
///
/// Split out of [`TftpCore`] so that a method needing the socket can borrow it
/// while another borrows the session table mutably — the alternative being to
/// clone every session out of the map to send a packet.
struct Wire<S: Datagram> {
    socket: S,
    events: EventSink,
}

impl<S: Datagram> Wire<S> {
    fn emit(&self, event: EngineEvent) {
        (self.events)(event);
    }

    fn log(&self, level: LogLevel, message: impl Into<String>) {
        self.emit(EngineEvent::Log {
            level,
            message: message.into(),
        });
    }

    /// Sends packets without registering them for retransmission. Used for
    /// one-shot answers: ERROR, and the busy/unknown-TID replies.
    ///
    /// UDP is best-effort and a send failure is logged, never propagated: a
    /// transient `send_to` error against one peer must not abort a loop serving
    /// every other peer.
    fn send_raw(&self, peer: SocketAddr, packets: &[Vec<u8>]) {
        for packet in packets {
            if let Err(e) = self.socket.send_to(packet, peer) {
                self.log(LogLevel::Error, format!("send to {peer} failed: {e}"));
            }
        }
    }

    /// Sends packets belonging to a session **and** registers them for
    /// retransmission.
    ///
    /// The order is load-bearing: register, then send. Reversed, a maintenance
    /// tick landing between the two finds an empty queue and aborts a healthy
    /// session for having nothing to retransmit.
    fn send_for_transfer(&self, session: &mut TransferSession, packets: &[Vec<u8>]) {
        if packets.is_empty() {
            return;
        }
        session.record_outbound(packets);
        self.send_raw(session.peer, packets);
    }
}

// ---------------------------------------------------------------------------
// Core
// ---------------------------------------------------------------------------

/// The tail of a finished upload, kept alive for one retry interval.
///
/// RFC 1350 §6 dallies after the last ACK so that a lost final ACK can be
/// answered again. Under RFC 7440 that ACK is cumulative over a whole window,
/// so the block a client resends after losing it is the *first* one the window
/// covered, not the last. State that keeps only `final_block` answers every
/// other block with `UnknownTransferId`, which leaves the file complete on the
/// server and the upload reported as failed on the client.
struct CompletedWrite {
    /// First and last block of the window the retained ACK stood for. The range
    /// is a single block when the transfer ended on a window boundary, and
    /// shorter than `windowsize` whenever the file ran out mid-window — which is
    /// why the negotiated size cannot stand in for it.
    window_start: u16,
    final_block: u16,
    ack: Vec<u8>,
    /// How long each answered retry buys. Retained because the deadline is
    /// restarted on every one, not set once at completion.
    dally: Duration,
    expires_at: Instant,
}

impl CompletedWrite {
    /// True when `block` is one the retained ACK already covered.
    ///
    /// Distances run backwards from `final_block`, so a block ahead of it wraps
    /// to the far end of the sequence space and lands outside the window: the
    /// comparison needs no separate case for the wrap.
    fn covers(&self, block: u16) -> bool {
        block_distance(block, self.final_block)
            <= block_distance(self.window_start, self.final_block)
    }
}

/// The protocol core: everything except the socket loop itself.
pub struct TftpCore<S: Datagram> {
    wire: Wire<S>,
    guard: PathGuard,
    allow_write: bool,
    admission: Admission,
    transfers: HashMap<SocketAddr, TransferSession>,
    write_handles: HashMap<SocketAddr, File>,
    write_paths: HashMap<SocketAddr, PathBuf>,
    completed_writes: HashMap<SocketAddr, CompletedWrite>,
}

impl<S: Datagram> TftpCore<S> {
    fn new(socket: S, events: EventSink, guard: PathGuard, options: &EngineOptions) -> Self {
        Self {
            wire: Wire { socket, events },
            guard,
            allow_write: options.allow_write,
            admission: Admission::new(options.max_transfers),
            transfers: HashMap::new(),
            write_handles: HashMap::new(),
            write_paths: HashMap::new(),
            completed_writes: HashMap::new(),
        }
    }

    /// Snapshot of every live transfer.
    pub fn active_transfers(&mut self) -> Vec<TransferInfo> {
        self.transfers.values_mut().map(info_of).collect()
    }

    #[must_use]
    pub fn transfer_count(&self) -> usize {
        self.transfers.len()
    }

    /// Aborts a transfer on operator request.
    ///
    /// RFC 1350 §2 gives a server exactly one way to tear a connection down
    /// mid-flight: send an ERROR, which the client must not acknowledge. There
    /// is no "aborted by server" code in the RFC 1350 §5 table, so code 0
    /// carries a human-readable reason instead.
    ///
    /// Returns `false` when no such transfer is live — a benign race where the
    /// operator clicked Cancel as the last block landed, not an error.
    pub fn cancel_transfer(&mut self, transfer_id: &str) -> bool {
        const REASON: &str = "Transfer cancelled by server";
        let Some(peer) = self
            .transfers
            .keys()
            .find(|p| p.to_string() == transfer_id)
            .copied()
        else {
            return false;
        };
        let Some(session) = self.transfers.get_mut(&peer) else {
            return false;
        };
        session.set_error(ErrorCode::NotDefined, REASON);
        let packet = session.error_packet();
        self.wire.send_raw(peer, &[packet]);
        self.wire.log(
            LogLevel::Info,
            format!("transfer {transfer_id} cancelled by operator"),
        );
        self.finish_error(peer, REASON.to_owned(), Some("Cancelled".to_owned()));
        true
    }

    /// Entry point for a received datagram.
    pub fn handle_message(&mut self, msg: &[u8], peer: SocketAddr) {
        let Some(raw_opcode) = peek_opcode(msg) else {
            // Not even an opcode. Answering would only teach a scanner that
            // something is listening.
            return;
        };
        if self.transfers.contains_key(&peer) {
            self.route_existing(msg, peer);
            return;
        }
        if self.reack_completed_write(msg, peer) {
            return;
        }
        match Opcode::from_wire(raw_opcode) {
            Some(Opcode::Rrq | Opcode::Wrq) => self.handle_new_request(msg, peer),
            _ => {
                self.wire.send_raw(
                    peer,
                    &[encode_error(
                        ErrorCode::UnknownTransferId,
                        Some("No active transfer"),
                    )],
                );
            }
        }
    }

    /// Runs retransmission, reaping and timeout handling for every session.
    pub fn tick(&mut self) {
        let now = Instant::now();
        self.completed_writes
            .retain(|_, completed| completed.expires_at > now);
        let peers: Vec<SocketAddr> = self.transfers.keys().copied().collect();
        for peer in peers {
            let Some(session) = self.transfers.get_mut(&peer) else {
                continue;
            };
            // A session that finished but was not reaped on the packet path must
            // still be announced. Reaping it silently leaves its row sitting in
            // the UI forever, because no further event ever refreshes it away.
            if session.phase == Phase::Done {
                self.finish_done(peer);
                continue;
            }
            if session.phase != Phase::Error && session.time_for_retransmission() {
                let Some(packets) = session.consume_retransmission() else {
                    let reason = session
                        .error()
                        .map_or_else(|| "Max retries exceeded".to_owned(), |(_, m)| m.to_owned());
                    self.wire.log(
                        LogLevel::Warn,
                        format!("transfer {peer} exhausted its retransmission budget"),
                    );
                    self.finish_error(peer, reason, Some("MaxRetries".to_owned()));
                    continue;
                };
                let attempt = session.retries;
                let max = session.max_retries;
                self.wire.log(
                    LogLevel::Debug,
                    format!(
                        "transfer {peer} retransmitting {} packet(s), attempt {attempt}/{max}",
                        packets.len()
                    ),
                );
                self.wire.send_raw(peer, &packets);
            }
            let Some(session) = self.transfers.get_mut(&peer) else {
                continue;
            };
            if session.is_timed_out() {
                let phase = session.phase;
                self.wire.log(
                    LogLevel::Warn,
                    format!("transfer {peer} timed out in phase {phase:?}"),
                );
                // A client that simply stops answering is the second way a
                // transfer dies. It goes through the same failure path as every
                // other one so that it emits an event: reaping it silently is
                // what leaves "ghost" transfers in the UI, since the peer is
                // gone and no later event will ever refresh the row away.
                self.finish_error(
                    peer,
                    "Transfer timed out with no response from the client".to_owned(),
                    Some("Timeout".to_owned()),
                );
            }
        }
    }

    /// Releases every resource the core holds. Idempotent.
    pub fn shutdown(&mut self) {
        for session in self.transfers.values_mut() {
            session.close_file();
        }
        self.transfers.clear();
        for (_, path) in self.write_paths.drain() {
            let _ = std::fs::remove_file(path);
        }
        self.write_handles.clear();
        self.completed_writes.clear();
    }

    // -- request handling ---------------------------------------------------

    fn reack_completed_write(&mut self, msg: &[u8], peer: SocketAddr) -> bool {
        let now = Instant::now();
        let Some(completed) = self.completed_writes.get_mut(&peer) else {
            return false;
        };
        if completed.expires_at <= now {
            self.completed_writes.remove(&peer);
            return false;
        }
        let Ok(Some(Packet::Data { block, .. })) = parse_packet(msg) else {
            return false;
        };
        if !completed.covers(block) {
            return false;
        }
        // Every answered retry restarts the clock. The client waits a full
        // timeout before retrying again, so a deadline fixed at completion has
        // already lapsed by the time a lost *answer* brings the client back —
        // and the record would be gone exactly when it is still needed.
        completed.expires_at = now + completed.dally;
        let ack = completed.ack.clone();
        self.wire.send_raw(peer, &[ack]);
        true
    }

    fn route_existing(&mut self, msg: &[u8], peer: SocketAddr) {
        let packet = match parse_packet(msg) {
            Ok(Some(packet)) => packet,
            Ok(None) => return,
            Err(ProtocolError(message)) => {
                self.wire.send_raw(
                    peer,
                    &[encode_error(ErrorCode::IllegalOperation, Some(&message))],
                );
                self.finish_error(peer, message, Some("ProtocolError".to_owned()));
                return;
            }
        };
        match packet {
            Packet::Ack { block } => self.on_ack(peer, block),
            Packet::Data { block, data } => self.on_data(peer, block, &data),
            Packet::Error { code, message } => {
                let text = truncate_for_log(&message);
                self.wire.log(
                    LogLevel::Warn,
                    format!("client error from {peer} [{code}] {text}"),
                );
                let reason = if text.is_empty() {
                    format!("Client error {code}")
                } else {
                    format!("Client error: {text}")
                };
                self.finish_error(peer, reason, Some("ClientError".to_owned()));
            }
            // A peer that sends a fresh request from a port that already has a
            // session, or echoes an OACK back, is confused rather than hostile.
            // Ignoring is what RFC 1350 leaves room for and costs nothing.
            _ => {}
        }
    }

    fn on_ack(&mut self, peer: SocketAddr, block: u16) {
        let Some(session) = self.transfers.get_mut(&peer) else {
            return;
        };
        let outcome = session.handle_ack(block);
        if outcome.produce_more {
            match session.produce_next_send_packets() {
                Ok(packets) if !packets.is_empty() => {
                    self.wire.send_for_transfer(session, &packets);
                    let info = info_of(session);
                    self.wire.emit(EngineEvent::TransferProgress(Box::new(info)));
                }
                Ok(_) => {}
                Err(e) => {
                    // The source file went away or became unreadable mid-flight.
                    // Answering with a mapped ERROR is the only way the client
                    // learns anything; a silent drop reads to it as a timeout.
                    let (code, message) = wire_error_for_io(&e);
                    let text = message.unwrap_or_else(|| code.default_message().to_owned());
                    self.wire
                        .send_raw(peer, &[encode_error(code, Some(&text))]);
                    self.finish_error(peer, text, Some("ReadFailed".to_owned()));
                    return;
                }
            }
        }
        let done = outcome.done
            || self
                .transfers
                .get(&peer)
                .is_some_and(|s| s.phase == Phase::Done);
        if done {
            self.finish_done(peer);
        }
    }

    fn on_data(&mut self, peer: SocketAddr, block: u16, data: &[u8]) {
        let Some(session) = self.transfers.get_mut(&peer) else {
            return;
        };
        let outcome = session.handle_data(block, data);
        if let Some(payload) = &outcome.write {
            if !self.append_write(peer, payload) {
                return; // already torn down and answered
            }
            if let Some(session) = self.transfers.get_mut(&peer) {
                let info = info_of(session);
                self.wire.emit(EngineEvent::TransferProgress(Box::new(info)));
            }
        }
        if !outcome.send.is_empty() {
            if let Some(session) = self.transfers.get_mut(&peer) {
                let packets = outcome.send.clone();
                self.wire.send_for_transfer(session, &packets);
            }
        }
        let terminal = self
            .transfers
            .get(&peer)
            .is_some_and(|s| s.phase.is_terminal());
        if terminal {
            let failure = self
                .transfers
                .get(&peer)
                .and_then(|s| s.error().map(|(_, m)| m.to_owned()));
            match failure {
                Some(message) => self.finish_error(peer, message, Some("ProtocolError".to_owned())),
                None => self.finish_done(peer),
            }
        }
    }

    fn handle_new_request(&mut self, msg: &[u8], peer: SocketAddr) {
        let request = match parse_packet(msg) {
            Ok(Some(Packet::Rrq(request))) => (Direction::Read, request),
            Ok(Some(Packet::Wrq(request))) => (Direction::Write, request),
            Ok(_) => return,
            Err(ProtocolError(message)) => {
                self.wire.send_raw(
                    peer,
                    &[encode_error(ErrorCode::IllegalOperation, Some(&message))],
                );
                return;
            }
        };

        if !self.admission.try_reserve(self.transfers.len()) {
            self.wire.send_raw(
                peer,
                &[encode_error(ErrorCode::IllegalOperation, Some("Server busy"))],
            );
            self.wire.log(
                LogLevel::Warn,
                format!(
                    "session limit reached; rejecting {}",
                    truncate_for_log(&request.1.filename)
                ),
            );
            return;
        }
        // Exactly one release, covering every path out of `admit`, which is
        // written so that it always returns normally.
        self.admit(request.0, request.1, peer);
        self.admission.release();
    }

    fn admit(&mut self, direction: Direction, request: crate::types::Request, peer: SocketAddr) {
        let mut file_size = 0u64;
        let abs_path = match direction {
            Direction::Read => match self.guard.stat_file(&request.filename) {
                Ok(stat) => {
                    file_size = stat.size;
                    stat.abs_path
                }
                Err(e) => return self.reject(peer, &request.filename, &e),
            },
            Direction::Write => {
                if !self.allow_write {
                    self.wire.send_raw(
                        peer,
                        &[encode_error(
                            ErrorCode::AccessViolation,
                            Some("Write not allowed"),
                        )],
                    );
                    return;
                }
                match self.guard.ensure_writable_new(&request.filename) {
                    Ok(path) => path,
                    Err(e) => return self.reject(peer, &request.filename, &e),
                }
            }
        };

        let mut session = TransferSession::new(TransferInit {
            peer,
            direction,
            filename: request.filename.clone(),
            abs_path: abs_path.clone(),
            raw_options: request.options,
        });
        if session.phase == Phase::Error {
            self.wire.send_raw(peer, &[session.error_packet()]);
            return;
        }

        // For a write, the file is opened before the session is registered, so
        // there is never a window in which a session exists without its
        // destination. `create_new` is O_CREAT|O_EXCL: secondary hardening
        // against the narrow race between the sandbox's `symlink_metadata`
        // check and this open. It is deliberately NOT the defence against the
        // symlink case itself — Windows' CREATE_NEW follows a reparse point
        // rather than refusing it, unlike POSIX's O_EXCL.
        if direction == Direction::Write {
            match OpenOptions::new().write(true).create_new(true).open(&abs_path) {
                Ok(file) => {
                    self.write_handles.insert(peer, file);
                    self.write_paths.insert(peer, abs_path.clone());
                }
                Err(e) => {
                    let (code, message) = wire_error_for_io(&e);
                    self.wire.send_raw(
                        peer,
                        &[encode_error(code, message.as_deref())],
                    );
                    return;
                }
            }
        }

        let initial = match direction {
            Direction::Read => session.init_for_read(file_size),
            Direction::Write => session.init_for_write(),
        };
        let verb = if direction == Direction::Read { "RRQ" } else { "WRQ" };
        self.wire.log(
            LogLevel::Info,
            format!(
                "{verb} {peer} -> {} blksize={} window={}",
                truncate_for_log(&request.filename),
                session.opts.blksize,
                session.opts.windowsize
            ),
        );
        let info = info_of(&mut session);
        self.transfers.insert(peer, session);
        self.wire.emit(EngineEvent::TransferStart(Box::new(info)));

        let Some(session) = self.transfers.get_mut(&peer) else {
            return;
        };
        self.wire.send_for_transfer(session, &initial);

        if direction == Direction::Read && session.phase == Phase::Sending {
            match session.produce_next_send_packets() {
                Ok(packets) if !packets.is_empty() => {
                    self.wire.send_for_transfer(session, &packets);
                    let info = info_of(session);
                    self.wire.emit(EngineEvent::TransferProgress(Box::new(info)));
                }
                Ok(_) => {}
                Err(e) => {
                    let (code, message) = wire_error_for_io(&e);
                    let text = message.unwrap_or_else(|| code.default_message().to_owned());
                    self.wire.send_raw(peer, &[encode_error(code, Some(&text))]);
                    self.finish_error(peer, text, Some("ReadFailed".to_owned()));
                }
            }
        }
    }

    fn reject(&mut self, peer: SocketAddr, filename: &str, error: &GuardError) {
        if matches!(error, GuardError::PathViolation(_)) {
            self.wire.log(
                LogLevel::Warn,
                format!(
                    "refused path outside the sandbox from {peer}: {}",
                    truncate_for_log(filename)
                ),
            );
        }
        let (code, message) = wire_error_for_guard(error);
        self.wire
            .send_raw(peer, &[encode_error(code, message.as_deref())]);
    }

    /// Appends a received block to the destination file.
    ///
    /// Returns `false` when the write failed, in which case the session has
    /// already been answered with an ERROR and torn down.
    fn append_write(&mut self, peer: SocketAddr, data: &[u8]) -> bool {
        let Some(handle) = self.write_handles.get_mut(&peer) else {
            // Only reachable if a DATA arrives on a read transfer, which the
            // state machine already refuses.
            return true;
        };
        match handle.write_all(data) {
            Ok(()) => true,
            Err(e) => {
                let (code, message) = wire_error_for_io(&e);
                let text = message.unwrap_or_else(|| code.default_message().to_owned());
                self.wire.log(
                    LogLevel::Warn,
                    format!("write failed for {peer}: {text}"),
                );
                self.wire.send_raw(peer, &[encode_error(code, Some(&text))]);
                self.finish_error(peer, text, Some("WriteFailed".to_owned()));
                false
            }
        }
    }

    // -- teardown -----------------------------------------------------------

    /// Removes a session and returns its final snapshot.
    ///
    /// The removal happens **first**, so the same transfer can never be
    /// finalised twice: a second caller finds nothing and returns `None`. The
    /// reference implementation needed a separate "finalizing" set for this,
    /// because its teardown was asynchronous and the session stayed in the table
    /// across an await; doing the removal synchronously makes the set
    /// unnecessary and the invariant local.
    fn take(&mut self, peer: SocketAddr) -> Option<(TransferInfo, Option<PathBuf>)> {
        let mut session = self.transfers.remove(&peer)?;
        session.close_file();
        self.write_handles.remove(&peer);
        let write_path = self.write_paths.remove(&peer);
        Some((info_of(&mut session), write_path))
    }

    fn finish_done(&mut self, peer: SocketAddr) {
        let completed_write = self.transfers.get(&peer).and_then(|session| {
            (session.direction == Direction::Write).then(|| CompletedWrite {
                window_start: session.acked_window_start,
                final_block: session.last_acked,
                ack: crate::protocol::encode_ack(session.last_acked),
                dally: session.retry_interval(),
                expires_at: Instant::now() + session.retry_interval(),
            })
        });
        let Some((info, _write_path)) = self.take(peer) else {
            return;
        };
        if let Some(completed) = completed_write {
            self.completed_writes.insert(peer, completed);
        }
        self.wire.log(
            LogLevel::Info,
            format!(
                "{} complete {} ({} bytes)",
                info.direction.as_str().to_uppercase(),
                info.filename,
                info.bytes
            ),
        );
        self.wire.emit(EngineEvent::TransferComplete(Box::new(info)));
    }

    fn finish_error(&mut self, peer: SocketAddr, reason: String, code: Option<String>) {
        let Some((info, write_path)) = self.take(peer) else {
            return;
        };
        if info.direction == Direction::Write {
            if let Some(path) = write_path {
                let _ = std::fs::remove_file(path);
            }
        }
        self.wire.log(
            LogLevel::Warn,
            format!(
                "{} failed {}: {}",
                info.direction.as_str().to_uppercase(),
                info.filename,
                reason
            ),
        );
        self.wire.emit(EngineEvent::TransferError {
            info: Box::new(info),
            error: reason,
            code,
        });
    }
}

fn info_of(session: &mut TransferSession) -> TransferInfo {
    let metrics = session.metrics();
    TransferInfo {
        id: session.transfer_id(),
        peer_address: session.peer.ip().to_string(),
        peer_port: session.peer.port(),
        direction: session.direction,
        // Sanitised here, at the one place a `TransferInfo` is built, rather
        // than at each of the places one is emitted. The daemon turns this
        // struct into newline-delimited JSON, output-channel lines and
        // notification text; a raw control character in a peer-supplied name
        // forges log lines and drives the reader's terminal. Cleaning it per
        // emission site is what failed here — the engine cleaned some of its own
        // log copies while the service-level events carried the raw value — and
        // that list only grows. The unmodified name stays on the session, which
        // is what every filesystem path already uses.
        filename: truncate_for_log(&session.filename),
        bytes: session.bytes_transferred,
        total_bytes: session.total_bytes(),
        block_size: session.opts.blksize,
        window_size: session.opts.windowsize,
        speed_bps: metrics.speed_bps,
        eta_sec: metrics.eta_sec,
        started_at_epoch_ms: metrics.started_at_epoch_ms,
        elapsed_sec: session.elapsed().as_secs(),
    }
}

/// Bounds text that came from a peer before it is echoed anywhere.
fn truncate_for_log(text: &str) -> String {
    // Sanitise as well as truncate: a filename or ERROR message is attacker-
    // controlled and ends up in a newline-delimited JSON stream and a UI. A raw
    // control character there is at best unreadable and at worst a terminal
    // escape sequence rendered by whatever displays it.
    let cleaned: String = text
        .chars()
        .take(MAX_ECHOED_TEXT)
        .map(|c| if c.is_control() { '\u{fffd}' } else { c })
        .collect();
    if text.chars().count() > MAX_ECHOED_TEXT {
        format!("{cleaned}…")
    } else {
        cleaned
    }
}

/// Maps a sandbox refusal onto the wire error the client sees.
fn wire_error_for_guard(error: &GuardError) -> (ErrorCode, Option<String>) {
    match error {
        // Deliberately the bare default text: telling a client *why* its
        // traversal failed tells it about the shape of the filesystem.
        GuardError::PathViolation(_) => (ErrorCode::AccessViolation, None),
        GuardError::NotAFile(_) => (ErrorCode::FileNotFound, Some("Not a file".to_owned())),
        GuardError::FileAlreadyExists(_) => (ErrorCode::FileAlreadyExists, None),
        GuardError::Io(e) => wire_error_for_io(e),
    }
}

/// Maps a filesystem failure onto the wire error the client sees.
///
/// Out-of-space in particular has to stay distinct from access-denied: automated
/// deployment scripts read code 3 as "retry on another host" and code 2 as
/// "give up", and collapsing the two turns a full disk into a permanent failure.
fn wire_error_for_io(error: &io::Error) -> (ErrorCode, Option<String>) {
    if is_out_of_space(error) {
        return (
            ErrorCode::DiskFull,
            Some("Disk full or allocation exceeded".to_owned()),
        );
    }
    match error.kind() {
        io::ErrorKind::NotFound => (ErrorCode::FileNotFound, None),
        io::ErrorKind::PermissionDenied => (ErrorCode::AccessViolation, None),
        io::ErrorKind::AlreadyExists => (ErrorCode::FileAlreadyExists, None),
        // Anything else is reported with the OS text, which is far more useful
        // to an operator than a bare "not defined".
        _ => (ErrorCode::NotDefined, Some(error.to_string())),
    }
}

fn is_out_of_space(error: &io::Error) -> bool {
    // Checked by raw code rather than by `ErrorKind`, so this does not depend on
    // which `ErrorKind` variants happen to be stable in a given toolchain.
    match error.raw_os_error() {
        #[cfg(unix)]
        Some(28) => true, // ENOSPC
        #[cfg(windows)]
        Some(39 | 112) => true, // ERROR_HANDLE_DISK_FULL, ERROR_DISK_FULL
        _ => false,
    }
}

// ---------------------------------------------------------------------------
// Engine (socket loop)
// ---------------------------------------------------------------------------

enum Command {
    Stop,
    Cancel(String, SyncSender<bool>),
    Snapshot(SyncSender<Vec<TransferInfo>>),
}

/// A running TFTP service.
#[derive(Debug)]
pub struct Engine {
    control: Sender<Command>,
    bound_port: u16,
    join: Option<JoinHandle<()>>,
}

impl Engine {
    /// Validates the sandbox root, binds the socket, and starts the service.
    ///
    /// Both failure modes reject, and neither leaves anything bound. The root is
    /// validated **before** the socket is created, on purpose: a root that does
    /// not exist is a configuration error the operator has to see, and a bound
    /// socket that can serve nothing is the worst possible way to tell them —
    /// the service reports "running" and every client simply times out with no
    /// diagnosis anywhere.
    pub fn start(options: &EngineOptions, events: EventSink) -> Result<Self, StartError> {
        let guard = PathGuard::new(&options.root).map_err(StartError::Root)?;
        let socket = UdpSocket::bind(SocketAddr::new(options.address, options.port))
            .map_err(StartError::Bind)?;
        socket
            .set_read_timeout(Some(POLL_INTERVAL))
            .map_err(StartError::Bind)?;
        let local = socket.local_addr().map_err(StartError::Bind)?;
        let bound_port = local.port();

        let (control_tx, control_rx) = mpsc::channel();
        let gc_interval = options.gc_interval;
        let root_display = options.root.display().to_string();
        let mut core = TftpCore::new(socket.try_clone().map_err(StartError::Bind)?, events, guard, options);
        core.wire.emit(EngineEvent::Listening {
            address: local.ip().to_string(),
            port: bound_port,
        });
        core.wire.log(
            LogLevel::Info,
            format!("listening on {local} root={root_display}"),
        );

        let join = thread::Builder::new()
            .name("nexus-tftp".into())
            .spawn(move || run_loop(&socket, &mut core, &control_rx, gc_interval))
            .map_err(StartError::Bind)?;

        Ok(Self {
            control: control_tx,
            bound_port,
            join: Some(join),
        })
    }

    /// The port actually held, which may differ from the one requested when the
    /// caller asked for an ephemeral port.
    #[must_use]
    pub fn bound_port(&self) -> u16 {
        self.bound_port
    }

    /// Aborts one transfer. `false` means it had already finished.
    #[must_use]
    pub fn cancel_transfer(&self, transfer_id: &str) -> bool {
        let (tx, rx) = mpsc::sync_channel(1);
        if self
            .control
            .send(Command::Cancel(transfer_id.to_owned(), tx))
            .is_err()
        {
            return false;
        }
        rx.recv().unwrap_or(false)
    }

    /// Snapshot of every live transfer, or an empty list if the loop is gone.
    #[must_use]
    pub fn active_transfers(&self) -> Vec<TransferInfo> {
        let (tx, rx) = mpsc::sync_channel(1);
        if self.control.send(Command::Snapshot(tx)).is_err() {
            return Vec::new();
        }
        rx.recv().unwrap_or_default()
    }

    /// Stops the service and waits for its thread, releasing the socket and
    /// every open file before returning. Idempotent.
    pub fn stop(&mut self) {
        let _ = self.control.send(Command::Stop);
        if let Some(join) = self.join.take() {
            let _ = join.join();
        }
    }
}

impl Drop for Engine {
    fn drop(&mut self) {
        self.stop();
    }
}

fn run_loop(
    socket: &UdpSocket,
    core: &mut TftpCore<UdpSocket>,
    control: &Receiver<Command>,
    gc_interval: Duration,
) {
    let mut buffer = vec![0u8; RECV_BUFFER];
    let mut next_tick = Instant::now() + gc_interval;
    let mut consecutive_errors = 0u32;
    let mut stop_reason: Option<String> = None;

    'outer: loop {
        match socket.recv_from(&mut buffer) {
            Ok((len, peer)) => {
                consecutive_errors = 0;
                core.handle_message(&buffer[..len], peer);
            }
            Err(e)
                if matches!(
                    e.kind(),
                    io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut | io::ErrorKind::Interrupted
                ) =>
            {
                // The read timeout firing is the normal case: it is what paces
                // the tick and the control channel.
                consecutive_errors = 0;
            }
            Err(e) if e.kind() == io::ErrorKind::ConnectionReset => {
                // Windows reports an ICMP port-unreachable from a previous
                // `send_to` as an error on the *next* `recv_from`. It says
                // nothing about this socket's health, and treating it as fatal
                // kills a working server because one client went away.
                consecutive_errors = 0;
            }
            Err(e) => {
                consecutive_errors += 1;
                core.wire
                    .log(LogLevel::Warn, format!("socket receive failed: {e}"));
                if consecutive_errors >= MAX_CONSECUTIVE_SOCKET_ERRORS {
                    stop_reason = Some(format!("socket is unusable: {e}"));
                    break 'outer;
                }
            }
        }

        loop {
            match control.try_recv() {
                // A `Stop` and a disconnected channel mean the same thing:
                // nobody is left to serve. The second happens when the owning
                // handle is dropped without a stop, and must not leave a socket
                // bound that nothing can reach.
                Ok(Command::Stop) | Err(TryRecvError::Disconnected) => break 'outer,
                Ok(Command::Cancel(id, reply)) => {
                    let _ = reply.send(core.cancel_transfer(&id));
                }
                Ok(Command::Snapshot(reply)) => {
                    let _ = reply.send(core.active_transfers());
                }
                Err(TryRecvError::Empty) => break,
            }
        }

        if Instant::now() >= next_tick {
            core.tick();
            next_tick = Instant::now() + gc_interval;
        }
    }

    core.shutdown();
    core.wire.emit(EngineEvent::Stopped {
        reason: stop_reason,
    });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::path_guard::PathGuard;
    use crate::protocol::{encode_ack, encode_data, encode_rrq, encode_wrq};
    use crate::testsupport::TempDir;
    use crate::types::RawOptions;
    use std::cell::RefCell;
    use std::rc::Rc;
    use std::sync::{Arc, Mutex};

    /// A `Datagram` that records instead of sending.
    type SentPackets = Rc<RefCell<Vec<(SocketAddr, Vec<u8>)>>>;

    #[derive(Default, Clone)]
    struct Recorder {
        sent: SentPackets,
    }

    impl Datagram for Recorder {
        fn send_to(&self, buf: &[u8], peer: SocketAddr) -> io::Result<usize> {
            self.sent.borrow_mut().push((peer, buf.to_vec()));
            Ok(buf.len())
        }
    }

    fn core_for(temp: &TempDir, allow_write: bool, max_transfers: usize) -> (TftpCore<Recorder>, Recorder) {
        let recorder = Recorder::default();
        let mut options = EngineOptions::new(temp.path());
        options.allow_write = allow_write;
        options.max_transfers = max_transfers;
        let guard = PathGuard::new(temp.path()).unwrap();
        let core = TftpCore::new(recorder.clone(), Box::new(|_| {}), guard, &options);
        (core, recorder)
    }

    fn peer(port: u16) -> SocketAddr {
        format!("127.0.0.1:{port}").parse().unwrap()
    }

    fn error_code(packet: &[u8]) -> u16 {
        match parse_packet(packet).unwrap() {
            Some(Packet::Error { code, .. }) => code,
            other => panic!("expected ERROR, got {other:?}"),
        }
    }

    fn ack_block(packet: &[u8]) -> u16 {
        match parse_packet(packet).unwrap() {
            Some(Packet::Ack { block }) => block,
            other => panic!("expected ACK, got {other:?}"),
        }
    }

    // --- admission -----------------------------------------------------------

    #[test]
    fn reservations_count_toward_the_cap_before_anything_is_registered() {
        // This is the test that a check-then-act implementation fails. With the
        // cap read straight off the session table, `registered` stays 0 through
        // all of these — the very situation a burst of concurrent requests
        // creates — and every single one is admitted.
        let mut admission = Admission::new(2);
        assert!(admission.try_reserve(0));
        assert!(admission.try_reserve(0));
        assert!(
            !admission.try_reserve(0),
            "a third request must be refused even though nothing has registered yet"
        );
        assert_eq!(admission.reserved(), 2);
    }

    #[test]
    fn a_released_reservation_becomes_available_again() {
        let mut admission = Admission::new(1);
        assert!(admission.try_reserve(0));
        assert!(!admission.try_reserve(0));
        admission.release();
        assert!(admission.try_reserve(0));
    }

    #[test]
    fn registered_sessions_and_reservations_are_counted_together() {
        let mut admission = Admission::new(3);
        assert!(admission.try_reserve(2), "2 registered + 0 reserved < 3");
        assert!(
            !admission.try_reserve(2),
            "2 registered + 1 reserved has already reached the cap"
        );
    }

    #[test]
    fn a_burst_of_requests_cannot_exceed_the_cap() {
        let temp = TempDir::new("engine-burst");
        std::fs::write(temp.path().join("boot.bin"), vec![0u8; 200_000]).unwrap();
        let (mut core, _rec) = core_for(&temp, false, 2);
        let rrq = encode_rrq("boot.bin", "octet", &RawOptions::default());
        for i in 0..8u16 {
            core.handle_message(&rrq, peer(41000 + i));
        }
        assert_eq!(core.transfer_count(), 2);
    }

    #[test]
    fn a_failed_request_releases_its_slot_instead_of_leaking_it() {
        // Three requests for a file that does not exist: each is admitted, fails
        // in the sandbox, and answers FileNotFound. A reservation released only
        // on the success path would consume the single slot three times over and
        // wedge the service at "Server busy" permanently.
        let temp = TempDir::new("engine-leak");
        std::fs::write(temp.path().join("real.bin"), vec![1u8; 4096]).unwrap();
        let (mut core, _rec) = core_for(&temp, false, 1);
        let miss = encode_rrq("absent.bin", "octet", &RawOptions::default());
        for i in 0..3u16 {
            core.handle_message(&miss, peer(42000 + i));
        }
        assert_eq!(core.transfer_count(), 0);
        assert_eq!(core.admission.reserved(), 0, "the slots must have come back");

        let rrq = encode_rrq("real.bin", "octet", &RawOptions::default());
        core.handle_message(&rrq, peer(42100));
        assert_eq!(core.transfer_count(), 1);
    }

    // --- wire error mapping --------------------------------------------------

    #[test]
    fn a_stray_ack_without_a_session_gets_unknown_transfer_id() {
        let temp = TempDir::new("engine-stray");
        let (mut core, rec) = core_for(&temp, false, 8);
        core.handle_message(&encode_ack(1), peer(43000));
        let sent = rec.sent.borrow();
        assert_eq!(error_code(&sent[0].1), ErrorCode::UnknownTransferId.to_wire());
    }

    #[test]
    fn a_write_is_refused_when_uploads_are_disabled() {
        let temp = TempDir::new("engine-nowrite");
        let (mut core, rec) = core_for(&temp, false, 8);
        let wrq = encode_wrq("up.bin", "octet", &RawOptions::default());
        core.handle_message(&wrq, peer(43100));
        let sent = rec.sent.borrow();
        assert_eq!(error_code(&sent[0].1), ErrorCode::AccessViolation.to_wire());
        assert_eq!(core.transfer_count(), 0);
    }

    #[test]
    fn a_write_over_an_existing_file_is_refused() {
        let temp = TempDir::new("engine-exists");
        std::fs::write(temp.path().join("up.bin"), b"already here").unwrap();
        let (mut core, rec) = core_for(&temp, true, 8);
        core.handle_message(
            &encode_wrq("up.bin", "octet", &RawOptions::default()),
            peer(43200),
        );
        let sent = rec.sent.borrow();
        assert_eq!(error_code(&sent[0].1), ErrorCode::FileAlreadyExists.to_wire());
    }

    #[test]
    fn a_cancelled_write_removes_the_incomplete_destination() {
        let temp = TempDir::new("engine-cancel-write");
        let destination = temp.path().join("up.bin");
        let (mut core, _rec) = core_for(&temp, true, 8);
        let writer = peer(43210);

        core.handle_message(&encode_wrq("up.bin", "octet", &RawOptions::default()), writer);
        assert!(destination.exists(), "WRQ creates the destination before DATA arrives");
        assert!(core.cancel_transfer(&writer.to_string()));

        assert!(
            !destination.exists(),
            "a failed upload must not permanently reserve the requested filename"
        );
    }

    #[test]
    fn a_client_error_during_write_removes_the_incomplete_destination() {
        let temp = TempDir::new("engine-client-error-write");
        let destination = temp.path().join("up.bin");
        let (mut core, _rec) = core_for(&temp, true, 8);
        let writer = peer(43211);

        core.handle_message(&encode_wrq("up.bin", "octet", &RawOptions::default()), writer);
        assert!(destination.exists(), "WRQ creates the destination before DATA arrives");
        core.handle_message(
            &encode_error(ErrorCode::NotDefined, Some("client aborted")),
            writer,
        );

        assert!(
            !destination.exists(),
            "client-aborted uploads must not leave partial files behind"
        );
    }

    #[test]
    fn a_hostile_filename_is_sanitised_before_it_can_be_emitted() {
        // A WRQ filename is attacker-controlled, and valid UTF-8 may carry
        // newlines and escape sequences. `TransferInfo` is what the daemon turns
        // into newline-delimited JSON, output-channel lines and notification
        // text, so a raw control character here can forge a log line or drive
        // the terminal of whoever is watching. Sanitising at the one place
        // `TransferInfo` is built covers every emission site, including the ones
        // not written yet — which is the failure mode: the engine cleaned some
        // of its own log copies and the service-level events kept the raw value.
        let mut session = TransferSession::new(TransferInit {
            peer: peer(43300),
            direction: Direction::Write,
            filename: "up\n{\"event\":\"ready\"}\u{1b}[2J.bin".to_owned(),
            abs_path: PathBuf::from("up.bin"),
            raw_options: RawOptions::default(),
        });

        let info = info_of(&mut session);

        assert!(!info.filename.contains('\n'), "got {:?}", info.filename);
        assert!(!info.filename.contains('\u{1b}'), "got {:?}", info.filename);
        assert!(
            info.filename.starts_with("up"),
            "and the name is still recognisable: {:?}",
            info.filename
        );
    }

    #[test]
    fn a_completed_write_reacks_a_duplicate_final_data_packet() {
        let temp = TempDir::new("engine-write-final-retry");
        let destination = temp.path().join("up.bin");
        let (mut core, rec) = core_for(&temp, true, 8);
        let writer = peer(43212);

        core.handle_message(&encode_wrq("up.bin", "octet", &RawOptions::default()), writer);
        core.handle_message(&encode_data(1, b"done"), writer);
        assert_eq!(std::fs::read(&destination).unwrap(), b"done");

        let duplicate_final = encode_data(1, b"done");
        core.handle_message(&duplicate_final, writer);

        let sent = rec.sent.borrow();
        assert_eq!(ack_block(&sent[1].1), 1, "the final DATA must be acknowledged");
        assert_eq!(
            ack_block(&sent[2].1),
            1,
            "a duplicate final DATA must receive the same final ACK"
        );
        assert_eq!(
            std::fs::read(&destination).unwrap(),
            b"done",
            "the duplicate final DATA must not be appended a second time"
        );
    }

    #[test]
    fn a_completed_write_reacks_a_duplicate_from_anywhere_in_the_final_window() {
        // windowsize=4, blksize=8: DATA(1) is full and draws no ACK, DATA(2) is
        // short and completes the upload with the cumulative ACK(2). If that ACK
        // is lost, an RFC 7440 client resumes from the first block it never saw
        // acknowledged — DATA(1), not DATA(2). State that keeps only the final
        // block answers UnknownTransferId there, which leaves the server holding
        // a complete file while the client reports the upload as failed.
        let temp = TempDir::new("engine-write-final-window-retry");
        let destination = temp.path().join("up.bin");
        let (mut core, rec) = core_for(&temp, true, 8);
        let writer = peer(43214);
        let options = RawOptions {
            blksize: Some("8".to_owned()),
            windowsize: Some("4".to_owned()),
            ..RawOptions::default()
        };

        core.handle_message(&encode_wrq("up.bin", "octet", &options), writer);
        core.handle_message(&encode_data(1, b"01234567"), writer);
        core.handle_message(&encode_data(2, b"tail"), writer);
        assert_eq!(std::fs::read(&destination).unwrap(), b"01234567tail");

        core.handle_message(&encode_data(1, b"01234567"), writer);

        let sent = rec.sent.borrow();
        assert_eq!(
            ack_block(&sent.last().unwrap().1),
            2,
            "a duplicate from the completed window must draw the final cumulative ACK"
        );
        assert_eq!(
            std::fs::read(&destination).unwrap(),
            b"01234567tail",
            "the duplicate must not be appended a second time"
        );
    }

    #[test]
    fn a_completed_write_rejects_a_duplicate_from_before_the_final_window() {
        // windowsize=2, blksize=8: blocks 1-2 fill a window and draw ACK(2), then
        // the short block 3 completes the upload on its own. The final window is
        // therefore block 3 alone. A client that reached block 3 had already seen
        // ACK(2), so a late DATA(2) is a stale network duplicate rather than a
        // retry — bounding the dally by the negotiated windowsize instead of by
        // the window that actually closed would answer it as if the transfer were
        // still open.
        let temp = TempDir::new("engine-write-stale-window-retry");
        let (mut core, rec) = core_for(&temp, true, 8);
        let writer = peer(43215);
        let options = RawOptions {
            blksize: Some("8".to_owned()),
            windowsize: Some("2".to_owned()),
            ..RawOptions::default()
        };

        core.handle_message(&encode_wrq("up.bin", "octet", &options), writer);
        core.handle_message(&encode_data(1, b"01234567"), writer);
        core.handle_message(&encode_data(2, b"89abcdef"), writer);
        core.handle_message(&encode_data(3, b"tail"), writer);

        core.handle_message(&encode_data(2, b"89abcdef"), writer);

        let sent = rec.sent.borrow();
        assert_eq!(
            error_code(&sent.last().unwrap().1),
            ErrorCode::UnknownTransferId.to_wire(),
            "a block from before the completed window is not a final-window retry"
        );
    }

    #[test]
    fn answering_a_completed_write_retry_restarts_the_dally() {
        // A client whose retry is answered but whose *answer* is also lost waits
        // one more negotiated timeout before trying again. A deadline fixed at
        // completion has expired by then, so the second retry — just as valid as
        // the first — draws UnknownTransferId and the client reports a failure
        // for an upload the server already has.
        let temp = TempDir::new("engine-write-dally-renewal");
        let (mut core, _rec) = core_for(&temp, true, 8);
        let writer = peer(43216);
        let options = RawOptions {
            timeout: Some("30".to_owned()),
            ..RawOptions::default()
        };

        core.handle_message(&encode_wrq("up.bin", "octet", &options), writer);
        core.handle_message(&encode_data(1, b"done"), writer);
        let first = core
            .completed_writes
            .get(&writer)
            .expect("completed WRQ keeps final ACK state")
            .expires_at;

        core.handle_message(&encode_data(1, b"done"), writer);
        let renewed = core
            .completed_writes
            .get(&writer)
            .expect("answering a retry must not drop the state")
            .expires_at;

        assert!(
            renewed > first,
            "each answered retry must restart the dally clock"
        );
    }

    #[test]
    fn a_completed_write_dallies_for_the_negotiated_timeout() {
        let temp = TempDir::new("engine-write-final-retry-timeout");
        let (mut core, _rec) = core_for(&temp, true, 8);
        let writer = peer(43213);
        let options = RawOptions {
            timeout: Some("30".to_owned()),
            ..RawOptions::default()
        };

        core.handle_message(&encode_wrq("up.bin", "octet", &options), writer);
        core.handle_message(&encode_data(1, b"done"), writer);

        let retained_for = core
            .completed_writes
            .get(&writer)
            .expect("completed WRQ keeps final ACK state")
            .expires_at
            .saturating_duration_since(Instant::now());
        assert!(
            retained_for >= Duration::from_secs(29),
            "dally should follow the negotiated timeout; retained for {retained_for:?}"
        );
    }

    #[test]
    fn a_traversal_attempt_is_answered_with_access_violation_and_no_detail() {
        let temp = TempDir::new("engine-traversal");
        let (mut core, rec) = core_for(&temp, false, 8);
        core.handle_message(
            &encode_rrq("../../etc/passwd", "octet", &RawOptions::default()),
            peer(43300),
        );
        let sent = rec.sent.borrow();
        let Some(Packet::Error { code, message }) = parse_packet(&sent[0].1).unwrap() else {
            panic!("expected ERROR");
        };
        assert_eq!(code, ErrorCode::AccessViolation.to_wire());
        assert_eq!(
            message,
            ErrorCode::AccessViolation.default_message(),
            "the reason must not describe the filesystem to the client"
        );
        assert_eq!(core.transfer_count(), 0);
    }

    #[test]
    fn a_missing_file_is_answered_with_file_not_found() {
        let temp = TempDir::new("engine-missing");
        let (mut core, rec) = core_for(&temp, false, 8);
        core.handle_message(
            &encode_rrq("nope.bin", "octet", &RawOptions::default()),
            peer(43400),
        );
        let sent = rec.sent.borrow();
        assert_eq!(error_code(&sent[0].1), ErrorCode::FileNotFound.to_wire());
    }

    #[test]
    fn netascii_is_refused_on_the_wire_without_creating_a_session() {
        let temp = TempDir::new("engine-netascii");
        std::fs::write(temp.path().join("readme.txt"), b"hello").unwrap();
        let (mut core, rec) = core_for(&temp, false, 8);
        core.handle_message(
            &encode_rrq("readme.txt", "netascii", &RawOptions::default()),
            peer(43500),
        );
        let sent = rec.sent.borrow();
        assert_eq!(error_code(&sent[0].1), ErrorCode::IllegalOperation.to_wire());
        assert_eq!(core.transfer_count(), 0);
    }

    #[test]
    fn a_directory_is_not_servable() {
        let temp = TempDir::new("engine-dir");
        std::fs::create_dir(temp.path().join("sub")).unwrap();
        let (mut core, rec) = core_for(&temp, false, 8);
        core.handle_message(
            &encode_rrq("sub", "octet", &RawOptions::default()),
            peer(43600),
        );
        let sent = rec.sent.borrow();
        assert_eq!(error_code(&sent[0].1), ErrorCode::FileNotFound.to_wire());
    }

    // --- start-up validation -------------------------------------------------

    #[test]
    fn a_root_that_does_not_exist_fails_start_and_binds_nothing() {
        let temp = TempDir::new("engine-badroot");
        let mut options = EngineOptions::new(temp.path().join("no-such-directory"));
        options.port = 0;
        options.address = std::net::Ipv4Addr::LOCALHOST.into();
        let err = Engine::start(&options, Box::new(|_| {})).unwrap_err();
        assert!(
            err.to_string().contains("does not exist"),
            "got {err}"
        );
        // If the socket had been bound first, the port would be held by a
        // service that can serve nothing and every client would just time out.
        assert!(matches!(err, StartError::Root(_)));
    }

    #[test]
    fn a_bad_root_is_diagnosed_even_when_the_port_is_also_unavailable() {
        // Ordering decides which problem the operator is told about. With the
        // socket bound first, a service that is misconfigured in two ways
        // reports the secondary symptom — "port in use" — and the operator goes
        // hunting for a port conflict that is not the actual fault.
        let temp = TempDir::new("engine-order");
        let holder = UdpSocket::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let taken = holder.local_addr().unwrap().port();
        let mut options = EngineOptions::new(temp.path().join("no-such-directory"));
        options.address = Ipv4Addr::LOCALHOST.into();
        options.port = taken;
        let err = Engine::start(&options, Box::new(|_| {})).unwrap_err();
        assert!(
            matches!(err, StartError::Root(_)),
            "the root must be validated before the socket is touched, got {err}"
        );
    }

    #[test]
    fn a_root_that_is_a_file_fails_start() {
        let temp = TempDir::new("engine-fileroot");
        let file = temp.path().join("root-is-a-file");
        std::fs::write(&file, b"x").unwrap();
        let mut options = EngineOptions::new(&file);
        options.port = 0;
        options.address = std::net::Ipv4Addr::LOCALHOST.into();
        let err = Engine::start(&options, Box::new(|_| {})).unwrap_err();
        assert!(err.to_string().contains("not a directory"), "got {err}");
    }

    #[test]
    fn a_bind_failure_is_reported_rather_than_reported_as_success() {
        let temp = TempDir::new("engine-inuse");
        let mut options = EngineOptions::new(temp.path());
        options.port = 0;
        options.address = std::net::Ipv4Addr::LOCALHOST.into();
        let events: EventSink = Box::new(|_| {});
        let first = Engine::start(&options, events).expect("first bind succeeds");

        let mut second_options = options.clone();
        second_options.port = first.bound_port();
        let err = Engine::start(&second_options, Box::new(|_| {}))
            .expect_err("the port is already held");
        assert!(err.is_address_in_use(), "got {err}");
    }

    #[test]
    fn the_listening_event_carries_the_port_actually_bound() {
        let temp = TempDir::new("engine-listening");
        let mut options = EngineOptions::new(temp.path());
        options.port = 0;
        options.address = std::net::Ipv4Addr::LOCALHOST.into();
        let seen = Arc::new(Mutex::new(Vec::new()));
        let sink = Arc::clone(&seen);
        let engine = Engine::start(
            &options,
            Box::new(move |event| {
                if let EngineEvent::Listening { port, .. } = event {
                    sink.lock().unwrap().push(port);
                }
            }),
        )
        .unwrap();
        assert_eq!(seen.lock().unwrap().as_slice(), &[engine.bound_port()]);
        assert_ne!(engine.bound_port(), 0);
    }

    // --- echoed text ---------------------------------------------------------

    #[test]
    fn peer_supplied_text_is_bounded_and_stripped_of_control_characters() {
        let long = "a".repeat(MAX_ECHOED_TEXT * 3);
        let truncated = truncate_for_log(&long);
        assert!(truncated.chars().count() <= MAX_ECHOED_TEXT + 1);
        // A newline would split one JSON line into two on the daemon's stdout,
        // and an escape sequence would be rendered by whatever shows the log.
        let hostile = truncate_for_log("boot\n{\"event\":\"ready\"}\u{1b}[2J.bin");
        assert!(!hostile.contains('\n'));
        assert!(!hostile.contains('\u{1b}'));
    }
}
