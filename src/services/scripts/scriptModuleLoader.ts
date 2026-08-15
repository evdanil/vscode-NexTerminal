/**
 * Worker-side half of `nexus.include()`: the per-run module table, the
 * specifier memo, and the two pure helpers that make a thrown error name the
 * file and line the author actually wrote.
 *
 * IMPORTANT: part of the WORKER bundle — no `vscode` import, and nothing that
 * transitively imports one (so: no `scriptFs`, no `scriptInclude`). Everything
 * that decides which file a specifier means lives on the main thread; this
 * module only remembers what main already decided.
 *
 * WHY MODULES ARE KEYED BY MAIN'S `moduleId` AND NOT BY THE SPECIFIER: the
 * specifier is relative to whoever wrote it, so `"./b.js"` is a different file
 * in every folder. Main resolves that question and hands back an opaque id; two
 * different specifiers that reach the same file get the SAME id, which is what
 * makes "one module, one evaluation, one exports object per run" hold no matter
 * how it was spelled. The specifier memo on top of that is a pure round-trip
 * saving, and is keyed by parent + specifier precisely because a bare specifier
 * has no meaning on its own.
 */
import { SCRIPT_INCLUDE_ROOT_ID, type IncludeLoadResult } from "./scriptTypes";

/**
 * Scheme + root for the `//# sourceURL` every compiled unit carries. A scheme
 * of its own (rather than a bare path) keeps our frames unambiguously ours in a
 * stack that also contains real files, and keeps them from looking like
 * clickable local paths that do not exist.
 */
export const MODULE_URL_PREFIX = "nexus-script:/";

/**
 * How many lines V8's `AsyncFunction` wrapper adds above a compiled body:
 * `new AsyncFunction(body).toString()` is `"async function anonymous(\n) {\n" +
 * body + "\n}"`, so body line N is reported as line N + 2. Measured at runtime
 * by `measureAsyncFunctionLineOffset` (this constant is only the fallback), so
 * a future V8 wrapper change costs accuracy, never correctness.
 */
export const DEFAULT_ASYNC_FUNCTION_LINE_OFFSET = 2;

/**
 * Characters that must not appear literally in a `sourceURL`.
 *
 * Whitespace is the load-bearing one: V8 silently IGNORES a sourceURL directive
 * whose URL contains any (measured — it does not warn, the frame just falls
 * back to `<anonymous>`), so an unescaped space would quietly undo this whole
 * feature for anyone whose folder has a space in its name. (Whitespace BEFORE
 * the directive is fine — an indented `//# sourceURL` still names the frame.)
 * `#` and `?` would make the tail of a name read as a fragment/query, and `:`
 * is escaped so a name containing `:12:9` cannot be mistaken for the trailing
 * line:column a stack frame ends with.
 */
const MODULE_URL_ESCAPE_RE = /[%\s#?:]/g;

/**
 * Our frames in a V8 stack. The name group is GREEDY and the pattern is
 * anchored on the trailing `:LINE:COL`, which is the only reliable anchor: a
 * display name may legally contain parentheses (so a `\(([^)]*)\)` frame parser
 * closes early on `a(1).js`) and — before escaping — could contain colons and
 * digits of its own. Greedy + backtracking always yields the LAST `:N:N` in the
 * frame, which is the location V8 appended.
 */
const MODULE_FRAME_RE = /nexus-script:\/(\S+):(\d+):(\d+)/g;

/** Percent-escape a display name into a URL V8 will honour. */
export function encodeModuleUrl(displayName: string): string {
  // `%` is inside the character class, and `String.replace` scans left to
  // right without revisiting its own output, so escaping in one pass cannot
  // double-escape: every `%` in the result is one this function wrote.
  return (
    MODULE_URL_PREFIX +
    displayName.replace(MODULE_URL_ESCAPE_RE, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`)
  );
}

function decodeModuleUrl(encoded: string): string {
  try {
    return decodeURIComponent(encoded);
  } catch {
    // An exotic whitespace codepoint escapes to a byte that is not valid UTF-8
    // on its own, which `decodeURIComponent` rejects. A slightly ugly name in
    // a stack frame beats losing the frame.
    return encoded;
  }
}

/**
 * Rewrite every `nexus-script:` frame in `stack` into `<file>:<line>:<col>` with
 * the real line the author wrote, and leave every other character of the string
 * exactly as it was (frames from real files, the message, async separators).
 *
 * This is the whole of Phase 2's attribution story: no sourcemaps, no `vm`, no
 * `Error.prepareStackTrace` override (that hook is per-isolate and would
 * surprise user code that installs its own).
 */
export function humanizeStack(stack: string, lineOffset: number): string;
export function humanizeStack(stack: string | undefined, lineOffset: number): string | undefined;
export function humanizeStack(stack: string | undefined, lineOffset: number): string | undefined {
  if (typeof stack !== "string" || stack === "") return stack;
  return stack.replace(MODULE_FRAME_RE, (_match, name: string, line: string, column: string) => {
    // Clamped at 1: a frame reported inside the wrapper itself (or a future
    // wrapper with fewer lines) must not produce line 0 or a negative.
    const humanLine = Math.max(1, Number(line) - lineOffset);
    return `${decodeModuleUrl(name)}:${humanLine}:${column}`;
  });
}

/**
 * The offset carried by a probe's stack: the probe throws from body line 1, so
 * whatever line V8 reports IS the offset + 1.
 *
 * Total by construction — an unparseable stack yields the documented fallback
 * rather than `NaN`, because every subsequent line number is computed by
 * subtracting this value and `line - NaN` is `NaN`: a stack-shape change would
 * otherwise cost every frame its location instead of costing two lines of
 * accuracy. Exported for the fallback path's own test.
 */
export function asyncFunctionLineOffsetFromStack(stack: string | undefined): number {
  if (typeof stack !== "string") return DEFAULT_ASYNC_FUNCTION_LINE_OFFSET;
  MODULE_FRAME_RE.lastIndex = 0;
  const match = MODULE_FRAME_RE.exec(stack);
  MODULE_FRAME_RE.lastIndex = 0;
  if (!match) return DEFAULT_ASYNC_FUNCTION_LINE_OFFSET;
  const reported = Number(match[2]);
  if (!Number.isFinite(reported) || reported < 1) return DEFAULT_ASYNC_FUNCTION_LINE_OFFSET;
  return reported - 1;
}

let lineOffsetProbe: Promise<number> | undefined;

/**
 * Measure — once per worker, memoised — how many lines V8's `AsyncFunction`
 * wrapper adds, by compiling a one-line body that throws and reading the line
 * it is reported on. Measuring beats hardcoding: the number is a V8
 * implementation detail, and a silent drift would put every line number in
 * every stack quietly off by a constant.
 */
export function measureAsyncFunctionLineOffset(): Promise<number> {
  if (!lineOffsetProbe) lineOffsetProbe = runLineOffsetProbe();
  return lineOffsetProbe;
}

async function runLineOffsetProbe(): Promise<number> {
  try {
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (
      body: string
    ) => () => Promise<unknown>;
    // Body line 1 throws; the sourceURL makes the frame unambiguously ours, so
    // the parser cannot pick up an unrelated frame from the host stack.
    const probe = new AsyncFunction(
      `throw new Error("nexus line probe");\n//# sourceURL=${encodeModuleUrl("nexus-line-probe")}\n`
    );
    await probe();
    return DEFAULT_ASYNC_FUNCTION_LINE_OFFSET; // unreachable: the body always throws
  } catch (err) {
    return asyncFunctionLineOffsetFromStack((err as { stack?: string })?.stack);
  }
}

/**
 * The two kinds of compiled unit, and the one difference between them.
 *
 * A `module` is compiled WITH parameters (`module`, `exports`, `nexus`), which
 * is what gives an included file a lexically-scoped, per-file `nexus` facade:
 * `nexus.include("./sibling.js")` inside it resolves against ITS folder, even
 * from a callback that outlives its body, with no runtime "current module"
 * tracking (which is provably wrong for async modules) anywhere.
 *
 * The `entry` script is compiled with NO parameters — byte-identical to Phase 1
 * — because a parameter named `nexus`/`module`/`exports` turns `const nexus =
 * …` in an ALREADY-SHIPPED script into a SyntaxError ("Identifier has already
 * been declared") where today it legally shadows the global. Its facade is
 * installed on the global instead. The visible cost is that `exports` in an
 * entry script is a ReferenceError; that is deliberate and documented (A-F3) —
 * inert `module`/`exports` globals would silently discard the assignment and
 * flip the `typeof module !== "undefined"` probe a pasted UMD library uses.
 */
export type ScriptUnitKind = "entry" | "module";

type AsyncFunctionConstructor = new (...args: string[]) => (...args: unknown[]) => Promise<unknown>;

function asyncFunctionConstructor(): AsyncFunctionConstructor {
  return Object.getPrototypeOf(async function () {}).constructor as AsyncFunctionConstructor;
}

/**
 * Compile one unit of user source, with the `//# sourceURL` that makes its
 * stack frames name the file instead of `<anonymous>`.
 *
 * The directive is APPENDED (last one wins in V8, measured), so a sourceURL the
 * user's own source happens to contain cannot displace ours.
 *
 * A syntax error carries no location — V8 gives none for `Function`/
 * `AsyncFunction` construction, ever (measured) — so the most this can do is
 * name the file it was compiling and hand the line-level job back to the
 * editor's own diagnostics. Only a MODULE's failure gets the
 * `IncludeSyntaxError` code (A-F6): an entry script's typo is a plain
 * `SyntaxError`, as it has always been, so a script with no includes at all
 * never reports an include error.
 */
export function compileScriptUnit(
  source: string,
  displayName: string,
  kind: ScriptUnitKind
): (...args: unknown[]) => Promise<unknown> {
  const AsyncFunction = asyncFunctionConstructor();
  const body = `${source}\n//# sourceURL=${encodeModuleUrl(displayName)}\n`;
  try {
    return kind === "module"
      ? new AsyncFunction("module", "exports", "nexus", body)
      : new AsyncFunction(body);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    const failure = new SyntaxError(`Failed to compile ${displayName}: ${detail}`);
    if (kind === "module") Object.assign(failure, { code: "IncludeSyntaxError", module: displayName });
    throw failure;
  }
}

/**
 * Compile and run one module body, resolving to what `nexus.include()` hands
 * back.
 *
 * EXPORTS PRECEDENCE, in order:
 *  1. a reassigned `module.exports` — the most explicit statement available;
 *  2. otherwise, the initial `exports` object if the body put anything on it;
 *  3. otherwise, the body's own `return` value, if it returned one;
 *  4. otherwise, the (empty) exports object — never `undefined`.
 *
 * Rule 3 exists because in this runtime a module body genuinely IS an async
 * function body, so `return { retry, backoff }` is the natural thing to write —
 * and without it that module would resolve to `{}`: a silent wrong answer,
 * exactly the class this codebase's conventions hunt for. Rules 1-2 come first
 * so a module that does both keeps the CommonJS meaning.
 *
 * A body that throws propagates its own error untouched — no `IncludeFailed`
 * wrapper, so the stack's top frame stays the line that threw.
 */
export async function evaluateScriptModule(
  source: string,
  displayName: string,
  nexus: unknown
): Promise<unknown> {
  const compiled = compileScriptUnit(source, displayName, "module");
  const initialExports: Record<PropertyKey, unknown> = {};
  const moduleObject = { exports: initialExports as unknown };
  const returned = await compiled(moduleObject, initialExports, nexus);
  if (moduleObject.exports !== initialExports) return moduleObject.exports;
  if (Reflect.ownKeys(initialExports).length > 0) return initialExports;
  if (returned !== undefined) return returned;
  return initialExports;
}

/** What the loader needs from its host: main-thread resolution, and evaluation. */
export interface ModuleLoaderDeps {
  /** Round-trips `include.load` to the main thread. */
  load(specifier: unknown, chain: string[]): Promise<IncludeLoadResult>;
  /**
   * Compiles and runs one module body, resolving to its exports. `chain` ends
   * with the new module's own id, which is what the facade handed to that body
   * uses as the base for ITS relative paths.
   */
  evaluate(source: string, displayName: string, chain: string[]): Promise<unknown>;
}

/** One module's single evaluation, shared by every include that reaches it. */
interface ModuleEntry {
  exports: Promise<unknown>;
}

export class ScriptModuleLoader {
  /** moduleId → the one evaluation of that module. Never deleted — see below. */
  private readonly modules = new Map<string, ModuleEntry>();
  /** `parentId + "\0" + specifier` → moduleId, for SUCCESSFUL edges only. */
  private readonly specifierMemo = new Map<string, string>();

  public constructor(private readonly deps: ModuleLoaderDeps) {}

  /**
   * Resolve `specifier`, written inside the file at the end of `chain`, to that
   * module's exports.
   *
   * FAILURE IS STICKY. A module whose compile or body threw keeps its rejected
   * promise in the table, so every later include of it rejects with the same
   * error rather than re-running a body that already ran halfway. (Main-side
   * REFUSALS — a cycle, a missing file, a marked script — never reach this
   * table at all and are re-evaluated on every call.)
   */
  public async include(chain: string[], specifier: unknown): Promise<unknown> {
    const parentId = chain.length > 0 ? chain[chain.length - 1] : SCRIPT_INCLUDE_ROOT_ID;
    const memoKey = typeof specifier === "string" ? `${parentId}\0${specifier}` : undefined;
    if (memoKey !== undefined) {
      const memoised = this.specifierMemo.get(memoKey);
      if (memoised !== undefined) {
        const entry = this.modules.get(memoised);
        // A memo entry only exists for an edge that already completed a load,
        // so the module entry always exists; if it somehow does not, say so
        // rather than silently re-requesting.
        if (!entry) throw includeInternal(`memoised module ${memoised} is missing from the module table`);
        return await entry.exports;
      }
    }

    const result = await this.deps.load(specifier, chain);
    let entry = this.modules.get(result.moduleId);
    if (!entry) {
      if (result.cached) {
        // Main only omits the source when it has already delivered it to THIS
        // worker in THIS run, so there is nothing to evaluate and nothing to
        // hand back — a protocol violation, not a state we can recover from.
        throw includeInternal(
          `main reported ${result.displayName} as already delivered, but this worker has no module for it`
        );
      }
      if (typeof result.source !== "string") {
        throw includeInternal(`main delivered ${result.displayName} without source`);
      }
      // Stored BEFORE the first await on it, so a concurrent include arriving
      // while this body is still running joins the same evaluation instead of
      // starting a second one.
      entry = { exports: this.deps.evaluate(result.source, result.displayName, [...chain, result.moduleId]) };
      this.modules.set(result.moduleId, entry);
    }

    const exports = await entry.exports;
    // Successful edges only: a refusal must stay re-askable (the condition
    // behind it — an unsaved file, a stopped run — can be transient), and a
    // memo entry for an edge that never completed could mask a later cycle.
    if (memoKey !== undefined) this.specifierMemo.set(memoKey, result.moduleId);
    return exports;
  }
}

function includeInternal(detail: string): Error & { code: string } {
  return Object.assign(new Error(`${detail} — this should never happen; please file an issue.`), {
    code: "IncludeInternal"
  });
}
