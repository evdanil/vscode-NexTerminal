/**
 * The fast, keyboard-only editor for the two network services.
 *
 * On a bench the same three or four values get changed over and over — which
 * NIC, where the pool starts, how big it is — and a webview form is a slow way
 * to change one of them. This is the quick path: a quick pick of the settings
 * that actually move, each opening a single input box or nested pick, writing
 * straight through to `nexus.networkServers.<kind>.*`. Everything structured
 * (ZTP boot options, static reservations) stays in the full form, reachable
 * from the trailing escape-hatch item.
 *
 * Settings are re-read on every pass of the loop rather than captured once, so
 * the list always shows what was just saved — and stays right if the user edits
 * `settings.json` in another window mid-session.
 */

import * as vscode from "vscode";
import type { NetworkServerKind } from "../models/networkServer";
import { DEFAULTS } from "../services/networkServers/dhcp/engine/dhcpConstants";
import { networkInterfaceBindOptions } from "./networkInterfaceOptions";
import {
  NETWORK_SERVER_LABELS,
  currentPoolCount,
  dhcpPoolProblem,
  dhcpRangeEndForCount,
  isValidIpv4
} from "./networkServerSettings";

export interface NetworkServerQuickAdjustDeps {
  /** Whether the service is currently serving, i.e. whether a restart is needed to apply. */
  readonly isRunning: () => boolean;
  readonly restart: () => Promise<void>;
  /** Escape hatch to the full `WebviewFormPanel` form for this service. */
  readonly openFullForm: () => void;
  /** Stores the settings currently in effect under a name. */
  readonly saveProfile: () => Promise<void>;
  /**
   * Applies a saved profile, resolving `true` when one was actually written.
   *
   * Injected rather than invoked as a command so the restart prompt stays where
   * the rest of this editor's edits already put it — at the end of the session,
   * once — instead of firing a second time from inside the apply.
   */
  readonly loadProfile: () => Promise<boolean>;
}

/** `edited` is the only outcome that can leave a running service out of date. */
type QuickAdjustOutcome = "edited" | "unchanged" | "full";

interface QuickAdjustItem extends vscode.QuickPickItem {
  readonly run: () => Promise<QuickAdjustOutcome>;
}

/** Separators carry no `run`, so a picked row has to be narrowed before use. */
type QuickAdjustRow = QuickAdjustItem | vscode.QuickPickItem;

const SERVICE_LABELS = NETWORK_SERVER_LABELS;

function settingsSection(kind: NetworkServerKind): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration(`nexus.networkServers.${kind}`);
}

/**
 * Raw setting, not the resolved one.
 *
 * `readDhcpConfig` substitutes derived values (an auto-linked TFTP address, for
 * one), and seeding an editor with a derived value writes it back as an
 * explicit setting on the next save.
 */
function rawString(section: vscode.WorkspaceConfiguration, key: string): string | undefined {
  const value = section.get<string>(key, "");
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed.length > 0 ? trimmed : undefined;
}

async function writeSetting(kind: NetworkServerKind, key: string, value: string | number | boolean | undefined): Promise<void> {
  // Global target only: these services bind ports on this machine, so scoping
  // them to whichever folder happens to be open would make the same lab setup
  // vanish in the next window.
  await settingsSection(kind).update(key, value, vscode.ConfigurationTarget.Global);
}

/**
 * One text setting, edited in an input box.
 *
 * Escape (`undefined`) and an unchanged value are both `unchanged` — only a
 * genuinely different value is written, so browsing the list never marks the
 * service as needing a restart. An empty submit is a real edit: it clears the
 * key and hands the setting back to its packaged default.
 */
async function editString(options: {
  kind: NetworkServerKind;
  key: string;
  title: string;
  prompt: string;
  placeholder: string;
  current: string | undefined;
  validate?: (value: string) => string | undefined;
}): Promise<QuickAdjustOutcome> {
  const seed = options.current ?? "";
  const entered = await vscode.window.showInputBox({
    title: options.title,
    prompt: options.prompt,
    placeHolder: options.placeholder,
    value: seed,
    ignoreFocusOut: true,
    validateInput: (raw) => {
      const trimmed = raw.trim();
      return trimmed.length > 0 ? options.validate?.(trimmed) : undefined;
    }
  });
  if (entered === undefined) return "unchanged";
  const trimmed = entered.trim();
  if (trimmed === seed) return "unchanged";
  await writeSetting(options.kind, options.key, trimmed.length > 0 ? trimmed : undefined);
  return "edited";
}

async function editNumber(options: {
  kind: NetworkServerKind;
  key: string;
  title: string;
  prompt: string;
  placeholder: string;
  current: number | undefined;
  min: number;
  max: number;
}): Promise<QuickAdjustOutcome> {
  const seed = options.current === undefined ? "" : String(options.current);
  const entered = await vscode.window.showInputBox({
    title: options.title,
    prompt: options.prompt,
    placeHolder: options.placeholder,
    value: seed,
    ignoreFocusOut: true,
    validateInput: (raw) => {
      const trimmed = raw.trim();
      if (!trimmed) return undefined;
      const parsed = Number(trimmed);
      if (!Number.isInteger(parsed)) return "Enter a whole number.";
      if (parsed < options.min || parsed > options.max) {
        return `Enter a number between ${String(options.min)} and ${String(options.max)}.`;
      }
      return undefined;
    }
  });
  if (entered === undefined) return "unchanged";
  const trimmed = entered.trim();
  if (trimmed === seed) return "unchanged";
  await writeSetting(options.kind, options.key, trimmed.length > 0 ? Number(trimmed) : undefined);
  return "edited";
}

interface BindPick extends vscode.QuickPickItem {
  readonly address: string;
}

function describeInterface(configured: string | undefined): string {
  return configured && configured !== "0.0.0.0" ? configured : "all interfaces (0.0.0.0)";
}

/**
 * The bind-address picker, enumerated per open — a VPN coming up or a dock
 * being unplugged changes the answer between one edit and the next. An address
 * the setting holds but this machine no longer has is kept in the list and
 * flagged, so confirming the current value cannot silently rebind the service
 * to every interface.
 */
async function editInterface(kind: NetworkServerKind, configured: string | undefined): Promise<QuickAdjustOutcome> {
  const current = configured === "0.0.0.0" ? "" : (configured ?? "");
  const options = networkInterfaceBindOptions();
  const known = options.some((option) => option.value === current)
    ? options
    : [...options, { label: `${current} — not currently available`, value: current }];
  const pick = await vscode.window.showQuickPick<BindPick>(
    known.map((option) => ({
      label: option.label,
      description: option.value === current ? "current" : undefined,
      address: option.value
    })),
    { title: `${SERVICE_LABELS[kind]} — Interface`, placeHolder: "Which NIC serves this service" }
  );
  if (!pick || pick.address === current) return "unchanged";
  await writeSetting(kind, "interface", pick.address.length > 0 ? pick.address : undefined);
  return "edited";
}

interface AccessPick extends vscode.QuickPickItem {
  readonly allowWrite: boolean;
}

async function editTftpAccess(current: boolean): Promise<QuickAdjustOutcome> {
  const pick = await vscode.window.showQuickPick<AccessPick>(
    [
      {
        label: "Read Only (RO)",
        description: current ? undefined : "current",
        detail: "Reject write requests (WRQ).",
        allowWrite: false
      },
      {
        label: "Read/Write (RW)",
        description: current ? "current" : undefined,
        detail: "TFTP has no authentication — anything that can reach the port could overwrite files.",
        allowWrite: true
      }
    ],
    { title: "TFTP — Access Mode", placeHolder: "Whether remote hosts may upload into the root" }
  );
  if (!pick || pick.allowWrite === current) return "unchanged";
  await writeSetting("tftp", "allowWrite", pick.allowWrite);
  return "edited";
}

function tftpQuickItems(): QuickAdjustItem[] {
  const section = settingsSection("tftp");
  const root = rawString(section, "root");
  const bindAddress = rawString(section, "interface");
  const port = section.get<number>("port", 69);
  const allowWrite = section.get<boolean>("allowWrite", false) === true;
  return [
    {
      label: "$(folder) Root Directory",
      description: root ?? "~/Nexus/tftp-root (default)",
      run: () =>
        editString({
          kind: "tftp",
          key: "root",
          title: "TFTP — Root Directory",
          prompt: "Every file beneath this directory is readable by any host that can reach the port. Leave empty for the default.",
          placeholder: "~/Nexus/tftp-root (default)",
          current: root
        })
    },
    {
      label: "$(plug) Interface",
      description: describeInterface(bindAddress),
      run: () => editInterface("tftp", bindAddress)
    },
    {
      label: "$(radio-tower) Port",
      description: `UDP ${String(port)}`,
      run: () =>
        editNumber({
          kind: "tftp",
          key: "port",
          title: "TFTP — Port",
          prompt: "UDP 69 is privileged; if binding is denied the service falls back to 1069 and logs a warning.",
          placeholder: "69",
          current: port,
          min: 1,
          max: 65535
        })
    },
    {
      label: "$(lock) Access Mode",
      description: allowWrite ? "Read/Write (RW)" : "Read Only (RO)",
      run: () => editTftpAccess(allowWrite)
    }
  ];
}

/**
 * Moving the pool start keeps the pool the same size.
 *
 * Start + count is the model the user is being shown, so a new start has to
 * carry the count with it — leaving `rangeEnd` where it was would silently
 * resize (or invert) the pool. The count that survives is validated against the
 * new start before anything is written.
 */
async function editPoolStart(
  current: string | undefined,
  count: number,
  subnet: string | undefined
): Promise<QuickAdjustOutcome> {
  const seed = current ?? "";
  const entered = await vscode.window.showInputBox({
    title: "DHCP — Pool Start",
    prompt: `First address of the dynamic pool. The pool keeps its current size of ${String(count)} addresses.`,
    placeHolder: `${DEFAULTS.rangeStart} (default)`,
    value: seed,
    ignoreFocusOut: true,
    validateInput: (raw) => {
      const trimmed = raw.trim();
      if (!trimmed) return undefined;
      if (!isValidIpv4(trimmed)) return `Pool Start must be a dotted-quad IPv4 address (got "${trimmed}").`;
      return dhcpPoolProblem(trimmed, count, subnet);
    }
  });
  if (entered === undefined) return "unchanged";
  const trimmed = entered.trim();
  if (trimmed === seed) return "unchanged";
  const rangeStart = trimmed.length > 0 ? trimmed : undefined;
  await writeSetting("dhcp", "rangeStart", rangeStart);
  await writeSetting("dhcp", "rangeEnd", dhcpRangeEndForCount(rangeStart, count));
  return "edited";
}

/**
 * The pool size, stored as the `rangeEnd` it implies.
 *
 * The underlying settings are unchanged — `rangeStart`/`rangeEnd` remain the
 * real keys, so a `settings.json` power user sees exactly what they always did.
 * Only what the editor asks for is different.
 */
async function editPoolCount(
  rangeStart: string | undefined,
  current: number,
  subnet: string | undefined
): Promise<QuickAdjustOutcome> {
  const seed = current > 0 ? String(current) : "";
  const start = rangeStart ?? DEFAULTS.rangeStart;
  const entered = await vscode.window.showInputBox({
    title: "DHCP — Pool Count",
    prompt: `How many addresses the pool hands out, starting at ${start}. Saved as the pool's end address.`,
    placeHolder: "190 (default)",
    value: seed,
    ignoreFocusOut: true,
    validateInput: (raw) => {
      const trimmed = raw.trim();
      if (!trimmed) return undefined;
      const parsed = Number(trimmed);
      if (!Number.isInteger(parsed)) return "Pool Count must be a whole number.";
      return dhcpPoolProblem(rangeStart, parsed, subnet);
    }
  });
  if (entered === undefined) return "unchanged";
  const trimmed = entered.trim();
  if (trimmed === seed) return "unchanged";
  await writeSetting("dhcp", "rangeEnd", dhcpRangeEndForCount(rangeStart, trimmed.length > 0 ? Number(trimmed) : undefined));
  return "edited";
}

function dhcpQuickItems(): QuickAdjustItem[] {
  const section = settingsSection("dhcp");
  const bindAddress = rawString(section, "interface");
  const rangeStart = rawString(section, "rangeStart");
  const rangeEnd = rawString(section, "rangeEnd");
  const subnet = rawString(section, "subnet");
  const leaseTimeSec = section.get<number>("leaseTimeSec", DEFAULTS.leaseTimeSec);
  const count = currentPoolCount(rangeStart, rangeEnd);
  return [
    {
      label: "$(plug) Interface",
      description: describeInterface(bindAddress),
      run: () => editInterface("dhcp", bindAddress)
    },
    {
      label: "$(globe) Pool Start",
      description: rangeStart ?? `${DEFAULTS.rangeStart} (default)`,
      run: () => editPoolStart(rangeStart, count, subnet)
    },
    {
      label: "$(list-ordered) Pool Count",
      // The end address is the thing actually stored, so it is shown too —
      // otherwise a count-only row hides what a peer reading settings.json sees.
      description: count > 0 ? `${String(count)} addresses → ${rangeEnd ?? DEFAULTS.rangeEnd}` : "pool range is invalid",
      run: () => editPoolCount(rangeStart, count, subnet)
    },
    {
      label: "$(clock) Lease Time",
      description: `${String(leaseTimeSec)}s`,
      run: () =>
        editNumber({
          kind: "dhcp",
          key: "leaseTimeSec",
          title: "DHCP — Lease Time (seconds)",
          prompt: "Lease duration handed to clients (option 51). Clamped to 60 seconds minimum and 7 days maximum.",
          placeholder: String(DEFAULTS.leaseTimeSec),
          current: leaseTimeSec,
          min: 60,
          max: 604_800
        })
    }
  ];
}

/**
 * The trailing actions section: the whole configuration in and out of a named
 * preset, kept apart from the field rows above it because these two do not edit
 * one setting — they replace or capture the lot.
 */
function profileRows(kind: NetworkServerKind, deps: NetworkServerQuickAdjustDeps): QuickAdjustRow[] {
  return [
    { label: "", kind: vscode.QuickPickItemKind.Separator },
    {
      label: "$(save) Save current as profile…",
      description: `Store these ${SERVICE_LABELS[kind]} settings under a name`,
      run: async (): Promise<QuickAdjustOutcome> => {
        await deps.saveProfile();
        return "unchanged";
      }
    },
    {
      label: "$(archive) Load profile…",
      description: "Replace these settings with a saved profile",
      run: async (): Promise<QuickAdjustOutcome> => ((await deps.loadProfile()) ? "edited" : "unchanged")
    }
  ];
}

function fullFormItem(kind: NetworkServerKind): QuickAdjustItem {
  return {
    label:
      kind === "dhcp" ? "$(gear) More settings (ZTP, static leases…)" : "$(gear) More settings (all TFTP options)",
    description: "Open the full settings form",
    run: () => Promise.resolve("full")
  };
}

/**
 * Runs the quick editor until the user dismisses it, then offers the restart
 * that a live service needs to pick the changes up.
 *
 * The prompt fires once at the end rather than after each field: adapters read
 * their configuration in the constructor, so a running service keeps serving
 * what it started with either way, and asking per field would interrupt a run
 * of three quick edits three times.
 */
export async function openNetworkServerQuickAdjust(
  kind: NetworkServerKind,
  deps: NetworkServerQuickAdjustDeps
): Promise<void> {
  const service = SERVICE_LABELS[kind];
  let edited = false;
  for (;;) {
    const items = kind === "tftp" ? tftpQuickItems() : dhcpQuickItems();
    const pick = await vscode.window.showQuickPick<QuickAdjustRow>(
      [...items, ...profileRows(kind, deps), fullFormItem(kind)],
      {
        title: `${service} — Quick Settings`,
        placeHolder: "Pick a setting to change, or press Escape when you are done"
      }
    );
    if (!pick) break;
    if (!("run" in pick)) continue;
    const outcome = await pick.run();
    if (outcome === "edited") edited = true;
    if (outcome !== "full") continue;
    // Settled before handing over: the full form seeds itself from the saved
    // settings, so a pending quick edit would otherwise reach the service only
    // if the user also saved the form.
    await promptRestart(service, edited, deps);
    deps.openFullForm();
    return;
  }
  await promptRestart(service, edited, deps);
}

async function promptRestart(service: string, edited: boolean, deps: NetworkServerQuickAdjustDeps): Promise<void> {
  if (!edited || !deps.isRunning()) return;
  const choice = await vscode.window.showInformationMessage(
    `Restart ${service} to apply the new settings?`,
    "Restart"
  );
  if (choice !== "Restart") return;
  await deps.restart();
}
