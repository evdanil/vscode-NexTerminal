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

// Ceiling on the bytes a transcript holds in memory, across every stage the
// writer keeps them in (`pending`, `owed`). Enforced at the one point
// bytes enter the writer and nowhere else — see admit() — so the bound
// depends on nothing downstream: not on a drain running, not on the descriptor
// answering, not on further output ever arriving.
//
// The cap is deliberately unconditional. Its predecessor shed only when it
// judged the outstanding append "wedged rather than merely slow", and that
// judgement was wrong in both directions: a healthy append outstanding longer
// than one flush interval read as wedged, so a latency spike shed bytes the
// drain was still going to write; while a descriptor trickling one byte per
// short write reset the clock on every retry and never read as wedged at all,
// leaving the pre-drain backlog unbounded. No replacement signal can do
// better, because the two cases are not distinct: over any horizon, a
// descriptor slower than the session produces output is byte-for-byte a wedge
// as far as memory is concerned. What the cap actually bounds is backlog, so
// backlog is the only thing it reads.
//
// That makes the value the entire policy, so it is generous where the old
// 1 MiB was tight: an 8 MiB `cat` over SSH is an ordinary burst, and this is
// eight times that. On any descriptor that eventually accepts its bytes, a
// transcript is byte-perfect unless the session out-produced 64 MiB of
// unwritten backlog — the point past which holding more would be trading the
// extension host's heap for a log file. A permanently wedged descriptor pins
// at most this much, plus the one append buffer the kernel already holds
// (MAX_APPEND_BYTES). Internal tuning constant, not a user-facing promise;
// tests inject smaller values so the bound stays checkable without
// gigabyte-sized fixtures.
const DEFAULT_MAX_RETAINED_BYTES = 64 * 1024 * 1024;

// Upper bound on the buffer one append syscall is handed, and therefore on
// `inFlight` — the one allocation the retention cap cannot reclaim, because
// dropping our reference to a buffer the kernel is reading frees nothing and
// cannot stop those bytes reaching the file. promote() stops coalescing at
// this size and takeAppendBatch() splits an oversized `owed` against it, so
// the exemption is bounded by construction rather than by argument: total
// footprint is the retention cap of retained bytes plus at most one of these
// inside the syscall, whatever the fd does and whatever shape the output
// arrives in.
const MAX_APPEND_BYTES = 1024 * 1024;

// Backoff for the tail a `close()` could not land. The descriptor and the
// transcript's registration are held open across these attempts, so the budget
// is deliberately short and finite: a permanently failing fd must cost a
// bounded delay and one descriptor, not either of them for the rest of the
// session. Timers only — `close()` returns without waiting for any of them
// (though the attempt it makes on the spot is a writeSync, which a wedged
// descriptor can stall in; see finishClose()).
const CLOSE_RETRY_DELAYS_MS = [50, 250, 1000];

/** `fd` value meaning "this transcript owns no descriptor right now". */
const NO_FD = -1;

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
 * exists to reclaim. The copy is bounded by the retention cap and only happens
 * on the shedding path.
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
 * - **Undecided** — `pending`: byte-accurate chunks, one per `write()` call,
 *   encoded to UTF-8 in the same synchronous step that admitted them. No
 *   rotation decision of any kind is attached to them, and none has been made
 *   about them — the types cannot even express one. There is no separate
 *   raw-string stage: encoding at admission means the writer never holds a
 *   chunk in two representations, so the footprint bound below holds at every
 *   instant, including mid-drain. (The old drain-time conversion held the
 *   entire raw queue and its encoded copy simultaneously — a transient
 *   footprint of twice the retention cap that no stated invariant covered.)
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
 *   past one append batch — stays undecided until the bytes ahead of it have
 *   landed. Both limits stop coalescing in the same way and neither moves a
 *   boundary: a chunk left behind takes its own test at a later promote,
 *   against a `currentSize` that has advanced by exactly the bytes it would
 *   have been projected past.
 * - **Durability.** A write that fails, or that lands only part of its
 *   buffer, leaves the unwritten bytes in `owed` for the next drain instead
 *   of dropping them. `currentSize` only ever advances by bytes that actually
 *   reached the file, so rotation cannot drift out of step with the disk.
 * - **Bounded.** Everything the writer holds — `pending` and `owed` — is
 *   capped at `maxRetainedBytes`, enforced in {@link admit}: the single
 *   point bytes enter the writer, so the bound holds for any arrival
 *   pattern and any descriptor behaviour, including a lone chunk larger than
 *   the cap followed by silence. Nothing is ever shed below the cap — not
 *   for a slow append, not for a failed drain, not for a wedge — and above
 *   it the oldest bytes go first, so exactly the newest survive. Dropping
 *   undecided bytes invalidates nothing — no decision was made about them or
 *   against them. Dropping placed bytes only shortens an append whose
 *   destination was already settled. Neither can move a rotation. The one
 *   thing outside the cap is `inFlight`, the buffer the kernel is holding,
 *   and it is one {@link MAX_APPEND_BYTES} batch at most because that is all
 *   an append is ever given — and, since {@link takeAppendBatch} never hands
 *   over a view of something larger, one batch of *pinned memory* rather than
 *   just one batch of bytes written. So the whole footprint is at most
 *   `maxRetainedBytes` + {@link MAX_APPEND_BYTES}, at every instant: no
 *   drain stage re-encodes or duplicates what admission already holds, and
 *   the remainder of a short write goes back where it came from rather than
 *   being concatenated in front of what is still owed. Two transients sit on
 *   top, both bounded by one `write()` call that admission already trimmed to
 *   the cap: the chunk being admitted, which exists as the caller's string
 *   and the writer's buffer for the duration of one {@link admit} call; and a
 *   single call larger than one batch, which is drained in place — `owed`
 *   walks it as a view — so the whole of it stays alive while the cap counts
 *   only the part still unwritten.
 *
 *   One consequence of that second transient is worth stating outright,
 *   because the arithmetic above does not make it obvious. If an admission
 *   trims while such a chunk is still being walked, {@link shedOldest} cuts a
 *   survivor out of a view whose parent is still referenced, so parent and
 *   survivor coexist for the duration of the copy — close to twice the cap at
 *   that instant — and the copy itself runs synchronously inside
 *   {@link admit}, on the terminal output path: measured at 32–41 ms for a
 *   62.9 MiB survivor, to shed an excess that is at most one arriving chunk.
 *   Reachability is the only thing that makes this acceptable: it needs a
 *   single `write()` of tens of MiB, and every shipped transport delivers
 *   ≤ ~64 KiB per call (ssh2 channel data, serial sidecar reads). If a future
 *   caller can hand this writer a chunk that large, shed by re-deriving a
 *   `subarray` from the split record instead of copying — the length guard in
 *   {@link returnUnwritten} then correctly falls back to concatenation,
 *   because contiguity really has been broken.
 * - **Descriptor ownership.** `fd` holds a descriptor this transcript owns,
 *   or {@link NO_FD}. It is never left holding a number the process has
 *   already handed back — see {@link releaseFd}.
 */
class FileSessionTranscript implements SessionTranscript {
  /** Open descriptor, or {@link NO_FD} when none is currently owned. */
  private fd: number = NO_FD;
  private currentSize: number;
  private closed = false;
  /**
   * Undecided bytes, one buffer per `write()` call, oldest first, encoded at
   * admission. Placement is decided in {@link promote} and nowhere else —
   * these carry no flags.
   */
  private pending: Buffer[] = [];
  /**
   * Byte size of `pending`, maintained incrementally: the retention cap is
   * consulted once per chunk on the hot path, and `pending` is not
   * guaranteed to be short — a burst larger than one append batch stays
   * there, chunk by chunk, while the drain works through it.
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
   * Set exactly while `owed` is a *view* of a larger buffer it was split from
   * — the state a single `write()` call bigger than one append batch leaves
   * behind — rather than an allocation that stands on its own. Holds that
   * buffer and the view itself, so the pairing is checkable by identity:
   * every other path that touches `owed` replaces it with a fresh object (see
   * {@link setOwed}), so a stale record can never be mistaken for a live one.
   *
   * It exists so {@link returnUnwritten} can put a short write's remainder
   * back by re-deriving the view — the unwritten head of the batch and
   * everything owed behind it are one contiguous run of that same buffer —
   * instead of concatenating a copy of the remainder in front of it. The
   * concatenation allocated prefix + suffix while the parent and the batch
   * copy were both still live: measured at ≈17 MiB transient for one 8 MiB
   * write whose first append failed.
   */
  private owedSplitFrom?: { parent: Buffer; view: Buffer };
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
  /** True while a drain is queued on `flushChain` and has not started yet. */
  private drainQueued = false;
  private closeAttempt = 0;
  private closeRetryTimer?: ReturnType<typeof setTimeout>;

  public constructor(
    private readonly filepath: string,
    private readonly rotation: LoggerRotationOptions,
    /** Retention cap — see {@link DEFAULT_MAX_RETAINED_BYTES} for the policy. */
    private readonly maxRetainedBytes: number
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
    this.admit(footer);
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
   * does not wait for those retries: they are timers, and terminal closure
   * returns without them.
   *
   * It is not, however, non-blocking. The drain below is {@link drainSync},
   * which is {@link writeSync}, and on a descriptor that is wedged rather than
   * failing — a hard-mounted NFS export in D-state, a dead UNC share — that
   * syscall blocks the extension host for whatever the kernel's timeout is,
   * once per attempt, so up to four times across the retry budget. That is
   * accepted rather than overlooked: the writer this replaced took the same
   * exposure on *every chunk* of a session, and the tail of a transcript is
   * the part worth a bounded stall. Extension-host teardown draws the line
   * differently — see {@link flushSessionTranscripts}, which refuses
   * `writeSync` outright because a stall there eats a budget VS Code is about
   * to end by force.
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
    this.setOwed(NO_BYTES);
    this.pending = [];
    this.pendingBytes = 0;
    this.releaseFd();
    liveTranscripts.delete(this);
    console.error(
      `[Nexus] Session transcript ${this.filepath}: the last ${lost} byte(s) could not be written and have been dropped.`
    );
  }

  /**
   * The one place bytes enter the writer — `write()` chunks, the session
   * header, the close() footer — so the one place the retention cap is
   * enforced. The chunk is encoded to UTF-8 here, in the same synchronous
   * step that accepts it: from this point on the writer holds exactly one
   * representation of every byte, so no later stage can double the footprint
   * by converting a backlog it is still holding (the defect the old
   * drain-time `ingest()` had). Every stage downstream of here only moves
   * bytes between stages or removes them, so holding the bound at admission
   * holds it everywhere, for any arrival pattern: a chunk larger than the
   * whole cap is trimmed in this same synchronous step, never left for an
   * enforcement that would only run if more output happened to arrive.
   * No syscall and no queue walk: one UTF-8 encode (the same O(n) the old
   * shape spent on `Buffer.byteLength` here and `Buffer.from` at drain
   * time, now paid once), a comparison, and — only when the cap is crossed
   * — a shed of the oldest bytes.
   */
  private admit(text: string): void {
    this.pushPending(Buffer.from(text, "utf8"));
    if (this.retainedByteCount() > this.maxRetainedBytes) {
      this.trimRetained();
    }
  }

  /** The one place `pending` grows, so `pendingBytes` cannot drift from it. */
  private pushPending(chunk: Buffer): void {
    if (chunk.length === 0) {
      return;
    }
    this.pending.push(chunk);
    this.pendingBytes += chunk.length;
  }

  /**
   * Replace `owed` with a buffer that stands on its own, dropping any split
   * record with it — the record describes one exact view, and every path
   * through here produces a different object. The two paths that deliberately
   * leave a view behind ({@link takeAppendBatch}'s split and
   * {@link returnUnwritten}'s re-derivation) set the record themselves.
   */
  private setOwed(next: Buffer): void {
    this.owed = next;
    this.owedSplitFrom = undefined;
  }

  /**
   * The buffer `owed` is currently a view of, or undefined when it stands on
   * its own. Verified by identity rather than trusted: anything that replaced
   * `owed` since the record was written — a trim shedding into it while an
   * append was outstanding, most of all — leaves a different object here.
   */
  private owedSplit(): { parent: Buffer; view: Buffer } | undefined {
    const split = this.owedSplitFrom;
    if (split === undefined) {
      return undefined;
    }
    if (split.view !== this.owed) {
      this.owedSplitFrom = undefined;
      return undefined;
    }
    return split;
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
   * Take a chunk off the hot path. Admission — and with it the retention cap,
   * see {@link admit} — is synchronous and cheap; everything that can
   * block happens later, on the drain the timer schedules. There is nothing
   * here about what the descriptor is doing, and that is the design: the old
   * shape of this method shed differently depending on whether it judged the
   * outstanding append slow or wedged, and the judgement was wrong in both
   * directions (see {@link DEFAULT_MAX_RETAINED_BYTES}).
   */
  private enqueue(text: string): void {
    this.admit(text);
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
   * takes on everything the writer holds at the moment it finally runs.
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
   * Every byte this writer is holding: placed but unwritten (`owed`) and
   * undecided (`pending`). Both stages, and not a subset — a raw-string
   * stage used to sit in front of these and was once excluded from the
   * count, which made the cap measure the stages that cannot grow while a
   * write is wedged and ignore the only one that could. Encoding at
   * admission removed that stage outright.
   *
   * `inFlight` is deliberately not here, and it is the only thing that is not.
   * Those bytes are inside a syscall: counting them would make the cap shed
   * newer bytes to compensate for memory it cannot free anyway. They are held
   * to one batch by {@link takeAppendBatch} instead, so the exemption costs a
   * bounded {@link MAX_APPEND_BYTES} rather than requiring an argument about
   * arrival patterns.
   */
  private retainedByteCount(): number {
    return this.owed.length + this.pendingBytes;
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
   * generation *and* keep the placed buffer inside one append batch
   * ({@link MAX_APPEND_BYTES}) — a projection made of settled bytes only
   * (`currentSize` plus what is already owed), so it is a statement of fact
   * about this file, not a guess about writes that might fail. A chunk that
   * would cross either limit stays undecided; it takes its own test at a
   * later promote, once the bytes ahead of it have landed.
   *
   * The size limit is what keeps `owed` — and therefore the buffer an append
   * is given, and therefore the memory a wedged syscall pins — to one batch
   * however large the burst behind it is. It cannot move a rotation for the
   * same reason the generation limit cannot: the chunk it leaves behind is
   * tested later against a `currentSize` that has advanced by exactly the
   * bytes it would otherwise have been projected past, so the test is the
   * same test with the same answer. The head is still placed unconditionally,
   * batch-sized or not, because a single `write()` call larger than a batch
   * must overfill its generation exactly as the synchronous writer overfilled
   * it.
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
      this.setOwed(head);
    }
    let projected = this.currentSize + this.owed.length;
    let placed = this.owed.length;
    const taken: Buffer[] = [];
    while (
      this.pending.length > 0 &&
      !this.overflowsFile(projected, this.pending[0].length) &&
      placed + this.pending[0].length <= MAX_APPEND_BYTES
    ) {
      const chunk = this.shiftPending()!;
      taken.push(chunk);
      projected += chunk.length;
      placed += chunk.length;
    }
    if (taken.length > 0) {
      this.setOwed(Buffer.concat([this.owed, ...taken]));
    }
  }

  /**
   * Hand the next append its buffer: at most one {@link MAX_APPEND_BYTES}
   * batch, off the head of `owed`, and out of the writer's stages for as long
   * as the syscall lasts.
   *
   * This is what makes the in-flight exemption a bound rather than a claim,
   * and the bound is on *pinned* memory, not just on the byte count the kernel
   * is asked to write: whatever this hands over, nothing bigger than a batch
   * stays alive on its account for the duration of the syscall.
   *
   * Coalescing already stops at a batch, so the whole of `owed` is normally
   * what goes — the split below only ever fires for a single `write()` call
   * larger than a batch, which promote() must place whole to keep rotation
   * per-call. Two rules follow from the bound, and both are about views:
   *
   * - The split copies its prefix rather than slicing it. A view would keep
   *   the oversized buffer it came from alive for as long as the kernel holds
   *   it, which is precisely the memory being bounded.
   * - The *last* slice of such a buffer is copied for the same reason. It is
   *   at most one batch long, so the untracked version handed it over as it
   *   was — a view pinning every already-written byte of its parent behind it,
   *   several batches of memory inside an exemption that claims one. Copying
   *   it out releases the parent.
   *
   * The suffix left in `owed` mid-split stays a view: it is what the next
   * batch comes off, and the parent it holds alive is bounded by the retention
   * cap, which trimmed the chunk at admission before it ever reached a drain.
   * That is also the one place the cap under-reports what the writer holds —
   * it counts the unwritten suffix, while the whole chunk stays alive until
   * its last batch is taken — and it is bounded by that chunk, which is to say
   * by one `write()` call that admission already held to the cap.
   */
  private takeAppendBatch(): Buffer {
    const split = this.owedSplit();
    if (this.owed.length <= MAX_APPEND_BYTES) {
      this.inFlight = split === undefined ? this.owed : Buffer.from(this.owed);
      this.setOwed(NO_BYTES);
    } else {
      const parent = this.owed;
      this.inFlight = Buffer.from(parent.subarray(0, MAX_APPEND_BYTES));
      this.owed = parent.subarray(MAX_APPEND_BYTES);
      this.owedSplitFrom = { parent, view: this.owed };
    }
    return this.inFlight;
  }

  /**
   * Take back whatever the append could not land, at the head of `owed` where
   * it belongs — ahead of anything promote() placed behind it. Returns true
   * when something was left over, which is the drain's signal that the file
   * refused bytes and the loop should stop rather than spin.
   *
   * When the batch was split off a larger buffer that is still intact behind
   * it, the two halves are put back by re-deriving the view — the unwritten
   * head of the batch and everything owed behind it are one contiguous run of
   * that buffer, so nothing needs allocating at all. The general path has to
   * concatenate, and for an oversized chunk that concatenation is the whole
   * remainder copied while the parent and the batch are both still live. It
   * stays as the fallback for the case the re-derivation cannot cover: a trim
   * that shed into `owed` while the append was outstanding, which leaves a
   * buffer the batch is no longer the head of.
   */
  private returnUnwritten(batch: Buffer, written: number): boolean {
    this.inFlight = NO_BYTES;
    if (written >= batch.length) {
      return false;
    }
    const split = this.owedSplit();
    // The length test is the proof that `batch` really is the head this view
    // was cut after, so re-deriving from `written` cannot skip or repeat a
    // byte; it costs nothing and does not rely on the call order holding.
    if (split !== undefined && split.parent.length - split.view.length === batch.length) {
      this.owed = split.parent.subarray(written);
      this.owedSplitFrom = { parent: split.parent, view: this.owed };
      return true;
    }
    const rest = batch.subarray(written);
    this.setOwed(this.owed.length === 0 ? rest : Buffer.concat([rest, this.owed]));
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
   * Hold everything the writer has (`owed`, then `pending`) to
   * `maxRetainedBytes`, shedding the oldest bytes first — placed before
   * undecided, head before tail — so it is exactly the newest bytes that
   * survive. Reached only from {@link admit}, when an admission crosses the
   * cap: shedding is a function of how much the writer holds, never of what
   * the descriptor is doing. The writer holds no opinion
   * on whether an outstanding append is slow or wedged, because every opinion
   * it could form was wrong in one direction or the other — see
   * {@link DEFAULT_MAX_RETAINED_BYTES} for that history.
   *
   * There is no exemption to arrange here. The buffer a syscall owns is not
   * in `owed` or `pending` at all — {@link takeAppendBatch} takes it
   * out and {@link returnUnwritten} puts back whatever did not land — so
   * there is nothing to skip over, no excess to discount, and no way for
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
    this.shedOldest(this.retainedByteCount() - this.maxRetainedBytes);
  }

  /**
   * Drop `excess` bytes, oldest first: placed, then undecided. A pending
   * chunk that survives a partial cut stays at the head of `pending`, where
   * the next admission's cap check can still see it — a survivor moved
   * anywhere else would drift out of the stage its byte count is tracked in.
   */
  private shedOldest(excess: number): void {
    if (excess <= 0) {
      return;
    }
    if (excess >= this.owed.length) {
      excess -= this.owed.length;
      this.setOwed(NO_BYTES);
    } else {
      this.setOwed(cutUtf8Head(this.owed, excess));
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
  }

  private drainSync(): void {
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
        // is left — placed bytes stay placed — for the next drain to retry.
        // No trim here: the retained total was within the cap before the
        // append took its batch out, and nothing in a drain grows it back.
        return;
      }
    }
  }

  private async drainAsync(): Promise<void> {
    if (this.closed || (this.pending.length === 0 && this.owed.length === 0)) {
      return;
    }
    this.draining = true;
    try {
      for (;;) {
        this.promote();
        if (this.owed.length === 0) {
          return;
        }
        const batch = this.takeAppendBatch();
        const written = await this.appendAsync(batch);
        this.currentSize += written;
        if (this.returnUnwritten(batch, written)) {
          // Unwritten bytes stay placed for the retry, as in drainSync — but
          // not for the same reason about the cap. The synchronous drain
          // cannot be interleaved with; this one awaits, and admissions during
          // that await can have refilled `retained` all the way to the cap, so
          // handing the batch back can leave it at cap + up to one batch until
          // the next admission trims. That is a per-stage overshoot, not a
          // footprint one: `inFlight` is empty at this instant, and the bytes
          // being counted twice against the cap are the same bytes the
          // exemption stopped counting when the batch was taken out. Trimming
          // here instead would shed bytes a retry is about to write, to
          // restore an invariant that the total bound does not need.
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
   * One `fs.write` as a promise. A synchronous throw from `write` rejects via
   * the executor, so the caller's catch sees both failure shapes the same
   * way. Nothing is timed here: how long the syscall stays outstanding is not
   * a signal this writer reads any more.
   */
  private writeOnce(data: Buffer, offset: number): Promise<number> {
    const fd = this.fd;
    return new Promise<number>((resolve, reject) => {
      write(fd, data, offset, data.length - offset, (error, written) => {
        if (error) {
          reject(error);
        } else {
          resolve(written);
        }
      });
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

export interface SessionTranscriptOptions extends Partial<LoggerRotationOptions> {
  /**
   * Retention cap override — see {@link DEFAULT_MAX_RETAINED_BYTES} for the
   * policy the value carries. Internal tuning knob, not a user-facing
   * setting: tests inject small values so the bound is checkable without
   * gigabyte-sized fixtures. Values below one append batch (or otherwise
   * unusable) fall back to the default.
   */
  maxRetainedBytes?: number;
}

function normalizeRetainedCap(value?: number): number {
  if (value === undefined || !Number.isFinite(value) || value < MAX_APPEND_BYTES) {
    return DEFAULT_MAX_RETAINED_BYTES;
  }
  return Math.floor(value);
}

export function createSessionTranscript(
  logDir: string,
  profileName: string,
  enabled: boolean,
  options?: SessionTranscriptOptions
): SessionTranscript {
  if (!enabled) {
    return NOOP_TRANSCRIPT;
  }
  try {
    const safeName = profileName.replace(/[^\w.-]/g, "_");
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const filename = `${safeName}_${timestamp}.log`;
    const filepath = path.join(logDir, filename);
    return new FileSessionTranscript(
      filepath,
      normalizeLoggerRotationOptions(options),
      normalizeRetainedCap(options?.maxRetainedBytes)
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[Nexus] Failed to create session transcript in ${logDir}: ${message}`);
    return NOOP_TRANSCRIPT;
  }
}
