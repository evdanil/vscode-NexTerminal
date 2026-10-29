import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("pool invalidation has a single source", () => {
  const extension = readFileSync(join(__dirname, "../../src/extension.ts"), "utf8");
  const runtime = readFileSync(join(__dirname, "../../src/services/ssh/sshCredentialRuntime.ts"), "utf8");

  it("activation delegates once and does not install a competing watcher or general-event invalidator", () => {
    expect(extension).not.toContain("pool.invalidate(");
    expect(extension).not.toContain("watchSshPoolServerRemovals");
    expect(extension).not.toContain("watchPoolInvalidationOnConfigMutation");
    expect(extension.match(/\bcreateSshCredentialRuntime\s*\(/g)).toHaveLength(1);
  });

  it("native composition installs exactly one mutation watcher without another invalidation source", () => {
    // The behavior tests in sshCredentialRuntime.test.ts also assert one pool
    // invalidation after an actual profile edit. Keep the activation-side guard:
    // a second watcher there would be outside those focused runtime tests.
    expect(runtime.match(/\bwatchPoolInvalidationOnConfigMutation\s*\(/g)).toHaveLength(1);
    expect(runtime).not.toContain("pool.invalidate(");
    expect(runtime).not.toContain("watchSshPoolServerRemovals");
    expect(/\bcore\.onDidChange\s*\(/.test(runtime)).toBe(false);
  });
});
