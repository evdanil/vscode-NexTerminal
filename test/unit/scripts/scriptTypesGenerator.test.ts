import { describe, expect, it, vi, beforeEach } from "vitest";

interface MockStat {
  type: number;
}

const fsState = {
  dirs: new Set<string>(),
  files: new Map<string, Uint8Array>()
};

vi.mock("vscode", () => ({
  EventEmitter: class {
    public event = () => ({ dispose: () => {} });
    public fire(): void {}
    public dispose(): void {}
  },
  Uri: {
    file: (p: string) => ({ fsPath: p, scheme: "file", path: p, toString: () => p }),
    joinPath: (base: { fsPath: string }, ...parts: string[]) => ({
      fsPath: [base.fsPath, ...parts].join("/"),
      scheme: "file",
      path: [base.fsPath, ...parts].join("/"),
      toString: () => [base.fsPath, ...parts].join("/")
    })
  },
  FileType: { File: 1, Directory: 2 },
  workspace: {
    fs: {
      createDirectory: vi.fn(async (uri: { fsPath: string }) => {
        fsState.dirs.add(uri.fsPath);
      }),
      stat: vi.fn(async (uri: { fsPath: string }): Promise<MockStat> => {
        if (fsState.files.has(uri.fsPath)) return { type: 1 };
        if (fsState.dirs.has(uri.fsPath)) return { type: 2 };
        throw new Error(`ENOENT: ${uri.fsPath}`);
      }),
      readFile: vi.fn(async (uri: { fsPath: string }): Promise<Uint8Array> => {
        const f = fsState.files.get(uri.fsPath);
        if (!f) throw new Error(`ENOENT: ${uri.fsPath}`);
        return f;
      }),
      writeFile: vi.fn(async (uri: { fsPath: string }, bytes: Uint8Array) => {
        fsState.files.set(uri.fsPath, bytes);
      })
    }
  }
}));

import * as vscode from "vscode";
import { ensureWorkspaceScriptTypes, BUNDLED_DTS_VERSION_HEADER } from "../../../src/services/scripts/scriptTypesGenerator";

const BUNDLED_DTS = `${BUNDLED_DTS_VERSION_HEADER}\ndeclare function expect(x: unknown): Promise<unknown>;\n`;
const BUNDLED_JSCONFIG = `{"compilerOptions":{"checkJs":true}}`;

async function getAssets(): Promise<{ dts: string; jsconfig: string }> {
  return { dts: BUNDLED_DTS, jsconfig: BUNDLED_JSCONFIG };
}

function scriptsDir(dir: string) {
  return { fsPath: dir, scheme: "file", path: dir, toString: () => dir } as vscode.Uri;
}

describe("scriptTypesGenerator.ensureWorkspaceScriptTypes", () => {
  beforeEach(() => {
    fsState.dirs.clear();
    fsState.files.clear();
    vi.clearAllMocks();
  });

  it("writes .d.ts and jsconfig.json when neither exists, creating parent directories", async () => {
    await ensureWorkspaceScriptTypes(scriptsDir("/workspace/.nexus/scripts"), getAssets);
    expect(fsState.dirs.has("/workspace/.nexus/scripts")).toBe(true);
    expect(fsState.dirs.has("/workspace/.nexus/scripts/types")).toBe(true);
    const dts = new TextDecoder().decode(fsState.files.get("/workspace/.nexus/scripts/types/nexus-scripts.d.ts")!);
    const jsconfig = new TextDecoder().decode(fsState.files.get("/workspace/.nexus/scripts/jsconfig.json")!);
    expect(dts).toBe(BUNDLED_DTS);
    expect(jsconfig).toBe(BUNDLED_JSCONFIG);
  });

  it("is idempotent when both files exist with matching content", async () => {
    fsState.dirs.add("/workspace/.nexus/scripts");
    fsState.dirs.add("/workspace/.nexus/scripts/types");
    fsState.files.set(
      "/workspace/.nexus/scripts/types/nexus-scripts.d.ts",
      new TextEncoder().encode(BUNDLED_DTS)
    );
    fsState.files.set("/workspace/.nexus/scripts/jsconfig.json", new TextEncoder().encode(BUNDLED_JSCONFIG));
    await ensureWorkspaceScriptTypes(scriptsDir("/workspace/.nexus/scripts"), getAssets);
    expect((vscode.workspace.fs.writeFile as unknown as { mock: { calls: unknown[] } }).mock.calls).toHaveLength(0);
  });

  it("overwrites the .d.ts when the bundled version-header differs", async () => {
    fsState.dirs.add("/workspace/.nexus/scripts");
    fsState.dirs.add("/workspace/.nexus/scripts/types");
    fsState.files.set(
      "/workspace/.nexus/scripts/types/nexus-scripts.d.ts",
      new TextEncoder().encode("// older version\nold content\n")
    );
    fsState.files.set("/workspace/.nexus/scripts/jsconfig.json", new TextEncoder().encode(BUNDLED_JSCONFIG));
    await ensureWorkspaceScriptTypes(scriptsDir("/workspace/.nexus/scripts"), getAssets);
    const dts = new TextDecoder().decode(fsState.files.get("/workspace/.nexus/scripts/types/nexus-scripts.d.ts")!);
    expect(dts).toBe(BUNDLED_DTS);
  });

  it("works with a globalStorage-based scripts directory", async () => {
    await ensureWorkspaceScriptTypes(scriptsDir("/globalStorage/scripts"), getAssets);
    expect(fsState.dirs.has("/globalStorage/scripts")).toBe(true);
    expect(fsState.files.has("/globalStorage/scripts/types/nexus-scripts.d.ts")).toBe(true);
  });
});
