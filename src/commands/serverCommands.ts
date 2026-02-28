import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import type { AuthType, ProxyConfig, ServerConfig } from "../models/config";
import { createSessionTranscript } from "../logging/sessionTranscriptLogger";
import { SshPty } from "../services/ssh/sshPty";
import { passphraseSecretKey, passwordSecretKey, proxyPasswordSecretKey } from "../services/ssh/silentAuth";
import { serverFormDefinition } from "../ui/formDefinitions";
import { authProfilePasswordSecretKey } from "../services/ssh/silentAuth";
import type { FormValues } from "../ui/formTypes";
import { FolderTreeItem, ServerTreeItem, SessionTreeItem } from "../ui/nexusTreeProvider";
import { WebviewFormPanel } from "../ui/webviewFormPanel";
import { defaultSshDir, deployPublicKeyToRemote, findLocalKeyPairs, generateKeyPair } from "../services/ssh/deploySshKey";
import type { KeyPairInfo } from "../services/ssh/deploySshKey";
import { resolveTunnelConnectionMode, startTunnel } from "./tunnelCommands";
import type { CommandContext, ServerTerminalMap } from "./types";
import { getAncestorPaths, isDescendantOrSelf, folderDisplayName, normalizeFolderPath } from "../utils/folderPaths";

/** @deprecated Use FolderTreeItem */
const GroupTreeItem = FolderTreeItem;

async function pickServer(core: import("../core/nexusCore").NexusCore): Promise<ServerConfig | undefined> {
  const servers = core.getSnapshot().servers.filter((server) => !server.isHidden);
  if (servers.length === 0) {
    vscode.window.showWarningMessage("No Nexus servers configured");
    return undefined;
  }
  const pick = await vscode.window.showQuickPick(
    servers.map((server) => ({
      label: server.name,
      description: `${server.username}@${server.host}:${server.port}`,
      server
    })),
    { title: "Select Nexus Server" }
  );
  return pick?.server;
}

function toServerFromArg(
  core: import("../core/nexusCore").NexusCore,
  arg: unknown
): ServerConfig | undefined {
  if (arg instanceof ServerTreeItem) {
    return arg.server;
  }
  if (arg instanceof SessionTreeItem) {
    return core.getServer(arg.session.serverId);
  }
  if (typeof arg === "object" && arg) {
    const withServer = arg as { server?: ServerConfig };
    if (withServer.server?.id) {
      return core.getServer(withServer.server.id) ?? withServer.server;
    }
    const withSession = arg as { session?: { serverId?: string } };
    if (withSession.session?.serverId) {
      return core.getServer(withSession.session.serverId);
    }
  }
  if (typeof arg === "string") {
    return core.getServer(arg);
  }
  return undefined;
}

function addTerminal(serverId: string, terminal: vscode.Terminal, terminalsByServer: ServerTerminalMap): void {
  let terminals = terminalsByServer.get(serverId);
  if (!terminals) {
    terminals = new Set();
    terminalsByServer.set(serverId, terminals);
  }
  terminals.add(terminal);
}

function removeTerminal(serverId: string, terminal: vscode.Terminal, terminalsByServer: ServerTerminalMap): void {
  const terminals = terminalsByServer.get(serverId);
  if (!terminals) {
    return;
  }
  terminals.delete(terminal);
  if (terminals.size === 0) {
    terminalsByServer.delete(serverId);
  }
}

function collectGroups(ctx: CommandContext): string[] {
  const snapshot = ctx.core.getSnapshot();
  const groups = new Set<string>();
  for (const group of snapshot.explicitGroups) {
    for (const ancestor of getAncestorPaths(group)) {
      groups.add(ancestor);
    }
  }
  for (const server of snapshot.servers) {
    if (server.group) {
      for (const ancestor of getAncestorPaths(server.group)) {
        groups.add(ancestor);
      }
    }
  }
  for (const profile of snapshot.serialProfiles) {
    if (profile.group) {
      for (const ancestor of getAncestorPaths(profile.group)) {
        groups.add(ancestor);
      }
    }
  }
  return [...groups].sort((a, b) => a.localeCompare(b));
}

const VALID_AUTH_TYPES = new Set<string>(["password", "key", "agent"]);
function isAuthType(value: unknown): value is AuthType {
  return typeof value === "string" && VALID_AUTH_TYPES.has(value);
}

function getDefaultSessionTranscriptsEnabled(): boolean {
  return vscode.workspace.getConfiguration("nexus.logging").get<boolean>("sessionTranscripts", true);
}

function isValidProxyPort(port: number): boolean {
  return Number.isInteger(port) && port >= 1 && port <= 65535;
}

const DEPLOY_DEFAULT_KEY_NAME = "id_ed25519";
const DEPLOY_FALLBACK_KEY_NAME = "id_ed25519_nexus";
const DEPLOY_KEY_NAME_PATTERN = /^[A-Za-z0-9._-]+$/;

function validateDeployKeyNameInput(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return "Name cannot be empty";
  }
  if (trimmed === "." || trimmed === "..") {
    return "Name cannot be '.' or '..'";
  }
  if (!DEPLOY_KEY_NAME_PATTERN.test(trimmed)) {
    return "Name can only contain letters, numbers, '.', '_' and '-'";
  }
  return null;
}

interface SelectedDeployKey {
  publicKeyPath: string;
  privateKeyPath: string;
}

async function pickPassphraseForGeneratedKey(): Promise<string | undefined> {
  const passChoice = await vscode.window.showQuickPick(
    [
      { label: "No passphrase", description: "Key will not be encrypted", passphrase: "" },
      {
        label: "Set passphrase",
        description: "Encrypt the private key",
        passphrase: undefined as string | undefined
      }
    ],
    { title: "Key Passphrase" }
  );
  if (!passChoice) {
    return undefined;
  }
  if (passChoice.passphrase !== undefined) {
    return passChoice.passphrase;
  }
  const passphrase = await vscode.window.showInputBox({
    title: "Enter Passphrase",
    password: true,
    prompt: "Enter passphrase for the new key"
  });
  if (passphrase === undefined) {
    return undefined;
  }
  const confirm = await vscode.window.showInputBox({
    title: "Confirm Passphrase",
    password: true,
    prompt: "Re-enter passphrase to confirm"
  });
  if (confirm === undefined || confirm !== passphrase) {
    void vscode.window.showErrorMessage("Passphrases do not match.");
    return undefined;
  }
  return passphrase;
}

async function pickDeployKeyName(sshDir: string): Promise<string | undefined> {
  let keyName = DEPLOY_DEFAULT_KEY_NAME;
  try {
    await readFile(path.join(sshDir, `${DEPLOY_DEFAULT_KEY_NAME}.pub`));
    const custom = await vscode.window.showInputBox({
      title: "Key Name",
      prompt: `${DEPLOY_DEFAULT_KEY_NAME} already exists. Enter a name for the new key`,
      value: DEPLOY_FALLBACK_KEY_NAME,
      validateInput: validateDeployKeyNameInput
    });
    if (!custom) {
      return undefined;
    }
    keyName = custom.trim();
  } catch {
    // Default name available
  }
  return keyName;
}

async function pickKeyForDeployment(sshDir: string): Promise<SelectedDeployKey | undefined> {
  const keyPairs = await findLocalKeyPairs(sshDir);

  type KeyPickItem = vscode.QuickPickItem & { keyPair?: KeyPairInfo; generate?: boolean };
  const items: KeyPickItem[] = keyPairs.map((keyPair) => ({
    label: keyPair.name,
    description: keyPair.publicKeyPath,
    keyPair
  }));
  items.push({ label: "$(add) Generate new ed25519 key", generate: true });

  const pick = await vscode.window.showQuickPick(items, {
    title: "Deploy SSH Key",
    placeHolder: "Select an existing key or generate a new one"
  });
  if (!pick) {
    return undefined;
  }
  if (!pick.generate) {
    if (!pick.keyPair) {
      return undefined;
    }
    return {
      publicKeyPath: pick.keyPair.publicKeyPath,
      privateKeyPath: pick.keyPair.privateKeyPath
    };
  }

  const keyName = await pickDeployKeyName(sshDir);
  if (!keyName) {
    return undefined;
  }
  const passphrase = await pickPassphraseForGeneratedKey();
  if (passphrase === undefined) {
    return undefined;
  }

  const generated = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: "Generating SSH key..." },
    () => generateKeyPair({ sshDir, name: keyName, passphrase })
  );
  return { publicKeyPath: generated.publicKeyPath, privateKeyPath: generated.privateKeyPath };
}

export function formValuesToProxy(values: FormValues): ProxyConfig | undefined {
  const proxyType = typeof values.proxyType === "string" ? values.proxyType : "none";
  if (proxyType === "none") return undefined;

  if (proxyType === "ssh") {
    const jumpHostId = typeof values.proxyJumpHostId === "string" ? values.proxyJumpHostId : "";
    if (!jumpHostId) return undefined;
    return { type: "ssh", jumpHostId };
  }

  if (proxyType === "socks5") {
    const host = typeof values.proxySocks5Host === "string" ? values.proxySocks5Host.trim() : "";
    const port = typeof values.proxySocks5Port === "number" ? values.proxySocks5Port : 1080;
    if (!host || !isValidProxyPort(port)) return undefined;
    const username = typeof values.proxySocks5Username === "string" && values.proxySocks5Username.trim()
      ? values.proxySocks5Username.trim()
      : undefined;
    return { type: "socks5", host, port, username };
  }

  if (proxyType === "http") {
    const host = typeof values.proxyHttpHost === "string" ? values.proxyHttpHost.trim() : "";
    const port = typeof values.proxyHttpPort === "number" ? values.proxyHttpPort : 3128;
    if (!host || !isValidProxyPort(port)) return undefined;
    const username = typeof values.proxyHttpUsername === "string" && values.proxyHttpUsername.trim()
      ? values.proxyHttpUsername.trim()
      : undefined;
    return { type: "http", host, port, username };
  }

  return undefined;
}

export async function syncProxyPasswordSecret(ctx: CommandContext, serverId: string, values: FormValues): Promise<void> {
  if (!ctx.secretVault) {
    return;
  }
  const secretKey = proxyPasswordSecretKey(serverId);
  const proxyType = typeof values.proxyType === "string" ? values.proxyType : "none";

  if (proxyType === "socks5") {
    const username = typeof values.proxySocks5Username === "string" ? values.proxySocks5Username.trim() : "";
    if (!username) {
      await ctx.secretVault.delete(secretKey);
      return;
    }
    const password = typeof values.proxySocks5Password === "string" ? values.proxySocks5Password : "";
    if (password.length > 0) {
      await ctx.secretVault.store(secretKey, password);
    }
    return;
  }

  if (proxyType === "http") {
    const username = typeof values.proxyHttpUsername === "string" ? values.proxyHttpUsername.trim() : "";
    if (!username) {
      await ctx.secretVault.delete(secretKey);
      return;
    }
    const password = typeof values.proxyHttpPassword === "string" ? values.proxyHttpPassword : "";
    if (password.length > 0) {
      await ctx.secretVault.store(secretKey, password);
    }
    return;
  }

  await ctx.secretVault.delete(secretKey);
}

export function formValuesToServer(values: FormValues, existingId?: string, preserveIsHidden = false): ServerConfig | undefined {
  const name = typeof values.name === "string" ? values.name.trim() : "";
  const host = typeof values.host === "string" ? values.host.trim() : "";
  const username = typeof values.username === "string" ? values.username.trim() : "";
  if (!name || !host || !username) {
    return undefined;
  }
  return {
    id: existingId ?? randomUUID(),
    name,
    host,
    port: typeof values.port === "number" ? values.port : 22,
    username,
    authType: isAuthType(values.authType) ? values.authType : "password",
    keyPath: typeof values.keyPath === "string" && values.keyPath ? values.keyPath : undefined,
    group: typeof values.group === "string" && values.group ? normalizeFolderPath(values.group) : undefined,
    isHidden: preserveIsHidden,
    logSession: typeof values.logSession === "boolean" ? values.logSession : getDefaultSessionTranscriptsEnabled(),
    multiplexing: typeof values.multiplexing === "boolean" ? values.multiplexing : undefined,
    proxy: formValuesToProxy(values)
  };
}

export { browseForKey, collectGroups };

async function browseForKey(): Promise<string | undefined> {
  const uris = await vscode.window.showOpenDialog({
    canSelectFiles: true,
    canSelectMany: false,
    title: "Select SSH Private Key",
    defaultUri: vscode.Uri.file(os.homedir() + "/.ssh/"),
    openLabel: "Select Key",
    filters: { "All Files": ["*"] }
  });
  return uris?.[0]?.fsPath;
}

async function stopAutoStopTunnels(ctx: CommandContext, serverId: string): Promise<void> {
  const snapshot = ctx.core.getSnapshot();
  const tunnelsToStop = snapshot.activeTunnels.filter((t) => {
    if (t.serverId !== serverId) {
      return false;
    }
    const profile = ctx.core.getTunnel(t.profileId);
    return profile?.autoStop !== false; // undefined or true → stop
  });
  await Promise.all(tunnelsToStop.map((t) => ctx.tunnelManager.stop(t.id)));
}

function hasActiveTunnelsForServer(ctx: CommandContext, serverId: string): boolean {
  return ctx.core.getSnapshot().activeTunnels.some((tunnel) => tunnel.serverId === serverId);
}

async function connectServer(ctx: CommandContext, arg?: unknown): Promise<void> {
  const server = toServerFromArg(ctx.core, arg) ?? (await pickServer(ctx.core));
  if (!server) {
    return;
  }

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Connecting to ${server.name}...`,
      cancellable: false
    },
    async () => {
      const terminalName = `Nexus SSH: ${server.name}`;
      let terminalRef: vscode.Terminal | undefined;
      const pty = new SshPty(
        server,
        ctx.sshFactory,
        {
          onSessionOpened: (sessionId) => {
            ctx.core.registerSession({
              id: sessionId,
              serverId: server.id,
              terminalName,
              startedAt: Date.now()
            });
            if (terminalRef) {
              ctx.sessionTerminals.set(sessionId, terminalRef);
            }

            for (const tunnel of ctx.core.getSnapshot().tunnels) {
              if (tunnel.autoStart && tunnel.defaultServerId === server.id) {
                // Silently skip tunnels that are already running
                if (ctx.core.getSnapshot().activeTunnels.some((t) => t.profileId === tunnel.id)) {
                  continue;
                }
                void resolveTunnelConnectionMode(tunnel, false).then((mode) => {
                  if (!mode) {
                    return;
                  }
                  return startTunnel(ctx.core, ctx.tunnelManager, ctx.sshFactory, tunnel, server, mode, ctx.registrySync);
                });
              }
            }
          },
          onSessionClosed: (sessionId) => {
            ctx.core.unregisterSession(sessionId);
            ctx.sessionTerminals.delete(sessionId);
            if (terminalRef) {
              removeTerminal(server.id, terminalRef, ctx.terminalsByServer);
            }
            if (!ctx.core.isServerConnected(server.id)) {
              stopAutoStopTunnels(ctx, server.id).catch(() => {});
            }
          },
          onDisconnected: (sessionId) => {
            ctx.core.unregisterSession(sessionId);
            ctx.sessionTerminals.delete(sessionId);
            // Intentionally keep terminalsByServer entry (terminal is still
            // alive for reconnect) and do NOT stop auto-stop tunnels — they
            // will be cleaned up when the terminal is fully closed via
            // onSessionClosed.
          }
        },
        ctx.loggerFactory.create("terminal", server.id),
        createSessionTranscript(
          ctx.sessionLogDir,
          server.name,
          server.logSession ?? getDefaultSessionTranscriptsEnabled()
        ),
        ctx.highlighter
      );
      const openInEditor = vscode.workspace.getConfiguration("nexus.terminal").get("openLocation") === "editor";
      const terminal = vscode.window.createTerminal({
        name: terminalName,
        pty,
        location: openInEditor ? vscode.TerminalLocation.Editor : vscode.TerminalLocation.Panel
      });
      terminalRef = terminal;
      addTerminal(server.id, terminal, ctx.terminalsByServer);
      terminal.show();
    }
  );
}

async function disconnectServer(ctx: CommandContext, arg?: unknown): Promise<void> {
  // If arg is a single session node, disconnect only that session
  if (arg instanceof SessionTreeItem) {
    const terminal = ctx.sessionTerminals.get(arg.session.id);
    if (terminal) {
      terminal.dispose();
    }
    return;
  }

  // Otherwise disconnect all sessions for the server
  const server = toServerFromArg(ctx.core, arg) ?? (await pickServer(ctx.core));
  if (!server) {
    return;
  }
  const terminals = ctx.terminalsByServer.get(server.id);
  if (terminals) {
    for (const terminal of terminals) {
      terminal.dispose();
    }
    ctx.terminalsByServer.delete(server.id);
  }
  await stopAutoStopTunnels(ctx, server.id);
  if (!hasActiveTunnelsForServer(ctx, server.id)) {
    ctx.sshPool.disconnect(server.id);
  }
}

export function registerServerCommands(ctx: CommandContext): vscode.Disposable[] {
  return [
    vscode.commands.registerCommand("nexus.server.add", () => {
      void vscode.commands.executeCommand("nexus.profile.add");
    }),

    vscode.commands.registerCommand("nexus.server.edit", async (arg?: unknown) => {
      const existing = toServerFromArg(ctx.core, arg) ?? (await pickServer(ctx.core));
      if (!existing) {
        return;
      }
      const existingGroups = collectGroups(ctx);
      const snapshot = ctx.core.getSnapshot();
      const serverList = snapshot.servers.map((s) => ({ id: s.id, name: s.name }));
      const definition = serverFormDefinition(existing, existingGroups, getDefaultSessionTranscriptsEnabled(), serverList, snapshot.authProfiles);
      WebviewFormPanel.open("server-edit", definition, {
        onSubmit: async (values) => {
          const updated = formValuesToServer(values, existing.id, existing.isHidden);
          if (!updated) {
            return;
          }
          await ctx.core.addOrUpdateServer(updated);
          await syncProxyPasswordSecret(ctx, updated.id, values);
          // Copy auth profile password to server if profile was selected
          const authProfileId = typeof values.authProfileId === "string" ? values.authProfileId : "";
          if (authProfileId && ctx.secretVault) {
            const profilePw = await ctx.secretVault.get(authProfilePasswordSecretKey(authProfileId));
            if (profilePw) {
              await ctx.secretVault.store(passwordSecretKey(updated.id), profilePw);
            }
          }
          if (ctx.core.isServerConnected(existing.id)) {
            void vscode.window.showInformationMessage(
              "Server profile updated. Existing sessions keep current connection settings until reconnect."
            );
          }
        },
        onBrowse: browseForKey,
        onAutofill: async (_key, value) => {
          const profile = ctx.core.getAuthProfile(value);
          if (!profile) {
            return undefined;
          }
          return {
            username: profile.username,
            authType: profile.authType,
            ...(profile.keyPath ? { keyPath: profile.keyPath } : {})
          };
        }
      });
    }),

    vscode.commands.registerCommand("nexus.server.remove", async (arg?: unknown) => {
      const server = toServerFromArg(ctx.core, arg) ?? (await pickServer(ctx.core));
      if (!server) {
        return;
      }
      const confirm = await vscode.window.showWarningMessage(
        `Remove server "${server.name}" and disconnect all sessions?`,
        { modal: true },
        "Remove"
      );
      if (confirm !== "Remove") {
        return;
      }
      await disconnectServer(ctx, server.id);
      if (ctx.secretVault) {
        await ctx.secretVault.delete(passwordSecretKey(server.id));
        await ctx.secretVault.delete(passphraseSecretKey(server.id));
        await ctx.secretVault.delete(proxyPasswordSecretKey(server.id));
      }
      // Stop ALL tunnels when server profile is deleted, regardless of autoStop
      const remaining = ctx.core.getSnapshot().activeTunnels.filter((t) => t.serverId === server.id);
      await Promise.all(remaining.map((t) => ctx.tunnelManager.stop(t.id)));
      ctx.sshPool.disconnect(server.id);
      await ctx.core.removeServer(server.id);
    }),

    vscode.commands.registerCommand("nexus.server.connect", (arg?: unknown) => connectServer(ctx, arg)),
    vscode.commands.registerCommand("nexus.server.disconnect", (arg?: unknown) => disconnectServer(ctx, arg)),

    vscode.commands.registerCommand("nexus.server.copyInfo", async (arg?: unknown) => {
      const server = toServerFromArg(ctx.core, arg) ?? (await pickServer(ctx.core));
      if (!server) {
        return;
      }
      const info = `${server.username}@${server.host}:${server.port}`;
      await vscode.env.clipboard.writeText(info);
      void vscode.window.showInformationMessage(`Copied: ${info}`);
    }),

    vscode.commands.registerCommand("nexus.server.duplicate", async (arg?: unknown) => {
      const server = toServerFromArg(ctx.core, arg) ?? (await pickServer(ctx.core));
      if (!server) {
        return;
      }
      const copy = { ...server, id: randomUUID(), name: `${server.name} (copy)` };
      await ctx.core.addOrUpdateServer(copy);
    }),

    vscode.commands.registerCommand("nexus.server.rename", async (arg?: unknown) => {
      const server = toServerFromArg(ctx.core, arg) ?? (await pickServer(ctx.core));
      if (!server) {
        return;
      }
      const newName = await vscode.window.showInputBox({
        title: "Rename Server",
        value: server.name,
        prompt: "Enter new name",
        validateInput: (value) => (value.trim() ? null : "Name cannot be empty")
      });
      if (!newName || newName.trim() === server.name) {
        return;
      }
      await ctx.core.addOrUpdateServer({ ...server, name: newName.trim() });
    }),

    vscode.commands.registerCommand("nexus.group.rename", async (arg?: unknown) => {
      if (!(arg instanceof FolderTreeItem)) {
        return;
      }
      const oldPath = arg.folderPath;
      const currentName = folderDisplayName(oldPath);
      const newName = await vscode.window.showInputBox({
        title: "Rename Folder",
        value: currentName,
        prompt: "Enter new folder name",
        validateInput: (value) => {
          const trimmed = value.trim();
          if (!trimmed) {
            return "Folder name cannot be empty";
          }
          if (trimmed.includes("/")) {
            return "Folder name cannot contain '/'";
          }
          return null;
        }
      });
      if (!newName || newName.trim() === currentName) {
        return;
      }
      await ctx.core.renameFolder(oldPath, newName.trim());
    }),

    vscode.commands.registerCommand("nexus.group.connect", async (arg?: unknown) => {
      if (!(arg instanceof FolderTreeItem)) {
        return;
      }
      const folderPath = arg.folderPath;
      const servers = ctx.core
        .getSnapshot()
        .servers.filter((s) => s.group && isDescendantOrSelf(s.group, folderPath) && !s.isHidden);
      for (const server of servers) {
        void connectServer(ctx, server.id);
      }
    }),

    vscode.commands.registerCommand("nexus.group.disconnect", async (arg?: unknown) => {
      if (!(arg instanceof FolderTreeItem)) {
        return;
      }
      const folderPath = arg.folderPath;
      const servers = ctx.core
        .getSnapshot()
        .servers.filter((s) => s.group && isDescendantOrSelf(s.group, folderPath) && !s.isHidden);
      for (const server of servers) {
        await disconnectServer(ctx, server.id);
      }
    }),

    vscode.commands.registerCommand("nexus.server.deployKey", async (arg?: unknown) => {
      const server = toServerFromArg(ctx.core, arg) ?? (await pickServer(ctx.core));
      if (!server) {
        return;
      }

      const sshDir = defaultSshDir();
      let selectedKey: SelectedDeployKey | undefined;
      try {
        selectedKey = await pickKeyForDeployment(sshDir);
      } catch (error: any) {
        const message = error instanceof Error ? error.message : String(error);
        void vscode.window.showErrorMessage(`Key selection failed: ${message}`);
        return;
      }
      if (!selectedKey) {
        return;
      }
      const { publicKeyPath, privateKeyPath } = selectedKey;

      let pubKeyContent: string;
      try {
        pubKeyContent = await readFile(publicKeyPath, "utf-8");
      } catch (error: any) {
        const message = error instanceof Error ? error.message : String(error);
        void vscode.window.showErrorMessage(`Cannot read public key: ${message}`);
        return;
      }

      let connection: import("../services/ssh/contracts").SshConnection | undefined;
      try {
        const deployResult = await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: `Deploying key to ${server.name}...`,
            cancellable: false,
          },
          async () => {
            connection = await ctx.sshFactory.connect(server);
            return deployPublicKeyToRemote(connection, pubKeyContent);
          },
        );

        if (deployResult.alreadyDeployed) {
          void vscode.window.showInformationMessage("Public key is already deployed on this server.");
        } else {
          const switchAction = "Switch to key auth";
          const response = await vscode.window.showInformationMessage(
            `SSH key deployed to ${server.name} successfully.`,
            switchAction,
          );
          if (response === switchAction) {
            await ctx.core.addOrUpdateServer({ ...server, authType: "key", keyPath: privateKeyPath });
            if (server.authType === "password" && ctx.secretVault) {
              const removeAction = "Remove stored password";
              const pwResponse = await vscode.window.showInformationMessage(
                "Server switched to key authentication.",
                removeAction,
              );
              if (pwResponse === removeAction) {
                await ctx.secretVault.delete(passwordSecretKey(server.id));
              }
            }
          }
        }
      } catch (err: any) {
        void vscode.window.showErrorMessage(`Deploy failed: ${err?.message ?? err}`);
      } finally {
        connection?.dispose();
      }
    })
  ];
}
