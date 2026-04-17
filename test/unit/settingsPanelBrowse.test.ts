import { describe, expect, it, vi } from "vitest";

// Minimal vscode mock — the function under test depends only on Uri.file /
// Uri.joinPath and never actually touches the workspace.fs module (the stat
// shim is injected via a function parameter). The rest of the SettingsPanel
// class references workspace.* at import time; we mock enough to let the
// module load and then never exercise that path.
vi.mock("vscode", () => ({
  EventEmitter: class MockEventEmitter<T> {
    public readonly event = vi.fn(() => ({ dispose: vi.fn() }));
    public fire(_v?: T): void {}
    public dispose(): void {}
  },
  ViewColumn: { Active: -1 },
  FileType: { File: 1, Directory: 2 },
  Uri: {
    file: (p: string) => ({
      fsPath: p,
      scheme: "file",
      path: p,
      toString: () => p
    }),
    joinPath: (base: { fsPath: string }, ...parts: string[]) => ({
      fsPath: [base.fsPath, ...parts].join("/"),
      scheme: "file",
      path: [base.fsPath, ...parts].join("/"),
      toString: () => [base.fsPath, ...parts].join("/")
    })
  },
  workspace: {
    workspaceFolders: [],
    onDidChangeConfiguration: vi.fn(() => ({ dispose: vi.fn() })),
    getConfiguration: vi.fn(() => ({ get: vi.fn((_k: string, d?: unknown) => d), update: vi.fn() })),
    fs: {
      stat: vi.fn()
    }
  },
  window: {
    createWebviewPanel: vi.fn(),
    showOpenDialog: vi.fn(),
    showWarningMessage: vi.fn()
  },
  ConfigurationTarget: { Global: 1 }
}));

import { resolveBrowseDefaultUri } from "../../src/ui/settingsPanel";

const WS = { fsPath: "/ws", scheme: "file", path: "/ws", toString: () => "/ws" } as unknown as import("vscode").Uri;

function makeIsDirectory(directories: Set<string>): (uri: import("vscode").Uri) => Promise<boolean> {
  return async (uri) => directories.has(uri.fsPath);
}

describe("resolveBrowseDefaultUri", () => {
  it("seeds at an absolute path that exists as a directory", async () => {
    const isDir = makeIsDirectory(new Set(["/opt/nexus-scripts"]));
    const result = await resolveBrowseDefaultUri("/opt/nexus-scripts", WS, "/gs", isDir);
    expect(result?.fsPath).toBe("/opt/nexus-scripts");
  });

  it("resolves a relative path against the workspace root when that directory exists", async () => {
    const isDir = makeIsDirectory(new Set(["/ws/.nexus/scripts"]));
    const result = await resolveBrowseDefaultUri(".nexus/scripts", WS, "/gs", isDir);
    expect(result?.fsPath).toBe("/ws/.nexus/scripts");
  });

  it("resolves a relative path under global storage when no workspace is open", async () => {
    const isDir = makeIsDirectory(new Set(["/gs/.nexus/scripts"]));
    const result = await resolveBrowseDefaultUri(".nexus/scripts", undefined, "/gs", isDir);
    expect(result?.fsPath).toBe("/gs/.nexus/scripts");
  });

  it("falls back to the workspace root when the joined relative candidate does not exist", async () => {
    // Workspace is open but .nexus/scripts doesn't exist yet (first-run case).
    const isDir = makeIsDirectory(new Set(["/ws"]));
    const result = await resolveBrowseDefaultUri(".nexus/scripts", WS, "/gs", isDir);
    expect(result?.fsPath).toBe("/ws");
  });

  it("falls back to global storage when no workspace AND candidate doesn't exist", async () => {
    // Classic no-workspace first-run: relative setting points nowhere, no
    // workspace root to bail on — seed at the global-storage root so the
    // user lands somewhere meaningful rather than at VS Code's last-visited.
    const isDir = makeIsDirectory(new Set());
    const result = await resolveBrowseDefaultUri(".nexus/scripts", undefined, "/gs", isDir);
    expect(result?.fsPath).toBe("/gs");
  });

  it("returns undefined when nothing is seedable", async () => {
    const isDir = makeIsDirectory(new Set());
    const result = await resolveBrowseDefaultUri("", undefined, undefined, isDir);
    expect(result).toBeUndefined();
  });

  it("ignores a non-existent absolute path and falls through to the workspace root", async () => {
    const isDir = makeIsDirectory(new Set(["/ws"]));
    const result = await resolveBrowseDefaultUri("/not/a/real/path", WS, "/gs", isDir);
    expect(result?.fsPath).toBe("/ws");
  });

  it("prefers the absolute-path branch over the workspace-root fallback", async () => {
    // Both would resolve — the absolute path wins because it's the user's
    // explicit choice.
    const isDir = makeIsDirectory(new Set(["/opt/scripts", "/ws"]));
    const result = await resolveBrowseDefaultUri("/opt/scripts", WS, "/gs", isDir);
    expect(result?.fsPath).toBe("/opt/scripts");
  });

  it("treats an empty `current` as no seed and falls through to workspace root", async () => {
    const isDir = makeIsDirectory(new Set(["/ws"]));
    const result = await resolveBrowseDefaultUri("", WS, "/gs", isDir);
    expect(result?.fsPath).toBe("/ws");
  });
});
