import { describe, expect, it } from "vitest";
import { parseScriptHeader } from "../../../src/services/scripts/scriptHeader";

const base = (body: string) =>
  `/**\n${body
    .split("\n")
    .map((l) => ` ${l.trimStart() === "" ? "*" : "* " + l}`)
    .join("\n")}\n */\n\nawait expect("x");\n`;

describe("scriptHeader / parseScriptHeader", () => {
  it("returns marker=false for files without @nexus-script", () => {
    const h = parseScriptHeader(base("@name My Script"));
    expect(h.marker).toBe(false);
  });

  it("parses every supported field", () => {
    const src = base(
      [
        "@nexus-script",
        "@name Router IOS Downgrade",
        "@description Downgrade an IR1800 via USB",
        "@target-type serial",
        "@target-profile lab-router-a",
        "@default-timeout 30s",
        "@lock-input",
        "@allow-macros password, hostname-prompt"
      ].join("\n")
    );
    const h = parseScriptHeader(src);
    expect(h.marker).toBe(true);
    expect(h.name).toBe("Router IOS Downgrade");
    expect(h.description).toBe("Downgrade an IR1800 via USB");
    expect(h.targetType).toBe("serial");
    expect(h.targetProfile).toBe("lab-router-a");
    expect(h.defaultTimeoutMs).toBe(30_000);
    expect(h.lockInput).toBe(true);
    expect(h.allowMacros).toEqual(["password", "hostname-prompt"]);
    expect(h.parseErrors).toEqual([]);
  });

  it("defaults missing fields", () => {
    const h = parseScriptHeader(base("@nexus-script"));
    expect(h.marker).toBe(true);
    expect(h.name).toBeUndefined();
    expect(h.targetType).toBeUndefined();
    expect(h.lockInput).toBe(false);
    expect(h.allowMacros).toEqual([]);
    expect(h.defaultTimeoutMs).toBeUndefined();
  });

  it("accepts ms / s / m duration units case-insensitively", () => {
    expect(parseScriptHeader(base("@nexus-script\n@default-timeout 500ms")).defaultTimeoutMs).toBe(500);
    expect(parseScriptHeader(base("@nexus-script\n@default-timeout 5s")).defaultTimeoutMs).toBe(5_000);
    expect(parseScriptHeader(base("@nexus-script\n@default-timeout 2M")).defaultTimeoutMs).toBe(120_000);
  });

  it("records a parse error on malformed @default-timeout", () => {
    const h = parseScriptHeader(base("@nexus-script\n@default-timeout soon"));
    expect(h.parseErrors.join("\n")).toMatch(/default-timeout/i);
    expect(h.defaultTimeoutMs).toBeUndefined();
  });

  it("records a parse error on unknown @target-type value", () => {
    const h = parseScriptHeader(base("@nexus-script\n@target-type telnet"));
    expect(h.parseErrors.join("\n")).toMatch(/target-type/i);
  });

  it("accepts case-insensitive @target-type values", () => {
    expect(parseScriptHeader(base("@nexus-script\n@target-type SSH")).targetType).toBe("ssh");
    expect(parseScriptHeader(base("@nexus-script\n@target-type Serial")).targetType).toBe("serial");
  });

  it("trims whitespace in comma-separated @allow-macros", () => {
    const h = parseScriptHeader(base("@nexus-script\n@allow-macros  password ,  hostname-prompt ,, "));
    expect(h.allowMacros).toEqual(["password", "hostname-prompt"]);
  });

  it("ignores JSDoc blocks that come after the first executable statement", () => {
    const src = `const x = 1;\n/**\n * @nexus-script\n */\n`;
    const h = parseScriptHeader(src);
    expect(h.marker).toBe(false);
  });

  it("tolerates a shebang and leading blank lines", () => {
    const src = `#!/usr/bin/env node\n\n/**\n * @nexus-script\n * @name Hello\n */\n`;
    const h = parseScriptHeader(src);
    expect(h.marker).toBe(true);
    expect(h.name).toBe("Hello");
  });

  it("warns (not errors) on unknown @tag", () => {
    const h = parseScriptHeader(base("@nexus-script\n@name X\n@made-up-field yes"));
    expect(h.parseErrors).toEqual([]);
    expect(h.warnings.join("\n")).toMatch(/made-up-field/);
  });

  it("uses the first occurrence and warns on duplicate fields", () => {
    const h = parseScriptHeader(base("@nexus-script\n@name First\n@name Second"));
    expect(h.name).toBe("First");
    expect(h.warnings.join("\n")).toMatch(/duplicate/i);
  });

  it("concatenates and dedupes values across multiple @allow-macros lines", () => {
    const h = parseScriptHeader(
      base(
        [
          "@nexus-script",
          "@allow-macros password",
          "@allow-macros hostname-prompt, password",
          "@allow-macros keep-alive"
        ].join("\n")
      )
    );
    expect(h.allowMacros).toEqual(["password", "hostname-prompt", "keep-alive"]);
    // Dedup should not produce a "duplicate" warning for @allow-macros.
    expect(h.warnings.join("\n")).not.toMatch(/allow-macros/);
  });
});
