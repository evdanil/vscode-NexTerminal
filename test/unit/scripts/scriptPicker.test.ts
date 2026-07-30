import { describe, expect, it, vi, beforeEach } from "vitest";

const mockFsEntries = new Map<string, Array<[string, number]>>();
const mockFiles = new Map<string, string>();
let quickPickItems: unknown[] | undefined;
let quickPickReturn: unknown = undefined;
const shownInfo: string[] = [];

vi.mock("vscode", () => ({
  FileType: { File: 1, Directory: 2 },
  Uri: {
    file: (p: string) => ({ fsPath: p, scheme: "file", path: p, toString: () => p }),
    joinPath: (base: { fsPath: string }, ...parts: string[]) => ({
      fsPath: [base.fsPath, ...parts].join("/"),
      scheme: "file",
      path: [base.fsPath, ...parts].join("/"),
      toString: () => [base.fsPath, ...parts].join("/")
    })
  },
  workspace: {
    workspaceFolders: [{ uri: { fsPath: "/ws", scheme: "file", path: "/ws" }, name: "ws", index: 0 }],
    getConfiguration: vi.fn(() => ({ get: vi.fn((_k: string, d?: unknown) => d) })),
    fs: {
      readDirectory: vi.fn(async (uri: { fsPath: string }) => mockFsEntries.get(uri.fsPath) ?? []),
      readFile: vi.fn(async (uri: { fsPath: string }) => {
        const content = mockFiles.get(uri.fsPath);
        if (content === undefined) throw new Error(`ENOENT: ${uri.fsPath}`);
        return new TextEncoder().encode(content);
      })
    }
  },
  window: {
    showQuickPick: vi.fn((items: unknown[]) => {
      quickPickItems = items;
      return Promise.resolve(quickPickReturn);
    }),
    showInformationMessage: vi.fn((msg: string) => {
      shownInfo.push(msg);
      return Promise.resolve(undefined);
    })
  }
}));

import * as vscode from "vscode";
import { pickScriptFromWorkspace } from "../../../src/services/scripts/scriptPicker";

const GLOBAL_STORAGE = "/gs";

describe("scriptPicker / pickScriptFromWorkspace", () => {
  beforeEach(() => {
    mockFsEntries.clear();
    mockFiles.clear();
    quickPickItems = undefined;
    quickPickReturn = undefined;
    shownInfo.length = 0;
    (vscode.workspace as unknown as { workspaceFolders: unknown[] }).workspaceFolders = [
      { uri: { fsPath: "/ws", scheme: "file", path: "/ws" }, name: "ws", index: 0 }
    ];
    // Restore the default readDirectory in case a prior test replaced it with an
    // ENOENT-throwing variant.
    (vscode.workspace.fs as unknown as { readDirectory: (u: { fsPath: string }) => Promise<Array<[string, number]>> }).readDirectory = vi.fn(
      async (uri: { fsPath: string }) => mockFsEntries.get(uri.fsPath) ?? []
    );
  });

  it("falls back to global-storage scripts directory when no workspace is open", async () => {
    (vscode.workspace as unknown as { workspaceFolders: unknown[] | undefined }).workspaceFolders = undefined;
    mockFsEntries.set("/gs/scripts", [["any.js", 1]]);
    mockFiles.set("/gs/scripts/any.js", "/**\n * @nexus-script\n * @name Any\n */\n");
    await pickScriptFromWorkspace(GLOBAL_STORAGE);
    const labels = (quickPickItems as Array<{ label: string }>)?.map((i) => i.label) ?? [];
    expect(labels).toEqual(["Any"]);
    // No "open a folder" prompt — the no-workspace case is a supported flow now.
    expect(shownInfo.some((m) => /open a folder/i.test(m))).toBe(false);
  });

  it("returns undefined and informs when the scripts directory does not exist", async () => {
    // Throw ENOENT from readDirectory — simulating a missing directory.
    (vscode.workspace.fs as unknown as { readDirectory: (u: unknown) => Promise<unknown> }).readDirectory = vi.fn(
      async () => {
        throw new Error("ENOENT");
      }
    );
    const result = await pickScriptFromWorkspace(GLOBAL_STORAGE);
    expect(result).toBeUndefined();
    expect(shownInfo.some((m) => /no nexus scripts folder/i.test(m))).toBe(true);
  });

  it("filters out files without the @nexus-script marker", async () => {
    mockFsEntries.set("/ws/.nexus/scripts", [["good.js", 1], ["bad.js", 1]]);
    mockFiles.set("/ws/.nexus/scripts/good.js", "/**\n * @nexus-script\n * @name Good\n */\n");
    mockFiles.set("/ws/.nexus/scripts/bad.js", "console.log('not a nexus script');\n");
    await pickScriptFromWorkspace(GLOBAL_STORAGE);
    const labels = (quickPickItems as Array<{ label: string }>)?.map((i) => i.label) ?? [];
    expect(labels).toEqual(["Good"]);
  });

  it("hides scripts whose @target-type disagrees with the caller", async () => {
    mockFsEntries.set("/ws/.nexus/scripts", [
      ["ssh-only.js", 1],
      ["serial-only.js", 1],
      ["local-only.js", 1],
      ["unrestricted.js", 1]
    ]);
    mockFiles.set("/ws/.nexus/scripts/ssh-only.js", "/**\n * @nexus-script\n * @name SshOnly\n * @target-type ssh\n */\n");
    mockFiles.set(
      "/ws/.nexus/scripts/serial-only.js",
      "/**\n * @nexus-script\n * @name SerialOnly\n * @target-type serial\n */\n"
    );
    mockFiles.set(
      "/ws/.nexus/scripts/local-only.js",
      "/**\n * @nexus-script\n * @name LocalOnly\n * @target-type local\n */\n"
    );
    mockFiles.set("/ws/.nexus/scripts/unrestricted.js", "/**\n * @nexus-script\n * @name Any\n */\n");

    await pickScriptFromWorkspace(GLOBAL_STORAGE, "local");
    const labels = (quickPickItems as Array<{ label: string }>)?.map((i) => i.label) ?? [];
    expect(labels.sort()).toEqual(["Any", "LocalOnly"]);
  });

  it("shows an unrestricted script in SSH, serial, and Local Shell contexts", async () => {
    mockFsEntries.set("/ws/.nexus/scripts", [["a.js", 1]]);
    mockFiles.set("/ws/.nexus/scripts/a.js", "/**\n * @nexus-script\n * @name Any\n */\n");

    await pickScriptFromWorkspace(GLOBAL_STORAGE, "ssh");
    const sshLabels = (quickPickItems as Array<{ label: string }>)?.map((i) => i.label) ?? [];
    expect(sshLabels).toEqual(["Any"]);

    quickPickItems = undefined;
    await pickScriptFromWorkspace(GLOBAL_STORAGE, "serial");
    const serialLabels = (quickPickItems as Array<{ label: string }>)?.map((i) => i.label) ?? [];
    expect(serialLabels).toEqual(["Any"]);

    quickPickItems = undefined;
    await pickScriptFromWorkspace(GLOBAL_STORAGE, "local");
    const localLabels = (quickPickItems as Array<{ label: string }>)?.map((i) => i.label) ?? [];
    expect(localLabels).toEqual(["Any"]);
  });

  it("surfaces a helpful message when no compatible scripts exist", async () => {
    mockFsEntries.set("/ws/.nexus/scripts", [["ssh-only.js", 1]]);
    mockFiles.set("/ws/.nexus/scripts/ssh-only.js", "/**\n * @nexus-script\n * @target-type ssh\n */\n");
    const result = await pickScriptFromWorkspace(GLOBAL_STORAGE, "serial");
    expect(result).toBeUndefined();
    expect(shownInfo.some((m) => /no nexus scripts compatible with serial/i.test(m))).toBe(true);
  });

  it("returns the chosen script URI on confirmation", async () => {
    mockFsEntries.set("/ws/.nexus/scripts", [["ok.js", 1]]);
    mockFiles.set("/ws/.nexus/scripts/ok.js", "/**\n * @nexus-script\n * @name Ok\n */\n");
    quickPickReturn = { label: "Ok", uri: { fsPath: "/ws/.nexus/scripts/ok.js", scheme: "file", path: "/ws/.nexus/scripts/ok.js", toString: () => "" } };
    const result = await pickScriptFromWorkspace(GLOBAL_STORAGE);
    expect(result?.fsPath).toBe("/ws/.nexus/scripts/ok.js");
  });

  it("returns undefined when the user dismisses the QuickPick", async () => {
    mockFsEntries.set("/ws/.nexus/scripts", [["ok.js", 1]]);
    mockFiles.set("/ws/.nexus/scripts/ok.js", "/**\n * @nexus-script\n */\n");
    quickPickReturn = undefined;
    const result = await pickScriptFromWorkspace(GLOBAL_STORAGE);
    expect(result).toBeUndefined();
  });

  // ---- §5.8 — the picker that actually regresses: nested scripts must not
  // silently vanish once moved into a subdirectory. -----------------------

  it("finds a script nested in a subdirectory and shows the folder-relative path as description", async () => {
    mockFsEntries.set("/ws/.nexus/scripts", [["cisco", 2]]);
    mockFsEntries.set("/ws/.nexus/scripts/cisco", [["reload.js", 1]]);
    mockFiles.set("/ws/.nexus/scripts/cisco/reload.js", "/**\n * @nexus-script\n * @name Reload\n */\n");

    const result = await pickScriptFromWorkspace(GLOBAL_STORAGE);
    const items = (quickPickItems as Array<{ label: string; description?: string; uri: { fsPath: string } }>) ?? [];
    expect(items.map((i) => i.label)).toEqual(["Reload"]);
    expect(items[0].description).toBe("cisco");
    expect(result).toBeUndefined(); // no quickPickReturn set for this test — dismissed
  });

  it("finds a script nested several levels deep", async () => {
    mockFsEntries.set("/ws/.nexus/scripts", [["cisco", 2]]);
    mockFsEntries.set("/ws/.nexus/scripts/cisco", [["routers", 2]]);
    mockFsEntries.set("/ws/.nexus/scripts/cisco/routers", [["backup.js", 1]]);
    mockFiles.set(
      "/ws/.nexus/scripts/cisco/routers/backup.js",
      "/**\n * @nexus-script\n * @name Backup\n */\n"
    );

    await pickScriptFromWorkspace(GLOBAL_STORAGE);
    const items = (quickPickItems as Array<{ label: string; description?: string }>) ?? [];
    expect(items.map((i) => i.label)).toEqual(["Backup"]);
    expect(items[0].description).toBe("cisco/routers");
  });

  it("disambiguates two same-named scripts living in different folders by their folder-relative description", async () => {
    mockFsEntries.set("/ws/.nexus/scripts", [["cisco", 2], ["juniper", 2]]);
    mockFsEntries.set("/ws/.nexus/scripts/cisco", [["reload.js", 1]]);
    mockFsEntries.set("/ws/.nexus/scripts/juniper", [["reload.js", 1]]);
    mockFiles.set("/ws/.nexus/scripts/cisco/reload.js", "/**\n * @nexus-script\n * @name Reload\n */\n");
    mockFiles.set("/ws/.nexus/scripts/juniper/reload.js", "/**\n * @nexus-script\n * @name Reload\n */\n");

    await pickScriptFromWorkspace(GLOBAL_STORAGE);
    const items = (quickPickItems as Array<{ label: string; description?: string; uri: { fsPath: string } }>) ?? [];
    expect(items).toHaveLength(2);
    expect(items.map((i) => i.label)).toEqual(["Reload", "Reload"]);
    expect(items.map((i) => i.description).sort()).toEqual(["cisco", "juniper"]);
    expect(items.map((i) => i.uri.fsPath).sort()).toEqual([
      "/ws/.nexus/scripts/cisco/reload.js",
      "/ws/.nexus/scripts/juniper/reload.js"
    ]);
  });

  it("works with no dependency on the Scripts tree view ever having been constructed", async () => {
    // Deliberately never import/construct ScriptTreeProvider in this test
    // file — pickScriptFromWorkspace must not rely on any cache the tree
    // view would otherwise populate (§5.8 — the scan is a shared FUNCTION,
    // not a shared cache, precisely so this works on a cold start).
    mockFsEntries.set("/ws/.nexus/scripts", [["cisco", 2]]);
    mockFsEntries.set("/ws/.nexus/scripts/cisco", [["deep.js", 1]]);
    mockFiles.set("/ws/.nexus/scripts/cisco/deep.js", "/**\n * @nexus-script\n * @name Deep\n */\n");

    await pickScriptFromWorkspace(GLOBAL_STORAGE);
    const labels = ((quickPickItems as Array<{ label: string }>) ?? []).map((i) => i.label);
    expect(labels).toEqual(["Deep"]);
  });

  it("root-level scripts show an empty description (nothing to disambiguate)", async () => {
    mockFsEntries.set("/ws/.nexus/scripts", [["top.js", 1]]);
    mockFiles.set("/ws/.nexus/scripts/top.js", "/**\n * @nexus-script\n * @name Top\n */\n");

    await pickScriptFromWorkspace(GLOBAL_STORAGE);
    const items = (quickPickItems as Array<{ label: string; description?: string }>) ?? [];
    expect(items).toEqual([expect.objectContaining({ label: "Top", description: "" })]);
  });
});
