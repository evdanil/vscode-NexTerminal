/*
 * Main-thread policy for `nexus.include()` (scriptInclude.ts).
 *
 * Everything that decides WHICH file a module id refers to lives here, so this
 * is where the resolution/containment/caching/cycle/limit matrix is pinned. The
 * worker's half (evaluation, exports precedence, stack rewriting) is
 * scriptModuleLoader.test.ts; the two meet in
 * test/integration/scripts/scriptInclude.integration.test.ts.
 *
 * House rule (CLAUDE.md): every test must fail against the specific wrong
 * implementation it prevents (⊘). Several fixtures below deliberately put TWO
 * plausible real files on disk, so a wrong resolution base does not fail
 * loudly — it silently returns the other file's content. Asserting the exact
 * module identity is the only thing that separates them.
 */
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    // Wrapped, not replaced — the real implementation stays in place; tests
    // only need the CALL COUNT, which is how "refused before any I/O" and
    // "one read per module, however many includes" are discriminated.
    open: vi.fn(actual.open),
    __realOpen: actual.open
  };
});

vi.mock("vscode", () => {
  class FakeUri {
    public constructor(
      public scheme: string,
      public authority: string,
      public path: string,
      public fsPath: string
    ) {}
    public with(): FakeUri {
      return this;
    }
    public toString(): string {
      return this.path;
    }
  }
  return {
    FileType: { Unknown: 0, File: 1, Directory: 2, SymbolicLink: 64 },
    Uri: { file: (p: string) => new FakeUri("file", "", p, p) },
    workspace: { fs: { stat: vi.fn(), readFile: vi.fn() } }
  };
});

import * as vscode from "vscode";
import { resetScriptFsSchedulers, type ScriptFsContext } from "../../../src/services/scripts/scriptFs";
import { SCRIPT_FS_DEFAULT_MAX_BYTES } from "../../../src/services/scripts/maxReadSize";
import { SCRIPT_INCLUDE_ROOT_ID } from "../../../src/services/scripts/scriptTypes";
import {
  createScriptIncludeState,
  includeCacheKeyFor,
  includeModuleDirOf,
  includeModuleDisplayNameOf,
  scriptIncludeLoad,
  SCRIPT_INCLUDE_MAX_DEPTH,
  SCRIPT_INCLUDE_MAX_MODULES,
  SCRIPT_INCLUDE_MAX_TOTAL_SOURCE_BYTES,
  type ScriptIncludeState
} from "../../../src/services/scripts/scriptInclude";

const nodeOpenSpy = fsp.open as unknown as ReturnType<typeof vi.fn>;
const realNodeOpen = (fsp as unknown as { __realOpen: typeof fsp.open }).__realOpen;

let tmpRoot: string;

beforeEach(async () => {
  vi.clearAllMocks();
  resetScriptFsSchedulers();
  tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "nexus-include-"));
});

afterEach(async () => {
  nodeOpenSpy.mockReset();
  nodeOpenSpy.mockImplementation(realNodeOpen as never);
  await fsp.rm(tmpRoot, { recursive: true, force: true });
});

/**
 * Entry script at `<root>/main.js`, scripts root `<root>` — so a module under
 * `<root>/lib` gets the display name `lib/x.js` and the entry gets `main.js`.
 */
async function makeFixture(overrides?: Partial<ScriptFsContext>): Promise<{
  ctx: ScriptFsContext;
  state: ScriptIncludeState;
  root: string;
  log: ReturnType<typeof vi.fn>;
  lines: () => string[];
}> {
  const root = tmpRoot;
  await fsp.mkdir(path.join(root, "lib"), { recursive: true });
  await fsp.writeFile(path.join(root, "main.js"), "/**\n * @nexus-script\n */\n");
  const log = vi.fn();
  const ctx: ScriptFsContext = {
    scriptUri: vscode.Uri.file(path.join(root, "main.js")),
    scriptDirUri: vscode.Uri.file(root),
    scriptsRootUri: vscode.Uri.file(root),
    maxBytes: SCRIPT_FS_DEFAULT_MAX_BYTES,
    log,
    isAborted: () => false,
    ...overrides
  };
  const state = createScriptIncludeState(ctx);
  return { ctx, state, root, log, lines: () => log.mock.calls.map((c) => String(c[0])) };
}

/** Loads `specifier` from the entry script and returns the assigned module id. */
async function loadFromRoot(
  specifier: string,
  ctx: ScriptFsContext,
  state: ScriptIncludeState
): Promise<string> {
  const res = await scriptIncludeLoad(specifier, [SCRIPT_INCLUDE_ROOT_ID], ctx, state);
  return res.moduleId;
}

async function expectRejection(promise: Promise<unknown>): Promise<Record<string, unknown> & { code?: string; message?: string }> {
  try {
    await promise;
  } catch (err) {
    return err as Record<string, unknown> & { code?: string; message?: string };
  }
  throw new Error("expected the include to be refused, but it resolved");
}

// -----------------------------------------------------------------------------

describe("scriptIncludeLoad — a relative specifier resolves against the file it is written in", () => {
  it("a module under lib/ including './b.js' gets lib/b.js — NOT the equally-real b.js next to the entry script", async () => {
    // ⊘ resolving every specifier against the entry script's own directory
    // (i.e. never threading a per-module base through). Both files exist and
    // both are legal targets, so the wrong implementation loads the OTHER real
    // file and reports success — the failure mode is a silently wrong answer,
    // which is why this asserts the display name rather than "it worked".
    const { ctx, state, root } = await makeFixture();
    await fsp.writeFile(path.join(root, "b.js"), "exports.who = 'entry-sibling';");
    await fsp.writeFile(path.join(root, "lib", "b.js"), "exports.who = 'lib-sibling';");
    await fsp.writeFile(path.join(root, "lib", "a.js"), "exports.a = 1;");

    const aId = await loadFromRoot("./lib/a.js", ctx, state);
    const fromA = await scriptIncludeLoad("./b.js", [SCRIPT_INCLUDE_ROOT_ID, aId], ctx, state);

    expect(fromA.displayName).toBe("lib/b.js");
    expect(fromA.source).toBe("exports.who = 'lib-sibling';");
  });

  it("the entry script's own base is its directory — the same specifier from #root reaches the other file", async () => {
    const { ctx, state, root } = await makeFixture();
    await fsp.writeFile(path.join(root, "b.js"), "exports.who = 'entry-sibling';");
    await fsp.writeFile(path.join(root, "lib", "b.js"), "exports.who = 'lib-sibling';");

    const fromRoot = await scriptIncludeLoad("./b.js", [SCRIPT_INCLUDE_ROOT_ID], ctx, state);
    expect(fromRoot.displayName).toBe("b.js");
    expect(fromRoot.source).toBe("exports.who = 'entry-sibling';");
  });

  it("containment is unchanged: a module cannot climb out of the run's two roots, and the refusal is logged", async () => {
    // ⊘ making the per-module base a third containment root.
    const { ctx, state, root, lines } = await makeFixture();
    await fsp.writeFile(path.join(root, "lib", "a.js"), "exports.a = 1;");
    const aId = await loadFromRoot("./lib/a.js", ctx, state);

    const err = await expectRejection(
      scriptIncludeLoad("../../outside.js", [SCRIPT_INCLUDE_ROOT_ID, aId], ctx, state)
    );
    expect(err.code).toBe("PathOutsideScope");
    expect(lines().some((l) => l.startsWith("include ") && l.includes("PathOutsideScope"))).toBe(true);
  });
});

describe("scriptIncludeLoad — module identity is the resolved path, not the request string", () => {
  it("two different specifiers reaching the same file are ONE module: same id, second answer carries no source, and the file is read once", async () => {
    // ⊘ keying the per-run cache by the request string ("./lib/x.js" vs
    // "./x.js" would then be two modules, two reads, and — worse — two
    // evaluations of the same file with two separate exports objects).
    const { ctx, state, root } = await makeFixture();
    await fsp.writeFile(path.join(root, "lib", "x.js"), "exports.x = 1;");
    await fsp.writeFile(path.join(root, "lib", "a.js"), "exports.a = 1;");

    const first = await scriptIncludeLoad("./lib/x.js", [SCRIPT_INCLUDE_ROOT_ID], ctx, state);
    const aId = await loadFromRoot("./lib/a.js", ctx, state);
    const opensBefore = nodeOpenSpy.mock.calls.length;
    const second = await scriptIncludeLoad("./x.js", [SCRIPT_INCLUDE_ROOT_ID, aId], ctx, state);

    expect(second.moduleId).toBe(first.moduleId);
    expect(second.cached).toBe(true);
    expect(second.source).toBeUndefined();
    expect(nodeOpenSpy.mock.calls.length).toBe(opensBefore);
  });

  it("concurrent includes of the same not-yet-loaded file coalesce into ONE read and ONE module id", async () => {
    // ⊘ a cache populated only AFTER the read resolves: two concurrent
    // Promise.all includes would both miss, both read, and mint two ids for
    // one file — the worker would then evaluate the module twice, giving two
    // different exports objects for the same path.
    const { ctx, state, root } = await makeFixture();
    await fsp.writeFile(path.join(root, "lib", "x.js"), "exports.x = 1;");

    const [a, b] = await Promise.all([
      scriptIncludeLoad("./lib/x.js", [SCRIPT_INCLUDE_ROOT_ID], ctx, state),
      scriptIncludeLoad("./lib/x.js", [SCRIPT_INCLUDE_ROOT_ID], ctx, state)
    ]);

    expect(b.moduleId).toBe(a.moduleId);
    expect([a.cached, b.cached].filter(Boolean).length).toBe(1);
    expect([a.source, b.source].filter((s) => s !== undefined).length).toBe(1);
    expect(nodeOpenSpy.mock.calls.length).toBe(1);
  });

  it("a delivered module's source is NOT retained on the main thread", async () => {
    // ⊘ keeping `source` on the module record "for the cache": the protocol
    // never resends it (a repeat delivery is `cached: true` with no source),
    // so retaining it just pins up to 64 × the cap in the extension host for
    // the life of the run. Amendment A-F2.
    const { ctx, state, root } = await makeFixture();
    const marker = "exports.secret = 'RETAINED-SOURCE-MARKER';";
    await fsp.writeFile(path.join(root, "lib", "x.js"), marker);

    const id = await loadFromRoot("./lib/x.js", ctx, state);
    const record = state.byId.get(id)!;
    expect(record).toBeDefined();
    expect(JSON.stringify(record)).not.toContain("RETAINED-SOURCE-MARKER");
  });
});

describe("includeCacheKeyFor — case folding follows the filesystem, per platform", () => {
  it("win32 folds case (one module), posix does not (two modules)", () => {
    // ⊘ an unconditional toLowerCase (posix would then treat ./Lib.js and
    // ./lib.js — two genuinely different files on Linux — as one module, so
    // one of them would never run), and ⊘ no folding at all (a Windows user
    // gets two copies of one file, each with its own exports object).
    expect(includeCacheKeyFor("C:\\ws\\Lib\\A.js", "win32")).toBe(
      includeCacheKeyFor("c:\\ws\\lib\\a.js", "win32")
    );
    expect(includeCacheKeyFor("/ws/Lib/A.js", "posix")).not.toBe(includeCacheKeyFor("/ws/lib/a.js", "posix"));
  });

  it("end-to-end on posix: two files differing only in case are two distinct modules", async () => {
    if (process.platform === "win32") return; // the fixture cannot exist on a case-insensitive FS
    const { ctx, state, root } = await makeFixture();
    await fsp.writeFile(path.join(root, "lib", "case.js"), "exports.v = 'lower';");
    await fsp.writeFile(path.join(root, "lib", "Case.js"), "exports.v = 'upper';");

    const lower = await scriptIncludeLoad("./lib/case.js", [SCRIPT_INCLUDE_ROOT_ID], ctx, state);
    const upper = await scriptIncludeLoad("./lib/Case.js", [SCRIPT_INCLUDE_ROOT_ID], ctx, state);

    expect(upper.moduleId).not.toBe(lower.moduleId);
    expect(upper.source).toBe("exports.v = 'upper';");
  });
});

describe("scriptIncludeLoad — cycles", () => {
  it("a cycle is refused with the whole chain spelled out, and the audit line carries it too", async () => {
    // ⊘ CommonJS-style partial exports (returning the half-built object of a
    // module still executing): in an async module system the ancestor has not
    // finished awaiting, so what you get back is arbitrarily incomplete.
    const { ctx, state, root, lines } = await makeFixture();
    await fsp.writeFile(path.join(root, "lib", "a.js"), "exports.a = 1;");
    await fsp.writeFile(path.join(root, "lib", "b.js"), "exports.b = 1;");

    const aId = await loadFromRoot("./lib/a.js", ctx, state);
    const bRes = await scriptIncludeLoad("./b.js", [SCRIPT_INCLUDE_ROOT_ID, aId], ctx, state);
    const err = await expectRejection(
      scriptIncludeLoad("./a.js", [SCRIPT_INCLUDE_ROOT_ID, aId, bRes.moduleId], ctx, state)
    );

    expect(err.code).toBe("CircularInclude");
    expect(err.cycle).toEqual(["main.js", "lib/a.js", "lib/b.js", "lib/a.js"]);
    expect(err.message).toContain("main.js → lib/a.js → lib/b.js → lib/a.js");
    expect(lines()).toContain("include ./a.js → CircularInclude (main.js → lib/a.js → lib/b.js → lib/a.js)");
  });

  it("a DIAMOND is not a cycle: two different parents may both include the same module", async () => {
    // ⊘ "is this module currently loading?" flag-based cycle detection, which
    // false-positives the diamond — the single most common real shape (two
    // libraries sharing a helper).
    const { ctx, state, root } = await makeFixture();
    await fsp.writeFile(path.join(root, "lib", "shared.js"), "exports.s = 1;");
    await fsp.writeFile(path.join(root, "lib", "a.js"), "exports.a = 1;");
    await fsp.writeFile(path.join(root, "lib", "b.js"), "exports.b = 1;");

    const aId = await loadFromRoot("./lib/a.js", ctx, state);
    const bId = await loadFromRoot("./lib/b.js", ctx, state);
    const viaA = await scriptIncludeLoad("./shared.js", [SCRIPT_INCLUDE_ROOT_ID, aId], ctx, state);
    const viaB = await scriptIncludeLoad("./shared.js", [SCRIPT_INCLUDE_ROOT_ID, bId], ctx, state);

    expect(viaA.moduleId).toBe(viaB.moduleId);
    expect(viaB.cached).toBe(true);
  });

  it("a module including ITSELF is a cycle", async () => {
    const { ctx, state, root } = await makeFixture();
    await fsp.writeFile(path.join(root, "lib", "a.js"), "exports.a = 1;");
    const aId = await loadFromRoot("./lib/a.js", ctx, state);

    const err = await expectRejection(scriptIncludeLoad("./a.js", [SCRIPT_INCLUDE_ROOT_ID, aId], ctx, state));
    expect(err.code).toBe("CircularInclude");
    expect(err.cycle).toEqual(["main.js", "lib/a.js", "lib/a.js"]);
  });

  it("the entry script itself is on the chain — including it back is a cycle, not a second module", async () => {
    const { ctx, state, root } = await makeFixture();
    await fsp.writeFile(path.join(root, "lib", "a.js"), "exports.a = 1;");
    const aId = await loadFromRoot("./lib/a.js", ctx, state);

    const err = await expectRejection(
      scriptIncludeLoad("../main.js", [SCRIPT_INCLUDE_ROOT_ID, aId], ctx, state)
    );
    expect(err.code).toBe("CircularInclude");
  });
});

describe("scriptIncludeLoad — depth cap", () => {
  it("a chain exactly at the cap loads; one deeper is refused with depth/maxDepth, before any I/O", async () => {
    // ⊘ an off-by-one (refusing at the cap, or admitting one past it).
    const { ctx, state, root, lines } = await makeFixture();
    // 16 distinct real modules to build honest chains out of, plus two
    // never-yet-loaded targets so a missing depth check would have to READ
    // something to answer — which is what makes "no I/O" observable.
    for (let i = 0; i < SCRIPT_INCLUDE_MAX_DEPTH; i++) {
      await fsp.writeFile(path.join(root, "lib", `d${i}.js`), `exports.d = ${i};`);
    }
    await fsp.writeFile(path.join(root, "lib", "at-cap.js"), "exports.atCap = true;");
    await fsp.writeFile(path.join(root, "lib", "too-deep.js"), "exports.tooDeep = true;");

    const ids: string[] = [];
    for (let i = 0; i < SCRIPT_INCLUDE_MAX_DEPTH; i++) {
      ids.push(await loadFromRoot(`./lib/d${i}.js`, ctx, state));
    }

    // A chain of N ids means the module being loaded would sit at depth N.
    const chainAtCap = [SCRIPT_INCLUDE_ROOT_ID, ...ids.slice(0, SCRIPT_INCLUDE_MAX_DEPTH - 1)];
    expect(chainAtCap.length).toBe(SCRIPT_INCLUDE_MAX_DEPTH);
    const atCap = await scriptIncludeLoad("./at-cap.js", chainAtCap, ctx, state);
    expect(atCap.cached).toBe(false);
    expect(atCap.source).toBe("exports.atCap = true;");

    const opensBefore = nodeOpenSpy.mock.calls.length;
    const tooDeep = [SCRIPT_INCLUDE_ROOT_ID, ...ids];
    expect(tooDeep.length).toBe(SCRIPT_INCLUDE_MAX_DEPTH + 1);
    const err = await expectRejection(scriptIncludeLoad("./too-deep.js", tooDeep, ctx, state));

    expect(err.code).toBe("IncludeDepthExceeded");
    expect(err.depth).toBe(SCRIPT_INCLUDE_MAX_DEPTH + 1);
    expect(err.maxDepth).toBe(SCRIPT_INCLUDE_MAX_DEPTH);
    expect(nodeOpenSpy.mock.calls.length).toBe(opensBefore);
    expect(lines()).toContain(`include ./too-deep.js → IncludeDepthExceeded (17 > 16)`);
  });
});

describe("scriptIncludeLoad — distinct-module cap", () => {
  it("the cap counts DISTINCT modules, not include calls: 65 includes of one module are fine", async () => {
    // ⊘ counting calls instead of modules — a poll loop calling include()
    // inside it would hit the limit for no reason.
    const { ctx, state, root } = await makeFixture();
    await fsp.writeFile(path.join(root, "lib", "one.js"), "exports.one = 1;");
    for (let i = 0; i < SCRIPT_INCLUDE_MAX_MODULES + 1; i++) {
      await scriptIncludeLoad("./lib/one.js", [SCRIPT_INCLUDE_ROOT_ID], ctx, state);
    }
    expect(state.byId.size).toBe(2); // #root + one module
  });

  it("the 64th distinct module loads; the 65th is refused with count/maxModules and never opens the file", async () => {
    const { ctx, state, root, lines } = await makeFixture();
    for (let i = 0; i < SCRIPT_INCLUDE_MAX_MODULES + 1; i++) {
      await fsp.writeFile(path.join(root, "lib", `m${i}.js`), `exports.m = ${i};`);
    }
    for (let i = 0; i < SCRIPT_INCLUDE_MAX_MODULES; i++) {
      const res = await scriptIncludeLoad(`./lib/m${i}.js`, [SCRIPT_INCLUDE_ROOT_ID], ctx, state);
      expect(res.cached).toBe(false);
    }

    const opensBefore = nodeOpenSpy.mock.calls.length;
    const err = await expectRejection(
      scriptIncludeLoad(`./lib/m${SCRIPT_INCLUDE_MAX_MODULES}.js`, [SCRIPT_INCLUDE_ROOT_ID], ctx, state)
    );

    expect(err.code).toBe("IncludeLimitExceeded");
    expect(err.count).toBe(SCRIPT_INCLUDE_MAX_MODULES);
    expect(err.maxModules).toBe(SCRIPT_INCLUDE_MAX_MODULES);
    // Refused BEFORE the read (⊘ a cap checked only after the source is in
    // memory, which spends exactly the budget the cap exists to protect).
    expect(nodeOpenSpy.mock.calls.length).toBe(opensBefore);
    expect(lines()).toContain(`include ./lib/m64.js → IncludeLimitExceeded (64 modules)`);
  });

  it("the cap holds against a concurrent fan-out: one Promise.allSettled of 80 distinct includes commits exactly 64 modules", async () => {
    // ⊘ a cap counted only against REGISTERED modules (state.byKey). Steps 1-8
    // of the ladder are synchronous while registration happens after the async
    // read — so every include fired in one tick sees byKey.size === 1 and
    // passes, and `Promise.all(files.map(f => nexus.include(f)))` (an ordinary
    // thing an automation author writes) loads all 80. The check must count
    // in-flight loads (state.pending) as committed too.
    const { ctx, state, root } = await makeFixture();
    const total = SCRIPT_INCLUDE_MAX_MODULES + 16;
    for (let i = 0; i < total; i++) {
      await fsp.writeFile(path.join(root, "lib", `c${i}.js`), `exports.m = ${i};`);
    }

    const settled = await Promise.allSettled(
      Array.from({ length: total }, (_, i) =>
        scriptIncludeLoad(`./lib/c${i}.js`, [SCRIPT_INCLUDE_ROOT_ID], ctx, state)
      )
    );

    const fulfilled = settled.filter((s) => s.status === "fulfilled").length;
    const refused = settled.filter(
      (s): s is PromiseRejectedResult => s.status === "rejected"
    );
    expect(fulfilled).toBe(SCRIPT_INCLUDE_MAX_MODULES);
    expect(refused.length).toBe(total - SCRIPT_INCLUDE_MAX_MODULES);
    for (const r of refused) {
      expect((r.reason as { code?: string }).code).toBe("IncludeLimitExceeded");
    }
    // The ledger agrees: exactly 64 modules minted (byId also holds #root).
    expect(state.byId.size - 1).toBe(SCRIPT_INCLUDE_MAX_MODULES);
  });
});

describe("scriptIncludeLoad — cumulative source-byte budget", () => {
  // The count cap alone cannot bound the worker's heap: 64 modules of up to
  // `ctx.maxBytes` each is 1 GiB at the 16 MiB ceiling, ~2 GiB as UTF-16 in a
  // worker whose own limit is 192 MiB — so a SUPPORTED configuration would die
  // with an allocation crash instead of the documented typed refusal. These
  // tests pin the budget that closes that gap. They never write 48 MiB of
  // fixtures: the run's committed total is pre-set next to the constant, which
  // is the same arithmetic the real path performs one module at a time.
  const LIMIT = SCRIPT_INCLUDE_MAX_TOTAL_SOURCE_BYTES;

  it("the module that exactly fills the budget loads and charges it; one byte over is refused with maxTotalBytes, mints nothing, and is logged", async () => {
    // ⊘ never charging the budget (`totalSourceBytes` stays 0 — the exact-fit
    // half below would then report 0 instead of the file's size, and nothing
    // would ever be refused in a real run), and ⊘ a `>=` comparison in place of
    // `>` (the module that exactly fits — a legal, supported load — would be
    // refused, which is an off-by-one that only a boundary case can see).
    const source = "exports.big = 1;";
    const size = Buffer.byteLength(source);

    {
      const { ctx, state, root, lines } = await makeFixture();
      await fsp.writeFile(path.join(root, "lib", "big.js"), source);
      state.totalSourceBytes = LIMIT - size + 1;
      const before = state.totalSourceBytes;

      const err = await expectRejection(
        scriptIncludeLoad("./lib/big.js", [SCRIPT_INCLUDE_ROOT_ID], ctx, state)
      );

      expect(err.code).toBe("IncludeLimitExceeded");
      expect(err.maxTotalBytes).toBe(LIMIT);
      expect(err.totalBytes).toBe(before);
      // Nothing minted, nothing charged, nothing left in flight.
      expect(state.byId.size).toBe(1); // #root only
      expect(state.byKey.size).toBe(1);
      expect(state.pending.size).toBe(0);
      expect(state.totalSourceBytes).toBe(before);
      expect(lines()).toContain("include ./lib/big.js → IncludeLimitExceeded (source budget)");
    }

    {
      const { ctx, state, root } = await makeFixture();
      await fsp.writeFile(path.join(root, "lib", "big.js"), source);
      state.totalSourceBytes = LIMIT - size;

      const res = await scriptIncludeLoad("./lib/big.js", [SCRIPT_INCLUDE_ROOT_ID], ctx, state);

      expect(res.cached).toBe(false);
      expect(res.source).toBe(source);
      expect(state.totalSourceBytes).toBe(LIMIT);
    }
  });

  it("an exhausted budget refuses BEFORE the file is opened", async () => {
    // ⊘ a budget enforced only after the read: the run would spend a read slot,
    // and up to one whole `maxBytes` of host memory, to be told it had no
    // budget left — exactly what the cheap pre-read step of the ladder exists
    // to avoid (same shape as the count cap's own no-I/O assertion).
    const { ctx, state, root, lines } = await makeFixture();
    await fsp.writeFile(path.join(root, "lib", "after.js"), "exports.after = 1;");
    state.totalSourceBytes = LIMIT;
    const opensBefore = nodeOpenSpy.mock.calls.length;

    const err = await expectRejection(
      scriptIncludeLoad("./lib/after.js", [SCRIPT_INCLUDE_ROOT_ID], ctx, state)
    );

    expect(err.code).toBe("IncludeLimitExceeded");
    expect(err.totalBytes).toBe(LIMIT);
    expect(err.maxTotalBytes).toBe(LIMIT);
    expect(nodeOpenSpy.mock.calls.length).toBe(opensBefore);
    expect(lines()).toContain("include ./lib/after.js → IncludeLimitExceeded (source budget)");
  });

  it("the budget holds against a concurrent fan-out: three includes with room for one commit exactly one", async () => {
    // ⊘ a post-read check that compares against a total SNAPSHOTTED before the
    // read (the natural way to write it, since the size is only known after the
    // read): every member of a `Promise.all` fan-out would see the same stale
    // total, all three would pass, and the run would overshoot the budget by
    // however many loads were in flight. Registration runs sequentially on the
    // event loop, so reading `state.totalSourceBytes` AT the check is what makes
    // this safe.
    const { ctx, state, root } = await makeFixture();
    const sources = [0, 1, 2].map((i) => `exports.m = ${i};`);
    const size = Buffer.byteLength(sources[0]);
    expect(new Set(sources.map((s) => Buffer.byteLength(s))).size).toBe(1);
    for (let i = 0; i < 3; i++) {
      await fsp.writeFile(path.join(root, "lib", `f${i}.js`), sources[i]);
    }
    state.totalSourceBytes = LIMIT - size; // room for exactly one of them

    const settled = await Promise.allSettled(
      [0, 1, 2].map((i) => scriptIncludeLoad(`./lib/f${i}.js`, [SCRIPT_INCLUDE_ROOT_ID], ctx, state))
    );

    const fulfilled = settled.filter((s) => s.status === "fulfilled");
    const refused = settled.filter((s): s is PromiseRejectedResult => s.status === "rejected");
    expect(fulfilled.length).toBe(1);
    expect(refused.length).toBe(2);
    for (const r of refused) {
      expect((r.reason as { code?: string }).code).toBe("IncludeLimitExceeded");
    }
    expect(state.totalSourceBytes).toBeLessThanOrEqual(LIMIT);
    expect(state.totalSourceBytes).toBe(LIMIT);
    expect(state.byId.size - 1).toBe(1);
  });

  it("a budget refusal is not sticky: the state is untouched and a module that still fits loads afterwards", async () => {
    // ⊘ charging the budget (or minting the record) on the refusing path — the
    // run would be poisoned by the very load it declined, and A-F4's "a refused
    // load is never remembered" would hold for every refusal except this one.
    const { ctx, state, root } = await makeFixture();
    const big = "exports.big = " + "0".repeat(80) + ";";
    const small = "exports.small = 1;";
    await fsp.writeFile(path.join(root, "lib", "big.js"), big);
    await fsp.writeFile(path.join(root, "lib", "small.js"), small);
    const seeded = LIMIT - Buffer.byteLength(big) + 1;
    state.totalSourceBytes = seeded;

    await expectRejection(scriptIncludeLoad("./lib/big.js", [SCRIPT_INCLUDE_ROOT_ID], ctx, state));
    expect(state.totalSourceBytes).toBe(seeded);
    expect(state.byId.size).toBe(1);
    expect(state.pending.size).toBe(0);

    const res = await scriptIncludeLoad("./lib/small.js", [SCRIPT_INCLUDE_ROOT_ID], ctx, state);
    expect(res.cached).toBe(false);
    expect(res.source).toBe(small);
    expect(state.totalSourceBytes).toBe(seeded + Buffer.byteLength(small));
  });
});

describe("scriptIncludeLoad — what may be included", () => {
  it("a non-.js specifier is refused with InvalidPath pointing at nexus.fs", async () => {
    // ⊘ no extension guard at all: a .json or .txt target would be compiled
    // as JavaScript and surface as a baffling IncludeSyntaxError instead.
    const { ctx, state, root, lines } = await makeFixture();
    await fsp.writeFile(path.join(root, "lib", "data.json"), "{}");

    const err = await expectRejection(
      scriptIncludeLoad("./lib/data.json", [SCRIPT_INCLUDE_ROOT_ID], ctx, state)
    );
    expect(err.code).toBe("InvalidPath");
    expect(err.message).toContain("nexus.fs");
    expect(lines().some((l) => l === "include ./lib/data.json → InvalidPath")).toBe(true);
  });

  it("a .JS specifier is accepted (the extension check is case-insensitive)", async () => {
    const { ctx, state, root } = await makeFixture();
    await fsp.writeFile(path.join(root, "lib", "upper.JS"), "exports.u = 1;");
    const res = await scriptIncludeLoad("./lib/upper.JS", [SCRIPT_INCLUDE_ROOT_ID], ctx, state);
    expect(res.cached).toBe(false);
  });

  it("a file carrying @nexus-script is refused: scripts are entry points, libraries are unmarked", async () => {
    // ⊘ ignoring the marker. A marked file is what the Scripts view, the
    // CodeLens and the picker all key on; letting one be included as a library
    // makes "is this a script?" ambiguous in both directions.
    const { ctx, state, root, lines } = await makeFixture();
    await fsp.writeFile(
      path.join(root, "lib", "script.js"),
      "/**\n * @nexus-script\n * @name inner\n */\nexports.x = 1;\n"
    );

    const err = await expectRejection(
      scriptIncludeLoad("./lib/script.js", [SCRIPT_INCLUDE_ROOT_ID], ctx, state)
    );
    expect(err.code).toBe("IncludeIsScript");
    expect(err.module).toBe("lib/script.js");
    expect(lines()).toContain("include ./lib/script.js → IncludeIsScript");
  });

  it("a refused @nexus-script file is NOT cached — a second attempt is re-read and refused again", async () => {
    // ⊘ minting a module record before the header check (a refusal that
    // consumed one of the 64 slots, and — worse — a second include of the
    // same path answering `cached: true` for a module the worker never got).
    const { ctx, state, root } = await makeFixture();
    await fsp.writeFile(path.join(root, "lib", "script.js"), "/**\n * @nexus-script\n */\n");

    await expectRejection(scriptIncludeLoad("./lib/script.js", [SCRIPT_INCLUDE_ROOT_ID], ctx, state));
    const opensAfterFirst = nodeOpenSpy.mock.calls.length;
    const second = await expectRejection(
      scriptIncludeLoad("./lib/script.js", [SCRIPT_INCLUDE_ROOT_ID], ctx, state)
    );

    expect(second.code).toBe("IncludeIsScript");
    expect(nodeOpenSpy.mock.calls.length).toBeGreaterThan(opensAfterFirst);
    expect(state.byId.size).toBe(1); // #root only
  });

  it("a concurrent caller that joins a load which is then refused logs its own refusal line", async () => {
    // ⊘ rethrowing the starter's error from the join path without logging.
    // The file's invariant is "EVERY refusal writes its audit line before it
    // throws" — a joiner's request is a distinct call and the Output Channel
    // must record both, even though only the starter ran the ladder.
    const { ctx, state, root, lines } = await makeFixture();
    await fsp.writeFile(path.join(root, "lib", "script.js"), "/**\n * @nexus-script\n */\n");

    const [first, second] = await Promise.allSettled([
      scriptIncludeLoad("./lib/script.js", [SCRIPT_INCLUDE_ROOT_ID], ctx, state),
      scriptIncludeLoad("./lib/script.js", [SCRIPT_INCLUDE_ROOT_ID], ctx, state)
    ]);
    expect(first.status).toBe("rejected");
    expect(second.status).toBe("rejected");
    const refusalLines = lines().filter((l) => l.includes("include ./lib/script.js → IncludeIsScript"));
    expect(refusalLines.length).toBe(2);
  });
});

describe("scriptIncludeLoad — the chain is diagnostic input, never trust input", () => {
  it("a chain that is not an array, is empty, does not start at #root, or names an unknown id is IncludeInternal — with no I/O", async () => {
    // ⊘ trusting the worker's chain (a forged id would otherwise pick an
    // arbitrary resolution base, or crash on an undefined record).
    const { ctx, state, root } = await makeFixture();
    await fsp.writeFile(path.join(root, "lib", "x.js"), "exports.x = 1;");
    const opensBefore = nodeOpenSpy.mock.calls.length;

    const bad: unknown[] = [
      "not-an-array",
      [],
      ["m1"],
      [SCRIPT_INCLUDE_ROOT_ID, "m-nonexistent"],
      [SCRIPT_INCLUDE_ROOT_ID, 7],
      undefined
    ];
    for (const chain of bad) {
      const err = await expectRejection(scriptIncludeLoad("./lib/x.js", chain, ctx, state));
      expect(err.code).toBe("IncludeInternal");
    }
    expect(nodeOpenSpy.mock.calls.length).toBe(opensBefore);
  });

  it("includeModuleDirOf / includeModuleDisplayNameOf refuse an unknown module id rather than falling back to the entry script", async () => {
    // ⊘ a silent fallback to the entry script's directory for an unknown id:
    // a module's `nexus.fs` call would then resolve against the wrong folder
    // instead of reporting the protocol violation.
    const { ctx, state, root } = await makeFixture();
    expect(includeModuleDirOf(state, SCRIPT_INCLUDE_ROOT_ID)).toBe(root);
    expect(includeModuleDisplayNameOf(state, SCRIPT_INCLUDE_ROOT_ID)).toBe("main.js");
    expect(() => includeModuleDirOf(state, "m404")).toThrow(
      expect.objectContaining({ code: "IncludeInternal" })
    );
    expect(ctx).toBeDefined();
  });
});

describe("scriptIncludeLoad — inherited nexus.fs behaviour", () => {
  it("an untitled: script refuses every include with NoScriptDir", async () => {
    const { ctx, state } = await makeFixture({ scriptDirUri: undefined });
    const err = await expectRejection(scriptIncludeLoad("./lib/x.js", [SCRIPT_INCLUDE_ROOT_ID], ctx, state));
    expect(err.code).toBe("NoScriptDir");
  });

  it("a stopped run refuses with Stopped and performs no I/O", async () => {
    let aborted = false;
    const { ctx, state, root } = await makeFixture({ isAborted: () => aborted });
    await fsp.writeFile(path.join(root, "lib", "x.js"), "exports.x = 1;");
    aborted = true;
    const opensBefore = nodeOpenSpy.mock.calls.length;

    const err = await expectRejection(scriptIncludeLoad("./lib/x.js", [SCRIPT_INCLUDE_ROOT_ID], ctx, state));
    expect(err.code).toBe("Stopped");
    expect(nodeOpenSpy.mock.calls.length).toBe(opensBefore);
  });

  it("a module over the run's effective cap throws FileTooLarge quoting that cap", async () => {
    const MiB = 1024 * 1024;
    const { ctx, state, root } = await makeFixture({ maxBytes: 2 * MiB });
    await fsp.writeFile(path.join(root, "lib", "huge.js"), Buffer.alloc(3 * MiB, "a"));

    const err = await expectRejection(scriptIncludeLoad("./lib/huge.js", [SCRIPT_INCLUDE_ROOT_ID], ctx, state));
    expect(err.code).toBe("FileTooLarge");
    expect(err.maxBytes).toBe(2 * MiB);
  });

  it("a non-UTF-8 module throws NotUtf8", async () => {
    const { ctx, state, root } = await makeFixture();
    await fsp.writeFile(path.join(root, "lib", "bin.js"), Buffer.from([0xff, 0xfe, 0x00]));
    const err = await expectRejection(scriptIncludeLoad("./lib/bin.js", [SCRIPT_INCLUDE_ROOT_ID], ctx, state));
    expect(err.code).toBe("NotUtf8");
  });

  it("a missing module throws FileNotFound, filed under the include verb", async () => {
    const { ctx, state, lines } = await makeFixture();
    const err = await expectRejection(scriptIncludeLoad("./lib/gone.js", [SCRIPT_INCLUDE_ROOT_ID], ctx, state));
    expect(err.code).toBe("FileNotFound");
    // ⊘ the inherited post-resolution refusal path regressing to the
    // `fs.readText` verb — the author wrote nexus.include, not nexus.fs.
    expect(lines().some((l) => l.startsWith("include ") && l.includes("FileNotFound"))).toBe(true);
    expect(lines().some((l) => l.includes("fs.readText"))).toBe(false);
  });
});

describe("scriptIncludeLoad — audit lines", () => {
  it("a successful load names the request, the display name and the source size; a cache hit says (cached)", async () => {
    // ⊘ an audit line that only names the resolved path (a reader cannot tell
    // which of several specifiers produced it) or that omits the cache-hit
    // line entirely (a diamond would look like a module that never loaded).
    const { ctx, state, root, lines } = await makeFixture();
    const source = "exports.h = 1;";
    await fsp.writeFile(path.join(root, "lib", "helpers.js"), source);

    await scriptIncludeLoad("./lib/helpers.js", [SCRIPT_INCLUDE_ROOT_ID], ctx, state);
    await scriptIncludeLoad("./lib/helpers.js", [SCRIPT_INCLUDE_ROOT_ID], ctx, state);

    expect(lines()).toEqual([
      `include ./lib/helpers.js → lib/helpers.js (${Buffer.byteLength(source)} bytes)`,
      "include ./lib/helpers.js → lib/helpers.js (cached)"
    ]);
  });

  it("display names are relative to the scripts root when the module is inside it, and to the entry script's folder otherwise", async () => {
    const outside = await fsp.mkdtemp(path.join(os.tmpdir(), "nexus-include-outside-"));
    try {
      const scriptDir = path.join(outside, "proj");
      await fsp.mkdir(path.join(scriptDir, "lib"), { recursive: true });
      await fsp.writeFile(path.join(scriptDir, "lib", "u.js"), "exports.u = 1;");
      const log = vi.fn();
      const ctx: ScriptFsContext = {
        scriptUri: vscode.Uri.file(path.join(scriptDir, "main.js")),
        scriptDirUri: vscode.Uri.file(scriptDir),
        // A scripts root that has nothing to do with this script (decision 4:
        // a script run from anywhere keeps its own-folder scope).
        scriptsRootUri: vscode.Uri.file(path.join(tmpRoot, "unrelated")),
        maxBytes: SCRIPT_FS_DEFAULT_MAX_BYTES,
        log,
        isAborted: () => false
      };
      const state = createScriptIncludeState(ctx);
      const res = await scriptIncludeLoad("./lib/u.js", [SCRIPT_INCLUDE_ROOT_ID], ctx, state);
      expect(res.displayName).toBe("lib/u.js");
      expect(includeModuleDisplayNameOf(state, SCRIPT_INCLUDE_ROOT_ID)).toBe("main.js");
    } finally {
      await fsp.rm(outside, { recursive: true, force: true });
    }
  });
});
