import { describe, expect, it, vi, beforeEach } from "vitest";

const mockFsEntries = new Map<string, Array<[string, number]>>();
const mockFiles = new Map<string, string>();
let quickPickItems: unknown[] | undefined;
let quickPickReturn: unknown = undefined;
const shownInfo: string[] = [];

vi.mock("vscode", () => ({
  FileType: { File: 1, Directory: 2 },
  Uri: {
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

  it("returns undefined and informs the user when no workspace is open", async () => {
    (vscode.workspace as unknown as { workspaceFolders: unknown[] | undefined }).workspaceFolders = undefined;
    const result = await pickScriptFromWorkspace();
    expect(result).toBeUndefined();
    expect(shownInfo.some((m) => /open a folder/i.test(m))).toBe(true);
  });

  it("returns undefined and informs when the scripts directory does not exist", async () => {
    // Throw ENOENT from readDirectory — simulating a missing directory.
    (vscode.workspace.fs as unknown as { readDirectory: (u: unknown) => Promise<unknown> }).readDirectory = vi.fn(
      async () => {
        throw new Error("ENOENT");
      }
    );
    const result = await pickScriptFromWorkspace();
    expect(result).toBeUndefined();
    expect(shownInfo.some((m) => /no nexus scripts folder/i.test(m))).toBe(true);
  });

  it("filters out files without the @nexus-script marker", async () => {
    mockFsEntries.set("/ws/.nexus/scripts", [["good.js", 1], ["bad.js", 1]]);
    mockFiles.set("/ws/.nexus/scripts/good.js", "/**\n * @nexus-script\n * @name Good\n */\n");
    mockFiles.set("/ws/.nexus/scripts/bad.js", "console.log('not a nexus script');\n");
    await pickScriptFromWorkspace();
    const labels = (quickPickItems as Array<{ label: string }>)?.map((i) => i.label) ?? [];
    expect(labels).toEqual(["Good"]);
  });

  it("hides scripts whose @target-type disagrees with the caller", async () => {
    mockFsEntries.set("/ws/.nexus/scripts", [
      ["ssh-only.js", 1],
      ["serial-only.js", 1],
      ["unrestricted.js", 1]
    ]);
    mockFiles.set("/ws/.nexus/scripts/ssh-only.js", "/**\n * @nexus-script\n * @name SshOnly\n * @target-type ssh\n */\n");
    mockFiles.set(
      "/ws/.nexus/scripts/serial-only.js",
      "/**\n * @nexus-script\n * @name SerialOnly\n * @target-type serial\n */\n"
    );
    mockFiles.set("/ws/.nexus/scripts/unrestricted.js", "/**\n * @nexus-script\n * @name Any\n */\n");

    await pickScriptFromWorkspace("serial");
    const labels = (quickPickItems as Array<{ label: string }>)?.map((i) => i.label) ?? [];
    expect(labels.sort()).toEqual(["Any", "SerialOnly"]);
  });

  it("shows an unrestricted script in both SSH and serial contexts", async () => {
    mockFsEntries.set("/ws/.nexus/scripts", [["a.js", 1]]);
    mockFiles.set("/ws/.nexus/scripts/a.js", "/**\n * @nexus-script\n * @name Any\n */\n");

    await pickScriptFromWorkspace("ssh");
    const sshLabels = (quickPickItems as Array<{ label: string }>)?.map((i) => i.label) ?? [];
    expect(sshLabels).toEqual(["Any"]);

    quickPickItems = undefined;
    await pickScriptFromWorkspace("serial");
    const serialLabels = (quickPickItems as Array<{ label: string }>)?.map((i) => i.label) ?? [];
    expect(serialLabels).toEqual(["Any"]);
  });

  it("surfaces a helpful message when no compatible scripts exist", async () => {
    mockFsEntries.set("/ws/.nexus/scripts", [["ssh-only.js", 1]]);
    mockFiles.set("/ws/.nexus/scripts/ssh-only.js", "/**\n * @nexus-script\n * @target-type ssh\n */\n");
    const result = await pickScriptFromWorkspace("serial");
    expect(result).toBeUndefined();
    expect(shownInfo.some((m) => /no nexus scripts compatible with serial/i.test(m))).toBe(true);
  });

  it("returns the chosen script URI on confirmation", async () => {
    mockFsEntries.set("/ws/.nexus/scripts", [["ok.js", 1]]);
    mockFiles.set("/ws/.nexus/scripts/ok.js", "/**\n * @nexus-script\n * @name Ok\n */\n");
    quickPickReturn = { label: "Ok", uri: { fsPath: "/ws/.nexus/scripts/ok.js", scheme: "file", path: "/ws/.nexus/scripts/ok.js", toString: () => "" } };
    const result = await pickScriptFromWorkspace();
    expect(result?.fsPath).toBe("/ws/.nexus/scripts/ok.js");
  });

  it("returns undefined when the user dismisses the QuickPick", async () => {
    mockFsEntries.set("/ws/.nexus/scripts", [["ok.js", 1]]);
    mockFiles.set("/ws/.nexus/scripts/ok.js", "/**\n * @nexus-script\n */\n");
    quickPickReturn = undefined;
    const result = await pickScriptFromWorkspace();
    expect(result).toBeUndefined();
  });
});
