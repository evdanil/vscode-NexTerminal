/*
 * Handler tests for the nexus.fs main-thread implementation (scriptFs.ts).
 *
 * Two schemes, two mocking strategies:
 *  - `file:` reads go through `node:fs/promises` directly now (P1 — bounded
 *    native read, see scriptFs.ts's `boundedReadFile`), so `node:fs/promises`
 *    is PARTIALLY mocked below: every export passes through to the real
 *    implementation except `stat`, which is wrapped in a `vi.fn` (still
 *    delegating to the real `stat` by default) so individual tests can
 *    `mockImplementationOnce` a lying stat for the "stat lies" cases. Setup
 *    calls (`writeFile`, `mkdir`, `symlink`, ...) all still hit the real disk.
 *  - Non-`file` reads keep going through `vscode.workspace.fs.stat` /
 *    `.readFile`, mocked below the same way as before (real disk for `file:`
 *    Uris passed to it — only `exists()` still uses this for `file:` — and a
 *    synthetic `.path`-addressed store for remote Uris).
 *
 * House rule (CLAUDE.md): every test must fail against the specific wrong
 * implementation it prevents. Each block below names its target-wrong-impl (⊘).
 */
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const FileType = { Unknown: 0, File: 1, Directory: 2, SymbolicLink: 64 } as const;

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    // Wrapped, not replaced — defaults to the real implementation so every
    // OTHER test's fixture setup (writeFile/mkdir/symlink/...) and every OTHER
    // test's read path work unchanged. Only tests that explicitly
    // `mockImplementationOnce` see different behavior, and only for that one
    // call. `open` is wrapped too (still real) purely so tests can assert it
    // was never CALLED — the early-reject-before-opening test needs that —
    // and so the concurrency-gate test can install a slow-but-still-real
    // `mockImplementation` (via `__realOpen`, the un-wrapped original) that
    // tracks how many opens are in flight at once.
    stat: vi.fn(actual.stat),
    open: vi.fn(actual.open),
    __realOpen: actual.open
  };
});

vi.mock("vscode", () => {
  const FileTypeEnum = { Unknown: 0, File: 1, Directory: 2, SymbolicLink: 64 };

  /**
   * Synthetic remote filesystem, keyed by Uri `.path` (never `.fsPath`) —
   * exactly what a real remote FileSystemProvider is addressed by. Exported
   * out of the mock (via `__remoteFiles`) so tests can seed it directly.
   */
  const remoteFiles = new Map<string, { content: Uint8Array; isDir?: boolean }>();

  class FakeUri {
    public constructor(
      public scheme: string,
      public authority: string,
      public path: string,
      public fsPath: string,
      public query = "",
      public fragment = ""
    ) {}
    public with(changes: Partial<{ scheme: string; authority: string; path: string; query: string; fragment: string }>): FakeUri {
      const newScheme = changes.scheme ?? this.scheme;
      const newPath = changes.path ?? this.path;
      // Recompute fsPath from the new path, mirroring real vscode.Uri.with()
      // (fsPath is DERIVED from path, not independently settable). For a
      // non-file scheme the decoy prefix is deliberate: it guarantees fsPath
      // and path diverge, so a handler that mistakenly reads `.fsPath` for a
      // remote Uri fails loudly (an ENOENT lookup on a key nothing seeded)
      // instead of silently working because a fixture happened to keep
      // path === fsPath.
      const newFsPath = newScheme === "file" ? newPath : `/LOCAL-DECOY-DO-NOT-USE${newPath}`;
      return new FakeUri(newScheme, changes.authority ?? this.authority, newPath, newFsPath, changes.query ?? this.query, changes.fragment ?? this.fragment);
    }
    public toString(): string {
      return `${this.scheme}://${this.authority}${this.path}`;
    }
  }

  /** A `vscode-remote://`-style Uri whose `.fsPath` is deliberately bogus — see FakeUri.with() above. */
  function remoteUri(authority: string, p: string): FakeUri {
    return new FakeUri("vscode-remote", authority, p, `/LOCAL-DECOY-DO-NOT-USE${p}`);
  }

  function notFound(remotePath: string): Error {
    return Object.assign(new Error(`ENOENT (remote): ${remotePath}`), { code: "FileNotFound" });
  }

  const statMock = vi.fn(async (uri: { scheme: string; fsPath: string; path: string }) => {
    if (uri.scheme !== "file") {
      const entry = remoteFiles.get(uri.path);
      if (!entry) throw notFound(uri.path);
      return { type: entry.isDir ? FileTypeEnum.Directory : FileTypeEnum.File, ctime: 0, mtime: 0, size: entry.content.byteLength };
    }
    const lst = await fsp.lstat(uri.fsPath);
    let type = 0;
    let sizeSource = lst;
    if (lst.isSymbolicLink()) {
      type |= FileTypeEnum.SymbolicLink;
      const real = await fsp.stat(uri.fsPath); // follows the link
      sizeSource = real;
      type |= real.isDirectory() ? FileTypeEnum.Directory : FileTypeEnum.File;
    } else {
      type |= lst.isDirectory() ? FileTypeEnum.Directory : FileTypeEnum.File;
    }
    return { type, ctime: sizeSource.ctimeMs, mtime: sizeSource.mtimeMs, size: sizeSource.size };
  });

  const readFileMock = vi.fn(async (uri: { scheme: string; fsPath: string; path: string }) => {
    if (uri.scheme !== "file") {
      const entry = remoteFiles.get(uri.path);
      if (!entry || entry.isDir) throw notFound(uri.path);
      return entry.content;
    }
    const buf = await fsp.readFile(uri.fsPath);
    return new Uint8Array(buf);
  });

  return {
    FileType: FileTypeEnum,
    Uri: {
      file: (p: string) => new FakeUri("file", "", p, p)
    },
    workspace: {
      fs: {
        stat: statMock,
        readFile: readFileMock
      }
    },
    __remoteFiles: remoteFiles,
    __remoteUri: remoteUri
  };
});

import * as vscode from "vscode";
import {
  scriptFsExists,
  scriptFsReadText,
  buildScriptFsScope,
  boundedReadFile,
  initialReadCapacity,
  createSemaphore,
  SCRIPT_FS_MAX_CONCURRENT_READS,
  SCRIPT_FS_READ_TIMEOUT_MS,
  SCRIPT_FS_MAX_ORPHANED_READS,
  type ScriptFsContext
} from "../../../src/services/scripts/scriptFs";

const statSpy = vscode.workspace.fs.stat as unknown as ReturnType<typeof vi.fn>;
const readFileSpy = vscode.workspace.fs.readFile as unknown as ReturnType<typeof vi.fn>;
const remoteFiles = (vscode as unknown as { __remoteFiles: Map<string, { content: Uint8Array; isDir?: boolean }> }).__remoteFiles;
const remoteUri = (vscode as unknown as { __remoteUri: (authority: string, p: string) => vscode.Uri }).__remoteUri;
/** `node:fs/promises`'s `stat`, wrapped (not replaced) — see the vi.mock above. */
const nodeStatSpy = fsp.stat as unknown as ReturnType<typeof vi.fn>;
/** `node:fs/promises`'s `open`, wrapped (not replaced) — see the vi.mock above. */
const nodeOpenSpy = fsp.open as unknown as ReturnType<typeof vi.fn>;
/** The real (un-wrapped) `open`, for tests that need to stay on real disk while still overriding the spy's `mockImplementation`. */
const realNodeOpen = (fsp as unknown as { __realOpen: typeof fsp.open }).__realOpen;

// -----------------------------------------------------------------------------
// Fixture harness
// -----------------------------------------------------------------------------

let tmpRoot: string;

beforeEach(async () => {
  vi.clearAllMocks();
  remoteFiles.clear();
  tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "nexus-scriptfs-"));
});

afterEach(async () => {
  await fsp.rm(tmpRoot, { recursive: true, force: true });
});

function fileUri(p: string): vscode.Uri {
  return vscode.Uri.file(p) as vscode.Uri;
}

/** Standard scope: scriptDir = <root>/cisco, one level under scriptsRoot = <root>. */
async function makeCtx(overrides?: Partial<ScriptFsContext>): Promise<{ ctx: ScriptFsContext; root: string; scriptDir: string; log: ReturnType<typeof vi.fn> }> {
  const root = tmpRoot;
  const scriptDir = path.join(root, "cisco");
  await fsp.mkdir(scriptDir, { recursive: true });
  const log = vi.fn();
  const ctx: ScriptFsContext = {
    scriptUri: fileUri(path.join(scriptDir, "probe.js")),
    scriptDirUri: fileUri(scriptDir),
    scriptsRootUri: fileUri(root),
    log,
    isAborted: () => false,
    ...overrides
  };
  return { ctx, root, scriptDir, log };
}

/** Polls `predicate` until true or `timeoutMs` elapses (rejects on timeout). */
async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("waitFor: timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/**
 * A resolver-controlled promise — for mocking a "stalled" I/O call that a
 * test can release on demand (rather than a bare `new Promise(() => {})`,
 * which would hang FOREVER and, once round 11's orphan tracking exists,
 * leave `orphanedReads` permanently incremented for every OTHER test sharing
 * this file's module instance). Every test that stalls a call via this
 * helper MUST eventually resolve it before the test ends.
 */
function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/**
 * Registers exactly `n` fresh `mockImplementationOnce` hangs on `nodeOpenSpy`,
 * each gated by its own `deferred()`. Callers MUST arrange for exactly `n`
 * real `open()` calls to consume these — registering more than will actually
 * be called leaves unconsumed `mockImplementationOnce` entries queued on the
 * shared spy, which `vi.clearAllMocks()` in `beforeEach` does NOT clear and
 * which would then apply to a later, unrelated test's `open()` calls.
 */
function gateOpens(n: number): Array<{ resolve: () => void }> {
  const gates = Array.from({ length: n }, () => deferred<void>());
  gates.forEach((gate) => {
    nodeOpenSpy.mockImplementationOnce(async (...args: Parameters<typeof realNodeOpen>) => {
      await gate.promise;
      return realNodeOpen(...args);
    });
  });
  return gates;
}

// -----------------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------------

describe("scriptFsReadText — size cap (file: scheme, bounded native read — P1)", () => {
  it("reads a file exactly at the 4 MiB boundary", async () => {
    const { ctx, scriptDir } = await makeCtx();
    const exact = Buffer.alloc(4 * 1024 * 1024, "a");
    await fsp.writeFile(path.join(scriptDir, "exact.bin"), exact);

    const text = await scriptFsReadText("exact.bin", ctx);
    expect(text.length).toBe(4 * 1024 * 1024);
  });

  it("refuses a file one byte over the 4 MiB boundary with FileTooLarge", async () => {
    // ⊘ a >= / off-by-one in either direction.
    const { ctx, scriptDir } = await makeCtx();
    const over = Buffer.alloc(4 * 1024 * 1024 + 1, "a");
    await fsp.writeFile(path.join(scriptDir, "over.bin"), over);

    // TOP-LEVEL sizeBytes/maxBytes, not nested under `.extra` — this is what
    // the docs and the d.ts promise (`err.sizeBytes`), and what
    // scriptRuntimeManager.ts's extraFieldsOf/reviveError round-trip expects
    // to find as plain own properties on the error. ⊘ makeFsError nesting
    // these fields under a property literally named "extra". (This file is
    // exactly maxBytes + 1, so it can't tell apart "reported the true size"
    // from "reported the maxBytes+1 floor" — see the next test for that.)
    await expect(scriptFsReadText("over.bin", ctx)).rejects.toMatchObject({
      code: "FileTooLarge",
      sizeBytes: 4 * 1024 * 1024 + 1,
      maxBytes: 4 * 1024 * 1024
    });
  });

  it("reports the TRUE size (not the maxBytes+1 floor) when an honest stat already knows the file is well over the cap", async () => {
    // ⊘ always reporting `maxBytes + 1` regardless of what stat says — for a
    // file whose real size is 5 MiB (stat correctly reports 5 MiB, not the
    // 4 MiB + 1 the boundedReadFile floor would give), a script catching this
    // error and logging `err.sizeBytes` deserves the true, more informative
    // number when it's available and trustworthy. Deliberately a DIFFERENT
    // file size than the "one byte over" test above, so the two numbers
    // (5 MiB vs. 4 MiB + 1) can't be confused with each other.
    const { ctx, scriptDir } = await makeCtx();
    await fsp.writeFile(path.join(scriptDir, "wayover.bin"), Buffer.alloc(5 * 1024 * 1024, "a"));

    await expect(scriptFsReadText("wayover.bin", ctx)).rejects.toMatchObject({
      code: "FileTooLarge",
      sizeBytes: 5 * 1024 * 1024,
      maxBytes: 4 * 1024 * 1024
    });
    // Rejected from stat alone — the file was never opened for reading.
    expect(nodeOpenSpy).not.toHaveBeenCalled();
  });

  it("rejects BEFORE opening the file when stat already reports an over-cap size — no I/O for an honestly-oversized file, worst on a slow network-backed file: mount", async () => {
    // ⊘ the pre-fix implementation, which always ran the file through
    // boundedReadFile (an open + capped read) regardless of what stat said,
    // paying for I/O even when stat already knew the file was too large. A
    // mocked stat — decoupled from the real (tiny) file on disk — proves the
    // rejection is driven by stat.size ALONE, before any open() call: if the
    // implementation still opened the file first, this would either read the
    // real 4-byte content (no FileTooLarge at all) or, if it also trusted the
    // mocked size correctly but only after opening, `open` would still have
    // been called — either way this test would catch it.
    const { ctx, scriptDir } = await makeCtx();
    const filePath = path.join(scriptDir, "small-but-lies-big.bin");
    await fsp.writeFile(filePath, "tiny"); // really 4 bytes on disk
    const claimedSize = 10 * 1024 * 1024; // 10 MiB, far over the cap
    nodeStatSpy.mockImplementationOnce(
      async () => ({ isFile: () => true, isDirectory: () => false, size: claimedSize }) as unknown as import("node:fs").Stats
    );

    await expect(scriptFsReadText("small-but-lies-big.bin", ctx)).rejects.toMatchObject({
      code: "FileTooLarge",
      sizeBytes: claimedSize,
      maxBytes: 4 * 1024 * 1024
    });
    expect(nodeOpenSpy).not.toHaveBeenCalled();
  });

  it("caps memory via a bounded native read: a lying node fs.stat (small reported size) does NOT defeat the post-read cap on a real oversized file", async () => {
    // ⊘ P1 — trusting `node:fs`'s stat.size (or, before this fix,
    // vscode.workspace.fs.readFile's unbounded result) instead of what
    // boundedReadFile actually reads off disk. This is the exact hazard: a
    // lying provider, or a file that grew between stat and read, must not let
    // an oversized file's FULL body reach the extension host.
    const { ctx, scriptDir } = await makeCtx();
    const filePath = path.join(scriptDir, "lies.bin");
    await fsp.writeFile(filePath, Buffer.alloc(5 * 1024 * 1024, "a")); // really 5 MiB
    nodeStatSpy.mockImplementationOnce(
      async () => ({ isFile: () => true, isDirectory: () => false, size: 10 }) as unknown as import("node:fs").Stats
    );

    await expect(scriptFsReadText("lies.bin", ctx)).rejects.toMatchObject({
      code: "FileTooLarge",
      // stat's claimed 10 bytes is untrustworthy (it disagrees with what was
      // actually read) — the floor estimate boundedReadFile itself guarantees
      // is reported instead of repeating the lie.
      sizeBytes: 4 * 1024 * 1024 + 1,
      maxBytes: 4 * 1024 * 1024
    });
  });
});

describe("scriptFsReadText — size cap (non-file scheme, best-effort — P1)", () => {
  it("catches a lying vscode.workspace.fs.stat (size: 0) via the post-read byteLength check — the only enforcement available for a remote FileSystemProvider", async () => {
    // ⊘ trusting `stat.size` alone and skipping the post-read check. Unlike
    // the file: scheme (bounded native read above), there is no bounded-read
    // API on vscode.workspace.fs — this check protects CORRECTNESS (the
    // script never sees more than the cap) but is best-effort for peak
    // extension-host memory: readFile itself is still unbounded here.
    const authority = "wsl+ubuntu";
    const scriptDirPath = "/home/u/scripts/cisco";
    const big = new Uint8Array(5 * 1024 * 1024).fill(97); // really 5 MiB
    remoteFiles.set(`${scriptDirPath}/lies.bin`, { content: big });
    statSpy.mockImplementationOnce(async () => ({ type: FileType.File, ctime: 0, mtime: 0, size: 0 }));

    const ctx: ScriptFsContext = {
      scriptUri: remoteUri(authority, `${scriptDirPath}/probe.js`),
      scriptDirUri: remoteUri(authority, scriptDirPath),
      scriptsRootUri: undefined,
      log: vi.fn(),
      isAborted: () => false
    };

    await expect(scriptFsReadText("lies.bin", ctx)).rejects.toMatchObject({ code: "FileTooLarge" });
    // Unlike the file: scheme's pre-open regular-file/size checks, the body
    // WAS read here — that's the point: stat lied, so only the post-read
    // check (the only one available for this scheme) catches it.
    expect(readFileSpy).toHaveBeenCalledTimes(1);
  });
});

describe("initialReadCapacity — pure boundary matrix (P1: size-hint-driven allocation)", () => {
  const MAX = 4 * 1024 * 1024;

  it("clamps to [0, maxBytes] before adding 1, for the full boundary matrix", () => {
    // ⊘ an implementation that always returns maxBytes + 1 regardless of the
    // hint — every row below except the "at/over the cap" ones would then
    // return the SAME (4 MiB + 1) value, which this table-driven assertion
    // would catch immediately.
    const cases: Array<[hint: number, expected: number]> = [
      [0, 1], // empty file
      [200, 201], // tiny honest file — the whole point of this fix
      [MAX - 1, MAX], // just under the cap
      [MAX, MAX + 1], // exactly at the cap
      [MAX + 1, MAX + 1], // an honest stat already over the cap — clamped, not MAX+2
      [MAX * 10, MAX + 1], // wildly over — still clamped to the cap, never more
      [-1, 1], // a negative/hostile hint never allocates less than 1 byte
      [-1000, 1]
    ];
    for (const [hint, expected] of cases) {
      expect(initialReadCapacity(hint, MAX)).toBe(expected);
    }
  });
});

describe("boundedReadFile — direct unit coverage (P1)", () => {
  it("returns exactly maxBytes for a file exactly at the boundary (honest hint)", async () => {
    const { scriptDir } = await makeCtx();
    const filePath = path.join(scriptDir, "exact.bin");
    await fsp.writeFile(filePath, Buffer.alloc(4 * 1024 * 1024, "a"));

    const bytes = await boundedReadFile(filePath, 4 * 1024 * 1024, 4 * 1024 * 1024);
    expect(bytes.byteLength).toBe(4 * 1024 * 1024);
  });

  it("never returns more than maxBytes + 1 bytes, even for a file well over the cap (honest hint)", async () => {
    // ⊘ a helper that reads the whole file (e.g. via fs.readFile) and slices
    // the result afterward — that would still allocate the FULL body before
    // truncating, defeating the entire point. The only way to reliably
    // produce exactly maxBytes + 1 here, for a 6 MiB file, is to actually cap
    // the read itself.
    const { scriptDir } = await makeCtx();
    const filePath = path.join(scriptDir, "huge.bin");
    await fsp.writeFile(filePath, Buffer.alloc(6 * 1024 * 1024, "b")); // well over the cap

    const bytes = await boundedReadFile(filePath, 4 * 1024 * 1024, 6 * 1024 * 1024);
    expect(bytes.byteLength).toBe(4 * 1024 * 1024 + 1);
  });

  it("returns the whole (short) file when it's under the cap, including empty files (honest hints)", async () => {
    const { scriptDir } = await makeCtx();
    const short = path.join(scriptDir, "short.txt");
    await fsp.writeFile(short, "hello");
    expect((await boundedReadFile(short, 4 * 1024 * 1024, 5)).toString("utf8")).toBe("hello");

    const empty = path.join(scriptDir, "empty.txt");
    await fsp.writeFile(empty, "");
    expect((await boundedReadFile(empty, 4 * 1024 * 1024, 0)).byteLength).toBe(0);
  });

  it("allocates from the size hint for a small honest file — NOT always the full 4 MiB cap", async () => {
    // ⊘ preallocating maxBytes + 1 for every call regardless of the hint —
    // `Promise.all(paths.map(nexus.fs.readText))` over a few hundred tiny
    // files would then transiently allocate gigabytes.
    const { scriptDir } = await makeCtx();
    const filePath = path.join(scriptDir, "tiny.bin");
    const content = Buffer.alloc(200, "x");
    await fsp.writeFile(filePath, content);

    const allocSpy = vi.spyOn(Buffer, "allocUnsafe");
    try {
      const bytes = await boundedReadFile(filePath, 4 * 1024 * 1024, 200);
      expect(bytes.byteLength).toBe(200);
      expect(bytes.equals(content)).toBe(true);
      expect(allocSpy).toHaveBeenCalledWith(201);
      expect(allocSpy).not.toHaveBeenCalledWith(4 * 1024 * 1024 + 1);
    } finally {
      allocSpy.mockRestore();
    }
  });

  it("grows ONCE when the hint under-reports an under-cap file — full content still returned, not truncated at the (wrong) hint", async () => {
    // ⊘ a no-growth implementation, which would silently TRUNCATE the return
    // value at the too-small hint instead of recovering — a script would get
    // 4 bytes of a 10 KiB file back with no error at all.
    const { scriptDir } = await makeCtx();
    const filePath = path.join(scriptDir, "undercap-lied.bin");
    const content = Buffer.alloc(10 * 1024, "y"); // 10 KiB, well under the 4 MiB cap
    await fsp.writeFile(filePath, content);

    const bytes = await boundedReadFile(filePath, 4 * 1024 * 1024, 4); // hint claims 4 bytes
    expect(bytes.byteLength).toBe(10 * 1024);
    expect(bytes.equals(content)).toBe(true);
  });

  it("grows ONCE when the hint under-reports an over-cap file — still correctly yields cap+1 bytes (the stat-lies/growth defense, untouched)", async () => {
    // ⊘ a no-growth implementation, which would return only the (wrong,
    // small) hint's worth of bytes — under the cap — and the caller would
    // never see FileTooLarge at all for a file that genuinely exceeds it.
    const { scriptDir } = await makeCtx();
    const filePath = path.join(scriptDir, "overcap-lied.bin");
    await fsp.writeFile(filePath, Buffer.alloc(6 * 1024 * 1024, "z")); // 6 MiB, over the cap

    const bytes = await boundedReadFile(filePath, 4 * 1024 * 1024, 4); // hint claims 4 bytes
    expect(bytes.byteLength).toBe(4 * 1024 * 1024 + 1);
  });
});

describe("createSemaphore — direct unit coverage (P1: host-side FIFO concurrency gate)", () => {
  it("runs at most `limit` tasks concurrently, all `limit`-plus tasks eventually complete, and admits waiters in FIFO submission order", async () => {
    // ⊘ an ungated (or badly-gated) implementation — e.g. one that increments
    // `available` on release without handing the slot to a waiter, letting a
    // fresh acquire() race ahead of one already queued — would let `peak`
    // exceed the limit and/or scramble the admission order.
    const limit = 4;
    const sem = createSemaphore(limit);
    let concurrent = 0;
    let peak = 0;
    const startedOrder: number[] = [];

    async function task(id: number): Promise<number> {
      await sem.acquire();
      try {
        concurrent++;
        peak = Math.max(peak, concurrent);
        startedOrder.push(id);
        await new Promise<void>((resolve) => setTimeout(resolve, 10));
        return id;
      } finally {
        concurrent--;
        sem.release();
      }
    }

    const results = await Promise.all(Array.from({ length: 10 }, (_, i) => task(i)));

    expect(peak).toBeLessThanOrEqual(limit);
    expect(peak).toBeGreaterThan(0);
    expect(results).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]); // all 10 completed
    // FIFO fairness: submitted 0..9 in order; the first `limit` acquire
    // synchronously (before any of them can finish), so admission order for
    // the rest tracks release order, which tracks submission order here.
    expect(startedOrder).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it("acquire() resolves immediately (no queueing) while slots remain", async () => {
    const sem = createSemaphore(2);
    let resolved = false;
    sem.acquire().then(() => {
      resolved = true;
    });
    // A real microtask tick is enough for an unqueued acquire() to settle;
    // ⊘ an implementation that always queues (even with slots free) would
    // need an explicit release() first, which never happens here.
    await Promise.resolve();
    await Promise.resolve();
    expect(resolved).toBe(true);
  });
});

describe("scriptFsReadText — release-on-error, no deadlock across the concurrency gate (P1)", () => {
  it("readSemaphore releases its slot even when the gated read throws — subsequent reads never deadlock behind a failing batch", async () => {
    // ⊘ releasing the semaphore only on the success path (e.g. no `finally`,
    // or a `release()` call placed only after `return text`) — every one of
    // the SCRIPT_FS_MAX_CONCURRENT_READS failing calls below would leak its
    // permit, and the read that follows would then wait forever for a slot
    // that never frees (this test's own timeout is what would catch that).
    const { ctx, scriptDir } = await makeCtx();
    const failing = await Promise.all(
      Array.from({ length: SCRIPT_FS_MAX_CONCURRENT_READS }, (_, i) =>
        scriptFsReadText(`missing-${i}.txt`, ctx).catch((e: unknown) => e)
      )
    );
    for (const err of failing) {
      expect(err).toMatchObject({ code: "FileNotFound" });
    }

    await fsp.writeFile(path.join(scriptDir, "ok.txt"), "hi");
    const text = await scriptFsReadText("ok.txt", ctx);
    expect(text).toBe("hi");
  });
});

describe("scriptFsReadText — global concurrency gate (P1: bounds host-side transient allocation)", () => {
  it("10 concurrent readText calls over small real files all succeed — no deadlock through the gate", async () => {
    const { ctx, scriptDir } = await makeCtx();
    const n = 10;
    for (let i = 0; i < n; i++) {
      await fsp.writeFile(path.join(scriptDir, `f${i}.txt`), `content-${i}`);
    }

    const results = await Promise.all(Array.from({ length: n }, (_, i) => scriptFsReadText(`f${i}.txt`, ctx)));
    results.forEach((text, i) => expect(text).toBe(`content-${i}`));
  });

  it("caps concurrent file opens at SCRIPT_FS_MAX_CONCURRENT_READS — a 5th-and-beyond call waits for a slot instead of opening immediately", async () => {
    // ⊘ an ungated scriptFsReadText — every one of the 10 concurrent calls
    // below would call `open` immediately, so peak concurrent opens would
    // equal however many calls were issued at once (10), not the configured
    // limit (4).
    const { ctx, scriptDir } = await makeCtx();
    const n = 10;
    for (let i = 0; i < n; i++) {
      await fsp.writeFile(path.join(scriptDir, `slow${i}.txt`), `content-${i}`);
    }

    let inFlight = 0;
    let peakInFlight = 0;
    nodeOpenSpy.mockImplementation(async (...args: Parameters<typeof realNodeOpen>) => {
      inFlight++;
      peakInFlight = Math.max(peakInFlight, inFlight);
      await new Promise<void>((resolve) => setTimeout(resolve, 15));
      try {
        return await realNodeOpen(...args);
      } finally {
        inFlight--;
      }
    });

    try {
      const results = await Promise.all(Array.from({ length: n }, (_, i) => scriptFsReadText(`slow${i}.txt`, ctx)));
      results.forEach((text, i) => expect(text).toBe(`content-${i}`));
      expect(peakInFlight).toBeGreaterThan(0);
      expect(peakInFlight).toBeLessThanOrEqual(SCRIPT_FS_MAX_CONCURRENT_READS);
    } finally {
      // Restore the wrapped-but-real default so every OTHER test keeps
      // hitting the real filesystem unchanged.
      nodeOpenSpy.mockImplementation(realNodeOpen as never);
    }
  }, 10_000);
});

describe("scriptFsReadText — aborting the run drains its queued reads off the GLOBAL semaphore (P1: no starvation of other sessions)", () => {
  it("reads still queued when the run ends never open the file, all settle (rejected Stopped), and the semaphore is left fully drained for a fresh, unrelated read", async () => {
    // ⊘ a `scriptFsReadText` with no `isAborted()` check after `acquire()` at
    // all — every one of the 6 reads still queued when the run "ends" below
    // would, one by one as slots free up, still open and read its file, log
    // a normal audit line, and try to post a result to a dead worker: this is
    // the starvation this fix exists to prevent. The assertion that actually
    // discriminates is `nodeOpenSpy` staying at exactly
    // SCRIPT_FS_MAX_CONCURRENT_READS — WITHOUT the fix it climbs to 10.
    const { ctx, scriptDir } = await makeCtx();
    const n = 10;
    for (let i = 0; i < n; i++) {
      await fsp.writeFile(path.join(scriptDir, `q${i}.txt`), `content-${i}`);
    }

    let aborted = false;
    const abortableCtx: ScriptFsContext = { ...ctx, isAborted: () => aborted };

    // Deferred opens: each call gets its own resolver, so the test controls
    // exactly when each ADMITTED read's I/O completes instead of racing
    // timers — the "release the in-flight ones" step needs to be explicit
    // and deterministic, not a fixed delay.
    const openWaiters: Array<() => void> = [];
    nodeOpenSpy.mockImplementation(async (...args: Parameters<typeof realNodeOpen>) => {
      await new Promise<void>((resolve) => openWaiters.push(resolve));
      return realNodeOpen(...args);
    });

    try {
      const promises = Array.from({ length: n }, (_, i) => scriptFsReadText(`q${i}.txt`, abortableCtx));

      // Let exactly SCRIPT_FS_MAX_CONCURRENT_READS reads acquire the
      // semaphore and reach `open()` — the other 6 are still queued on it.
      await waitFor(() => nodeOpenSpy.mock.calls.length >= SCRIPT_FS_MAX_CONCURRENT_READS);
      expect(nodeOpenSpy.mock.calls.length).toBe(SCRIPT_FS_MAX_CONCURRENT_READS);
      expect(openWaiters).toHaveLength(SCRIPT_FS_MAX_CONCURRENT_READS);

      // The run ends here — while 6 reads are still parked on the semaphore.
      aborted = true;

      // Now let the SCRIPT_FS_MAX_CONCURRENT_READS in-flight opens finish.
      // As each releases its slot, the queued reads get admitted in turn —
      // and each must see `isAborted()` immediately and bail before ever
      // reaching `open()`.
      openWaiters.forEach((resolve) => resolve());

      const results = await Promise.all(promises.map((p) => p.catch((e: unknown) => e)));
      expect(results).toHaveLength(n);

      // The 4 already in flight before the abort complete normally (a
      // preemptive design isn't what's being asked for — only QUEUED reads
      // are skipped); the 6 that were still queued reject Stopped.
      const succeeded = results.filter((r) => typeof r === "string");
      const stopped = results.filter((r): r is Error & { code?: string } => r instanceof Error);
      expect(succeeded).toHaveLength(SCRIPT_FS_MAX_CONCURRENT_READS);
      expect(stopped).toHaveLength(n - SCRIPT_FS_MAX_CONCURRENT_READS);
      for (const err of stopped) {
        expect(err.code).toBe("Stopped");
      }

      // The discriminating assertion: open() was NEVER called for the 6
      // skipped reads — the count stays exactly where it was before the
      // abort, it does not climb toward 10.
      expect(nodeOpenSpy.mock.calls.length).toBe(SCRIPT_FS_MAX_CONCURRENT_READS);
    } finally {
      // Restore BEFORE the starvation check below — it does its own real
      // open() and must not hang on a deferred resolver nothing will ever call.
      nodeOpenSpy.mockImplementation(realNodeOpen as never);
    }

    // Starvation check: the semaphore is fully drained (back to its full
    // limit) — a FRESH read from a NON-aborted context proceeds immediately,
    // not stuck behind anything left over from the dead run.
    const freshStart = Date.now();
    const freshText = await scriptFsReadText("q0.txt", ctx); // ctx: isAborted() => false
    expect(freshText).toBe("content-0");
    expect(Date.now() - freshStart).toBeLessThan(500);
  }, 10_000);

  it("the cheap pre-acquire early-out: an aborted call started while the semaphore is fully occupied settles immediately, without waiting in the FIFO queue", async () => {
    // ⊘ removing the `isAborted()` check BEFORE `acquire()` specifically: the
    // AFTER-acquire check alone would still eventually catch this call, but
    // only once it reached the front of the semaphore's FIFO queue — i.e.
    // only after waiting behind however long the busy reads below take. WITH
    // the early-out, it settles near-instantly regardless of how busy the
    // semaphore is, because it never calls `acquire()` at all.
    const { ctx, scriptDir } = await makeCtx();
    for (let i = 0; i < SCRIPT_FS_MAX_CONCURRENT_READS; i++) {
      await fsp.writeFile(path.join(scriptDir, `busy${i}.txt`), "x");
    }
    await fsp.writeFile(path.join(scriptDir, "already-dead.txt"), "irrelevant");

    const openWaiters: Array<() => void> = [];
    nodeOpenSpy.mockImplementation(async (...args: Parameters<typeof realNodeOpen>) => {
      await new Promise<void>((resolve) => openWaiters.push(resolve));
      return realNodeOpen(...args);
    });

    try {
      // Occupy every slot with slow reads that won't complete until told to.
      const busyPromises = Array.from({ length: SCRIPT_FS_MAX_CONCURRENT_READS }, (_, i) =>
        scriptFsReadText(`busy${i}.txt`, ctx)
      );
      await waitFor(() => nodeOpenSpy.mock.calls.length >= SCRIPT_FS_MAX_CONCURRENT_READS);

      // The semaphore has zero free slots. Issue the aborted call now.
      const deadCtx: ScriptFsContext = { ...ctx, isAborted: () => true };
      const start = Date.now();
      await expect(scriptFsReadText("already-dead.txt", deadCtx)).rejects.toMatchObject({ code: "Stopped" });
      expect(Date.now() - start).toBeLessThan(100);

      openWaiters.forEach((resolve) => resolve());
      await Promise.all(busyPromises);
    } finally {
      nodeOpenSpy.mockImplementation(realNodeOpen as never);
    }
  });

  it("scriptFsExists also gets the cheap pre-check — an aborted context's exists() probe throws Stopped without stat'ing anything", async () => {
    const { ctx, scriptDir } = await makeCtx();
    await fsp.writeFile(path.join(scriptDir, "already-dead.txt"), "irrelevant");
    const deadCtx: ScriptFsContext = { ...ctx, isAborted: () => true };

    statSpy.mockClear();
    await expect(scriptFsExists("already-dead.txt", deadCtx)).rejects.toMatchObject({ code: "Stopped" });
    expect(statSpy).not.toHaveBeenCalled();
  });

  it("the OR'd predicate (round 10, P2 — the stopScript grace-race window): a queued read granted a permit while ONLY a stop has been requested (cleanedUp still false) is rejected Stopped and never opens the file", async () => {
    // ⊘ `isAborted` wired to `record.cleanedUp` ALONE (dropping the
    // `|| record.stopReason !== undefined` half added in round 10). In the
    // real `stopScript`, `record.stopReason` is set SYNCHRONOUSLY at the very
    // top — before the up-to-100ms `worker.terminate()` grace race — while
    // `record.cleanedUp` only flips once `cleanupRun` runs, AFTER that race
    // settles. A read that was already queued on the semaphore and gets
    // GRANTED a permit during that window would, under the cleanedUp-only
    // predicate, see isAborted() === false (cleanedUp hasn't flipped yet) and
    // wrongly proceed to open() and succeed — exactly the starvation-adjacent
    // hazard this fix closes. `cleanedUp` and `stopRequested` here stand in
    // for the two real record fields, OR'd exactly as fsContextFor OR's them.
    const { ctx, scriptDir } = await makeCtx();
    const n = SCRIPT_FS_MAX_CONCURRENT_READS + 1; // exactly one call ends up genuinely queued
    for (let i = 0; i < n; i++) {
      await fsp.writeFile(path.join(scriptDir, `w${i}.txt`), `content-${i}`);
    }

    let cleanedUp = false;
    let stopRequested = false;
    const windowCtx: ScriptFsContext = { ...ctx, isAborted: () => cleanedUp || stopRequested };

    const openWaiters: Array<() => void> = [];
    nodeOpenSpy.mockImplementation(async (...args: Parameters<typeof realNodeOpen>) => {
      await new Promise<void>((resolve) => openWaiters.push(resolve));
      return realNodeOpen(...args);
    });

    try {
      const promises = Array.from({ length: n }, (_, i) => scriptFsReadText(`w${i}.txt`, windowCtx));

      // Fill the pool — the (n)th call is the one genuinely queued on the semaphore.
      await waitFor(() => nodeOpenSpy.mock.calls.length >= SCRIPT_FS_MAX_CONCURRENT_READS);
      expect(nodeOpenSpy.mock.calls.length).toBe(SCRIPT_FS_MAX_CONCURRENT_READS);
      expect(openWaiters).toHaveLength(SCRIPT_FS_MAX_CONCURRENT_READS);

      // Simulate the P2 window: a stop has been REQUESTED, but cleanup hasn't
      // run — `cleanedUp` is still false.
      stopRequested = true;
      expect(cleanedUp).toBe(false);

      // Let the in-flight opens finish. As soon as the first one releases its
      // slot, the queued (n)th read is admitted — DURING the window, with
      // `cleanedUp` still false.
      openWaiters.forEach((resolve) => resolve());

      const results = await Promise.all(promises.map((p) => p.catch((e: unknown) => e)));
      const succeeded = results.filter((r) => typeof r === "string");
      const stopped = results.filter((r): r is Error & { code?: string } => r instanceof Error);
      expect(succeeded).toHaveLength(SCRIPT_FS_MAX_CONCURRENT_READS);
      expect(stopped).toHaveLength(1);
      expect(stopped[0].code).toBe("Stopped");

      // The discriminator: open() was never called for the queued read — the
      // count stays exactly at SCRIPT_FS_MAX_CONCURRENT_READS, never reaching n.
      expect(nodeOpenSpy.mock.calls.length).toBe(SCRIPT_FS_MAX_CONCURRENT_READS);
    } finally {
      nodeOpenSpy.mockImplementation(realNodeOpen as never);
    }
  }, 10_000);
});

describe("scriptFsReadText — read deadline (P1, round 10: a stalled I/O call must not pin its semaphore slot forever)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("file: branch — a stalled open() call times out after SCRIPT_FS_READ_TIMEOUT_MS and releases its permit: with the pool fully saturated by stalls, a queued fresh read is admitted only once the deadline fires", async () => {
    // ⊘ no deadline race at all (scriptFsReadText just `await`s the read
    // directly) — none of the SCRIPT_FS_MAX_CONCURRENT_READS stalled calls
    // below would ever settle, their `finally` would never run, their
    // permits would never release, and the queued fresh read would then wait
    // forever too — this test would time out entirely rather than pass.
    const { ctx, scriptDir } = await makeCtx();
    for (let i = 0; i < SCRIPT_FS_MAX_CONCURRENT_READS; i++) {
      await fsp.writeFile(path.join(scriptDir, `stall${i}.txt`), "x");
    }
    await fsp.writeFile(path.join(scriptDir, "healthy.txt"), "ok");

    vi.useFakeTimers();
    try {
      // Chained `mockImplementationOnce` (self-cleaning — never touches the
      // shared default) rather than a persistent `mockImplementation`: stat
      // stays fully in-memory here (real disk stat, under fake timers, isn't
      // guaranteed to settle within a single microtask flush — this keeps the
      // test's timing entirely deterministic), and open() hangs for exactly
      // the SCRIPT_FS_MAX_CONCURRENT_READS stalled calls.
      const fakeStat = async () => ({ isFile: () => true, isDirectory: () => false, size: 1 }) as unknown as import("node:fs").Stats;
      for (let i = 0; i < SCRIPT_FS_MAX_CONCURRENT_READS + 1; i++) {
        nodeStatSpy.mockImplementationOnce(fakeStat);
      }
      // Resolver-controlled, not a bare eternal hang — round 11 tracks these
      // as orphans once their deadline fires, and this test releases them
      // itself at the end so it doesn't leak into `orphanedReads` for every
      // OTHER test sharing this file's module instance.
      const stallGates = Array.from({ length: SCRIPT_FS_MAX_CONCURRENT_READS }, () => deferred<void>());
      for (const gate of stallGates) {
        nodeOpenSpy.mockImplementationOnce(async (...args: Parameters<typeof realNodeOpen>) => {
          await gate.promise;
          return realNodeOpen(...args);
        });
      }

      const stalledPromises = Array.from({ length: SCRIPT_FS_MAX_CONCURRENT_READS }, (_, i) =>
        scriptFsReadText(`stall${i}.txt`, ctx)
      );
      // Attach rejection handlers immediately — before any timer advances —
      // so the eventual timeout rejections are never briefly "unhandled".
      const stalledSettled = Promise.allSettled(stalledPromises);

      // Flush microtasks (stat resolves, each reaches the hung open() call and
      // registers its own deadline timer) without advancing virtual time.
      await vi.advanceTimersByTimeAsync(0);
      expect(nodeOpenSpy.mock.calls.length).toBe(SCRIPT_FS_MAX_CONCURRENT_READS);

      // The pool is now fully saturated by stalls — this read queues on the
      // semaphore. Once admitted (after a stall's deadline frees a slot), it
      // should use the REAL open() and succeed quickly.
      nodeOpenSpy.mockImplementationOnce(realNodeOpen as never);
      const freshPromise = scriptFsReadText("healthy.txt", ctx);

      // Advance to the deadline: all SCRIPT_FS_MAX_CONCURRENT_READS stalled
      // reads time out and release their permits.
      await vi.advanceTimersByTimeAsync(SCRIPT_FS_READ_TIMEOUT_MS);

      const results = await stalledSettled;
      for (const r of results) {
        expect(r.status).toBe("rejected");
        expect((r as PromiseRejectedResult).reason).toMatchObject({
          code: "ReadFailed",
          message: expect.stringContaining("timed out")
        });
      }

      // Pool-exhaustion discriminator: with a permit freed, the queued fresh
      // read is admitted and completes — it was never stuck behind the
      // orphaned (still "running" but detached) stalled I/O.
      await expect(freshPromise).resolves.toBe("ok");

      // Release the orphans and let their real (now-harmless, discarded)
      // disk I/O actually finish — this drains `orphanedReads` back to
      // baseline before the next test runs.
      vi.useRealTimers();
      stallGates.forEach((gate) => gate.resolve());
      await new Promise((resolve) => setTimeout(resolve, 50));
    } finally {
      vi.useRealTimers();
    }
  }, 10_000);

  it("non-file (remote) branch — a stalled workspace.fs.readFile call times out after SCRIPT_FS_READ_TIMEOUT_MS and releases its permit: a subsequent healthy read is not stuck behind it", async () => {
    // ⊘ same as above, on the non-file branch specifically — proves the race
    // wraps BOTH branches' I/O, not just the file: one.
    const authority = "wsl+ubuntu";
    const scriptDirPath = "/home/u/scripts/cisco";
    for (let i = 0; i < SCRIPT_FS_MAX_CONCURRENT_READS; i++) {
      remoteFiles.set(`${scriptDirPath}/stall${i}.txt`, { content: new TextEncoder().encode("x") });
    }
    remoteFiles.set(`${scriptDirPath}/healthy.txt`, { content: new TextEncoder().encode("ok") });

    const ctx: ScriptFsContext = {
      scriptUri: remoteUri(authority, `${scriptDirPath}/probe.js`),
      scriptDirUri: remoteUri(authority, scriptDirPath),
      scriptsRootUri: undefined,
      log: vi.fn(),
      isAborted: () => false
    };

    vi.useFakeTimers();
    try {
      // Resolver-controlled, not a bare eternal hang — see `deferred`'s doc
      // comment: round 11 tracks these as orphans, so this test releases
      // them itself at the end to avoid leaking into `orphanedReads` for
      // every OTHER test sharing this file's module instance.
      const stallGates = Array.from({ length: SCRIPT_FS_MAX_CONCURRENT_READS }, () => deferred<void>());
      for (const gate of stallGates) {
        readFileSpy.mockImplementationOnce(async (uri: { path: string }) => {
          await gate.promise;
          const entry = remoteFiles.get(uri.path);
          return entry!.content;
        });
      }

      const stalledPromises = Array.from({ length: SCRIPT_FS_MAX_CONCURRENT_READS }, (_, i) =>
        scriptFsReadText(`stall${i}.txt`, ctx)
      );
      const stalledSettled = Promise.allSettled(stalledPromises);

      await vi.advanceTimersByTimeAsync(0);
      expect(readFileSpy.mock.calls.length).toBe(SCRIPT_FS_MAX_CONCURRENT_READS);

      readFileSpy.mockImplementationOnce(async (uri: { path: string }) => {
        const entry = remoteFiles.get(uri.path);
        return entry!.content;
      });
      const freshPromise = scriptFsReadText("healthy.txt", ctx);

      await vi.advanceTimersByTimeAsync(SCRIPT_FS_READ_TIMEOUT_MS);

      const results = await stalledSettled;
      for (const r of results) {
        expect(r.status).toBe("rejected");
        expect((r as PromiseRejectedResult).reason).toMatchObject({
          code: "ReadFailed",
          message: expect.stringContaining("timed out")
        });
      }
      await expect(freshPromise).resolves.toBe("ok");

      // Drain `orphanedReads` back to baseline before the next test.
      vi.useRealTimers();
      stallGates.forEach((gate) => gate.resolve());
      await new Promise((resolve) => setTimeout(resolve, 50));
    } finally {
      vi.useRealTimers();
    }
  }, 10_000);

  it("fast path — a normal (non-timed-out) read does not leak its deadline timer: setTimeout is cleared in the same tick the read settles", async () => {
    // ⊘ dropping the `clearTimeout` from `withReadDeadline`'s `finally` (or
    // putting it only on the timeout branch) — the fast, common-case read
    // below would still succeed (this alone wouldn't fail), but the timer it
    // registered would never be cleared: `clearTimeoutSpy` would stay at 0
    // calls instead of 1, exactly the "leaks a timer on the fast path" this
    // guards against.
    const { ctx, scriptDir } = await makeCtx();
    await fsp.writeFile(path.join(scriptDir, "quick.txt"), "hello");

    const setTimeoutSpy = vi.spyOn(global, "setTimeout");
    const clearTimeoutSpy = vi.spyOn(global, "clearTimeout");
    try {
      const text = await scriptFsReadText("quick.txt", ctx);
      expect(text).toBe("hello");
      expect(setTimeoutSpy).toHaveBeenCalledTimes(1);
      expect(clearTimeoutSpy).toHaveBeenCalledTimes(1);
      expect(clearTimeoutSpy.mock.calls[0][0]).toBe(setTimeoutSpy.mock.results[0].value);
    } finally {
      setTimeoutSpy.mockRestore();
      clearTimeoutSpy.mockRestore();
    }
  });

  it("round 11, P1 — orphan capacity: a stalled read's permit releases immediately at the deadline AND its orphan slot returns to baseline once it settles", async () => {
    // ⊘ round 10's implementation (unconditional immediate release, no
    // orphan tracking at all) passes the FIRST half of this test too
    // (liveness) — what specifically discriminates round 11 is the tail: a
    // fresh batch of exactly SCRIPT_FS_MAX_ORPHANED_READS new stalls, issued
    // only AFTER the original orphan settles, must ALL be able to release
    // their own permits (proving the counter genuinely returned to 0, not
    // stuck at 1 — a leaked counter would make the batch's own last member
    // hit the cap one call early, leaving only 3 of 4 permits free
    // afterward instead of all 4).
    const { ctx, scriptDir } = await makeCtx();
    await fsp.writeFile(path.join(scriptDir, "stall.txt"), "x");
    await fsp.writeFile(path.join(scriptDir, "healthy.txt"), "ok");
    for (let i = 0; i < SCRIPT_FS_MAX_ORPHANED_READS; i++) {
      await fsp.writeFile(path.join(scriptDir, `batch${i}.txt`), "x");
    }
    for (let i = 0; i < SCRIPT_FS_MAX_CONCURRENT_READS; i++) {
      await fsp.writeFile(path.join(scriptDir, `probe${i}.txt`), `p${i}`);
    }

    const originalStatImpl = nodeStatSpy.getMockImplementation();
    nodeStatSpy.mockImplementation(
      async () => ({ isFile: () => true, isDirectory: () => false, size: 1 }) as unknown as import("node:fs").Stats
    );

    vi.useFakeTimers();
    try {
      const [stallGate] = gateOpens(1);
      const stalled = scriptFsReadText("stall.txt", ctx);
      const stalledSettled = stalled.catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(0);
      expect(nodeOpenSpy.mock.calls.length).toBe(1);

      // Only stall.txt's own deadline timer is registered at this point —
      // advancing to it (and ONLY it) keeps this step isolated from any
      // OTHER call's deadline window.
      await vi.advanceTimersByTimeAsync(SCRIPT_FS_READ_TIMEOUT_MS);

      const stalledResult = await stalledSettled;
      expect(stalledResult).toMatchObject({ code: "ReadFailed", message: expect.stringContaining("timed out") });

      // Liveness: permit released immediately — a brand-new read (issued
      // only now, so it can't share stall.txt's own deadline window) is not
      // stuck behind it. Its real (fast) I/O resolves via genuine promise
      // progression — no further timer advance needed.
      nodeOpenSpy.mockImplementationOnce(realNodeOpen as never);
      await expect(scriptFsReadText("healthy.txt", ctx)).resolves.toBe("ok");

      // Settle the orphan for real and give its (discarded) result time to
      // land — this should decrement `orphanedReads` back to 0.
      vi.useRealTimers();
      stallGate.resolve();
      await new Promise((resolve) => setTimeout(resolve, 50));
      vi.useFakeTimers();

      // Baseline-return proof: a FRESH batch of exactly
      // SCRIPT_FS_MAX_ORPHANED_READS stalls (two waves of
      // SCRIPT_FS_MAX_CONCURRENT_READS), issued only now.
      const wavesNeeded = SCRIPT_FS_MAX_ORPHANED_READS / SCRIPT_FS_MAX_CONCURRENT_READS;
      const batchGates: Array<{ resolve: () => void }> = [];
      for (let wave = 0; wave < wavesNeeded; wave++) {
        const gates = gateOpens(SCRIPT_FS_MAX_CONCURRENT_READS);
        batchGates.push(...gates);
        for (let i = 0; i < SCRIPT_FS_MAX_CONCURRENT_READS; i++) {
          void scriptFsReadText(`batch${wave * SCRIPT_FS_MAX_CONCURRENT_READS + i}.txt`, ctx).catch(() => {});
        }
        // Flush first so all SCRIPT_FS_MAX_CONCURRENT_READS calls register
        // their OWN deadline timer before the big jump — otherwise a call
        // whose timer registers mid-jump can end up scheduled against a
        // LATER virtual instant than intended.
        await vi.advanceTimersByTimeAsync(0);
        expect(nodeOpenSpy.mock.calls.length).toBe(2 + (wave + 1) * SCRIPT_FS_MAX_CONCURRENT_READS);
        await vi.advanceTimersByTimeAsync(SCRIPT_FS_READ_TIMEOUT_MS);
      }

      // All SCRIPT_FS_MAX_CONCURRENT_READS permits should now be free — every
      // probe gets ADMITTED (reaches open()) immediately, none stuck queued.
      // These probes are themselves GATED (not real quick reads): a real
      // quick read would complete and release its OWN permit on its own,
      // which could cascade-admit a queued probe regardless of whether the
      // baseline genuinely reset — that would make this check pass either
      // way and defeat the discriminator. Gating them means admission can
      // ONLY come from the batch's own released permits, observed directly
      // via the open() call count, exactly like the other round-11 tests.
      const openCountBeforeProbes = nodeOpenSpy.mock.calls.length;
      const probeGates = gateOpens(SCRIPT_FS_MAX_CONCURRENT_READS);
      for (let i = 0; i < SCRIPT_FS_MAX_CONCURRENT_READS; i++) {
        void scriptFsReadText(`probe${i}.txt`, ctx).catch(() => {});
      }
      await vi.advanceTimersByTimeAsync(0);
      expect(nodeOpenSpy.mock.calls.length).toBe(openCountBeforeProbes + SCRIPT_FS_MAX_CONCURRENT_READS);

      vi.useRealTimers();
      batchGates.forEach((g) => g.resolve());
      probeGates.forEach((g) => g.resolve());
      await new Promise((resolve) => setTimeout(resolve, 50));
    } finally {
      nodeOpenSpy.mockImplementation(realNodeOpen as never);
      nodeStatSpy.mockImplementation(originalStatImpl as never);
      vi.useRealTimers();
    }
  }, 20_000);

  it("round 11, P1 — beyond capacity: once SCRIPT_FS_MAX_ORPHANED_READS orphans are already in flight, the NEXT timeout holds its permit instead of releasing it; settling that one orphan releases exactly one permit", async () => {
    // ⊘ round 10's implementation (always release on timeout, no cap at
    // all) — the discriminator is that the probe read below stays QUEUED
    // (not admitted) right after the third wave times out; under the old
    // always-release behavior it would be admitted immediately, exactly like
    // waves 1 and 2 were.
    const { ctx, scriptDir } = await makeCtx();
    const totalStalls = SCRIPT_FS_MAX_ORPHANED_READS + SCRIPT_FS_MAX_CONCURRENT_READS; // 8 orphans + 4 held permits
    for (let i = 0; i < totalStalls; i++) {
      await fsp.writeFile(path.join(scriptDir, `s${i}.txt`), "x");
    }
    await fsp.writeFile(path.join(scriptDir, "probe.txt"), "p");

    const originalStatImpl = nodeStatSpy.getMockImplementation();
    nodeStatSpy.mockImplementation(
      async () => ({ isFile: () => true, isDirectory: () => false, size: 1 }) as unknown as import("node:fs").Stats
    );

    vi.useFakeTimers();
    try {
      const allGates: Array<{ resolve: () => void }> = [];
      // Waves 1 + 2: fill the ORPHAN pool to exactly SCRIPT_FS_MAX_ORPHANED_READS.
      for (let wave = 0; wave < SCRIPT_FS_MAX_ORPHANED_READS / SCRIPT_FS_MAX_CONCURRENT_READS; wave++) {
        const gates = gateOpens(SCRIPT_FS_MAX_CONCURRENT_READS);
        allGates.push(...gates);
        for (let i = 0; i < SCRIPT_FS_MAX_CONCURRENT_READS; i++) {
          void scriptFsReadText(`s${wave * SCRIPT_FS_MAX_CONCURRENT_READS + i}.txt`, ctx).catch(() => {});
        }
        // Flush first so all SCRIPT_FS_MAX_CONCURRENT_READS calls register
        // their OWN deadline timer before the big jump — a timer registered
        // mid-jump would end up scheduled against a LATER virtual instant.
        await vi.advanceTimersByTimeAsync(0);
        expect(nodeOpenSpy.mock.calls.length).toBe((wave + 1) * SCRIPT_FS_MAX_CONCURRENT_READS);
        await vi.advanceTimersByTimeAsync(SCRIPT_FS_READ_TIMEOUT_MS);
      }

      // Wave 3: SCRIPT_FS_MAX_CONCURRENT_READS more, admitted (permits are
      // free again — waves 1-2 released theirs) — these will HOLD their
      // permits once they time out, since the orphan pool is already full.
      const heldGates = gateOpens(SCRIPT_FS_MAX_CONCURRENT_READS);
      allGates.push(...heldGates);
      for (let i = 0; i < SCRIPT_FS_MAX_CONCURRENT_READS; i++) {
        void scriptFsReadText(`s${SCRIPT_FS_MAX_ORPHANED_READS + i}.txt`, ctx).catch(() => {});
      }
      await vi.advanceTimersByTimeAsync(0);
      expect(nodeOpenSpy.mock.calls.length).toBe(totalStalls);

      // The pool is fully occupied (0 free permits) — this queues.
      nodeOpenSpy.mockImplementationOnce(realNodeOpen as never);
      const probePromise = scriptFsReadText("probe.txt", ctx);
      let probeSettled = false;
      probePromise.then(
        () => {
          probeSettled = true;
        },
        () => {
          probeSettled = true;
        }
      );

      // Wave 3 times out — the orphan pool is ALREADY at cap, so none of
      // these release their permit; each holds it until its own work settles.
      await vi.advanceTimersByTimeAsync(SCRIPT_FS_READ_TIMEOUT_MS);

      // Real-time margin so anything that COULD have settled genuinely has —
      // this is what makes the "still false" check below trustworthy rather
      // than a false pass from insufficient microtask flushing.
      vi.useRealTimers();
      await new Promise((resolve) => setTimeout(resolve, 30));

      // Discriminator: the probe is still queued — no permit was freed.
      expect(probeSettled).toBe(false);

      // Settle exactly ONE of wave 3's held-permit reads — releases exactly
      // one permit, admitting the queued probe.
      heldGates[0].resolve();
      await waitFor(() => probeSettled, 2_000);
      await expect(probePromise).resolves.toBe("p");

      allGates.forEach((g) => g.resolve());
      await new Promise((resolve) => setTimeout(resolve, 50));
    } finally {
      nodeOpenSpy.mockImplementation(realNodeOpen as never);
      nodeStatSpy.mockImplementation(originalStatImpl as never);
      vi.useRealTimers();
    }
  }, 20_000);

  it("round 11, P1 — unbounded-accumulation discriminator: repeated timeout waves plateau at SCRIPT_FS_MAX_CONCURRENT_READS + SCRIPT_FS_MAX_ORPHANED_READS simultaneously-open handles, never beyond", async () => {
    // ⊘ round 10's implementation (always release immediately, no orphan
    // cap): each SCRIPT_FS_READ_TIMEOUT_MS window admits
    // SCRIPT_FS_MAX_CONCURRENT_READS MORE calls regardless of how many
    // orphans have already accumulated — 5 waves would reach 20
    // concurrently-open (never-closed) handles, well past 12. Manually
    // verified (mutation testing, see round-11 report) that reverting the
    // fix makes `nodeOpenSpy.mock.calls.length` climb past the bound
    // asserted below instead of plateauing at it.
    const { ctx, scriptDir } = await makeCtx();
    const cap = SCRIPT_FS_MAX_CONCURRENT_READS + SCRIPT_FS_MAX_ORPHANED_READS; // 12
    const attempted = 5 * SCRIPT_FS_MAX_CONCURRENT_READS; // 20 — deliberately more than can ever be admitted
    for (let i = 0; i < attempted; i++) {
      await fsp.writeFile(path.join(scriptDir, `a${i}.txt`), "x");
    }

    const originalStatImpl = nodeStatSpy.getMockImplementation();
    nodeStatSpy.mockImplementation(
      async () => ({ isFile: () => true, isDirectory: () => false, size: 1 }) as unknown as import("node:fs").Stats
    );

    vi.useFakeTimers();
    try {
      // Only `cap` (12) of these will ever actually be admitted and reach
      // open() — the other 8 stay queued forever, never calling open() at
      // all, so only `cap` gates are needed (see `gateOpens`'s doc comment on
      // why over-registering would leak into a later test).
      const gates = gateOpens(cap);
      for (let i = 0; i < attempted; i++) {
        void scriptFsReadText(`a${i}.txt`, ctx).catch(() => {});
      }
      // Flush first so the first admitted batch registers its deadline
      // timers before any big jump — a timer registered mid-jump would end
      // up scheduled against a LATER virtual instant than intended.
      await vi.advanceTimersByTimeAsync(0);

      // Advance through several full deadline windows — well more than the
      // 3 waves it actually takes to permanently jam the pool (waves 1-2
      // fill the orphan pool; wave 3 holds its permits since the pool is
      // already full; wave 4+ never even reach open() at all).
      for (let round = 0; round < 5; round++) {
        await vi.advanceTimersByTimeAsync(SCRIPT_FS_READ_TIMEOUT_MS);
      }

      expect(nodeOpenSpy.mock.calls.length).toBeLessThanOrEqual(cap);
      // Not merely "bounded" — genuinely reaches the bound, proving the pool
      // ran (rather than stalling at 0 for an unrelated reason).
      expect(nodeOpenSpy.mock.calls.length).toBe(cap);

      vi.useRealTimers();
      gates.forEach((g) => g.resolve());
      await new Promise((resolve) => setTimeout(resolve, 50));
    } finally {
      nodeOpenSpy.mockImplementation(realNodeOpen as never);
      nodeStatSpy.mockImplementation(originalStatImpl as never);
      vi.useRealTimers();
    }
  }, 20_000);
});

describe("scriptFsReadText — audit suppression for a detached read that settles AFTER its own deadline (P2, round 12: only the branch that wins the race may log)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("late-success suppression: a detached read that eventually SUCCEEDS after its deadline already fired does not log a second (contradictory) success line", async () => {
    // ⊘ the pre-round-12 implementation (the raw, unwrapped `ctx` handed
    // straight into `readLocalFileBounded` instead of a per-call guarded
    // one) — once the gate below is released, the detached work's own real,
    // successful read would call `ctx.log` a SECOND time with a
    // "(N bytes)" success line for a call whose result was already
    // discarded at the timeout — exactly the contradictory audit entry this
    // fix exists to prevent.
    const { ctx, scriptDir, log } = await makeCtx();
    await fsp.writeFile(path.join(scriptDir, "late-success.txt"), "hello");

    vi.useFakeTimers();
    try {
      const [gate] = gateOpens(1);
      const settled = scriptFsReadText("late-success.txt", ctx).catch((e: unknown) => e);

      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(SCRIPT_FS_READ_TIMEOUT_MS);

      const timeoutErr = await settled;
      expect(timeoutErr).toMatchObject({ code: "ReadFailed", message: expect.stringContaining("timed out") });
      // Exactly the deadline's own audit line so far — `fail()`'s log format
      // is `fs.readText <path> → <code>`, no message/timing detail in it.
      expect(log.mock.calls).toEqual([[expect.stringContaining("→ ReadFailed")]]);
      const callCountAtTimeout = log.mock.calls.length;

      // Let the detached work actually succeed for real now.
      vi.useRealTimers();
      gate.resolve();
      await new Promise((resolve) => setTimeout(resolve, 50));

      // No NEW log lines beyond the timeout one — specifically, no late
      // "(N bytes)" success line.
      expect(log.mock.calls.length).toBe(callCountAtTimeout);
      expect(log).not.toHaveBeenCalledWith(expect.stringContaining("bytes"));
    } finally {
      nodeOpenSpy.mockImplementation(realNodeOpen as never);
      vi.useRealTimers();
    }
  }, 10_000);

  it("late-failure suppression: a detached read that eventually FAILS after its deadline already fired does not log a second failure line", async () => {
    // Same shape as the success case, but the detached work's own I/O fails
    // (e.g. a permission error surfacing only once the stalled open() finally
    // settles) rather than succeeding — `fail()` still constructs and
    // rejects with the error, it just must not log a second time.
    const { ctx, scriptDir, log } = await makeCtx();
    await fsp.writeFile(path.join(scriptDir, "late-failure.txt"), "hello");

    const openGate = deferred<void>();
    nodeOpenSpy.mockImplementationOnce(async () => {
      await openGate.promise;
      throw Object.assign(new Error("EACCES: permission denied (simulated)"), { code: "EACCES" });
    });

    vi.useFakeTimers();
    try {
      const settled = scriptFsReadText("late-failure.txt", ctx).catch((e: unknown) => e);

      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(SCRIPT_FS_READ_TIMEOUT_MS);

      const timeoutErr = await settled;
      expect(timeoutErr).toMatchObject({ code: "ReadFailed", message: expect.stringContaining("timed out") });
      expect(log.mock.calls).toEqual([[expect.stringContaining("→ ReadFailed")]]);
      const callCountAtTimeout = log.mock.calls.length;

      // Let the detached work actually fail for real now — its own `fail()`
      // call would normally log an (identical-looking) SECOND
      // "→ ReadFailed" line for this same path.
      vi.useRealTimers();
      openGate.resolve();
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(log.mock.calls.length).toBe(callCountAtTimeout);
    } finally {
      nodeOpenSpy.mockImplementation(realNodeOpen as never);
      vi.useRealTimers();
    }
  }, 10_000);

  it("fast path unchanged: a normal (non-timed-out) read still logs its single success line", async () => {
    const { ctx, scriptDir, log } = await makeCtx();
    await fsp.writeFile(path.join(scriptDir, "quick.txt"), "hi");

    const text = await scriptFsReadText("quick.txt", ctx);

    expect(text).toBe("hi");
    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/^fs\.readText .*quick\.txt \(2 bytes\)$/));
  });
});

describe("scriptFsReadText — non-regular files are rejected before ANY read (file: scheme, P1)", () => {
  it.skipIf(process.platform === "win32")(
    "rejects a FIFO (named pipe) as not-a-regular-file, quickly and without ever opening it — opening a FIFO with no writer would hang forever",
    async () => {
      // ⊘ removing (or narrowing) the regular-file check — the read path
      // would then reach `boundedReadFile`'s `nodeFs.open(fifoPath, "r")`,
      // which blocks until a writer connects. Nothing in this test ever
      // writes to the FIFO, so a reintroduced bug here would hang the test
      // until the surrounding timeout fires, not just fail an assertion.
      const { ctx, scriptDir } = await makeCtx();
      const fifoPath = path.join(scriptDir, "afifo");
      const { execFileSync } = await import("node:child_process");
      execFileSync("mkfifo", [fifoPath]);

      const startedAt = Date.now();
      await expect(scriptFsReadText("afifo", ctx)).rejects.toMatchObject({
        code: "FileNotFound",
        message: expect.stringContaining("not a regular file")
      });
      expect(Date.now() - startedAt).toBeLessThan(2000);
    },
    5_000
  );
});

describe("scriptFsReadText — decoding", () => {
  it("rejects non-UTF-8 bytes with NotUtf8", async () => {
    // ⊘ a non-fatal TextDecoder that silently replaces invalid bytes with U+FFFD.
    const { ctx, scriptDir } = await makeCtx();
    await fsp.writeFile(path.join(scriptDir, "bad.bin"), Buffer.from([0xff, 0xfe, 0x41]));

    await expect(scriptFsReadText("bad.bin", ctx)).rejects.toMatchObject({ code: "NotUtf8" });
  });

  it("strips a UTF-8 BOM from valid text", async () => {
    const { ctx, scriptDir } = await makeCtx();
    await fsp.writeFile(path.join(scriptDir, "bom.txt"), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("hello", "utf8")]));

    const text = await scriptFsReadText("bom.txt", ctx);
    expect(text).toBe("hello");
  });
});

describe("scriptFsReadText — FileNotFound", () => {
  it("throws FileNotFound for a missing path", async () => {
    const { ctx } = await makeCtx();
    await expect(scriptFsReadText("nope.txt", ctx)).rejects.toMatchObject({ code: "FileNotFound" });
  });

  it("throws FileNotFound (not a crash) when the target is a real directory", async () => {
    // ⊘ using `lstat` (or otherwise not following the symlink) and/or missing
    // the `isDirectory()` check entirely, so a directory falls through to the
    // "not a regular file" branch or a decode attempt instead.
    const { ctx, scriptDir } = await makeCtx();
    await fsp.mkdir(path.join(scriptDir, "adir"));
    await expect(scriptFsReadText("adir", ctx)).rejects.toMatchObject({ code: "FileNotFound" });
  });

  it.skipIf(process.platform === "win32")(
    "throws FileNotFound for a SYMLINKED directory too",
    async () => {
      // ⊘ using `lstat` instead of `stat` for the file: scheme's directory
      // check — `lstat` reports the LINK itself (not a directory), which
      // would let a symlinked directory fall through to the "not a regular
      // file" branch instead of being caught here. `node:fs`'s `stat` follows
      // the link and reports the TARGET's type directly — no bitmask
      // reasoning needed here the way `vscode.FileType` (used on the
      // non-file scheme) requires; see `scriptScanner.ts` for that discipline.
      const { ctx, scriptDir, root } = await makeCtx();
      const real = path.join(root, "realdir");
      await fsp.mkdir(real);
      await fsp.symlink(real, path.join(scriptDir, "linkdir"), "dir");
      await expect(scriptFsReadText("linkdir", ctx)).rejects.toMatchObject({ code: "FileNotFound" });
    }
  );
});

describe("scriptFsReadText — stat-failure mapping (FileNotFound vs. ReadFailed)", () => {
  it("maps a permission-denied node fs.stat failure to ReadFailed, not FileNotFound — the path resolved fine, the read itself is what didn't work", async () => {
    // ⊘ a stat catch-block that maps EVERY failure to FileNotFound regardless
    // of cause, which contradicts ReadFailed's documented meaning ("stat ok
    // but read failed (permissions, provider error)") — a permission error IS
    // exactly that documented case, just surfacing one step earlier (at stat
    // rather than readFile). file: scheme now stats via node:fs, not
    // vscode.workspace.fs — mocking THAT is what actually exercises this path.
    const { ctx, scriptDir } = await makeCtx();
    await fsp.writeFile(path.join(scriptDir, "secret.txt"), "shh");
    nodeStatSpy.mockImplementationOnce(async () => {
      throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
    });

    await expect(scriptFsReadText("secret.txt", ctx)).rejects.toMatchObject({ code: "ReadFailed" });
  });

  it("still maps a genuine ENOENT-style stat failure to FileNotFound (unchanged)", async () => {
    const { ctx } = await makeCtx();
    await expect(scriptFsReadText("nope.txt", ctx)).rejects.toMatchObject({ code: "FileNotFound" });
  });
});

describe("scriptFsReadText — real symlink follow (decision 3)", () => {
  it.skipIf(process.platform === "win32")(
    "reads through a symlink that points OUTSIDE the scope — lexical containment, no realpath",
    async () => {
      // ⊘ a realpath-based containment check, which would refuse this the
      // moment it resolved "linked" to somewhere outside root/scripts.
      const root = tmpRoot;
      const scriptDir = path.join(root, "scripts", "cisco");
      const outsideDir = path.join(root, "outside");
      await fsp.mkdir(scriptDir, { recursive: true });
      await fsp.mkdir(outsideDir, { recursive: true });
      await fsp.writeFile(path.join(outsideDir, "secret.txt"), "shh");
      await fsp.symlink(outsideDir, path.join(scriptDir, "linked"), "dir");

      const ctx: ScriptFsContext = {
        scriptUri: fileUri(path.join(scriptDir, "probe.js")),
        scriptDirUri: fileUri(scriptDir),
        scriptsRootUri: fileUri(path.join(root, "scripts")),
        log: vi.fn(),
        isAborted: () => false
      };

      const text = await scriptFsReadText("linked/secret.txt", ctx);
      expect(text).toBe("shh");
    }
  );
});

describe("scriptFsExists", () => {
  it("is true for an existing file and an existing directory", async () => {
    const { ctx, scriptDir } = await makeCtx();
    await fsp.writeFile(path.join(scriptDir, "a.txt"), "x");
    await fsp.mkdir(path.join(scriptDir, "adir"));
    expect(await scriptFsExists("a.txt", ctx)).toBe(true);
    expect(await scriptFsExists("adir", ctx)).toBe(true);
  });

  it("is false for a missing entry", async () => {
    const { ctx } = await makeCtx();
    expect(await scriptFsExists("nope.txt", ctx)).toBe(false);
  });

  it("throws PathOutsideScope for an out-of-scope probe rather than returning false (no existence oracle outside scope)", async () => {
    // ⊘ exists() swallowing an out-of-scope path into a plain `false`.
    const { ctx } = await makeCtx();
    await expect(scriptFsExists("../../../secrets.txt", ctx)).rejects.toMatchObject({ code: "PathOutsideScope" });
  });
});

describe("NoScriptDir — untitled scripts", () => {
  it("both readText and exists throw NoScriptDir even for a path that would otherwise be in-scope", async () => {
    // ⊘ falling back to root-only (or any) scope for an untitled script.
    const { ctx, root } = await makeCtx({ scriptDirUri: undefined });
    await expect(scriptFsReadText(path.join(root, "x.json"), ctx)).rejects.toMatchObject({ code: "NoScriptDir" });
    await expect(scriptFsExists(path.join(root, "x.json"), ctx)).rejects.toMatchObject({ code: "NoScriptDir" });
  });
});

describe("logging (decision 8)", () => {
  it("logs a successful read with the resolved path and byte count", async () => {
    // ⊘ a silent read that never calls ctx.log.
    const { ctx, scriptDir, log } = await makeCtx();
    await fsp.writeFile(path.join(scriptDir, "a.txt"), "hello");
    await scriptFsReadText("a.txt", ctx);
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/^fs\.readText .*a\.txt \(5 bytes\)$/));
  });

  it("logs a refusal with the failing error code", async () => {
    const { ctx, log } = await makeCtx();
    await expect(scriptFsReadText("../../../etc/passwd", ctx)).rejects.toBeTruthy();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("PathOutsideScope"));
  });

  it("logs exists() with the resolved boolean", async () => {
    const { ctx, scriptDir, log } = await makeCtx();
    await fsp.writeFile(path.join(scriptDir, "a.txt"), "hi");
    await scriptFsExists("a.txt", ctx);
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/^fs\.exists .*a\.txt → true$/));
  });
});

describe("audit log names the RESOLVED path once resolution succeeded, not the raw request (P2)", () => {
  it("a failure log line for an in-scope-but-missing '../shared/config.json' contains the RESOLVED absolute path", async () => {
    // ⊘ logging String(requested) unconditionally, for every failure,
    // regardless of whether resolution succeeded. For a relative traversal
    // like "../shared/config.json" that raw string tells an operator almost
    // nothing about what was actually checked on disk — the resolved
    // absolute path is what they need to go find (or explain the absence of)
    // the file.
    const { ctx, root, log } = await makeCtx();
    // scriptDir = <root>/cisco, so "../shared/config.json" resolves to
    // <root>/shared/config.json — inside scriptsRoot (in scope), but nothing
    // is there.
    const requested = "../shared/config.json";
    const expectedResolved = path.join(root, "shared", "config.json");

    await expect(scriptFsReadText(requested, ctx)).rejects.toMatchObject({ code: "FileNotFound" });

    expect(log).toHaveBeenCalledWith(expect.stringContaining(expectedResolved));
    expect(log).not.toHaveBeenCalledWith(expect.stringContaining(requested));
  });

  it("a PRE-resolution failure (PathOutsideScope) still logs the raw requested value — there is no resolved path to name", async () => {
    // Pins the other half of P2's rule: only POST-resolution failures switch
    // to the resolved path. A path that never resolved at all (it's outside
    // scope) has no resolved path to report, so the raw request is still the
    // only thing worth logging here.
    const { ctx, log } = await makeCtx();
    const requested = "../../../etc/passwd";

    await expect(scriptFsReadText(requested, ctx)).rejects.toMatchObject({ code: "PathOutsideScope" });

    expect(log).toHaveBeenCalledWith(expect.stringContaining(requested));
  });
});

describe("InvalidPath messages name the offending path", () => {
  it("the thrown Error's message — not just the log line — includes the requested value", async () => {
    // ⊘ an InvalidPath detail string that only ever says something generic
    // like "path must be a non-empty string" with no way to tell, from the
    // error alone, WHICH call produced it.
    const { ctx } = await makeCtx();
    await expect(scriptFsReadText("", ctx)).rejects.toMatchObject({
      code: "InvalidPath",
      message: expect.stringContaining('""')
    });
    await expect(scriptFsReadText("a\0b", ctx)).rejects.toMatchObject({
      code: "InvalidPath",
      message: expect.stringContaining("a\\u0000b")
    });
  });
});

describe("buildScriptFsScope — scheme guard (decision 5, remote compat)", () => {
  it("drops the scripts root from the union when its scheme differs from the script's, and refuses a root-scoped read", () => {
    // ⊘ comparing a remote `.path` against a local `.fsPath` (or vice versa) as
    // if they were on the same filesystem.
    const remoteScriptUri = { scheme: "vscode-remote", authority: "wsl+ubuntu", path: "/home/u/scripts/a.js", fsPath: "/home/u/scripts/a.js" } as unknown as vscode.Uri;
    const remoteScriptDirUri = { scheme: "vscode-remote", authority: "wsl+ubuntu", path: "/home/u/scripts", fsPath: "/home/u/scripts" } as unknown as vscode.Uri;
    const localRootUri = fileUri("/ws/.nexus/scripts");

    const scope = buildScriptFsScope({
      scriptUri: remoteScriptUri,
      scriptDirUri: remoteScriptDirUri,
      scriptsRootUri: localRootUri,
      log: vi.fn()
    });

    expect("code" in scope).toBe(false);
    if (!("code" in scope)) {
      expect(scope.scriptsRootPath).toBeUndefined();
      expect(scope.scriptDirPath).toBe("/home/u/scripts");
      expect(scope.platform).toBe("posix");
    }
  });

  it("keeps the root in the union when scheme AND authority match", () => {
    const remoteScriptUri = { scheme: "vscode-remote", authority: "wsl+ubuntu", path: "/home/u/scripts/cisco/a.js", fsPath: "/home/u/scripts/cisco/a.js" } as unknown as vscode.Uri;
    const remoteScriptDirUri = { scheme: "vscode-remote", authority: "wsl+ubuntu", path: "/home/u/scripts/cisco", fsPath: "/home/u/scripts/cisco" } as unknown as vscode.Uri;
    const remoteRootUri = { scheme: "vscode-remote", authority: "WSL+UBUNTU", path: "/home/u/scripts", fsPath: "/home/u/scripts" } as unknown as vscode.Uri;

    const scope = buildScriptFsScope({
      scriptUri: remoteScriptUri,
      scriptDirUri: remoteScriptDirUri,
      scriptsRootUri: remoteRootUri,
      log: vi.fn()
    });

    expect("code" in scope).toBe(false);
    if (!("code" in scope)) {
      expect(scope.scriptsRootPath).toBe("/home/u/scripts");
    }
  });
});

describe("remote (non-file) scheme — backslash traversal guard", () => {
  it("refuses a backslash-containing path on a non-file scheme with InvalidPath, even though posix lexical resolution alone would consider it one harmless filename segment", async () => {
    // ⊘ scriptFs.ts not rejecting backslashes on non-file schemes at all —
    // buildScriptFsScope forces platform "posix" for every remote scheme, and
    // posix treats "\" as an ordinary filename character, so containment
    // alone WOULD pass this. The danger is downstream: a real Windows remote
    // FileSystemProvider (Remote-SSH / WSL to a Windows host) normalizes "\"
    // into a genuine path separator, turning this into a real traversal on
    // the far end.
    const ctx: ScriptFsContext = {
      scriptUri: remoteUri("wsl+ubuntu", "/home/u/scripts/cisco/probe.js"),
      scriptDirUri: remoteUri("wsl+ubuntu", "/home/u/scripts/cisco"),
      scriptsRootUri: undefined,
      log: vi.fn(),
      isAborted: () => false
    };

    await expect(scriptFsReadText("..\\..\\..\\etc\\passwd", ctx)).rejects.toMatchObject({ code: "InvalidPath" });
    await expect(scriptFsExists("..\\..\\..\\etc\\passwd", ctx)).rejects.toMatchObject({ code: "InvalidPath" });
  });

  it.skipIf(process.platform === "win32")(
    "still allows a literal backslash in a filename on the local file: scheme (unaffected — a real filename character there)",
    async () => {
      const { ctx, scriptDir } = await makeCtx();
      const weirdName = "weird\\name.txt";
      await fsp.writeFile(path.join(scriptDir, weirdName), "ok");
      const text = await scriptFsReadText(weirdName, ctx);
      expect(text).toBe("ok");
    }
  );
});

describe("remote (non-file) scheme — reads route by .path, never by the (bogus for remote) .fsPath", () => {
  it("reads a file through a vscode-remote Uri whose .path and .fsPath deliberately diverge", async () => {
    // ⊘ pathOf() using `.fsPath` instead of `.path` for a non-file scheme —
    // would compute the scope from the decoy fsPath, causing the resolved Uri
    // handed to workspace.fs to carry the decoy prefix too, which nothing in
    // remoteFiles is keyed by → FileNotFound instead of the real content.
    // ⊘ uriOf() dropping the `.with({ path: resolvedPath })` reconstruction
    // (e.g. returning `scriptUri` unchanged) — would stat/read the SCRIPT's
    // own path ("probe.js") instead of the resolved target ("data.txt").
    const authority = "wsl+ubuntu";
    const scriptDirPath = "/home/u/scripts/cisco";
    remoteFiles.set(`${scriptDirPath}/data.txt`, { content: new TextEncoder().encode("remote-content") });

    const ctx: ScriptFsContext = {
      scriptUri: remoteUri(authority, `${scriptDirPath}/probe.js`),
      scriptDirUri: remoteUri(authority, scriptDirPath),
      scriptsRootUri: undefined,
      log: vi.fn(),
      isAborted: () => false
    };

    const text = await scriptFsReadText("data.txt", ctx);
    expect(text).toBe("remote-content");
  });

  it("exists() also routes by .path for a remote Uri", async () => {
    const authority = "wsl+ubuntu";
    const scriptDirPath = "/home/u/scripts/cisco";
    remoteFiles.set(`${scriptDirPath}/present.txt`, { content: new TextEncoder().encode("x") });

    const ctx: ScriptFsContext = {
      scriptUri: remoteUri(authority, `${scriptDirPath}/probe.js`),
      scriptDirUri: remoteUri(authority, scriptDirPath),
      scriptsRootUri: undefined,
      log: vi.fn(),
      isAborted: () => false
    };

    expect(await scriptFsExists("present.txt", ctx)).toBe(true);
    expect(await scriptFsExists("missing.txt", ctx)).toBe(false);
  });

  it("platform is forced to posix for a remote scope even when the HOST process reports win32", () => {
    // ⊘ deriving platform from `process.platform` regardless of scheme
    // (dropping the `ctx.scriptUri.scheme === "file"` guard) — on this repo's
    // actual posix CI host that mutation is unobservable (process.platform is
    // already posix either way), so this test forces process.platform to
    // "win32" to make the scheme check the ONLY thing that can still produce
    // "posix" for a remote scope.
    const originalDescriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    try {
      const remoteScope = buildScriptFsScope({
        scriptUri: remoteUri("wsl+ubuntu", "/home/u/scripts/cisco/probe.js"),
        scriptDirUri: remoteUri("wsl+ubuntu", "/home/u/scripts/cisco"),
        scriptsRootUri: undefined,
        log: vi.fn()
      });
      expect("code" in remoteScope).toBe(false);
      if (!("code" in remoteScope)) {
        expect(remoteScope.platform).toBe("posix");
      }
    } finally {
      Object.defineProperty(process, "platform", originalDescriptor);
    }
  });
});
