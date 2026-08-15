import { describe, expect, it, vi, beforeEach } from "vitest";

const state = {
  workspaceFolders: undefined as unknown[] | undefined,
  configuredPath: ".nexus/scripts"
};

vi.mock("vscode", () => {
  /**
   * Mirrors `scriptFs.test.ts`'s `FakeUri` — specifically, `.with()` is a
   * real (if minimal) implementation, not a stub, since round 14's fix
   * depends on it to rebase onto a remote workspace root's scheme+authority.
   */
  class FakeUri {
    public constructor(
      public scheme: string,
      public authority: string,
      public path: string,
      public fsPath: string,
      public query = "",
      public fragment = ""
    ) {}
    public with(
      changes: Partial<{ scheme: string; authority: string; path: string; query: string; fragment: string }>
    ): FakeUri {
      const newScheme = changes.scheme ?? this.scheme;
      const newPath = changes.path ?? this.path;
      // Non-`file` fsPath is a decoy — same rationale as scriptFs.test.ts's
      // FakeUri: guarantees a handler that mistakenly reads `.fsPath` for a
      // remote Uri fails loudly instead of silently working.
      const newFsPath = newScheme === "file" ? newPath : `/LOCAL-DECOY-DO-NOT-USE${newPath}`;
      return new FakeUri(
        newScheme,
        changes.authority ?? this.authority,
        newPath,
        newFsPath,
        changes.query ?? this.query,
        changes.fragment ?? this.fragment
      );
    }
    public toString(): string {
      return this.scheme === "file" ? this.fsPath : `${this.scheme}://${this.authority}${this.path}`;
    }
  }

  /** Test-only constructor for a non-`file` (e.g. `vscode-remote:`) workspace-folder Uri. */
  function remoteUri(scheme: string, authority: string, p: string): FakeUri {
    return new FakeUri(scheme, authority, p, `/LOCAL-DECOY-DO-NOT-USE${p}`);
  }

  return {
    workspace: {
      get workspaceFolders() {
        return state.workspaceFolders;
      },
      getConfiguration: () => ({
        get: (_key: string, def?: string) => state.configuredPath ?? def
      })
    },
    Uri: {
      file: (p: string) => new FakeUri("file", "", p, p),
      joinPath: (base: { fsPath?: string; scheme?: string; authority?: string; path?: string }, ...parts: string[]) => {
        const scheme = base.scheme ?? "file";
        const authority = base.authority ?? "";
        const basePath = base.path ?? base.fsPath ?? "";
        const joinedPath = [basePath, ...parts].join("/");
        return new FakeUri(scheme, authority, joinedPath, scheme === "file" ? joinedPath : `/LOCAL-DECOY-DO-NOT-USE${joinedPath}`);
      }
    },
    __remoteUri: remoteUri
  };
});

import * as vscode from "vscode";
import { resolveScriptsDir } from "../../../src/services/scripts/resolveScriptsDir";

const remoteUri = (vscode as unknown as { __remoteUri: (scheme: string, authority: string, p: string) => vscode.Uri }).__remoteUri;

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

  it("round 14 — remote workspace + absolute configured path: rebases onto the workspace root's scheme+authority, preserving the POSIX path", () => {
    // ⊘ the pre-round-14 implementation (`vscode.Uri.file(configured)`
    // unconditionally for any absolute path): this would return a LOCAL
    // `file:` Uri for a path that only makes sense on the remote host —
    // `buildScriptFsScope`'s scheme/authority guard then refuses to unify
    // it with the remote script's own scope (see scriptFs.test.ts's
    // "buildScriptFsScope — scheme guard" tests), and a documented
    // absolute-path configuration silently breaks on remote.
    state.configuredPath = "/remote/shared/scripts";
    state.workspaceFolders = [{ uri: remoteUri("vscode-remote", "ssh-remote+host", "/home/user/project") }];

    const dir = resolveScriptsDir("/global-storage");

    expect(dir.scheme).toBe("vscode-remote");
    expect(dir.authority).toBe("ssh-remote+host");
    expect(dir.path).toBe("/remote/shared/scripts");
  });

  it("round 14 — Windows-drive-absolute configured path on a remote workspace: posixifies to /C:/scripts, same scheme+authority", () => {
    // A Windows-drive absolute (C:\...) is a real scenario over Remote-SSH
    // into a Windows host — Node's platform-default `path.isAbsolute` alone
    // wouldn't even recognize this as absolute when the CHECK happens to run
    // on a POSIX host (this repo's own CI), which is exactly why the fix
    // checks both path conventions rather than relying on `process.platform`.
    state.configuredPath = "C:\\scripts";
    state.workspaceFolders = [{ uri: remoteUri("vscode-remote", "ssh-remote+winbox", "/C:/Users/dev/project") }];

    const dir = resolveScriptsDir("/global-storage");

    expect(dir.scheme).toBe("vscode-remote");
    expect(dir.authority).toBe("ssh-remote+winbox");
    expect(dir.path).toBe("/C:/scripts");
  });

  it("round 14 — local (file:) absolute configured path is unchanged: still a plain Uri.file result, even with a workspace open", () => {
    state.configuredPath = "/custom/absolute/scripts";
    state.workspaceFolders = [{ uri: { fsPath: "/ws", scheme: "file", path: "/ws" } }];

    const dir = resolveScriptsDir("/global-storage");

    expect(dir.scheme).toBe("file");
    expect(dir.fsPath).toBe("/custom/absolute/scripts");
  });

  it("round 14 — absolute configured path with NO workspace open is unchanged: still Uri.file", () => {
    state.configuredPath = "/custom/absolute/scripts";
    state.workspaceFolders = undefined;

    const dir = resolveScriptsDir("/global-storage");

    expect(dir.scheme).toBe("file");
    expect(dir.fsPath).toBe("/custom/absolute/scripts");
  });
});
