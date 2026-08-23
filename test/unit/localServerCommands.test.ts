/**
 * @author kanekitakitos
 *
 * Unit tests for the Local Servers command layer.
 *
 * Focus points:
 *  1. formValuesToLocalServer — pure parser / coercer from webview form
 *     values to a valid LocalServerConfig, with strict early failure on
 *     missing name / executable / invalid folder paths.
 *  2. Edge cases around env textarea parsing (null/undefined keywords,
 *     comments, empty values), args multi-line, boolean / number coercion
 *     for checkbox and number fields coming from the form layer.
 *
 * No real VS Code APIs are exercised here; the configMutationLock pattern
 * for destructive remove is covered conceptually by the command-level
 * integration tests in profileCommands.test.ts (same FSM as SSH remove,
 * only the disclosure helper differs and is type-checked by the compiler).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

const registeredCommands = new Map<string, (...args: unknown[]) => unknown>();

vi.mock("vscode", () => ({
  EventEmitter: class<T> {
    private readonly listeners: Array<(e: T) => void> = [];
    public event = (l: (e: T) => void) => { this.listeners.push(l); return { dispose: vi.fn() }; };
    public fire(e: T): void { for (const l of this.listeners) l(e); }
  },
  Disposable: class { public constructor(private readonly fn: () => void) {} public dispose(): void { this.fn(); } },
  commands: {
    registerCommand: (id: string, h: (...a: unknown[]) => unknown) => { registeredCommands.set(id, h); return { dispose: vi.fn() }; },
    executeCommand: vi.fn()
  },
  window: {
    createTerminal: vi.fn(() => ({ show: vi.fn(), dispose: vi.fn(), name: "Nexus" })),
    showErrorMessage: vi.fn(),
    showWarningMessage: vi.fn(),
    showInformationMessage: vi.fn(),
    showQuickPick: vi.fn(),
    showInputBox: vi.fn(),
    onDidCloseTerminal: vi.fn(() => ({ dispose: vi.fn() }))
  },
  workspace: {
    getConfiguration: vi.fn(() => ({ get: (_k: string, fb: unknown) => fb }))
  },
  env: { clipboard: { writeText: vi.fn() } },
  TreeItem: class { public label?: unknown; public contextValue?: unknown; public constructor(label?: unknown) { this.label = label; } },
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
  ThemeColor: class {},
  ConfigurationTarget: { Global: 1 }
}));

vi.mock("../../src/services/configMutationLock", () => ({
  configMutationLock: { runExclusive: <T>(fn: () => Promise<T>) => fn() }
}));

vi.mock("../../src/services/local/localServerManager", () => ({
  LocalServerManager: class {},
  localServerDescription: (c: unknown) => String(c),
  localServerRemovalDisclosure: (c: unknown) => String(c)
}));

vi.mock("../../src/ui/webviewFormPanel", () => ({
  WebviewFormPanel: class { public static open() { return Promise.resolve(undefined); } }
}));

vi.mock("../../src/ui/formDefinitions", () => ({ localServerFormDefinition: () => ({ title: "", fields: [] }) }));

vi.mock("../../src/ui/nexusTreeProvider", () => ({
  LocalServerConfigTreeItem: class { public constructor(public readonly config: unknown) {} },
  LocalServerSessionTreeItem: class { public constructor(public readonly session: unknown) {} }
}));

vi.mock("../../src/utils/folderPaths", async () => {
  const actual = await import("../../src/utils/folderPaths");
  return {
    ...actual,
    normalizeOptionalFolderPath: (value: unknown) => {
      if (value === undefined || value === null || value === "") return "";
      if (typeof value !== "string") return null;
      const trimmed = value.trim();
      if (trimmed.startsWith("/not/a/relative/path")) return null;
      return actual.normalizeOptionalFolderPath(value);
    }
  };
});

vi.mock("../../src/utils/naturalCompare", () => ({ naturalCompare: (a: string, b: string) => a.localeCompare(b) }));

vi.mock("../../src/commands/serverCommands", () => ({ collectGroups: () => [] }));

import { formValuesToLocalServer } from "../../src/commands/localServerCommands";
import type { LocalServerConfig } from "../../src/models/localServer";
import type { FormValues } from "../../src/ui/formTypes";

beforeEach(() => {
  registeredCommands.clear();
});

function baseValues(): FormValues {
  return {
    name: "Backend Dev Server",
    executable: "node",
    group: ""
  };
}

describe("formValuesToLocalServer", () => {
  it("returns a complete LocalServerConfig on the happy path", () => {
    const values: FormValues = {
      ...baseValues(),
      args: "--port\n8080\n",
      cwd: "${workspaceFolder}/apps/api",
      env: "NODE_ENV=development\nPORT=8080\n# comment line\nDEBUG=",
      autoRestart: "on",
      maxAutoRestarts: "3",
      description: "Runs the local API dev server via `node dist/main.js`."
    };

    const result = formValuesToLocalServer(values);
    expect(result).toBeDefined();
    expect(result!.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(result!.name).toBe("Backend Dev Server");
    expect(result!.executable).toBe("node");
    expect(result!.args).toEqual(["--port", "8080"]);
    expect(result!.cwd).toBe("${workspaceFolder}/apps/api");
    expect(result!.description).toBe(
      "Runs the local API dev server via `node dist/main.js`."
    );
    expect(result!.autoRestart).toBe(true);
    expect(result!.maxAutoRestarts).toBe(3);
  });

  it("returns undefined when required `name` is missing", () => {
    const values: FormValues = { ...baseValues(), name: "" };
    expect(formValuesToLocalServer(values)).toBeUndefined();
  });

  it("returns undefined when required `executable` is missing", () => {
    const values: FormValues = { ...baseValues(), executable: "   \n\t" };
    expect(formValuesToLocalServer(values)).toBeUndefined();
  });

  it("returns undefined when group contains an invalid folder path", () => {
    // normalizeOptionalFolderPath returns null for leading slashes with no root
    const values: FormValues = { ...baseValues(), group: "/not/a/relative/path" };
    expect(formValuesToLocalServer(values)).toBeUndefined();
  });

  it("preserves an existing id when editing", () => {
    const existing: Partial<LocalServerConfig> = { id: randomUUID() };
    const result = formValuesToLocalServer(baseValues(), existing);
    expect(result!.id).toBe(existing.id);
  });

  it("parses env textarea keywords: null / undefined / empty string", () => {
    const values: FormValues = {
      ...baseValues(),
      env: [
        "FORCE_COLOR=1",
        "WILDCARD=null",
        "INHERIT=undefined",
        "EMPTY=",
        "# ignored=yes"
      ].join("\n")
    };
    const result = formValuesToLocalServer(values);
    expect(result!.env).toEqual({
      FORCE_COLOR: "1",
      WILDCARD: null,
      INHERIT: undefined,
      EMPTY: null
    });
  });

  it("drops blank / whitespace-only argument lines", () => {
    const values: FormValues = {
      ...baseValues(),
      args: "\n  \n--host\n   \n0.0.0.0\n\n"
    };
    const result = formValuesToLocalServer(values);
    expect(result!.args).toEqual(["--host", "0.0.0.0"]);
  });

  it("coerces autoRestart from boolean true (checkbox) and string 'true'", () => {
    const viaBool = formValuesToLocalServer({ ...baseValues(), autoRestart: true });
    const viaStr = formValuesToLocalServer({ ...baseValues(), autoRestart: "true" });
    const viaOff = formValuesToLocalServer({ ...baseValues(), autoRestart: false });
    expect(viaBool!.autoRestart).toBe(true);
    expect(viaStr!.autoRestart).toBe(true);
    expect(viaOff!.autoRestart).toBeUndefined();
  });

  it("coerces maxAutoRestarts from string and number; keeps a deliberate 0, drops garbage", () => {
    // 0 now means "no automatic restarts" rather than "unset", so it has to
    // survive the form. Unparseable text must not: mapping it to 0 would turn a
    // typo into a silent disabling of auto-restart, which is the one outcome
    // nobody asks for. A value above the ceiling is stored as typed and clamped
    // where it is used, so the profile keeps saying what its owner wrote.
    const viaStr = formValuesToLocalServer({ ...baseValues(), maxAutoRestarts: "12" });
    const viaNum = formValuesToLocalServer({ ...baseValues(), maxAutoRestarts: 7 });
    const viaZero = formValuesToLocalServer({ ...baseValues(), maxAutoRestarts: "0" });
    const viaGarbage = formValuesToLocalServer({ ...baseValues(), maxAutoRestarts: "abc" });
    const viaNegative = formValuesToLocalServer({ ...baseValues(), maxAutoRestarts: "-3" });
    expect(viaStr!.maxAutoRestarts).toBe(12);
    expect(viaNum!.maxAutoRestarts).toBe(7);
    expect(viaZero!.maxAutoRestarts).toBe(0);
    expect(viaGarbage!.maxAutoRestarts).toBeUndefined();
    expect(viaNegative!.maxAutoRestarts).toBeUndefined();
  });

  it("normalizes group folder path and preserves leading / trailing group semantics", () => {
    const values: FormValues = { ...baseValues(), group: "   Production / APIs   " };
    const result = formValuesToLocalServer(values);
    expect(result!.group).toBe("Production/APIs");
  });

  it("leaves optional fields undefined when not submitted", () => {
    const result = formValuesToLocalServer(baseValues());
    expect(result!.args).toBeUndefined();
    expect(result!.cwd).toBeUndefined();
    expect(result!.env).toBeUndefined();
    expect(result!.description).toBeUndefined();
    expect(result!.autoRestart).toBeUndefined();
    expect(result!.maxAutoRestarts).toBeUndefined();
  });
});
