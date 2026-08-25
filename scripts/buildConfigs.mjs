import { createRequire } from "node:module";

/**
 * Turns an accidental `vscode` import inside an out-of-host bundle into a BUILD
 * error naming the offending file.
 *
 * Marking `vscode` external is what previously let such an import through:
 * esbuild then emits a bare `require("vscode")`, which resolves only under the
 * extension host's injected module loader. The script worker (a
 * node:worker_threads Worker) and the network server daemon (a bare Node child
 * process) have no such loader, so the import failed at RUNTIME, inside an
 * isolated process, instead of here. Both source files carried a comment saying
 * they must not import `vscode`; this enforces it.
 *
 * Applied ONLY to the out-of-host bundles. dist/extension.js and
 * dist/webExtension.js legitimately keep `vscode` external — it is the host API
 * they are written against.
 */
export function denyVscodeImport(bundleLabel) {
  return {
    name: "deny-vscode-import",
    setup(build) {
      build.onResolve({ filter: /^vscode$/ }, (args) => ({
        errors: [
          {
            text:
              `${bundleLabel} must not import the \`vscode\` module — it runs outside the ` +
              `extension host, where that module does not exist. Imported by ${args.importer}. ` +
              `Move whatever needs the vscode API to the main-thread orchestrator and pass the ` +
              `result across the existing RPC boundary.`
          }
        ]
      }));
    }
  };
}

// jsonc-parser ships a UMD `main` whose factory calls require("./impl/format")
// through a runtime-passed `require` esbuild can't statically resolve — esbuild
// then keeps the UMD wrapper verbatim and the deep requires dangle, so the
// packaged bundle throws "Cannot find module './impl/format'" at load (this
// silently shipped in v2.8.61 and bricked activation). Pin resolution to the
// package's ESM `module` build instead: its `import './impl/...'` statements
// ARE followed and inlined, so the bundle loads cleanly. Scoped to this one
// package via alias so no other dependency's resolution changes.
const jsoncParserEsm = createRequire(import.meta.url).resolve("jsonc-parser/lib/esm/main.js");

/**
 * Every esbuild build this repository performs, as data.
 *
 * Extracted from esbuild.mjs so test/unit/esbuildWorkerIsolation.test.ts can
 * assert against the REAL configurations rather than a copy of them. A test
 * that attached the isolation plugin itself would prove only that the plugin
 * works, and would stay green if someone deleted it from the build.
 */
export function createBuildConfigs({ production }) {
  const common = {
    bundle: true,
    platform: "node",
    target: "es2022",
    format: "cjs",
    sourcemap: !production,
    minify: production,
    // Native .node files can't be bundled
    loader: { ".node": "empty" }
  };

  return [
    // Main extension — bundles ssh2 and all pure-JS deps.
    {
      ...common,
      entryPoints: ["src/extension.ts"],
      outfile: "dist/extension.js",
      // ssh2 treats cpu-features as an optional native acceleration module and
      // catches require failures at runtime. Keep it external so local package
      // builds do not depend on a platform-specific cpufeatures.node artifact.
      external: ["vscode", "cpu-features"],
      alias: { "jsonc-parser": jsoncParserEsm }
    },

    // Web extension (browser fallback — no Node deps).
    {
      ...common,
      entryPoints: ["src/webExtension.ts"],
      outfile: "dist/webExtension.js",
      external: ["vscode"],
      platform: "browser"
    },

    // Serial sidecar worker — runs as a child process, needs serialport at
    // runtime. serialport has native addons loaded via node-gyp-build and must
    // stay in node_modules.
    {
      ...common,
      entryPoints: ["src/services/serial/serialSidecarWorker.ts"],
      outfile: "dist/services/serial/serialSidecarWorker.js",
      external: ["serialport"]
    },

    // Script runtime worker — runs in a node:worker_threads Worker spawned by
    // ScriptRuntimeManager. Isolated V8 isolate so user-authored scripts can be
    // terminate()d without blocking the extension host.
    {
      ...common,
      entryPoints: ["src/services/scripts/scriptWorker.ts"],
      outfile: "dist/services/scripts/scriptWorker.js",
      plugins: [denyVscodeImport("The script worker bundle")]
    },

    // Network servers daemon — a child process managed by NetworkServerManager.
    // Hosts the TFTP + DHCP adapters out-of-process so they can bind privileged
    // UDP ports and crash without taking the extension host down. It is spawned
    // as a bare Node script and receives all configuration over RPC/env.
    // `dhcp` is pure JS, so it bundles in with no external needed.
    {
      ...common,
      entryPoints: ["src/services/networkServers/networkServerDaemon.ts"],
      outfile: "dist/services/networkServers/networkServerDaemon.js",
      plugins: [denyVscodeImport("The network server daemon bundle")]
    }
  ];
}
