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

// Cap on the data a transcript holds in memory after failed writes. Retrying is
// what makes a transient EIO/ENOSPC non-lossy, but a *permanent* write failure
// on a busy session would otherwise grow the queue without limit. Past the cap
// the oldest retained bytes are dropped, so a wedged transcript costs a bounded
// amount of heap rather than the extension host.
const MAX_RETAINED_BYTES = 1024 * 1024;

// Backoff for the tail a `close()` could not land. The descriptor and the
// transcript's registration are held open across these attempts, so the budget
// is deliberately short and finite: a permanently failing fd must cost a
// bounded delay and one descriptor, not either of them for the rest of the
// session. Timers only — `close()` itself must not block terminal closure.
const CLOSE_RETRY_DELAYS_MS = [50, 250, 1000];

/** `fd` value meaning "this transcript owns no descriptor right now". */
const NO_FD = -1;

function stripTerminalCodes(data: string): string {
  return data.replace(createAnsiRegex(), "").replace(CTRL_RE, "");
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

/** One append's worth of bytes, already resolved against the rotation boundary. */
interface PendingBatch {
  /** Rotate before writing this batch. Cleared once the rotation has happened. */
  rotateFirst: boolean;
  data: Buffer;
}

/**
 * Buffered transcript writer.
 *
 * Terminal data arrives in small chunks at high frequency; a `writeSync` per
 * chunk put a blocking syscall on the render path for every one of them.
 * Chunks are queued and drained on a timer via an asynchronous append instead.
 *
 * Invariants the queue must not break:
 *
 * - **Ordering.** Drains are serialised through `flushChain`, so a drain that
 *   is still in flight when the next timer fires cannot interleave with it.
 * - **Rotation identity.** The queue is drained chunk by chunk against the same
 *   `currentSize + size > maxFileSizeBytes` test the synchronous writer applied
 *   per `write()` call, so a transcript rotates at exactly the same byte
 *   boundaries as before. Adjacent chunks that land in the same file are
 *   concatenated into one syscall; a batch is cut wherever a rotation falls.
 * - **Durability.** A write that fails, or that lands only part of its buffer,
 *   leaves the unwritten bytes queued for the next drain instead of dropping
 *   them. `currentSize` only ever advances by bytes that actually reached the
 *   file, so rotation cannot drift out of step with the file on disk.
 * - **Descriptor ownership.** `fd` holds a descriptor this transcript owns, or
 *   {@link NO_FD}. It is never left holding a number the process has already
 *   handed back — see {@link releaseFd}.
 */
class FileSessionTranscript implements SessionTranscript {
  /** Open descriptor, or {@link NO_FD} when none is currently owned. */
  private fd: number = NO_FD;
  private currentSize: number;
  private closed = false;
  private queue: string[] = [];
  /**
   * Batches a previous drain could not write, or could only partly write. They
   * go out at the head of the next drain, ahead of anything queued since, so a
   * transient failure costs a retry rather than the data. Their rotation has
   * already been resolved (and, for the batch that failed, already applied).
   */
  private retained: PendingBatch[] = [];
  private flushTimer?: ReturnType<typeof setTimeout>;
  private flushChain: Promise<void> = Promise.resolve();
  private draining = false;
  /**
   * The generations have been shifted but no descriptor has been acquired for
   * the new file yet — a rotation that got half-way. A retry must finish it,
   * not restart it: shifting twice would move the just-rotated content another
   * generation along, and at `maxRotatedFiles: 1` would delete it outright.
   */
  private rotationShifted = false;
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
      if (this.retained.length > 0) {
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
    this.queue.push(footer);
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
   * when it does the tail and the session footer sit in `retained`. Closing the
   * descriptor and deregistering here would put them out of reach of every
   * retry path there is, which loses precisely the bytes retention exists to
   * keep. So a failed drain keeps both, and a timer retries on a short, finite
   * budget. `close()` itself stays synchronous and returns immediately either
   * way: terminal closure must not wait on a wedged filesystem.
   */
  private finishClose(): void {
    this.clearCloseRetryTimer();
    this.drainSync();
    if (this.retained.length > 0) {
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
    const lost = this.retained.reduce((total, batch) => total + batch.data.length, 0);
    this.retained = [];
    this.releaseFd();
    liveTranscripts.delete(this);
    console.error(
      `[Nexus] Session transcript ${this.filepath}: the last ${lost} byte(s) could not be written and have been dropped.`
    );
  }

  private enqueue(text: string): void {
    this.queue.push(text);
    if (this.flushTimer === undefined) {
      this.flushTimer = setTimeout(() => {
        this.flushTimer = undefined;
        this.flushChain = this.flushChain.then(() => this.drainAsync());
      }, FLUSH_INTERVAL_MS);
      // Never hold the host process open for a transcript flush.
      (this.flushTimer as { unref?: () => void }).unref?.();
    }
  }

  private clearFlushTimer(): void {
    if (this.flushTimer !== undefined) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
  }

  /**
   * The rotation rule, in one place: does appending `size` bytes to a file
   * already holding `projectedSize` push it past the boundary? Every path that
   * resolves a rotation goes through here, because the class's rotation
   * identity is precisely that this one test is applied the same way the
   * synchronous writer applied it — two copies of it drifting apart is how that
   * identity gets lost.
   */
  private overflowsFile(projectedSize: number, size: number): boolean {
    return projectedSize + size > this.rotation.maxFileSizeBytes;
  }

  /**
   * Walk a projected file size forward through `batches` and return where it
   * ends up: each batch either resets the projection (it rotates first) or adds
   * to it, so the walk describes what the live file holds once the whole
   * sequence has been written.
   *
   * `resolve` decides what happens to each batch's `rotateFirst`:
   *
   * - `false` — take it as given, and only move the projection. Retained
   *   batches reach a drain in this state: their rotation was settled when they
   *   were cut, and for the remainder a partial write left behind it has
   *   already been *applied*, so recomputing would rotate that batch twice.
   * - `true` — recompute it. Correct only once the projection those flags were
   *   decided against no longer holds, which is exactly what dropping retained
   *   bytes does — and it invalidates *every* surviving batch, not just the
   *   first, since each one was sized against a file the dropped bytes were
   *   going to fill.
   */
  private projectRotation(batches: PendingBatch[], startSize: number, resolve: boolean): number {
    let projectedSize = startSize;
    for (const batch of batches) {
      const size = batch.data.length;
      if (resolve) {
        batch.rotateFirst = this.overflowsFile(projectedSize, size);
      }
      if (batch.rotateFirst) {
        projectedSize = 0;
      }
      projectedSize += size;
    }
    return projectedSize;
  }

  /**
   * Split the queue into batches that each land inside one file generation,
   * applying rotation between batches. Returns the batches in write order —
   * anything retained from a failed drain first — and leaves the queue empty;
   * the caller performs the writes.
   */
  private takeBatches(): PendingBatch[] {
    const batches = this.retained;
    this.retained = [];

    // Retained batches have already been sized against the rotation boundary;
    // they only move the projection along so the chunks queued behind them
    // rotate exactly where they would have without the failure.
    let projectedSize = this.projectRotation(batches, this.currentSize, false);

    let current: { rotateFirst: boolean; text: string } | undefined;
    const fresh: Array<{ rotateFirst: boolean; text: string }> = [];
    for (const chunk of this.queue) {
      const size = Buffer.byteLength(chunk, "utf8");
      const rotates = this.overflowsFile(projectedSize, size);
      if (rotates) {
        projectedSize = 0;
      }
      if (current === undefined || rotates) {
        current = { rotateFirst: rotates, text: chunk };
        fresh.push(current);
      } else {
        current.text += chunk;
      }
      projectedSize += size;
    }
    this.queue = [];

    for (const batch of fresh) {
      batches.push({ rotateFirst: batch.rotateFirst, data: Buffer.from(batch.text, "utf8") });
    }
    return batches;
  }

  /**
   * Put back everything a drain did not write: the batch it stopped in, minus
   * the bytes that did land, followed by every batch after it. Order is
   * preserved — retained batches go out ahead of whatever was queued while the
   * failed drain was running.
   *
   * No retry timer is armed from here. A live session enqueues again within
   * milliseconds and takes the retained bytes with it; an idle one flushes on
   * disconnect or close. Re-arming would spin a permanently failing fd forever.
   */
  private retainFrom(batches: PendingBatch[], index: number, written: number): void {
    const batch = batches[index];
    const remainder = written > 0 ? batch.data.subarray(written) : batch.data;
    const rest = batches.slice(index + 1);
    if (remainder.length > 0) {
      rest.unshift({ rotateFirst: batch.rotateFirst, data: remainder });
    }
    this.retained = rest.concat(this.retained);
    this.trimRetained();
  }

  /**
   * Hold the retained queue to {@link MAX_RETAINED_BYTES}, keeping the newest
   * bytes.
   *
   * Whole batches are shed oldest-first, and the last one standing is *not*
   * exempt from the cap: `takeBatches()` coalesces every adjacent chunk bound
   * for the same file into one batch, so a single batch can be an entire
   * rotation generation — 10 MiB by default, up to 1 GiB when configured — and
   * one `write()` can be larger still. Exempting it let a permanently failing
   * fd retain orders of magnitude more than the stated bound. It is trimmed
   * from the head instead, which keeps the same tail-most bytes that shedding
   * oldest-first keeps.
   *
   * `currentSize` is deliberately untouched: it counts bytes that reached the
   * file, and everything dropped here is by definition unwritten, so the drop
   * cannot move it out of step with the file on disk. What the drop *does*
   * invalidate is the projection every surviving batch's `rotateFirst` was
   * decided against — that projection assumed the dropped bytes would land. So
   * the whole surviving sequence is re-resolved against the real file size,
   * exactly as `takeBatches()` resolves freshly queued chunks.
   *
   * The head alone is not enough. Re-resolving it can flip its rotation either
   * way, and every batch behind it was projected against the file that flip
   * decides the shape of: a head that no longer rotates leaves the bytes behind
   * it landing in a file that is already part-full, so a stale `rotateFirst:
   * false` further down overruns `maxFileSizeBytes`, while a stale `true`
   * shifts a generation (and, at `maxRotatedFiles: 1`, deletes one) to make
   * room in a file the lost bytes never filled.
   */
  private trimRetained(): void {
    let total = 0;
    for (const batch of this.retained) {
      total += batch.data.length;
    }
    if (total <= MAX_RETAINED_BYTES) {
      return;
    }
    while (total > MAX_RETAINED_BYTES && this.retained.length > 1) {
      total -= this.retained.shift()!.data.length;
    }
    const head = this.retained[0];
    if (head === undefined) {
      return;
    }
    if (total > MAX_RETAINED_BYTES) {
      let cut = total - MAX_RETAINED_BYTES;
      // Never cut mid-glyph: step forward off any UTF-8 continuation byte. That
      // drops at most three more bytes, so it cannot push the total back over.
      while (cut < head.data.length && (head.data[cut] & 0xc0) === 0x80) {
        cut += 1;
      }
      head.data = head.data.subarray(cut);
    }
    this.projectRotation(this.retained, this.currentSize, true);
  }

  /**
   * Perform the rotation a batch asks for. Returns false if the rotation itself
   * failed, in which case the batch and everything after it has been retained.
   */
  private applyRotation(batches: PendingBatch[], index: number): boolean {
    const batch = batches[index];
    if (!batch.rotateFirst) {
      return true;
    }
    try {
      this.rotate();
    } catch {
      this.retainFrom(batches, index, 0);
      return false;
    }
    // The rotation has happened; a retry of this batch must not repeat it.
    batch.rotateFirst = false;
    this.currentSize = 0;
    return true;
  }

  private drainSync(): void {
    const batches = this.takeBatches();
    for (let index = 0; index < batches.length; index += 1) {
      const batch = batches[index];
      if (!this.applyRotation(batches, index)) {
        return;
      }
      const written = this.appendSync(batch.data);
      this.currentSize += written;
      if (written < batch.data.length) {
        this.retainFrom(batches, index, written);
        return;
      }
    }
  }

  private async drainAsync(): Promise<void> {
    if (this.closed || (this.queue.length === 0 && this.retained.length === 0)) {
      return;
    }
    this.draining = true;
    try {
      const batches = this.takeBatches();
      for (let index = 0; index < batches.length; index += 1) {
        const batch = batches[index];
        if (!this.applyRotation(batches, index)) {
          return;
        }
        const written = await this.appendAsync(batch.data);
        this.currentSize += written;
        if (written < batch.data.length) {
          // Short write or hard failure: keep the rest for the next drain
          // rather than dropping this batch and every batch behind it.
          this.retainFrom(batches, index, written);
          return;
        }
      }
    } catch {
      // A failed transcript write must never take down a session, and must
      // never reject the flush chain (which would strand everything queued
      // behind it). The append paths already retain what they could not write.
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

  private writeOnce(data: Buffer, offset: number): Promise<number> {
    const fd = this.fd;
    return new Promise<number>((resolve, reject) => {
      write(fd, data, offset, data.length - offset, (error, written) =>
        error ? reject(error) : resolve(written)
      );
    });
  }

  private readCurrentSize(): number {
    try {
      return existsSync(this.filepath) ? statSync(this.filepath).size : 0;
    } catch {
      return 0;
    }
  }

  /**
   * Take ownership of a descriptor for the live file. The assignment and the
   * half-rotated flag move together, so a successful open always cancels a
   * rotation that was left part-finished.
   */
  private openFd(): void {
    this.fd = openSync(this.filepath, "a");
    this.rotationShifted = false;
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
   * Reacquire a descriptor after one was lost — a rotation whose open failed,
   * or a give-up that released it. Returns false if the file still cannot be
   * opened, in which case the caller retains its bytes and the next drain
   * tries again. This is what keeps a transient failure during rotation from
   * ending the transcript permanently.
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
    // The descriptor is new and the file underneath it may not be the one the
    // old accounting described, so trust the file's own size.
    this.currentSize = this.readCurrentSize();
    return true;
  }

  /**
   * Rotate the file: release the live descriptor, shift the generations, open
   * the new file.
   *
   * The descriptor has to be released before the renames — Windows will not
   * reliably rename a file the process still holds open, and transcripts can
   * live on UNC shares where that is stricter still — so there is unavoidably
   * a window with no descriptor. What must not happen is that window becoming
   * permanent: if the open throws, `fd` stays {@link NO_FD} (never the closed
   * number), `rotationShifted` records that the renames are already done, and
   * the next attempt finishes the rotation rather than restarting it.
   */
  private rotate(): void {
    if (this.rotationShifted) {
      // The renames already happened; only the descriptor is still owed.
      this.openFd();
      return;
    }
    this.releaseFd();
    this.shiftGenerations();
    this.rotationShifted = true;
    this.openFd();
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
