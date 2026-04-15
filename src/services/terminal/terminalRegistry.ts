import * as vscode from "vscode";
import type { ActiveSerialSession, ActiveSession, SessionPtyHandle } from "../../models/config";
import type { PtyOutputObserver } from "../macroAutoTrigger";
import { TerminalCaptureBuffer } from "./terminalCaptureBuffer";

export const CONTEXT_KEY_IS_NEXUS = "nexus.isNexusTerminal";
export const CONTEXT_KEY_IS_CONNECTED = "nexus.isNexusTerminalConnected";

export interface RegistryEntry {
  pty: SessionPtyHandle;
  buffer: TerminalCaptureBuffer;
}

interface InternalEntry extends RegistryEntry {
  observerDisposable: vscode.Disposable;
}

interface CoreSnapshotLike {
  activeSessions: ReadonlyArray<Pick<ActiveSession, "pty">>;
  activeSerialSessions: ReadonlyArray<Pick<ActiveSerialSession, "pty">>;
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
    this.entries.set(terminal, { pty, buffer, observerDisposable });
    this.refreshContextKeys();
  }

  public get(terminal: vscode.Terminal | undefined): RegistryEntry | undefined {
    if (!terminal) return undefined;
    return this.entries.get(terminal);
  }

  public unregister(terminal: vscode.Terminal): void {
    const entry = this.entries.get(terminal);
    if (!entry) return;
    entry.observerDisposable.dispose();
    entry.buffer.dispose();
    this.entries.delete(terminal);
    this.refreshContextKeys();
  }

  public isConnected(entry: RegistryEntry): boolean {
    const snap = this.core.getSnapshot();
    for (const s of snap.activeSessions) {
      if (s.pty === entry.pty) return true;
    }
    for (const s of snap.activeSerialSessions) {
      if (s.pty === entry.pty) return true;
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
