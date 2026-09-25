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

  it("v11 → v12 (serial Connect and Run Script… keeps output too): a workspace holding the OLD real v11 header is rewritten to the new bundled content on the next run", async () => {
    // ⊘ shipping new d.ts content (adding nexus.fs / NexusApi in v4, the fixed
    // 30-second deadline in v5, the configurable read cap in v6,
    // nexus.include + module/exports in v7, the v8 corrections — telnet
    // in `session.type`, `poll.send` string-only, the real `lookback`
    // semantics — v9's waitFor example without a top-level `return`,
    // v10's `FileTooLarge.sizeBytes` note saying which case applies in a
    // remote window rather than contrasting "local" with "remote",
    // v11's buffer that Connect and Run Script… starts at the session's open,
    // then v12's saying it does so on a serial profile too)
    // without bumping BUNDLED_DTS_VERSION_HEADER to match —
    // existing users' seeded copies
    // would keep comparing equal to the (un-bumped) constant and never get
    // rewritten, so the new content would silently never reach their
    // IntelliSense no matter how many times they ran a script command. The
    // literals below are deliberately hardcoded rather than derived from the
    // constant: a test that reads the constant on both sides would pass
    // against ANY value, including an un-bumped one.
    fsState.dirs.add("/workspace/.nexus/scripts");
    fsState.dirs.add("/workspace/.nexus/scripts/types");
    fsState.files.set(
      "/workspace/.nexus/scripts/types/nexus-scripts.d.ts",
      new TextEncoder().encode(
        "// Nexus Scripts API types — v11\ndeclare function expect(x: unknown): Promise<unknown>;\n"
      )
    );
    fsState.files.set("/workspace/.nexus/scripts/jsconfig.json", new TextEncoder().encode(BUNDLED_JSCONFIG));

    expect(BUNDLED_DTS_VERSION_HEADER).toBe("// Nexus Scripts API types — v12");
    await ensureWorkspaceScriptTypes(scriptsDir("/workspace/.nexus/scripts"), getAssets);

    const dts = new TextDecoder().decode(fsState.files.get("/workspace/.nexus/scripts/types/nexus-scripts.d.ts")!);
    expect(dts).toBe(BUNDLED_DTS);
    expect(dts.startsWith("// Nexus Scripts API types — v12")).toBe(true);
  });

  it("leaves an existing jsconfig.json alone — edits to it survive later runs, a d.ts upgrade included (#155)", async () => {
    // ⊘ the old rule, rewrite jsconfig.json whenever it differs from the
    // bundled copy: every run silently reverted the user's own settings (a
    // `paths` map, an extra `lib`, `checkJs: false`), and a scripts folder
    // pointed at a project that already had its own jsconfig.json lost it.
    // ⊘ a version gate that rides on the d.ts marker: the upgrade below
    // would then take the user's jsconfig.json with it.
    const edited = `{"compilerOptions":{"checkJs":false,"lib":["ES2022","DOM"]}}`;
    fsState.dirs.add("/workspace/.nexus/scripts");
    fsState.dirs.add("/workspace/.nexus/scripts/types");
    fsState.files.set(
      "/workspace/.nexus/scripts/types/nexus-scripts.d.ts",
      new TextEncoder().encode("// Nexus Scripts API types — v1\nold content\n")
    );
    fsState.files.set("/workspace/.nexus/scripts/jsconfig.json", new TextEncoder().encode(edited));

    await ensureWorkspaceScriptTypes(scriptsDir("/workspace/.nexus/scripts"), getAssets);
    await ensureWorkspaceScriptTypes(scriptsDir("/workspace/.nexus/scripts"), getAssets);

    const jsconfig = new TextDecoder().decode(fsState.files.get("/workspace/.nexus/scripts/jsconfig.json")!);
    expect(jsconfig).toBe(edited);
    const writes = (vscode.workspace.fs.writeFile as unknown as { mock: { calls: Array<[{ fsPath: string }]> } }).mock.calls;
    expect(writes.map(([uri]) => uri.fsPath)).toEqual(["/workspace/.nexus/scripts/types/nexus-scripts.d.ts"]);
  });

  // The exact jsconfig.json earlier releases wrote, from the git history of
  // src/services/scripts/assets/jsconfig.json. Hardcoded, not imported: a
  // test reading the generator's own list would pass whatever the list held.
  const SHIPPED_IN_2_8_0_AND_2_8_1 = `{
  "compilerOptions": {
    "checkJs": true,
    "target": "ES2022",
    "lib": ["ES2022"],
    "module": "ESNext",
    "moduleResolution": "Node",
    "types": ["./types/nexus-scripts"]
  },
  "include": ["**/*.js"],
  "exclude": ["node_modules"]
}
`;
  const SHIPPED_IN_2_8_2 = `{
  "compilerOptions": {
    "checkJs": true,
    "target": "ES2022",
    "lib": ["ES2022"],
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "types": ["./types/nexus-scripts"]
  },
  "include": ["**/*.js"],
  "exclude": ["node_modules"]
}
`;

  it.each([
    ["2.8.0 / 2.8.1 (moduleResolution Node)", SHIPPED_IN_2_8_0_AND_2_8_1],
    ["2.8.2 (no moduleDetection: force)", SHIPPED_IN_2_8_2],
    ["2.8.2, checked out with CRLF line endings", SHIPPED_IN_2_8_2.replace(/\n/g, "\r\n")]
  ])("replaces a jsconfig.json that is Nexus's own copy from %s (#155)", async (_label, shipped) => {
    // ⊘ keeping every readable jsconfig.json: a workspace last seeded before
    // 2.8.3 keeps the copy that raised TS1375 on every top-level await (and,
    // before 2.8.2, the legacy module resolution) — fixes the old
    // rewrite-on-every-run rule used to deliver.
    fsState.dirs.add("/workspace/.nexus/scripts");
    fsState.dirs.add("/workspace/.nexus/scripts/types");
    fsState.files.set("/workspace/.nexus/scripts/types/nexus-scripts.d.ts", new TextEncoder().encode(BUNDLED_DTS));
    fsState.files.set("/workspace/.nexus/scripts/jsconfig.json", new TextEncoder().encode(shipped));

    await ensureWorkspaceScriptTypes(scriptsDir("/workspace/.nexus/scripts"), getAssets);

    const jsconfig = new TextDecoder().decode(fsState.files.get("/workspace/.nexus/scripts/jsconfig.json")!);
    expect(jsconfig).toBe(BUNDLED_JSCONFIG);
  });

  it("the bundled jsconfig.json is still the one this suite knows (#155)", async () => {
    // ⊘ changing the bundled copy without adding the outgoing text to
    // SUPERSEDED_BUNDLED_JSCONFIGS: every workspace seeded with it would keep
    // the old copy forever, since an existing jsconfig.json is otherwise kept.
    // When this fails, add the previous text to that list, then update this.
    const { readFileSync } = await import("node:fs");
    const pathMod = await import("node:path");
    const bundled = readFileSync(
      pathMod.join(__dirname, "..", "..", "..", "src", "services", "scripts", "assets", "jsconfig.json"),
      "utf8"
    );
    expect(bundled).toBe(`{
  "compilerOptions": {
    "checkJs": true,
    "target": "ES2022",
    "lib": ["ES2022"],
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "moduleDetection": "force",
    "useUnknownInCatchVariables": false,
    "allowJs": true,
    "noEmit": true,
    "types": ["./types/nexus-scripts"]
  },
  "include": ["**/*.js"],
  "exclude": ["node_modules"]
}
`);
  });

  it("keeps an old Nexus copy the user has since edited (#155)", async () => {
    // ⊘ matching "looks like ours" (a shared key, the types entry) instead of
    // the exact shipped text: one edit makes the file the user's.
    const edited = SHIPPED_IN_2_8_2.replace('"lib": ["ES2022"]', '"lib": ["ES2022", "DOM"]');
    fsState.dirs.add("/workspace/.nexus/scripts");
    fsState.dirs.add("/workspace/.nexus/scripts/types");
    fsState.files.set("/workspace/.nexus/scripts/types/nexus-scripts.d.ts", new TextEncoder().encode(BUNDLED_DTS));
    fsState.files.set("/workspace/.nexus/scripts/jsconfig.json", new TextEncoder().encode(edited));

    await ensureWorkspaceScriptTypes(scriptsDir("/workspace/.nexus/scripts"), getAssets);

    const jsconfig = new TextDecoder().decode(fsState.files.get("/workspace/.nexus/scripts/jsconfig.json")!);
    expect(jsconfig).toBe(edited);
  });

  it("writes jsconfig.json when it is missing, even though the d.ts is already current (#155)", async () => {
    // ⊘ writing jsconfig.json only alongside a d.ts (re)write: deleting it
    // must still bring the bundled copy back on the next run, as the guide says.
    fsState.dirs.add("/workspace/.nexus/scripts");
    fsState.dirs.add("/workspace/.nexus/scripts/types");
    fsState.files.set(
      "/workspace/.nexus/scripts/types/nexus-scripts.d.ts",
      new TextEncoder().encode(BUNDLED_DTS)
    );

    await ensureWorkspaceScriptTypes(scriptsDir("/workspace/.nexus/scripts"), getAssets);

    const jsconfig = new TextDecoder().decode(fsState.files.get("/workspace/.nexus/scripts/jsconfig.json")!);
    expect(jsconfig).toBe(BUNDLED_JSCONFIG);
  });
});
