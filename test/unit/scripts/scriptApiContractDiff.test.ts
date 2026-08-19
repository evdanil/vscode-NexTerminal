import { readFileSync } from "node:fs";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";

// scriptTypesGenerator imports `vscode` at module scope; only the header
// constant is needed here, so an empty stub is enough.
vi.mock("vscode", () => ({}));
import { BUNDLED_DTS_VERSION_HEADER } from "../../../src/services/scripts/scriptTypesGenerator";

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const MAIN_REPO_ROOT = path.resolve(REPO_ROOT, "..", "..");

const CONTRACT_PATHS = [
  path.join(REPO_ROOT, "specs", "001-scripting-support", "contracts", "script-api.d.ts"),
  path.join(MAIN_REPO_ROOT, "specs", "001-scripting-support", "contracts", "script-api.d.ts")
];

function loadContract(): string | undefined {
  for (const candidate of CONTRACT_PATHS) {
    try {
      return readFileSync(candidate, "utf8");
    } catch {
      continue;
    }
  }
  return undefined;
}

describe("script-api.d.ts contract sync", () => {
  it("bundled asset stays byte-identical to specs contracts/script-api.d.ts", () => {
    const contract = loadContract();
    if (contract === undefined) {
      // specs/ may be excluded via .gitignore in downstream forks — skip gracefully.
      console.warn("skipping contract diff: specs/001-scripting-support/contracts/script-api.d.ts not reachable");
      return;
    }
    const bundled = readFileSync(
      path.join(REPO_ROOT, "src", "services", "scripts", "assets", "nexus-scripts.d.ts"),
      "utf8"
    );
    expect(bundled).toBe(contract);
  });

  it("bundled asset's first line matches BUNDLED_DTS_VERSION_HEADER", () => {
    // ⊘ bumping the d.ts copies without bumping the generator constant (or vice
    // versa). Skew in the copies-ahead direction is the nasty one: after one
    // reseed the workspace file's first line is the NEW header while
    // `writeIfChanged` still compares against the OLD constant, so every script
    // command rewrites the user's d.ts forever. The copy-vs-copy test above
    // cannot see this — both copies move together.
    const bundled = readFileSync(
      path.join(REPO_ROOT, "src", "services", "scripts", "assets", "nexus-scripts.d.ts"),
      "utf8"
    );
    expect(bundled.split(/\r?\n/, 1)[0]).toBe(BUNDLED_DTS_VERSION_HEADER);
  });
});
