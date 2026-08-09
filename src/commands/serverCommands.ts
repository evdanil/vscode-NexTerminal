import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import type { AuthProfile, AuthType, ProxyConfig, ServerConfig } from "../models/config";
import {
  authProfileOwnedCredentials,
  authProfileOwnershipSignature,
  cloneServerConfig,
  effectiveServerUsername,
  formOfferedServerCredentials,
  mergeServerConfigFields,
  serverConfigsEqual
} from "../models/config";
import { createSessionTranscript } from "../logging/sessionTranscriptLogger";
import type { LoggerRotationOptions } from "../logging/terminalLogger";
import { SshPty } from "../services/ssh/sshPty";
import type { PtyOutputObserver } from "../services/macroAutoTrigger";
import { Osc7Parser } from "../services/terminal/osc7Parser";
import { passphraseSecretKey, passwordSecretKey, proxyPasswordSecretKey } from "../services/ssh/silentAuth";
import { serverFormDefinition } from "../ui/formDefinitions";
import type { FormValues } from "../ui/formTypes";
import { FolderTreeItem, ServerTreeItem, SessionTreeItem } from "../ui/nexusTreeProvider";
import { WebviewFormPanel } from "../ui/webviewFormPanel";
import { defaultSshDir, deployPublicKeyToRemote, findLocalKeyPairs, generateKeyPair } from "../services/ssh/deploySshKey";
import type { KeyPairInfo } from "../services/ssh/deploySshKey";
import { classifySshConnectionError, type ConnectionDiagnosticResult } from "../services/ssh/connectionDiagnostics";
import { resolveTunnelConnectionMode, startTunnel } from "./tunnelCommands";
import { browseServerFiles } from "./fileCommands";
import type { CommandContext, ServerTerminalMap } from "./types";
import {
  getAncestorPaths,
  folderDisplayName,
  normalizeOptionalFolderPath,
  INVALID_FOLDER_PATH_MESSAGE
} from "../utils/folderPaths";
import { formatAuthProfileLabel, formatKeyPathDisplayName, normalizeKeyPathForComparison } from "../utils/authProfileLabel";
import { naturalCompare, naturalComparePath } from "../utils/naturalCompare";
import { createInlineAuthProfileCreation } from "./inlineAuthProfileCreation";
import { pickScriptFromWorkspace } from "../services/scripts/scriptPicker";
import { configMutationLock } from "../services/configMutationLock";

export async function pickServer(core: import("../core/nexusCore").NexusCore): Promise<ServerConfig | undefined> {
  const servers = core.getSnapshot().servers.filter((server) => !server.isHidden);
  if (servers.length === 0) {
    vscode.window.showWarningMessage("No Nexus servers configured");
    return undefined;
  }
  const pick = await vscode.window.showQuickPick(
    servers
      .slice()
      .sort((a, b) => naturalCompare(a.name, b.name))
      .map((server) => ({
        label: server.name,
        description: `${server.username}@${server.host}:${server.port}`,
        server
      })),
    { title: "Select Nexus Server" }
  );
  return pick?.server;
}

export function toServerFromArg(
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

/**
 * Directory-sync (issue #35, §5.2) passive OSC 7 observer. One instance per SSH
 * session, attached via `pty.addOutputObserver` alongside the existing macro
 * observer. Feeds each chunk to a per-session `Osc7Parser`, records a per-session
 * `lastOutputAt` timestamp on every chunk (the coordinator's staleness check
 * needs this — see `CwdSyncDeps.lastOutputAt`), and reports any parsed match to
 * `CwdTracker`.
 *
 * **Late-binding pattern (§5.2/§5.4g):** mirrors the shape of the macro
 * observer's `createObserver(..., undefined, server.id)` +
 * `bindObserverToSession(obs, sessionId)` — the sessionId does not exist yet at
 * the point this observer is attached (`terminalRegistry.register` runs before
 * `pty.open()` fires `onSessionOpened`), so `onOutput` closes over a mutable
 * `sessionId` variable that starts `undefined` and is set once `onSessionOpened`
 * fires. Unlike the macro observer, this one is entirely local to
 * `serverCommands.ts` (never crosses into `macroAutoTrigger.ts`), so a simple
 * closure variable is used instead of an exported `bindObserverToSession` API.
 */
function createOsc7Observer(
  ctx: CommandContext,
  serverId: string
): PtyOutputObserver & { bindSessionId(sessionId: string): void; resetParser(): void } {
  const parser = new Osc7Parser();
  let sessionId: string | undefined;
  return {
    onOutput: (text: string) => {
      if (sessionId) {
        ctx.cwdLastOutputAt?.set(sessionId, Date.now());
      }
      if (!ctx.cwdTracker || !sessionId) {
        return;
      }
      const matches = parser.feed(text);
      if (matches.length === 0) {
        return;
      }
      const now = Date.now();
      for (const match of matches) {
        ctx.cwdTracker.report(sessionId, serverId, match.path, "osc7", match.authority, now);
      }
    },
    pauseIntervalMacros: () => {
      /* no macro state on this observer to pause */
    },
    dispose: () => {
      parser.reset();
    },
    bindSessionId: (id: string) => {
      sessionId = id;
    },
    resetParser: () => {
      parser.reset();
    }
  };
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
  for (const profile of snapshot.localShellProfiles) {
    if (profile.group) {
      for (const ancestor of getAncestorPaths(profile.group)) {
        groups.add(ancestor);
      }
    }
  }
  return [...groups].sort((a, b) => naturalComparePath(a, b));
}

const VALID_AUTH_TYPES = new Set<string>(["password", "key", "agent"]);
function isAuthType(value: unknown): value is AuthType {
  return typeof value === "string" && VALID_AUTH_TYPES.has(value);
}

function getDefaultSessionTranscriptsEnabled(): boolean {
  return vscode.workspace.getConfiguration("nexus.logging").get<boolean>("sessionTranscripts", true);
}

function getTranscriptRotationOptions(ctx: CommandContext): Partial<LoggerRotationOptions> | undefined {
  return (ctx.loggerFactory as { getRotationOptions?: () => LoggerRotationOptions }).getRotationOptions?.();
}

function isValidProxyPort(port: number): boolean {
  return Number.isInteger(port) && port >= 1 && port <= 65535;
}

const DEPLOY_DEFAULT_KEY_NAME = "id_ed25519";
const DEPLOY_FALLBACK_KEY_NAME = "id_ed25519_nexus";
const DEPLOY_KEY_NAME_PATTERN = /^[A-Za-z0-9._-]+$/;
const DEPLOY_USE_STANDALONE_KEY_ACTION = "Use standalone key";
const DEPLOY_USE_KEY_PROFILE_ACTION = "Use key auth profile";
const DEPLOY_CREATE_KEY_PROFILE_ACTION = "Create new key auth profile...";
const DEPLOY_REMOVE_STORED_PASSWORD_ACTION = "Remove stored password";

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

/**
 * The username a connection to `server` will actually use — the deploy-key flow
 * needs it to name the account the public key is installed for, and to stamp
 * the converted/linked record.
 *
 * REVIEW FINDING (P2) — resolved through the shared ownership rule, so a
 * profile that supplies no usable username leaves the server's own standing.
 * `profile.username ?? server.username` used to hand back a whitespace-only
 * username, which `buildStandaloneKeyServer` then wrote onto the record as its
 * own — a `username` that `validateServerConfig` rejects, i.e. a server that
 * disappears at the next load.
 */
function resolveEffectiveUsername(core: import("../core/nexusCore").NexusCore, server: ServerConfig): string {
  if (!server.authProfileId) {
    return server.username;
  }
  return effectiveServerUsername(server, core.getAuthProfile(server.authProfileId));
}

function buildStandaloneKeyServer(server: ServerConfig, username: string, privateKeyPath: string): ServerConfig {
  return {
    ...server,
    username,
    authProfileId: undefined,
    authType: "key",
    keyPath: privateKeyPath
  };
}

function buildProfileLinkedKeyServer(
  server: ServerConfig,
  username: string,
  privateKeyPath: string,
  authProfileId: string
): ServerConfig {
  return {
    ...server,
    username,
    authProfileId,
    authType: "key",
    keyPath: privateKeyPath
  };
}

async function maybeRemoveStoredPasswordAfterKeyConversion(ctx: CommandContext, originalServer: ServerConfig): Promise<void> {
  if (!ctx.secretVault || originalServer.authType !== "password") {
    return;
  }
  const existingPassword = await ctx.secretVault.get(passwordSecretKey(originalServer.id));
  if (!existingPassword) {
    return;
  }
  const response = await vscode.window.showInformationMessage(
    "Server switched to key authentication.",
    DEPLOY_REMOVE_STORED_PASSWORD_ACTION
  );
  if (response === DEPLOY_REMOVE_STORED_PASSWORD_ACTION) {
    await ctx.secretVault.delete(passwordSecretKey(originalServer.id));
  }
}

async function pickDeployConversionMode(
  serverName: string,
  alreadyDeployed: boolean
): Promise<"standalone" | "profile" | undefined> {
  const response = await vscode.window.showInformationMessage(
    alreadyDeployed
      ? `Public key is already deployed on ${serverName}. Choose how to use it for future connections.`
      : `SSH key deployed to ${serverName} successfully. Choose how to use it for future connections.`,
    DEPLOY_USE_STANDALONE_KEY_ACTION,
    DEPLOY_USE_KEY_PROFILE_ACTION
  );
  if (response === DEPLOY_USE_STANDALONE_KEY_ACTION) {
    return "standalone";
  }
  if (response === DEPLOY_USE_KEY_PROFILE_ACTION) {
    return "profile";
  }
  return undefined;
}

/**
 * The existing key profiles that are interchangeable with the one this flow
 * would otherwise create — i.e. that supply the same account and the same key
 * file as `{ username, authType: "key", keyPath: privateKeyPath }` would.
 *
 * REVIEW FINDING (P3) — every candidate field is read through THE ONE RULE
 * (`authProfileOwnedCredentials`, models/config.ts), the same rule
 * `resolveEffectiveUsername` above uses to derive `username`. A raw
 * `profile.username === username` compared a trimmed value against an untrimmed
 * one, so an imported profile with a padded username (`"deploy-user "` — reachable
 * because `validateAuthProfile` only checks length) was not offered even though
 * it is the very profile the user already has for this account and this key: the
 * flow then prompted them to create a duplicate that behaves identically, because
 * the connect path trims too.
 *
 * WHAT DOES NOT CHANGE — a profile that supplies NO usable username still
 * matches nothing. `resolveEffectiveUsername`'s `?? server.username` fallback is
 * NOT part of the rule and has no counterpart here: there it answers "what
 * account does this already-chosen pairing connect as", and the server is the
 * other half of that pairing. Here the question is "which profile supplies the
 * account I need", and a profile that owns no username supplies none — so
 * `undefined !== username` for every possible target, which is right. Adopting
 * the fallback instead (`owned.username ?? username`) would make a blank-username
 * profile match EVERY account, offering the user a known-broken record as the
 * reusable profile for a key they just deployed.
 *
 * `authType` and `keyPath` read off the same rule for consistency, which is
 * behaviour-preserving: `authType` is always owned, and
 * `normalizeKeyPathForComparison` already trimmed what the old comparison passed
 * it.
 */
function findMatchingKeyAuthProfiles(
  core: import("../core/nexusCore").NexusCore,
  username: string,
  privateKeyPath: string
): AuthProfile[] {
  const normalizedKeyPath = normalizeKeyPathForComparison(privateKeyPath);
  return core.getSnapshot().authProfiles.filter((profile) => {
    const owned = authProfileOwnedCredentials(profile);
    return (
      owned.authType === "key" &&
      owned.username === username &&
      owned.keyPath !== undefined &&
      normalizeKeyPathForComparison(owned.keyPath) === normalizedKeyPath
    );
  });
}

function getDefaultKeyAuthProfileName(username: string, privateKeyPath: string): string {
  return `${username} — ${formatKeyPathDisplayName(privateKeyPath)}`;
}

async function promptForKeyAuthProfileName(username: string, privateKeyPath: string): Promise<string | undefined> {
  const name = await vscode.window.showInputBox({
    title: "Key Auth Profile Name",
    prompt: "Enter a name for the new key auth profile",
    value: getDefaultKeyAuthProfileName(username, privateKeyPath),
    validateInput: (value) => value.trim() ? null : "Name cannot be empty"
  });
  return name?.trim() || undefined;
}

async function createKeyAuthProfile(
  ctx: CommandContext,
  username: string,
  privateKeyPath: string
): Promise<AuthProfile | undefined> {
  const name = await promptForKeyAuthProfileName(username, privateKeyPath);
  if (!name) {
    return undefined;
  }
  const profile: AuthProfile = {
    id: randomUUID(),
    name,
    username,
    authType: "key",
    keyPath: privateKeyPath
  };
  await ctx.core.addOrUpdateAuthProfile(profile);
  return profile;
}

async function pickOrCreateKeyAuthProfile(
  ctx: CommandContext,
  username: string,
  privateKeyPath: string
): Promise<AuthProfile | undefined> {
  const matches = findMatchingKeyAuthProfiles(ctx.core, username, privateKeyPath);
  if (matches.length === 0) {
    return createKeyAuthProfile(ctx, username, privateKeyPath);
  }

  type ProfilePickItem = vscode.QuickPickItem & { profile?: AuthProfile; createNew?: boolean };
  const pick = await vscode.window.showQuickPick<ProfilePickItem>(
    [
      ...matches.map((profile) => ({
        label: formatAuthProfileLabel(profile),
        description: "Reuse existing key auth profile",
        profile
      })),
      {
        label: DEPLOY_CREATE_KEY_PROFILE_ACTION,
        description: "Create a new reusable key auth profile for this key",
        createNew: true
      }
    ],
    {
      title: "Select Key Auth Profile",
      placeHolder: "Choose an existing matching key auth profile or create a new one"
    }
  );
  if (!pick) {
    return undefined;
  }
  if (pick.createNew) {
    return createKeyAuthProfile(ctx, username, privateKeyPath);
  }
  return pick.profile;
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
  const normalizedGroup = normalizeOptionalFolderPath(values.group);
  if (!name || !host || !username) {
    return undefined;
  }
  if (normalizedGroup === null) {
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
    // Trimmed and blank-canonicalized like every other optional text field: an
    // all-whitespace value would otherwise read as "set" here and as "not set"
    // in `resolveProfileTokens`, which trims before it decides.
    ipmiHost: typeof values.ipmiHost === "string" && values.ipmiHost.trim() ? values.ipmiHost.trim() : undefined,
    group: normalizedGroup,
    isHidden: preserveIsHidden,
    logSession: typeof values.logSession === "boolean" ? values.logSession : getDefaultSessionTranscriptsEnabled(),
    multiplexing: typeof values.multiplexing === "boolean" ? values.multiplexing : undefined,
    legacyAlgorithms: typeof values.legacyAlgorithms === "boolean" ? values.legacyAlgorithms : undefined,
    openFileExplorerOnFirstConnect: values.openFileExplorerOnFirstConnect === true ? true : undefined,
    proxy: formValuesToProxy(values),
    authProfileId: typeof values.authProfileId === "string" && values.authProfileId
      ? values.authProfileId : undefined
  };
}

/**
 * REVIEW FINDING (P2) — the linked-profile half of a server edit's save.
 *
 * WHY IT EXISTS: a field the profile supplies is rendered read-only holding the
 * profile's mirrored value, and a read-only control still SUBMITS. Writing that
 * echo through would overwrite the server's own stored credential with the
 * profile's, so unlinking later would leave the server on credentials it never
 * had. This puts the stored value back underneath the link.
 *
 * WHY IT IS SCOPED — and REVIEW FINDING (P1), the scoping rule itself: a
 * submitted credential is kept only where the form OFFERED that field, i.e.
 * rendered it visible AND unlocked (`formOfferedServerCredentials`,
 * models/config.ts, which states the invariant in full and why ownership alone
 * cannot express it). Everything else is put back from the stored record.
 *
 * The two directions this replaces, each of which was a separate defect:
 *
 *   * restoring all three whenever a link existed silently discarded exactly
 *     the edits the form had — correctly — permitted: the username under a
 *     profile whose own username is blank, and the key path under a `key`
 *     profile that carries none. The user saw the field unlock, typed into it,
 *     saved, and got the old value back with nothing said.
 *   * restoring only the OWNED keys then erased the key path of a `key` server
 *     linked to a `password`/`agent` profile. That profile owns `authType`, so
 *     the form renders its type, which hides the Private Key File control,
 *     which drops it from the submission — and this declined to restore a field
 *     the profile does not own. A rename was enough to destroy the file.
 *
 * `existing`, not the live record, is the source of a restored field: it is
 * what the form was rendered from, which keeps a credential the user never saw
 * behaving like every other field of this submission under the last-writer-wins
 * rule the edit path documents at its `liveRecord` capture.
 *
 * An id resolving to NOTHING (profile deleted while the form sat open) owns
 * nothing, so every field is treated as offered — the same conclusion the
 * connect path and the form's own render-time seed reach for that id, since
 * with no profile to mirror from the form opened those fields unlocked and
 * prefilled from the record. The edit path rejects such a submission outright
 * (`serverAuthProfileRejection`) rather than relying on that agreement.
 */
export function preserveLinkedServerCredentials(
  existing: ServerConfig | undefined,
  next: ServerConfig,
  profile: AuthProfile | undefined
): ServerConfig {
  if (!existing || !next.authProfileId) {
    return next;
  }
  const offered = formOfferedServerCredentials(next, profile);
  return {
    ...next,
    ...(offered.username ? {} : { username: existing.username }),
    ...(offered.authType ? {} : { authType: existing.authType }),
    ...(offered.keyPath ? {} : { keyPath: existing.keyPath })
  };
}

/**
 * REVIEW FINDING (P1) — what a server edit form committed to when it rendered
 * (or last mirrored) the credentials of the profile it is linked to. Compared
 * against LIVE core state at Save by `serverAuthProfileRejection`.
 */
export interface RenderedAuthProfile {
  /** The id whose credentials the form is currently showing. */
  id: string;
  /** `authProfileOwnershipSignature` of the profile it showed them from. */
  signature: string;
}

const MISSING_AUTH_PROFILE_MESSAGE =
  "The selected auth profile no longer exists. Choose another, or clear the Auth Profile field.";

function changedAuthProfileMessage(profile: AuthProfile): string {
  return `The auth profile "${profile.name}" changed which credentials it supplies while this form was open, so the fields on screen are no longer the ones a save would keep. Re-select it in the Auth Profile list (or reopen this server) to pick up its current credentials, then save again.`;
}

/**
 * REVIEW FINDING (P1) — "may this server be saved carrying this auth profile?",
 * the server form's equivalent of `inventoryAuthProfileRejection`
 * (commands/inventoryCommands.ts), which the inventory source form has had
 * since this feature landed while the server form went without.
 *
 * WHY IT IS NEEDED. A form can sit open indefinitely, and auth profile
 * add/edit/delete are ordinary commands. Two things go wrong without this:
 *
 *   * the profile is DELETED. `NexusCore.removeAuthProfile` already strips the
 *     link off every referencing server, but the open form still holds the id
 *     and the deleted profile's mirrored username and key path in fields that
 *     have since unlocked. Saving resurrected the dangling id and adopted those
 *     mirrored credentials as the server's own.
 *   * the profile's OWNERSHIP SHAPE changed (`authProfileOwnershipSignature`,
 *     models/config.ts, which lists exactly what counts and why a changed
 *     VALUE does not). `preserveLinkedServerCredentials` reads the LIVE profile
 *     to decide which submitted fields are user input, so a shape that moved
 *     under it makes that decision about a form nobody rendered: a key path the
 *     user typed is discarded, or the profile's own mirrored path is written
 *     onto the server as its own — silently, either way.
 *
 * REJECT rather than repair. The values needed to re-render correctly live in
 * the webview's own transition machinery (`profileDisplacedValues`,
 * ui/formHtml.ts), which restores what a profile displaced before applying the
 * next one; pushing a bare `fillFields` from here would apply the new shape
 * WITHOUT that release, leaving a field the profile no longer fills unlocked
 * and still holding the profile's value — the precise state this exists to
 * prevent. The message therefore names the one action that runs the real
 * transition: re-select the profile.
 *
 * Call it with a `live` re-resolved inside `configMutationLock`. Auth profile
 * writes take that same lock (ui/authProfileEditorPanel.ts), so a check made
 * while holding it stays true through the write it is guarding.
 */
export function serverAuthProfileRejection(
  submittedId: string | undefined,
  rendered: RenderedAuthProfile | undefined,
  live: AuthProfile | undefined
): string | undefined {
  if (submittedId === undefined) {
    // No link: every credential on screen was the user's own, unlocked, and
    // `preserveLinkedServerCredentials` keeps all of it. Nothing to compare.
    return undefined;
  }
  if (live === undefined) {
    return MISSING_AUTH_PROFILE_MESSAGE;
  }
  if (rendered === undefined || rendered.id !== submittedId) {
    // The submission names a profile this form never showed credentials for —
    // a Save clicked between choosing one and its mirror answering. The fields
    // still hold the previous state, so the save would be decided against a
    // profile nobody has seen.
    return changedAuthProfileMessage(live);
  }
  if (rendered.signature !== authProfileOwnershipSignature(live)) {
    return changedAuthProfileMessage(live);
  }
  return undefined;
}

/**
 * The Auth Profile select's mirror payload for the SSH server form and the
 * unified profile form (`onAutofill`), the counterpart of the inventory source
 * form's `authProfileUsernameMirror`. Sends exactly the keys the profile owns
 * (`authProfileOwnedCredentials`), so the webview's own ownership record —
 * rebuilt from this payload — matches the render-time seed
 * (`authProfileFilledKeys`, ui/formDefinitions.ts) and matches what
 * `preserveLinkedServerCredentials` will keep at Save.
 *
 * `undefined` (not `{}`) for an id that resolves to no profile: that is
 * WebviewFormPanel's "no answer", which suppresses the fillFields round trip
 * entirely — touching the form when the profile is gone would be guessing.
 */
export function authProfileCredentialMirror(profile: AuthProfile | undefined): Record<string, string> | undefined {
  if (!profile) {
    return undefined;
  }
  const owned = authProfileOwnedCredentials(profile);
  const values: Record<string, string> = {};
  if (owned.username !== undefined) {
    values.username = owned.username;
  }
  if (owned.authType !== undefined) {
    values.authType = owned.authType;
  }
  if (owned.keyPath !== undefined) {
    values.keyPath = owned.keyPath;
  }
  return values;
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

export interface ConnectServerOptions {
  allowAutoFileExplorer?: boolean;
  /**
   * REVIEW FINDING (P2) — the session this call created never came up: its
   * initial SSH connect failed (`SshPtyCallbacks.onConnectFailed`,
   * services/ssh/sshPty.ts). `connectServer` itself RESOLVES in that case —
   * it resolves once the terminal exists, and the connect runs inside the pty
   * afterwards — so a caller that waits for the session to register needs this
   * to know the wait is over. It fires after `connectServer`'s own promise has
   * settled, hence a callback rather than a return value or a rejection.
   *
   * The SSH layer has already reported the CAUSE to the user by the time this
   * fires; a handler should say only what it adds (what did not happen next).
   */
  onConnectFailed?: (message: string) => void;
}

export async function connectServer(ctx: CommandContext, arg?: unknown, options: ConnectServerOptions = {}): Promise<void> {
  const server = toServerFromArg(ctx.core, arg) ?? (await pickServer(ctx.core));
  if (!server) {
    return;
  }
  const allowAutoFileExplorer = options.allowAutoFileExplorer ?? true;
  let autoFileExplorerHandled = false;

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Connecting to ${server.name}...`,
      cancellable: false
    },
    async () => {
      const terminalName = `Nexus SSH: ${server.name}`;
      let terminalRef: vscode.Terminal | undefined;
      let ptyRef: SshPty | undefined;
      const triggerObserver = ctx.macroAutoTrigger.createObserver(
        (text) => ptyRef?.handleInput(text),
        () => ctx.focusedTerminal === terminalRef,
        undefined,
        server.id
      );
      const osc7Observer = createOsc7Observer(ctx, server.id);
      const terminalType = vscode.workspace.getConfiguration("nexus.ssh").get<string>("terminalType", "xterm-256color");
      const pty = new SshPty(
        server,
        ctx.sshFactory,
        {
          onSessionOpened: (sessionId) => {
            ctx.core.registerSession({
              id: sessionId,
              serverId: server.id,
              terminalName,
              startedAt: Date.now(),
              pty: ptyRef
            });
            ctx.macroAutoTrigger.bindObserverToSession(triggerObserver, sessionId);
            osc7Observer.bindSessionId(sessionId);
            if (terminalRef) {
              ctx.sessionTerminals.set(sessionId, terminalRef);
            }
            if (ptyRef) {
              ctx.activityIndicators.set(sessionId, ptyRef);
            }

            // §5.4 hole (a): NexusCore.unregisterSession nulls focusedSessionId on
            // disconnect (nexusCore.ts:313-316), and onDidChangeActiveTerminal
            // never fires again on reconnect — the terminal never lost VS Code
            // focus. Without this, directory sync is a permanent no-op after any
            // reconnect. Re-assert focus here whenever this session's terminal is
            // the terminal VS Code currently considers active.
            if (vscode.window.activeTerminal === terminalRef) {
              ctx.core.setFocusedSession(sessionId);
            }

            if (
              allowAutoFileExplorer &&
              server.openFileExplorerOnFirstConnect &&
              !autoFileExplorerHandled
            ) {
              autoFileExplorerHandled = true;
              if (ctx.fileExplorerProvider.getActiveServerId() !== server.id) {
                void browseServerFiles(ctx, server);
              }
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
            ctx.activityIndicators.delete(sessionId);
            // Belt-and-braces alongside the onDisconnected cleanup below: a
            // terminal can close without ever going through onDisconnected
            // (SshPty.dispose() calls onSessionClosed directly, bypassing
            // handleDisconnect — see sshPty.ts), so clear here too rather than
            // leaking a tracker entry / lastOutputAt timestamp for a session
            // that never reconnects. Idempotent if onDisconnected already ran.
            ctx.cwdSyncCoordinator?.onSessionEnded(sessionId);
            ctx.cwdLastOutputAt?.delete(sessionId);
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
            ctx.activityIndicators.delete(sessionId);
            // §5.4 hole (b): sessionId is stable across reconnect (sshPty.ts:35),
            // including a reconnect to a *different* host after the user edits
            // host/port (extension.ts invalidates the pool on exactly that
            // change). Clear the tracker record and any pin owned by this
            // session so a stale cwd from the old host cannot survive into the
            // new connection. Also reset the OSC 7 parser's carry buffer so a
            // partial escape sequence stranded by the disconnect cannot
            // prepend to the reconnected session's first chunk (mirrors
            // SshPty.start()'s own oscFilter.reset() for the same reason).
            osc7Observer.resetParser();
            ctx.cwdSyncCoordinator?.onSessionEnded(sessionId);
            ctx.cwdLastOutputAt?.delete(sessionId);
            // Intentionally keep terminalsByServer entry (terminal is still
            // alive for reconnect) and do NOT stop auto-stop tunnels — they
            // will be cleaned up when the terminal is fully closed via
            // onSessionClosed.
          },
          onConnectFailed: (_sessionId, message) => {
            options.onConnectFailed?.(message);
          },
          onDataReceived: (sessionId) => {
            if (terminalRef && ctx.focusedTerminal !== terminalRef) {
              ctx.core.markSessionActivity(sessionId);
              ptyRef?.setActivityIndicator(true);
            }
          }
        },
        ctx.loggerFactory.create("terminal", server.id),
        createSessionTranscript(
          ctx.sessionLogDir,
          server.name,
          server.logSession ?? getDefaultSessionTranscriptsEnabled(),
          getTranscriptRotationOptions(ctx)
        ),
        ctx.highlighter,
        triggerObserver,
        terminalType
      );
      ptyRef = pty;
      pty.addOutputObserver(osc7Observer);
      const openInEditor = vscode.workspace.getConfiguration("nexus.terminal").get("openLocation") === "editor";
      const terminal = vscode.window.createTerminal({
        name: terminalName,
        pty,
        iconPath: new vscode.ThemeIcon("server"),
        color: new vscode.ThemeColor("terminal.ansiCyan"),
        location: openInEditor ? vscode.TerminalLocation.Editor : vscode.TerminalLocation.Panel
      });
      terminalRef = terminal;
      ctx.terminalRegistry?.register(terminal, pty);
      addTerminal(server.id, terminal, ctx.terminalsByServer);
      ctx.focusedTerminal = terminal;
      terminal.show();
    }
  );
}

function diagnosticField(value: string | number): string {
  return String(value).replace(/[\r\n]+/g, " ").trim();
}

function formatSshDiagnosticDetails(server: ServerConfig, diagnostic: ConnectionDiagnosticResult): string {
  return [
    `Server: ${diagnosticField(server.name)}`,
    `Host: ${diagnosticField(server.host)}`,
    `Port: ${diagnosticField(server.port)}`,
    `Stage: ${diagnostic.stage}`,
    `Title: ${diagnostic.title}`,
    `Detail: ${diagnostic.detail}`,
    `Suggestion: ${diagnostic.suggestion}`
  ].join("\n");
}

async function testServerConnection(ctx: CommandContext, arg?: unknown): Promise<void> {
  const server = toServerFromArg(ctx.core, arg) ?? (await pickServer(ctx.core));
  if (!server) {
    return;
  }

  try {
    const connection = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Testing connection to ${server.name}...`,
        cancellable: false
      },
      () => ctx.sshFactory.connect(server)
    );
    connection.dispose();
    void vscode.window.showInformationMessage(`Connection test succeeded for ${server.name}.`);
  } catch (error) {
    const diagnostic = classifySshConnectionError(error);
    const choice = await vscode.window.showErrorMessage(
      `${diagnostic.title}: ${diagnostic.detail}`,
      "Copy Details"
    );
    if (choice === "Copy Details") {
      await vscode.env.clipboard.writeText(formatSshDiagnosticDetails(server, diagnostic));
    }
  }
}

/**
 * Connect to a server (opening a fresh session) and auto-run a picked Nexus
 * script against it the moment the session registers. Invoked from the server
 * tree-item context menu entry "Run with script…".
 *
 * Implementation: captures the set of existing session ids for this server up
 * front, subscribes to `core.onDidChange`, and fires the script the first time
 * a new session for this server appears. Safety timeout (90s) unsubscribes if
 * the connect never produces a session (auth failure, network timeout).
 */
async function connectAndRunScript(ctx: CommandContext, arg?: unknown): Promise<void> {
  const server = toServerFromArg(ctx.core, arg) ?? (await pickServer(ctx.core));
  if (!server) return;
  if (!ctx.scriptRuntimeManager) {
    void vscode.window.showErrorMessage("Nexus script runtime is not available in this context.");
    return;
  }
  const scriptUri = await pickScriptFromWorkspace(ctx.globalStoragePath, "ssh");
  if (!scriptUri) return;

  const preExisting = new Set(
    ctx.core
      .getSnapshot()
      .activeSessions.filter((s) => s.serverId === server.id)
      .map((s) => s.id)
  );

  const timeoutMs = 90_000;
  let resolved = false;

  const unsubscribe = ctx.core.onDidChange(() => {
    if (resolved) return;
    const newSession = ctx.core
      .getSnapshot()
      .activeSessions.find((s) => s.serverId === server.id && !preExisting.has(s.id));
    if (!newSession) return;
    resolved = true;
    clearTimeout(timer);
    unsubscribe();
    // Fire the script — runScript itself logs to the Scripts output channel.
    void ctx.scriptRuntimeManager!.runScript(scriptUri, newSession.id).catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      void vscode.window.showErrorMessage(`Failed to start script after connect: ${message}`);
    });
  });

  const timer = setTimeout(() => {
    if (resolved) return;
    resolved = true;
    unsubscribe();
    void vscode.window.showWarningMessage(
      `Connected to ${server.name} but the script did not start within ${timeoutMs / 1000}s. ` +
        `Run the script manually if the session is live.`
    );
  }, timeoutMs);

  try {
    await connectServer(ctx, server.id, { allowAutoFileExplorer: false });
  } catch (err) {
    // connectServer can reject (auth failure, proxy error). Without this
    // the subscription + timer would leak until the 90-second watchdog.
    if (!resolved) {
      resolved = true;
      clearTimeout(timer);
      unsubscribe();
    }
    throw err;
  }
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

/**
 * F1 — server runtime teardown extracted from nexus.server.remove's own sequence
 * (below) so extension.ts can hand the exact same logic to
 * registerInventoryCommands as its `teardownServerRuntime` dependency: disconnect
 * terminals/sessions, stop every active tunnel routed through the server
 * (unconditionally — unlike disconnectServer's auto-stop-only tunnels), then
 * disconnect the pooled SSH connection. Does NOT touch saved secrets or the
 * server record itself — those stay the caller's job (nexus.server.remove
 * deletes both after this; inventory sync/removeSource delete vault secrets
 * separately and let applyInventorySyncPlan drop the server record).
 *
 * FINDING 5 (removal-teardown review) — deliberately does NOT delegate to
 * disconnectServer(ctx, serverId) the way it used to. disconnectServer's
 * fallback path resolves its `arg` through toServerFromArg(), whose `string`
 * branch does `core.getServer(arg)` — i.e. it requires the server record to
 * STILL EXIST in NexusCore. If it doesn't (missing → toServerFromArg returns
 * undefined), disconnectServer falls through to `pickServer(ctx.core)`, an
 * INTERACTIVE quickpick prompt — clearly wrong for a programmatic teardown
 * call, and exactly the trap a caller reordered to "apply the removal first,
 * then tear down only the ids actually removed" (removeSource's Delete
 * Servers flow) would fall into, since by the time teardown runs for a given
 * id the server record is already gone. None of the actual work below
 * (disposing this server's terminals, stopping its tunnels, disconnecting
 * its pooled SSH connection) needs anything from the ServerConfig object
 * besides the id we already have, so it's inlined directly against
 * `serverId` instead of re-resolving through core. Safe to call whether or
 * not `serverId` still names a server in NexusCore.
 *
 * FINDING 2 (P2, mid-teardown-recheck review) — a caller's pre-teardown
 * "still absent" check only guards against a replacement that existed
 * BEFORE this call started; it says nothing about a replacement created
 * DURING the awaits inside this function itself (the tunnel-stop
 * `Promise.all` below can take arbitrarily long). A replacement created in
 * that window gets its own new pooled SSH connection under the same
 * `serverId`, and an unconditional `sshPool.disconnect(serverId)` at the
 * end would then tear that brand-new connection down instead of the stale
 * one this call actually set out to clean up.
 *
 * `shouldAbort`, when provided, is rechecked after every await in this
 * function (currently the one after the tunnel-stop `Promise.all`) —
 * immediately before the next disposal step. A `true` result stops the
 * rest of teardown right there: already-completed steps (terminals
 * disposed, tunnels already stopped) are NOT undone or retried — an
 * acceptable, documented limitation, since those steps only ever acted on
 * the STALE server's own terminals/tunnels regardless of what shows up
 * afterward. Only the final `sshPool.disconnect` — the one step that could
 * otherwise hit a replacement's fresh connection — is guarded this way.
 * Callers that omit `shouldAbort` (the plain nexus.server.remove flow) get
 * the original, unconditional behavior.
 */
export async function teardownServerRuntime(ctx: CommandContext, serverId: string, shouldAbort?: () => boolean): Promise<void> {
  const terminals = ctx.terminalsByServer.get(serverId);
  if (terminals) {
    for (const terminal of terminals) {
      terminal.dispose();
    }
    ctx.terminalsByServer.delete(serverId);
  }
  const remaining = ctx.core.getSnapshot().activeTunnels.filter((t) => t.serverId === serverId);
  await Promise.all(remaining.map((t) => ctx.tunnelManager.stop(t.id)));
  if (shouldAbort?.()) {
    return;
  }
  ctx.sshPool.disconnect(serverId);
}

export function registerServerCommands(ctx: CommandContext): vscode.Disposable[] {
  return [
    vscode.commands.registerCommand("nexus.server.add", () => {
      void vscode.commands.executeCommand("nexus.profile.add", { addMode: "ssh", profileType: "ssh" });
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
      // Issue #48 — a caller that is sending the user here to fill in an
      // advanced field (a `${profile.ipmiHost}` refusal) says so, and the
      // section opens instead of hiding the field the error just named.
      if (arg && typeof arg === "object" && (arg as { expandAdvanced?: unknown }).expandAdvanced === true) {
        definition.expandAdvanced = true;
      }
      const inlineAuthProfile = createInlineAuthProfileCreation(ctx);
      // REVIEW FINDING (P1) — the profile shape this form is currently showing
      // credentials from, checked against live state at Save by
      // `serverAuthProfileRejection` (see its doc comment for the two ways an
      // unchecked submission goes wrong). Seeded from the SAME profile list the
      // definition above was built with, so it describes the render rather than
      // a second, later lookup; then re-stamped by every `onAutofill` answer,
      // which is the only other point at which this form is handed a profile's
      // credentials — a selection, and `addSelectOption` after an inline
      // create, both post one.
      let renderedAuthProfile: RenderedAuthProfile | undefined =
        existing.authProfileId !== undefined
          ? {
              id: existing.authProfileId,
              signature: authProfileOwnershipSignature(snapshot.authProfiles.find((p) => p.id === existing.authProfileId))
            }
          : undefined;
      const panel = WebviewFormPanel.open("server-edit", definition, {
        onSubmit: async (values) => {
          if (normalizeOptionalFolderPath(values.group) === null) {
            throw new Error(INVALID_FOLDER_PATH_MESSAGE);
          }
          const candidate = formValuesToServer(values, existing.id, existing.isHidden);
          if (!candidate) {
            return;
          }
          // P1 — the edit form has no field for `origin` (it's an inventory-sync
          // ownership marker, not a user-editable setting), so formValuesToServer's
          // reconstruction never carries it. Without restoring it here, saving any
          // edit to a synced server silently detaches it from inventory sync: the
          // next sync sees an unowned server squatting on the deterministic id and
          // skips the device forever (id-collision guard in syncEngine.ts).
          //
          // The restore is deferred to inside the mutation lock, below — it
          // must source `origin` from the LIVE record (`liveRecord`), not
          // from this form-open `existing` snapshot. If Remove Source → Keep
          // Servers stripped the live server's origin while this form was
          // open, `existing.origin` is a stale ownership marker; reattaching
          // it here would resurrect the dead source's ownership (an inert
          // synced badge, and a later same-id source import could then
          // manage a server it no longer owns). `liveRecord` reflects
          // whatever ownership state actually holds at write time: present →
          // keep it, stripped/absent → leave it absent.
          //
          // ADOPT 1 — `formerlySynced` is restored the same way, from the same
          // place, because it is the same bug in the same shape: the form has
          // no field for the marker either, so the reconstruction drops it and
          // saving ANY edit to a kept server destroys the one thing that makes
          // it adoptable — permanently, since a re-added source has no other
          // way to recognize it and nothing in the UI reports the loss. That
          // is not a corner case: renaming a kept server is the exact flow this
          // feature exists to serve, and it was the flow that broke it.
          //
          // Sourced from `liveRecord` for the mirror-image reason `origin` is,
          // in both directions. If a sync ADOPTED this server while the form
          // sat open, the live record has traded its marker for an `origin` —
          // and reattaching the stale marker from `existing` would leave a
          // record carrying BOTH, which the engine's first eligibility clause
          // makes inert but which still misrepresents the record's history. If
          // Remove Source → Keep Servers landed while the form sat open, the
          // live record gained a marker `existing` never had, and only the live
          // read preserves it.
          // FINDING 2 (P2, edit-race review) — the record persist and the
          // proxy-secret sync must commit as ONE generation with respect to
          // captureBackupStateForExport (configCommands.ts), which reads a
          // fresh server snapshot AND every server's proxy-password secret
          // together inside this SAME configMutationLock. Previously these
          // two awaits ran unlocked back-to-back: a backup capture landing
          // between them could pair this edit's NEW server record (new
          // proxy host/port/type) with the OLD proxy password still sitting
          // in the vault (capture runs first, reads pre-edit vault value,
          // edit's addOrUpdateServer already committed) — or the reverse,
          // pairing the OLD record with a NEW password if the capture's
          // server-snapshot read lands before this addOrUpdateServer but its
          // vault.get for this server's proxy password lands after
          // syncProxyPasswordSecret. Both are torn pairs. Nothing below this
          // point shows UI — see the lock's own contract — the info message
          // just after is fire-and-forget (`void`, never awaited) and stays
          // outside the lock regardless.
          await configMutationLock.runExclusive(async () => {
            // REVIEW FINDING (P1) — the profile is re-resolved against LIVE
            // core state (the select was populated when the form opened and
            // the form can sit open indefinitely) and checked against what
            // this form actually rendered, BEFORE anything is written and
            // while holding the lock every auth profile write also takes
            // (ui/authProfileEditorPanel.ts) — so the shape this save is
            // decided against cannot move between the check and the write.
            // This is the server form's copy of the guard the inventory
            // source form has always had (`inventoryAuthProfileRejection`,
            // commands/inventoryCommands.ts): throwing here reaches the user
            // as "Save failed: …" and leaves the panel open, which is what
            // both of its messages tell the user to act on.
            const linkedProfile = candidate.authProfileId ? ctx.core.getAuthProfile(candidate.authProfileId) : undefined;
            const authProfileRejection = serverAuthProfileRejection(candidate.authProfileId, renderedAuthProfile, linkedProfile);
            if (authProfileRejection) {
              throw new Error(authProfileRejection);
            }
            // Which submitted credentials are this user's own, and which the
            // stored record keeps — see preserveLinkedServerCredentials.
            const linked = preserveLinkedServerCredentials(existing, candidate, linkedProfile);
            const proxySecretKey = proxyPasswordSecretKey(existing.id);
            // FINDING 1 (P2, baseline-before-vault-read review) — this
            // secret-capture await MUST run BEFORE the baseline snapshot
            // (liveRecord) below, and nothing may await between that
            // baseline capture and the addOrUpdateServer(updated) write
            // further down. nexus.server.rename and nexus.server.remove
            // don't take configMutationLock (see the FINDING 1 comment in
            // the catch block below), so either can commit against this
            // same server id while THIS await is pending. Previously
            // liveRecord was captured BEFORE this await: a rename landing
            // during it produced a stale liveRecord, and a subsequently
            // failed secret write rolled back onto that stale snapshot,
            // silently discarding the rename. Capturing liveRecord AFTER
            // this await settles — and keeping everything from liveRecord
            // through addOrUpdateServer synchronous, with no further await
            // in between — closes that gap entirely.
            const priorSecretValue = ctx.secretVault ? await ctx.secretVault.get(proxySecretKey) : undefined;
            // FINDING 1 (P2, edit-rollback-staleness review) — capture the
            // LIVE record via ctx.core.getServer(existing.id), not the
            // form-open `existing` snapshot, and do it here — synchronously,
            // immediately after the vault-read above settles and
            // immediately before this generation's write lands. An edit or
            // deletion committed between form-open and this point (there is
            // no drift guard blocking that window; see below) means
            // `existing` can already be stale by the time we get here.
            // Rolling back to it on a failed secret write would silently
            // erase that intervening edit, or — if the record was deleted in
            // the meantime — resurrect a server the user just removed.
            // Capturing the live value immediately before the write it's
            // rolling back means the rollback always restores exactly what
            // this submission clobbered, not whatever was on screen when the
            // form opened (or whatever committed during the vault-read await
            // above).
            //
            // No drift guard: this deliberately does NOT block the edit
            // from proceeding when the live record differs from (or is
            // absent from) the form-open snapshot — last-writer-wins is
            // the existing behavior for the happy path too (addOrUpdateServer
            // unconditionally overwrites by id). Proceeding and relying on
            // the live-snapshot rollback below to undo cleanly on failure
            // is an accepted, intentional scope limit for this fix.
            const liveRecord = ctx.core.getServer(existing.id);
            // P1 — origin preservation (see the comment on `linked` above)
            // sources from `liveRecord`, captured immediately above, NOT
            // from the form-open `existing` snapshot: present → keep it,
            // stripped/absent (e.g. a Remove Source → Keep Servers that
            // landed while the form was open) → leave it absent. ADOPT 1 —
            // `formerlySynced` is carried across on identical terms; the
            // conditional spread is what keeps "absent stays absent" true for
            // both, rather than writing an explicit `undefined` key onto a
            // record that never had one.
            const updated: ServerConfig = {
              ...linked,
              ...(liveRecord?.origin !== undefined ? { origin: liveRecord.origin } : {}),
              ...(liveRecord?.formerlySynced !== undefined ? { formerlySynced: liveRecord.formerlySynced } : {})
            };
            // FINDINGS 2+3 (P2, edit-rollback review) — addOrUpdateServer
            // enforces single ownership of openFileExplorerOnFirstConnect:
            // if `updated` enables the flag, it clears it from whichever
            // OTHER server currently holds it. Capture that displaced owner
            // (if any) BEFORE the write below lands, so a failed secret sync
            // can hand its flag back — otherwise a rolled-back edit still
            // leaves the displaced owner cleared.
            const displacedOwner = updated.openFileExplorerOnFirstConnect
              ? ctx.core.getSnapshot().servers.find((s) => s.openFileExplorerOnFirstConnect && s.id !== updated.id)
              : undefined;
            // FINDING (P2, edit-rollback reference-sharing review) — when
            // `updated` enables openFileExplorerOnFirstConnect,
            // addOrUpdateServer stores `updated` itself into the live
            // servers map (no clone — see its `next = server` branch), so
            // `updated` and ctx.core.getServer(existing.id) become THE SAME
            // object reference from the moment addOrUpdateServer's own
            // synchronous map-set runs — which is BEFORE it awaits the
            // repository write, i.e. before this call below even returns.
            // An in-place mutator (e.g. _renameFolderPath rewriting `.group`
            // on whatever object currently sits in the map) landing during
            // EITHER that pending persist or the pending secret write further
            // below would then mutate `updated` itself. Capturing the
            // DETACHED structural snapshot (cloneServerConfig) AFTER
            // addOrUpdateServer's await settles is too late — a mutation
            // that lands during addOrUpdateServer's own pending save is
            // already baked into the clone, so the "still owned by this
            // submission" check further below would trivially match no
            // matter what changed, comparing the live record to a copy of
            // itself. Capture the snapshot HERE, before the write is even
            // issued, so it reflects exactly what THIS submission set out to
            // write and nothing an intervening mutation could have touched —
            // mirroring the same fix already applied in
            // NexusCore.applyInventorySyncPlan (see cloneServerConfig's own
            // doc comment).
            const writtenSnapshot = cloneServerConfig(updated);
            await ctx.core.addOrUpdateServer(updated);
            try {
              await syncProxyPasswordSecret(ctx, updated.id, values);
            } catch {
              // The record above just committed to the NEW generation, but
              // its proxy secret never did — left alone, the new record
              // would pair with the OLD password while the form reports
              // failure. Restore the LIVE pre-submit value captured above:
              // if a record existed live, put it back; if the record was
              // already gone (deleted mid-flight), remove the one this
              // submission just created rather than reviving anything. Both
              // are best-effort. A restore failure is reported honestly
              // (rather than retried or silently swallowed) since it means
              // the vault or the record no longer matches either
              // generation.
              //
              // FINDING 1 (P2, edit-rollback-race review) — nexus.server.rename
              // and nexus.server.remove don't take configMutationLock, so
              // either can commit against this SAME server id while this
              // catch is only reached after awaiting syncProxyPasswordSecret
              // above — i.e. after the lock body has already resumed from an
              // await, no longer exclusive in practice against unlocked
              // callers. An unconditional restore here would then erase a
              // concurrent rename, or resurrect a concurrent delete. Guard
              // it: only restore/remove when the CURRENT live record is
              // still structurally exactly what THIS submission's
              // addOrUpdateServer(updated) call wrote (serverConfigsEqual
              // against `writtenSnapshot`, the DETACHED clone captured
              // BEFORE that write was even issued — not the live `updated`
              // reference itself, which addOrUpdateServer may have stored
              // verbatim into the servers map when openFileExplorerOnFirstConnect
              // is enabled; comparing against that shared reference would
              // trivially "match" any in-place mutation applied to it in the
              // meantime, e.g. _renameFolderPath rewriting `.group`, and
              // silently undo a legitimate concurrent change).
              //
              // FINDING 2 (P2, edit-rollback-merge review) — if it differs,
              // something else already legitimately changed it since this
              // submission's own write — but that does NOT mean the whole
              // record should be left untouched. Skipping it wholesale used
              // to leave every field this now-rejected submission wrote
              // (e.g. a new proxy host/port) live, paired against whatever
              // the rollback below restores in the vault — a mismatched
              // pair. Instead, merge field-wise (mirrors
              // NexusCore.applyInventorySyncPlan's own rollback merge, see
              // mergeServerConfigFields' doc comment): a field the
              // concurrent change actually touched (current differs from
              // what THIS submission wrote) keeps its current value; every
              // other field falls back to `liveRecord` (the pre-submission
              // value), discarding this rejected submission's write for
              // that field. `liveRecord` undefined means this submission's
              // own write CREATED the record (no pre-submission state was
              // captured) — there is nothing to merge the concurrent change
              // onto, so the concurrently-mutated current record is kept
              // as-is, matching the same created-record exception in
              // NexusCore.applyInventorySyncPlan.
              try {
                const currentRecord = ctx.core.getServer(existing.id);
                if (currentRecord !== undefined) {
                  if (serverConfigsEqual(currentRecord, writtenSnapshot)) {
                    if (liveRecord) {
                      await ctx.core.addOrUpdateServer(liveRecord);
                    } else {
                      await ctx.core.removeServer(existing.id);
                    }
                  } else if (liveRecord) {
                    await ctx.core.addOrUpdateServer(mergeServerConfigFields(liveRecord, writtenSnapshot, currentRecord));
                  }
                  // else: created by this submission, then concurrently
                  // mutated — leave the concurrent mutation as-is.
                }
                // else: the record is gone for a reason other than this
                // generation's own rollback-eligible write (a concurrent
                // delete) — nothing to restore or merge onto.
              } catch {
                void vscode.window.showErrorMessage(
                  `Could not restore server "${existing.name}" to its previous settings after a failed save — re-check its record.`
                );
              }
              if (displacedOwner) {
                // Same concurrent-change rule as above, applied to the
                // displaced owner: if its live record is still exactly what
                // addOrUpdateServer(updated) left it (the captured record
                // with the flag cleared), hand the flag straight back.
                //
                // FINDING 2 (P2, displaced-owner-merge review) — if it's
                // since diverged (e.g. a concurrent rename of the displaced
                // owner), the old all-or-nothing check failed the
                // whole-record equality test and skipped the restore
                // entirely, leaving the flag cleared for good even though
                // nothing about THIS submission's rollback should depend on
                // fields the concurrent change touched. Restore ONLY the
                // flag onto whatever the displaced owner's CURRENT record
                // is, preserving every field the concurrent change touched,
                // unless:
                //  - the displaced owner was concurrently deleted
                //    (currentDisplaced is undefined) — nothing to restore
                //    the flag onto, or
                //  - some other server already holds the flag now (checked
                //    against the live snapshot, taken AFTER this
                //    submission's own record-rollback above has already
                //    run) — restoring here would violate the single-owner
                //    invariant addOrUpdateServer otherwise enforces.
                //
                // FINDING 1 (P2, current-flag-owner review) — the
                // currentFlagOwner check used to guard ONLY the divergent
                // (else) branch below, not the exact-match branch above it.
                // On the exact-match path, a concurrent command could have
                // enabled the flag on some OTHER server C while this
                // rollback was still pending — restoring it onto the
                // unchanged displaced owner B here would then silently clear
                // C's flag via addOrUpdateServer's single-owner enforcement,
                // even though B's restore has nothing to do with C's
                // legitimate, more recent change. Hoist the check so it
                // guards BOTH branches: skip the restore entirely whenever
                // another server currently holds the flag.
                try {
                  const currentDisplaced = ctx.core.getServer(displacedOwner.id);
                  if (currentDisplaced !== undefined) {
                    const currentFlagOwner = ctx.core.getSnapshot().servers.find((s) => s.openFileExplorerOnFirstConnect);
                    if (!currentFlagOwner) {
                      if (serverConfigsEqual(currentDisplaced, { ...displacedOwner, openFileExplorerOnFirstConnect: undefined })) {
                        await ctx.core.addOrUpdateServer({ ...displacedOwner, openFileExplorerOnFirstConnect: true });
                      } else {
                        await ctx.core.addOrUpdateServer({ ...currentDisplaced, openFileExplorerOnFirstConnect: true });
                      }
                    }
                  }
                  // else: the displaced owner was concurrently deleted —
                  // nothing to restore the flag onto.
                } catch {
                  void vscode.window.showErrorMessage(
                    `Could not restore the previous auto-open setting on "${displacedOwner.name}" after a failed save — re-check its settings.`
                  );
                }
              }
              // FINDING 3 (P2, orphaned-secret-on-concurrent-delete review)
              // — the record-rollback logic above correctly leaves a
              // concurrently-deleted server deleted (see its own "nothing to
              // restore or merge onto" branch a few lines up). Restoring the
              // prior secret value unconditionally here would then recreate
              // a proxy password for an id that no longer has a record — an
              // orphaned vault key that nexus.server.remove already cleaned
              // up when it deleted the server. Gate the restore on whether
              // the record is actually still present after the rollback
              // logic above has run: only store the prior value when it is;
              // otherwise make sure the vault key ends up deleted too
              // (best-effort, same treatment as the no-prior-value case).
              const recordStillPresentAfterRollback = ctx.core.getServer(existing.id) !== undefined;
              if (ctx.secretVault) {
                try {
                  if (recordStillPresentAfterRollback && priorSecretValue !== undefined) {
                    await ctx.secretVault.store(proxySecretKey, priorSecretValue);
                    // FINDING 2 (P2, post-store-presence review) — belt-and-
                    // braces on top of nexus.server.remove now serializing
                    // its own mutation phase under this SAME
                    // configMutationLock (see that command's own comment):
                    // re-check the record's presence AFTER this store's
                    // await has settled, and best-effort delete the key it
                    // just wrote if the record has vanished in the meantime.
                    // Covers any FUTURE lock-free deleter that might still
                    // slip a removal in between the presence check above and
                    // this store landing — without this, that race would
                    // leave exactly the orphaned vault key (a secret with no
                    // record to pair it with) this whole rollback exists to
                    // avoid.
                    if (ctx.core.getServer(existing.id) === undefined) {
                      try {
                        await ctx.secretVault.delete(proxySecretKey);
                      } catch {
                        // best-effort — ignore
                      }
                    }
                  } else {
                    await ctx.secretVault.delete(proxySecretKey);
                  }
                } catch {
                  void vscode.window.showErrorMessage(
                    `Could not restore the previous proxy password for "${existing.name}" after a failed save — re-check its proxy credentials.`
                  );
                }
              }
              throw new Error(`Could not store proxy credentials for "${existing.name}" — changes were not saved.`);
            }
          });
          if (ctx.core.isServerConnected(existing.id)) {
            void vscode.window.showInformationMessage(
              "Server profile updated. Existing sessions keep current connection settings until reconnect."
            );
          }
        },
        onBrowse: browseForKey,
        onCreateInline: inlineAuthProfile.handleCreateInline,
        onAutofill: async (_key, value) => {
          const profile = ctx.core.getAuthProfile(value);
          // Stamped from the SAME lookup the mirror is built from, so what the
          // form is about to show and what Save checks against are one fact.
          // `undefined` for an id that resolves to nothing: the mirror answers
          // nothing either (WebviewFormPanel then suppresses the fillFields
          // round trip entirely), so this form is showing no profile's
          // credentials and a Save carrying that id is refused as missing.
          renderedAuthProfile = profile
            ? { id: profile.id, signature: authProfileOwnershipSignature(profile) }
            : undefined;
          return authProfileCredentialMirror(profile);
        }
      });
      inlineAuthProfile.attachPanel(panel);
    }),

    vscode.commands.registerCommand("nexus.server.remove", async (arg?: unknown) => {
      const server = toServerFromArg(ctx.core, arg) ?? (await pickServer(ctx.core));
      if (!server) {
        return;
      }
      // `server` is the LIVE record (getServer/toServerFromArg/pickServer all
      // return the map's own object, not a copy) — e.g. nexus.group.rename
      // mutates `server.group` on that same object in place. Snapshot it
      // structurally, BEFORE the first await (the confirmation modal below),
      // so an in-place mutation that lands while the modal or the lock wait
      // is pending can't silently drag the comparand along with it and make
      // the in-lock revalidation below compare a mutated record against
      // itself. Use this detached clone for the confirmation text too, so
      // what the user sees matches what gets compared.
      const confirmedSnapshot = cloneServerConfig(server);
      const confirm = await vscode.window.showWarningMessage(
        `Remove server "${confirmedSnapshot.name}" and disconnect all sessions?`,
        { modal: true },
        "Remove"
      );
      if (confirm !== "Remove") {
        return;
      }
      // FINDING 2 (P2, remove-mutation-race review) — this flow used to run
      // its whole teardown+delete sequence lock-free. A concurrent
      // nexus.server.edit rollback (see the edit-path comments above) can
      // hold a pending vault.store for THIS SAME server id — if this
      // remove's key deletion below completed first, then the rollback's
      // store landed AFTER, the record would already be gone but the vault
      // key would reappear: an orphaned secret with no record to pair it
      // with. Serializing this span under configMutationLock (the SAME
      // singleton the edit rollback and inventory sync/backup flows already
      // use) makes the two flows strictly ordered instead of interleaved —
      // this also closes the equivalent remove-vs-inventory-sync and
      // remove-vs-backup-capture races. `server` is already resolved above
      // and the confirmation modal has already settled, so nothing
      // interactive runs inside this span — only disconnect/teardown,
      // tunnel stops, vault deletions, and the final core.removeServer.
      //
      // FINDING (P1, remove-lock-picker-fallback review) — `server` was
      // resolved BEFORE the confirmation modal and before waiting to
      // acquire this very lock; either wait can be arbitrarily long, and a
      // concurrent flow (inventory sync, another remove) can delete this
      // same record in the meantime. The lock body used to call
      // disconnectServer(ctx, server.id) first thing, whose fallback
      // resolves the id through toServerFromArg -> core.getServer — if the
      // record is already gone that resolves to undefined and
      // disconnectServer falls through to an INTERACTIVE pickServer
      // quickpick, opened while HOLDING configMutationLock (blocking every
      // other mutation in the app) and risking disconnecting an unrelated
      // server the user happens to pick. Re-check presence as the very
      // first thing inside the lock and bail out with an info message if
      // the record is already gone — nothing left to remove. Teardown
      // itself now goes through teardownServerRuntime(ctx, server.id), the
      // id-only, never-prompting variant (see its own doc comment) that
      // already disposes this server's terminals, stops ALL of its active
      // tunnels unconditionally, and disconnects the pooled SSH connection
      // — the exact same three effects the old disconnectServer() call
      // plus this span's own duplicate tunnel-stop/sshPool.disconnect lines
      // produced between them, now performed exactly once.
      await configMutationLock.runExclusive(async () => {
        const currentRecord = ctx.core.getServer(server.id);
        if (!currentRecord) {
          void vscode.window.showInformationMessage(`Server "${confirmedSnapshot.name}" was already removed.`);
          return;
        }
        // FINDING (revalidation was presence-only) — a presence check alone
        // cannot tell "still the record the user confirmed" apart from "a
        // DIFFERENT record that a replace-mode import (or another writer
        // ahead of us in the lock queue) recreated under the same id" while
        // this confirm modal was open or this flow was waiting for the
        // lock. Compare structurally against the captured, DETACHED
        // `confirmedSnapshot` and abort — distinct from the already-removed
        // message — rather than tearing down/deleting credentials for/
        // removing a record the user never actually confirmed removing.
        // Comparing against `server` itself would be comparing the live map
        // object against itself — an in-place mutation (e.g.
        // nexus.group.rename touching server.group) updates both sides at
        // once and the check would pass despite the change.
        if (!serverConfigsEqual(currentRecord, confirmedSnapshot)) {
          // Says what happened AND what it cost — "nothing was removed" is the
          // load-bearing half after a destructive click — then names the next
          // step's object rather than a bare "try again". Worded identically to
          // its three siblings in the same refusal family (nexus.tunnel.remove,
          // nexus.serial.remove, nexus.localShell.remove) and to the auth
          // profile refusals in commands/authProfileCommands.ts and
          // ui/authProfileEditorPanel.ts, so the whole family reads as one
          // system: "<subject> changed while the confirmation was open —
          // nothing was <verb>. <Next step> again to review …".
          //
          // GENERIC by necessity here, more than anywhere else in the family:
          // this compares the WHOLE record structurally, so "changed" covers a
          // rename, a port edit, a proxy change, a folder move — naming any one
          // of them would be a guess.
          void vscode.window.showWarningMessage(
            `Server "${confirmedSnapshot.name}" changed while the confirmation was open — nothing was removed. ` +
              "Remove it again to review the current details."
          );
          return;
        }
        await teardownServerRuntime(ctx, server.id);
        if (ctx.secretVault) {
          await ctx.secretVault.delete(passwordSecretKey(server.id));
          await ctx.secretVault.delete(passphraseSecretKey(server.id));
          await ctx.secretVault.delete(proxyPasswordSecretKey(server.id));
        }
        await ctx.core.removeServer(server.id);
      });
    }),

    vscode.commands.registerCommand("nexus.server.connect", (arg?: unknown) => connectServer(ctx, arg)),
    vscode.commands.registerCommand("nexus.server.testConnection", (arg?: unknown) => testServerConnection(ctx, arg)),
    vscode.commands.registerCommand("nexus.server.disconnect", (arg?: unknown) => disconnectServer(ctx, arg)),
    vscode.commands.registerCommand("nexus.server.runWithScript", (arg?: unknown) => connectAndRunScript(ctx, arg)),

    vscode.commands.registerCommand("nexus.server.copyInfo", async (arg?: unknown) => {
      const server = toServerFromArg(ctx.core, arg) ?? (await pickServer(ctx.core));
      if (!server) {
        return;
      }
      // Issue #48 — the BMC address rides along when there is one: whoever is
      // copying connection details to paste into a ticket or a shell wants it
      // too, and it is otherwise only visible behind the form's Advanced section.
      const ipmiHost = typeof server.ipmiHost === "string" ? server.ipmiHost.trim() : "";
      const info = `${server.username}@${server.host}:${server.port}${ipmiHost ? `\nIPMI/BMC: ${ipmiHost}` : ""}`;
      await vscode.env.clipboard.writeText(info);
      void vscode.window.showInformationMessage(`Copied: ${info.replace(/\n/g, "  ")}`);
    }),

    vscode.commands.registerCommand("nexus.server.duplicate", async (arg?: unknown) => {
      const server = toServerFromArg(ctx.core, arg) ?? (await pickServer(ctx.core));
      if (!server) {
        return;
      }
      // F6 — a duplicate of a synced server is a manual server: keeping `origin`
      // would make the copy compete with the original for the SAME deterministic
      // id on the next sync (both share externalId, but only one id can win it).
      //
      // ADOPT 1 — `formerlySynced` is dropped by exactly that reasoning, one
      // step further along: the marker is the adoption key, so a copy carrying
      // it hands a re-added source TWO candidates for one device (same
      // providerId, same externalId, and — a spread copy keeps host/port — the
      // same endpoint corroboration). That is the ambiguity the sync engine
      // resolves by adopting NEITHER and warning, so duplicating a kept server
      // would cost the ORIGINAL its adoption too, silently, until the user
      // deletes the copy. And it is the governing rule besides: a server the
      // user made by hand is never adoptable, and a duplicate is made by hand.
      const copy = {
        ...server,
        id: randomUUID(),
        name: `${server.name} (copy)`,
        openFileExplorerOnFirstConnect: undefined,
        origin: undefined,
        formerlySynced: undefined
      };
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
        .servers.filter((s) => s.group === folderPath && !s.isHidden);
      for (const server of servers) {
        void connectServer(ctx, server.id, { allowAutoFileExplorer: false });
      }
    }),

    vscode.commands.registerCommand("nexus.group.disconnect", async (arg?: unknown) => {
      if (!(arg instanceof FolderTreeItem)) {
        return;
      }
      const folderPath = arg.folderPath;
      const servers = ctx.core
        .getSnapshot()
        .servers.filter((s) => s.group === folderPath && !s.isHidden);
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

        const conversionMode = await pickDeployConversionMode(server.name, deployResult.alreadyDeployed);
        if (!conversionMode) {
          return;
        }

        const effectiveUsername = resolveEffectiveUsername(ctx.core, server);
        if (conversionMode === "standalone") {
          await ctx.core.addOrUpdateServer(buildStandaloneKeyServer(server, effectiveUsername, privateKeyPath));
          await maybeRemoveStoredPasswordAfterKeyConversion(ctx, server);
          return;
        }

        const profile = await pickOrCreateKeyAuthProfile(ctx, effectiveUsername, privateKeyPath);
        if (!profile) {
          return;
        }
        await ctx.core.addOrUpdateServer(
          buildProfileLinkedKeyServer(server, effectiveUsername, privateKeyPath, profile.id)
        );
        await maybeRemoveStoredPasswordAfterKeyConversion(ctx, server);
      } catch (err: any) {
        void vscode.window.showErrorMessage(`Deploy failed: ${err?.message ?? err}`);
      } finally {
        connection?.dispose();
      }
    })
  ];
}
