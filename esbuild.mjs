import * as esbuild from "esbuild";

const production = process.argv.includes("--production");

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
  external: ["vscode"],
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

console.log("Build complete");
