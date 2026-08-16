/**
 * Command handlers for the Embedded Network Servers subsystem (TFTP + DHCP).
 * Surface area:
 *   nexus.networkServer.start       — start a service with current settings
 *   nexus.networkServer.stop        — gracefully stop a running service
 *   nexus.networkServer.restart     — stop then start, re-reading settings so
 *                                     edits made while running take effect
 *   nexus.networkServer.edit        — open the service's configuration surface
 *   nexus.networkServer.inspectLogs — reveal the shared diagnostics channel
 *
 * There is no CRUD surface here: TFTP and DHCP are fixed singletons identified
 * by their {@link NetworkServerKind}, not user-created profiles, and everything
 * configurable lives in native VS Code settings rather than ConfigRepository.
 * Every command therefore resolves a *kind* — from a tree item when invoked
 * from the view, or from a quick pick when invoked from the Command Palette
 * with no argument.
 *
 * Trust is enforced twice by design: the manifest hides Start/Restart from the
 * palette in Restricted Mode, and `manager.assertTrusted()` refuses at runtime
 * for any other invocation path (keybinding, another extension, a tree item).
 */

import * as vscode from "vscode";
import { NetworkServerError, type NetworkServerKind } from "../models/networkServer";
import type { NetworkServerManager } from "../services/networkServers/networkServerManager";
import type { DhcpAdapterConfig, DhcpVendorSpecificEntry } from "../services/networkServers/core/index";
import { isValidSubOptionCode } from "../services/networkServers/dhcp/engine/dhcpBootOptions";
import { networkServerFormDefinition, type DhcpServerFormSeed } from "../ui/formDefinitions";
import type { FormValues } from "../ui/formTypes";
import { WebviewFormPanel } from "../ui/webviewFormPanel";
import { networkInterfaceBindOptions } from "./networkInterfaceOptions";
import type { CommandContext } from "./types";

/** `serviceKind`, not `kind` — `QuickPickItem.kind` is taken by VS Code. */
interface NetworkServerPick extends vscode.QuickPickItem {
  serviceKind: NetworkServerKind;
}

const NETWORK_SERVER_PICKS: readonly NetworkServerPick[] = [
  { label: "TFTP", description: "File transfer service (UDP 69)", serviceKind: "tftp" },
  { label: "DHCP", description: "Address assignment service (UDP 67)", serviceKind: "dhcp" }
];

function isNetworkServerKind(value: unknown): value is NetworkServerKind {
  return value === "tftp" || value === "dhcp";
}

function toNetworkServerKindFromArg(arg: unknown): NetworkServerKind | undefined {
  if (isNetworkServerKind(arg)) {
    return arg;
  }
  if (typeof arg === "object" && arg) {
    const withKind = arg as { kind?: unknown; session?: { kind?: unknown } };
    if (isNetworkServerKind(withKind.kind)) {
      return withKind.kind;
    }
    const session = withKind.session;
    if (session && isNetworkServerKind(session.kind)) {
      return session.kind;
    }
  }
  return undefined;
}

async function pickNetworkServerKind(title: string): Promise<NetworkServerKind | undefined> {
  const pick = await vscode.window.showQuickPick<NetworkServerPick>(NETWORK_SERVER_PICKS, { title });
  return pick?.serviceKind;
}

/** Value accepted by `WorkspaceConfiguration.update`; `undefined` clears the key. */
type SettingValue =
  | string
  | number
  | boolean
  | string[]
  | Record<string, string>
  | DhcpVendorSpecificEntry[]
  | undefined;

/** Blank collapses to `undefined` so the key is removed and the default applies. */
function readSettingString(value: FormValues[string]): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function readSettingNumber(value: FormValues[string]): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** Checkboxes arrive as `"on"` from the webview, or as a boolean under test. */
function readSettingBoolean(value: FormValues[string]): boolean {
  return value === true || value === "on" || value === "true";
}

function parseCommaList(value: FormValues[string]): string[] | undefined {
  if (typeof value !== "string") return undefined;
  const entries = value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  return entries.length > 0 ? entries : undefined;
}

/**
 * Parses the `MAC=IP` reservation textarea, mirroring the Local Server form's
 * `KEY=VALUE` environment table. Malformed lines are skipped rather than
 * rejected — one bad line must not discard the rest of the map, which is the
 * same tolerance `readStaticLeaseMap` applies when reading the setting back.
 */
function parseStaticLeases(value: FormValues[string]): Record<string, string> | undefined {
  if (typeof value !== "string") return undefined;
  const result: Record<string, string> = {};
  for (const rawLine of value.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const equalIdx = line.indexOf("=");
    if (equalIdx <= 0) continue;
    const mac = line.slice(0, equalIdx).trim();
    const ip = line.slice(equalIdx + 1).trim();
    if (!mac || !ip) continue;
    result[mac] = ip;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

/**
 * Parses the `CODE=VALUE` option 43 textarea into the setting's array form,
 * with the same skip-the-bad-line tolerance as {@link parseStaticLeases}.
 */
function parseVendorSpecificOptions(value: FormValues[string]): DhcpVendorSpecificEntry[] | undefined {
  if (typeof value !== "string") return undefined;
  const entries: DhcpVendorSpecificEntry[] = [];
  for (const rawLine of value.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const equalIdx = line.indexOf("=");
    if (equalIdx <= 0) continue;
    const subOption = Number(line.slice(0, equalIdx).trim());
    const optionValue = line.slice(equalIdx + 1).trim();
    if (!optionValue || !isValidSubOptionCode(subOption)) continue;
    entries.push({ subOption, value: optionValue });
  }
  return entries.length > 0 ? entries : undefined;
}

/**
 * Seeds the editor from the *raw* settings for the auto-linkable keys.
 *
 * `manager.readConfig` returns the resolved config, where an empty
 * `nextServer` has already been replaced by the TFTP interface. Showing that
 * derived address in the field would write it back as an explicit value on the
 * next save, silently freezing the link the user asked to keep automatic.
 */
function dhcpFormSeed(current: DhcpAdapterConfig): DhcpServerFormSeed {
  const section = vscode.workspace.getConfiguration("nexus.networkServers.dhcp");
  const rawAddresses = section.get<string[]>("tftpServerAddresses", []);
  return {
    ...current,
    nextServer: readSettingString(section.get<string>("nextServer", "")),
    tftpServerAddresses: Array.isArray(rawAddresses) && rawAddresses.length > 0 ? rawAddresses : undefined,
    autoLinkTftp: section.get<boolean>("autoLinkTftp", true) !== false
  };
}

function networkServerSettingUpdates(kind: NetworkServerKind, values: FormValues): Array<[string, SettingValue]> {
  if (kind === "tftp") {
    return [
      ["root", readSettingString(values.root)],
      ["port", readSettingNumber(values.port)],
      ["allowWrite", readSettingBoolean(values.allowWrite)],
      ["interface", readSettingString(values.interface)]
    ];
  }
  return [
    ["rangeStart", readSettingString(values.rangeStart)],
    ["rangeEnd", readSettingString(values.rangeEnd)],
    ["subnet", readSettingString(values.subnet)],
    ["gateway", readSettingString(values.gateway)],
    ["dns", parseCommaList(values.dns)],
    ["leaseTimeSec", readSettingNumber(values.leaseTimeSec)],
    ["serverId", readSettingString(values.serverId)],
    ["broadcast", readSettingString(values.broadcast)],
    ["interface", readSettingString(values.interface)],
    ["static", parseStaticLeases(values.static)],
    ["bootFileName", readSettingString(values.bootFileName)],
    ["nextServer", readSettingString(values.nextServer)],
    ["tftpServerAddresses", parseCommaList(values.tftpServerAddresses)],
    ["vendorClassId", readSettingString(values.vendorClassId)],
    ["vendorSpecificOptions", parseVendorSpecificOptions(values.vendorSpecificOptions)],
    ["autoLinkTftp", readSettingBoolean(values.autoLinkTftp)]
  ];
}

const DOTTED_QUAD = /^(?:(?:25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])\.){3}(?:25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])$/;

function compareIpv4(left: string, right: string): number {
  const a = left.split(".").map(Number);
  const b = right.split(".").map(Number);
  for (let i = 0; i < 4; i += 1) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

/** A mask is usable only if its set bits are contiguous from the top — `255.0.255.0` is not a subnet. */
function isContiguousMask(mask: string): boolean {
  const value = mask.split(".").reduce((acc, part) => ((acc << 8) | Number(part)) >>> 0, 0);
  const inverted = ~value >>> 0;
  return ((inverted + 1) & inverted) === 0;
}

/**
 * Sanity checks run before any setting is written, returning the first problem
 * as a message.
 *
 * `WebviewFormPanel` has no field-level validation hook a caller can drive (the
 * webview understands a `validationError` message, but nothing exposes a way to
 * send one), so this rides the mechanism that does exist: throwing out of
 * `onSubmit` reports the reason and leaves the panel open with the user's input
 * intact. Only non-blank values are checked — blank means "clear the key and
 * use the packaged default", which is always valid.
 */
function validateDhcpValues(values: FormValues): string | undefined {
  const rangeStart = readSettingString(values.rangeStart);
  const rangeEnd = readSettingString(values.rangeEnd);
  const subnet = readSettingString(values.subnet);
  for (const [label, value] of [
    ["Pool Start", rangeStart],
    ["Pool End", rangeEnd],
    ["Subnet Mask", subnet],
    ["Gateway", readSettingString(values.gateway)],
    ["Server Identifier", readSettingString(values.serverId)],
    ["Broadcast Address", readSettingString(values.broadcast)]
  ] as const) {
    if (value && !DOTTED_QUAD.test(value)) {
      return `${label} must be a dotted-quad IPv4 address (got "${value}").`;
    }
  }
  if (subnet && !isContiguousMask(subnet)) {
    return `Subnet Mask "${subnet}" is not a valid netmask — its set bits must be contiguous (e.g. 255.255.255.0).`;
  }
  if (rangeStart && rangeEnd && compareIpv4(rangeStart, rangeEnd) > 0) {
    return `Pool Start (${rangeStart}) must not be higher than Pool End (${rangeEnd}).`;
  }
  return undefined;
}

function errorMessageFor(error: unknown, prefix: string): string {
  if (error instanceof NetworkServerError) {
    return `${prefix}: ${error.message} (${error.code})`;
  }
  const message = error instanceof Error ? error.message : String(error);
  return `${prefix}: ${message}`;
}

export function registerNetworkServerCommands(
  ctx: CommandContext & { networkServerManager: NetworkServerManager }
): vscode.Disposable[] {
  const manager = ctx.networkServerManager;

  return [
    vscode.commands.registerCommand("nexus.networkServer.start", async (arg?: unknown) => {
      const kind = toNetworkServerKindFromArg(arg) ?? (await pickNetworkServerKind("Start Network Server"));
      if (!kind) return;
      try {
        await manager.start(kind);
      } catch (error) {
        void vscode.window.showErrorMessage(errorMessageFor(error, "Failed to start network server"));
      }
    }),

    vscode.commands.registerCommand("nexus.networkServer.stop", async (arg?: unknown) => {
      const kind = toNetworkServerKindFromArg(arg) ?? (await pickNetworkServerKind("Stop Network Server"));
      if (!kind) return;
      try {
        await manager.stop(kind);
      } catch (error) {
        void vscode.window.showErrorMessage(errorMessageFor(error, "Failed to stop network server"));
      }
    }),

    vscode.commands.registerCommand("nexus.networkServer.restart", async (arg?: unknown) => {
      const kind = toNetworkServerKindFromArg(arg) ?? (await pickNetworkServerKind("Restart Network Server"));
      if (!kind) return;
      try {
        await manager.restart(kind);
      } catch (error) {
        void vscode.window.showErrorMessage(errorMessageFor(error, "Failed to restart network server"));
      }
    }),

    vscode.commands.registerCommand("nexus.networkServer.edit", async (arg?: unknown) => {
      const kind = toNetworkServerKindFromArg(arg) ?? (await pickNetworkServerKind("Edit Network Server"));
      if (!kind) return;
      const service = kind.toUpperCase();
      const seed =
        kind === "dhcp" ? dhcpFormSeed(manager.readConfig(kind) as DhcpAdapterConfig) : manager.readConfig(kind);
      // Enumerated per open, never cached: a VPN coming up or a dock being
      // unplugged changes the answer between one Edit and the next.
      const form = networkServerFormDefinition(kind, seed, { interfaceOptions: networkInterfaceBindOptions() });
      WebviewFormPanel.open(`network-server-edit-${kind}`, form, {
        onSubmit: async (values) => {
          const problem = kind === "dhcp" ? validateDhcpValues(values) : undefined;
          if (problem) {
            // Thrown, not reported here: WebviewFormPanel turns this into a
            // "Save failed" message and leaves the panel open with the input.
            throw new Error(problem);
          }
          const section = vscode.workspace.getConfiguration(`nexus.networkServers.${kind}`);
          // Global target only: these services are machine-level (they bind
          // ports on this host), so scoping them to whichever folder happens to
          // be open would make the same lab setup vanish in the next window.
          for (const [key, value] of networkServerSettingUpdates(kind, values)) {
            await section.update(key, value, vscode.ConfigurationTarget.Global);
          }
          // Adapters read their configuration in the constructor, so a live
          // service keeps serving the settings it started with until restarted.
          if (ctx.core.getNetworkServerSession(kind)?.status !== "running") return;
          const choice = await vscode.window.showInformationMessage(
            `Restart ${service} to apply the new settings?`,
            "Restart"
          );
          if (choice !== "Restart") return;
          try {
            await manager.restart(kind);
          } catch (error) {
            void vscode.window.showErrorMessage(errorMessageFor(error, "Failed to restart network server"));
          }
        }
      });
    }),

    vscode.commands.registerCommand("nexus.networkServer.inspectLogs", () => {
      const channel = ctx.networkServerOutputChannel;
      if (!channel) {
        void vscode.window.showInformationMessage("Network server diagnostics are not available.");
        return;
      }
      // preserveFocus: reading the log should not steal focus from the terminal
      // or editor the user was working in.
      channel.show(true);
    })
  ];
}
