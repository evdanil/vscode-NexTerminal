import * as esbuild from "esbuild";
import { cp, mkdir } from "node:fs/promises";
import { createRequire } from "node:module";

const production = process.argv.includes("--production");

// jsonc-parser ships a UMD `main` whose factory calls require("./impl/format")
// through a runtime-passed `require` esbuild can't statically resolve — esbuild
// then keeps the UMD wrapper verbatim and the deep requires dangle, so the
// packaged bundle throws "Cannot find module './impl/format'" at load (this
// silently shipped in v2.8.61 and bricked activation). Pin resolution to the
// package's ESM `module` build instead: its `import './impl/...'` statements
// ARE followed and inlined, so the bundle loads cleanly. Scoped to this one
// package via alias so no other dependency's resolution changes.
const jsoncParserEsm = createRequire(import.meta.url).resolve("jsonc-parser/lib/esm/main.js");

const common = {
  bundle: true,
  platform: "node",
  target: "es2022",
  format: "cjs",
  sourcemap: !production,
  minify: production,
  // Native .node files can't be bundled
  loader: { ".node": "empty" },
};

// Main extension — bundles ssh2 and all pure-JS deps
await esbuild.build({
  ...common,
  entryPoints: ["src/extension.ts"],
  outfile: "dist/extension.js",
  // ssh2 treats cpu-features as an optional native acceleration module and
  // catches require failures at runtime. Keep it external so local package
  // builds do not depend on a platform-specific cpufeatures.node artifact.
  external: ["vscode", "cpu-features"],
  alias: { "jsonc-parser": jsoncParserEsm },
});

// Web extension (browser fallback — no Node deps)
await esbuild.build({
  ...common,
  entryPoints: ["src/webExtension.ts"],
  outfile: "dist/webExtension.js",
  external: ["vscode"],
  platform: "browser",
});

// Serial sidecar worker — runs as child process, needs serialport at runtime
await esbuild.build({
  ...common,
  entryPoints: ["src/services/serial/serialSidecarWorker.ts"],
  outfile: "dist/services/serial/serialSidecarWorker.js",
  // serialport has native addons loaded via node-gyp-build — must stay in node_modules
  external: ["serialport"],
});

// Script runtime worker — runs in a node:worker_threads Worker spawned by ScriptRuntimeManager.
// Isolated V8 isolate so user-authored scripts can be terminate()d without blocking the extension host.
await esbuild.build({
  ...common,
  entryPoints: ["src/services/scripts/scriptWorker.ts"],
  outfile: "dist/services/scripts/scriptWorker.js",
  external: ["vscode"],
});

// Ship the IntelliSense .d.ts + jsconfig template alongside the worker so the
// runtime can copy them into user workspaces on first script invocation.
await mkdir("dist/services/scripts/assets", { recursive: true });
await cp("src/services/scripts/assets", "dist/services/scripts/assets", { recursive: true });

console.log("Build complete");
