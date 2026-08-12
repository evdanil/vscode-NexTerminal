import { closeSync, existsSync, mkdirSync, openSync, renameSync, statSync, unlinkSync, write, writeSync } from "node:fs";
import * as path from "node:path";
import { normalizeLoggerRotationOptions, type LoggerRotationOptions } from "./terminalLogger";
import { createAnsiRegex } from "../utils/ansi";

// Control characters except \n, \r, \t
const CTRL_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;

// How long a chunk may sit in the in-memory queue before it reaches the file.
// Bounds worst-case loss if the extension host is killed outright (nothing
// short of a synchronous write per chunk survives that, and that write is what
// we are removing from the hot path). Every orderly exit — terminal closed,
// session disconnected, extension deactivated — flushes explicitly.
const FLUSH_INTERVAL_MS = 250;

// Upper bound on how long extension-host teardown waits for transcripts to
// reach disk. VS Code force-exits the host a few seconds after `deactivate()`,
// and a wedged fd (dead network share) must not eat that budget.
const SHUTDOWN_FLUSH_TIMEOUT_MS = 1000;

// Cap on the data a transcript holds in memory while it cannot get rid of it.
// Retrying is what makes a transient EIO/ENOSPC non-lossy, but a *permanent*
// write failure on a busy session would otherwise grow the queue without limit.
// Past the cap the oldest retained bytes are dropped, so a wedged transcript
// costs a bounded amount of heap rather than the extension host.
//
// The cap covers every stage the writer holds bytes in — `queue`, `pending`
// and `owed` — and is enforced at both ends: after a failed drain, and at
// enqueue while a drain is in flight (see enqueue() for the two shapes that
// takes). Drain-time enforcement alone was not a bound, because the drain is
// not guaranteed to run: an `fs.write` whose callback never fires (a stalled
// network-share descriptor) leaves the drain awaiting forever, so `trimRetained`
// is never reached and every later drain queues behind the blocked promise,
// while terminal output keeps piling into `queue`.
//
// One thing is deliberately outside the cap: `inFlight`, the buffer of an
// append the kernel is holding. Dropping our reference frees nothing and
// cannot stop those bytes reaching the file, so counting it would only make
// the writer shed *newer* bytes it really could have kept. That exemption is
// safe only because the buffer is bounded on its own, and it is bounded by
// construction rather than by argument: an append is never handed more than
// one capful (see takeAppendBatch, and promote()'s matching coalescing limit).
// Total footprint is therefore MAX_RETAINED_BYTES of retained bytes plus at
// most one capful inside the syscall — 2 × MAX_RETAINED_BYTES — whatever the
// fd does and whatever shape the output arrives in.
const MAX_RETAINED_BYTES = 1024 * 1024;

// How long one append may be outstanding before the writer stops treating the
// bytes queued behind it as bytes on their way out.
//
// This is the line between "slow" and "refusing", and the cap needs it because
// the two cases want opposite things. An append that is progressing is
// emptying the writer: everything behind it is already committed to the file
// and is being handed over a capful at a time, so shedding it would throw away
// data a healthy fd was about to accept — the same mistake as shedding because
// the flush timer has not fired yet. An append that has been outstanding
// longer than the writer's whole flush cadence is the wedge: nothing behind it
// is going anywhere, and everything arriving is growth with no end in sight.
// One flush interval is the natural threshold — a write that has not completed
// in the time the writer would have produced another whole drain's worth of
// output is not taking bytes at the rate they arrive.
const APPEND_STALL_MS = FLUSH_INTERVAL_MS;

// Backoff for the tail a `close()` could not land. The descriptor and the
// transcript's registration are held open across these attempts, so the budget
// is deliberately short and finite: a permanently failing fd must cost a
// bounded delay and one descriptor, not either of them for the rest of the
// session. Timers only — `close()` itself must not block terminal closure.
const CLOSE_RETRY_DELAYS_MS = [50, 250, 1000];

/** `fd` value meaning "this transcript owns no descriptor right now". */
const NO_FD = -1;

/** `writeStartedAt` value meaning "no append is outstanding". */
const NO_WRITE = -1;

/** A shared zero-length buffer: `owed` is never null, only empty. */
const NO_BYTES = Buffer.alloc(0);

function stripTerminalCodes(data: string): string {
  return data.replace(createAnsiRegex(), "").replace(CTRL_RE, "");
}

/**
 * Drop `cut` bytes from the head of `data`, stepping forward off any UTF-8
 * continuation byte so the cut never lands mid-glyph. Stepping forward drops
 * at most three bytes more, so it can only ever cut deeper, never less.
 *
 * The survivor is copied rather than returned as a view. `subarray` keeps the
 * whole buffer it was taken from alive, so shedding the head of a large buffer
 * would free nothing at all — which is exactly the memory the retention cap
 * exists to reclaim. The copy is at most one capful and only happens on the
 * shedding path.
 */
function cutUtf8Head(data: Buffer, cut: number): Buffer {
  while (cut < data.length && (data[cut] & 0xc0) === 0x80) {
    cut += 1;
  }
  return cut >= data.length ? NO_BYTES : Buffer.from(data.subarray(cut));
}

export interface SessionTranscript {
  write(data: string): void;
  /**
   * Write everything queued to disk now. Called on disconnect and on extension
   * deactivate, where the session may never be closed cleanly. Optional so the
   * lightweight transcript doubles used across the suite keep working.
   *
   * Synchronous when it can be (nothing in flight), which is the common case.
   * When a timer drain is already mid-syscall this can only queue the work
   * behind it — see {@link flushSessionTranscripts} for the awaitable half that
   * extension-host teardown needs.
   */
  flush?(): void;
  close(): void;
}

const NOOP_TRANSCRIPT: SessionTranscript = { write() {}, flush() {}, close() {} };

/**
 * Buffered transcript writer.
 *
 * Terminal data arrives in small chunks at high frequency; a `writeSync` per
 * chunk put a blocking syscall on the render path for every one of them.
 * Chunks are queued and drained on a timer via an asynchronous append instead.
 *
 * ### The invariant everything hangs off
 *
 * Every byte this writer holds is in exactly one of two states:
 *
 * - **Undecided** — `queue` (raw strings, straight off the hot path) and
 *   `pending` (byte-accurate chunks, one per `write()` call). No rotation
 *   decision of any kind is attached to them, and none has been made about
 *   them — the types cannot even express one.
 * - **Placed** — `owed`: bytes whose file generation is settled. The rotation
 *   their chunk required, if any, has already been performed; all that
 *   remains is to finish appending them to the live file. Bytes on disk are
 *   the completion of this state.
 *
 * A rotation decision exists only for the instant of {@link promote}: it is
 * derived from settled state alone — `currentSize` plus bytes already owed to
 * the live file — and acting on it (shifting the generations) is part of the
 * same synchronous step that moves the deciding chunk from undecided to
 * placed. Because no decision is ever stored, none can go stale when a write
 * fails or the retention cap sheds bytes; and because {@link rotateNow} is
 * only reachable while `owed` is empty, a chunk whose rotation has been
 * performed can never trigger it again. "Stale rotation flag" and "rotated
 * twice" — the shape of every accounting defect this file has had — have no
 * representation.
 *
 * The invariants carried over from the synchronous writer:
 *
 * - **Ordering.** Drains are serialised through `flushChain`, so a drain that
 *   is still in flight when the next timer fires cannot interleave with it.
 * - **Rotation identity.** Each chunk gets the same
 *   `currentSize + size > maxFileSizeBytes` test the synchronous writer
 *   applied per `write()` call — once, when it is promoted — so a transcript
 *   rotates at exactly the same byte boundaries as before. Adjacent chunks
 *   bound for the same generation are coalesced into one syscall; a chunk
 *   that would cross the boundary — or that would take the coalesced buffer
 *   past one capful — stays undecided until the bytes ahead of it have
 *   landed. Both limits stop coalescing in the same way and neither moves a
 *   boundary: a chunk left behind takes its own test at a later promote,
 *   against a `currentSize` that has advanced by exactly the bytes it would
 *   have been projected past.
 * - **Durability.** A write that fails, or that lands only part of its
 *   buffer, leaves the unwritten bytes in `owed` for the next drain instead
 *   of dropping them. `currentSize` only ever advances by bytes that actually
 *   reached the file, so rotation cannot drift out of step with the disk.
 * - **Bounded.** Everything the writer holds — `queue`, `pending` and `owed`
 *   — is trimmed, oldest first, to {@link MAX_RETAINED_BYTES}: after a failed
 *   drain, and at enqueue whenever a drain is already stuck on this fd (the
 *   only way the queue can grow without a drain ever emptying it). Dropping
 *   undecided bytes invalidates nothing — no decision was made about them or
 *   against them. Dropping placed bytes only shortens an append whose
 *   destination was already settled. Neither can move a rotation. The one
 *   thing outside the cap is `inFlight`, the buffer the kernel is holding,
 *   and it is one capful at most because that is all an append is ever given
 *   — so the whole footprint is at most 2 × {@link MAX_RETAINED_BYTES}.
 * - **Descriptor ownership.** `fd` holds a descriptor this transcript owns,
 *   or {@link NO_FD}. It is never left holding a number the process has
 *   already handed back — see {@link releaseFd}.
 */
class FileSessionTranscript implements SessionTranscript {
  /** Open descriptor, or {@link NO_FD} when none is currently owned. */
  private fd: number = NO_FD;
  private currentSize: number;
  private closed = false;
  /** Raw chunks off the hot path. Moved into `pending` when a drain starts. */
  private queue: string[] = [];
  /**
   * UTF-8 size of `queue`, maintained incrementally so the retention cap can
   * be checked on the hot path without walking it. Kept in bytes, not
   * characters, because that is the unit the cap and every other stage use.
   */
  private queuedBytes = 0;
  /**
   * Undecided bytes, one buffer per `write()` call, oldest first. Placement
   * is decided in {@link promote} and nowhere else — these carry no flags.
   */
  private pending: Buffer[] = [];
  /**
   * Byte size of `pending`, maintained incrementally for the same reason
   * `queuedBytes` is: the retention cap is consulted once per chunk on the hot
   * path, and `pending` is no longer guaranteed to be short — a burst larger
   * than one capful stays there, chunk by chunk, while the drain works
   * through it.
   */
  private pendingBytes = 0;
  /**
   * Placed bytes: the live file's settled future content that has not reached
   * the disk yet. A failed or short write leaves its remainder here, and a
   * retry may only finish the append — nothing about these bytes is ever
   * decided again.
   */
  private owed: Buffer = NO_BYTES;
  /**
   * The placed bytes an append has handed to the kernel, for exactly as long
   * as that syscall lasts. They are taken out of `owed` rather than left in
   * it, which is what makes the exemption honest: bytes inside a syscall are
   * in none of the writer's stages, so the cap neither counts them (it could
   * not free them) nor can trim into them (the drain is about to subtract a
   * written count from this exact buffer). Whatever the append cannot land
   * comes back to the head of `owed` — see {@link returnUnwritten}.
   */
  private inFlight: Buffer = NO_BYTES;
  private flushTimer?: ReturnType<typeof setTimeout>;
  private flushChain: Promise<void> = Promise.resolve();
  private draining = false;
  /**
   * When the outstanding `fs.write` was submitted, or {@link NO_WRITE} when
   * none is. Read only by {@link appendStalled}, which is how the retention
   * cap tells a descriptor that is merely slow from one that has stopped
   * taking bytes altogether.
   */
  private writeStartedAt = NO_WRITE;
  /** True while a drain is queued on `flushChain` and has not started yet. */
  private drainQueued = false;
  private closeAttempt = 0;
  private closeRetryTimer?: ReturnType<typeof setTimeout>;

  public constructor(
    private readonly filepath: string,
    private readonly rotation: LoggerRotationOptions
  ) {
    mkdirSync(path.dirname(filepath), { recursive: true });
    this.currentSize = this.readCurrentSize();
    this.openFd();
    const header = `--- Session started ${new Date().toISOString()} ---\n`;
    this.enqueue(header);
    liveTranscripts.add(this);
  }

  public write(data: string): void {
    if (this.closed) {
      return;
    }
    const clean = stripTerminalCodes(data);
    if (clean) {
      this.enqueue(clean);
    }
  }

  public flush(): void {
    if (this.closed) {
      return;
    }
    this.clearFlushTimer();
    if (this.draining) {
      // A drain is mid-syscall on this fd. Writing from here would interleave
      // with it; chain instead so the queued tail still lands, in order.
      this.flushChain = this.flushChain.then(() => this.drainAsync());
      return;
    }
    this.drainSync();
  }

  /**
   * Resolve once everything queued at call time is on disk (or has been given
   * up on). `flush()` cannot promise that on its own: when a timer drain is
   * already mid-write it can only chain the tail behind it, leaving the caller
   * nothing to wait on — which is exactly the window extension-host teardown
   * falls into. Never rejects: a transcript must not fail a shutdown.
   */
  public async settle(): Promise<void> {
    // The chain is reassigned by anything that queues work behind an in-flight
    // drain, so follow it until it stops moving. Bounded — a transcript that
    // keeps growing a chain is not worth blocking teardown for.
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const chain = this.flushChain;
      await chain.catch(() => undefined);
      if (this.flushChain === chain) {
        break;
      }
    }
    if (this.draining) {
      // The chain outran the loop above. Leave the fd to the drain that owns it
      // rather than interleaving a synchronous write.
      return;
    }
    if (this.closed) {
      // A close that could not land its tail stays registered, with its
      // descriptor open, until the retry budget runs out. Teardown is the last
      // chance those bytes get, so spend it here rather than waiting for a
      // timer the host is about to stop running.
      if (this.retainedByteCount() > 0) {
        this.finishClose();
      }
      return;
    }
    // Nothing is in flight now, so the tail (and anything a failed write put
    // back) can go out synchronously.
    this.clearFlushTimer();
    this.drainSync();
  }

  public close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.clearFlushTimer();
    const footer = `\n--- Session ended ${new Date().toISOString()} ---\n`;
    this.pushQueued(footer);
    if (this.draining) {
      // Rare: a timer drain is in flight. Finish the close behind it so the
      // file is never written to after closeSync.
      this.flushChain = this.flushChain.then(() => this.finishClose());
      return;
    }
    this.finishClose();
  }

  /**
   * Land the tail, then let the descriptor go.
   *
   * The drain can fail — a transient EIO, a network share that blinked — and
   * when it does the tail and the session footer are still held (placed or
   * pending). Closing the descriptor and deregistering here would put them out
   * of reach of every retry path there is, which loses precisely the bytes
   * retention exists to keep. So a failed drain keeps both, and a timer
   * retries on a short, finite budget. `close()` itself stays synchronous and
   * returns immediately either way: terminal closure must not wait on a
   * wedged filesystem.
   */
  private finishClose(): void {
    this.clearCloseRetryTimer();
    this.drainSync();
    if (this.retainedByteCount() > 0) {
      this.scheduleCloseRetry();
      return;
    }
    this.releaseFd();
    liveTranscripts.delete(this);
  }

  private scheduleCloseRetry(): void {
    const delay = CLOSE_RETRY_DELAYS_MS[this.closeAttempt];
    if (delay === undefined) {
      this.abandonTail();
      return;
    }
    this.closeAttempt += 1;
    this.closeRetryTimer = setTimeout(() => {
      this.closeRetryTimer = undefined;
      this.finishClose();
    }, delay);
    // Never hold the host process open for a transcript that is already closed.
    (this.closeRetryTimer as { unref?: () => void }).unref?.();
  }

  private clearCloseRetryTimer(): void {
    if (this.closeRetryTimer !== undefined) {
      clearTimeout(this.closeRetryTimer);
      this.closeRetryTimer = undefined;
    }
  }

  /**
   * The retry budget is spent. Report the loss rather than swallowing it — a
   * transcript that silently ends short is worse than one that says it did —
   * and release the descriptor so a permanently failing file costs nothing
   * further.
   */
  private abandonTail(): void {
    const lost = this.retainedByteCount();
    this.owed = NO_BYTES;
    this.pending = [];
    this.pendingBytes = 0;
    this.queue = [];
    this.queuedBytes = 0;
    this.releaseFd();
    liveTranscripts.delete(this);
    console.error(
      `[Nexus] Session transcript ${this.filepath}: the last ${lost} byte(s) could not be written and have been dropped.`
    );
  }

  /** The one place `queue` grows from the tail, so `queuedBytes` cannot drift. */
  private pushQueued(text: string): void {
    this.queue.push(text);
    this.queuedBytes += Buffer.byteLength(text, "utf8");
  }

  /** The one place `pending` grows, so `pendingBytes` cannot drift from it. */
  private pushPending(chunk: Buffer): void {
    if (chunk.length === 0) {
      return;
    }
    this.pending.push(chunk);
    this.pendingBytes += chunk.length;
  }

  /** The one place a whole chunk leaves `pending`'s head. */
  private shiftPending(): Buffer | undefined {
    const head = this.pending.shift();
    if (head !== undefined) {
      this.pendingBytes -= head.length;
    }
    return head;
  }

  /**
   * Take a chunk off the hot path, and hold the memory bound while doing it.
   *
   * The bound cannot be left to the drain: a wedged `fs.write` — the callback
   * that never fires — means no drain ever completes again, so nothing ever
   * reaches {@link trimRetained} and `queue` grows for as long as the session
   * produces output. It is enforced here instead, with no syscall and no
   * blocking work of any kind: a byte count, a comparison, and — only when a
   * drain is stuck *and* the cap is crossed — a splice of the oldest bytes.
   *
   * The cap only bites while a drain is in flight, and that condition is the
   * substance of it rather than an optimisation. A queue over the cap with
   * nothing in flight means only that the 250 ms timer has not fired yet — the
   * file has not been offered these bytes and has refused nothing, and holding
   * one flush interval of output is the entire premise of this writer. Dropping
   * data a healthy file was about to accept would be absurd. Either way
   * `enqueue` is always within one flush interval of a drain — the timer below
   * guarantees it — so a queue can never grow for longer than that without a
   * drain taking it on.
   *
   * While a drain *is* in flight, which bytes may be shed depends on what the
   * descriptor is doing, and the two cases are opposites:
   *
   * - **Progressing.** Everything the drain took on is committed and on its
   *   way out a capful at a time; only what has arrived *since* it started is
   *   growth. So the cap applies to `queue` alone — arrivals are held to one
   *   capful, which is what bounds a descriptor that simply cannot keep up
   *   with the session — and the committed bytes are left to land. A burst
   *   larger than the cap therefore reaches the disk intact even while output
   *   keeps arriving behind it.
   * - **Stalled.** The append has been outstanding longer than the writer's
   *   whole flush cadence: the fd has been handed bytes and is not taking
   *   them, nothing behind it is going anywhere, and "committed" no longer
   *   means "on its way out". The cap now applies to everything the writer
   *   holds, oldest first — which is what makes the bound hold against a burst
   *   that arrived before the first drain and then wedged.
   */
  private enqueue(text: string): void {
    this.pushQueued(text);
    if (this.draining && this.retainedByteCount() > MAX_RETAINED_BYTES) {
      if (this.appendStalled()) {
        this.trimRetained();
      } else {
        this.trimArrivals();
      }
    }
    if (this.flushTimer === undefined) {
      this.flushTimer = setTimeout(() => {
        this.flushTimer = undefined;
        this.scheduleDrain();
      }, FLUSH_INTERVAL_MS);
      // Never hold the host process open for a transcript flush.
      (this.flushTimer as { unref?: () => void }).unref?.();
    }
  }

  /**
   * Put one drain on the flush chain, never more.
   *
   * Behind a wedged write the chain never advances, so an unguarded
   * `flushChain.then(...)` every 250 ms is itself an unbounded queue — of
   * closures rather than of terminal output, but growing for the same reason
   * and for as long. One waiting drain is all that can ever be useful: it
   * ingests whatever is queued at the moment it finally runs.
   */
  private scheduleDrain(): void {
    if (this.drainQueued) {
      return;
    }
    this.drainQueued = true;
    this.flushChain = this.flushChain.then(() => {
      this.drainQueued = false;
      return this.drainAsync();
    });
  }

  private clearFlushTimer(): void {
    if (this.flushTimer !== undefined) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
  }

  /**
   * The rotation rule, in one place: does appending `size` bytes to a file
   * already holding `settledSize` push it past the boundary? The class's
   * rotation identity is precisely that this one test is applied the same way
   * the synchronous writer applied it, so every rotation decision goes
   * through here — and is acted on in the same step it is made.
   */
  private overflowsFile(settledSize: number, size: number): boolean {
    return settledSize + size > this.rotation.maxFileSizeBytes;
  }

  /**
   * Every byte this writer is holding: placed but unwritten (`owed`),
   * undecided (`pending`), and raw off the hot path (`queue`).
   *
   * All three, and not a subset: `queue` used to be excluded, which made the
   * cap measure the one stage that cannot grow while a write is wedged and
   * ignore the only stage that can.
   *
   * `inFlight` is deliberately not here, and it is the only thing that is not.
   * Those bytes are inside a syscall: counting them would make the cap shed
   * newer bytes to compensate for memory it cannot free anyway. They are held
   * to one capful by {@link takeAppendBatch} instead, so the exemption costs a
   * bounded amount rather than requiring an argument about arrival patterns.
   */
  private retainedByteCount(): number {
    return this.owed.length + this.pendingBytes + this.queuedBytes;
  }

  /**
   * Has the append the writer is waiting on stopped taking bytes?
   *
   * A wedged descriptor is an `fs.write` whose callback never fires, so the
   * only thing that distinguishes it from a slow one is how long it has been
   * outstanding — there is no event to wait for. {@link APPEND_STALL_MS}
   * explains why one flush interval is the threshold. Consulted only when the
   * writer is already over the cap, so the clock read is off the common path.
   */
  private appendStalled(): boolean {
    return this.writeStartedAt !== NO_WRITE && Date.now() - this.writeStartedAt >= APPEND_STALL_MS;
  }

  /** Move raw queued chunks into the undecided stage, byte-accurate. */
  private ingest(): void {
    for (const chunk of this.queue) {
      this.pushPending(Buffer.from(chunk, "utf8"));
    }
    this.queue = [];
    this.queuedBytes = 0;
  }

  /**
   * Move bytes from undecided to placed. When nothing is owed, the head chunk
   * is placed first: it gets its one rotation test — the synchronous writer's
   * rule, against the live file's settled size — and the generation shift it
   * asks for happens here, in the same step. It is then placed
   * unconditionally: a chunk larger than a whole file overfills its
   * generation, exactly as the synchronous writer overfilled it, rather than
   * ever being asked again.
   *
   * Chunks behind the head are coalesced in while they fit the same
   * generation *and* keep the placed buffer inside one capful — a projection
   * made of settled bytes only (`currentSize` plus what is already owed), so
   * it is a statement of fact about this file, not a guess about writes that
   * might fail. A chunk that would cross either limit stays undecided; it
   * takes its own test at a later promote, once the bytes ahead of it have
   * landed.
   *
   * The size limit is what keeps `owed` — and therefore the buffer an append
   * is given, and therefore the memory a wedged syscall pins — to one capful
   * however large the burst behind it is. It cannot move a rotation for the
   * same reason the generation limit cannot: the chunk it leaves behind is
   * tested later against a `currentSize` that has advanced by exactly the
   * bytes it would otherwise have been projected past, so the test is the
   * same test with the same answer. The head is still placed unconditionally,
   * capful or not, because a single `write()` call larger than the cap must
   * overfill its generation exactly as the synchronous writer overfilled it.
   */
  private promote(): void {
    if (this.owed.length === 0) {
      const head = this.shiftPending();
      if (head === undefined) {
        return;
      }
      if (this.overflowsFile(this.currentSize, head.length)) {
        this.rotateNow();
      }
      this.owed = head;
    }
    let projected = this.currentSize + this.owed.length;
    let placed = this.owed.length;
    const taken: Buffer[] = [];
    while (
      this.pending.length > 0 &&
      !this.overflowsFile(projected, this.pending[0].length) &&
      placed + this.pending[0].length <= MAX_RETAINED_BYTES
    ) {
      const chunk = this.shiftPending()!;
      taken.push(chunk);
      projected += chunk.length;
      placed += chunk.length;
    }
    if (taken.length > 0) {
      this.owed = Buffer.concat([this.owed, ...taken]);
    }
  }

  /**
   * Hand the next append its buffer: at most one capful, off the head of
   * `owed`, and out of the writer's stages for as long as the syscall lasts.
   *
   * This is what makes the in-flight exemption a bound rather than a claim.
   * Coalescing already stops at a capful, so the whole of `owed` is normally
   * what goes — the split below only ever fires for a single `write()` call
   * larger than the cap, which promote() must place whole to keep rotation
   * per-call. That split copies rather than slicing: a view would keep the
   * oversized buffer it came from alive for as long as the kernel holds it,
   * which is precisely the memory being bounded.
   */
  private takeAppendBatch(): Buffer {
    if (this.owed.length <= MAX_RETAINED_BYTES) {
      this.inFlight = this.owed;
      this.owed = NO_BYTES;
    } else {
      this.inFlight = Buffer.from(this.owed.subarray(0, MAX_RETAINED_BYTES));
      this.owed = this.owed.subarray(MAX_RETAINED_BYTES);
    }
    return this.inFlight;
  }

  /**
   * Take back whatever the append could not land, at the head of `owed` where
   * it belongs — ahead of anything promote() placed behind it. Returns true
   * when something was left over, which is the drain's signal that the file
   * refused bytes and the retention cap should be applied.
   */
  private returnUnwritten(batch: Buffer, written: number): boolean {
    this.inFlight = NO_BYTES;
    if (written >= batch.length) {
      return false;
    }
    const rest = batch.subarray(written);
    this.owed = this.owed.length === 0 ? rest : Buffer.concat([rest, this.owed]);
    return true;
  }

  /**
   * Shift the generations for the chunk being placed, in the same synchronous
   * step as the decision that called for it.
   *
   * The descriptor is released first — Windows will not reliably rename a
   * file the process still holds open, and transcripts can live on UNC shares
   * where that is stricter still. Reacquiring one is deliberately *not* done
   * here: opening is the append path's job ({@link ensureOpen}), which
   * already retries across drains and re-reads the file's true size when it
   * succeeds. With the fallible syscall out of it, rotation itself cannot
   * fail — so "a rotation that half-happened" is not a state this writer can
   * be in, and there is nothing about a rotation to remember, resume, or
   * accidentally repeat.
   */
  private rotateNow(): void {
    // `inFlight` counts as owed: promote() only ever runs between appends, so
    // a rotation here with a syscall outstanding would be shifting generations
    // under bytes already committed to the live file.
    const stranded = this.owed.length + this.inFlight.length;
    if (stranded !== 0) {
      // Unreachable: the only call site promotes with `owed` empty, and no
      // append is outstanding while a drain is between syscalls. If a future
      // change breaks that, failing loudly here beats silently stranding
      // placed bytes in a generation they were never placed in.
      throw new Error(
        `[Nexus] Session transcript ${this.filepath}: invariant violation — rotation while ${stranded} byte(s) are still owed to the live file`
      );
    }
    this.releaseFd();
    this.shiftGenerations();
    this.currentSize = 0;
  }

  /**
   * Hold everything the writer has (`owed`, then `pending`, then `queue`) to
   * {@link MAX_RETAINED_BYTES}, shedding the oldest bytes first — placed
   * before undecided, undecided before raw, head before tail — so it is
   * exactly the newest bytes that survive. Called after a failed or short
   * drain, and from enqueue() once the append the writer is waiting on has
   * stalled; a healthy burst larger than the cap writes through without ever
   * being trimmed.
   *
   * There is no exemption to arrange here any more. The buffer a syscall owns
   * is not in `owed`, `pending` or `queue` at all — {@link takeAppendBatch}
   * takes it out and {@link returnUnwritten} puts back whatever did not land —
   * so there is nothing to skip over, no excess to discount, and no way for
   * memory the writer cannot free to make the cap shed newer bytes in its
   * place. The arithmetic that used to express that exemption is where every
   * previous shape of this cap went wrong.
   *
   * Shedding placed bytes shortens an append whose destination was already
   * settled. Shedding undecided bytes shrinks or removes chunks nothing has
   * been decided about — a shortened survivor simply takes its one rotation
   * test later, at its new size, against whatever the file really holds by
   * then. No stored decision exists to go stale, which is the difference
   * between this cap and every previous shape of it.
   *
   * `currentSize` is deliberately untouched: it counts bytes that reached the
   * file, and everything dropped here is by definition unwritten, so the drop
   * cannot move it out of step with the file on disk.
   */
  private trimRetained(): void {
    this.shedOldest(this.retainedByteCount() - MAX_RETAINED_BYTES);
  }

  /**
   * Hold the bytes that arrived *since* the current drain committed — and only
   * those — to {@link MAX_RETAINED_BYTES}. This is the cap while an append is
   * progressing: what the drain took on is on its way to the file a capful at
   * a time and must not be dropped out from under it, while arrivals behind it
   * are the growth that needs bounding. See enqueue().
   */
  private trimArrivals(): void {
    this.shedQueued(this.queuedBytes - MAX_RETAINED_BYTES);
  }

  /** Drop `excess` bytes, oldest first: placed, then undecided, then raw. */
  private shedOldest(excess: number): void {
    if (excess <= 0) {
      return;
    }
    if (excess >= this.owed.length) {
      excess -= this.owed.length;
      this.owed = NO_BYTES;
    } else {
      this.owed = cutUtf8Head(this.owed, excess);
      excess = 0;
    }
    while (excess > 0 && this.pending.length > 0) {
      const head = this.pending[0];
      if (excess >= head.length) {
        excess -= head.length;
        this.shiftPending();
      } else {
        const survivor = cutUtf8Head(head, excess);
        this.pendingBytes -= head.length - survivor.length;
        if (survivor.length === 0) {
          this.pending.shift();
        } else {
          this.pending[0] = survivor;
        }
        excess = 0;
      }
    }
    // Raw chunks last — they are the newest bytes the writer holds. Reaching
    // here means `pending` is empty (the loop above only exits with excess
    // left when it is), so the queue's head is now the oldest byte there is.
    this.shedQueued(excess);
  }

  /**
   * Drop `excess` bytes off the head of the raw queue.
   *
   * A chunk that survives a partial cut goes back to the head of the queue,
   * and it matters that it goes back *there*: `queue` is the only stage
   * {@link trimArrivals} can reach, so a survivor moved anywhere else would be
   * exempt from the arrivals cap, and a chunk-cut per enqueue would leak
   * arrivals into memory for as long as a healthy drain kept the writer busy.
   * The cut lands on a UTF-8 boundary, so the survivor re-encodes to exactly
   * the bytes it was measured as.
   */
  private shedQueued(excess: number): void {
    while (excess > 0 && this.queue.length > 0) {
      const head = this.queue.shift()!;
      const size = Buffer.byteLength(head, "utf8");
      this.queuedBytes -= size;
      if (excess >= size) {
        excess -= size;
        continue;
      }
      const survivor = cutUtf8Head(Buffer.from(head, "utf8"), excess).toString("utf8");
      this.queue.unshift(survivor);
      this.queuedBytes += Buffer.byteLength(survivor, "utf8");
      excess = 0;
    }
  }

  private drainSync(): void {
    this.ingest();
    for (;;) {
      this.promote();
      if (this.owed.length === 0) {
        return; // nothing placed and nothing left to place — fully drained
      }
      const batch = this.takeAppendBatch();
      const written = this.appendSync(batch);
      this.currentSize += written;
      if (this.returnUnwritten(batch, written)) {
        // Failure, or a short write that stopped making progress: keep what
        // is left — placed bytes stay placed — on a bounded budget.
        this.trimRetained();
        return;
      }
    }
  }

  private async drainAsync(): Promise<void> {
    if (this.closed || (this.queue.length === 0 && this.pending.length === 0 && this.owed.length === 0)) {
      return;
    }
    this.draining = true;
    try {
      this.ingest();
      for (;;) {
        this.promote();
        if (this.owed.length === 0) {
          return;
        }
        const batch = this.takeAppendBatch();
        const written = await this.appendAsync(batch);
        this.currentSize += written;
        if (this.returnUnwritten(batch, written)) {
          this.trimRetained();
          return;
        }
      }
    } catch (error) {
      // Nothing in the loop is expected to throw — the append paths catch
      // their own syscall errors — so anything caught here is a logic fault
      // worth hearing about. It must still never take down a session, and
      // must never reject the flush chain (which would strand everything
      // queued behind it). State is already consistent either way: unwritten
      // bytes are still owed or pending.
      console.error(`[Nexus] Session transcript ${this.filepath}: unexpected drain error: ${String(error)}`);
    } finally {
      this.draining = false;
    }
  }

  /**
   * Append the whole buffer, resuming after a short write. Returns how many
   * bytes reached the file — less than `data.length` means the rest is still
   * owed and the caller must retain it.
   */
  private appendSync(data: Buffer): number {
    if (!this.ensureOpen()) {
      return 0;
    }
    let offset = 0;
    while (offset < data.length) {
      let written: number;
      try {
        written = writeSync(this.fd, data, offset, data.length - offset);
      } catch {
        return offset;
      }
      if (written <= 0) {
        // No progress and no error: stop rather than spin the host thread.
        return offset;
      }
      offset += written;
    }
    return offset;
  }

  /** Asynchronous twin of {@link appendSync}, with the same contract. */
  private async appendAsync(data: Buffer): Promise<number> {
    if (!this.ensureOpen()) {
      return 0;
    }
    let offset = 0;
    while (offset < data.length) {
      let written: number;
      try {
        written = await this.writeOnce(data, offset);
      } catch {
        return offset;
      }
      if (written <= 0) {
        return offset;
      }
      offset += written;
    }
    return offset;
  }

  /**
   * One `fs.write`, with `writeStartedAt` held for exactly the window in which
   * the syscall is outstanding — including the case where `write` throws
   * outright rather than calling back, which must not leave the writer
   * believing an append is still on its way.
   */
  private writeOnce(data: Buffer, offset: number): Promise<number> {
    const fd = this.fd;
    return new Promise<number>((resolve, reject) => {
      this.writeStartedAt = Date.now();
      try {
        write(fd, data, offset, data.length - offset, (error, written) => {
          this.writeStartedAt = NO_WRITE;
          if (error) {
            reject(error);
          } else {
            resolve(written);
          }
        });
      } catch (error) {
        this.writeStartedAt = NO_WRITE;
        reject(error);
      }
    });
  }

  private readCurrentSize(): number {
    try {
      return existsSync(this.filepath) ? statSync(this.filepath).size : 0;
    } catch {
      return 0;
    }
  }

  /** Take ownership of a descriptor for the live file. */
  private openFd(): void {
    this.fd = openSync(this.filepath, "a");
  }

  /**
   * Hand the descriptor back. The field is cleared *before* the syscall, and
   * only a descriptor we still hold is closed, so `fd` can never be left
   * naming a number the process has already returned to the OS. That matters
   * more than the failure it guards: file descriptors are reused, so a second
   * `closeSync` on a stale number does not merely fail with EBADF — once the
   * number has been handed out again it closes an unrelated file belonging to
   * some other part of the extension host.
   */
  private releaseFd(): void {
    const fd = this.fd;
    this.fd = NO_FD;
    if (fd === NO_FD) {
      return;
    }
    try {
      closeSync(fd);
    } catch {
      // Already gone as far as the OS is concerned; nothing left to release.
    }
  }

  /**
   * Reacquire a descriptor after one was released — by a rotation, or by a
   * previous open that failed. Returns false if the file still cannot be
   * opened, in which case the caller's bytes stay owed and the next drain
   * tries again; this is what keeps a transient failure around rotation from
   * ending the transcript permanently. On success the accounting trusts the
   * file's own size: the descriptor is new, and the file underneath it may
   * not be the one the old accounting described.
   */
  private ensureOpen(): boolean {
    if (this.fd !== NO_FD) {
      return true;
    }
    try {
      this.openFd();
    } catch {
      return false;
    }
    this.currentSize = this.readCurrentSize();
    return true;
  }

  private shiftGenerations(): void {
    if (this.rotation.maxRotatedFiles > 0) {
      for (let index = this.rotation.maxRotatedFiles; index >= 1; index -= 1) {
        const source = index === 1 ? this.filepath : `${this.filepath}.${index - 1}`;
        const target = `${this.filepath}.${index}`;
        try {
          unlinkSync(target);
        } catch {
          // target doesn't exist
        }
        try {
          renameSync(source, target);
        } catch {
          // source doesn't exist
        }
      }
    } else {
      try {
        unlinkSync(this.filepath);
      } catch {
        // file doesn't exist
      }
    }
  }
}

/** Every transcript that has been created and not yet closed. */
const liveTranscripts = new Set<FileSessionTranscript>();

/**
 * Wait for every open transcript to get its queued tail onto disk.
 *
 * The PTYs push their tail out via `markShuttingDown()` → `flush()`, both of
 * which are `void` by contract: `markShuttingDown` is part of
 * `SessionPtyHandle` and is called from a `dispose()` — a signature VS Code
 * defines as synchronous, so even an async version could not be awaited there.
 * The awaitable half therefore lives here, on the writer that owns the queue,
 * and `deactivate()` awaits it directly.
 *
 * Bounded on purpose: a wedged fd (dead network share, hung filesystem) must
 * not hold extension-host teardown open. On timeout we give up rather than fall
 * back to `writeSync`, which on that same wedged fd would block the host thread
 * outright — a worse outcome than losing the last quarter-second of a log.
 */
export async function flushSessionTranscripts(
  timeoutMs: number = SHUTDOWN_FLUSH_TIMEOUT_MS
): Promise<void> {
  const pending = [...liveTranscripts].map((transcript) =>
    transcript.settle().catch(() => undefined)
  );
  if (pending.length === 0) {
    return;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, timeoutMs);
    (timer as { unref?: () => void }).unref?.();
  });
  try {
    await Promise.race([Promise.all(pending).then(() => undefined), expiry]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

export function createSessionTranscript(
  logDir: string,
  profileName: string,
  enabled: boolean,
  rotationOptions?: Partial<LoggerRotationOptions>
): SessionTranscript {
  if (!enabled) {
    return NOOP_TRANSCRIPT;
  }
  try {
    const safeName = profileName.replace(/[^\w.-]/g, "_");
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const filename = `${safeName}_${timestamp}.log`;
    const filepath = path.join(logDir, filename);
    return new FileSessionTranscript(filepath, normalizeLoggerRotationOptions(rotationOptions));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[Nexus] Failed to create session transcript in ${logDir}: ${message}`);
    return NOOP_TRANSCRIPT;
  }
}
