import { readFileSync } from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

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
});
