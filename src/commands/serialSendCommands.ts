import * as vscode from "vscode";
import type { NexusCore } from "../core/nexusCore";
import { isSerialUserInput, type SerialUserInput } from "../services/serial/serialUserInput";
import type { TerminalRegistry } from "../services/terminal/terminalRegistry";
import type { SerialSendPanel } from "../ui/serialSendPanel";
import { isTerminalArg } from "./terminalTabCommands";
import type { SerialTerminalEntry, SerialTerminalMap } from "./types";

interface SerialSendCommandDependencies {
  core: Pick<NexusCore, "getSerialProfile" | "getSnapshot" | "onDidChange">;
  serialTerminals: SerialTerminalMap;
  terminalRegistry?: Pick<TerminalRegistry, "get">;
  panel: Pick<SerialSendPanel, "openOrReveal" | "disposeForSession" | "dispose">;
  onDedicatedSessionsChanged(sessionIds: ReadonlySet<string>): void;
}
interface Target { sessionId: string; entry: SerialTerminalEntry; input: SerialUserInput }
const UNAVAILABLE = "This serial session is no longer available. Reconnect the profile to use its send box.";

/** Owns command targeting and transient view subscriptions for this activation. */
export class SerialSendCommands implements vscode.Disposable {
  private readonly subscriptions: vscode.Disposable[] = [];
  private readonly owners = new Map<string, { entry: SerialTerminalEntry; input: SerialUserInput; subscription: vscode.Disposable }>();
  private readonly opening = new Map<vscode.Terminal, { profileId: string; input: SerialUserInput; subscription: vscode.Disposable }>();
  private readonly closedTerminals = new WeakSet<vscode.Terminal>();
  private disposed = false;

  public constructor(private readonly deps: SerialSendCommandDependencies) {
    this.subscriptions.push(
      vscode.commands.registerCommand("nexus.serial.openSendBox", (...args: unknown[]) => this.run(args, false)),
      vscode.commands.registerCommand("nexus.serial.useDirectInput", (...args: unknown[]) => this.run(args, true)),
      { dispose: deps.core.onDidChange(() => this.reconcile()) },
      vscode.window.onDidCloseTerminal(terminal => {
        this.closedTerminals.add(terminal);
        this.forgetOpening(terminal);
        for (const [id, owner] of this.owners) {
          if (owner.entry.terminal !== terminal) continue;
          this.owners.delete(id);
          owner.subscription.dispose();
          this.deps.panel.disposeForSession(id);
        }
        this.publish();
      })
    );
    this.reconcile();
  }

  /** Standard sessions acquire their real ID only after the driver opens. */
  public trackOpening(profileId: string, terminal: vscode.Terminal, input: SerialUserInput): void {
    this.forgetOpening(terminal);
    if (this.disposed || this.closedTerminals.has(terminal) || input.getInputState().status !== "opening" || !this.deps.core.getSerialProfile(profileId)) return;
    const subscription = input.onDidChangeInputState(state => {
      if (state.status !== "opening") this.forgetOpening(terminal);
    });
    this.opening.set(terminal, { profileId, input, subscription });
  }

  private forgetOpening(terminal: vscode.Terminal): void {
    const pending = this.opening.get(terminal);
    this.opening.delete(terminal);
    pending?.subscription.dispose();
  }

  private target(sessionId: string, entry: SerialTerminalEntry | undefined): Target | undefined {
    return entry?.input ? { sessionId, entry, input: entry.input } : undefined;
  }

  private forTerminal(terminal: vscode.Terminal): Target | undefined {
    for (const [id, entry] of this.deps.serialTerminals) {
      if (entry.terminal === terminal) return this.target(id, entry);
    }
    return undefined;
  }

  private explicitTarget(arg: unknown): Target | undefined {
    if (isTerminalArg(arg)) return this.forTerminal(arg);
    if (typeof arg === "string") {
      const session = this.deps.serialTerminals.get(arg);
      if (session) return this.target(arg, session);
      if (!this.deps.core.getSerialProfile(arg)) return undefined;
      for (const [id, entry] of this.deps.serialTerminals) if (entry.profileId === arg) return this.target(id, entry);
      return undefined;
    }
    if (!arg || typeof arg !== "object") return undefined;
    const node = arg as { session?: { id?: unknown }; profile?: { id?: unknown } };
    if (typeof node.session?.id === "string") return this.target(node.session.id, this.deps.serialTerminals.get(node.session.id));
    if (typeof node.profile?.id === "string") {
      if (!this.deps.core.getSerialProfile(node.profile.id)) return undefined;
      for (const [id, entry] of this.deps.serialTerminals) if (entry.profileId === node.profile.id) return this.target(id, entry);
    }
    return undefined;
  }

  private current(target: Target): boolean {
    return !this.disposed && !this.closedTerminals.has(target.entry.terminal) && this.deps.serialTerminals.get(target.sessionId) === target.entry
      && target.entry.input === target.input && !!this.deps.core.getSerialProfile(target.entry.profileId)
      && this.deps.core.getSnapshot().activeSerialSessions.some(session => session.id === target.sessionId);
  }

  private refuseExplicit(arg: unknown): void {
    const profileId = typeof arg === "string" ? arg : arg && typeof arg === "object" ? (arg as { profile?: { id?: unknown } }).profile?.id : undefined;
    if (typeof profileId === "string" && [...this.opening.values()].some(pending => pending.profileId === profileId && pending.input.getInputState().status === "opening")) {
      void vscode.window.showWarningMessage("This serial port is still opening. Wait for the connection before opening its send box.");
      return;
    }
    if (isTerminalArg(arg)) {
      if (this.closedTerminals.has(arg)) {
        void vscode.window.showWarningMessage(UNAVAILABLE);
        return;
      }
      const pty = this.deps.terminalRegistry?.get(arg)?.pty;
      if (isSerialUserInput(pty)) {
        const state = pty.getInputState();
        void vscode.window.showWarningMessage(state.status === "opening"
          ? "This serial port is still opening. Wait for the connection before opening its send box."
          : UNAVAILABLE);
        return;
      }
      if (![...this.deps.serialTerminals.values()].some(entry => entry.terminal === arg)) {
        void vscode.window.showWarningMessage("Select a Nexus serial terminal to open its send box.");
        return;
      }
    }
    void vscode.window.showWarningMessage(UNAVAILABLE);
  }

  private async select(arg: unknown): Promise<Target | undefined> {
    if (arg !== undefined) {
      const target = this.explicitTarget(arg);
      if (!target) this.refuseExplicit(arg);
      return target;
    }
    const active = vscode.window.activeTerminal;
    if (active) {
      const target = this.forTerminal(active);
      if (target) return target;
      // A disconnected Standard tab must not redirect to a different serial session.
      if (isSerialUserInput(this.deps.terminalRegistry?.get(active)?.pty)) {
        this.refuseExplicit(active);
        return undefined;
      }
    }
    const choices = [...this.deps.serialTerminals].flatMap(([sessionId, entry]) => {
      const target = this.target(sessionId, entry);
      const profile = this.deps.core.getSerialProfile(entry.profileId);
      return target && profile && this.current(target) ? [{ label: profile.name, description: target.input.getInputState().path, target }] : [];
    });
    if (choices.length === 0) {
      const action = await vscode.window.showInformationMessage("Connect a serial profile to open its send box.", "Connect Serial Profile");
      if (!this.disposed && action === "Connect Serial Profile") await vscode.commands.executeCommand("nexus.serial.connect");
      return undefined;
    }
    return (await vscode.window.showQuickPick(choices, { title: "Select Serial Send Box Session" }))?.target;
  }

  private async run(args: readonly unknown[], direct: boolean): Promise<void> {
    // Native terminal menus can marshal a closed clicked terminal to undefined.
    // Retain invocation arity so that target cannot become a palette fallback.
    if (args.length > 0 && args[0] === undefined) {
      this.refuseExplicit(undefined);
      return;
    }
    const target = await this.select(args[0]);
    if (!target) return;
    await this.apply(target, direct);
  }

  private async apply(target: Target, direct: boolean): Promise<void> {
    if (!this.current(target)) { void vscode.window.showWarningMessage(UNAVAILABLE); return; }
    const state = target.input.getInputState();
    if (state.status === "opening" && !target.entry.smartFollow) {
      void vscode.window.showWarningMessage("This serial port is still opening. Wait for the connection before opening its send box.");
      return;
    }
    if (state.status === "closed" || (!target.entry.smartFollow && !state.connected)) {
      void vscode.window.showWarningMessage(UNAVAILABLE); return;
    }
    if (direct) {
      this.deps.panel.disposeForSession(target.sessionId);
      if (target.input.getInputState().dedicatedInputEnabled) target.input.setDedicatedInputEnabled(false);
      target.entry.terminal.show();
      return;
    }
    const profile = this.deps.core.getSerialProfile(target.entry.profileId)!;
    this.deps.panel.openOrReveal({ sessionId: target.sessionId, terminal: target.entry.terminal, input: target.input, profileName: profile.name });
    if (state.inputLocked) {
      const action = await vscode.window.showInformationMessage("A running script owns serial input. Use Stop Script to release input before sending.", "Stop Script");
      if (action === "Stop Script" && this.current(target)) await vscode.commands.executeCommand("nexus.script.stop", target.sessionId);
    } else if (state.status === "waiting") {
      void vscode.window.showInformationMessage("Smart Follow is waiting for the approved port. You can edit the draft; Send becomes available when connected.");
    } else if (state.status === "stopped") {
      void vscode.window.showInformationMessage("Smart Follow has stopped. You can edit the draft; close the terminal and reconnect the profile to send.");
    }
  }

  /** The notification action retains the original session even after focus changes. */
  public async remindNativeInput(terminal: vscode.Terminal, input: SerialUserInput): Promise<void> {
    const target = this.forTerminal(terminal);
    if (!target || target.input !== input || !this.current(target)) return;
    const action = await vscode.window.showInformationMessage("Dedicated send box is enabled for this serial session. Use Open Send Box to type, or Use Direct Input to type in the terminal.", "Open Send Box", "Use Direct Input");
    if (action === "Open Send Box" || action === "Use Direct Input") await this.apply(target, action === "Use Direct Input");
  }

  private publish(): void {
    this.deps.onDedicatedSessionsChanged(new Set([...this.owners].filter(([, owner]) => owner.input.getInputState().dedicatedInputEnabled).map(([id]) => id)));
  }

  private reconcile(): void {
    if (this.disposed) return;
    for (const [terminal, pending] of this.opening) {
      if (!this.deps.core.getSerialProfile(pending.profileId) || pending.input.getInputState().status !== "opening") this.forgetOpening(terminal);
    }
    const liveIds = new Set(this.deps.core.getSnapshot().activeSerialSessions.map(session => session.id));
    for (const [id, owner] of this.owners) {
      if (!liveIds.has(id) || this.deps.serialTerminals.get(id) !== owner.entry || owner.entry.input !== owner.input || !this.deps.core.getSerialProfile(owner.entry.profileId)) {
        this.owners.delete(id);
        owner.subscription.dispose();
        this.deps.panel.disposeForSession(id);
      }
    }
    for (const [id, entry] of this.deps.serialTerminals) {
      if (!this.closedTerminals.has(entry.terminal) && !this.owners.has(id) && liveIds.has(id) && entry.input && this.deps.core.getSerialProfile(entry.profileId)) {
        this.owners.set(id, { entry, input: entry.input, subscription: entry.input.onDidChangeInputState(() => this.publish()) });
      }
    }
    this.publish();
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const subscription of this.subscriptions) subscription.dispose();
    for (const owner of this.owners.values()) owner.subscription.dispose();
    this.owners.clear();
    for (const terminal of this.opening.keys()) this.forgetOpening(terminal);
    this.deps.panel.dispose();
    this.publish();
  }
}
