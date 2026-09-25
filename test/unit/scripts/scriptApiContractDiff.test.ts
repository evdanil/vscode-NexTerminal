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

  it("no @example in the shipped types ends a script with a top-level `return` (#155)", () => {
    // ⊘ `if (!m) { log.warn(...); return; }` in waitFor's example: it runs,
    // but under the seeded jsconfig.json (checkJs) a script copying it gets
    // TS1108, "A 'return' statement can only be used within a function body".
    const bundled = readFileSync(
      path.join(REPO_ROOT, "src", "services", "scripts", "assets", "nexus-scripts.d.ts"),
      "utf8"
    );
    const examples = [...bundled.matchAll(/@example\r?\n([\s\S]*?)\*\//g)].map((m) => m[1]);
    expect(examples.length).toBeGreaterThan(0);
    for (const example of examples) {
      expect(example).not.toMatch(/\breturn\b/);
    }
  });

  it("the shipped types say Connect and Run Script… keeps the session's output on a serial profile too (#207)", () => {
    // ⊘ the v11 wording, "starts on a server", left in `Match.before` or
    // `lookback` (or updated in only one of them): a serial script's author
    // would read that a device's first output is never in the buffer, and
    // press Enter for a prompt the run already holds.
    const bundled = readFileSync(
      path.join(REPO_ROOT, "src", "services", "scripts", "assets", "nexus-scripts.d.ts"),
      "utf8"
    );
    const prose = bundled.replace(/\r?\n\s*\*\s?/g, " ");
    const scopes = [...prose.matchAll(/Connect and Run Script… starts on a (.+?), (?:since|from)/g)].map((m) => m[1]);
    expect(scopes).toEqual(["server or a serial profile", "server or a serial profile"]);
    expect(prose).not.toMatch(/Connect and Run Script… starts on a server, /);
  });
});
