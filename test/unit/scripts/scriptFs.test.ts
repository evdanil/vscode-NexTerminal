/*
 * Handler tests for the nexus.fs main-thread implementation (scriptFs.ts).
 *
 * `vscode.workspace.fs.stat` / `.readFile` delegate to node:fs/promises against
 * a per-test tmp directory, same style as the existing runtime-manager
 * integration mock — real filesystem behavior (including real symlinks),
 * without spinning up a Worker.
 *
 * House rule (CLAUDE.md): every test must fail against the specific wrong
 * implementation it prevents. Each block below names its target-wrong-impl (⊘).
 */
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const FileType = { Unknown: 0, File: 1, Directory: 2, SymbolicLink: 64 } as const;

vi.mock("vscode", () => {
  const FileTypeEnum = { Unknown: 0, File: 1, Directory: 2, SymbolicLink: 64 };

  /**
   * Synthetic remote filesystem, keyed by Uri `.path` (never `.fsPath`) —
   * exactly what a real remote FileSystemProvider is addressed by. Exported
   * out of the mock (via `__remoteFiles`) so tests can seed it directly.
   */
  const remoteFiles = new Map<string, { content: Uint8Array; isDir?: boolean }>();

  class FakeUri {
    public constructor(
      public scheme: string,
      public authority: string,
      public path: string,
      public fsPath: string,
      public query = "",
      public fragment = ""
    ) {}
    public with(changes: Partial<{ scheme: string; authority: string; path: string; query: string; fragment: string }>): FakeUri {
      const newScheme = changes.scheme ?? this.scheme;
      const newPath = changes.path ?? this.path;
      // Recompute fsPath from the new path, mirroring real vscode.Uri.with()
      // (fsPath is DERIVED from path, not independently settable). For a
      // non-file scheme the decoy prefix is deliberate: it guarantees fsPath
      // and path diverge, so a handler that mistakenly reads `.fsPath` for a
      // remote Uri fails loudly (an ENOENT lookup on a key nothing seeded)
      // instead of silently working because a fixture happened to keep
      // path === fsPath.
      const newFsPath = newScheme === "file" ? newPath : `/LOCAL-DECOY-DO-NOT-USE${newPath}`;
      return new FakeUri(newScheme, changes.authority ?? this.authority, newPath, newFsPath, changes.query ?? this.query, changes.fragment ?? this.fragment);
    }
    public toString(): string {
      return `${this.scheme}://${this.authority}${this.path}`;
    }
  }

  /** A `vscode-remote://`-style Uri whose `.fsPath` is deliberately bogus — see FakeUri.with() above. */
  function remoteUri(authority: string, p: string): FakeUri {
    return new FakeUri("vscode-remote", authority, p, `/LOCAL-DECOY-DO-NOT-USE${p}`);
  }

  function notFound(remotePath: string): Error {
    return Object.assign(new Error(`ENOENT (remote): ${remotePath}`), { code: "FileNotFound" });
  }

  const statMock = vi.fn(async (uri: { scheme: string; fsPath: string; path: string }) => {
    if (uri.scheme !== "file") {
      const entry = remoteFiles.get(uri.path);
      if (!entry) throw notFound(uri.path);
      return { type: entry.isDir ? FileTypeEnum.Directory : FileTypeEnum.File, ctime: 0, mtime: 0, size: entry.content.byteLength };
    }
    const lst = await fsp.lstat(uri.fsPath);
    let type = 0;
    let sizeSource = lst;
    if (lst.isSymbolicLink()) {
      type |= FileTypeEnum.SymbolicLink;
      const real = await fsp.stat(uri.fsPath); // follows the link
      sizeSource = real;
      type |= real.isDirectory() ? FileTypeEnum.Directory : FileTypeEnum.File;
    } else {
      type |= lst.isDirectory() ? FileTypeEnum.Directory : FileTypeEnum.File;
    }
    return { type, ctime: sizeSource.ctimeMs, mtime: sizeSource.mtimeMs, size: sizeSource.size };
  });

  const readFileMock = vi.fn(async (uri: { scheme: string; fsPath: string; path: string }) => {
    if (uri.scheme !== "file") {
      const entry = remoteFiles.get(uri.path);
      if (!entry || entry.isDir) throw notFound(uri.path);
      return entry.content;
    }
    const buf = await fsp.readFile(uri.fsPath);
    return new Uint8Array(buf);
  });

  return {
    FileType: FileTypeEnum,
    Uri: {
      file: (p: string) => new FakeUri("file", "", p, p)
    },
    workspace: {
      fs: {
        stat: statMock,
        readFile: readFileMock
      }
    },
    __remoteFiles: remoteFiles,
    __remoteUri: remoteUri
  };
});

import * as vscode from "vscode";
import { scriptFsExists, scriptFsReadText, buildScriptFsScope, type ScriptFsContext } from "../../../src/services/scripts/scriptFs";

const statSpy = vscode.workspace.fs.stat as unknown as ReturnType<typeof vi.fn>;
const readFileSpy = vscode.workspace.fs.readFile as unknown as ReturnType<typeof vi.fn>;
const remoteFiles = (vscode as unknown as { __remoteFiles: Map<string, { content: Uint8Array; isDir?: boolean }> }).__remoteFiles;
const remoteUri = (vscode as unknown as { __remoteUri: (authority: string, p: string) => vscode.Uri }).__remoteUri;

// -----------------------------------------------------------------------------
// Fixture harness
// -----------------------------------------------------------------------------

let tmpRoot: string;

beforeEach(async () => {
  vi.clearAllMocks();
  remoteFiles.clear();
  tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "nexus-scriptfs-"));
});

afterEach(async () => {
  await fsp.rm(tmpRoot, { recursive: true, force: true });
});

function fileUri(p: string): vscode.Uri {
  return vscode.Uri.file(p) as vscode.Uri;
}

/** Standard scope: scriptDir = <root>/cisco, one level under scriptsRoot = <root>. */
async function makeCtx(overrides?: Partial<ScriptFsContext>): Promise<{ ctx: ScriptFsContext; root: string; scriptDir: string; log: ReturnType<typeof vi.fn> }> {
  const root = tmpRoot;
  const scriptDir = path.join(root, "cisco");
  await fsp.mkdir(scriptDir, { recursive: true });
  const log = vi.fn();
  const ctx: ScriptFsContext = {
    scriptUri: fileUri(path.join(scriptDir, "probe.js")),
    scriptDirUri: fileUri(scriptDir),
    scriptsRootUri: fileUri(root),
    log,
    ...overrides
  };
  return { ctx, root, scriptDir, log };
}

// -----------------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------------

describe("scriptFsReadText — size cap", () => {
  it("reads a file exactly at the 4 MiB boundary", async () => {
    const { ctx, scriptDir } = await makeCtx();
    const exact = Buffer.alloc(4 * 1024 * 1024, "a");
    await fsp.writeFile(path.join(scriptDir, "exact.bin"), exact);

    const text = await scriptFsReadText("exact.bin", ctx);
    expect(text.length).toBe(4 * 1024 * 1024);
  });

  it("refuses a file one byte over the 4 MiB boundary with FileTooLarge, and never reads its body", async () => {
    // ⊘ a >= / off-by-one in either direction, and ⊘ read-then-check ordering.
    const { ctx, scriptDir } = await makeCtx();
    const over = Buffer.alloc(4 * 1024 * 1024 + 1, "a");
    await fsp.writeFile(path.join(scriptDir, "over.bin"), over);

    // TOP-LEVEL sizeBytes/maxBytes, not nested under `.extra` — this is what
    // the docs and the d.ts promise (`err.sizeBytes`), and what
    // scriptRuntimeManager.ts's extraFieldsOf/reviveError round-trip expects
    // to find as plain own properties on the error. ⊘ makeFsError nesting
    // these fields under a property literally named "extra".
    await expect(scriptFsReadText("over.bin", ctx)).rejects.toMatchObject({
      code: "FileTooLarge",
      sizeBytes: 4 * 1024 * 1024 + 1,
      maxBytes: 4 * 1024 * 1024
    });
    // The cap-ordering assertion: stat rejected it before readFile was ever called.
    expect(readFileSpy).not.toHaveBeenCalled();
  });

  it("catches a lying stat (size: 0) via the post-read byteLength check", async () => {
    // ⊘ trusting `stat.size` alone and skipping the post-read check.
    const { ctx, scriptDir } = await makeCtx();
    const big = Buffer.alloc(5 * 1024 * 1024, "a");
    await fsp.writeFile(path.join(scriptDir, "lies.bin"), big);
    statSpy.mockImplementationOnce(async () => ({ type: FileType.File, ctime: 0, mtime: 0, size: 0 }));

    await expect(scriptFsReadText("lies.bin", ctx)).rejects.toMatchObject({ code: "FileTooLarge" });
    // Unlike the ordering test above, the body WAS read here — that's the point:
    // stat lied, so only the post-read check catches it.
    expect(readFileSpy).toHaveBeenCalledTimes(1);
  });
});

describe("scriptFsReadText — decoding", () => {
  it("rejects non-UTF-8 bytes with NotUtf8", async () => {
    // ⊘ a non-fatal TextDecoder that silently replaces invalid bytes with U+FFFD.
    const { ctx, scriptDir } = await makeCtx();
    await fsp.writeFile(path.join(scriptDir, "bad.bin"), Buffer.from([0xff, 0xfe, 0x41]));

    await expect(scriptFsReadText("bad.bin", ctx)).rejects.toMatchObject({ code: "NotUtf8" });
  });

  it("strips a UTF-8 BOM from valid text", async () => {
    const { ctx, scriptDir } = await makeCtx();
    await fsp.writeFile(path.join(scriptDir, "bom.txt"), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("hello", "utf8")]));

    const text = await scriptFsReadText("bom.txt", ctx);
    expect(text).toBe("hello");
  });
});

describe("scriptFsReadText — FileNotFound", () => {
  it("throws FileNotFound for a missing path", async () => {
    const { ctx } = await makeCtx();
    await expect(scriptFsReadText("nope.txt", ctx)).rejects.toMatchObject({ code: "FileNotFound" });
  });

  it("throws FileNotFound (not a crash) when the target is a real directory", async () => {
    // ⊘ `stat.type === vscode.FileType.Directory` equality instead of a bitmask test.
    const { ctx, scriptDir } = await makeCtx();
    await fsp.mkdir(path.join(scriptDir, "adir"));
    await expect(scriptFsReadText("adir", ctx)).rejects.toMatchObject({ code: "FileNotFound" });
  });

  it.skipIf(process.platform === "win32")(
    "throws FileNotFound for a SYMLINKED directory too (bitmask test, not equality)",
    async () => {
      // ⊘ `stat.type === vscode.FileType.Directory`: a symlinked dir reports
      // BOTH the Directory bit and the SymbolicLink bit, so a strict equality
      // test would never match it and would fall through to trying to decode
      // it as a file.
      const { ctx, scriptDir, root } = await makeCtx();
      const real = path.join(root, "realdir");
      await fsp.mkdir(real);
      await fsp.symlink(real, path.join(scriptDir, "linkdir"), "dir");
      await expect(scriptFsReadText("linkdir", ctx)).rejects.toMatchObject({ code: "FileNotFound" });
    }
  );
});

describe("scriptFsReadText — stat-failure mapping (FileNotFound vs. ReadFailed)", () => {
  it("maps a permission-denied stat failure to ReadFailed, not FileNotFound — the path resolved fine, the read itself is what didn't work", async () => {
    // ⊘ a stat catch-block that maps EVERY failure to FileNotFound regardless
    // of cause, which contradicts ReadFailed's documented meaning ("stat ok
    // but read failed (permissions, provider error)") — a permission error IS
    // exactly that documented case, just surfacing one step earlier (at stat
    // rather than readFile).
    const { ctx, scriptDir } = await makeCtx();
    await fsp.writeFile(path.join(scriptDir, "secret.txt"), "shh");
    statSpy.mockImplementationOnce(async () => {
      throw Object.assign(new Error("EACCES: permission denied"), { code: "NoPermissions" });
    });

    await expect(scriptFsReadText("secret.txt", ctx)).rejects.toMatchObject({ code: "ReadFailed" });
  });

  it("still maps a genuine ENOENT-style stat failure to FileNotFound (unchanged)", async () => {
    const { ctx } = await makeCtx();
    await expect(scriptFsReadText("nope.txt", ctx)).rejects.toMatchObject({ code: "FileNotFound" });
  });
});

describe("scriptFsReadText — real symlink follow (decision 3)", () => {
  it.skipIf(process.platform === "win32")(
    "reads through a symlink that points OUTSIDE the scope — lexical containment, no realpath",
    async () => {
      // ⊘ a realpath-based containment check, which would refuse this the
      // moment it resolved "linked" to somewhere outside root/scripts.
      const root = tmpRoot;
      const scriptDir = path.join(root, "scripts", "cisco");
      const outsideDir = path.join(root, "outside");
      await fsp.mkdir(scriptDir, { recursive: true });
      await fsp.mkdir(outsideDir, { recursive: true });
      await fsp.writeFile(path.join(outsideDir, "secret.txt"), "shh");
      await fsp.symlink(outsideDir, path.join(scriptDir, "linked"), "dir");

      const ctx: ScriptFsContext = {
        scriptUri: fileUri(path.join(scriptDir, "probe.js")),
        scriptDirUri: fileUri(scriptDir),
        scriptsRootUri: fileUri(path.join(root, "scripts")),
        log: vi.fn()
      };

      const text = await scriptFsReadText("linked/secret.txt", ctx);
      expect(text).toBe("shh");
    }
  );
});

describe("scriptFsExists", () => {
  it("is true for an existing file and an existing directory", async () => {
    const { ctx, scriptDir } = await makeCtx();
    await fsp.writeFile(path.join(scriptDir, "a.txt"), "x");
    await fsp.mkdir(path.join(scriptDir, "adir"));
    expect(await scriptFsExists("a.txt", ctx)).toBe(true);
    expect(await scriptFsExists("adir", ctx)).toBe(true);
  });

  it("is false for a missing entry", async () => {
    const { ctx } = await makeCtx();
    expect(await scriptFsExists("nope.txt", ctx)).toBe(false);
  });

  it("throws PathOutsideScope for an out-of-scope probe rather than returning false (no existence oracle outside scope)", async () => {
    // ⊘ exists() swallowing an out-of-scope path into a plain `false`.
    const { ctx } = await makeCtx();
    await expect(scriptFsExists("../../../secrets.txt", ctx)).rejects.toMatchObject({ code: "PathOutsideScope" });
  });
});

describe("NoScriptDir — untitled scripts", () => {
  it("both readText and exists throw NoScriptDir even for a path that would otherwise be in-scope", async () => {
    // ⊘ falling back to root-only (or any) scope for an untitled script.
    const { ctx, root } = await makeCtx({ scriptDirUri: undefined });
    await expect(scriptFsReadText(path.join(root, "x.json"), ctx)).rejects.toMatchObject({ code: "NoScriptDir" });
    await expect(scriptFsExists(path.join(root, "x.json"), ctx)).rejects.toMatchObject({ code: "NoScriptDir" });
  });
});

describe("logging (decision 8)", () => {
  it("logs a successful read with the resolved path and byte count", async () => {
    // ⊘ a silent read that never calls ctx.log.
    const { ctx, scriptDir, log } = await makeCtx();
    await fsp.writeFile(path.join(scriptDir, "a.txt"), "hello");
    await scriptFsReadText("a.txt", ctx);
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/^fs\.readText .*a\.txt \(5 bytes\)$/));
  });

  it("logs a refusal with the failing error code", async () => {
    const { ctx, log } = await makeCtx();
    await expect(scriptFsReadText("../../../etc/passwd", ctx)).rejects.toBeTruthy();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("PathOutsideScope"));
  });

  it("logs exists() with the resolved boolean", async () => {
    const { ctx, scriptDir, log } = await makeCtx();
    await fsp.writeFile(path.join(scriptDir, "a.txt"), "hi");
    await scriptFsExists("a.txt", ctx);
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/^fs\.exists .*a\.txt → true$/));
  });
});

describe("InvalidPath messages name the offending path", () => {
  it("the thrown Error's message — not just the log line — includes the requested value", async () => {
    // ⊘ an InvalidPath detail string that only ever says something generic
    // like "path must be a non-empty string" with no way to tell, from the
    // error alone, WHICH call produced it.
    const { ctx } = await makeCtx();
    await expect(scriptFsReadText("", ctx)).rejects.toMatchObject({
      code: "InvalidPath",
      message: expect.stringContaining('""')
    });
    await expect(scriptFsReadText("a\0b", ctx)).rejects.toMatchObject({
      code: "InvalidPath",
      message: expect.stringContaining("a\\u0000b")
    });
  });
});

describe("buildScriptFsScope — scheme guard (decision 5, remote compat)", () => {
  it("drops the scripts root from the union when its scheme differs from the script's, and refuses a root-scoped read", () => {
    // ⊘ comparing a remote `.path` against a local `.fsPath` (or vice versa) as
    // if they were on the same filesystem.
    const remoteScriptUri = { scheme: "vscode-remote", authority: "wsl+ubuntu", path: "/home/u/scripts/a.js", fsPath: "/home/u/scripts/a.js" } as unknown as vscode.Uri;
    const remoteScriptDirUri = { scheme: "vscode-remote", authority: "wsl+ubuntu", path: "/home/u/scripts", fsPath: "/home/u/scripts" } as unknown as vscode.Uri;
    const localRootUri = fileUri("/ws/.nexus/scripts");

    const scope = buildScriptFsScope({
      scriptUri: remoteScriptUri,
      scriptDirUri: remoteScriptDirUri,
      scriptsRootUri: localRootUri,
      log: vi.fn()
    });

    expect("code" in scope).toBe(false);
    if (!("code" in scope)) {
      expect(scope.scriptsRootPath).toBeUndefined();
      expect(scope.scriptDirPath).toBe("/home/u/scripts");
      expect(scope.platform).toBe("posix");
    }
  });

  it("keeps the root in the union when scheme AND authority match", () => {
    const remoteScriptUri = { scheme: "vscode-remote", authority: "wsl+ubuntu", path: "/home/u/scripts/cisco/a.js", fsPath: "/home/u/scripts/cisco/a.js" } as unknown as vscode.Uri;
    const remoteScriptDirUri = { scheme: "vscode-remote", authority: "wsl+ubuntu", path: "/home/u/scripts/cisco", fsPath: "/home/u/scripts/cisco" } as unknown as vscode.Uri;
    const remoteRootUri = { scheme: "vscode-remote", authority: "WSL+UBUNTU", path: "/home/u/scripts", fsPath: "/home/u/scripts" } as unknown as vscode.Uri;

    const scope = buildScriptFsScope({
      scriptUri: remoteScriptUri,
      scriptDirUri: remoteScriptDirUri,
      scriptsRootUri: remoteRootUri,
      log: vi.fn()
    });

    expect("code" in scope).toBe(false);
    if (!("code" in scope)) {
      expect(scope.scriptsRootPath).toBe("/home/u/scripts");
    }
  });
});

describe("remote (non-file) scheme — backslash traversal guard", () => {
  it("refuses a backslash-containing path on a non-file scheme with InvalidPath, even though posix lexical resolution alone would consider it one harmless filename segment", async () => {
    // ⊘ scriptFs.ts not rejecting backslashes on non-file schemes at all —
    // buildScriptFsScope forces platform "posix" for every remote scheme, and
    // posix treats "\" as an ordinary filename character, so containment
    // alone WOULD pass this. The danger is downstream: a real Windows remote
    // FileSystemProvider (Remote-SSH / WSL to a Windows host) normalizes "\"
    // into a genuine path separator, turning this into a real traversal on
    // the far end.
    const ctx: ScriptFsContext = {
      scriptUri: remoteUri("wsl+ubuntu", "/home/u/scripts/cisco/probe.js"),
      scriptDirUri: remoteUri("wsl+ubuntu", "/home/u/scripts/cisco"),
      scriptsRootUri: undefined,
      log: vi.fn()
    };

    await expect(scriptFsReadText("..\\..\\..\\etc\\passwd", ctx)).rejects.toMatchObject({ code: "InvalidPath" });
    await expect(scriptFsExists("..\\..\\..\\etc\\passwd", ctx)).rejects.toMatchObject({ code: "InvalidPath" });
  });

  it.skipIf(process.platform === "win32")(
    "still allows a literal backslash in a filename on the local file: scheme (unaffected — a real filename character there)",
    async () => {
      const { ctx, scriptDir } = await makeCtx();
      const weirdName = "weird\\name.txt";
      await fsp.writeFile(path.join(scriptDir, weirdName), "ok");
      const text = await scriptFsReadText(weirdName, ctx);
      expect(text).toBe("ok");
    }
  );
});

describe("remote (non-file) scheme — reads route by .path, never by the (bogus for remote) .fsPath", () => {
  it("reads a file through a vscode-remote Uri whose .path and .fsPath deliberately diverge", async () => {
    // ⊘ pathOf() using `.fsPath` instead of `.path` for a non-file scheme —
    // would compute the scope from the decoy fsPath, causing the resolved Uri
    // handed to workspace.fs to carry the decoy prefix too, which nothing in
    // remoteFiles is keyed by → FileNotFound instead of the real content.
    // ⊘ uriOf() dropping the `.with({ path: resolvedPath })` reconstruction
    // (e.g. returning `scriptUri` unchanged) — would stat/read the SCRIPT's
    // own path ("probe.js") instead of the resolved target ("data.txt").
    const authority = "wsl+ubuntu";
    const scriptDirPath = "/home/u/scripts/cisco";
    remoteFiles.set(`${scriptDirPath}/data.txt`, { content: new TextEncoder().encode("remote-content") });

    const ctx: ScriptFsContext = {
      scriptUri: remoteUri(authority, `${scriptDirPath}/probe.js`),
      scriptDirUri: remoteUri(authority, scriptDirPath),
      scriptsRootUri: undefined,
      log: vi.fn()
    };

    const text = await scriptFsReadText("data.txt", ctx);
    expect(text).toBe("remote-content");
  });

  it("exists() also routes by .path for a remote Uri", async () => {
    const authority = "wsl+ubuntu";
    const scriptDirPath = "/home/u/scripts/cisco";
    remoteFiles.set(`${scriptDirPath}/present.txt`, { content: new TextEncoder().encode("x") });

    const ctx: ScriptFsContext = {
      scriptUri: remoteUri(authority, `${scriptDirPath}/probe.js`),
      scriptDirUri: remoteUri(authority, scriptDirPath),
      scriptsRootUri: undefined,
      log: vi.fn()
    };

    expect(await scriptFsExists("present.txt", ctx)).toBe(true);
    expect(await scriptFsExists("missing.txt", ctx)).toBe(false);
  });

  it("platform is forced to posix for a remote scope even when the HOST process reports win32", () => {
    // ⊘ deriving platform from `process.platform` regardless of scheme
    // (dropping the `ctx.scriptUri.scheme === "file"` guard) — on this repo's
    // actual posix CI host that mutation is unobservable (process.platform is
    // already posix either way), so this test forces process.platform to
    // "win32" to make the scheme check the ONLY thing that can still produce
    // "posix" for a remote scope.
    const originalDescriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    try {
      const remoteScope = buildScriptFsScope({
        scriptUri: remoteUri("wsl+ubuntu", "/home/u/scripts/cisco/probe.js"),
        scriptDirUri: remoteUri("wsl+ubuntu", "/home/u/scripts/cisco"),
        scriptsRootUri: undefined,
        log: vi.fn()
      });
      expect("code" in remoteScope).toBe(false);
      if (!("code" in remoteScope)) {
        expect(remoteScope.platform).toBe("posix");
      }
    } finally {
      Object.defineProperty(process, "platform", originalDescriptor);
    }
  });
});
