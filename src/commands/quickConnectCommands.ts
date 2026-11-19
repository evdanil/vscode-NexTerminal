import { randomUUID } from "node:crypto";
import { isIP } from "node:net";
import { domainToASCII } from "node:url";
import * as vscode from "vscode";
import type { SerialProfile, ServerConfig, ServerProtocol } from "../models/config";
import type { SerialPty } from "../services/serial/serialPty";
import type { ContextAwareSshFactory } from "../services/ssh/contracts";
import { SshPty } from "../services/ssh/sshPty";
import { TelnetPty } from "../services/telnet/telnetPty";
import type { SessionHighlightHandle } from "../services/terminal/highlightProfileService";
import { quickConnectSerialFormDefinition } from "../ui/formDefinitions";
import { WebviewFormPanel } from "../ui/webviewFormPanel";
import { openQuickConnectProfileForm } from "./profileCommands";
import { createSerialTerminal, createStandardSerialPty, formValuesToSerial, scanForPort, serialPortInUseMessage } from "./serialCommands";
import { createNetworkDeviceTerminal, createServerSessionTranscript } from "./serverCommands";
import { isTerminalArg } from "./terminalTabCommands";
import type { CommandContext } from "./types";

export const QUICK_CONNECT_COMMAND = "nexus.server.quickConnect";
const SAVE_PROFILE_COMMAND = "nexus.server.saveQuickConnectProfile";
const HAS_SAVABLE_CONTEXT = "nexus.quickConnectHasSavableTerminal";
const ADDRESS_ERROR = "Enter a host, user@host, user@host:port, or telnet://host.";
const QUICK_CONNECT_TYPES = [
  { label: "SSH", description: "Connect to an SSH host", type: "ssh" },
  { label: "Telnet", description: "Connect to a Telnet host", type: "telnet" },
  { label: "Serial", description: "Open a serial port", type: "serial" }
] as const;

interface QuickConnectAddress {
  protocol: ServerProtocol;
  host: string;
  port: number;
  username?: string;
}

interface QuickConnectRequest extends QuickConnectAddress {
  legacyAlgorithms: boolean;
}

function validUsername(value: string): boolean {
  return value.length > 0 && !/[\s\p{C}:@/\\?#%]/u.test(value);
}

export function parseQuickConnectAddress(value: string, defaultProtocol: ServerProtocol = "ssh"): QuickConnectAddress {
  const address = value.trim();
  if (!address || /[\s\p{C}\\?#%]/u.test(address)) throw new Error(ADDRESS_ERROR);
  const scheme = /^(ssh|telnet):\/\//i.exec(address)?.[0];
  const protocol = scheme ? (scheme.toLowerCase() === "telnet://" ? "telnet" : "ssh") : defaultProtocol;
  let endpoint = scheme ? address.slice(scheme.length) : address;
  let username: string | undefined;
  const at = endpoint.indexOf("@");
  if (at >= 0) {
    username = endpoint.slice(0, at);
    endpoint = endpoint.slice(at + 1);
    if (protocol === "telnet" || !validUsername(username)) throw new Error(ADDRESS_ERROR);
  }
  const bracketed = /^\[([^\]]+)\](?::(\d+))?$/.exec(endpoint);
  const plain = /^([^:]+)(?::(\d+))?$/.exec(endpoint);
  let host: string;
  let portText: string | undefined;
  if (bracketed && isIP(bracketed[1]) === 6) {
    [, host, portText] = bracketed;
  } else if (isIP(endpoint) === 6) {
    host = endpoint;
  } else if (plain) {
    // Reject URL delimiters before IDNA processing, which can interpret them.
    if (!/^[\p{L}\p{M}\p{N}._-]+$/u.test(plain[1])) throw new Error(ADDRESS_ERROR);
    host = /^[\x00-\x7f]+$/.test(plain[1]) ? plain[1] : domainToASCII(plain[1]);
    if (!host || !/^[a-z\d_.-]+$/i.test(host)) throw new Error(ADDRESS_ERROR);
    portText = plain[2];
  } else {
    throw new Error(ADDRESS_ERROR);
  }
  const port = portText === undefined ? (protocol === "telnet" ? 23 : 22) : Number(portText);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(ADDRESS_ERROR);
  return { protocol, host: host.toLowerCase(), port, ...(username !== undefined && { username }) };
}

function formatAddress({ protocol, host, port }: QuickConnectAddress): string {
  const endpoint = isIP(host) === 6 ? `[${host}]` : host;
  return port === (protocol === "ssh" ? 22 : 23) ? endpoint : `${endpoint}:${port}`;
}

function readAddress(
  input: vscode.InputBox,
  protocol: ServerProtocol,
  legacy: boolean
): Promise<QuickConnectRequest | "back" | undefined> {
  const enableLegacy = { iconPath: new vscode.ThemeIcon("shield"), tooltip: "Enable legacy SSH algorithms" };
  const disableLegacy = { iconPath: new vscode.ThemeIcon("warning"), tooltip: "Disable legacy SSH algorithms" };
  let previousAddress = "";
  let target: QuickConnectAddress | undefined;

  function renderAddress(): void {
    const telnet = protocol === "telnet";
    input.title = telnet ? "Quick Connect · Telnet" : "Quick Connect · SSH";
    input.placeholder = telnet ? "host or host:port" : "host or user@host:port";
    input.prompt = legacy && !telnet ? "Legacy SSH algorithms enabled." : `Enter a ${telnet ? "Telnet" : "SSH"} address.`;
    input.buttons = telnet ? [vscode.QuickInputButtons.Back] : [vscode.QuickInputButtons.Back, legacy ? disableLegacy : enableLegacy];
  }

  return new Promise(resolve => {
    input.onDidChangeValue(() => {
      input.validationMessage = undefined;
      if (!target) renderAddress();
    });
    input.onDidTriggerButton(button => {
      if (button === vscode.QuickInputButtons.Back) {
        if (!target) {
          resolve("back");
          return;
        }
        target = undefined;
        input.value = previousAddress;
        input.validationMessage = undefined;
        renderAddress();
      } else if (!target && (button === enableLegacy || button === disableLegacy)) {
        legacy = button === enableLegacy;
        renderAddress();
      }
    });
    input.onDidAccept(() => {
      if (target) {
        const username = input.value.trim();
        if (!validUsername(username)) {
          input.validationMessage = "Enter an SSH username.";
          return;
        }
        resolve({ ...target, username, legacyAlgorithms: legacy });
        return;
      }
      let address: QuickConnectAddress;
      try {
        address = parseQuickConnectAddress(input.value, protocol);
      } catch {
        input.validationMessage = protocol === "telnet"
          ? "Enter a Telnet host or host:port."
          : "Enter an SSH host, user@host, or user@host:port.";
        return;
      }
      if (address.protocol !== protocol) {
        input.validationMessage = "Use Back to choose the protocol in the address.";
        return;
      }
      if (address.protocol === "ssh" && !address.username) {
        previousAddress = input.value;
        target = address;
        input.value = "";
        input.placeholder = "SSH username";
        input.prompt = `Enter the username for ${address.host}.${legacy ? " Legacy SSH algorithms enabled." : ""}`;
        input.buttons = [vscode.QuickInputButtons.Back];
        return;
      }
      resolve({ ...address, legacyAlgorithms: address.protocol === "ssh" && legacy });
    });
    input.onDidHide(() => resolve(undefined));
    renderAddress();
    input.show();
  });
}

interface QuickSession {
  profile: ServerConfig | SerialProfile;
  pty: SshPty | TelnetPty | SerialPty;
  abort?: AbortController;
  connected: boolean;
  opened: boolean;
  saved: boolean;
}

export class QuickConnectCommands implements vscode.Disposable {
  private readonly sessions = new Map<vscode.Terminal, QuickSession>();
  private readonly subscriptions: vscode.Disposable[];
  private protocolPick?: vscode.CancellationTokenSource;
  private input?: vscode.InputBox;
  private serialForm?: WebviewFormPanel;
  private disposed = false;
  private lastHasSavable?: boolean;
  private resetGeneration = 0;

  public constructor(private readonly ctx: CommandContext, private readonly sshFactory: ContextAwareSshFactory) {
    this.subscriptions = [
      vscode.commands.registerCommand(QUICK_CONNECT_COMMAND, () => this.connect()),
      vscode.commands.registerCommand(SAVE_PROFILE_COMMAND, (...args: unknown[]) => this.save(args)),
      vscode.window.onDidCloseTerminal(terminal => this.close(terminal))
    ];
    this.refreshContext();
  }

  private async pickProtocol(): Promise<(typeof QUICK_CONNECT_TYPES)[number]["type"] | undefined> {
    const cancellation = new vscode.CancellationTokenSource();
    this.protocolPick = cancellation;
    try {
      const item = await vscode.window.showQuickPick(QUICK_CONNECT_TYPES, {
        title: "Quick Connect",
        placeHolder: "Choose how to connect"
      }, cancellation.token);
      return item?.type;
    } finally {
      this.protocolPick = undefined;
      cancellation.dispose();
    }
  }

  private async connect(retry?: QuickConnectRequest): Promise<void> {
    if (this.disposed || this.protocolPick) return;
    if (this.input) {
      this.input.show();
      return;
    }
    const generation = this.resetGeneration;
    const protocol = retry?.protocol ?? await this.pickProtocol();
    if (!protocol || this.disposed || generation !== this.resetGeneration) return;
    if (protocol === "serial") {
      this.serialForm = WebviewFormPanel.open("quick-connect-serial", quickConnectSerialFormDefinition(), {
        onScan: () => scanForPort(this.ctx),
        onSubmit: values => {
          if (this.disposed || generation !== this.resetGeneration) return;
          const profile = formValuesToSerial({ ...values, name: values.path, mode: "standard" });
          if (!profile) throw new Error("Enter a serial port path or select one with Scan.");
          this.launchSerial(profile);
        }
      });
      return;
    }
    const input = vscode.window.createInputBox();
    if (retry) {
      const prefix = retry.protocol === "telnet" ? "telnet://" : retry.username ? `${retry.username}@` : "";
      input.value = `${prefix}${formatAddress(retry)}`;
    }
    this.input = input;
    let request: QuickConnectRequest | "back" | undefined;
    try {
      request = await readAddress(input, protocol, retry?.legacyAlgorithms ?? false);
    } finally {
      this.input = undefined;
      input.dispose();
    }
    if (!request || this.disposed || generation !== this.resetGeneration) return;
    if (request === "back") return this.connect();
    this.launch(request);
  }

  private launchSerial(profile: SerialProfile): void {
    const conflict = serialPortInUseMessage(this.ctx, profile.path);
    if (conflict) throw new Error(conflict);
    const highlight = this.ctx.highlightProfileService?.createSession();
    let terminal: vscode.Terminal | undefined;
    const pty = createStandardSerialPty(this.ctx, profile, {
      onSessionOpened: () => this.setConnected(terminal, true),
      onSessionClosed: () => this.setConnected(terminal, false)
    }, highlight);
    try {
      terminal = createSerialTerminal(profile, pty);
    } catch (error) {
      pty.dispose();
      highlight?.dispose();
      throw error;
    }
    this.track(terminal, profile, pty, highlight);
  }

  private launch(request: QuickConnectRequest): void {
    const { protocol, host, port, username, legacyAlgorithms } = request;
    const address = formatAddress(request);
    const name = username ? `${username}@${address}` : address;
    const server: ServerConfig = {
      id: `quick-${randomUUID()}`, name, protocol, host, port, username: username ?? "",
      authType: "password", isHidden: false, ...(legacyAlgorithms && { legacyAlgorithms: true })
    };
    const title = `Nexus ${protocol === "ssh" ? "SSH" : "Telnet"}: ${name}`;
    const abort = new AbortController();
    const generation = this.resetGeneration;
    let terminal: vscode.Terminal | undefined;
    const callbacks = {
      onSessionOpened: () => this.setConnected(terminal, true),
      onDisconnected: () => this.setConnected(terminal, false),
      onSessionClosed: () => { if (terminal) this.close(terminal); },
      onConnectFailed: (_sessionId: string, message: string): boolean => {
        const edit = "Edit Address…";
        void vscode.window.showErrorMessage(`${title}: Connection failed. ${message}`, edit).then(choice => {
          if (choice === edit && generation === this.resetGeneration) {
            return this.connect(request);
          }
        });
        return true;
      }
    };
    const scopedSshFactory: ContextAwareSshFactory = {
      connect: config => this.sshFactory.connectWithContext(config, { signal: abort.signal }),
      connectWithContext: (config, context) => this.sshFactory.connectWithContext(config, { ...context, signal: abort.signal })
    };
    const terminalType = vscode.workspace.getConfiguration("nexus.ssh").get("terminalType", "xterm-256color");
    const logger = this.ctx.loggerFactory.create("terminal", server.id);
    const transcript = createServerSessionTranscript(this.ctx, server);
    const registry = this.ctx.terminalRegistry;
    const highlight = registry ? this.ctx.highlightProfileService?.createSession() : undefined;
    const highlighter = highlight ?? this.ctx.highlighter;
    const pty = protocol === "ssh"
      ? new SshPty(server, scopedSshFactory, callbacks, logger, transcript, highlighter, undefined, terminalType)
      : new TelnetPty(server, callbacks, logger, { transcript, highlighter, terminalType });
    try {
      terminal = createNetworkDeviceTerminal(title, pty);
    } catch (error) {
      pty.dispose();
      highlight?.dispose();
      throw error;
    }
    this.track(terminal, server, pty, highlight, abort);
  }

  private track(
    terminal: vscode.Terminal,
    profile: QuickSession["profile"],
    pty: QuickSession["pty"],
    highlight?: SessionHighlightHandle,
    abort?: AbortController
  ): void {
    const session: QuickSession = { profile, pty, abort, connected: false, opened: false, saved: false };
    this.sessions.set(terminal, session);
    this.ctx.terminalRegistry?.register(terminal, pty, highlight, () => session.connected);
    terminal.show();
  }

  private setConnected(terminal: vscode.Terminal | undefined, connected: boolean): void {
    const session = terminal && this.sessions.get(terminal);
    if (!session) return;
    session.connected = connected;
    session.opened ||= connected;
    this.refreshContext();
    this.ctx.terminalRegistry?.refreshContextKeys();
  }

  private async pickSaveTarget(): Promise<vscode.Terminal | undefined> {
    const active = vscode.window.activeTerminal;
    const session = active && this.sessions.get(active);
    if (session?.opened && !session.saved) return active;
    const choices = [...this.sessions].filter(([, candidate]) => candidate.opened && !candidate.saved);
    if (choices.length === 0) {
      const open = "Quick Connect";
      const action = await vscode.window.showInformationMessage(
        "Open a Quick Connect terminal and let it connect before saving it as a profile.", open
      );
      if (action === open) await this.connect();
      return undefined;
    }
    const pick = await vscode.window.showQuickPick(choices.map(([terminal, { profile, connected }]) => ({
      label: "path" in profile ? `Serial: ${profile.path}` : `${profile.protocol === "telnet" ? "Telnet" : "SSH"}: ${profile.name}`,
      description: connected ? "Connected" : "Disconnected",
      terminal
    })), { title: "Save Quick Connect as Profile", placeHolder: "Choose the terminal to save" });
    return pick?.terminal;
  }

  private async save(args: unknown[]): Promise<void> {
    const [arg, selection] = args;
    const terminal = args.length === 0 ? await this.pickSaveTarget()
      : isTerminalArg(arg) && (selection === undefined ||
        (Array.isArray(selection) && selection.length === 1 && selection[0] === arg)) ? arg : undefined;
    const session = terminal && this.sessions.get(terminal);
    if (!terminal || !session || !session.opened || session.saved) {
      if (terminal || args.length > 0) {
        void vscode.window.showInformationMessage("Choose an unsaved Quick Connect terminal that has connected at least once.");
      }
      return;
    }
    const isAvailable = (): boolean => this.sessions.get(terminal) === session && !session.saved;
    openQuickConnectProfileForm(this.ctx, session.profile, isAvailable, () => {
      session.saved = true;
      this.refreshContext();
    });
  }

  private refreshContext(): void {
    // Native terminal menus can target a different terminal from the one
    // currently focused. The command checks the exact target before saving.
    const hasSavable = [...this.sessions.values()].some(entry => entry.opened && !entry.saved);
    if (this.lastHasSavable !== hasSavable) {
      this.lastHasSavable = hasSavable;
      void vscode.commands.executeCommand("setContext", HAS_SAVABLE_CONTEXT, hasSavable);
    }
  }

  private close(terminal: vscode.Terminal): void {
    const session = this.sessions.get(terminal);
    if (!session) return;
    this.sessions.delete(terminal);
    session.abort?.abort();
    this.ctx.terminalRegistry?.unregister(terminal);
    session.pty.dispose();
    this.refreshContext();
  }

  public listSerialPortOwners(): Array<{ path: string; terminal: vscode.Terminal }> {
    const owners: Array<{ path: string; terminal: vscode.Terminal }> = [];
    for (const [terminal, { pty, profile }] of this.sessions) {
      if (!("path" in profile) || !("getInputState" in pty)) continue;
      const { status } = pty.getInputState();
      if (status === "connected" || status === "opening") {
        owners.push({ path: profile.path, terminal });
      }
    }
    return owners;
  }

  public closeAll(): void {
    this.resetGeneration++;
    this.protocolPick?.cancel();
    this.input?.hide();
    this.serialForm?.dispose();
    for (const terminal of this.sessions.keys()) {
      this.close(terminal);
      terminal.dispose();
    }
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.protocolPick?.cancel();
    this.input?.hide();
    this.serialForm?.dispose();
    for (const [terminal, session] of this.sessions) {
      // Serial disposal releases the port. Its shutdown banner clears the
      // transport handle ahead of the sidecar's process-wide shutdown.
      if (!("path" in session.profile)) {
        session.pty.markShuttingDown("Nexus extension is shutting down. This session has been closed.");
      }
      this.close(terminal);
    }
    for (const subscription of this.subscriptions) subscription.dispose();
  }
}
