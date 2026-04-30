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

import { sanitizeForSharing, collectIncomingMacros } from "../../src/commands/configCommands";
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
    const result = sanitizeForSharing([], [], [], {}, [], macros);
    expect(result.macros.map((m) => m.name)).toEqual(["public"]);
  });

  it("reassigns fresh ids to shared macros", () => {
    const macros: TerminalMacro[] = [{ id: "stable-id", name: "p", text: "t" }];
    const result = sanitizeForSharing([], [], [], {}, [], macros);
    expect(result.macros[0].id).not.toBe("stable-id");
  });

  it("does not include macros in the settings object", () => {
    // readSettings() never emits nexus.terminal.macros; confirm the key is absent
    const result = sanitizeForSharing([], [], [], {}, [], []);
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
