import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createRequire, isBuiltin } from "node:module";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import type { BuildOptions } from "esbuild";
import { beforeAll, describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "..", "..");
const rootRequire = createRequire(path.join(ROOT, "package.json"));

interface LockEntry {
  dev?: boolean;
  optional?: boolean;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}

/**
 * Externals a bundle may name although the VSIX leaves them out. cpu-features
 * is ssh2's optional native accelerator: ssh2 try/catches its require and runs
 * without it, and it would need a build per platform, so it is excluded on
 * purpose. It is exempt only while package-lock.json marks it optional.
 */
const UNSHIPPED_OPTIONAL_EXTERNALS = new Set(["cpu-features"]);

/** Lockfile keys a bundle names as `external`, i.e. loads from node_modules at run time. */
let roots: string[];
/** Externals neither the host provides nor the VSIX can carry: no production lockfile entry. */
let unprovidedExternals: string[];
/** `roots` plus everything they require, resolved the way Node resolves it. */
let mustShip: Set<string>;
/** Production lockfile keys with at least one file that survives .vscodeignore. */
let shipped: Set<string>;
/** Whether `vsce package` keeps this repo-relative file, per .vscodeignore. */
let wouldShip: (file: string) => boolean;

/**
 * What vsce collects for one package: every file under it except its own
 * node_modules, whose packages are lockfile keys of their own.
 */
function filesOf(key: string): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      const child = `${dir}/${entry.name}`;
      if (!entry.isDirectory()) found.push(child);
      else if (child !== `${key}/node_modules`) walk(child);
    }
  };
  if (existsSync(path.join(ROOT, key))) walk(key);
  return found;
}

const isPrebuiltAddon = (file: string): boolean => /\/prebuilds\/.+\.node$/.test(file);

beforeAll(async () => {
  const lock = (JSON.parse(readFileSync(path.join(ROOT, "package-lock.json"), "utf8")) as {
    packages: Record<string, LockEntry>;
  }).packages;

  // The REAL build configurations, as esbuild.mjs consumes them — for the same
  // reason test/unit/esbuildWorkerIsolation.test.ts reads them: a copy would
  // stay green after someone added an external to the real build.
  const { createBuildConfigs } = (await import(
    pathToFileURL(path.join(ROOT, "scripts", "buildConfigs.mjs")).href
  )) as { createBuildConfigs(options: { production: boolean }): BuildOptions[] };
  const packageName = (spec: string): string => spec.split("/").slice(0, spec.startsWith("@") ? 2 : 1).join("/");
  roots = [];
  unprovidedExternals = [];
  const externals = new Set(
    createBuildConfigs({ production: true }).flatMap((config) => (config.external ?? []).map(packageName))
  );
  for (const name of externals) {
    // The extension host provides `vscode`, and Node its built-ins.
    if (name === "vscode" || isBuiltin(name)) continue;
    const key = `node_modules/${name}`;
    const entry = lock[key];
    if (!entry || entry.dev) unprovidedExternals.push(name);
    else if (!(entry.optional && UNSHIPPED_OPTIONAL_EXTERNALS.has(name))) roots.push(key);
  }

  // Node's lookup: the nearest node_modules/<name>, walking up from the dependent.
  const resolveDependency = (fromKey: string, name: string): string | undefined => {
    for (let base = fromKey; ; ) {
      const nested = `${base}/node_modules/${name}`;
      if (lock[nested]) return nested;
      const up = base.lastIndexOf("/node_modules/");
      if (up < 0) return lock[`node_modules/${name}`] ? `node_modules/${name}` : undefined;
      base = base.slice(0, up);
    }
  };
  mustShip = new Set<string>();
  const queue = [...roots];
  for (let key = queue.pop(); key !== undefined; key = queue.pop()) {
    if (mustShip.has(key)) continue;
    mustShip.add(key);
    const { dependencies = {}, optionalDependencies = {} } = lock[key];
    for (const name of Object.keys({ ...dependencies, ...optionalDependencies })) {
      const resolved = resolveDependency(key, name);
      if (resolved) queue.push(resolved);
      else if (name in dependencies) throw new Error(`package-lock.json has no entry for ${name}, required by ${key}`);
    }
  }

  // vsce's own matcher, so every pattern means here exactly what it means
  // when packaging.
  const { Minimatch } = createRequire(rootRequire.resolve("@vscode/vsce"))("minimatch") as {
    Minimatch: new (pattern: string, options: { dot: boolean }) => { match(file: string): boolean };
  };
  // The filter in vsce's collectFiles() (node_modules/@vscode/vsce/out/package.js):
  // a pattern with no wildcard in its last segment also matches as a folder,
  // and a file is dropped when ANY ignore pattern matches it and NO `!`
  // pattern does — line order plays no part. vsce's built-in default ignores
  // are left out: inside node_modules they only drop things like .git,
  // .DS_Store and *.vsix, which no package needs to run. At the top level they
  // also drop CONTRIBUTING.md, .gitattributes and the like, and vsce always
  // keeps package.json and README.md; no test here asks about any of those.
  const lines = readFileSync(path.join(ROOT, ".vscodeignore"), "utf8")
    .split(/[\n\r]/)
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"));
  const patterns = [
    ...lines,
    ...lines.filter((line) => !/(^|\/)[^/]*\*[^/]*$/.test(line)).map((line) => (line.endsWith("/") ? `${line}**` : `${line}/**`))
  ];
  const ignore = patterns.filter((p) => !p.startsWith("!")).map((p) => new Minimatch(p, { dot: true }));
  const negate = patterns.filter((p) => p.startsWith("!")).map((p) => new Minimatch(p.slice(1), { dot: true }));
  wouldShip = (file) => !ignore.some((m) => m.match(file)) || negate.some((m) => m.match(file));

  shipped = new Set(Object.keys(lock).filter((key) => key !== "" && !lock[key].dev && filesOf(key).some(wouldShip)));
});

/**
 * The extension is bundled by esbuild; the only things a bundle loads from
 * node_modules at run time are its non-optional `external`s (serialport, for
 * the serial sidecar) and their own dependencies. Every other production
 * dependency is compiled into dist/*.js or, like the optional cpu-features,
 * left out because its importer runs without it, so shipping its files is dead
 * weight — and the copy a VSIX scanner flags is one nothing ever loads. These
 * tests hold .vscodeignore to that line in both directions, deriving it from
 * package-lock.json and the real build configuration rather than from a list
 * kept by hand.
 */
describe("the VSIX ships exactly the node_modules the bundles load from disk", () => {
  it("checks a real dependency closure", () => {
    expect(
      roots,
      "no bundle in scripts/buildConfigs.mjs names serialport as an `external` any more: if that is deliberate, " +
        "anchor this check on another package a bundle loads from disk"
    ).toContain("node_modules/serialport");
    expect(
      [...mustShip].filter((key) => !existsSync(path.join(ROOT, key))),
      "package-lock.json lists these but they are not installed: run npm ci"
    ).toEqual([]);
    expect(
      [...mustShip].flatMap(filesOf).filter(isPrebuiltAddon),
      "no package a bundle loads from disk carries a prebuilt native addon any more: the native-addon half of " +
        "the run-time file check below now proves nothing"
    ).not.toEqual([]);
  });

  it("ships no package the bundles already inline", () => {
    expect(
      [...shipped].filter((key) => !mustShip.has(key)),
      "esbuild compiles these into dist/*.js and nothing loads them from node_modules: add `node_modules/<name>/**` " +
        "to .vscodeignore for each (never a `!node_modules/...` line — a `!` pattern beats every ignore)"
    ).toEqual([]);
  });

  it("ships every package a bundle loads from disk", () => {
    expect(
      unprovidedExternals,
      "a bundle names these as `external` in scripts/buildConfigs.mjs, so it loads them from node_modules at run " +
        "time, but package-lock.json has no production entry for them and the VSIX cannot carry them"
    ).toEqual([]);
    expect(
      [...mustShip].filter((key) => !shipped.has(key)),
      "a bundle requires these from node_modules at run time (an `external` in scripts/buildConfigs.mjs, or a " +
        "dependency of one): remove the .vscodeignore line that drops them"
    ).toEqual([]);
  });

  it("keeps every file those packages need at run time", () => {
    // What Node loads (.js, .cjs, .node) or reads to resolve a package (.json,
    // package.json above all); dot-files such as .eslintrc.cjs are tool
    // configuration, not code. A package-root build/ is node-gyp's compile
    // output and is left out on purpose — the addons in prebuilds/ are what
    // ships — so each package's entry point is also checked by name, in case
    // it lives under build/.
    const runtimeFiles = [...mustShip].flatMap((key) =>
      filesOf(key).filter((file) => /\/[^./][^/]*\.(c?js|json|node)$/.test(file) && !file.startsWith(`${key}/build/`))
    );
    const entries = [...mustShip].map((key) =>
      path.relative(ROOT, rootRequire.resolve(path.join(ROOT, key))).split(path.sep).join("/")
    );
    expect(
      [...new Set([...entries, ...runtimeFiles])].filter((file) => !wouldShip(file)),
      "a bundle loads these files from node_modules at run time: narrow the .vscodeignore line that drops them"
    ).toEqual([]);
  });
});

describe("the VSIX leaves out build-time inputs", () => {
  // patch-package applies patches/ to node_modules during npm ci, before
  // esbuild compiles the patched code into the bundles, and .ignore is a
  // ripgrep rule for searching the repository. Nothing reads either at run time.
  it("ships no patch file and no .ignore", () => {
    const buildInputs = [...readdirSync(path.join(ROOT, "patches")).map((name) => `patches/${name}`), ".ignore"];
    expect(buildInputs.filter(wouldShip)).toEqual([]);
  });
});

/**
 * vsce reads .vscodeignore and its own defaults, never .gitignore, so a file
 * git ignores still ships in a VSIX packaged from a maintainer's checkout
 * unless .vscodeignore drops it. CI packages a fresh checkout, which has none
 * of these, so a release build cannot catch a gap here; only this test can.
 */
describe("the VSIX leaves out local tooling", () => {
  it("ships no top-level dot-file or dot-folder, including one no line names", () => {
    const dotEntries = [
      // Tool state a maintainer's checkout holds or .gitignore names: assistant
      // session memory, MCP server configuration (it can carry tokens),
      // worktrees, and working folders.
      ".remember/now.md",
      ".superpowers/state.json",
      ".agents/notes.md",
      ".mcp.json",
      ".claude/settings.local.json",
      ".codex",
      ".specify/memory.md",
      ".worktrees/issue-1/package.json",
      ".demo-lab/record.sh",
      // Made up: a tool adopted after this test was written.
      ".newtool.json",
      ".some-new-tool/cache/state.db"
    ];
    expect(dotEntries.filter(wouldShip)).toEqual([]);
  });

  it("ships none of the non-dot tool entries", () => {
    // Unlike dot-entries, a non-dot top-level name can be the extension's own
    // (dist/, media/, LICENSE), so these have to be named one by one.
    const toolEntries = ["graft/INDEX.md", "graft/nodes/src/extension.md", "opencode.json"];
    expect(toolEntries.filter(wouldShip)).toEqual([]);
  });
});
