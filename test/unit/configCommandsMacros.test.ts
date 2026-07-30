import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("vscode", () => ({
  workspace: {
    getConfiguration: vi.fn(() => ({
      get: vi.fn(() => undefined),
      inspect: vi.fn(() => ({})),
      update: vi.fn()
    }))
  },
  window: {
    showInformationMessage: vi.fn(),
    showErrorMessage: vi.fn(),
    showWarningMessage: vi.fn(),
    showInputBox: vi.fn(),
    showQuickPick: vi.fn(),
    showSaveDialog: vi.fn(),
    showOpenDialog: vi.fn(),
    withProgress: vi.fn()
  },
  ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
  ProgressLocation: { Notification: 15 },
  Uri: { file: vi.fn((p: string) => ({ fsPath: p })) }
}));

import { sanitizeForSharing, collectIncomingMacros, keyOf } from "../../src/commands/configCommands";
import { encrypt } from "../../src/utils/configCrypto";
import type { TerminalMacro } from "../../src/models/terminalMacro";
import { InMemoryMacroStore } from "../../src/storage/inMemoryMacroStore";
import { setActiveMacroStore } from "../../src/macroSettings";

beforeEach(async () => {
  const store = new InMemoryMacroStore();
  await store.initialize();
  setActiveMacroStore(store);
});

describe("sanitizeForSharing — macros", () => {
  it("emits only non-secret macros", () => {
    const macros: TerminalMacro[] = [
      { id: "1", name: "public", text: "hello" },
      { id: "2", name: "private", text: "classified", secret: true }
    ];
    const result = sanitizeForSharing([], [], [], [], {}, [], macros);
    expect(result.macros.map((m) => m.name)).toEqual(["public"]);
  });

  it("reassigns fresh ids to shared macros", () => {
    const macros: TerminalMacro[] = [{ id: "stable-id", name: "p", text: "t" }];
    const result = sanitizeForSharing([], [], [], [], {}, [], macros);
    expect(result.macros[0].id).not.toBe("stable-id");
  });

  it("does not include macros in the settings object", () => {
    // readSettings() never emits nexus.terminal.macros; confirm the key is absent
    const result = sanitizeForSharing([], [], [], [], {}, [], []);
    expect(result.settings["nexus.terminal.macros"]).toBeUndefined();
  });
});

describe("collectIncomingMacros (direct)", () => {
  it("v2 with resolved secret — returns macro with text filled from id-keyed blob", () => {
    const secretId = "macro-sec-1";
    const decryptedSecrets = {
      secretMacros: [{ id: secretId, text: "real-secret" }]
    };
    const payload = {
      version: 2 as const,
      exportedAt: "",
      macros: [
        { id: "m1", name: "Public", text: "echo hi" },
        { id: secretId, name: "Secret", text: "", secret: true }
      ] as TerminalMacro[]
    };

    const result = collectIncomingMacros(payload, decryptedSecrets);
    expect(result).toBeDefined();
    expect(result!.unresolvedCount).toBe(0);
    expect(result!.macros.find(m => m.name === "Public")?.text).toBe("echo hi");
    expect(result!.macros.find(m => m.name === "Secret")?.text).toBe("real-secret");
  });

  it("v2 with missing-id secret — increments unresolvedCount", () => {
    const payload = {
      version: 2 as const,
      exportedAt: "",
      macros: [
        { id: "no-blob-id", name: "Ghost", text: "", secret: true }
      ] as TerminalMacro[]
    };

    const result = collectIncomingMacros(payload, { secretMacros: [] });
    expect(result).toBeDefined();
    expect(result!.unresolvedCount).toBe(1);
    expect(result!.macros[0].text).toBe("");
  });

  it("v1 with name-matched secret blob — resolves text", () => {
    const decryptedSecrets = {
      secretMacros: [{ name: "Legacy", text: "old-secret" }]
    };
    const payload = {
      version: 1 as const,
      exportedAt: "",
      servers: [] as import("../../src/models/config").ServerConfig[],
      settings: {
        "nexus.terminal.macros": [
          { name: "Public", text: "echo hello" },
          { name: "Legacy", text: "", secret: true }
        ]
      }
    };

    const result = collectIncomingMacros(payload as Parameters<typeof collectIncomingMacros>[0], decryptedSecrets);
    expect(result).toBeDefined();
    expect(result!.unresolvedCount).toBe(0);
    expect(result!.macros.find(m => m.name === "Legacy")?.text).toBe("old-secret");
    expect(result!.macros.find(m => m.name === "Public")?.text).toBe("echo hello");
  });

  it("v1 with pre-strip cleartext — not counted as unresolved", () => {
    // Pre-2.7.0 backups may carry cleartext in m.text even for secret macros.
    // The best-effort resolution falls back to m.text, so unresolvedCount stays 0.
    const payload = {
      version: 1 as const,
      exportedAt: "",
      servers: [] as import("../../src/models/config").ServerConfig[],
      settings: {
        "nexus.terminal.macros": [
          { name: "OldSecret", text: "cleartext-was-here", secret: true }
        ]
      }
    };

    const result = collectIncomingMacros(payload as Parameters<typeof collectIncomingMacros>[0], { secretMacros: [] });
    expect(result).toBeDefined();
    expect(result!.unresolvedCount).toBe(0);
    expect(result!.macros[0].text).toBe("cleartext-was-here");
  });

  it("sanitizes unsafe imported macro trigger metadata", () => {
    const payload = {
      version: 2 as const,
      exportedAt: "",
      macros: [
        {
          name: "BadScope",
          text: "secret\n",
          triggerPattern: "Prompt:",
          triggerScope: "typo"
        },
        {
          name: "BadRegex",
          text: "secret\n",
          triggerPattern: "^(a{1,})+$",
          triggerScope: "all-terminals"
        }
      ] as TerminalMacro[]
    };

    const result = collectIncomingMacros(payload);

    expect(result?.macros[0].triggerPattern).toBeUndefined();
    expect(result?.macros[0].triggerScope).toBeUndefined();
    expect(result?.macros[1].triggerPattern).toBeUndefined();
  });
});

describe("collectIncomingMacros — variable sanitization (§10)", () => {
  function importOne(macro: Record<string, unknown>): TerminalMacro {
    const payload = {
      version: 2 as const,
      exportedAt: "",
      macros: [macro] as TerminalMacro[]
    };
    return collectIncomingMacros(payload)!.macros[0];
  }

  it("drops a non-array variables shape", () => {
    const result = importOne({ name: "m", text: "t", variables: "abc" });
    expect(result.variables).toBeUndefined();
  });

  it("drops an object-shaped (non-array) variables value too", () => {
    const result = importOne({ name: "m", text: "t", variables: { length: 5 } });
    expect(result.variables).toBeUndefined();
  });

  it("drops entries with an invalid name, keeping the valid ones", () => {
    const result = importOne({
      name: "m",
      text: "t",
      variables: [{ name: "host" }, { name: "2bad" }, { name: "user name" }, "garbage", null]
    });
    expect(result.variables?.map((v) => v.name)).toEqual(["host"]);
  });

  it("drops duplicate names, keeping the first occurrence", () => {
    const result = importOne({
      name: "m",
      text: "t",
      variables: [
        { name: "host", label: "first" },
        { name: "host", label: "second" }
      ]
    });
    expect(result.variables).toHaveLength(1);
    expect(result.variables?.[0].label).toBe("first");
  });

  it("caps at 10 variables", () => {
    const variables = Array.from({ length: 15 }, (_, i) => ({ name: `v${i}` }));
    const result = importOne({ name: "m", text: "t", variables });
    expect(result.variables).toHaveLength(10);
  });

  it("strips default and remember from a secret variable", () => {
    const result = importOne({
      name: "m",
      text: "t",
      variables: [{ name: "password", secret: true, default: "hunter2", remember: false }]
    });
    expect(result.variables?.[0]).toEqual({ name: "password", secret: true });
  });

  it("keeps default/remember on a non-secret variable", () => {
    const result = importOne({
      name: "m",
      text: "t",
      variables: [{ name: "host", default: "10.0.0.1", remember: false }]
    });
    expect(result.variables?.[0]).toEqual({ name: "host", default: "10.0.0.1", remember: false });
  });

  it("strips trigger fields when both variables and a triggerPattern survive sanitization (§6.2)", () => {
    const result = importOne({
      name: "m",
      text: "t",
      variables: [{ name: "host" }],
      triggerPattern: "router#",
      triggerScope: "all-terminals"
    });
    expect(result.variables?.map((v) => v.name)).toEqual(["host"]);
    expect(result.triggerPattern).toBeUndefined();
    expect(result.triggerScope).toBeUndefined();
  });

  it("a macro with no trigger at all still gets its variables sanitized (the common case)", () => {
    const result = importOne({ name: "m", text: "t", variables: [{ name: "2bad" }, { name: "host" }] });
    expect(result.variables?.map((v) => v.name)).toEqual(["host"]);
  });

  it("a macro with a valid trigger and no variables is unaffected by the new variables logic", () => {
    const result = importOne({ name: "m", text: "t", triggerPattern: "router#" });
    expect(result.variables).toBeUndefined();
    expect(result.triggerPattern).toBe("router#");
  });

  // Fix A — sanitizeImportedMacroVariables() must return whether the macro carried
  // ANY declaration BEFORE sanitization, and sanitizeImportedMacro()'s §6.2 trigger
  // strip must key off that, not off the surviving array. Before this fix, an
  // all-invalid declaration was deleted by sanitization and the (now variables-less)
  // macro's trigger survived import — for
  // `{secret: true, text: "hunter2\n", triggerPattern: "[Pp]assword:",
  // variables: [{name: "2bad"}]}` that means the secret text starts auto-sending on
  // any output matching `Password:`.
  it("Fix A — strips the trigger even when every declared variable entry is invalid, though nothing survives to suppress it", () => {
    const result = importOne({
      name: "Password",
      text: "hunter2\n",
      secret: true,
      triggerPattern: "[Pp]assword:",
      variables: [{ name: "2bad" }]
    });
    expect(result.variables).toBeUndefined();
    expect(result.triggerPattern).toBeUndefined();
  });

  it("Fix A — strips the trigger when variables is a malformed non-array string (fail-safe: a non-array can never suppress at runtime)", () => {
    const result = importOne({
      name: "Password",
      text: "hunter2\n",
      secret: true,
      triggerPattern: "[Pp]assword:",
      variables: "abc"
    });
    expect(result.variables).toBeUndefined();
    expect(result.triggerPattern).toBeUndefined();
  });

  it("Fix A — strips the trigger when variables is an array-like (non-array) object", () => {
    const result = importOne({
      name: "Password",
      text: "hunter2\n",
      secret: true,
      triggerPattern: "[Pp]assword:",
      variables: { 0: { name: "password", secret: true, default: "hunter2" }, length: 1 }
    });
    expect(result.variables).toBeUndefined();
    expect(result.triggerPattern).toBeUndefined();
  });
});

describe("collectIncomingMacros — `group` is untrusted at every ingest site (§4.2)", () => {
  function importOne(macro: Record<string, unknown>): TerminalMacro {
    const payload = {
      version: 2 as const,
      exportedAt: "",
      macros: [macro] as TerminalMacro[]
    };
    return collectIncomingMacros(payload)!.macros[0];
  }

  it("keeps a valid group", () => {
    expect(importOne({ name: "m", text: "t", group: "Cisco/Routers" }).group).toBe("Cisco/Routers");
  });

  it("canonicalizes an empty-string group to undefined", () => {
    expect(importOne({ name: "m", text: "t", group: "" }).group).toBeUndefined();
  });

  it("drops a non-string group without throwing (a malformed import must not break the whole import)", () => {
    expect(() => importOne({ name: "m", text: "t", group: { nope: true } })).not.toThrow();
    expect(importOne({ name: "m", text: "t", group: { nope: true } }).group).toBeUndefined();
  });

  it("rejects a '..' path-traversal group", () => {
    expect(importOne({ name: "m", text: "t", group: "../secrets" }).group).toBeUndefined();
  });

  it("rejects an over-depth group", () => {
    const huge = Array.from({ length: 200 }, () => "a").join("/");
    expect(importOne({ name: "m", text: "t", group: huge }).group).toBeUndefined();
  });
});

describe("§7 — keyOf() deliberately excludes `group` (assert the decision)", () => {
  it("two macros identical except for `group` hash to the SAME dedup key", () => {
    const inFolder: TerminalMacro = { name: "reload", text: "reload\n", group: "Cisco" };
    const atRoot: TerminalMacro = { name: "reload", text: "reload\n" };
    expect(keyOf(inFolder)).toBe(keyOf(atRoot));
  });

  it("two macros in DIFFERENT folders still hash to the same key as each other", () => {
    const inCisco: TerminalMacro = { name: "reload", text: "reload\n", group: "Cisco" };
    const inJuniper: TerminalMacro = { name: "reload", text: "reload\n", group: "Juniper" };
    expect(keyOf(inCisco)).toBe(keyOf(inJuniper));
  });
});
