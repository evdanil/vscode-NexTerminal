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
// enqueue while a drain is in flight (see enqueue() for why that condition is
// the substance of it). Drain-time enforcement alone was not a bound, because
// the drain is not guaranteed to run: an `fs.write` whose callback never fires (a stalled
// network-share descriptor) leaves the drain awaiting forever, so `trimRetained`
// is never reached and every later drain queues behind the blocked promise,
// while terminal output keeps piling into `queue`.
//
// One thing is deliberately outside the cap: the buffer of an append that is
// currently in flight. That memory belongs to the pending syscall — dropping
// our reference frees nothing and cannot stop those bytes reaching the file —
// so counting it would only make the writer shed *newer* bytes it really could
// have kept. It is bounded on its own: promote() moves bytes between stages
// and never creates any, so an in-flight buffer is at most one capful. Total
// footprint is therefore bounded by 2 × MAX_RETAINED_BYTES, whatever the fd does.
const MAX_RETAINED_BYTES = 1024 * 1024;

// Backoff for the tail a `close()` could not land. The descriptor and the
// transcript's registration are held open across these attempts, so the budget
// is deliberately short and finite: a permanently failing fd must cost a
// bounded delay and one descriptor, not either of them for the rest of the
// session. Timers only — `close()` itself must not block terminal closure.
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
 */
function cutUtf8Head(data: Buffer, cut: number): Buffer {
  while (cut < data.length && (data[cut] & 0xc0) === 0x80) {
    cut += 1;
  }
  return data.subarray(cut);
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
 *   that would cross the boundary stays undecided until the bytes ahead of
 *   it have landed.
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
 *   destination was already settled. Neither can move a rotation.
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
   * Placed bytes: the live file's settled future content that has not reached
   * the disk yet. A failed or short write leaves its remainder here, and a
   * retry may only finish the append — nothing about these bytes is ever
   * decided again.
   */
  private owed: Buffer = NO_BYTES;
  private flushTimer?: ReturnType<typeof setTimeout>;
  private flushChain: Promise<void> = Promise.resolve();
  private draining = false;
  /**
   * True exactly while an `fs.write` is outstanding. The kernel — not this
   * class — owns `owed` for that window: trimming it would free nothing, would
   * not stop the bytes landing, and would leave the drain about to subtract a
   * written count from a buffer it no longer describes. See trimRetained().
   */
  private writeInFlight = false;
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
    this.queue = [];
    this.queuedBytes = 0;
    this.releaseFd();
    liveTranscripts.delete(this);
    console.error(
      `[Nexus] Session transcript ${this.filepath}: the last ${lost} byte(s) could not be written and have been dropped.`
    );
  }

  /** The one place `queue` grows, so `queuedBytes` cannot drift from it. */
  private pushQueued(text: string): void {
    this.queue.push(text);
    this.queuedBytes += Buffer.byteLength(text, "utf8");
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
   * data a healthy file was about to accept would be absurd. A queue over the
   * cap *while a drain is in flight* is the opposite: the fd has been handed
   * bytes and is not taking them, and everything arriving behind them is
   * growth with no end in sight. That is the wedge, and that is when shedding
   * is right. Either way `enqueue` is always within one flush interval of a
   * drain — the timer below guarantees it — so a queue can never grow for
   * longer than that without one of the two conditions resolving it.
   */
  private enqueue(text: string): void {
    this.pushQueued(text);
    if (this.draining && this.retainedByteCount() > MAX_RETAINED_BYTES) {
      this.trimRetained();
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
   * ignore the only stage that can. `pending` is walked rather than counted
   * incrementally because it holds at most one drain's worth of chunks — a
   * promote() empties it into `owed` — so the loop is short even on the hot
   * path, and one fewer running total is one fewer thing that can drift.
   */
  private retainedByteCount(): number {
    let total = this.owed.length + this.queuedBytes;
    for (const chunk of this.pending) {
      total += chunk.length;
    }
    return total;
  }

  /** Move raw queued chunks into the undecided stage, byte-accurate. */
  private ingest(): void {
    for (const chunk of this.queue) {
      this.pending.push(Buffer.from(chunk, "utf8"));
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
   * generation — a projection made of settled bytes only (`currentSize` plus
   * what is already owed), so it is a statement of fact about this file, not
   * a guess about writes that might fail. A chunk that would cross the
   * boundary stays undecided; it takes its own test at a later promote, once
   * the bytes ahead of it have landed.
   */
  private promote(): void {
    if (this.owed.length === 0) {
      const head = this.pending.shift();
      if (head === undefined) {
        return;
      }
      if (this.overflowsFile(this.currentSize, head.length)) {
        this.rotateNow();
      }
      this.owed = head;
    }
    let projected = this.currentSize + this.owed.length;
    const taken: Buffer[] = [];
    while (this.pending.length > 0 && !this.overflowsFile(projected, this.pending[0].length)) {
      const chunk = this.pending.shift()!;
      taken.push(chunk);
      projected += chunk.length;
    }
    if (taken.length > 0) {
      this.owed = Buffer.concat([this.owed, ...taken]);
    }
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
    if (this.owed.length !== 0) {
      // Unreachable: the only call site promotes with `owed` empty. If a
      // future change breaks that, failing loudly here beats silently
      // stranding placed bytes in a generation they were never placed in.
      throw new Error(
        `[Nexus] Session transcript ${this.filepath}: invariant violation — rotation while ${this.owed.length} byte(s) are still owed to the live file`
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
   * drain, and from enqueue() when a drain is already stuck; a healthy burst
   * larger than the cap writes through without ever being trimmed.
   *
   * `owed` is exempt while an append is in flight, and only then. Those bytes
   * are inside a syscall: releasing them frees no memory, does not stop them
   * reaching the file, and would leave the drain resuming against a buffer
   * that is no longer the one it wrote from. They are excluded from the excess
   * too, so their presence cannot make the cap shed newer bytes in their
   * place — which would invert the whole policy at exactly the moment it
   * matters. An in-flight buffer is bounded on its own (promote() only moves
   * bytes that were already inside the cap), so the exemption costs at most
   * one extra capful of heap and never unbounded growth.
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
    const pinned = this.writeInFlight;
    let excess = this.retainedByteCount() - MAX_RETAINED_BYTES - (pinned ? this.owed.length : 0);
    if (excess <= 0) {
      return;
    }
    if (!pinned) {
      if (excess >= this.owed.length) {
        excess -= this.owed.length;
        this.owed = NO_BYTES;
      } else {
        this.owed = cutUtf8Head(this.owed, excess);
        excess = 0;
      }
    }
    while (excess > 0 && this.pending.length > 0) {
      const head = this.pending[0];
      if (excess >= head.length) {
        excess -= head.length;
        this.pending.shift();
      } else {
        this.pending[0] = cutUtf8Head(head, excess);
        excess = 0;
      }
    }
    // Raw chunks last — they are the newest bytes the writer holds. Reaching
    // here means `pending` is empty (the loop above only exits with excess
    // left when it is), so the queue's head is now the oldest byte there is,
    // and a chunk that survives a partial cut can be handed to `pending`
    // without disturbing the order: it is the stage immediately ahead.
    while (excess > 0 && this.queue.length > 0) {
      const head = this.queue.shift()!;
      const size = Buffer.byteLength(head, "utf8");
      this.queuedBytes -= size;
      if (excess >= size) {
        excess -= size;
      } else {
        this.pending.push(cutUtf8Head(Buffer.from(head, "utf8"), excess));
        excess = 0;
      }
    }
  }

  private drainSync(): void {
    this.ingest();
    for (;;) {
      this.promote();
      if (this.owed.length === 0) {
        return; // nothing placed and nothing left to place — fully drained
      }
      const written = this.appendSync(this.owed);
      this.currentSize += written;
      this.owed = this.owed.subarray(written);
      if (this.owed.length > 0) {
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
        const written = await this.appendAsync(this.owed);
        this.currentSize += written;
        this.owed = this.owed.subarray(written);
        if (this.owed.length > 0) {
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
   * One `fs.write`, with `writeInFlight` held for exactly the window in which
   * the syscall owns `data` — including the case where `write` throws outright
   * rather than calling back, which must not leave the flag stuck on and the
   * buffer permanently exempt from the retention cap.
   */
  private writeOnce(data: Buffer, offset: number): Promise<number> {
    const fd = this.fd;
    return new Promise<number>((resolve, reject) => {
      this.writeInFlight = true;
      try {
        write(fd, data, offset, data.length - offset, (error, written) => {
          this.writeInFlight = false;
          if (error) {
            reject(error);
          } else {
            resolve(written);
          }
        });
      } catch (error) {
        this.writeInFlight = false;
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
