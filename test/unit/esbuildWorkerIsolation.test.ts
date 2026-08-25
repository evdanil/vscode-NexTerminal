import * as path from "node:path";
import { describe, expect, it } from "vitest";
import * as esbuild from "esbuild";
import { createBuildConfigs } from "../../scripts/buildConfigs.mjs";

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const FIXTURE = path.join(REPO_ROOT, "test", "fixtures", "esbuild", "importsVscode.ts");

function configFor(suffix: string) {
  const config = createBuildConfigs({ production: true }).find((c) => c.outfile.endsWith(suffix));
  if (!config) {
    throw new Error(`no build config produces a file ending in ${suffix}`);
  }
  return config;
}

/**
 * The script worker runs in a node:worker_threads Worker and the network
 * server daemon runs as a bare Node child process. Neither has the extension
 * host's injected `vscode` module loader, so a require("vscode") reaching
 * either bundle is a runtime crash in an isolated process — the hardest place
 * in this codebase to diagnose. Both source files say "MUST NOT import
 * vscode" in a comment; this is what makes the comment true.
 *
 * These assertions run against the SAME configuration objects esbuild.mjs
 * consumes. That is the point: a test that builds with a plugin it attached
 * itself would stay green after someone deleted the plugin from the real
 * build.
 */
describe("out-of-host bundles are isolated from the vscode module", () => {
  const OUT_OF_HOST = [
    ["the script worker", "scriptWorker.js"],
    ["the network server daemon", "networkServerDaemon.js"],
    ["the serial sidecar worker", "serialSidecarWorker.js"]
  ] as const;

  for (const [label, suffix] of OUT_OF_HOST) {
    it(`${label} config does not declare vscode external`, () => {
      expect(configFor(suffix).external ?? []).not.toContain("vscode");
    });

    it(`${label} config installs the deny-vscode-import plugin`, () => {
      const names = (configFor(suffix).plugins ?? []).map((p: { name: string }) => p.name);
      expect(names).toContain("deny-vscode-import");
    });

    it(`${label} config rejects a build whose entry imports vscode`, async () => {
      const build = esbuild.build({
        ...configFor(suffix),
        entryPoints: [FIXTURE],
        outfile: undefined,
        write: false,
        logLevel: "silent"
      });

      await expect(build).rejects.toThrow(/vscode/i);
    });

    it(`${label} rejection names the importing file`, async () => {
      let serialized = "";
      try {
        await esbuild.build({
          ...configFor(suffix),
          entryPoints: [FIXTURE],
          outfile: undefined,
          write: false,
          logLevel: "silent"
        });
      } catch (err) {
        serialized = JSON.stringify((err as { errors?: unknown[] }).errors ?? String(err));
      }
      expect(serialized).toContain("importsVscode.ts");
    });
  }

  // Guards the opposite error: over-applying the plugin. dist/extension.js and
  // dist/webExtension.js are written AGAINST the vscode API and must keep it
  // external, or the extension bundle stops loading in the host.
  for (const [label, suffix] of [
    ["the main extension", "dist/extension.js"],
    ["the web extension", "dist/webExtension.js"]
  ] as const) {
    it(`${label} config still declares vscode external`, () => {
      expect(configFor(suffix).external ?? []).toContain("vscode");
    });
  }
});
