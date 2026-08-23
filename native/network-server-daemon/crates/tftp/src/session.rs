//! The per-transfer state machine.
//!
//! Deliberately free of I/O beyond the single file it reads for an RRQ: the
//! socket lives in [`crate::engine`]. That split is what makes the whole
//! protocol — option negotiation, windowing, retransmission, the block-number
//! wrap — testable without a socket, a timer, or a peer.

use crate::protocol::{
    encode_ack, encode_data, encode_error, encode_oack, validate_options, validated_to_raw,
    ProtocolError,
};
use crate::types::{ErrorCode, RawOptions, ValidatedOptions, BLOCK_SPACE};
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::net::SocketAddr;
use std::path::PathBuf;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

/// Default network timeout. RFC 2349 lets a client negotiate this.
pub const DEFAULT_TIMEOUT: Duration = Duration::from_secs(5);

/// Retransmission attempts before a session is declared dead.
pub const DEFAULT_MAX_RETRIES: u32 = 5;

/// Ceiling on the exponential retransmission backoff.
const MAX_BACKOFF: Duration = Duration::from_secs(60);

/// EWMA smoothing factor for the speed estimate.
const EWMA_ALPHA: f64 = 0.25;

/// Minimum interval between speed samples, so a burst of small blocks does not
/// produce a meaningless instantaneous rate.
const METRICS_SAMPLE_INTERVAL: Duration = Duration::from_millis(200);

/// Forward distance from `from` to `to` in the 16-bit block-number space.
///
/// Block numbers are 16 bits on the wire and wrap 65535 → 0, so plain `<` /
/// `>=` comparisons are wrong the moment a transfer
/// passes 65535 blocks — 32 MB at the default block size, which is one PXE
/// image at any realistic size. Past the wrap the sender's numbers restart while
/// `last_acked` is still up at 65535: every subsequent ACK reads as "older than
/// what we already have", the window never advances, no more DATA is produced,
/// and the transfer stalls with no error on either side.
///
/// The distance is computed modulo 65536, directly matching the wire
/// representation.
#[must_use]
pub fn block_distance(from: u16, to: u16) -> u32 {
    u32::from(to.wrapping_sub(from))
}

/// True when `later` is at or ahead of `earlier` — the wrap-safe replacement
/// for `later >= earlier`.
///
/// "Ahead" is the near half of the space: an ACK more than 32768 blocks forward
/// is read as a stale duplicate lagging behind, which is what it always is in
/// practice, the window being bounded far below that.
#[must_use]
pub fn block_at_or_after(earlier: u16, later: u16) -> bool {
    block_distance(earlier, later) < BLOCK_SPACE / 2
}

/// The block after `block`, wrapping 65535 → 0.
#[must_use]
pub fn next_block(block: u16) -> u16 {
    block.wrapping_add(1)
}

/// Which way the bytes flow, named from the client's point of view — the one an
/// operator watching a device boot is thinking in.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Direction {
    /// RRQ: the client is downloading from this server.
    Read,
    /// WRQ: the client is uploading to this server.
    Write,
}

impl Direction {
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Read => "rrq",
            Self::Write => "wrq",
        }
    }
}

/// Phases of the transfer state machine.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Phase {
    /// Constructed, not yet initialised.
    Idle,
    /// OACK sent; awaiting the peer's acknowledgement of the negotiated options.
    SendOack,
    /// RRQ in progress, DATA going out.
    Sending,
    /// Last DATA sent (shorter than `blksize`); awaiting the final ACK.
    SentLast,
    /// WRQ without options: ACK(0) sent, awaiting DATA(1).
    RecvInitialAck,
    /// WRQ in progress, DATA coming in.
    Receiving,
    /// Terminal failure.
    Error,
    /// Terminal success.
    Done,
}

impl Phase {
    #[must_use]
    pub fn is_terminal(self) -> bool {
        matches!(self, Self::Error | Self::Done)
    }
}

/// Everything the engine knows when it admits a request.
#[derive(Debug, Clone)]
pub struct TransferInit {
    pub peer: SocketAddr,
    pub direction: Direction,
    pub filename: String,
    pub abs_path: PathBuf,
    pub raw_options: RawOptions,
}

/// One packet held for possible retransmission.
#[derive(Debug, Clone)]
struct Outbound {
    /// `None` for a packet that carries no block number — in practice the OACK.
    block: Option<u16>,
    bytes: Vec<u8>,
}

/// What the caller should do after feeding an ACK to the machine.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct AckOutcome {
    /// The window has room; call [`TransferSession::produce_next_send_packets`].
    pub produce_more: bool,
    /// The transfer finished successfully.
    pub done: bool,
}

/// What the caller should do after feeding a DATA packet to the machine.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct DataOutcome {
    /// Packets to put on the wire, in order.
    pub send: Vec<Vec<u8>>,
    /// Payload to append to the destination file, if any.
    pub write: Option<Vec<u8>>,
    /// The transfer reached a terminal state (successfully or not).
    pub done: bool,
}

/// Real-time metrics for the UI.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Metrics {
    pub speed_bps: f64,
    pub eta_sec: Option<f64>,
    pub started_at_epoch_ms: u64,
}

/// The state machine for one client:server pair.
#[derive(Debug)]
pub struct TransferSession {
    pub peer: SocketAddr,
    pub direction: Direction,
    pub filename: String,
    pub abs_path: PathBuf,

    pub opts: ValidatedOptions,
    pub phase: Phase,
    error: Option<(ErrorCode, String)>,

    /// Next block number to send (RRQ) or expect (WRQ).
    pub block: u16,
    /// Highest block the peer has confirmed, in wrap-safe terms.
    pub last_acked: u16,
    /// First block covered by the cumulative ACK at [`Self::last_acked`], i.e.
    /// the start of the window that ACK closed. A WRQ that ends mid-window
    /// closes a window shorter than `windowsize`, so the negotiated size alone
    /// does not say which blocks the final ACK stood for.
    pub acked_window_start: u16,
    pub file_size: u64,
    /// Bytes moved so far, including not-yet-acknowledged in-flight data.
    pub bytes_transferred: u64,
    pub tsize_at_start: Option<u64>,

    last_activity: Instant,
    pub retries: u32,
    pub max_retries: u32,
    timeout: Duration,
    retx_backoff: Duration,

    outbound: Vec<Outbound>,
    outbound_sent_last: Instant,

    file: Option<File>,
    file_offset: u64,

    started_at: Instant,
    started_at_epoch_ms: u64,
    speed_bps: f64,
    last_metrics_sample: Instant,
}

impl TransferSession {
    /// Builds a session from an admitted request, validating its options.
    ///
    /// A negotiation failure is not returned as an `Err`: the session is
    /// constructed in [`Phase::Error`] carrying ERROR(8), because the caller
    /// still needs a session object to serialise that packet from and to attach
    /// the peer address to. [`TransferSession::phase`] must be checked before
    /// the session is registered.
    #[must_use]
    pub fn new(init: TransferInit) -> Self {
        let now = Instant::now();
        let mut session = Self {
            peer: init.peer,
            direction: init.direction,
            filename: init.filename,
            abs_path: init.abs_path,
            opts: ValidatedOptions::default(),
            phase: Phase::Idle,
            error: None,
            block: 0,
            last_acked: 0,
            acked_window_start: 1,
            file_size: 0,
            bytes_transferred: 0,
            tsize_at_start: None,
            last_activity: now,
            retries: 0,
            max_retries: DEFAULT_MAX_RETRIES,
            timeout: DEFAULT_TIMEOUT,
            retx_backoff: DEFAULT_TIMEOUT,
            outbound: Vec::new(),
            outbound_sent_last: now,
            file: None,
            file_offset: 0,
            started_at: now,
            started_at_epoch_ms: epoch_millis(),
            speed_bps: 0.0,
            last_metrics_sample: now,
        };
        match validate_options(&init.raw_options, ValidatedOptions::default()) {
            Ok(opts) => session.opts = opts,
            Err(ProtocolError(message)) => {
                session.set_error(ErrorCode::OptionNegotiation, message);
            }
        }
        if let Some(seconds) = session.opts.timeout {
            session.timeout = Duration::from_secs(u64::from(seconds));
        }
        session.retx_backoff = session.timeout;
        session
    }

    /// `address:port` of the peer — the TFTP transfer id (TID).
    ///
    /// RFC 1350 §4 makes the source port the connection identity, so this is
    /// both the map key and the value the operator cancels by.
    #[must_use]
    pub fn transfer_id(&self) -> String {
        self.peer.to_string()
    }

    #[must_use]
    pub fn error(&self) -> Option<(ErrorCode, &str)> {
        self.error.as_ref().map(|(c, m)| (*c, m.as_str()))
    }

    /// The peer's negotiated retry interval.
    #[must_use]
    pub fn retry_interval(&self) -> Duration {
        self.timeout
    }

    /// Moves the session to a terminal failure the caller will serialise.
    pub fn set_error(&mut self, code: ErrorCode, message: impl Into<String>) {
        self.phase = Phase::Error;
        self.error = Some((code, message.into()));
    }

    /// The ERROR packet for the current failure.
    #[must_use]
    pub fn error_packet(&self) -> Vec<u8> {
        match &self.error {
            Some((code, message)) => encode_error(*code, Some(message)),
            None => encode_error(ErrorCode::NotDefined, None),
        }
    }

    /// Records peer activity: refreshes the deadline and resets the backoff.
    fn touch(&mut self) {
        self.last_activity = Instant::now();
        self.retx_backoff = self.timeout;
    }

    /// True when the peer has gone quiet for longer than the retransmission
    /// schedule could account for.
    ///
    /// `timeout * (retries + 1)` leaves room for every scheduled retransmission
    /// to have been tried before the peer is declared dead. The clock is
    /// [`Instant`] — monotonic — so a wall-clock adjustment cannot make a live
    /// transfer look abandoned or an abandoned one look live.
    #[must_use]
    pub fn is_timed_out(&self) -> bool {
        self.last_activity.elapsed() > self.timeout * (self.retries + 1)
    }

    /// Registers packets for possible retransmission.
    ///
    /// MUST be called **before** the packets are handed to the socket. With the
    /// order reversed, a garbage-collection tick landing between the send and
    /// the record finds an empty queue and aborts a session that is perfectly
    /// healthy.
    pub fn record_outbound(&mut self, packets: &[Vec<u8>]) {
        for packet in packets {
            let block = match packet.as_slice() {
                // DATA and ACK carry a block number in bytes 2..4; the OACK does
                // not, and is the only unnumbered packet ever queued here.
                [0, 3 | 4, hi, lo, ..] => Some(u16::from_be_bytes([*hi, *lo])),
                _ => None,
            };
            self.outbound.push(Outbound {
                block,
                bytes: packet.clone(),
            });
        }
        self.outbound_sent_last = Instant::now();
        // The queue holds at most one window plus the OACK once draining works,
        // and the window itself is bounded by the in-flight byte budget. The cap
        // is a backstop against a peer that never acknowledges anything, so its
        // memory is bounded by that same budget rather than by the transfer.
        let cap = self.opts.windowsize as usize + 8;
        if self.outbound.len() > cap {
            let excess = self.outbound.len() - cap;
            self.outbound.drain(..excess);
        }
    }

    /// Drops every packet the peer has now confirmed.
    ///
    /// Two things here are easy to get wrong and both were:
    ///
    /// * The comparison must be wrap-safe. `block <= ack` stops dead at the
    ///   wrap: a queue holding 65534, 65535, 0, 1 confirmed by ACK(1) drains
    ///   nothing, and the session then retransmits blocks the peer already has
    ///   until the cap silently discards them.
    /// * An unnumbered packet — the OACK — must be *droppable*. Treating it as
    ///   unconfirmable leaves it stuck at the head of the queue, and since the
    ///   drain stops at the first unconfirmed entry, nothing behind it ever
    ///   leaves either: the queue fills to its cap and every retransmission
    ///   re-sends a whole window of blocks the peer already has. Any incoming
    ///   ACK confirms it, because the OACK is the only thing that can have been
    ///   outstanding when the first ACK arrives.
    pub fn clear_outbound_up_to(&mut self, ack: u16) {
        let mut confirmed = 0usize;
        for entry in &self.outbound {
            let is_confirmed = match entry.block {
                None => true,
                Some(block) => block_at_or_after(block, ack),
            };
            if is_confirmed {
                confirmed += 1;
            } else {
                break;
            }
        }
        if confirmed > 0 {
            self.outbound.drain(..confirmed);
        }
        self.retx_backoff = self.timeout;
    }

    /// True when the retransmission timer has expired for the current window.
    #[must_use]
    pub fn time_for_retransmission(&self) -> bool {
        !self.outbound.is_empty() && self.outbound_sent_last.elapsed() >= self.retx_backoff
    }

    /// Takes the current window for retransmission, or `None` once the attempt
    /// budget is spent (in which case the session is left in [`Phase::Error`]).
    pub fn consume_retransmission(&mut self) -> Option<Vec<Vec<u8>>> {
        if self.outbound.is_empty() {
            return None;
        }
        self.retries += 1;
        if self.retries > self.max_retries {
            self.set_error(ErrorCode::NotDefined, "Max retries exceeded");
            return None;
        }
        self.retx_backoff = (self.retx_backoff * 2).min(MAX_BACKOFF);
        let now = Instant::now();
        self.outbound_sent_last = now;
        self.last_activity = now;
        Some(self.outbound.iter().map(|o| o.bytes.clone()).collect())
    }

    /// Initialises an RRQ. Returns the OACK, when options were negotiated.
    pub fn init_for_read(&mut self, file_size: u64) -> Vec<Vec<u8>> {
        self.file_size = file_size;
        self.bytes_transferred = 0;
        self.block = 0;
        self.last_acked = 0;
        self.acked_window_start = 1;
        self.file_offset = 0;
        // RFC 2349 §3: a client asking `tsize` with the value 0 on a read is
        // asking the server to fill it in.
        if self.opts.tsize == Some(0) {
            self.opts.tsize = Some(file_size);
        }
        self.tsize_at_start = Some(file_size);
        let raw = validated_to_raw(&self.opts);
        if raw.is_empty() {
            self.phase = Phase::Sending;
            Vec::new()
        } else {
            self.phase = Phase::SendOack;
            vec![encode_oack(&raw)]
        }
    }

    /// Initialises a WRQ. Returns either the OACK or the opening ACK(0).
    pub fn init_for_write(&mut self) -> Vec<Vec<u8>> {
        self.bytes_transferred = 0;
        self.block = 1;
        self.last_acked = 0;
        self.acked_window_start = 1;
        // Captured here so an upload can show a progress bar and an ETA. It is
        // the only size information a WRQ ever carries.
        self.tsize_at_start = self.opts.tsize;
        let raw = validated_to_raw(&self.opts);
        if raw.is_empty() {
            self.phase = Phase::RecvInitialAck;
            vec![encode_ack(0)]
        } else {
            self.phase = Phase::SendOack;
            vec![encode_oack(&raw)]
        }
    }

    /// True when `ack` names a block this session has actually put on the wire.
    ///
    /// [`Self::block`] is the highest block emitted and [`Self::last_acked`] the
    /// highest already confirmed, so anything outside `[last_acked, block]` is
    /// either a stale duplicate or an invention. Both comparisons are wrap-safe
    /// for the reason given on [`block_at_or_after`].
    fn ack_is_for_sent_data(&self, ack: u16) -> bool {
        match self.phase {
            // The OACK is the only thing outstanding, and RFC 2347 has the peer
            // confirm it with ACK(0).
            Phase::SendOack => ack == 0,
            Phase::Sending | Phase::SentLast => {
                // Strictly ahead of `last_acked`: an ACK equal to it confirms
                // nothing that was not already confirmed, so it clears nothing
                // and advances nothing — and must not refresh the session
                // either, or repeating one stale ACK keeps a stalled transfer
                // alive for as long as the peer cares to send it.
                ack != self.last_acked
                    && block_at_or_after(self.last_acked, ack)
                    && block_at_or_after(ack, self.block)
            }
            // Nothing of ours is outstanding in any other phase — a WRQ peer
            // sends DATA, not ACKs — so an ACK there is noise, and noise must
            // not be able to keep a session alive.
            _ => false,
        }
    }

    /// Feeds an ACK received from the peer to the machine.
    pub fn handle_ack(&mut self, ack: u16) -> AckOutcome {
        // An ACK for a block that was never sent proves nothing, so it may not
        // reach any of the state below. Acted on, it cleared the retransmission
        // queue, advanced the window past data the peer has not seen, and — via
        // the activity touch and retry reset — let a peer hold a stalled
        // transfer open indefinitely by repeating it, occupying one of a
        // bounded number of slots without ever moving a byte.
        if !self.ack_is_for_sent_data(ack) {
            return AckOutcome::default();
        }
        self.touch();
        self.retries = 0;
        if matches!(
            self.phase,
            Phase::SendOack | Phase::SentLast | Phase::Sending
        ) {
            self.clear_outbound_up_to(ack);
        }

        match self.phase {
            Phase::SentLast => {
                // Only the final DATA block proves the client received the
                // file. In an option-negotiated one-block RRQ, ACK(0) confirms
                // only the OACK; accepting it here would complete the transfer
                // even if DATA(1) was lost.
                if ack == self.block {
                    self.phase = Phase::Done;
                    return AckOutcome {
                        produce_more: false,
                        done: true,
                    };
                }
                AckOutcome::default()
            }
            Phase::SendOack => {
                if ack != 0 {
                    return AckOutcome::default();
                }
                match self.direction {
                    Direction::Read => {
                        self.phase = Phase::Sending;
                        AckOutcome {
                            produce_more: true,
                            done: false,
                        }
                    }
                    // RFC 2347 has a WRQ client answer an OACK with DATA(1), not
                    // with ACK(0) — see `handle_data`. Some clients send the ACK
                    // anyway, so both are accepted.
                    Direction::Write => {
                        self.phase = Phase::Receiving;
                        AckOutcome::default()
                    }
                }
            }
            Phase::Sending => {
                // Wrap-safe form of `ack < last_acked`. Past block 65535 the
                // peer's ACKs restart at 0 while `last_acked` is still 65535,
                // and a numeric compare discards every one of them: the window
                // never advances, no more DATA is produced, and the transfer
                // stalls silently.
                if !block_at_or_after(self.last_acked, ack) {
                    return AckOutcome::default();
                }
                self.last_acked = ack;
                AckOutcome {
                    produce_more: block_distance(self.last_acked, self.block)
                        < self.opts.windowsize,
                    done: false,
                }
            }
            _ => AckOutcome::default(),
        }
    }

    /// Feeds a DATA packet received from the peer to the machine.
    pub fn handle_data(&mut self, block: u16, data: &[u8]) -> DataOutcome {
        // RFC 2347: after an OACK on a *write*, the client begins the transfer
        // with DATA(1) rather than acknowledging the OACK. Refusing to leave
        // `SendOack` until an ACK arrives drops that DATA on the floor, and the
        // client retransmits it until it gives up — a standards-conforming
        // upload with any negotiated option never completes.
        if matches!(self.phase, Phase::RecvInitialAck)
            || (matches!(self.phase, Phase::SendOack) && self.direction == Direction::Write)
        {
            // The OACK is now confirmed by the arrival of the first DATA.
            self.clear_outbound_up_to(0);
            self.phase = Phase::Receiving;
        }
        if self.phase != Phase::Receiving {
            // DATA in a phase that never expects it — an RRQ waiting for ACKs,
            // a transfer already finished — proves nothing about the peer, so it
            // may not refresh the activity clock or refill the retry budget.
            // Doing so let a peer hold a slot open for as long as it cared to
            // send noise, and the slots are a bounded resource.
            return DataOutcome::default();
        }
        self.touch();
        self.retries = 0;

        // The block before the expected one in the same 16-bit sequence space
        // used by the wire format. A duplicate DATA(0) after the wrap is
        // distinct from negotiation ACK(0): at this point the phase is
        // `Receiving`, so it is just another data block number.
        let previous = self.block.wrapping_sub(1);
        if block == previous {
            return DataOutcome {
                send: vec![encode_ack(previous)],
                write: None,
                done: false,
            };
        }
        // A window that was only *partly* received: everything strictly between
        // the last cumulative ACK and the block now expected is already on disk
        // but not yet acknowledged. When one DATA of a window goes missing, the
        // client retransmits from the first block it never saw acknowledged,
        // which lands in exactly this range — and matched neither duplicate case
        // below, so it fell through to the mismatch path, answered
        // IllegalOperation and deleted a healthy partial upload. One lost
        // datagram was enough to kill a windowed transfer.
        //
        // RFC 7440 §4: answer out-of-sequence DATA with the last block received
        // in sequence, so the client resumes from the right place rather than
        // guessing.
        let received_through = block_distance(self.last_acked, previous);
        let offset = block_distance(self.last_acked, block);
        if self.bytes_transferred > 0 && offset >= 1 && offset <= received_through {
            return DataOutcome {
                send: vec![encode_ack(previous)],
                write: None,
                done: false,
            };
        }
        // If the cumulative ACK for a full WRQ window is lost, clients commonly
        // retransmit the whole window. Those DATA blocks have already been
        // written, so repeating the cumulative ACK is the only safe response:
        // accepting them would duplicate file contents, and rejecting them would
        // abort an otherwise healthy upload.
        if self.bytes_transferred > 0
            && self.block == next_block(self.last_acked)
            && block_distance(block, self.last_acked) < self.opts.windowsize
        {
            return DataOutcome {
                send: vec![encode_ack(self.last_acked)],
                write: None,
                done: false,
            };
        }
        if block != self.block {
            self.set_error(
                ErrorCode::IllegalOperation,
                format!("Block {block} received, expected {}", self.block),
            );
            return DataOutcome {
                send: vec![self.error_packet()],
                write: None,
                done: true,
            };
        }
        if data.len() as u64 > u64::from(self.opts.blksize) {
            self.set_error(ErrorCode::IllegalOperation, "DATA exceeds negotiated blksize");
            return DataOutcome {
                send: vec![self.error_packet()],
                write: None,
                done: true,
            };
        }

        let is_last = (data.len() as u64) < u64::from(self.opts.blksize);
        let current = self.block;
        self.bytes_transferred += data.len() as u64;
        self.update_metrics(data.len() as u64);
        if !is_last {
            self.block = next_block(self.block);
        }
        // Same wrap hazard as the send side: `current >= last_acked + windowsize`
        // is never true again once the client's numbering restarts at 0, so the
        // server stops acknowledging entirely and the upload dies on the
        // client's retries.
        let should_ack =
            is_last || block_distance(self.last_acked, current) >= self.opts.windowsize;
        if should_ack {
            // Recorded before `last_acked` moves: the window this ACK closes
            // began at the block after the previous cumulative ACK.
            self.acked_window_start = next_block(self.last_acked);
            self.last_acked = current;
            if is_last {
                self.phase = Phase::Done;
            }
            self.clear_outbound_up_to(current);
            return DataOutcome {
                send: vec![encode_ack(current)],
                write: Some(data.to_vec()),
                done: is_last,
            };
        }
        DataOutcome {
            send: Vec::new(),
            write: Some(data.to_vec()),
            done: false,
        }
    }

    /// Fills the send window with DATA packets read from the source file.
    ///
    /// The loop bound is wrap-safe for the reason spelled out on
    /// [`block_distance`]: `self.block < self.last_acked + windowsize` stops
    /// bounding anything once the sender wraps past 65535, because the sum stays
    /// up near 65536 while `self.block` restarts at 0 — the loop would then run
    /// to EOF and push the entire remaining file into memory in one call.
    pub fn produce_next_send_packets(&mut self) -> std::io::Result<Vec<Vec<u8>>> {
        let mut out = Vec::new();
        let start_bytes = self.bytes_transferred;
        let blksize = self.opts.blksize as usize;
        while self.phase == Phase::Sending
            && block_distance(self.last_acked, self.block) < self.opts.windowsize
        {
            if self.file.is_none() {
                self.file = Some(File::open(&self.abs_path)?);
            }
            let file = self
                .file
                .as_mut()
                .expect("file handle was just opened above");
            let mut buffer = vec![0u8; blksize];
            // The read offset is tracked explicitly rather than relying on the
            // handle's implicit cursor: it is the only thing that stays correct
            // if the handle is ever shared, re-opened, or seeked by anything
            // else, and getting it wrong duplicates or drops half a file.
            let read = read_full_at(file, self.file_offset, &mut buffer)?;
            self.file_offset += read as u64;
            buffer.truncate(read);

            self.block = next_block(self.block);
            let is_last = read < blksize;
            if is_last {
                self.phase = Phase::SentLast;
            }
            self.bytes_transferred += read as u64;
            out.push(encode_data(self.block, &buffer));
        }
        let delta = self.bytes_transferred - start_bytes;
        if delta > 0 {
            self.update_metrics(delta);
        }
        Ok(out)
    }

    /// Releases the source file handle, if one was opened.
    pub fn close_file(&mut self) {
        self.file = None;
    }

    /// Current speed and ETA.
    #[must_use]
    pub fn metrics(&mut self) -> Metrics {
        // A zero-byte sample lets the estimate decay while nothing is moving,
        // so a stalled transfer does not keep reporting the rate it had before
        // it stalled.
        self.update_metrics(0);
        let remaining_over = |total: u64| {
            if self.speed_bps > 0.0 && total > 0 {
                Some(total.saturating_sub(self.bytes_transferred) as f64 / self.speed_bps)
            } else {
                None
            }
        };
        let eta_sec = match self.direction {
            Direction::Read => remaining_over(self.file_size),
            Direction::Write => self.tsize_at_start.and_then(remaining_over),
        };
        Metrics {
            speed_bps: self.speed_bps,
            eta_sec,
            started_at_epoch_ms: self.started_at_epoch_ms,
        }
    }

    /// Total size to report to the UI, or `None` when it is genuinely unknown.
    #[must_use]
    pub fn total_bytes(&self) -> Option<u64> {
        match self.direction {
            Direction::Read => Some(self.file_size),
            Direction::Write => self.tsize_at_start,
        }
    }

    /// Wall-clock start, for the UI's elapsed-time display.
    #[must_use]
    pub fn started_at_epoch_ms(&self) -> u64 {
        self.started_at_epoch_ms
    }

    /// Monotonic start, for measuring elapsed time.
    #[must_use]
    pub fn elapsed(&self) -> Duration {
        self.started_at.elapsed()
    }

    fn update_metrics(&mut self, delta_bytes: u64) {
        let elapsed = self.last_metrics_sample.elapsed();
        if elapsed < METRICS_SAMPLE_INTERVAL {
            return;
        }
        let instant = if delta_bytes > 0 {
            delta_bytes as f64 / elapsed.as_secs_f64().max(0.001)
        } else {
            0.0
        };
        self.speed_bps = if self.speed_bps == 0.0 {
            instant
        } else {
            EWMA_ALPHA * instant + (1.0 - EWMA_ALPHA) * self.speed_bps
        };
        self.last_metrics_sample = Instant::now();
    }

    /// Test hook: force a metrics sample regardless of the sampling interval.
    #[cfg(test)]
    fn sample_metrics_now(&mut self, delta_bytes: u64, over: Duration) {
        self.last_metrics_sample = Instant::now()
            .checked_sub(over)
            .expect("test offsets are small");
        self.update_metrics(delta_bytes);
    }
}

/// Reads until `buf` is full or the file ends, returning the bytes read.
///
/// A single `read` may legitimately return fewer bytes than asked for even
/// before EOF — a signal, a network filesystem, a pipe-backed file. Treating
/// that short read as end-of-file is not a hypothetical: it marks the DATA
/// packet as the last one, and the transfer completes successfully with a
/// truncated file that neither side has any reason to doubt.
#[allow(clippy::needless_continue, reason = "the arm must diverge; its sibling breaks with a value")]
fn read_full_at<R: Read + Seek>(file: &mut R, offset: u64, buf: &mut [u8]) -> std::io::Result<usize> {
    file.seek(SeekFrom::Start(offset))?;
    let mut filled = 0usize;
    while filled < buf.len() {
        match file.read(&mut buf[filled..]) {
            Ok(0) => break,
            Ok(n) => filled += n,
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(e) => return Err(e),
        }
    }
    Ok(filled)
}

fn epoch_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as u64)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::{parse_packet, peek_opcode};
    use crate::testsupport::TempDir;
    use crate::types::{Opcode, Packet, DEFAULT_BLOCK_SIZE, DEFAULT_WINDOW_SIZE};
    use std::path::Path;

    fn raw(pairs: &[(&str, &str)]) -> RawOptions {
        let mut o = RawOptions::default();
        for (k, v) in pairs {
            assert!(o.set(k, v));
        }
        o
    }

    fn session(direction: Direction, options: RawOptions) -> TransferSession {
        TransferSession::new(TransferInit {
            peer: "127.0.0.1:41000".parse().unwrap(),
            direction,
            filename: "x.bin".into(),
            abs_path: PathBuf::from("x.bin"),
            raw_options: options,
        })
    }

    fn session_for_file(path: &Path, options: RawOptions) -> TransferSession {
        TransferSession::new(TransferInit {
            peer: "127.0.0.1:41000".parse().unwrap(),
            direction: Direction::Read,
            filename: "payload.bin".into(),
            abs_path: path.to_path_buf(),
            raw_options: options,
        })
    }

    fn ack_block(packet: &[u8]) -> u16 {
        match parse_packet(packet).unwrap() {
            Some(Packet::Ack { block }) => block,
            other => panic!("expected ACK, got {other:?}"),
        }
    }

    fn data_block(packet: &[u8]) -> u16 {
        match parse_packet(packet).unwrap() {
            Some(Packet::Data { block, .. }) => block,
            other => panic!("expected DATA, got {other:?}"),
        }
    }

    // --- construction ---------------------------------------------------------

    #[test]
    fn a_bare_request_uses_protocol_defaults() {
        let s = session(Direction::Read, RawOptions::default());
        assert_eq!(s.phase, Phase::Idle);
        assert_eq!(s.opts.blksize, DEFAULT_BLOCK_SIZE);
        assert_eq!(s.opts.windowsize, DEFAULT_WINDOW_SIZE);
    }

    #[test]
    fn an_unusable_option_leaves_the_session_in_error_with_code_eight() {
        let s = session(Direction::Read, raw(&[("blksize", "3")]));
        assert_eq!(s.phase, Phase::Error);
        assert_eq!(s.error().unwrap().0, ErrorCode::OptionNegotiation);
    }

    #[test]
    fn a_negotiated_timeout_drives_the_retransmission_schedule() {
        let s = session(Direction::Read, raw(&[("timeout", "3")]));
        assert_eq!(s.timeout, Duration::from_secs(3));
        assert_eq!(s.retx_backoff, Duration::from_secs(3));
    }

    // --- initialisation transitions ------------------------------------------

    #[test]
    fn a_read_without_options_starts_sending_immediately() {
        let mut s = session(Direction::Read, RawOptions::default());
        assert!(s.init_for_read(1000).is_empty(), "no options means no OACK");
        assert_eq!(s.phase, Phase::Sending);
    }

    #[test]
    fn a_read_with_options_sends_an_oack_first() {
        let mut s = session(Direction::Read, raw(&[("blksize", "1400"), ("tsize", "0")]));
        let initial = s.init_for_read(4096);
        assert_eq!(initial.len(), 1);
        assert_eq!(peek_opcode(&initial[0]), Some(Opcode::Oack.to_wire()));
        assert_eq!(s.phase, Phase::SendOack);
        assert_eq!(s.opts.tsize, Some(4096), "tsize=0 asks the server to fill it in");
    }

    #[test]
    fn duplicate_ack_zero_does_not_complete_a_negotiated_single_block_read() {
        let temp = TempDir::new("session-ack-zero");
        let path = temp.path().join("small.bin");
        std::fs::write(&path, b"small").unwrap();
        let mut s = session_for_file(&path, raw(&[("blksize", "1400"), ("tsize", "0")]));
        s.init_for_read(5);
        assert!(s.handle_ack(0).produce_more);
        let packets = s.produce_next_send_packets().unwrap();
        assert_eq!(packets.len(), 1);
        assert_eq!(data_block(&packets[0]), 1);
        assert_eq!(s.phase, Phase::SentLast);

        let outcome = s.handle_ack(0);
        assert!(
            !outcome.done,
            "ACK(0) acknowledges only the OACK; it must not prove DATA(1) was delivered"
        );
        assert_eq!(s.phase, Phase::SentLast);
    }

    #[test]
    fn a_write_without_options_opens_with_ack_zero() {
        let mut s = session(Direction::Write, RawOptions::default());
        let initial = s.init_for_write();
        assert_eq!(ack_block(&initial[0]), 0);
        assert_eq!(s.phase, Phase::RecvInitialAck);
        assert_eq!(s.block, 1);
    }

    #[test]
    fn a_write_captures_tsize_at_start_for_the_progress_bar() {
        let mut s = session(Direction::Write, raw(&[("tsize", "8192")]));
        s.init_for_write();
        assert_eq!(s.tsize_at_start, Some(8192));
        assert_eq!(s.total_bytes(), Some(8192));
    }

    #[test]
    fn acking_the_oack_moves_a_read_to_sending_and_a_write_to_receiving() {
        let mut r = session(Direction::Read, raw(&[("blksize", "1400")]));
        r.init_for_read(4096);
        let outcome = r.handle_ack(0);
        assert_eq!(r.phase, Phase::Sending);
        assert!(outcome.produce_more, "a read must start sending data");

        let mut w = session(Direction::Write, raw(&[("blksize", "1400")]));
        w.init_for_write();
        let outcome = w.handle_ack(0);
        assert_eq!(w.phase, Phase::Receiving);
        assert!(
            !outcome.produce_more,
            "a write must never produce data from the server side"
        );
    }

    #[test]
    fn a_write_client_that_answers_an_oack_with_data_one_is_accepted() {
        // RFC 2347: after an OACK on a write, the client begins the transfer
        // with DATA(1) instead of acknowledging. A machine that refuses to leave
        // SendOack until an ACK arrives drops this packet and every
        // retransmission of it, so a conforming upload with any negotiated
        // option never completes.
        let mut s = session(Direction::Write, raw(&[("blksize", "8")]));
        s.init_for_write();
        assert_eq!(s.phase, Phase::SendOack);
        let outcome = s.handle_data(1, &[1, 2, 3, 4, 5, 6, 7, 8]);
        assert_eq!(s.phase, Phase::Receiving);
        assert_eq!(outcome.write.as_deref(), Some(&[1u8, 2, 3, 4, 5, 6, 7, 8][..]));
        assert_eq!(ack_block(&outcome.send[0]), 1);
    }

    // --- read path ------------------------------------------------------------

    #[test]
    fn a_read_walks_the_whole_file_and_ends_on_a_short_block() {
        let temp = TempDir::new("session-read");
        let path = temp.path().join("payload.bin");
        let payload: Vec<u8> = (0..1578u32).map(|i| (i % 251) as u8).collect();
        std::fs::write(&path, &payload).unwrap();

        let mut s = session_for_file(&path, RawOptions::default());
        s.init_for_read(payload.len() as u64);
        let mut received = Vec::new();
        let mut packets = s.produce_next_send_packets().unwrap();
        loop {
            assert_eq!(packets.len(), 1, "windowsize 1 is stop-and-wait");
            let Some(Packet::Data { block, data }) = parse_packet(&packets[0]).unwrap() else {
                panic!("expected DATA");
            };
            received.extend_from_slice(&data);
            let outcome = s.handle_ack(block);
            if outcome.done {
                break;
            }
            packets = s.produce_next_send_packets().unwrap();
        }
        assert_eq!(received, payload);
        assert_eq!(s.phase, Phase::Done);
        assert_eq!(s.bytes_transferred, payload.len() as u64);
    }

    #[test]
    fn a_file_that_is_an_exact_multiple_of_the_block_size_ends_with_an_empty_block() {
        let temp = TempDir::new("session-exact");
        let path = temp.path().join("payload.bin");
        std::fs::write(&path, vec![9u8; 1024]).unwrap();
        let mut s = session_for_file(&path, RawOptions::default());
        s.init_for_read(1024);

        let mut blocks = Vec::new();
        let mut packets = s.produce_next_send_packets().unwrap();
        for _ in 0..8 {
            let Some(Packet::Data { block, data }) = parse_packet(&packets[0]).unwrap() else {
                panic!("expected DATA");
            };
            blocks.push((block, data.len()));
            if s.handle_ack(block).done {
                break;
            }
            packets = s.produce_next_send_packets().unwrap();
        }
        assert_eq!(blocks, vec![(1, 512), (2, 512), (3, 0)]);
    }

    #[test]
    fn the_window_bounds_how_much_is_produced_at_once() {
        let temp = TempDir::new("session-window");
        let path = temp.path().join("payload.bin");
        std::fs::write(&path, vec![1u8; 512 * 20]).unwrap();
        let mut s = session_for_file(&path, raw(&[("windowsize", "4")]));
        s.init_for_read(512 * 20);
        s.handle_ack(0);
        let packets = s.produce_next_send_packets().unwrap();
        assert_eq!(packets.len(), 4);
    }

    #[test]
    fn data_arriving_during_a_read_does_not_refresh_the_transfer() {
        // The mirror of the phantom-ACK case. An RRQ waiting for ACKs has no use
        // for DATA, and the phase check does discard it — but only after the
        // activity clock and the retry budget had already been reset. A peer
        // could hold a slot open indefinitely by sending noise into it, and the
        // slots are a bounded resource.
        let temp = TempDir::new("session-read-phase-data");
        let path = temp.path().join("payload.bin");
        std::fs::write(&path, vec![1u8; 512 * 4]).unwrap();
        let mut s = session_for_file(&path, raw(&[("blksize", "512")]));
        s.init_for_read(512 * 4);
        s.handle_ack(0);
        let sent = s.produce_next_send_packets().unwrap();
        s.record_outbound(&sent);
        s.retries = 3;
        let before = s.last_activity;

        let outcome = s.handle_data(1, &vec![0u8; 512]);

        assert!(outcome.write.is_none(), "nothing may be written during a read");
        assert!(outcome.send.is_empty(), "and nothing answered");
        assert_eq!(s.retries, 3, "noise must not refill the retry budget");
        assert_eq!(
            s.last_activity, before,
            "nor hold the transfer open past its timeout"
        );
    }

    #[test]
    fn an_already_confirmed_ack_does_not_refresh_the_transfer() {
        // The range check is inclusive at both ends, so ACK(last_acked) passed
        // it — and then advanced nothing, cleared nothing, and still reached
        // `touch()` and the retry reset. Repeating one stale ACK held a stalled
        // RRQ open for as long as the peer cared to send it.
        let temp = TempDir::new("session-stale-ack");
        let path = temp.path().join("payload.bin");
        std::fs::write(&path, vec![1u8; 512 * 8]).unwrap();
        let mut s = session_for_file(&path, raw(&[("blksize", "512"), ("windowsize", "4")]));
        s.init_for_read(512 * 8);
        s.handle_ack(0);
        let sent = s.produce_next_send_packets().unwrap();
        s.record_outbound(&sent);
        s.handle_ack(1);
        assert_eq!(s.last_acked, 1, "a real ACK advances the window");

        s.retries = 3;
        let before = s.last_activity;
        let outcome = s.handle_ack(1);

        assert!(!outcome.produce_more, "a repeat confirms nothing new");
        assert_eq!(s.last_acked, 1, "and moves nothing");
        assert_eq!(s.retries, 3, "so it must not refill the retry budget");
        assert_eq!(
            s.last_activity, before,
            "nor hold a stalled transfer past its timeout"
        );
    }

    #[test]
    fn a_partly_received_write_window_recovers_from_a_lost_block() {
        // windowsize=4: DATA(1..3) arrive and are written, DATA(4) is lost. The
        // server now expects block 4 while `last_acked` is still 0, so the
        // client's retransmission of its unacknowledged window — which starts at
        // block 1, the first it never saw acknowledged — matched neither
        // duplicate case. It fell through to the mismatch path, which answered
        // IllegalOperation and deleted a healthy partial upload. One lost
        // datagram killed the transfer.
        let mut s = session(Direction::Write, raw(&[("windowsize", "4"), ("blksize", "512")]));
        s.init_for_write();
        for block in 1..=3u16 {
            let outcome = s.handle_data(block, &vec![block as u8; 512]);
            assert!(outcome.send.is_empty(), "block {block} is inside the window");
            assert!(outcome.write.is_some());
        }
        assert_eq!(s.block, 4, "block 4 is expected next");
        assert_eq!(s.last_acked, 0, "and nothing has been acknowledged yet");

        let outcome = s.handle_data(1, &vec![1u8; 512]);

        assert_eq!(
            s.phase,
            Phase::Receiving,
            "a lost block must not abort an upload that is going fine"
        );
        assert!(
            outcome.write.is_none(),
            "and block 1 must not be appended a second time"
        );
        assert_eq!(
            ack_block(&outcome.send[0]),
            3,
            "RFC 7440 §4: answer with the last block received in sequence"
        );
    }

    #[test]
    fn an_ack_for_a_block_that_was_never_sent_changes_nothing() {
        // An ACK inside the forward half of the sequence space was taken on
        // trust. ACK(1000) after a single DATA(1) cleared the retransmission
        // queue, dragged `last_acked` up to 1000, and — because every ACK
        // refreshed the activity clock and reset the retry counter — let a peer
        // hold a stalled transfer open for as long as it kept sending, occupying
        // one of a bounded number of slots without ever moving a byte.
        let temp = TempDir::new("session-phantom-ack");
        let path = temp.path().join("payload.bin");
        std::fs::write(&path, vec![1u8; 512 * 20]).unwrap();
        let mut s = session_for_file(&path, raw(&[("blksize", "512"), ("windowsize", "1")]));
        s.init_for_read(512 * 20);
        s.handle_ack(0);
        let sent = s.produce_next_send_packets().unwrap();
        assert_eq!(sent.len(), 1, "one block outstanding");
        assert_eq!(s.block, 1, "and it is block 1");
        s.record_outbound(&sent); // what the engine's send path does
        s.retries = 2;

        let outcome = s.handle_ack(1000);

        assert!(!outcome.produce_more, "a phantom ACK must not open the window");
        assert_eq!(s.last_acked, 0, "nor advance past data the peer never saw");
        assert_eq!(s.retries, 2, "nor reset the retry budget that ends a dead transfer");
        assert!(
            !s.outbound.is_empty(),
            "nor discard the block still awaiting a real acknowledgement"
        );
    }

    #[test]
    fn a_clamped_window_bounds_production_at_the_clamped_value_not_the_requested_one() {
        // The allocation bound is only real if the producer honours it. With the
        // clamp reverted this loop builds 65535 packets — about 33 MB for this
        // block size, from a single datagram, before anything is sent.
        let temp = TempDir::new("session-clamp");
        let path = temp.path().join("payload.bin");
        std::fs::write(&path, vec![1u8; 512 * 300]).unwrap();
        let mut s = session_for_file(&path, raw(&[("blksize", "512"), ("windowsize", "65535")]));
        let expected = crate::types::MAX_IN_FLIGHT_BYTES / 512;
        assert_eq!(s.opts.windowsize, expected);
        s.init_for_read(512 * 300);
        s.handle_ack(0);
        let packets = s.produce_next_send_packets().unwrap();
        assert!(
            packets.len() <= expected as usize,
            "produced {} packets, budget allows {expected}",
            packets.len()
        );
        let bytes: usize = packets.iter().map(Vec::len).sum();
        assert!(
            bytes as u32 <= crate::types::MAX_IN_FLIGHT_BYTES + 4 * expected,
            "in-flight bytes exceeded the budget"
        );
    }

    // --- write path -----------------------------------------------------------

    #[test]
    fn a_write_acknowledges_each_block_and_finishes_on_the_short_one() {
        let mut s = session(Direction::Write, RawOptions::default());
        s.init_for_write();
        for block in 1..=2u16 {
            let outcome = s.handle_data(block, &vec![7u8; 512]);
            assert_eq!(ack_block(&outcome.send[0]), block);
            assert!(!outcome.done);
        }
        let outcome = s.handle_data(3, &[7u8; 100]);
        assert!(outcome.done);
        assert_eq!(s.phase, Phase::Done);
        assert_eq!(s.bytes_transferred, 512 * 2 + 100);
    }

    #[test]
    fn an_out_of_order_block_is_a_protocol_violation() {
        let mut s = session(Direction::Write, RawOptions::default());
        s.init_for_write();
        let outcome = s.handle_data(2, &vec![0u8; 512]);
        assert!(outcome.done);
        assert_eq!(s.phase, Phase::Error);
        assert_eq!(s.error().unwrap().0, ErrorCode::IllegalOperation);
    }

    #[test]
    fn a_block_larger_than_the_negotiated_size_is_a_protocol_violation() {
        let mut s = session(Direction::Write, raw(&[("blksize", "512")]));
        s.init_for_write();
        s.handle_ack(0);
        let outcome = s.handle_data(1, &vec![0u8; 513]);
        assert!(outcome.done);
        assert_eq!(s.error().unwrap().0, ErrorCode::IllegalOperation);
    }

    #[test]
    fn a_windowed_write_reacks_retransmitted_blocks_from_a_completed_window() {
        let mut s = session(Direction::Write, raw(&[("windowsize", "4")]));
        s.init_for_write();
        for block in 1..=3u16 {
            let outcome = s.handle_data(block, &vec![block as u8; 512]);
            assert!(outcome.send.is_empty(), "block {block} is inside the window");
            assert!(outcome.write.is_some());
        }
        let outcome = s.handle_data(4, &vec![4u8; 512]);
        assert_eq!(ack_block(&outcome.send[0]), 4);
        assert_eq!(s.last_acked, 4);
        assert_eq!(s.block, 5);

        for block in 1..=4u16 {
            let outcome = s.handle_data(block, &vec![block as u8; 512]);
            assert_eq!(s.phase, Phase::Receiving, "block {block} must not abort the transfer");
            assert_eq!(ack_block(&outcome.send[0]), 4, "block {block} should resend the cumulative ACK");
            assert!(outcome.write.is_none(), "block {block} was already written");
            assert!(!outcome.done);
        }
    }

    // --- retransmission queue -------------------------------------------------

    #[test]
    fn confirmed_packets_leave_the_retransmission_queue() {
        let mut s = session(Direction::Read, RawOptions::default());
        s.init_for_read(4096);
        s.record_outbound(&[encode_data(1, &[0; 4]), encode_data(2, &[0; 4]), encode_data(3, &[0; 4])]);
        assert_eq!(s.outbound.len(), 3);
        s.clear_outbound_up_to(2);
        assert_eq!(s.outbound.len(), 1);
        assert_eq!(s.outbound[0].block, Some(3));
    }

    #[test]
    fn the_oack_does_not_jam_the_queue_behind_it() {
        // With the OACK treated as permanently unconfirmable, the drain stops at
        // it and nothing behind it ever leaves: the queue grows to its cap and
        // every retransmission re-sends a whole window the peer already has.
        let mut s = session(Direction::Read, raw(&[("blksize", "1400")]));
        let initial = s.init_for_read(4096);
        s.record_outbound(&initial);
        s.handle_ack(0);
        s.record_outbound(&[encode_data(1, &[0; 4])]);
        // `produce_next_send_packets` is what advances `block` alongside the
        // packets it hands to the send path; recording a DATA by hand has to say
        // so too, or the session claims to have emitted nothing.
        s.block = 1;
        s.handle_ack(1);
        assert!(
            s.outbound.is_empty(),
            "queue still holds {:?}",
            s.outbound.iter().map(|o| o.block).collect::<Vec<_>>()
        );
    }

    #[test]
    fn the_retransmission_budget_is_finite() {
        let mut s = session(Direction::Read, RawOptions::default());
        s.record_outbound(&[encode_data(1, &[0; 4])]);
        for attempt in 1..=DEFAULT_MAX_RETRIES {
            assert!(
                s.consume_retransmission().is_some(),
                "attempt {attempt} should be allowed"
            );
        }
        assert!(s.consume_retransmission().is_none());
        assert_eq!(s.phase, Phase::Error);
    }

    #[test]
    fn an_empty_queue_never_asks_for_retransmission() {
        let s = session(Direction::Read, RawOptions::default());
        assert!(!s.time_for_retransmission());
    }

    // --- block-number wrap ----------------------------------------------------
    //
    // Every test below fails against plain `<` / `>=` comparisons and against a
    // `block - 1` predecessor. They are the reason this module carries its own
    // sequence-space arithmetic instead of comparing numbers.

    #[test]
    fn distance_and_ordering_are_computed_in_the_sequence_space() {
        assert_eq!(block_distance(65535, 0), 1);
        assert_eq!(block_distance(65535, 1), 2);
        assert_eq!(block_distance(65534, 2), 4);
        assert!(block_at_or_after(65535, 0), "0 follows 65535");
        assert!(block_at_or_after(65535, 1), "1 follows 0");
        assert!(!block_at_or_after(1, 65535), "65535 precedes 1");
        assert_eq!(next_block(65535), 0, "the 16-bit wire field wraps through 0");
    }

    #[test]
    fn a_write_expects_block_zero_after_block_65535() {
        let mut s = session(Direction::Write, RawOptions::default());
        s.init_for_write();
        s.block = 65535;
        s.last_acked = 65534;
        let outcome = s.handle_data(65535, &vec![1u8; 512]);
        assert_eq!(ack_block(&outcome.send[0]), 65535);
        assert_eq!(s.block, 0, "the 16-bit wire field wraps through block 0");

        // The very next block is 0, and it must be accepted as the expected one
        // rather than rejected as an out-of-order duplicate.
        let outcome = s.handle_data(0, &vec![2u8; 512]);
        assert_eq!(s.phase, Phase::Receiving, "a wrap is not a protocol violation");
        assert_eq!(ack_block(&outcome.send[0]), 0);
        assert!(outcome.write.is_some());
    }

    #[test]
    fn a_read_window_still_advances_after_the_wrap() {
        let temp = TempDir::new("session-wrap-read");
        let path = temp.path().join("payload.bin");
        std::fs::write(&path, vec![4u8; 512 * 6]).unwrap();
        let mut s = session_for_file(&path, raw(&[("windowsize", "2")]));
        s.init_for_read(512 * 6);
        s.handle_ack(0);
        // Park the session one block short of the wrap.
        s.block = 65535;
        s.last_acked = 65534;

        let packets = s.produce_next_send_packets().unwrap();
        assert_eq!(
            packets.iter().map(|p| data_block(p)).collect::<Vec<_>>(),
            vec![0],
            "distance(65534, 65535) is already 1 of a 2-block window"
        );

        // ACK(0) is numerically far *below* last_acked (65534). A plain compare
        // discards it, the window never advances, and the transfer stalls with
        // no error on either side.
        let outcome = s.handle_ack(0);
        assert!(
            outcome.produce_more,
            "an ACK for a wrapped block must advance the window"
        );
        assert_eq!(s.last_acked, 0);
        let packets = s.produce_next_send_packets().unwrap();
        assert_eq!(
            packets.iter().map(|p| data_block(p)).collect::<Vec<_>>(),
            vec![1, 2]
        );
    }

    #[test]
    fn a_retransmitted_pre_wrap_block_is_re_acked_not_treated_as_a_violation() {
        // `self.block - 1` is 0 immediately after the wrap, so a perfectly
        // ordinary retransmission of 65535 matches nothing and kills a transfer
        // that was only recovering from a lost ACK.
        let mut s = session(Direction::Write, RawOptions::default());
        s.init_for_write();
        s.block = 0;
        s.last_acked = 65535;
        let outcome = s.handle_data(65535, &vec![5u8; 512]);
        assert_eq!(s.phase, Phase::Receiving, "must not error");
        assert_eq!(ack_block(&outcome.send[0]), 65535);
        assert!(outcome.write.is_none(), "a duplicate must not be written twice");
    }

    #[test]
    fn the_retransmission_queue_drains_across_the_wrap() {
        let mut s = session(Direction::Read, raw(&[("windowsize", "8")]));
        s.init_for_read(4096);
        s.record_outbound(&[
            encode_data(65534, &[0; 4]),
            encode_data(65535, &[0; 4]),
            encode_data(0, &[0; 4]),
            encode_data(1, &[0; 4]),
        ]);
        s.clear_outbound_up_to(1);
        assert!(
            s.outbound.is_empty(),
            "a numeric compare drains nothing here and the session then \
             retransmits blocks the peer already has"
        );
    }

    #[test]
    fn the_windowed_write_ack_still_fires_on_the_far_side_of_the_wrap() {
        let mut s = session(Direction::Write, raw(&[("windowsize", "4")]));
        s.init_for_write();
        s.handle_ack(0);
        s.block = 65535;
        s.last_acked = 65531;
        // distance(65531, 65535) == 4 == windowsize, so this block is acked.
        let outcome = s.handle_data(65535, &vec![1u8; 512]);
        assert_eq!(ack_block(&outcome.send[0]), 65535);
        assert_eq!(s.block, 0);
        // Four blocks past the wrap: distance(65535, 3) == 4, ack again.
        for block in [0u16, 1, 2] {
            let outcome = s.handle_data(block, &vec![1u8; 512]);
            assert!(outcome.send.is_empty(), "block {block} is inside the window");
        }
        let outcome = s.handle_data(3, &vec![1u8; 512]);
        assert_eq!(
            ack_block(&outcome.send[0]),
            3,
            "without wrap-safe distance the server stops acknowledging entirely \
             and the upload dies on the client's retries"
        );
    }

    // --- metrics --------------------------------------------------------------

    #[test]
    fn a_read_reports_speed_and_an_eta() {
        let mut s = session(Direction::Read, RawOptions::default());
        s.init_for_read(1_000_000);
        s.bytes_transferred = 500_000;
        s.sample_metrics_now(500_000, Duration::from_secs(1));
        let m = s.metrics();
        assert!(m.speed_bps > 100_000.0, "got {}", m.speed_bps);
        let eta = m.eta_sec.expect("a read knows the file size");
        assert!(eta > 0.0 && eta < 60.0, "got {eta}");
    }

    #[test]
    fn a_write_without_tsize_cannot_predict_an_eta() {
        let mut s = session(Direction::Write, RawOptions::default());
        s.init_for_write();
        s.bytes_transferred = 4096;
        s.sample_metrics_now(4096, Duration::from_secs(1));
        assert_eq!(s.metrics().eta_sec, None);
        assert_eq!(s.total_bytes(), None);
    }

    #[test]
    fn a_write_with_tsize_can_predict_an_eta() {
        let mut s = session(Direction::Write, raw(&[("tsize", "100000")]));
        s.init_for_write();
        s.bytes_transferred = 50_000;
        s.sample_metrics_now(50_000, Duration::from_secs(1));
        assert!(s.metrics().eta_sec.is_some());
    }

    #[test]
    fn the_transfer_id_is_the_peer_endpoint() {
        let s = session(Direction::Read, RawOptions::default());
        assert_eq!(s.transfer_id(), "127.0.0.1:41000");
    }

    /// A reader that hands back at most one byte per call, and reports EOF only
    /// when it truly is at the end.
    ///
    /// This is the behaviour a plain `File` is *allowed* to have — a signal
    /// during the read, a network filesystem, a pipe-backed file — and which it
    /// almost never exhibits on a local disk. A test against a real file cannot
    /// tell a looping reader from a single-`read` one, which is exactly the trap
    /// this whole crate's test discipline is meant to avoid: the assertion would
    /// pass against the broken implementation.
    struct DribblingReader {
        data: Vec<u8>,
        position: usize,
    }

    impl Read for DribblingReader {
        fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
            if self.position >= self.data.len() || buf.is_empty() {
                return Ok(0);
            }
            buf[0] = self.data[self.position];
            self.position += 1;
            Ok(1)
        }
    }

    impl Seek for DribblingReader {
        fn seek(&mut self, from: SeekFrom) -> std::io::Result<u64> {
            let SeekFrom::Start(offset) = from else {
                unimplemented!("only absolute seeks are used")
            };
            self.position = usize::try_from(offset).unwrap().min(self.data.len());
            Ok(offset)
        }
    }

    #[test]
    fn a_short_read_is_not_mistaken_for_end_of_file() {
        // Against a single `read`, this fills one byte and reports 1. The caller
        // then sees `1 < blksize`, marks the block as the last one, and the
        // transfer "completes successfully" having delivered one byte of a 4 KB
        // file — with neither side having any reason to doubt it.
        let payload: Vec<u8> = (0..4096u32).map(|i| (i % 253) as u8).collect();
        let mut reader = DribblingReader {
            data: payload.clone(),
            position: 0,
        };
        let mut buf = vec![0u8; 4096];
        assert_eq!(read_full_at(&mut reader, 0, &mut buf).unwrap(), 4096);
        assert_eq!(buf, payload);

        // A genuine end of file still stops the loop rather than spinning.
        let mut buf = vec![0u8; 4096];
        assert_eq!(read_full_at(&mut reader, 4000, &mut buf).unwrap(), 96);
        assert_eq!(&buf[..96], &payload[4000..]);
    }

    #[test]
    fn a_real_file_reads_through_the_same_path() {
        let temp = TempDir::new("session-shortread");
        let path = temp.path().join("payload.bin");
        let payload: Vec<u8> = (0..4096u32).map(|i| (i % 253) as u8).collect();
        std::fs::write(&path, &payload).unwrap();
        let mut file = File::open(&path).unwrap();
        let mut buf = vec![0u8; 4096];
        assert_eq!(read_full_at(&mut file, 0, &mut buf).unwrap(), 4096);
        assert_eq!(buf, payload);
    }
}
