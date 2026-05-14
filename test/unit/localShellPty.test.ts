import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("vscode", () => {
  class MockEventEmitter<T> {
    private readonly listeners: Array<(event: T) => void> = [];
    public event = (listener: (event: T) => void) => {
      this.listeners.push(listener);
      return { dispose: vi.fn() };
    };
    public fire(event: T): void {
      for (const listener of this.listeners) {
        listener(event);
      }
    }
    public dispose(): void {
      this.listeners.length = 0;
    }
  }
  return {
    EventEmitter: MockEventEmitter,
    Disposable: class {
      public constructor(private readonly fn: () => void) {}
      public dispose(): void {
        this.fn();
      }
    }
  };
});

import { LocalShellPty, type LocalPtySidecarProcess } from "../../src/services/local/localShellPty";

function encode(text: string): string {
  return Buffer.from(text, "utf8").toString("base64");
}

function decodeFrame(line: string): any {
  return JSON.parse(line.trim());
}

class FakeSidecar extends EventEmitter implements LocalPtySidecarProcess {
  public readonly stdout = new EventEmitter();
  public readonly stderr = new EventEmitter();
  public readonly stdin = {
    write: vi.fn((chunk: string) => {
      this.stdinWrites.push(chunk);
      return true;
    })
  };
  public readonly kill = vi.fn();
  public readonly stdinWrites: string[] = [];

  public emitStdout(frame: unknown): void {
    this.stdout.emit("data", Buffer.from(`${JSON.stringify(frame)}\n`, "utf8"));
  }
}

describe("LocalShellPty", () => {
  let sidecar: FakeSidecar;
  let spawnSidecar: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    sidecar = new FakeSidecar();
    spawnSidecar = vi.fn(() => sidecar);
  });

  it("spawns the sidecar, queues startup input until ready, and forwards PTY output to observers", () => {
    const observer = { onOutput: vi.fn(), pauseIntervalMacros: vi.fn(), dispose: vi.fn() };
    const pty = new LocalShellPty({
      sidecarPath: "/ext/dist/native/local-pty/linux-x64/nexus-local-pty",
      shellPath: "/bin/bash",
      shellArgs: ["--login"],
      cwd: "/workspace",
      env: { DEV: "1" },
      terminalName: "Nexus Local Shell: Dev",
      startupCommand: "echo ready",
      spawnSidecar
    });
    const writes: string[] = [];
    pty.onDidWrite((text) => writes.push(text));
    pty.addOutputObserver(observer);

    pty.open({ rows: 24, columns: 80 });

    expect(spawnSidecar).toHaveBeenCalledWith("/ext/dist/native/local-pty/linux-x64/nexus-local-pty");
    expect(decodeFrame(sidecar.stdinWrites[0])).toMatchObject({
      type: "spawn",
      shellPath: "/bin/bash",
      shellArgs: ["--login"],
      cwd: "/workspace",
      env: { DEV: "1" },
      rows: 24,
      cols: 80
    });
    expect(sidecar.stdinWrites).toHaveLength(1);

    sidecar.emitStdout({ type: "ready" });
    expect(decodeFrame(sidecar.stdinWrites[1])).toEqual({
      type: "input",
      data: encode("echo ready\n")
    });

    sidecar.emitStdout({ type: "data", data: encode("Password: ") });

    expect(writes).toEqual(["Password: "]);
    expect(observer.onOutput).toHaveBeenCalledWith("Password: ");
  });

  it("writes user and macro input through the sidecar protocol and forwards resize", () => {
    const pty = new LocalShellPty({
      sidecarPath: "/native/local-pty",
      shellPath: "/bin/zsh",
      shellArgs: [],
      terminalName: "Nexus Local Shell: Zsh",
      spawnSidecar
    });

    pty.open({ rows: 20, columns: 70 });
    sidecar.emitStdout({ type: "ready" });
    pty.handleInput("show version\r");
    pty.writeProgrammatic("macro text\n");
    pty.setDimensions({ rows: 40, columns: 120 });

    expect(decodeFrame(sidecar.stdinWrites[1])).toEqual({
      type: "input",
      data: encode("show version\r")
    });
    expect(decodeFrame(sidecar.stdinWrites[2])).toEqual({
      type: "input",
      data: encode("macro text\n")
    });
    expect(decodeFrame(sidecar.stdinWrites[3])).toEqual({
      type: "resize",
      rows: 40,
      cols: 120
    });
  });

  it("disposes observers and pauses interval macros when the shell exits", () => {
    const observer = { onOutput: vi.fn(), pauseIntervalMacros: vi.fn(), dispose: vi.fn() };
    const pty = new LocalShellPty({
      sidecarPath: "/native/local-pty",
      shellPath: "/bin/bash",
      shellArgs: [],
      terminalName: "Nexus Local Shell: Bash",
      spawnSidecar
    });
    pty.addOutputObserver(observer);

    pty.open({ rows: 24, columns: 80 });
    sidecar.emitStdout({ type: "exit", code: 0 });

    expect(observer.pauseIntervalMacros).toHaveBeenCalledOnce();
    expect(observer.dispose).toHaveBeenCalledOnce();
  });

  it("does not emit duplicate close events when protocol and process exits both arrive", () => {
    const pty = new LocalShellPty({
      sidecarPath: "/native/local-pty",
      shellPath: "/bin/bash",
      shellArgs: [],
      terminalName: "Nexus Local Shell: Bash",
      spawnSidecar
    });
    const closes: Array<number | void> = [];
    pty.onDidClose((code) => closes.push(code));

    pty.open({ rows: 24, columns: 80 });
    sidecar.emitStdout({ type: "exit", code: 0 });
    sidecar.emit("exit", 0, null);

    expect(closes).toEqual([0]);
  });

  it("ignores ready frames that arrive after the shell has already exited", () => {
    const pty = new LocalShellPty({
      sidecarPath: "/native/local-pty",
      shellPath: "/bin/bash",
      shellArgs: [],
      terminalName: "Nexus Local Shell: Bash",
      startupCommand: "echo ready",
      spawnSidecar
    });

    pty.open({ rows: 24, columns: 80 });
    sidecar.emitStdout({ type: "exit", code: 0 });
    sidecar.emitStdout({ type: "ready" });

    expect(sidecar.stdinWrites).toHaveLength(1);
  });

  it("keeps the terminal open and logs details when the sidecar exits before ready", () => {
    const outputChannel = { appendLine: vi.fn() };
    const observer = { onOutput: vi.fn(), pauseIntervalMacros: vi.fn(), dispose: vi.fn() };
    const pty = new LocalShellPty({
      sidecarPath: "C:/ext/dist/native/local-pty/win32-x64/nexus-local-pty.exe",
      shellPath: "powershell.exe",
      shellArgs: [],
      terminalName: "Nexus Local Shell: PowerShell",
      outputChannel,
      spawnSidecar
    });
    const writes: string[] = [];
    const closes: Array<number | void> = [];
    pty.onDidWrite((text) => writes.push(text));
    pty.onDidClose((code) => closes.push(code));
    pty.addOutputObserver(observer);

    pty.open({ rows: 24, columns: 80 });
    sidecar.emit("exit", -1073741515, null);

    expect(closes).toEqual([]);
    expect(writes.join("")).toContain("Local Shell sidecar exited before startup completed");
    expect(writes.join("")).toContain("-1073741515");
    expect(outputChannel.appendLine).toHaveBeenCalledWith(expect.stringContaining("nexus-local-pty.exe"));
    expect(outputChannel.appendLine).toHaveBeenCalledWith(expect.stringContaining("exited before ready"));
    expect(observer.pauseIntervalMacros).toHaveBeenCalledOnce();
    expect(observer.dispose).toHaveBeenCalledOnce();
  });
});
