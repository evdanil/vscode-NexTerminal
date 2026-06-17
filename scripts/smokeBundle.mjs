/**
 * Packaged-bundle smoke test.
 *
 * Loads the PRODUCTION-bundled dist/extension.js exactly the way VS Code's
 * extension host does — a bare require() of the file with `vscode` (and the
 * other declared-external native modules) stubbed. Module-level evaluation of
 * the whole import graph runs here, so any dependency that esbuild left as a
 * dangling runtime require (e.g. jsonc-parser's UMD `require("./impl/format")`,
 * which silently shipped in v2.8.61 and bricked activation) throws RIGHT HERE
 * instead of on a user's machine. Asserts the bundle loads and exports
 * activate()/deactivate().
 *
 * Run AFTER `node esbuild.mjs --production`. Exits non-zero on any failure so a
 * CI build fails before publish. This is the gate unit tests + a green esbuild
 * build do NOT provide: they exercise SOURCE (node_modules resolves), never the
 * packaged bundle with no node_modules alongside it.
 */
import { createRequire } from "node:module";
import Module from "node:module";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const bundlePath = path.resolve(here, "..", "dist", "extension.js");

if (!existsSync(bundlePath)) {
  console.error(`[smoke] dist/extension.js not found at ${bundlePath} — run \`node esbuild.mjs --production\` first.`);
  process.exit(1);
}

// Modules the MAIN extension bundle keeps external (see esbuild.mjs:
// external: ["vscode", "cpu-features"]). They are NOT in the bundle, so a bare
// require() of them resolves against node_modules / the host: `vscode` is
// provided by the extension host (absent here), and `cpu-features` is ssh2's
// optional native accel (ssh2 try/catches it). Stub both so module-level
// evaluation doesn't fail for an unrelated reason and mask — or falsely trip —
// the bundle-integrity check. NOTE: serialport is NOT external in the main
// bundle (it's inlined; external only in the sidecar-worker build), so it needs
// no stub here — any load-time problem in its inlined code SHOULD surface.
const EXTERNAL_STUBS = new Map([
  ["vscode", makeVscodeStub()],
  ["cpu-features", {}],
]);

const realLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (EXTERNAL_STUBS.has(request)) return EXTERNAL_STUBS.get(request);
  return realLoad.call(this, request, parent, isMain);
};

let exported;
try {
  const requireFromHere = createRequire(import.meta.url);
  exported = requireFromHere(bundlePath);
} catch (err) {
  console.error("[smoke] FAILED — packaged bundle threw at load:");
  console.error(err && err.stack ? err.stack : String(err));
  process.exit(1);
} finally {
  Module._load = realLoad;
}

const problems = [];
if (typeof exported?.activate !== "function") problems.push("missing exported activate()");
if (typeof exported?.deactivate !== "function") problems.push("missing exported deactivate()");

if (problems.length > 0) {
  console.error("[smoke] FAILED — " + problems.join("; "));
  process.exit(1);
}

console.log("[smoke] OK — dist/extension.js loads and exports activate()/deactivate().");

/**
 * Minimal `vscode` API stub covering the surface the extension touches at
 * module-load time (decorators, namespaces accessed while defining classes /
 * registering constants). It does NOT need to support activate() being called —
 * only that requiring the bundle evaluates cleanly.
 */
function makeVscodeStub() {
  const noop = () => undefined;
  const evt = () => ({ dispose: noop });
  return new Proxy(
    {
      EventEmitter: class {
        constructor() {
          this.event = evt;
        }
        fire() {}
        dispose() {}
      },
      Disposable: class {
        constructor() {}
        dispose() {}
        static from() {
          return { dispose: noop };
        }
      },
      Uri: { parse: (s) => ({ toString: () => String(s) }), file: (s) => ({ fsPath: String(s) }), joinPath: (...a) => ({ fsPath: a.join("/") }) },
      EventEmitterImpl: class {},
      ThemeIcon: class { constructor(id) { this.id = id; } },
      ThemeColor: class { constructor(id) { this.id = id; } },
      TreeItem: class { constructor(label) { this.label = label; } },
      TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
      MarkdownString: class { constructor(v) { this.value = v; } appendMarkdown() { return this; } },
      Range: class {},
      Position: class {},
      CodeLens: class {},
      RelativePattern: class {},
      window: new Proxy({}, { get: () => noop }),
      workspace: new Proxy({ getConfiguration: () => ({ get: noop, update: noop, inspect: noop, has: noop }), onDidChangeConfiguration: evt, workspaceFolders: undefined }, { get: (t, p) => (p in t ? t[p] : noop) }),
      commands: new Proxy({}, { get: () => noop }),
      languages: new Proxy({}, { get: () => noop }),
      env: new Proxy({}, { get: () => undefined }),
      extensions: new Proxy({}, { get: () => noop }),
      ViewColumn: { One: 1, Two: 2, Active: -1, Beside: -2 },
      StatusBarAlignment: { Left: 1, Right: 2 },
      ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
      TerminalLocation: { Panel: 1, Editor: 2 },
      ProgressLocation: { Notification: 15, Window: 10, SourceControl: 1 },
      FileType: { Unknown: 0, File: 1, Directory: 2, SymbolicLink: 64 },
      TreeItemCheckboxState: { Unchecked: 0, Checked: 1 },
    },
    { get: (t, p) => (p in t ? t[p] : new Proxy(noop, { get: () => noop })) }
  );
}
