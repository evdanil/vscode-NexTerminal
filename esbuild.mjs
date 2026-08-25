import * as esbuild from "esbuild";
import { cp, mkdir } from "node:fs/promises";
import { createBuildConfigs } from "./scripts/buildConfigs.mjs";

const production = process.argv.includes("--production");

// The configurations live in scripts/buildConfigs.mjs so the isolation test can
// assert against the same objects this runner consumes — see that module's
// createBuildConfigs doc comment.
for (const config of createBuildConfigs({ production })) {
  await esbuild.build(config);
}

// Ship the IntelliSense .d.ts + jsconfig template alongside the worker so the
// runtime can copy them into user workspaces on first script invocation.
await mkdir("dist/services/scripts/assets", { recursive: true });
await cp("src/services/scripts/assets", "dist/services/scripts/assets", { recursive: true });

console.log("Build complete");
