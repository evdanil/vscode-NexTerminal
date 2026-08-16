/*
 * Worker-side half of `nexus.include()` (scriptModuleLoader.ts): the module
 * table, the specifier memo, and the two pure stack-attribution helpers.
 *
 * No `vscode` mock, and none is possible — this module is part of the worker
 * bundle and must never import it (asserted below).
 *
 * House rule (CLAUDE.md): every test names the wrong implementation it fails
 * against (⊘).
 */
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_ASYNC_FUNCTION_LINE_OFFSET,
  MODULE_URL_PREFIX,
  ScriptModuleLoader,
  asyncFunctionLineOffsetFromStack,
  compileScriptUnit,
  encodeModuleUrl,
  evaluateScriptModule,
  humanizeStack,
  measureAsyncFunctionLineOffset,
  type ModuleLoaderDeps
} from "../../../src/services/scripts/scriptModuleLoader";
import { SCRIPT_INCLUDE_ROOT_ID, type IncludeLoadResult } from "../../../src/services/scripts/scriptTypes";

const ROOT = [SCRIPT_INCLUDE_ROOT_ID];

/**
 * A loader over a scripted main thread: `files` maps specifier → module id +
 * source, and every load/evaluate is counted so "how many times did this
 * actually happen" is assertable rather than inferred from a returned value.
 */
function makeLoader(options?: {
  resolve?: (specifier: unknown, chain: string[]) => IncludeLoadResult;
  evaluate?: (source: string, displayName: string, chain: string[]) => Promise<unknown>;
}): {
  loader: ScriptModuleLoader;
  load: ReturnType<typeof vi.fn>;
  evaluate: ReturnType<typeof vi.fn>;
} {
  const delivered = new Set<string>();
  const load = vi.fn(async (specifier: unknown, chain: string[]): Promise<IncludeLoadResult> => {
    if (options?.resolve) return options.resolve(specifier, chain);
    const name = String(specifier).replace(/^\.\//, "");
    const moduleId = `m:${name}`;
    if (delivered.has(moduleId)) return { moduleId, displayName: name, cached: true };
    delivered.add(moduleId);
    return { moduleId, displayName: name, source: `/* ${name} */`, cached: false };
  });
  const evaluate = vi.fn(
    options?.evaluate ?? (async (source: string, displayName: string) => ({ from: displayName, source }))
  );
  const deps: ModuleLoaderDeps = { load, evaluate };
  return { loader: new ScriptModuleLoader(deps), load, evaluate };
}

describe("ScriptModuleLoader — one evaluation per module, per run", () => {
  it("two sequential includes of the same module return the SAME exports object and evaluate once", async () => {
    const { loader, evaluate } = makeLoader();
    const first = await loader.include(ROOT, "./a.js");
    const second = await loader.include(ROOT, "./a.js");
    expect(second).toBe(first);
    expect(evaluate).toHaveBeenCalledTimes(1);
  });

  it("concurrent includes of a not-yet-evaluated module share the in-flight promise — the body runs exactly once", async () => {
    // ⊘ storing the module entry only AFTER evaluation finishes: both callers
    // would miss the table and evaluate the same file twice, producing two
    // different exports objects (and running its side effects twice).
    let releaseBody: () => void = () => {};
    const bodyStarted: string[] = [];
    const { loader, evaluate } = makeLoader({
      evaluate: async (_source, displayName) => {
        bodyStarted.push(displayName);
        await new Promise<void>((resolve) => {
          releaseBody = resolve;
        });
        return { displayName };
      }
    });

    const both = Promise.all([loader.include(ROOT, "./a.js"), loader.include(ROOT, "./a.js")]);
    await new Promise((r) => setImmediate(r));
    releaseBody();
    const [x, y] = await both;

    expect(x).toBe(y);
    expect(evaluate).toHaveBeenCalledTimes(1);
    expect(bodyStarted).toEqual(["a.js"]);
  });

  it("a module whose body threw is STICKY: every later include rejects with the same error, and it is never re-evaluated", async () => {
    // ⊘ deleting the entry on failure ("so it can be retried"): a half-executed
    // module would then run its side effects again on the next include, and
    // two callers would disagree about whether it loaded.
    const boom = Object.assign(new Error("module blew up"), { code: "BoomError" });
    const { loader, evaluate } = makeLoader({
      evaluate: async () => {
        throw boom;
      }
    });

    await expect(loader.include(ROOT, "./a.js")).rejects.toBe(boom);
    await expect(loader.include(ROOT, "./a.js")).rejects.toBe(boom);
    expect(evaluate).toHaveBeenCalledTimes(1);
  });

  it("the evaluation chain the module sees ends with its OWN id — that is what makes its nested includes resolve from its own folder", async () => {
    const { loader, evaluate } = makeLoader();
    await loader.include(ROOT, "./lib/a.js");
    expect(evaluate.mock.calls[0][2]).toEqual([SCRIPT_INCLUDE_ROOT_ID, "m:lib/a.js"]);
  });
});

describe("ScriptModuleLoader — specifier memo", () => {
  it("repeat includes of the same specifier from the same parent never hit the main thread again", async () => {
    // ⊘ no memo at all: `while (true) { const h = await nexus.include("./h.js") }`
    // inside a poll loop would post one RPC per iteration — tens of thousands
    // of round trips for a module that was resolved on the first tick.
    const { loader, load } = makeLoader();
    await loader.include(ROOT, "./a.js");
    await loader.include(ROOT, "./a.js");
    await loader.include(ROOT, "./a.js");
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("the memo is keyed by PARENT + specifier — the same specifier from a different file is a different question", async () => {
    // ⊘ a memo keyed by the specifier alone: "./b.js" means lib/b.js inside
    // lib/a.js and b.js at the root, so a global memo would hand the second
    // caller the FIRST caller's module — silently the wrong file.
    const { loader, load } = makeLoader({
      resolve: (specifier, chain) => {
        const parent = chain[chain.length - 1];
        const name = parent === SCRIPT_INCLUDE_ROOT_ID ? "b.js" : "lib/b.js";
        return { moduleId: `m:${name}`, displayName: name, source: `/* ${name} */`, cached: false };
      }
    });

    const fromRoot = (await loader.include(ROOT, "./b.js")) as { from: string };
    const fromLib = (await loader.include([SCRIPT_INCLUDE_ROOT_ID, "m:lib/a.js"], "./b.js")) as { from: string };

    expect(fromRoot.from).toBe("b.js");
    expect(fromLib.from).toBe("lib/b.js");
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("a REFUSED include is never memoised — the next call asks main again", async () => {
    // ⊘ memoising every edge, including refusals: a refusal is re-evaluated on
    // every call by design (main's own contract), and a memoised one would
    // freeze a transient condition (a stopped run, a file not saved yet) for
    // the rest of the run.
    let attempts = 0;
    const { loader, load } = makeLoader({
      resolve: (specifier) => {
        attempts++;
        if (attempts === 1) throw Object.assign(new Error("nope"), { code: "FileNotFound" });
        const name = String(specifier).replace(/^\.\//, "");
        return { moduleId: `m:${name}`, displayName: name, source: `/* ${name} */`, cached: false };
      }
    });

    await expect(loader.include(ROOT, "./a.js")).rejects.toMatchObject({ code: "FileNotFound" });
    await expect(loader.include(ROOT, "./a.js")).resolves.toBeDefined();
    expect(load).toHaveBeenCalledTimes(2);
  });
});

describe("ScriptModuleLoader — protocol violations are reported, never guessed at", () => {
  it("`cached: true` for a module this worker has no entry for is IncludeInternal", async () => {
    // ⊘ treating a source-less answer as "evaluate nothing" (the include would
    // resolve to undefined) or as "re-request it" (an infinite ping-pong).
    const { loader } = makeLoader({
      resolve: () => ({ moduleId: "m:ghost", displayName: "ghost.js", cached: true })
    });
    await expect(loader.include(ROOT, "./ghost.js")).rejects.toMatchObject({ code: "IncludeInternal" });
  });

  it("`cached: false` with no source is IncludeInternal", async () => {
    const { loader } = makeLoader({
      resolve: () => ({ moduleId: "m:empty", displayName: "empty.js", cached: false })
    });
    await expect(loader.include(ROOT, "./empty.js")).rejects.toMatchObject({ code: "IncludeInternal" });
  });
});

describe("encodeModuleUrl — a sourceURL V8 will actually honour", () => {
  it("percent-escapes whitespace: a space silently disables the whole directive", () => {
    // ⊘ leaving whitespace in the URL. V8 does not warn — it just drops the
    // sourceURL, and every frame from that module falls back to <anonymous>.
    // Attribution regresses to Phase-1 behaviour with nothing to indicate why.
    expect(encodeModuleUrl("my scripts/a.js")).toBe(`${MODULE_URL_PREFIX}my%20scripts/a.js`);
    expect(encodeModuleUrl("a\tb.js")).toBe(`${MODULE_URL_PREFIX}a%09b.js`);
  });

  it("percent-escapes the colon — otherwise a name containing :N:N mis-parses as the line/column", () => {
    // ⊘ leaving ':' unescaped (amendment A-F7): the frame
    // `nexus-script:/a:1:2.js:5:7` would be read back as file "/a", line 1,
    // column 2 by a non-anchored parser — a confidently wrong location.
    expect(encodeModuleUrl("a:1:2.js")).toBe(`${MODULE_URL_PREFIX}a%3A1%3A2.js`);
  });

  it("escapes the escape character first, plus # and ?", () => {
    expect(encodeModuleUrl("100%/a.js")).toBe(`${MODULE_URL_PREFIX}100%25/a.js`);
    expect(encodeModuleUrl("a#b?c.js")).toBe(`${MODULE_URL_PREFIX}a%23b%3Fc.js`);
  });

  it("leaves an ordinary path untouched", () => {
    expect(encodeModuleUrl("lib/helpers.js")).toBe(`${MODULE_URL_PREFIX}lib/helpers.js`);
  });
});

describe("humanizeStack — real file, real line", () => {
  const stackOf = (frames: string[]): string => ["Error: boom", ...frames.map((f) => `    at ${f}`)].join("\n");

  it("subtracts the AsyncFunction wrapper offset and decodes the file name", () => {
    // ⊘ forgetting the offset entirely: every reported line is 2 too high, and
    // silently plausible — the whole point of this pass is that the number
    // matches the editor's gutter.
    const humanized = humanizeStack(
      stackOf([`login (${MODULE_URL_PREFIX}lib/helpers.js:14:9)`]),
      2
    );
    expect(humanized).toBe("Error: boom\n    at login (lib/helpers.js:12:9)");
  });

  it("decodes percent-escapes back to the name the author sees", () => {
    const humanized = humanizeStack(stackOf([`${MODULE_URL_PREFIX}my%20scripts/a.js:3:1`]), 2);
    expect(humanized).toContain("my scripts/a.js:1:1");
  });

  it("a name containing parentheses is attributed correctly — the parser anchors on the trailing :LINE:COL", () => {
    // ⊘ a `\(([^)]*)\)` frame parser: the inner ')' of the filename closes the
    // group early, so the frame is either left alone or rewritten with a
    // truncated name.
    const humanized = humanizeStack(stackOf([`fn (${MODULE_URL_PREFIX}a(1).js:5:7)`]), 2);
    expect(humanized).toBe("Error: boom\n    at fn (a(1).js:3:7)");
  });

  it("a name whose escaped form still contains digits and colons resolves to the right file, line and column", () => {
    // The A-F7 pair to the encoder test above: even if a colon somehow
    // survives into the URL, anchoring on the LAST :LINE:COL keeps the file
    // name whole rather than reading "1:2" out of the middle of it.
    const humanized = humanizeStack(stackOf([`fn (${MODULE_URL_PREFIX}a:1:2.js:9:4)`]), 2);
    expect(humanized).toBe("Error: boom\n    at fn (a:1:2.js:7:4)");
  });

  it("never rewrites a frame that is not ours, and never pushes a line below 1", () => {
    const foreign = stackOf(["Object.<anonymous> (/home/u/proj/index.js:14:9)", "node:internal/main:1:1"]);
    expect(humanizeStack(foreign, 2)).toBe(foreign);
    expect(humanizeStack(stackOf([`${MODULE_URL_PREFIX}a.js:1:1`]), 2)).toContain("a.js:1:1");
  });

  it("an undefined or empty stack is handled without throwing", () => {
    expect(humanizeStack(undefined, 2)).toBeUndefined();
    expect(humanizeStack("", 2)).toBe("");
  });
});

describe("measureAsyncFunctionLineOffset — measured, not assumed", () => {
  it("reports this V8's real AsyncFunction body offset, and memoises the probe", async () => {
    const first = await measureAsyncFunctionLineOffset();
    const second = await measureAsyncFunctionLineOffset();
    expect(first).toBe(DEFAULT_ASYNC_FUNCTION_LINE_OFFSET);
    expect(second).toBe(first);
  });

  it("falls back to the documented offset when the probe's stack cannot be parsed", () => {
    // ⊘ a probe whose parse failure yields NaN/undefined: every subsequent
    // line number would be `line - NaN` = NaN, i.e. no attribution at all,
    // for a stack shape change that should at worst cost 2 lines of accuracy.
    expect(asyncFunctionLineOffsetFromStack(undefined)).toBe(DEFAULT_ASYNC_FUNCTION_LINE_OFFSET);
    expect(asyncFunctionLineOffsetFromStack("Error: probe\n    at <anonymous>")).toBe(
      DEFAULT_ASYNC_FUNCTION_LINE_OFFSET
    );
    expect(asyncFunctionLineOffsetFromStack("总之 no frames here")).toBe(DEFAULT_ASYNC_FUNCTION_LINE_OFFSET);
    // A parseable probe frame IS honoured (proving the fallback isn't just a
    // constant return).
    expect(asyncFunctionLineOffsetFromStack(`Error: probe\n    at ${MODULE_URL_PREFIX}probe:6:1`)).toBe(5);
  });
});

describe("scriptModuleLoader.ts — worker bundle hygiene", () => {
  it("does not import vscode, directly or via scriptFs/scriptInclude", () => {
    // ⊘ importing `vscode` (or anything that transitively does) into a module
    // the worker bundle pulls in: the worker has no extension-host context and
    // the bundle crashes at load, taking every script with it.
    const source = readFileSync(
      path.resolve(__dirname, "..", "..", "..", "src", "services", "scripts", "scriptModuleLoader.ts"),
      "utf8"
    );
    expect(source).not.toMatch(/from\s+"vscode"/);
    expect(source).not.toMatch(/from\s+"\.\/scriptFs(Scope)?"/);
    expect(source).not.toMatch(/from\s+"\.\/scriptInclude"/);
  });
});

// -----------------------------------------------------------------------------
// Compilation + evaluation of one unit. These run in this test process's own
// isolate exactly as they do in the worker's — same AsyncFunction constructor,
// same wrapper, same stacks.
// -----------------------------------------------------------------------------

describe("evaluateScriptModule — what include() resolves to", () => {
  const facade = { fs: {}, include: () => Promise.resolve(undefined) };
  const run = (body: string): Promise<unknown> => evaluateScriptModule(body, "lib/x.js", facade);

  it("exports.<key> assignments are the module's exports", async () => {
    // ⊘ always returning the RETURN VALUE: this module returns nothing, so a
    // return-only implementation resolves to undefined and every property
    // access on the library explodes at the call site.
    await expect(run("exports.a = 1;\nexports.b = () => 2;")).resolves.toMatchObject({ a: 1 });
  });

  it("a reassigned module.exports wins over everything", async () => {
    const value = await run("module.exports = { only: true };\nexports.ignored = 1;\nreturn { alsoIgnored: true };");
    expect(value).toEqual({ only: true });
  });

  it("a bare `return` is used when — and only when — exports was never touched", async () => {
    // ⊘ always returning module.exports: `return { retry, backoff }` is the
    // natural thing to write in a body that genuinely IS a function body, and
    // it would silently yield `{}` — a wrong answer, not an error.
    await expect(run("const v = 41;\nreturn { v: v + 1 };")).resolves.toEqual({ v: 42 });
  });

  it("a touched exports object beats a returned value", async () => {
    // ⊘ always returning the return value: `exports.a` would be dropped on the
    // floor for a module that does both.
    await expect(run("exports.a = 1;\nreturn { b: 2 };")).resolves.toEqual({ a: 1 });
  });

  it("a module that neither exports nor returns resolves to an empty object, not undefined", async () => {
    await expect(run("const unused = 1;")).resolves.toEqual({});
  });

  it("a body that throws propagates ITS OWN error, unwrapped, with a stack naming the module", async () => {
    // ⊘ wrapping a module body's failure in an `IncludeFailed`: the wrapper
    // becomes the stack's top frame and the line the author needs is buried.
    const err = await run("\n\nthrow Object.assign(new Error('inner'), { code: 'InnerCode' });").catch(
      (e: Error & { code?: string }) => e
    );
    expect((err as Error).message).toBe("inner");
    expect((err as { code?: string }).code).toBe("InnerCode");
    expect((err as Error).stack).toContain(`${MODULE_URL_PREFIX}lib/x.js:`);
    // The wrapper's +2 is exactly what humanizeStack subtracts: the throw is
    // on source line 3 and V8 reports 5.
    expect(humanizeStack((err as Error).stack!, await measureAsyncFunctionLineOffset())).toContain("lib/x.js:3:");
  });
});

describe("compileScriptUnit — a syntax error names the file, and only a MODULE gets an Include code", () => {
  it("a module that does not compile throws IncludeSyntaxError naming the file", async () => {
    const err = await Promise.resolve()
      .then(() => compileScriptUnit("let x = ;", "lib/broken.js", "module"))
      .catch((e: Error & { code?: string; module?: string }) => e);
    expect((err as Error).message).toMatch(/^Failed to compile lib\/broken\.js: /);
    expect((err as { code?: string }).code).toBe("IncludeSyntaxError");
    expect((err as { module?: string }).module).toBe("lib/broken.js");
  });

  it("the ENTRY script keeps a code-less SyntaxError — a typo in a plain script must not surface an Include* code", () => {
    // ⊘ tagging every compile failure with IncludeSyntaxError (amendment
    // A-F6): a script with no includes at all would then report an include
    // error for its own typo, and `err.code` would mislead anyone branching
    // on it.
    let thrown: (Error & { code?: string }) | undefined;
    try {
      compileScriptUnit("let x = ;", "main.js", "entry");
    } catch (e) {
      thrown = e as Error & { code?: string };
    }
    expect(thrown).toBeInstanceOf(SyntaxError);
    expect(thrown!.message).toMatch(/^Failed to compile main\.js: /);
    expect(thrown!.code).toBeUndefined();
  });

  it("the entry unit is compiled with NO parameters, so a script may still shadow nexus/module/exports", async () => {
    // ⊘ parameterising the entry script the way modules are parameterised:
    // `const nexus = ...` in an existing, shipped script would become a
    // SyntaxError ("Identifier 'nexus' has already been declared") where today
    // it legally shadows the global.
    const fn = compileScriptUnit("const nexus = 1;\nconst module = 2;\nconst exports = 3;\nreturn nexus + module + exports;", "main.js", "entry");
    await expect((fn as () => Promise<unknown>)()).resolves.toBe(6);
  });

  it("`exports` in an ENTRY script is a loud ReferenceError, not a silently discarded assignment", async () => {
    // Amendment A-F3, decided deliberately: installing inert `module`/`exports`
    // globals for the entry script would type-check AND run, while throwing the
    // assignment away — and would flip the `typeof module !== "undefined"` UMD
    // probe that a pasted library uses to decide it is in CommonJS. A loud
    // failure with a documented fix (move the library part into an included
    // file) beats a silent wrong answer.
    // ⊘ installing global `module`/`exports` shims.
    const fn = compileScriptUnit("exports.foo = 1;", "main.js", "entry");
    await expect((fn as () => Promise<unknown>)()).rejects.toBeInstanceOf(ReferenceError);
  });
});
