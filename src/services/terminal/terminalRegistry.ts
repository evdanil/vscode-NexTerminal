import * as vscode from "vscode";
import type { ActiveLocalShellSession, ActiveSerialSession, ActiveSession, SessionPtyHandle } from "../../models/config";
import type { ActiveLocalServerSession } from "../../models/localServer";
import type { PtyOutputObserver } from "../macroAutoTrigger";
import { TerminalCaptureBuffer } from "./terminalCaptureBuffer";

export const CONTEXT_KEY_IS_NEXUS = "nexus.isNexusTerminal";
export const CONTEXT_KEY_IS_CONNECTED = "nexus.isNexusTerminalConnected";

export interface RegistryEntry {
  terminal: vscode.Terminal;
  pty: SessionPtyHandle;
  buffer: TerminalCaptureBuffer;
}

interface InternalEntry extends RegistryEntry {
  observerDisposable: vscode.Disposable;
}

interface CoreSnapshotLike {
  activeSessions: ReadonlyArray<Pick<ActiveSession, "pty">>;
  activeSerialSessions: ReadonlyArray<Pick<ActiveSerialSession, "pty" | "status">>;
  activeLocalShellSessions: ReadonlyArray<Pick<ActiveLocalShellSession, "pty">>;
  activeLocalServerSessions: ReadonlyArray<Pick<ActiveLocalServerSession, "pty">>;
}

export interface NexusCoreLike {
  getSnapshot(): CoreSnapshotLike;
  onDidChange(listener: () => void): () => void;
}

export class TerminalRegistry implements vscode.Disposable {
  private readonly entries = new Map<vscode.Terminal, InternalEntry>();
  private readonly subscriptions: vscode.Disposable[] = [];
  private lastIsNexus?: boolean;
  private lastIsConnected?: boolean;
  private disposed = false;

  public constructor(private readonly core: NexusCoreLike) {
    this.subscriptions.push(
      vscode.window.onDidChangeActiveTerminal(() => this.refreshContextKeys())
    );
    this.subscriptions.push(
      vscode.window.onDidCloseTerminal((t) => this.unregister(t))
    );
    const off = core.onDidChange(() => this.refreshContextKeys());
    this.subscriptions.push({ dispose: off });
    this.refreshContextKeys();
  }

  public register(terminal: vscode.Terminal, pty: SessionPtyHandle): void {
    if (this.disposed || this.entries.has(terminal)) return;
    const buffer = new TerminalCaptureBuffer();
    const observer: PtyOutputObserver = {
      onOutput: (text) => buffer.append(text),
      pauseIntervalMacros: () => {},
      dispose: () => {}
    };
    const observerDisposable = pty.addOutputObserver(observer);
    this.entries.set(terminal, { terminal, pty, buffer, observerDisposable });
    this.refreshContextKeys();
  }

  public get(terminal: vscode.Terminal | undefined): RegistryEntry | undefined {
    if (!terminal) return undefined;
    return this.entries.get(terminal);
  }

  public unregister(terminal: vscode.Terminal): void {
    const entry = this.entries.get(terminal);
    if (!entry) return;
    try {
      entry.observerDisposable.dispose();
      entry.buffer.dispose();
    } finally {
      this.entries.delete(terminal);
      this.refreshContextKeys();
    }
  }

  public isConnected(entry: RegistryEntry): boolean {
    const snap = this.core.getSnapshot();
    for (const s of snap.activeSessions) {
      if (s.pty === entry.pty) return true;
    }
    for (const s of snap.activeSerialSessions) {
      if (s.pty === entry.pty && s.status !== "waiting") return true;
    }
    for (const s of snap.activeLocalShellSessions) {
      if (s.pty === entry.pty) return true;
    }
    // No status exclusion here, unlike the serial branch above. Smart Follow
    // registers a serial session while it is still "waiting" for a port to
    // appear, and leaving it in would enable Reset/Clear on a tab that may
    // never get a transport at all.
    //
    // A local server session does have pty-without-transport windows — the
    // claim that it does not was simply wrong. registerLocalServerSession()
    // runs immediately after createTerminal(), while the child process is only
    // spawned inside LocalShellPty.open(), which VS Code calls on attach; and a
    // session sits registered in "stopping" for up to the stop grace window
    // while its transport is being torn down. What makes the filter
    // unnecessary is the consequence, not the absence of the window: the two
    // commands this key gates are transport-free. Reset writes an escape
    // sequence to the local writeEmitter and Clear Scrollback empties a local
    // buffer — neither touches the child, so both are harmless before it exists
    // and after it is gone. A spawn that fails closes the terminal
    // (onDidTerminateEarly), which unregisters the entry outright.
    //
    // The genuinely transient states are torn straight back out:
    // handleExit() writes "failed" or "restarting" and calls cleanupSession()
    // on the next line.
    for (const s of snap.activeLocalServerSessions) {
      if (s.pty && s.pty === entry.pty) return true;
    }
    return false;
  }

  public refreshContextKeys(): void {
    const active = vscode.window.activeTerminal;
    const entry = this.get(active);
    const isNexus = entry !== undefined;
    const isConnected = isNexus && this.isConnected(entry);
    if (this.lastIsNexus !== isNexus) {
      void vscode.commands.executeCommand("setContext", CONTEXT_KEY_IS_NEXUS, isNexus);
      this.lastIsNexus = isNexus;
    }
    if (this.lastIsConnected !== isConnected) {
      void vscode.commands.executeCommand("setContext", CONTEXT_KEY_IS_CONNECTED, isConnected);
      this.lastIsConnected = isConnected;
    }
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const entry of this.entries.values()) {
      entry.observerDisposable.dispose();
      entry.buffer.dispose();
    }
    this.entries.clear();
    for (const sub of this.subscriptions) {
      try {
        sub.dispose();
      } catch {
        /* tolerate misbehaving disposable */
      }
    }
    this.subscriptions.length = 0;
  }
}
