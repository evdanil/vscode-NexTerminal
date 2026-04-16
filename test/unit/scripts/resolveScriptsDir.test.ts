import { describe, expect, it, vi, beforeEach } from "vitest";

const state = {
  workspaceFolders: undefined as unknown[] | undefined,
  configuredPath: ".nexus/scripts"
};

vi.mock("vscode", () => ({
  workspace: {
    get workspaceFolders() {
      return state.workspaceFolders;
    },
    getConfiguration: () => ({
      get: (_key: string, def?: string) => state.configuredPath ?? def
    })
  },
  Uri: {
    file: (p: string) => ({ fsPath: p, scheme: "file", path: p }),
    joinPath: (base: { fsPath: string }, ...parts: string[]) => ({
      fsPath: [base.fsPath, ...parts].join("/"),
      scheme: "file",
      path: [base.fsPath, ...parts].join("/")
    })
  }
}));

import { resolveScriptsDir } from "../../../src/services/scripts/resolveScriptsDir";

describe("resolveScriptsDir", () => {
  beforeEach(() => {
    state.workspaceFolders = undefined;
    state.configuredPath = ".nexus/scripts";
  });

  it("uses an absolute configured path regardless of workspace or fallback", () => {
    state.configuredPath = "/custom/absolute/scripts";
    state.workspaceFolders = [{ uri: { fsPath: "/ws", scheme: "file", path: "/ws" } }];
    const dir = resolveScriptsDir("/global-storage");
    expect(dir.fsPath).toBe("/custom/absolute/scripts");
  });

  it("resolves a relative path against the workspace root when a workspace is open", () => {
    state.workspaceFolders = [{ uri: { fsPath: "/ws", scheme: "file", path: "/ws" } }];
    const dir = resolveScriptsDir("/global-storage");
    expect(dir.fsPath).toBe("/ws/.nexus/scripts");
  });

  it("falls back to globalStoragePath/scripts when no workspace is open", () => {
    state.workspaceFolders = undefined;
    const dir = resolveScriptsDir("/home/user/.vscode/globalStorage/ext");
    expect(dir.fsPath).toBe("/home/user/.vscode/globalStorage/ext/scripts");
  });

  it("handles a custom relative path with workspace", () => {
    state.configuredPath = "my-scripts";
    state.workspaceFolders = [{ uri: { fsPath: "/project", scheme: "file", path: "/project" } }];
    const dir = resolveScriptsDir("/gs");
    expect(dir.fsPath).toBe("/project/my-scripts");
  });
});
