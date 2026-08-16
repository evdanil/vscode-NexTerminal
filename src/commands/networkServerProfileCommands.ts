/**
 * Command handlers for named TFTP/DHCP configuration profiles. Surface area:
 *   nexus.networkServer.profile.saveCurrent — snapshot the live settings of one
 *                                             service under a name
 *   nexus.networkServer.profile.apply       — write a saved snapshot back into
 *                                             those settings, then offer the
 *                                             restart a live service needs
 *   nexus.networkServer.profile.rename / duplicate / remove — standard CRUD
 *
 * A profile is config, not runtime: these commands talk to `NexusCore` (which
 * persists through `ConfigRepository`) and to `vscode.workspace.getConfiguration`,
 * never to the daemon. Applying one is exactly the write the full form and the
 * quick pick already perform, from a stored source instead of a typed one — so
 * a running service keeps serving what it started with until it is restarted,
 * the same as after any other settings edit.
 *
 * Trust is not re-checked here for the same reason `nexus.networkServer.edit`
 * does not: managing configuration binds no port and serves no file. The
 * Restricted-Mode gate sits on start/restart, which is where the capability is.
 */

import { randomUUID } from "node:crypto";
import * as vscode from "vscode";
import type { NexusCore } from "../core/nexusCore";
import type { NetworkServerKind } from "../models/networkServer";
import {
  cloneDhcpProfile,
  cloneTftpProfile,
  type NetworkServerConfigProfile
} from "../models/networkServerProfile";
import { configMutationLock } from "../services/configMutationLock";
import type { DhcpAdapterConfig } from "../services/networkServers/core/index";
import type { NetworkServerManager } from "../services/networkServers/networkServerManager";
import { readDhcpConfig, readTftpConfig } from "../services/networkServers/networkServerManager";
import { naturalCompare } from "../utils/naturalCompare";
import {
  NETWORK_SERVER_LABELS,
  networkServerProfileSettingUpdates,
  readSettingString
} from "./networkServerSettings";
import type { CommandContext } from "./types";

const NETWORK_SERVER_KINDS: readonly NetworkServerKind[] = ["tftp", "dhcp"];

function isNetworkServerKind(value: unknown): value is NetworkServerKind {
  return value === "tftp" || value === "dhcp";
}

/**
 * Current DHCP settings as a profile body.
 *
 * The auto-linkable keys are read *raw* rather than taken from
 * `readDhcpConfig`'s result, for the same reason the full form seeds itself
 * that way: by then an empty `nextServer` has already been replaced by the TFTP
 * interface, and storing that derived address would freeze a link the user
 * asked to keep automatic. `readDhcpConfig` is called without a storage path so
 * `leaseStorePath` stays unset — it is a machine-local path, not a setting, and
 * never travels with a profile.
 */
function captureDhcpProfileBody(): { config: DhcpAdapterConfig; autoLinkTftp: boolean } {
  const section = vscode.workspace.getConfiguration("nexus.networkServers.dhcp");
  const rawAddresses = section.get<string[]>("tftpServerAddresses", []);
  return {
    config: {
      ...readDhcpConfig(),
      nextServer: readSettingString(section.get<string>("nextServer", "")),
      tftpServerAddresses:
        Array.isArray(rawAddresses) && rawAddresses.length > 0 ? [...rawAddresses] : undefined
    },
    autoLinkTftp: section.get<boolean>("autoLinkTftp", true) !== false
  };
}

function listProfiles(core: NexusCore, kind: NetworkServerKind): NetworkServerConfigProfile[] {
  const snapshot = core.getSnapshot();
  const profiles: NetworkServerConfigProfile[] = kind === "tftp" ? [...snapshot.tftpProfiles] : [...snapshot.dhcpProfiles];
  return profiles.sort((a, b) => naturalCompare(a.name, b.name));
}

function getProfile(core: NexusCore, kind: NetworkServerKind, id: string): NetworkServerConfigProfile | undefined {
  return kind === "tftp" ? core.getTftpProfile(id) : core.getDhcpProfile(id);
}

async function persistProfile(core: NexusCore, profile: NetworkServerConfigProfile): Promise<void> {
  if (profile.kind === "tftp") {
    await core.addOrUpdateTftpProfile(profile);
    return;
  }
  await core.addOrUpdateDhcpProfile(profile);
}

async function deleteProfile(core: NexusCore, kind: NetworkServerKind, id: string): Promise<void> {
  if (kind === "tftp") {
    await core.removeTftpProfile(id);
    return;
  }
  await core.removeDhcpProfile(id);
}

/** `serviceKind`, not `kind` — `QuickPickItem.kind` is taken by VS Code. */
interface ProfileKindPick extends vscode.QuickPickItem {
  readonly serviceKind: NetworkServerKind;
}

/**
 * Which service's profiles to work with, when the invocation carried no answer.
 *
 * Shows how many each kind holds, so the palette route does not lead into an
 * empty picker without warning.
 */
async function pickProfileKind(core: NexusCore, title: string): Promise<NetworkServerKind | undefined> {
  const snapshot = core.getSnapshot();
  const counts: Record<NetworkServerKind, number> = {
    tftp: snapshot.tftpProfiles.length,
    dhcp: snapshot.dhcpProfiles.length
  };
  const pick = await vscode.window.showQuickPick<ProfileKindPick>(
    NETWORK_SERVER_KINDS.map((serviceKind) => ({
      label: NETWORK_SERVER_LABELS[serviceKind],
      description: counts[serviceKind] === 1 ? "1 saved profile" : `${String(counts[serviceKind])} saved profiles`,
      serviceKind
    })),
    { title }
  );
  return pick?.serviceKind;
}

interface ProfilePick extends vscode.QuickPickItem {
  readonly profile: NetworkServerConfigProfile;
}

async function pickProfile(
  core: NexusCore,
  kind: NetworkServerKind,
  title: string
): Promise<NetworkServerConfigProfile | undefined> {
  const profiles = listProfiles(core, kind);
  if (profiles.length === 0) {
    void vscode.window.showInformationMessage(
      `No saved ${NETWORK_SERVER_LABELS[kind]} profiles yet — use "Save current as profile" first.`
    );
    return undefined;
  }
  const pick = await vscode.window.showQuickPick<ProfilePick>(
    profiles.map((profile) => ({ label: profile.name, description: profile.description, profile })),
    { title, placeHolder: "Pick a saved configuration" }
  );
  return pick?.profile;
}

function toProfileFromArg(core: NexusCore, arg: unknown): NetworkServerConfigProfile | undefined {
  if (typeof arg !== "object" || arg === null) {
    return undefined;
  }
  const candidate = (arg as { profile?: unknown }).profile ?? arg;
  if (typeof candidate !== "object" || candidate === null) {
    return undefined;
  }
  const { id, kind } = candidate as { id?: unknown; kind?: unknown };
  if (typeof id !== "string" || !isNetworkServerKind(kind)) {
    return undefined;
  }
  // Resolved against the core rather than trusted as passed: a tree item can
  // outlive an edit made through another surface.
  return getProfile(core, kind, id);
}

function toKindFromArg(arg: unknown): NetworkServerKind | undefined {
  if (isNetworkServerKind(arg)) {
    return arg;
  }
  if (typeof arg === "object" && arg) {
    const { kind } = arg as { kind?: unknown };
    if (isNetworkServerKind(kind)) {
      return kind;
    }
  }
  return undefined;
}

function defaultProfileName(kind: NetworkServerKind): string {
  return `${NETWORK_SERVER_LABELS[kind]} — ${new Date().toISOString().slice(0, 10)}`;
}

async function promptProfileName(title: string, seed: string): Promise<string | undefined> {
  const entered = await vscode.window.showInputBox({
    title,
    prompt: 'A name you will recognise later, e.g. "Lab VLAN99".',
    value: seed,
    ignoreFocusOut: true,
    validateInput: (value) => (value.trim() ? undefined : "Name cannot be empty")
  });
  const trimmed = entered?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * The optional second step of a save.
 *
 * Escape here means "no description", not "cancel the save" — the name box is
 * where a save is abandoned, and making an optional field the last chance to
 * back out only loses the work already confirmed.
 */
async function promptProfileDescription(): Promise<string | undefined> {
  const entered = await vscode.window.showInputBox({
    title: "Profile Description (optional)",
    prompt: "What this preset is for. Leave empty to skip.",
    ignoreFocusOut: true
  });
  const trimmed = entered?.trim();
  return trimmed ? trimmed : undefined;
}

function profileRemovalDisclosure(profile: NetworkServerConfigProfile): string {
  const service = NETWORK_SERVER_LABELS[profile.kind];
  return `Remove the ${service} profile "${profile.name}"? The saved snapshot is deleted; the live ${service} settings are left exactly as they are.`;
}

/**
 * Stores the settings currently in effect for one service under a new name.
 *
 * Always a new record, never an overwrite of a same-named one: two presets that
 * differ only in a detail the name does not capture is a normal bench outcome,
 * and silently replacing the older one would lose it.
 */
export async function saveCurrentNetworkServerProfile(core: NexusCore, kind: NetworkServerKind): Promise<void> {
  const service = NETWORK_SERVER_LABELS[kind];
  const name = await promptProfileName(`Save Current ${service} Settings As…`, defaultProfileName(kind));
  if (!name) return;
  const description = await promptProfileDescription();
  if (kind === "tftp") {
    await core.addOrUpdateTftpProfile({ id: randomUUID(), kind: "tftp", name, description, config: readTftpConfig() });
  } else {
    const body = captureDhcpProfileBody();
    await core.addOrUpdateDhcpProfile({
      id: randomUUID(),
      kind: "dhcp",
      name,
      description,
      config: body.config,
      autoLinkTftp: body.autoLinkTftp
    });
  }
  void vscode.window.showInformationMessage(`Saved ${service} profile "${name}".`);
}

/**
 * Writes a profile into the live settings.
 *
 * Global target only, like every other write to these keys: the services bind
 * ports on this machine, so a folder-scoped preset would vanish in the next
 * window. Deliberately silent about restarting — the callers differ on when to
 * ask, and asking twice for one apply is worse than asking once.
 */
export async function applyNetworkServerProfile(profile: NetworkServerConfigProfile): Promise<void> {
  const section = vscode.workspace.getConfiguration(`nexus.networkServers.${profile.kind}`);
  for (const [key, value] of networkServerProfileSettingUpdates(profile)) {
    await section.update(key, value, vscode.ConfigurationTarget.Global);
  }
}

/**
 * Picks a saved profile and applies it, resolving to the profile that was
 * applied — or `undefined` if the user backed out or had nothing saved.
 */
export async function loadNetworkServerProfile(
  core: NexusCore,
  kind: NetworkServerKind
): Promise<NetworkServerConfigProfile | undefined> {
  const profile = await pickProfile(core, kind, `Load ${NETWORK_SERVER_LABELS[kind]} Profile`);
  if (!profile) return undefined;
  await applyNetworkServerProfile(profile);
  return profile;
}

function duplicateOf(profile: NetworkServerConfigProfile): NetworkServerConfigProfile {
  const name = `${profile.name} (copy)`;
  return profile.kind === "tftp"
    ? { ...cloneTftpProfile(profile), id: randomUUID(), name }
    : { ...cloneDhcpProfile(profile), id: randomUUID(), name };
}

export function registerNetworkServerProfileCommands(
  ctx: CommandContext & { networkServerManager: NetworkServerManager }
): vscode.Disposable[] {
  const manager = ctx.networkServerManager;

  /**
   * Adapters read their configuration in the constructor, so a live service
   * keeps serving the settings it started with until it is restarted.
   */
  const offerRestart = async (kind: NetworkServerKind): Promise<void> => {
    if (ctx.core.getNetworkServerSession(kind)?.status !== "running") return;
    const service = NETWORK_SERVER_LABELS[kind];
    const choice = await vscode.window.showInformationMessage(
      `Restart ${service} to apply the new settings?`,
      "Restart"
    );
    if (choice !== "Restart") return;
    try {
      await manager.restart(kind);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      void vscode.window.showErrorMessage(`Failed to restart network server: ${message}`);
    }
  };

  const resolveProfile = async (
    arg: unknown,
    title: string
  ): Promise<NetworkServerConfigProfile | undefined> => {
    const fromArg = toProfileFromArg(ctx.core, arg);
    if (fromArg) return fromArg;
    const kind = toKindFromArg(arg) ?? (await pickProfileKind(ctx.core, title));
    if (!kind) return undefined;
    return pickProfile(ctx.core, kind, title);
  };

  return [
    vscode.commands.registerCommand("nexus.networkServer.profile.saveCurrent", async (arg?: unknown) => {
      const kind = toKindFromArg(arg) ?? (await pickProfileKind(ctx.core, "Save Current Settings As Profile"));
      if (!kind) return;
      await saveCurrentNetworkServerProfile(ctx.core, kind);
    }),

    vscode.commands.registerCommand("nexus.networkServer.profile.apply", async (arg?: unknown) => {
      const profile = await resolveProfile(arg, "Load Network Server Profile");
      if (!profile) return;
      await applyNetworkServerProfile(profile);
      void vscode.window.showInformationMessage(
        `Applied ${NETWORK_SERVER_LABELS[profile.kind]} profile "${profile.name}".`
      );
      await offerRestart(profile.kind);
    }),

    vscode.commands.registerCommand("nexus.networkServer.profile.rename", async (arg?: unknown) => {
      const profile = await resolveProfile(arg, "Rename Network Server Profile");
      if (!profile) return;
      const newName = await promptProfileName("Rename Profile", profile.name);
      if (!newName || newName === profile.name) return;
      await persistProfile(ctx.core, { ...profile, name: newName });
    }),

    vscode.commands.registerCommand("nexus.networkServer.profile.duplicate", async (arg?: unknown) => {
      const profile = await resolveProfile(arg, "Duplicate Network Server Profile");
      if (!profile) return;
      await persistProfile(ctx.core, duplicateOf(profile));
    }),

    vscode.commands.registerCommand("nexus.networkServer.profile.remove", async (arg?: unknown) => {
      const profile = await resolveProfile(arg, "Remove Network Server Profile");
      if (!profile) return;
      const kind = profile.kind;
      const profileId = profile.id;
      const confirmedName = profile.name;
      const shownDisclosure = profileRemovalDisclosure(profile);
      const confirm = await vscode.window.showWarningMessage(shownDisclosure, { modal: true }, "Remove");
      if (confirm !== "Remove") return;
      let alreadyRemoved: string | undefined;
      let refusal: string | undefined;
      await configMutationLock.runExclusive(async () => {
        const current = getProfile(ctx.core, kind, profileId);
        if (!current) {
          alreadyRemoved = `Profile "${confirmedName}" was already removed.`;
          return;
        }
        if (profileRemovalDisclosure(current) !== shownDisclosure) {
          refusal =
            `Profile "${confirmedName}" changed while the confirmation was open — ` +
            "nothing was removed. Remove it again to review the current details.";
          return;
        }
        await deleteProfile(ctx.core, kind, profileId);
      });
      if (alreadyRemoved !== undefined) {
        void vscode.window.showInformationMessage(alreadyRemoved);
        return;
      }
      if (refusal !== undefined) {
        void vscode.window.showWarningMessage(refusal);
      }
    })
  ];
}
