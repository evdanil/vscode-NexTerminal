import { randomUUID } from "node:crypto";
import { isIP } from "node:net";
import { domainToASCII } from "node:url";
import * as vscode from "vscode";
import type { ServerConfig, ServerProtocol } from "../models/config";
import type { ContextAwareSshFactory } from "../services/ssh/contracts";
import { SshPty } from "../services/ssh/sshPty";
import { TelnetPty } from "../services/telnet/telnetPty";
import { openQuickConnectProfileForm } from "./profileCommands";
import { createNetworkDeviceTerminal, createServerSessionTranscript } from "./serverCommands";
import { isTerminalArg } from "./terminalTabCommands";
import type { CommandContext } from "./types";

export const QUICK_CONNECT_COMMAND = "nexus.server.quickConnect";
const SAVE_PROFILE_COMMAND = "nexus.server.saveQuickConnectProfile";
const CAN_SAVE_CONTEXT = "nexus.quickConnectCanSave";
const HAS_SAVABLE_CONTEXT = "nexus.quickConnectHasSavableTerminal";
const ADDRESS_ERROR = "Enter a host, user@host, user@host:port, or telnet://host.";

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

export function parseQuickConnectAddress(value: string): QuickConnectAddress {
  const address = value.trim();
  if (!address || /[\s\p{C}\\?#%]/u.test(address)) throw new Error(ADDRESS_ERROR);
  const scheme = /^(ssh|telnet):\/\//i.exec(address)?.[0];
  const protocol = scheme?.toLowerCase() === "telnet://" ? "telnet" : "ssh";
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

function readAddress(input: vscode.InputBox, legacy: boolean): Promise<QuickConnectRequest | undefined> {
  const enableLegacy = { iconPath: new vscode.ThemeIcon("shield"), tooltip: "Enable legacy SSH algorithms" };
  const disableLegacy = { iconPath: new vscode.ThemeIcon("warning"), tooltip: "Disable legacy SSH algorithms" };
  let previousAddress = "";
  let target: QuickConnectAddress | undefined;

  function renderAddress(): void {
    const telnet = /^telnet:\/\//i.test(input.value.trim());
    input.title = "Nexus: Quick Connect";
    input.placeholder = "user@host, user@host:2222, or telnet://host";
    input.prompt = legacy && !telnet ? "Legacy SSH algorithms enabled." : "Enter an SSH or Telnet address.";
    input.buttons = telnet ? [] : [legacy ? disableLegacy : enableLegacy];
  }

  return new Promise(resolve => {
    input.onDidChangeValue(() => {
      input.validationMessage = undefined;
      if (!target) renderAddress();
    });
    input.onDidTriggerButton(button => {
      if (button === vscode.QuickInputButtons.Back) {
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
        address = parseQuickConnectAddress(input.value);
      } catch {
        input.validationMessage = ADDRESS_ERROR;
        return;
      }
      if (address.protocol === "ssh" && !address.username) {
        previousAddress = input.value;
        target = address;
        input.value = "";
        input.title = "Nexus: Quick Connect";
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
  server: ServerConfig;
  pty: SshPty | TelnetPty;
  abort: AbortController;
  connected: boolean;
  opened: boolean;
  saved: boolean;
}

export class QuickConnectCommands implements vscode.Disposable {
  private readonly sessions = new Map<vscode.Terminal, QuickSession>();
  private readonly subscriptions: vscode.Disposable[];
  private input?: vscode.InputBox;
  private disposed = false;
  private lastCanSave?: boolean;
  private lastHasSavable?: boolean;
  private resetGeneration = 0;

  public constructor(private readonly ctx: CommandContext, private readonly sshFactory: ContextAwareSshFactory) {
    this.subscriptions = [
      vscode.commands.registerCommand(QUICK_CONNECT_COMMAND, () => this.connect()),
      vscode.commands.registerCommand(SAVE_PROFILE_COMMAND, (...args: unknown[]) => this.save(args)),
      vscode.window.onDidChangeActiveTerminal(() => this.refreshContext()),
      vscode.window.onDidCloseTerminal(terminal => this.close(terminal))
    ];
    this.refreshContext();
  }

  private async connect(retry?: QuickConnectRequest): Promise<void> {
    if (this.disposed) return;
    if (this.input) {
      this.input.show();
      return;
    }
    const input = vscode.window.createInputBox();
    if (retry) {
      const prefix = retry.protocol === "telnet" ? "telnet://" : retry.username ? `${retry.username}@` : "";
      input.value = `${prefix}${formatAddress(retry)}`;
    }
    this.input = input;
    let request: QuickConnectRequest | undefined;
    try {
      request = await readAddress(input, retry?.legacyAlgorithms ?? false);
    } finally {
      this.input = undefined;
      input.dispose();
    }
    if (request && !this.disposed) this.launch(request);
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
    const setConnected = (connected: boolean): void => {
      const session = terminal && this.sessions.get(terminal);
      if (!session) return;
      session.connected = connected;
      session.opened ||= connected;
      this.refreshContext();
      this.ctx.terminalRegistry?.refreshContextKeys();
    };
    const callbacks = {
      onSessionOpened: () => setConnected(true),
      onDisconnected: () => setConnected(false),
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
    const session: QuickSession = { server, pty, abort, connected: false, opened: false, saved: false };
    this.sessions.set(terminal, session);
    registry?.register(terminal, pty, highlight, () => session.connected);
    terminal.show();
  }

  private save(args: unknown[]): void {
    const [arg, selection] = args;
    const terminal = args.length === 0 ? vscode.window.activeTerminal
      : isTerminalArg(arg) && (selection === undefined ||
        (Array.isArray(selection) && selection.length === 1 && selection[0] === arg)) ? arg : undefined;
    const session = terminal && this.sessions.get(terminal);
    if (!terminal || !session || !session.opened || session.saved) {
      void vscode.window.showInformationMessage("Choose an unsaved Quick Connect terminal that has connected at least once.");
      return;
    }
    const isAvailable = (): boolean => this.sessions.get(terminal) === session && !session.saved;
    openQuickConnectProfileForm(this.ctx, session.server, isAvailable, () => {
      session.saved = true;
      this.refreshContext();
    });
  }

  private refreshContext(): void {
    const active = vscode.window.activeTerminal;
    const session = active && this.sessions.get(active);
    const canSave = session?.opened === true && !session.saved;
    if (this.lastCanSave !== canSave) {
      this.lastCanSave = canSave;
      void vscode.commands.executeCommand("setContext", CAN_SAVE_CONTEXT, canSave);
    }
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
    session.abort.abort();
    this.ctx.terminalRegistry?.unregister(terminal);
    session.pty.dispose();
    this.refreshContext();
  }

  public closeAll(): void {
    this.resetGeneration++;
    this.input?.hide();
    for (const terminal of this.sessions.keys()) {
      this.close(terminal);
      terminal.dispose();
    }
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.input?.hide();
    for (const [terminal, session] of this.sessions) {
      session.pty.markShuttingDown("Nexus extension is shutting down. This session has been closed.");
      this.close(terminal);
    }
    for (const subscription of this.subscriptions) subscription.dispose();
  }
}
