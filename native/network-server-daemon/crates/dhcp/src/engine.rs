//! The DHCP engine: UDP socket, the DORA state machine, and the tick that
//! expires leases and flushes the lease file.
//!
//! # Concurrency model
//!
//! One thread owns the socket and the lease table, exactly as in the TFTP
//! engine. Inbound datagrams arrive through a blocking `recv_from` with a read
//! timeout; that timeout also paces the maintenance tick and makes control
//! commands (stop, snapshot) land promptly. Nothing is shared, so there is no
//! lock around the lease table.
//!
//! # Structure
//!
//! [`DhcpCore`] is the protocol: it takes bytes and a peer, and produces
//! replies through a [`Datagram`]. It has no socket of its own, so the whole
//! DORA exchange can be driven from a unit test through a recorder. [`Engine`]
//! is the thread and the socket around it.

use std::collections::BTreeMap;
use std::fmt::{self, Write as _};
use std::io;
use std::net::{IpAddr, Ipv4Addr, SocketAddr, UdpSocket};
use std::path::PathBuf;
use std::sync::mpsc::{self, Receiver, Sender, SyncSender, TryRecvError};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use crate::boot::BootOptions;
use crate::constants::{
    CLIENT_PORT, DEFAULT_BROADCAST, DEFAULT_GATEWAY, DEFAULT_LEASE_SECS, DEFAULT_PORT,
    DEFAULT_RANGE_END, DEFAULT_RANGE_START, DEFAULT_SERVER_ID, DEFAULT_SUBNET,
    MAX_DHCP_POOL_SIZE, OPTION_BROADCAST, OPTION_DNS, OPTION_HOSTNAME, OPTION_LEASE_TIME,
    OPTION_MESSAGE, OPTION_MESSAGE_TYPE, OPTION_REBINDING_TIME, OPTION_RENEWAL_TIME,
    OPTION_REQUESTED_IP, OPTION_ROUTER, OPTION_SERVER_ID, OPTION_SUBNET_MASK,
    OPTION_VENDOR_CLASS_ID, OP_BOOTREQUEST,
};
use crate::lease::{BindOutcome, LeaseInfo, LeaseTable, PoolInfo};
use crate::net::{pool_size, MacKey};
use crate::persistence::{self, ReconcileContext};
use crate::protocol::{DecodeError, Message, MessageType, OptionsBuilder, ReplyBuilder};

/// How long a socket read blocks before the loop checks its other work. Bounds
/// the latency of a `stop` command.
const POLL_INTERVAL: Duration = Duration::from_millis(100);

/// Maintenance tick interval — lease expiry and the lease-file flush.
pub const DEFAULT_TICK_INTERVAL: Duration = Duration::from_secs(2);

/// Trailing-edge window between the last lease change and the write.
///
/// Long enough to swallow the DISCOVER/REQUEST burst of one client, and of a
/// whole switch stack coming up at once; short enough that a crash loses at most
/// half a second of lease history.
pub const DEFAULT_PERSIST_DEBOUNCE: Duration = Duration::from_millis(500);

/// Receive buffer: the largest payload a UDP datagram can carry.
const RECV_BUFFER: usize = 65_536;

/// Consecutive unexpected socket errors tolerated before the loop gives up.
///
/// Without a bound, a socket wedged in a permanently-failing state spins a core
/// at 100% forever.
const MAX_CONSECUTIVE_SOCKET_ERRORS: u32 = 100;

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

/// Counters for messages processed since start-up.
///
/// The field names are the reference implementation's, because the host renders
/// them — but two of them mean something different here, and better.
/// `offer_count`, `ack_count` and `nak_count` counted *received* option 53
/// values there, which is impossible: an OFFER, an ACK and a NAK all travel
/// server-to-client, so those three counters were permanently zero. Here they
/// are incremented where the packet is actually sent. `packets_sent` was an
/// estimate for the same reason; here it is a count.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct PacketCounters {
    pub packets_received: u64,
    pub packets_sent: u64,
    pub discover_count: u64,
    pub offer_count: u64,
    pub request_count: u64,
    pub decline_count: u64,
    pub ack_count: u64,
    pub nak_count: u64,
    pub release_count: u64,
    pub inform_count: u64,
    /// Datagrams that did not decode. Not in the reference at all, and the one
    /// number that says "something on this network is speaking nonsense at us".
    pub malformed_count: u64,
}

/// Everything the engine tells the outside world.
#[derive(Debug, Clone)]
pub enum EngineEvent {
    Listening { address: String, port: u16 },
    Log { level: LogLevel, message: String },
    /// A device took an address it was not holding before.
    LeaseBound(Box<LeaseInfo>),
    /// A device re-claimed the address it already held.
    LeaseRenewed(Box<LeaseInfo>),
    /// An address came back — released, declined or expired.
    LeaseReleased { mac: String, ip: Option<Ipv4Addr>, reason: ReleaseReason },
    /// A client refused an address because something else answers on it.
    LeaseDeclined { mac: String, ip: Option<Ipv4Addr> },
    /// The socket loop stopped on its own, which only happens on an
    /// unrecoverable socket fault.
    Stopped { reason: Option<String> },
}

/// Why an address came back to the pool.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReleaseReason {
    Released,
    Expired,
    Declined,
}

impl ReleaseReason {
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Released => "released",
            Self::Expired => "expired",
            Self::Declined => "declined",
        }
    }
}

/// Sink for engine events. Called on the engine thread, so it must not block.
pub type EventSink = Box<dyn Fn(EngineEvent) + Send>;

/// Why a service could not start.
#[derive(Debug)]
pub enum StartError {
    /// The configuration cannot serve anything — checked before the socket is
    /// touched, so a service that cannot work never reports itself as running.
    Configuration(String),
    Bind(io::Error),
}

impl fmt::Display for StartError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Configuration(message) => f.write_str(message),
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

    #[must_use]
    pub fn is_address_in_use(&self) -> bool {
        matches!(self, Self::Bind(e) if e.kind() == io::ErrorKind::AddrInUse)
    }
}

/// Engine construction parameters.
#[derive(Debug, Clone)]
pub struct EngineOptions {
    /// Local address to bind — which NIC serves DHCP.
    ///
    /// An [`IpAddr`], not a string, for the same reason as in the TFTP engine:
    /// binding to a `(&str, u16)` runs the string through name resolution, so a
    /// typo would turn service start-up into a blocking DNS lookup.
    pub address: IpAddr,
    pub port: u16,
    pub range_start: Ipv4Addr,
    pub range_end: Ipv4Addr,
    pub subnet: Ipv4Addr,
    pub gateway: Ipv4Addr,
    pub dns: Vec<Ipv4Addr>,
    pub lease_secs: u32,
    pub server_id: Ipv4Addr,
    pub broadcast: Ipv4Addr,
    /// MAC → IP reservations, already canonicalised.
    pub statics: BTreeMap<MacKey, Ipv4Addr>,
    /// Where the lease table is mirrored. `None` keeps leases in memory only.
    pub lease_store_path: Option<PathBuf>,
    pub boot: BootOptions,
    pub tick_interval: Duration,
    pub persist_debounce: Duration,
}

impl Default for EngineOptions {
    fn default() -> Self {
        Self {
            address: IpAddr::V4(Ipv4Addr::UNSPECIFIED),
            port: DEFAULT_PORT,
            range_start: DEFAULT_RANGE_START,
            range_end: DEFAULT_RANGE_END,
            subnet: DEFAULT_SUBNET,
            gateway: DEFAULT_GATEWAY,
            dns: crate::constants::DEFAULT_DNS.to_vec(),
            lease_secs: DEFAULT_LEASE_SECS,
            server_id: DEFAULT_SERVER_ID,
            broadcast: DEFAULT_BROADCAST,
            statics: BTreeMap::new(),
            lease_store_path: None,
            boot: BootOptions::default(),
            tick_interval: DEFAULT_TICK_INTERVAL,
            persist_debounce: DEFAULT_PERSIST_DEBOUNCE,
        }
    }
}

impl EngineOptions {
    /// Everything that must hold before a socket is worth binding.
    ///
    /// Checked at start rather than per packet, and *before* the bind: a service
    /// that binds and then answers nothing reads as "DHCP is broken" with no
    /// diagnosis anywhere, which is the worst possible way to report a typo.
    pub fn validate(&self) -> Result<(), String> {
        let size = pool_size(self.range_start, self.range_end);
        if size == 0 {
            return Err(format!(
                "The address pool {} → {} is empty: the end address is below the start. \
                 No client could be given an address.",
                self.range_start, self.range_end
            ));
        }
        if size > MAX_DHCP_POOL_SIZE {
            return Err(format!(
                "DHCP pool size is {size} addresses; it must not exceed 65,536."
            ));
        }
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Wire
// ---------------------------------------------------------------------------

/// Anything that can put a datagram on the wire.
///
/// Exists so the core can be driven by a test harness that records packets
/// instead of sending them.
pub trait Datagram {
    fn send_to(&self, buf: &[u8], peer: SocketAddr) -> io::Result<usize>;
}

impl Datagram for UdpSocket {
    fn send_to(&self, buf: &[u8], peer: SocketAddr) -> io::Result<usize> {
        UdpSocket::send_to(self, buf, peer)
    }
}

struct Wire<S: Datagram> {
    socket: S,
    events: EventSink,
}

impl<S: Datagram> Wire<S> {
    fn emit(&self, event: EngineEvent) {
        (self.events)(event);
    }

    fn log(&self, level: LogLevel, message: impl Into<String>) {
        self.emit(EngineEvent::Log { level, message: message.into() });
    }

    /// UDP is best-effort: a send failure is logged, never propagated. A
    /// transient failure against one peer must not abort a loop serving every
    /// other peer.
    fn send(&self, peer: SocketAddr, packet: &[u8]) -> bool {
        match self.socket.send_to(packet, peer) {
            Ok(_) => true,
            Err(e) => {
                self.log(LogLevel::Warn, format!("send to {peer} failed: {e}"));
                false
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Core
// ---------------------------------------------------------------------------

/// The protocol core: everything except the socket loop itself.
pub struct DhcpCore<S: Datagram> {
    wire: Wire<S>,
    table: LeaseTable,
    subnet: Ipv4Addr,
    gateway: Ipv4Addr,
    dns: Vec<Ipv4Addr>,
    server_id: Ipv4Addr,
    broadcast: Ipv4Addr,
    lease_secs: u32,
    boot: BootOptions,
    lease_store_path: Option<PathBuf>,
    persist_debounce: Duration,
    dirty_since: Option<Instant>,
    /// True while the last lease write failed and has not yet succeeded again.
    ///
    /// Retries run on the debounce interval, which is sub-second, so a store
    /// that never recovers would otherwise report itself several times a second
    /// for as long as the daemon runs. Reporting on the transitions instead
    /// keeps the retry silent without keeping it secret.
    persist_failed: bool,
    counters: PacketCounters,
}

impl<S: Datagram> DhcpCore<S> {
    /// Builds the core and restores the persisted table.
    ///
    /// The ordering inside is load-bearing and matches the reference: restore
    /// from disk **first**, then seed reservations. Reversed, a restored lease
    /// would overwrite a freshly-seeded placeholder and a reservation would lose
    /// to a stale dynamic lease; in this order the seeding sees what was
    /// restored and can leave a correct entry's bind history alone.
    fn new(socket: S, events: EventSink, options: &EngineOptions) -> Self {
        let mut core = Self {
            wire: Wire { socket, events },
            table: LeaseTable::new(
                options.range_start,
                options.range_end,
                options.lease_secs,
                options.statics.clone(),
            ),
            subnet: options.subnet,
            gateway: options.gateway,
            dns: options.dns.clone(),
            server_id: options.server_id,
            broadcast: options.broadcast,
            lease_secs: options.lease_secs,
            boot: options.boot.clone(),
            lease_store_path: options.lease_store_path.clone(),
            persist_debounce: options.persist_debounce,
            dirty_since: None,
            persist_failed: false,
            counters: PacketCounters::default(),
        };
        core.restore_persisted(options);
        let report = core.table.seed_static_reservations(persistence::now_epoch_ms());
        if !report.seeded.is_empty() || !report.skipped.is_empty() {
            let seeded = report
                .seeded
                .iter()
                .map(|(mac, ip)| format!("{mac}→{ip}"))
                .collect::<Vec<_>>()
                .join(", ");
            let skipped = report
                .skipped
                .iter()
                .map(|(mac, ip)| format!("{mac}→{ip}"))
                .collect::<Vec<_>>()
                .join(", ");
            let mut line = format!(
                "reserved {} in-pool static address(es)",
                report.seeded.len()
            );
            if !seeded.is_empty() {
                let _ = write!(line, ": {seeded}");
            }
            if !skipped.is_empty() {
                let _ = write!(
                    line,
                    " · {} outside the pool (no reservation needed): {skipped}",
                    report.skipped.len()
                );
            }
            core.wire.log(LogLevel::Info, line);
        }
        core
    }

    fn restore_persisted(&mut self, options: &EngineOptions) {
        let Some(path) = &options.lease_store_path else {
            return;
        };
        let stored = persistence::load_leases(path);
        if stored.is_empty() {
            return;
        }
        let result = persistence::reconcile(
            &stored,
            &ReconcileContext {
                statics: &options.statics,
                range_start: options.range_start,
                range_end: options.range_end,
                now_ms: persistence::now_epoch_ms(),
            },
        );
        self.table.restore(&result.restored);
        let mut line = format!(
            "restored {} lease(s) from {}",
            result.restored.len(),
            path.display()
        );
        if !result.dropped.is_empty() {
            let detail = result
                .dropped
                .iter()
                .map(|d| format!("{}→{} ({})", d.lease.mac, d.lease.ip, d.reason.as_str()))
                .collect::<Vec<_>>()
                .join(", ");
            let _ = write!(line, " · dropped {}: {detail}", result.dropped.len());
        }
        self.wire.log(LogLevel::Info, line);
    }

    #[must_use]
    pub fn counters(&self) -> PacketCounters {
        self.counters
    }

    #[must_use]
    pub fn active_leases(&self) -> Vec<LeaseInfo> {
        self.table.active_leases(persistence::now_epoch_ms())
    }

    #[must_use]
    pub fn pool_info(&self) -> PoolInfo {
        self.table.pool_info(persistence::now_epoch_ms())
    }

    /// Entry point for a received datagram.
    pub fn handle_message(&mut self, buf: &[u8], peer: SocketAddr) {
        self.counters.packets_received += 1;
        let message = match Message::decode(buf) {
            Ok(message) => message,
            Err(error) => {
                self.counters.malformed_count += 1;
                // Logged, not answered. Answering a packet we could not parse
                // would only tell a scanner that something is listening, and
                // there is no transaction id to answer it under anyway.
                self.wire.log(
                    LogLevel::Debug,
                    format!("dropped a malformed datagram from {peer}: {error}"),
                );
                self.note_decode_error(&error, peer);
                return;
            }
        };
        if message.op != OP_BOOTREQUEST {
            // A reply, not a request — another DHCP server is on this network.
            self.wire.log(
                LogLevel::Debug,
                format!("ignored a BOOTREPLY from {peer}: another DHCP server is answering here"),
            );
            return;
        }
        let Some(kind) = message.options.message_type() else {
            self.wire.log(
                LogLevel::Debug,
                format!("ignored a packet from {peer} with no DHCP message type (option 53)"),
            );
            return;
        };
        let mac = message.hardware_key();
        let vendor_class = message.options.text_full(OPTION_VENDOR_CLASS_ID);
        let vendor_class_log = message.options.text(OPTION_VENDOR_CLASS_ID);
        // The observed option 60 is echoed because the boot-option gate matches
        // exactly: this log line is where an operator copies the string their
        // gear actually sends.
        let suffix = vendor_class_log
            .as_deref()
            .map(|v| format!(" · vendor-class=\"{v}\""))
            .unwrap_or_default();
        self.wire
            .log(LogLevel::Debug, format!("{} from MAC {mac}{suffix}", kind.as_str()));

        match kind {
            MessageType::Discover => self.handle_discover(&message, &mac, vendor_class.as_deref()),
            MessageType::Request => self.handle_request(&message, &mac, vendor_class.as_deref()),
            MessageType::Release => self.handle_release(&message, &mac),
            MessageType::Decline => self.handle_decline(&message, &mac),
            MessageType::Inform => self.handle_inform(&message, &mac, vendor_class.as_deref()),
            MessageType::Offer | MessageType::Ack | MessageType::Nak => {
                self.wire.log(
                    LogLevel::Debug,
                    format!(
                        "ignored a {} from {peer}: that is a server message, \
                         so another DHCP server is answering on this network",
                        kind.as_str()
                    ),
                );
            }
        }
    }

    /// Raises a truncated option to `warn`.
    ///
    /// The rest of the malformed-packet space is noise a scanner generates. A
    /// length byte that overruns its buffer is the one shape worth surfacing:
    /// it is either hardware with a broken stack or somebody probing the parser,
    /// and both are things an operator wants named.
    fn note_decode_error(&self, error: &DecodeError, peer: SocketAddr) {
        if let DecodeError::OptionTruncated { code, declared, available } = error {
            self.wire.log(
                LogLevel::Warn,
                format!(
                    "{peer} sent option {code} declaring {declared} byte(s) with only \
                     {available} present — the packet was rejected, not parsed past the claim"
                ),
            );
        }
    }

    // -- DORA ---------------------------------------------------------------

    fn handle_discover(&mut self, request: &Message, mac: &MacKey, vendor_class: Option<&str>) {
        self.counters.discover_count += 1;
        let now = persistence::now_epoch_ms();
        let requested = request.options.ipv4(OPTION_REQUESTED_IP);
        let Some(address) = self.table.select_address(mac, requested, now) else {
            let info = self.table.pool_info(now);
            self.wire.log(
                LogLevel::Warn,
                format!(
                    "no address available for {mac}: the pool {} → {} is fully allocated \
                     ({} of {} in use). Widen the range or wait for a lease to expire.",
                    info.range_start, info.range_end, info.active_count, info.pool_size
                ),
            );
            return;
        };
        let hostname = request.options.text(OPTION_HOSTNAME);
        self.table.offer(mac, address, hostname, now);

        let Some(packet) = self.build_reply(request, MessageType::Offer, Some(address), vendor_class)
        else {
            return;
        };
        if self.wire.send(self.reply_destination(request, false), &packet) {
            self.counters.offer_count += 1;
            self.counters.packets_sent += 1;
        }
        self.wire
            .log(LogLevel::Info, format!("OFFER {address} to {mac}"));
    }

    fn handle_request(&mut self, request: &Message, mac: &MacKey, vendor_class: Option<&str>) {
        self.counters.request_count += 1;
        let now = persistence::now_epoch_ms();

        // RFC 2131 §3.1: option 54 in a REQUEST is the client naming the server
        // whose offer it accepted. If that is not us, the client chose somebody
        // else and our offer must be freed rather than left holding an address.
        if let Some(chosen) = request.options.ipv4(OPTION_SERVER_ID) {
            if chosen != self.server_id {
                if let Some(freed) = self.table.release_any(mac, now) {
                    self.mark_dirty();
                    self.wire.log(
                        LogLevel::Debug,
                        format!("{mac} accepted an offer from {chosen}; released {freed}"),
                    );
                }
                return;
            }
        }

        let requested = request.options.ipv4(OPTION_REQUESTED_IP).or({
            if request.ciaddr.is_unspecified() {
                None
            } else {
                Some(request.ciaddr)
            }
        });
        let selected = self.table.select_address(mac, requested, now);

        // A NAK is the honest answer to "you cannot have that address": it tells
        // the client to restart discovery immediately, where silence makes it
        // retry the same doomed request until it times out.
        let address = match (requested, selected) {
            (Some(wanted), Some(available)) if wanted != available => {
                self.send_nak(request, mac, &format!(
                    "{wanted} is not yours; {available} is what this server would assign"
                ));
                return;
            }
            (_, None) => {
                self.send_nak(request, mac, "no address is available in the configured pool");
                return;
            }
            (_, Some(available)) => available,
        };

        let hostname = request.options.text(OPTION_HOSTNAME);
        let outcome = self.table.bind(mac, address, hostname, now);
        self.mark_dirty();

        let Some(packet) = self.build_reply(request, MessageType::Ack, Some(address), vendor_class)
        else {
            return;
        };
        if self.wire.send(self.reply_destination(request, false), &packet) {
            self.counters.ack_count += 1;
            self.counters.packets_sent += 1;
        }

        // The event carries the table's own view rather than what was just
        // computed, so what is announced and what is stored cannot drift.
        if let Some(info) = self
            .table
            .active_leases(now)
            .into_iter()
            .find(|lease| lease.mac == *mac)
        {
            self.wire.log(
                LogLevel::Info,
                format!(
                    "ACK {address} to {mac} ({}, lease {}s{})",
                    info.lease_type.as_str(),
                    info.lease_sec,
                    info.hostname
                        .as_deref()
                        .map(|h| format!(", hostname={h}"))
                        .unwrap_or_default()
                ),
            );
            match outcome {
                BindOutcome::Bound => self.wire.emit(EngineEvent::LeaseBound(Box::new(info))),
                BindOutcome::Renewed => self.wire.emit(EngineEvent::LeaseRenewed(Box::new(info))),
            }
        }
    }

    fn handle_release(&mut self, request: &Message, mac: &MacKey) {
        self.counters.release_count += 1;
        if request.options.ipv4(OPTION_SERVER_ID) != Some(self.server_id) {
            return;
        }
        let address = request.ciaddr;
        if address.is_unspecified() {
            return;
        }
        let now = persistence::now_epoch_ms();
        // Unlike the reference — which had no access to the library's table and
        // so reported every release with a null address — the released address
        // is known here and is reported.
        let Some(released) = self.table.release(mac, address, now) else {
            return;
        };
        self.mark_dirty();
        self.wire.log(
            LogLevel::Info,
            format!("RELEASE from {mac} (was {released})"),
        );
        self.wire.emit(EngineEvent::LeaseReleased {
            mac: mac.to_string(),
            ip: Some(released),
            reason: ReleaseReason::Released,
        });
    }

    fn handle_decline(&mut self, request: &Message, mac: &MacKey) {
        self.counters.decline_count += 1;
        if request.options.ipv4(OPTION_SERVER_ID) != Some(self.server_id) {
            return;
        }
        let Some(named) = request.options.ipv4(OPTION_REQUESTED_IP) else {
            return;
        };
        let now = persistence::now_epoch_ms();
        let Some(declined) = self.table.decline(mac, named, now) else {
            return;
        };
        self.mark_dirty();
        self.wire.log(
            LogLevel::Warn,
            format!(
                "DECLINE from {mac} for {declined} — another host is already answering on that \
                 address; it is held out of the pool for now"
            ),
        );
        self.wire
            .emit(EngineEvent::LeaseDeclined { mac: mac.to_string(), ip: Some(declined) });
    }

    /// DHCPINFORM: the client already has an address and wants configuration.
    ///
    /// No address is allocated and no lease is created — RFC 2131 §4.3.5 is
    /// explicit that the server must not check for an existing binding and must
    /// not send a lease time.
    fn handle_inform(&mut self, request: &Message, mac: &MacKey, vendor_class: Option<&str>) {
        self.counters.inform_count += 1;
        let Some(packet) = self.build_reply(request, MessageType::Ack, None, vendor_class) else {
            return;
        };
        if self.wire.send(self.reply_destination(request, false), &packet) {
            self.counters.ack_count += 1;
            self.counters.packets_sent += 1;
        }
        self.wire
            .log(LogLevel::Debug, format!("INFORM answered for {mac}"));
    }

    fn send_nak(&mut self, request: &Message, mac: &MacKey, reason: &str) {
        let mut options = OptionsBuilder::new();
        // A NAK carries only the message type, the server identifier and,
        // optionally, a human-readable reason (RFC 2131 table 3). No lease, no
        // netmask, no address: there is nothing being granted.
        if options
            .put_u8(OPTION_MESSAGE_TYPE, MessageType::Nak.as_wire())
            .and_then(|b| b.put_ipv4(OPTION_SERVER_ID, self.server_id))
            .and_then(|b| b.put_text(OPTION_MESSAGE, &truncate_option_text(reason)))
            .is_err()
        {
            self.wire
                .log(LogLevel::Error, "could not encode a DHCPNAK".to_owned());
            return;
        }
        let reply = ReplyBuilder::for_request(request);
        let packet = reply.encode(&options.finish());
        // RFC 2131 §4.3.2: a NAK is broadcast, because the client's notion of
        // its own address is exactly what is being rejected.
        if self.wire.send(self.reply_destination(request, true), &packet) {
            self.counters.nak_count += 1;
            self.counters.packets_sent += 1;
        }
        self.wire
            .log(LogLevel::Info, format!("NAK to {mac}: {reason}"));
    }

    /// Builds an OFFER or an ACK.
    ///
    /// `address` is `None` for a DHCPINFORM, which grants no address and
    /// therefore carries no lease timers.
    fn build_reply(
        &self,
        request: &Message,
        kind: MessageType,
        address: Option<Ipv4Addr>,
        vendor_class: Option<&str>,
    ) -> Option<Vec<u8>> {
        let mut options = OptionsBuilder::new();
        let result = (|| -> Result<(), crate::protocol::EncodeError> {
            options.put_u8(OPTION_MESSAGE_TYPE, kind.as_wire())?;
            options.put_ipv4(OPTION_SERVER_ID, self.server_id)?;
            if address.is_some() {
                options.put_u32(OPTION_LEASE_TIME, self.lease_secs)?;
                // T1 at half the term and T2 at seven eighths, per RFC 2131 §4.4.5.
                options.put_u32(OPTION_RENEWAL_TIME, self.lease_secs / 2)?;
                options.put_u32(OPTION_REBINDING_TIME, self.lease_secs / 8 * 7)?;
            }
            options.put_ipv4(OPTION_SUBNET_MASK, self.subnet)?;
            options.put_ipv4(OPTION_ROUTER, self.gateway)?;
            if !self.dns.is_empty() {
                options.put_ipv4_list(OPTION_DNS, &self.dns)?;
            }
            options.put_ipv4(OPTION_BROADCAST, self.broadcast)?;
            Ok(())
        })();
        if let Err(error) = result {
            self.wire.log(
                LogLevel::Error,
                format!("could not encode a {}: {error}", kind.as_str()),
            );
            return None;
        }
        // A malformed boot option costs the boot options, not the address.
        // Refusing to hand out leases at all because one vendor TLV is mistyped
        // is a far worse outcome than serving the lease without option 43.
        if let Err(error) = self.boot.write_into(&mut options, vendor_class) {
            self.wire.log(
                LogLevel::Error,
                format!("boot options omitted from this reply: {error}"),
            );
        }

        let mut reply = ReplyBuilder::for_request(request);
        reply.siaddr = self.server_id;
        if let Some(address) = address {
            reply.yiaddr = address;
        } else {
            // An INFORM is answered to the address the client already holds.
            reply.ciaddr = request.ciaddr;
        }
        Some(reply.encode(&options.finish()))
    }

    /// Where a reply goes, per RFC 2131 §4.1.
    fn reply_destination(&self, request: &Message, force_broadcast: bool) -> SocketAddr {
        if !request.giaddr.is_unspecified() {
            // Through the relay agent that forwarded it, on the *server* port.
            return SocketAddr::new(IpAddr::V4(request.giaddr), DEFAULT_PORT);
        }
        if force_broadcast || request.wants_broadcast() {
            return SocketAddr::new(IpAddr::V4(self.broadcast), CLIENT_PORT);
        }
        SocketAddr::new(IpAddr::V4(request.ciaddr), CLIENT_PORT)
    }

    // -- maintenance ---------------------------------------------------------

    fn mark_dirty(&mut self) {
        if self.dirty_since.is_none() {
            self.dirty_since = Some(Instant::now());
        }
    }

    /// Expires lapsed claims and flushes the lease file once the debounce window
    /// has passed.
    pub fn tick(&mut self) {
        let now = persistence::now_epoch_ms();
        let expired = self.table.expire(now);
        for (mac, ip) in expired {
            self.wire
                .log(LogLevel::Info, format!("lease expired: {mac} had {ip}"));
            self.wire.emit(EngineEvent::LeaseReleased {
                mac: mac.to_string(),
                ip: Some(ip),
                reason: ReleaseReason::Expired,
            });
            self.mark_dirty();
        }
        if self
            .dirty_since
            .is_some_and(|since| since.elapsed() >= self.persist_debounce)
        {
            self.persist();
        }
    }

    /// Writes the lease table now, whatever the debounce window says.
    pub fn persist(&mut self) {
        self.dirty_since = None;
        let Some(path) = self.lease_store_path.clone() else {
            return;
        };
        let leases = self.table.persistable_leases(persistence::now_epoch_ms());
        if let Err(error) = persistence::save_leases(&path, &leases) {
            // The table stays dirty, so the next tick tries again once the
            // debounce window has passed. Clearing the marker unconditionally
            // made a transient failure permanent: with no later lease mutation
            // to set it again, nothing would ever rewrite the file, and a crash
            // after that would hand acknowledged addresses to somebody else.
            // Re-marking from *now* rather than restoring the original instant
            // also spaces the retries one debounce apart instead of reattempting
            // on every tick.
            self.dirty_since = Some(Instant::now());
            // Logged, never fatal: a lease server that stops serving because it
            // cannot write a cache file is strictly worse than one that serves
            // and warns. Logged once per outage rather than once per retry.
            if !self.persist_failed {
                self.persist_failed = true;
                self.wire.log(
                    LogLevel::Warn,
                    format!(
                        "could not persist the lease table to {} — leases will not survive a \
                         restart, and this will be retried quietly: {error}",
                        path.display()
                    ),
                );
            }
        } else if self.persist_failed {
            self.persist_failed = false;
            self.wire.log(
                LogLevel::Info,
                format!("lease table persisted again to {}", path.display()),
            );
        }
    }

    /// Final flush. An orderly shutdown is exactly when the last few seconds of
    /// lease changes are worth keeping.
    pub fn shutdown(&mut self) {
        self.persist();
    }
}

fn truncate_option_text(text: &str) -> String {
    text.chars().take(200).collect()
}

// ---------------------------------------------------------------------------
// Engine (socket loop)
// ---------------------------------------------------------------------------

/// A snapshot of everything the host renders.
#[derive(Debug, Clone)]
pub struct RuntimeSnapshot {
    pub leases: Vec<LeaseInfo>,
    pub counters: PacketCounters,
    pub pool: PoolInfo,
}

enum Command {
    Stop,
    Snapshot(SyncSender<RuntimeSnapshot>),
}

/// A running DHCP service.
#[derive(Debug)]
pub struct Engine {
    control: Sender<Command>,
    bound_port: u16,
    join: Option<JoinHandle<()>>,
}

impl Engine {
    /// Validates the configuration, binds the socket, and starts the service.
    ///
    /// The configuration is validated **before** the socket is created, exactly
    /// as the TFTP engine validates its sandbox root first: an empty pool is a
    /// configuration error the operator has to see, and a bound socket that can
    /// serve nothing is the worst possible way to tell them.
    pub fn start(options: &EngineOptions, events: EventSink) -> Result<Self, StartError> {
        options.validate().map_err(StartError::Configuration)?;

        let socket = UdpSocket::bind(SocketAddr::new(options.address, options.port))
            .map_err(StartError::Bind)?;
        // Without this, every OFFER to a client that has no address yet fails at
        // the send — which looks exactly like a network that is not delivering.
        socket.set_broadcast(true).map_err(StartError::Bind)?;
        socket
            .set_read_timeout(Some(POLL_INTERVAL))
            .map_err(StartError::Bind)?;
        let local = socket.local_addr().map_err(StartError::Bind)?;
        let bound_port = local.port();

        let (control_tx, control_rx) = mpsc::channel();
        let tick_interval = options.tick_interval;
        let mut core = DhcpCore::new(
            socket.try_clone().map_err(StartError::Bind)?,
            events,
            options,
        );
        core.wire.emit(EngineEvent::Listening {
            address: local.ip().to_string(),
            port: bound_port,
        });
        let info = core.pool_info();
        core.wire.log(
            LogLevel::Info,
            format!(
                "listening on {local} · pool {} → {} ({} addresses, {} static) · lease {}s",
                info.range_start,
                info.range_end,
                info.pool_size,
                info.static_entry_count,
                options.lease_secs
            ),
        );
        if !options.boot.is_empty() {
            core.wire.log(
                LogLevel::Info,
                format!(
                    "serving boot options [{}] {}",
                    options.boot.served_option_names().join(", "),
                    options.boot.vendor_class_id.as_deref().map_or_else(
                        || "to every client".to_owned(),
                        |class| format!("to clients whose option 60 is \"{class}\"")
                    )
                ),
            );
        }

        let join = thread::Builder::new()
            .name("nexus-dhcp".into())
            .spawn(move || run_loop(&socket, &mut core, &control_rx, tick_interval))
            .map_err(StartError::Bind)?;

        Ok(Self { control: control_tx, bound_port, join: Some(join) })
    }

    /// The port actually held, which may differ from the one requested when the
    /// caller asked for an ephemeral port.
    #[must_use]
    pub fn bound_port(&self) -> u16 {
        self.bound_port
    }

    /// Everything the host renders, or an empty view if the loop is gone.
    #[must_use]
    pub fn runtime(&self) -> Option<RuntimeSnapshot> {
        let (tx, rx) = mpsc::sync_channel(1);
        if self.control.send(Command::Snapshot(tx)).is_err() {
            return None;
        }
        rx.recv().ok()
    }

    /// Stops the service and waits for its thread, releasing the socket and
    /// flushing the lease file before returning. Idempotent.
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
    core: &mut DhcpCore<UdpSocket>,
    control: &Receiver<Command>,
    tick_interval: Duration,
) {
    let mut buffer = vec![0u8; RECV_BUFFER];
    let mut next_tick = Instant::now() + tick_interval;
    let mut consecutive_errors = 0u32;
    let mut stop_reason: Option<String> = None;

    'outer: loop {
        match socket.recv_from(&mut buffer) {
            Ok((len, peer)) => {
                consecutive_errors = 0;
                if let Some(datagram) = buffer.get(..len) {
                    core.handle_message(datagram, peer);
                }
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
                // kills a working server because one client went away — which
                // for DHCP is every client that broadcasts and then stops
                // listening on port 68.
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
                // nobody is left to serve.
                Ok(Command::Stop) | Err(TryRecvError::Disconnected) => break 'outer,
                Ok(Command::Snapshot(reply)) => {
                    let _ = reply.send(RuntimeSnapshot {
                        leases: core.active_leases(),
                        counters: core.counters(),
                        pool: core.pool_info(),
                    });
                }
                Err(TryRecvError::Empty) => break,
            }
        }

        if Instant::now() >= next_tick {
            core.tick();
            next_tick = Instant::now() + tick_interval;
        }
    }

    core.shutdown();
    core.wire.emit(EngineEvent::Stopped { reason: stop_reason });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::boot::VendorEntry;
    use crate::constants::{OPTION_CISCO_TFTP_SERVERS, OPTION_END, OPTION_PARAMETER_REQUEST_LIST};
    use crate::lease::LeaseType;
    use crate::protocol::Options;
    use crate::testsupport::{PacketBuilder, TempDir};
    use std::cell::RefCell;
    use std::rc::Rc;
    use std::sync::{Arc, Mutex, PoisonError};

    type Sent = Rc<RefCell<Vec<(SocketAddr, Vec<u8>)>>>;

    #[derive(Default, Clone)]
    struct Recorder(Sent);

    impl Datagram for Recorder {
        fn send_to(&self, buf: &[u8], peer: SocketAddr) -> io::Result<usize> {
            self.0.borrow_mut().push((peer, buf.to_vec()));
            Ok(buf.len())
        }
    }

    const MAC_A: [u8; 6] = [0xAA, 0x00, 0x00, 0x00, 0x00, 0x01];
    const MAC_B: [u8; 6] = [0xBB, 0x00, 0x00, 0x00, 0x00, 0x02];

    fn ip(text: &str) -> Ipv4Addr {
        text.parse().expect("test address parses")
    }

    fn options() -> EngineOptions {
        EngineOptions {
            range_start: ip("10.0.0.10"),
            range_end: ip("10.0.0.20"),
            subnet: ip("255.255.255.0"),
            gateway: ip("10.0.0.1"),
            dns: vec![ip("10.0.0.1")],
            lease_secs: 3600,
            server_id: ip("10.0.0.1"),
            broadcast: ip("10.0.0.255"),
            ..EngineOptions::default()
        }
    }

    struct Harness {
        core: DhcpCore<Recorder>,
        sent: Sent,
        events: Arc<Mutex<Vec<String>>>,
    }

    impl Harness {
        fn with(options: &EngineOptions) -> Self {
            let sent: Sent = Rc::default();
            let recorder = Recorder(Rc::clone(&sent));
            let events: Arc<Mutex<Vec<String>>> = Arc::default();
            let captured = Arc::clone(&events);
            let sink: EventSink = Box::new(move |event| {
                let line = match event {
                    EngineEvent::LeaseBound(l) => format!("bound {} {}", l.mac, l.ip),
                    EngineEvent::LeaseRenewed(l) => format!("renewed {} {}", l.mac, l.ip),
                    EngineEvent::LeaseReleased { mac, ip, reason } => format!(
                        "released {mac} {} {}",
                        ip.map_or_else(|| "-".to_owned(), |a| Ipv4Addr::to_string(&a)),
                        reason.as_str()
                    ),
                    EngineEvent::LeaseDeclined { mac, ip } => format!(
                        "declined {mac} {}",
                        ip.map_or_else(|| "-".to_owned(), |a| Ipv4Addr::to_string(&a))
                    ),
                    EngineEvent::Log { level, message } => format!("log {} {message}", level.as_str()),
                    EngineEvent::Listening { .. } => "listening".to_owned(),
                    EngineEvent::Stopped { .. } => "stopped".to_owned(),
                };
                captured.lock().unwrap_or_else(PoisonError::into_inner).push(line);
            });
            Self { core: DhcpCore::new(recorder, sink, options), sent, events }
        }

        fn new() -> Self {
            Self::with(&options())
        }

        fn feed(&mut self, packet: &[u8]) {
            self.core
                .handle_message(packet, SocketAddr::from(([10, 0, 0, 99], 68)));
        }

        /// The options of the last packet sent, decoded.
        fn last_reply(&self) -> Message {
            let sent = self.sent.borrow();
            let (_, bytes) = sent.last().expect("a reply was sent");
            Message::decode(bytes).expect("our own reply must decode")
        }

        fn last_destination(&self) -> SocketAddr {
            self.sent.borrow().last().expect("a reply was sent").0
        }

        fn reply_count(&self) -> usize {
            self.sent.borrow().len()
        }

        fn events(&self) -> Vec<String> {
            self.events.lock().unwrap_or_else(PoisonError::into_inner).clone()
        }

        fn lease_events(&self) -> Vec<String> {
            self.events()
                .into_iter()
                .filter(|e| !e.starts_with("log "))
                .collect()
        }
    }

    fn discover(mac: &[u8]) -> Vec<u8> {
        PacketBuilder::new(mac).xid(0x1111).message_type(1).build()
    }

    fn request(mac: &[u8], requested: Option<Ipv4Addr>, server: Option<Ipv4Addr>) -> Vec<u8> {
        let mut builder = PacketBuilder::new(mac).xid(0x1111).message_type(3);
        if let Some(address) = requested {
            builder = builder.option(OPTION_REQUESTED_IP, &address.octets());
        }
        if let Some(address) = server {
            builder = builder.option(OPTION_SERVER_ID, &address.octets());
        }
        builder.build()
    }

    // -- DORA ----------------------------------------------------------------

    #[test]
    fn a_discover_is_answered_with_an_offer_from_the_bottom_of_the_pool() {
        let mut h = Harness::new();
        h.feed(&discover(&MAC_A));
        let reply = h.last_reply();
        assert_eq!(reply.options.message_type(), Some(MessageType::Offer));
        assert_eq!(reply.yiaddr, ip("10.0.0.10"));
        assert_eq!(reply.options.ipv4(OPTION_SERVER_ID), Some(ip("10.0.0.1")));
        assert_eq!(reply.options.u32(OPTION_LEASE_TIME), Some(3600));
        assert_eq!(reply.options.ipv4(OPTION_SUBNET_MASK), Some(ip("255.255.255.0")));
        assert_eq!(reply.options.ipv4(OPTION_ROUTER), Some(ip("10.0.0.1")));
        assert_eq!(reply.options.ipv4_list(OPTION_DNS), vec![ip("10.0.0.1")]);
        assert_eq!(reply.xid, 0x1111, "the transaction id must be echoed");
    }

    #[test]
    fn a_full_dora_exchange_binds_the_lease() {
        let mut h = Harness::new();
        h.feed(&discover(&MAC_A));
        h.feed(&request(&MAC_A, Some(ip("10.0.0.10")), Some(ip("10.0.0.1"))));
        let reply = h.last_reply();
        assert_eq!(reply.options.message_type(), Some(MessageType::Ack));
        assert_eq!(reply.yiaddr, ip("10.0.0.10"));

        let leases = h.core.active_leases();
        assert_eq!(leases.len(), 1);
        assert_eq!(leases[0].ip, ip("10.0.0.10"));
        assert_eq!(leases[0].lease_type, LeaseType::Dynamic);
        assert!(h.lease_events().iter().any(|e| e.starts_with("bound AA-00-00-00-00-01 10.0.0.10")));
    }

    #[test]
    fn offers_and_acks_carry_the_configured_server_identifier_in_siaddr() {
        let mut o = options();
        o.server_id = ip("10.0.0.77");
        let mut h = Harness::with(&o);

        h.feed(&discover(&MAC_A));
        assert_eq!(h.last_reply().siaddr, ip("10.0.0.77"));

        h.feed(&request(&MAC_A, Some(ip("10.0.0.10")), Some(ip("10.0.0.77"))));
        let reply = h.last_reply();
        assert_eq!(reply.options.message_type(), Some(MessageType::Ack));
        assert_eq!(reply.siaddr, ip("10.0.0.77"));
    }

    #[test]
    fn a_second_client_is_offered_a_different_address() {
        let mut h = Harness::new();
        h.feed(&discover(&MAC_A));
        h.feed(&request(&MAC_A, Some(ip("10.0.0.10")), Some(ip("10.0.0.1"))));
        h.feed(&discover(&MAC_B));
        assert_eq!(h.last_reply().yiaddr, ip("10.0.0.11"));
    }

    #[test]
    fn a_request_for_an_address_the_server_would_not_assign_is_naked() {
        // Silence makes the client retry the same doomed request until it times
        // out; a NAK makes it restart discovery at once.
        let mut h = Harness::new();
        h.feed(&discover(&MAC_A));
        h.feed(&request(&MAC_A, Some(ip("10.0.0.10")), Some(ip("10.0.0.1"))));
        h.feed(&request(&MAC_B, Some(ip("10.0.0.10")), Some(ip("10.0.0.1"))));
        let reply = h.last_reply();
        assert_eq!(reply.options.message_type(), Some(MessageType::Nak));
        assert_eq!(reply.yiaddr, Ipv4Addr::UNSPECIFIED, "a NAK grants nothing");
        assert!(reply.options.text(OPTION_MESSAGE).is_some(), "and says why");
        assert_eq!(h.core.counters().nak_count, 1);
    }

    #[test]
    fn a_request_naming_another_server_frees_our_offer() {
        // RFC 2131 §3.1: the client chose somebody else. Holding the address
        // anyway costs a pool slot for a full offer window for nothing.
        let mut h = Harness::new();
        h.feed(&discover(&MAC_A));
        assert_eq!(h.core.active_leases().len(), 1);
        h.feed(&request(&MAC_A, Some(ip("10.0.0.10")), Some(ip("10.0.0.77")))); // another server
        assert!(h.core.active_leases().is_empty());
        assert_eq!(
            h.reply_count(),
            1,
            "we must not answer a request addressed to another server"
        );
    }

    #[test]
    fn a_renewal_keeps_the_address_and_reports_itself_as_a_renewal() {
        let mut h = Harness::new();
        h.feed(&discover(&MAC_A));
        h.feed(&request(&MAC_A, Some(ip("10.0.0.10")), Some(ip("10.0.0.1"))));
        h.feed(&request(&MAC_A, Some(ip("10.0.0.10")), Some(ip("10.0.0.1"))));
        let events = h.lease_events();
        assert!(events.iter().any(|e| e.starts_with("bound ")));
        assert!(events.iter().any(|e| e.starts_with("renewed ")));
        assert_eq!(h.core.active_leases().len(), 1);
    }

    #[test]
    fn a_release_hands_the_address_back_and_names_it() {
        // The reference could not see the library's table and so reported every
        // release with a null address.
        let mut h = Harness::new();
        h.feed(&discover(&MAC_A));
        h.feed(&request(&MAC_A, Some(ip("10.0.0.10")), Some(ip("10.0.0.1"))));
        let release = PacketBuilder::new(&MAC_A)
            .message_type(7)
            .ciaddr(ip("10.0.0.10"))
            .option(OPTION_SERVER_ID, &ip("10.0.0.1").octets())
            .build();
        h.feed(&release);
        assert!(h.core.active_leases().is_empty());
        assert!(h
            .lease_events()
            .iter()
            .any(|e| e == "released AA-00-00-00-00-01 10.0.0.10 released"));
    }

    #[test]
    fn a_release_without_this_server_and_bound_address_is_ignored() {
        let mut h = Harness::new();
        h.feed(&discover(&MAC_A));
        h.feed(&request(&MAC_A, Some(ip("10.0.0.10")), Some(ip("10.0.0.1"))));

        for release in [
            PacketBuilder::new(&MAC_A).message_type(7).ciaddr(ip("10.0.0.10")).build(),
            PacketBuilder::new(&MAC_A)
                .message_type(7)
                .ciaddr(ip("10.0.0.77"))
                .option(OPTION_SERVER_ID, &ip("10.0.0.1").octets())
                .build(),
            PacketBuilder::new(&MAC_A)
                .message_type(7)
                .ciaddr(ip("10.0.0.10"))
                .option(OPTION_SERVER_ID, &ip("10.0.0.77").octets())
                .build(),
        ] {
            h.feed(&release);
            assert_eq!(h.core.active_leases().len(), 1, "release {release:?} must be ignored");
        }
        assert!(
            h.lease_events()
                .iter()
                .all(|event| !event.starts_with("released ")),
            "ignored release packets must not emit release events"
        );
    }

    #[test]
    fn a_decline_holds_the_contested_address_out_of_the_pool() {
        let mut h = Harness::new();
        h.feed(&discover(&MAC_A));
        h.feed(&request(&MAC_A, Some(ip("10.0.0.10")), Some(ip("10.0.0.1"))));
        let decline = PacketBuilder::new(&MAC_A)
            .message_type(4)
            .option(OPTION_REQUESTED_IP, &ip("10.0.0.10").octets())
            .option(OPTION_SERVER_ID, &ip("10.0.0.1").octets())
            .build();
        h.feed(&decline);
        h.feed(&discover(&MAC_B));
        assert_eq!(
            h.last_reply().yiaddr,
            ip("10.0.0.11"),
            "handing the contested address to the next client repeats the conflict"
        );
        assert_eq!(h.core.counters().decline_count, 1);
    }

    #[test]
    fn a_decline_without_this_server_and_matching_offer_is_ignored() {
        let mut h = Harness::new();
        h.feed(&discover(&MAC_A));
        h.feed(&request(&MAC_A, Some(ip("10.0.0.10")), Some(ip("10.0.0.1"))));

        for decline in [
            PacketBuilder::new(&MAC_A)
                .message_type(4)
                .option(OPTION_REQUESTED_IP, &ip("10.0.0.10").octets())
                .build(),
            PacketBuilder::new(&MAC_A)
                .message_type(4)
                .option(OPTION_REQUESTED_IP, &ip("10.0.0.10").octets())
                .option(OPTION_SERVER_ID, &ip("10.0.0.77").octets())
                .build(),
            PacketBuilder::new(&MAC_A)
                .message_type(4)
                .option(OPTION_REQUESTED_IP, &ip("10.0.0.11").octets())
                .option(OPTION_SERVER_ID, &ip("10.0.0.1").octets())
                .build(),
        ] {
            h.feed(&decline);
            assert_eq!(h.core.active_leases().len(), 1, "decline {decline:?} must be ignored");
        }

        let stray = PacketBuilder::new(&MAC_B)
            .message_type(4)
            .option(OPTION_REQUESTED_IP, &ip("10.0.0.11").octets())
            .option(OPTION_SERVER_ID, &ip("10.0.0.1").octets())
            .build();
        h.feed(&stray);
        h.feed(&discover(&MAC_B));
        assert_eq!(
            h.last_reply().yiaddr,
            ip("10.0.0.11"),
            "a client with no offer must not quarantine the address it names"
        );
        assert!(
            h.lease_events()
                .iter()
                .all(|event| !event.starts_with("declined ")),
            "ignored decline packets must not emit decline events"
        );
    }

    #[test]
    fn an_inform_is_answered_with_configuration_but_no_address_or_lease() {
        let mut h = Harness::new();
        let inform = PacketBuilder::new(&MAC_A)
            .message_type(8)
            .ciaddr(ip("10.0.0.55"))
            .build();
        h.feed(&inform);
        let reply = h.last_reply();
        assert_eq!(reply.options.message_type(), Some(MessageType::Ack));
        assert_eq!(reply.yiaddr, Ipv4Addr::UNSPECIFIED);
        assert_eq!(
            reply.options.u32(OPTION_LEASE_TIME),
            None,
            "RFC 2131 §4.3.5: an INFORM grants no lease"
        );
        assert_eq!(reply.options.ipv4(OPTION_SUBNET_MASK), Some(ip("255.255.255.0")));
        assert!(
            h.core.active_leases().is_empty(),
            "an INFORM must not consume a pool address"
        );
    }

    #[test]
    fn a_pool_with_nothing_left_answers_a_discover_with_silence_and_a_warning() {
        let mut o = options();
        o.range_end = ip("10.0.0.10"); // one address
        let mut h = Harness::with(&o);
        h.feed(&discover(&MAC_A));
        h.feed(&request(&MAC_A, Some(ip("10.0.0.10")), Some(ip("10.0.0.1"))));
        let before = h.reply_count();
        h.feed(&discover(&MAC_B));
        assert_eq!(h.reply_count(), before, "there is nothing to offer");
        assert!(h
            .events()
            .iter()
            .any(|e| e.contains("fully allocated")), "and the operator is told why");
    }

    // -- addressing ----------------------------------------------------------

    #[test]
    fn an_offer_to_a_client_with_no_address_is_broadcast() {
        let mut h = Harness::new();
        h.feed(&discover(&MAC_A));
        assert_eq!(h.last_destination(), SocketAddr::from(([10, 0, 0, 255], 68)));
    }

    #[test]
    fn a_renewal_from_a_client_that_has_an_address_is_answered_directly() {
        let mut h = Harness::new();
        h.feed(&discover(&MAC_A));
        h.feed(&request(&MAC_A, Some(ip("10.0.0.10")), Some(ip("10.0.0.1"))));
        let renew = PacketBuilder::new(&MAC_A)
            .message_type(3)
            .ciaddr(ip("10.0.0.10"))
            .option(OPTION_SERVER_ID, &ip("10.0.0.1").octets())
            .build();
        h.feed(&renew);
        assert_eq!(h.last_destination(), SocketAddr::from(([10, 0, 0, 10], 68)));
    }

    #[test]
    fn a_relayed_request_is_answered_through_the_relay_on_the_server_port() {
        let mut h = Harness::new();
        let mut packet = discover(&MAC_A);
        // giaddr sits at offset 24.
        packet[24..28].copy_from_slice(&ip("10.9.9.1").octets());
        h.feed(&packet);
        assert_eq!(h.last_destination(), SocketAddr::from(([10, 9, 9, 1], 67)));
    }

    #[test]
    fn a_nak_is_broadcast_even_to_a_client_that_has_an_address() {
        // RFC 2131 §4.3.2: the client's notion of its own address is exactly
        // what is being rejected, so it cannot be used to reach it.
        let mut h = Harness::new();
        h.feed(&discover(&MAC_A));
        h.feed(&request(&MAC_A, Some(ip("10.0.0.10")), Some(ip("10.0.0.1"))));
        let bad = PacketBuilder::new(&MAC_B)
            .message_type(3)
            .ciaddr(ip("10.0.0.10"))
            .option(OPTION_REQUESTED_IP, &ip("10.0.0.10").octets())
            .build();
        h.feed(&bad);
        assert_eq!(h.last_reply().options.message_type(), Some(MessageType::Nak));
        assert_eq!(h.last_destination(), SocketAddr::from(([10, 0, 0, 255], 68)));
    }

    // -- malformed input -----------------------------------------------------

    #[test]
    fn a_malformed_datagram_is_counted_and_dropped_without_a_reply() {
        let mut h = Harness::new();
        h.feed(&[0u8; 12]);
        h.feed(b"definitely not a dhcp packet");
        h.feed(&[]);
        assert_eq!(h.reply_count(), 0, "answering teaches a scanner we are here");
        assert_eq!(h.core.counters().malformed_count, 3);
        assert_eq!(h.core.counters().packets_received, 3);
    }

    #[test]
    fn a_truncated_option_is_refused_and_surfaced_rather_than_parsed_past() {
        let mut h = Harness::new();
        // A DISCOVER whose last option claims 40 bytes and supplies none.
        let packet = PacketBuilder::new(&MAC_A)
            .message_type(1)
            .raw_option_bytes(&[OPTION_PARAMETER_REQUEST_LIST, 40])
            .build();
        // The builder appends END and pads with zeros; trim to leave the lie bare.
        let cut = packet
            .iter()
            .rposition(|b| *b == OPTION_END)
            .expect("END is present");
        h.feed(&packet[..cut]);
        assert_eq!(h.reply_count(), 0, "a packet we could not parse is not answered");
        assert_eq!(h.core.counters().malformed_count, 1);
        assert!(
            h.events().iter().any(|e| e.contains("declaring 40 byte(s)")),
            "a length byte that overruns its buffer is worth naming: {:?}",
            h.events()
        );
    }

    #[test]
    fn a_flood_of_hostile_datagrams_never_panics_and_never_allocates_a_lease() {
        let mut h = Harness::new();
        let mut seed = 0xACE1_2345u32;
        for size in [0usize, 1, 47, 239, 240, 300, 1500, 4096] {
            for _ in 0..32 {
                let mut buf = vec![0u8; size];
                for byte in &mut buf {
                    seed ^= seed << 13;
                    seed ^= seed >> 17;
                    seed ^= seed << 5;
                    *byte = (seed & 0xFF) as u8;
                }
                h.feed(&buf);
            }
        }
        assert!(h.core.active_leases().is_empty());
    }

    #[test]
    fn a_server_message_from_another_dhcp_server_is_ignored() {
        let mut h = Harness::new();
        let mut packet = PacketBuilder::new(&MAC_A).message_type(2).build();
        packet[0] = 2; // BOOTREPLY
        h.feed(&packet);
        assert_eq!(h.reply_count(), 0);
        assert!(h.events().iter().any(|e| e.contains("another DHCP server")));
    }

    #[test]
    fn a_packet_with_no_message_type_is_ignored() {
        let mut h = Harness::new();
        h.feed(&PacketBuilder::new(&MAC_A).build());
        assert_eq!(h.reply_count(), 0);
    }

    // -- reservations --------------------------------------------------------

    #[test]
    fn a_reserved_device_gets_its_address_and_nobody_else_does() {
        let mut o = options();
        o.statics = crate::net::normalize_static_map([("aa:00:00:00:00:01", ip("10.0.0.10"))]);
        let mut h = Harness::with(&o);
        // Another client first — the reservation must already be held.
        h.feed(&discover(&MAC_B));
        assert_eq!(h.last_reply().yiaddr, ip("10.0.0.11"));
        h.feed(&discover(&MAC_A));
        assert_eq!(h.last_reply().yiaddr, ip("10.0.0.10"));
        h.feed(&request(&MAC_A, Some(ip("10.0.0.10")), Some(ip("10.0.0.1"))));
        let leases = h.core.active_leases();
        let reserved = leases
            .iter()
            .find(|l| l.mac.as_str() == "AA-00-00-00-00-01")
            .expect("the reserved device has a lease");
        assert_eq!(reserved.lease_type, LeaseType::Static);
    }

    #[test]
    fn an_out_of_pool_reservation_is_honoured() {
        // The reference silently ignores this case when the MAC is typed with
        // colons, which is how every vendor writes them.
        let mut o = options();
        o.statics = crate::net::normalize_static_map([("aa:00:00:00:00:01", ip("192.168.50.5"))]);
        let mut h = Harness::with(&o);
        h.feed(&discover(&MAC_A));
        assert_eq!(h.last_reply().yiaddr, ip("192.168.50.5"));
    }

    // -- boot options --------------------------------------------------------

    #[test]
    fn boot_options_ride_along_with_the_offer_and_the_ack() {
        let mut o = options();
        o.boot = BootOptions::new(
            Some("10.0.0.1".to_owned()),
            Some("ios-image.bin".to_owned()),
            vec![ip("10.0.0.1")],
            None,
            &[VendorEntry { sub_option: 1, value: "0xC0A80201".to_owned() }],
        )
        .unwrap();
        let mut h = Harness::with(&o);
        h.feed(&discover(&MAC_A));
        let offer = h.last_reply();
        assert_eq!(
            offer.options.text(crate::constants::OPTION_TFTP_SERVER_NAME).as_deref(),
            Some("10.0.0.1")
        );
        assert_eq!(
            offer.options.text(crate::constants::OPTION_BOOTFILE_NAME).as_deref(),
            Some("ios-image.bin")
        );
        assert_eq!(offer.options.ipv4_list(OPTION_CISCO_TFTP_SERVERS), vec![ip("10.0.0.1")]);
        assert_eq!(
            offer.options.get(crate::constants::OPTION_VENDOR_SPECIFIC),
            Some(&[0x01, 0x04, 0xc0, 0xa8, 0x02, 0x01][..])
        );

        h.feed(&request(&MAC_A, Some(ip("10.0.0.10")), Some(ip("10.0.0.1"))));
        assert_eq!(
            h.last_reply().options.text(crate::constants::OPTION_BOOTFILE_NAME).as_deref(),
            Some("ios-image.bin"),
            "the ACK carries them too — plenty of firmware reads them only there"
        );
    }

    #[test]
    fn the_vendor_class_gate_decides_who_gets_boot_options() {
        let mut o = options();
        o.boot = BootOptions::new(
            None,
            Some("ios-image.bin".to_owned()),
            Vec::new(),
            Some("Cisco".to_owned()),
            &[],
        )
        .unwrap();
        let mut h = Harness::with(&o);

        let matching = PacketBuilder::new(&MAC_A)
            .message_type(1)
            .option(OPTION_VENDOR_CLASS_ID, b"Cisco")
            .build();
        h.feed(&matching);
        assert!(h.last_reply().options.contains(crate::constants::OPTION_BOOTFILE_NAME));

        let other = PacketBuilder::new(&MAC_B)
            .message_type(1)
            .option(OPTION_VENDOR_CLASS_ID, b"Aruba")
            .build();
        h.feed(&other);
        let reply = h.last_reply();
        assert!(!reply.options.contains(crate::constants::OPTION_BOOTFILE_NAME));
        assert_eq!(reply.yiaddr, ip("10.0.0.11"), "but it still gets an address");
    }

    #[test]
    fn vendor_class_matching_uses_the_full_option_value_not_the_log_echo() {
        let vendor_class = "V".repeat(255);
        let mut o = options();
        o.boot = BootOptions::new(
            None,
            Some("ios-image.bin".to_owned()),
            Vec::new(),
            Some(vendor_class.clone()),
            &[],
        )
        .unwrap();
        let mut h = Harness::with(&o);

        let matching = PacketBuilder::new(&MAC_A)
            .message_type(1)
            .option(OPTION_VENDOR_CLASS_ID, vendor_class.as_bytes())
            .build();
        h.feed(&matching);
        assert!(
            h.last_reply().options.contains(crate::constants::OPTION_BOOTFILE_NAME),
            "a full-length accepted option 60 value must still pass the boot-option gate"
        );
    }

    // -- persistence ---------------------------------------------------------

    #[test]
    fn a_bound_lease_survives_a_restart_and_keeps_its_address_reserved() {
        // The scenario this whole subsystem exists for: a device takes a lease,
        // the daemon dies, and a second device asks for an address before the
        // first one's lease has expired.
        let dir = TempDir::new("dhcp-engine-restart");
        let path = dir.path().join("dhcp-leases.json");
        let mut o = options();
        o.lease_store_path = Some(path.clone());

        {
            let mut h = Harness::with(&o);
            h.feed(&discover(&MAC_A));
            h.feed(&request(&MAC_A, Some(ip("10.0.0.10")), Some(ip("10.0.0.1"))));
            h.core.shutdown();
        }

        let persisted = persistence::load_leases(&path);
        assert_eq!(persisted.len(), 1, "stopping must flush the lease table to disk");
        assert_eq!(persisted[0].ip, ip("10.0.0.10"));

        let mut restarted = Harness::with(&o);
        let restored = restarted.core.active_leases();
        assert_eq!(restored.len(), 1, "the restarted engine comes up knowing the lease");
        assert_eq!(restored[0].bound_at, persisted[0].bound_at, "the original bind time survives");

        restarted.feed(&discover(&MAC_B));
        assert_eq!(
            restarted.last_reply().yiaddr,
            ip("10.0.0.11"),
            "a restored lease must keep its address out of the free pool"
        );
        restarted.feed(&discover(&MAC_A));
        assert_eq!(
            restarted.last_reply().yiaddr,
            ip("10.0.0.10"),
            "and the original device is handed its own address back"
        );
    }

    #[test]
    fn an_expired_persisted_lease_is_not_a_claim_on_its_address() {
        let dir = TempDir::new("dhcp-engine-expired");
        let path = dir.path().join("dhcp-leases.json");
        let stale = LeaseInfo {
            mac: MacKey::from_hardware(&MAC_A),
            ip: ip("10.0.0.10"),
            bound_at: 1,
            lease_sec: 3600,
            expires_at: 2,
            remaining_sec: 0,
            hostname: None,
            lease_type: LeaseType::Dynamic,
        };
        persistence::save_leases(&path, &[stale]).unwrap();

        let mut o = options();
        o.lease_store_path = Some(path);
        let mut h = Harness::with(&o);
        assert!(h.core.active_leases().is_empty());
        h.feed(&discover(&MAC_B));
        assert_eq!(h.last_reply().yiaddr, ip("10.0.0.10"));
    }

    #[test]
    fn an_unclaimed_offer_never_reaches_the_lease_file() {
        // In the reference an OFFERED entry is persisted and comes back as a
        // BOUND lease, so a scanner that only ever sends DISCOVERs consumes the
        // pool permanently.
        let dir = TempDir::new("dhcp-engine-offer");
        let path = dir.path().join("dhcp-leases.json");
        let mut o = options();
        o.lease_store_path = Some(path.clone());
        let mut h = Harness::with(&o);
        for tail in 0..5u8 {
            h.feed(&discover(&[0xCC, 0, 0, 0, 0, tail]));
        }
        h.core.shutdown();
        assert!(
            persistence::load_leases(&path).is_empty(),
            "an offer is a promise, not a claim"
        );
    }

    #[test]
    fn a_failed_lease_write_is_retried_once_the_filesystem_recovers() {
        // Clearing the dirty marker before the write means a transient failure
        // is never retried: if no further lease mutation follows and the daemon
        // then dies, acknowledged leases are absent from disk and get handed to
        // somebody else after the restart.
        let dir = TempDir::new("dhcp-engine-persist-retry");
        // A regular file where the store directory belongs, so `create_dir_all`
        // fails the way an unavailable directory would.
        let blocker = dir.path().join("store");
        std::fs::write(&blocker, b"not a directory").unwrap();
        let path = blocker.join("dhcp-leases.json");
        let mut o = options();
        o.lease_store_path = Some(path.clone());
        o.persist_debounce = Duration::ZERO;

        let mut h = Harness::with(&o);
        h.feed(&discover(&MAC_A));
        h.feed(&request(&MAC_A, Some(ip("10.0.0.10")), Some(ip("10.0.0.1"))));
        h.core.tick();
        assert!(
            persistence::load_leases(&path).is_empty(),
            "the obstructed write cannot have produced a file"
        );

        // The obstruction clears. No lease changes hands, so nothing marks the
        // table dirty again — only the retained marker can bring the write back.
        std::fs::remove_file(&blocker).unwrap();
        h.core.tick();

        assert_eq!(
            persistence::load_leases(&path).len(),
            1,
            "a failed write must leave the table dirty so a later tick retries it"
        );
    }

    #[test]
    fn a_persistently_unwritable_store_warns_once_not_on_every_tick() {
        // Retrying a failed write is right, but the debounce is 500ms, so a path
        // that never becomes writable would otherwise put two warnings a second
        // into the operator's log forever — burying whatever else is in it.
        // Retry quietly; say something again only when the situation changes.
        let dir = TempDir::new("dhcp-engine-persist-noise");
        let blocker = dir.path().join("store");
        std::fs::write(&blocker, b"not a directory").unwrap();
        let mut o = options();
        o.lease_store_path = Some(blocker.join("dhcp-leases.json"));
        o.persist_debounce = Duration::ZERO;

        let mut h = Harness::with(&o);
        h.feed(&discover(&MAC_A));
        h.feed(&request(&MAC_A, Some(ip("10.0.0.10")), Some(ip("10.0.0.1"))));
        for _ in 0..20 {
            h.core.tick();
        }

        let warnings = h
            .events
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .iter()
            .filter(|line| line.contains("could not persist the lease table"))
            .count();
        assert_eq!(
            warnings, 1,
            "a stuck lease store must be reported once, not on every retry"
        );
    }

    #[test]
    fn a_recovered_lease_store_says_so_after_it_has_failed() {
        // The counterpart to reporting once: having gone quiet, the engine still
        // has to tell the operator when the problem is over, or a warning with
        // no resolution is all they ever see.
        let dir = TempDir::new("dhcp-engine-persist-recovery");
        let blocker = dir.path().join("store");
        std::fs::write(&blocker, b"not a directory").unwrap();
        let path = blocker.join("dhcp-leases.json");
        let mut o = options();
        o.lease_store_path = Some(path.clone());
        o.persist_debounce = Duration::ZERO;

        let mut h = Harness::with(&o);
        h.feed(&discover(&MAC_A));
        h.feed(&request(&MAC_A, Some(ip("10.0.0.10")), Some(ip("10.0.0.1"))));
        h.core.tick();
        std::fs::remove_file(&blocker).unwrap();
        h.core.tick();

        assert_eq!(persistence::load_leases(&path).len(), 1);
        let recovered = h
            .events
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .iter()
            .any(|line| line.contains("lease table persisted again"));
        assert!(recovered, "recovery from a reported failure must be reported too");
    }

    #[test]
    fn no_lease_file_is_written_when_persistence_is_switched_off() {
        let dir = TempDir::new("dhcp-engine-nostore");
        let mut h = Harness::new(); // lease_store_path is None
        h.feed(&discover(&MAC_A));
        h.feed(&request(&MAC_A, Some(ip("10.0.0.10")), Some(ip("10.0.0.1"))));
        h.core.shutdown();
        assert_eq!(fs_entry_count(dir.path()), 0);
    }

    fn fs_entry_count(path: &std::path::Path) -> usize {
        std::fs::read_dir(path).map_or(0, Iterator::count)
    }

    // -- lifecycle -----------------------------------------------------------

    #[test]
    fn an_empty_pool_is_refused_before_any_socket_is_bound() {
        // A service that binds and then answers nothing reads as "DHCP is
        // broken" with no diagnosis anywhere.
        let mut o = options();
        o.range_start = ip("10.0.0.20");
        o.range_end = ip("10.0.0.10");
        o.port = 0;
        o.address = IpAddr::V4(Ipv4Addr::LOCALHOST);
        let error = Engine::start(&o, Box::new(|_| {})).expect_err("an empty pool cannot serve");
        assert!(matches!(error, StartError::Configuration(_)), "got {error:?}");
        assert!(error.to_string().contains("empty"));
    }

    #[test]
    fn configuration_is_checked_before_the_socket_is_touched() {
        // Asking for a port somebody else already holds *and* an empty pool.
        // Which error comes back says which check ran first: a configuration
        // error means the pool was judged before anything was bound, and a bind
        // error means a socket was reached for while the configuration was
        // already known to be unservable.
        let held = UdpSocket::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let port = held.local_addr().unwrap().port();
        let mut o = options();
        o.range_start = ip("10.0.0.20");
        o.range_end = ip("10.0.0.10");
        o.port = port;
        o.address = IpAddr::V4(Ipv4Addr::LOCALHOST);

        let error = Engine::start(&o, Box::new(|_| {})).expect_err("neither half can work");
        assert!(
            matches!(error, StartError::Configuration(_)),
            "the pool must be judged before a socket is reached for; got {error:?}"
        );
    }

    #[test]
    fn a_real_socket_binds_serves_and_is_released_on_stop() {
        let mut o = options();
        o.port = 0;
        o.address = IpAddr::V4(Ipv4Addr::LOCALHOST);
        o.broadcast = Ipv4Addr::LOCALHOST;
        let mut engine = Engine::start(&o, Box::new(|_| {})).expect("binds an ephemeral port");
        let port = engine.bound_port();
        assert_ne!(port, 0);

        let client = UdpSocket::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        client
            .send_to(&discover(&MAC_A), (Ipv4Addr::LOCALHOST, port))
            .unwrap();

        // The snapshot round-trips through the engine thread, which also proves
        // the loop is alive and processing.
        let deadline = Instant::now() + Duration::from_secs(5);
        let mut leases = Vec::new();
        while Instant::now() < deadline {
            if let Some(runtime) = engine.runtime() {
                if !runtime.leases.is_empty() {
                    leases = runtime.leases;
                    break;
                }
            }
            thread::sleep(Duration::from_millis(20));
        }
        assert_eq!(leases.len(), 1, "the engine thread must have offered an address");
        assert_eq!(leases[0].ip, ip("10.0.0.10"));

        engine.stop();
        assert!(
            UdpSocket::bind((Ipv4Addr::LOCALHOST, port)).is_ok(),
            "the port was still held after stop"
        );
    }

    #[test]
    fn stopping_twice_is_safe() {
        let mut o = options();
        o.port = 0;
        o.address = IpAddr::V4(Ipv4Addr::LOCALHOST);
        let mut engine = Engine::start(&o, Box::new(|_| {})).unwrap();
        engine.stop();
        engine.stop();
        assert!(engine.runtime().is_none(), "the loop is gone");
    }

    // -- counters ------------------------------------------------------------

    #[test]
    fn the_counters_the_host_renders_actually_move() {
        // In the reference, offer/ack/nak counted *received* option 53 values,
        // which for three server-to-client message types is always zero.
        let mut h = Harness::new();
        h.feed(&discover(&MAC_A));
        h.feed(&request(&MAC_A, Some(ip("10.0.0.10")), Some(ip("10.0.0.1"))));
        h.feed(&request(&MAC_B, Some(ip("10.0.0.10")), Some(ip("10.0.0.1"))));
        let c = h.core.counters();
        assert_eq!(c.discover_count, 1);
        assert_eq!(c.request_count, 2);
        assert_eq!(c.offer_count, 1, "an OFFER we sent must be counted");
        assert_eq!(c.ack_count, 1, "an ACK we sent must be counted");
        assert_eq!(c.nak_count, 1, "a NAK we sent must be counted");
        assert_eq!(c.packets_received, 3);
        assert_eq!(c.packets_sent, 3);
    }

    #[test]
    fn an_option_region_we_build_is_one_our_own_parser_accepts() {
        // Encoder and decoder are written against the RFC independently; this is
        // the seam where a disagreement between them would show up.
        let mut h = Harness::new();
        h.feed(&discover(&MAC_A));
        let sent = h.sent.borrow();
        let (_, bytes) = sent.last().unwrap();
        let mut parsed = Options::new();
        let mut reader = crate::protocol::Reader::new(&bytes[240..]);
        crate::protocol::parse_options(&mut reader, &mut parsed).expect("our own options parse");
        assert_eq!(parsed.message_type(), Some(MessageType::Offer));
    }
}
