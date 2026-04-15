import { describe, expect, it, vi } from "vitest";

vi.mock("vscode", () => ({
  EventEmitter: class MockEventEmitter<T> {
    private listeners = new Set<(v: T) => void>();
    public readonly event = (l: (v: T) => void) => {
      this.listeners.add(l);
      return { dispose: () => this.listeners.delete(l) };
    };
    public fire(v?: T): void {
      for (const l of this.listeners) l(v as T);
    }
    public dispose(): void {
      this.listeners.clear();
    }
  },
  CodeLens: class {
    public command?: { title: string; command: string; arguments?: unknown[] };
    public constructor(public readonly range: unknown) {}
  },
  Range: class {
    public constructor(
      public readonly startLine: number,
      public readonly startChar: number,
      public readonly endLine: number,
      public readonly endChar: number
    ) {}
  },
  Position: class {
    public constructor(public readonly line: number, public readonly character: number) {}
  }
}));

import { ScriptCodeLensProvider } from "../../../src/ui/scriptCodeLensProvider";
import type { ScriptRuntimeManager } from "../../../src/services/scripts/scriptRuntimeManager";

function makeDoc(text: string, fsPath = "/workspace/script.js"): {
  getText: () => string;
  uri: { fsPath: string; toString: () => string };
} {
  return {
    getText: () => text,
    uri: { fsPath, toString: () => fsPath }
  };
}

function makeManager(runningPaths: string[] = []): ScriptRuntimeManager {
  return {
    getRuns: vi.fn(() =>
      runningPaths.map((p) => ({
        id: "id-" + p,
        scriptName: "r",
        scriptPath: p,
        sessionId: "s-" + p,
        sessionName: "sess",
        sessionType: "ssh" as const,
        startedAt: 0,
        state: "running" as const,
        currentOperation: null
      }))
    ),
    onDidChangeRun: Object.assign(
      (_l: () => void) => ({ dispose: () => {} }),
      {}
    ) as unknown as ScriptRuntimeManager["onDidChangeRun"]
  } as unknown as ScriptRuntimeManager;
}

describe("ScriptCodeLensProvider", () => {
  it("returns a ▶ Run lens for files containing @nexus-script in the leading JSDoc", () => {
    const p = new ScriptCodeLensProvider(makeManager());
    const doc = makeDoc("/**\n * @nexus-script\n */\nawait expect('x');\n");
    const lenses = p.provideCodeLenses(doc as never);
    expect(lenses).toHaveLength(1);
    expect(lenses![0].command?.title).toMatch(/Run/);
    expect(lenses![0].command?.command).toBe("nexus.script.run");
  });

  it("returns no lens when the file lacks @nexus-script", () => {
    const p = new ScriptCodeLensProvider(makeManager());
    const doc = makeDoc("/**\n * Just a comment\n */\nconsole.log('hi');\n");
    const lenses = p.provideCodeLenses(doc as never);
    expect(lenses).toHaveLength(0);
  });

  it("returns a ◼ Stop lens when a run is active on this file", () => {
    const path = "/workspace/hello.js";
    const p = new ScriptCodeLensProvider(makeManager([path]));
    const doc = makeDoc("/**\n * @nexus-script\n */\n", path);
    const lenses = p.provideCodeLenses(doc as never);
    expect(lenses).toHaveLength(1);
    expect(lenses![0].command?.title).toMatch(/Stop/);
    expect(lenses![0].command?.command).toBe("nexus.script.stop");
  });

  it("does not offer a Run lens on files where the marker appears after the first executable statement", () => {
    const p = new ScriptCodeLensProvider(makeManager());
    const doc = makeDoc("const x = 1;\n/**\n * @nexus-script\n */\n");
    const lenses = p.provideCodeLenses(doc as never);
    expect(lenses).toHaveLength(0);
  });
});
