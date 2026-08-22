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
import { networkInterfaceBindOptions, networkInterfaceNameForAddress } from "./networkInterfaceOptions";
import {
  NETWORK_SERVER_LABELS,
  currentPoolCount,
  dhcpDerivedAddresses,
  dhcpPoolProblem,
  dhcpRangeEndForCount,
  isContiguousMask,
  isValidIpv4
} from "./networkServerSettings";
import type { SettingValue } from "./networkServerSettings";

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

async function writeSetting(kind: NetworkServerKind, key: string, value: SettingValue): Promise<void> {
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
 * The NIC behind the configured bind address, resolved on every open.
 *
 * The setting stores an address, not an interface name, so the row alone cannot
 * say whether that address is still on this machine — a dock unplugged or a VPN
 * dropped since it was set leaves a value that looks fine and binds nothing.
 * Naming the interface it currently belongs to answers both questions at once,
 * and an address no NIC holds is called out rather than silently formatted.
 */
function describeInterfaceDetail(configured: string | undefined): string {
  if (!configured || configured === "0.0.0.0") {
    return "Every IPv4 address on this machine — no single NIC, so no current IP to show.";
  }
  const name = networkInterfaceNameForAddress(configured);
  return name
    ? `${name} — current IP ${configured}`
    : `No interface on this machine currently holds ${configured} — current IP unknown.`;
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

interface ConfirmPick extends vscode.QuickPickItem {
  readonly confirmed: boolean;
}

/**
 * Whether a setting may be recomputed from a new pool start.
 *
 * Blank is the codebase's existing "no opinion" signal — an unset key means the
 * packaged default applies — so a blank value is always fair game. Beyond that,
 * only a value this auto-fill would itself have written for the *previous* pool
 * start is replaced: that is a stale suggestion, not a decision, and leaving it
 * behind is how a move from one lab subnet to another ends up advertising the
 * old subnet's gateway. Anything else the user typed is left exactly as typed.
 */
function isAutoFillable(current: string | undefined, previousDerived: string | undefined): boolean {
  return current === undefined || (previousDerived !== undefined && current === previousDerived);
}

function isDnsAutoFillable(current: readonly string[], previousDerived: readonly string[] | undefined): boolean {
  if (current.length === 0) return true;
  if (previousDerived === undefined) return false;
  return current.length === previousDerived.length && current.every((value, index) => value === previousDerived[index]);
}

const AUTO_FILL_LABELS: Readonly<Record<string, string>> = {
  gateway: "Gateway",
  broadcast: "Broadcast",
  dns: "DNS"
};

/**
 * Offers the addresses a new pool start implies — gateway, broadcast, DNS.
 *
 * The pool's own end address is not part of the offer: {@link editPoolStart}
 * already recomputes it unconditionally to preserve the pool size, and asking
 * about something that has already happened would misreport what the answer
 * changes.
 *
 * The netmask in force is respected rather than assumed: an explicit `subnet`
 * of, say, `255.255.254.0` derives a `.255`-crossing broadcast and the gateway
 * below it, and only an unset mask falls back to /24.
 *
 * Confirmation is asked for rather than assumed. Nothing in the settings marks
 * a value as machine-suggested, so silence would be indistinguishable from the
 * editor overwriting fields the user never opened — and the prompt is skipped
 * entirely when every candidate is already a deliberate value, which is the
 * case that would have been annoying.
 */
async function offerPoolAutoFill(
  rangeStart: string,
  previousStart: string | undefined,
  subnet: string | undefined
): Promise<void> {
  const derived = dhcpDerivedAddresses(rangeStart, subnet);
  if (!derived) return;
  const previous = previousStart ? dhcpDerivedAddresses(previousStart, subnet) : undefined;

  const section = settingsSection("dhcp");
  const dns = section
    .get<string[]>("dns", [])
    .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
    .filter((entry) => entry.length > 0);

  const writes: Array<[string, string | string[]]> = [];
  if (isAutoFillable(rawString(section, "gateway"), previous?.gateway)) writes.push(["gateway", derived.gateway]);
  if (isAutoFillable(rawString(section, "broadcast"), previous?.broadcast)) writes.push(["broadcast", derived.broadcast]);
  if (isDnsAutoFillable(dns, previous?.dns)) writes.push(["dns", [...derived.dns]]);
  if (writes.length === 0) return;

  const summary = writes
    .map(([key, value]) => `${AUTO_FILL_LABELS[key]} ${Array.isArray(value) ? value.join(", ") : value}`)
    .join("  ·  ");
  const pick = await vscode.window.showQuickPick<ConfirmPick>(
    [
      { label: "$(check) Yes, auto-fill", detail: summary, confirmed: true },
      {
        label: "$(close) No, I'll set them manually",
        detail: "Leave the other addresses exactly as they are.",
        confirmed: false
      }
    ],
    {
      title: "DHCP — Auto-Fill",
      placeHolder: `Fill in the addresses that follow from ${rangeStart}?`,
      ignoreFocusOut: true
    }
  );
  if (!pick?.confirmed) return;
  for (const [key, value] of writes) {
    await writeSetting("dhcp", key, value);
  }
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
  // Only a concrete start is worth deriving from: clearing the field hands the
  // whole pool back to the packaged defaults, which are already consistent.
  if (rangeStart) await offerPoolAutoFill(rangeStart, current, subnet);
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
  const gateway = rawString(section, "gateway");
  const leaseTimeSec = section.get<number>("leaseTimeSec", DEFAULTS.leaseTimeSec);
  const count = currentPoolCount(rangeStart, rangeEnd);
  return [
    {
      label: "$(plug) Interface",
      description: describeInterface(bindAddress),
      detail: describeInterfaceDetail(bindAddress),
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
      label: "$(circuit-board) Subnet Mask",
      description: subnet ?? `${DEFAULTS.subnet} (default)`,
      run: () =>
        editString({
          kind: "dhcp",
          key: "subnet",
          title: "DHCP — Subnet Mask",
          prompt:
            "Netmask handed to clients (option 1). It also derives the broadcast address while that is left empty. Leave empty for the default.",
          placeholder: `${DEFAULTS.subnet} (default)`,
          current: subnet,
          validate: (value) => {
            if (!isValidIpv4(value)) return `Subnet Mask must be a dotted-quad IPv4 address (got "${value}").`;
            if (!isContiguousMask(value)) {
              return `Subnet Mask "${value}" is not a valid netmask — its set bits must be contiguous (e.g. 255.255.255.0).`;
            }
            // A narrower mask can put the existing pool past the new broadcast,
            // so the pool is re-checked here rather than only where it is edited.
            return dhcpPoolProblem(rangeStart, count, value);
          }
        })
    },
    {
      label: "$(arrow-right) Default Gateway",
      description: gateway ?? `${DEFAULTS.gateway} (default)`,
      run: () =>
        editString({
          kind: "dhcp",
          key: "gateway",
          title: "DHCP — Default Gateway",
          prompt: "Default route handed to clients (option 3). Leave empty for the default.",
          placeholder: `${DEFAULTS.gateway} (default)`,
          current: gateway,
          validate: (value) =>
            isValidIpv4(value) ? undefined : `Default Gateway must be a dotted-quad IPv4 address (got "${value}").`
        })
    },
    {
      label: "$(clock) Lease Time",
      description: `${String(leaseTimeSec)}s`,
      run: () =>
        editNumber({
          kind: "dhcp",
          key: "leaseTimeSec",
          title: "DHCP — Lease Time (seconds)",
          prompt: "Lease duration handed to clients (option 51). Values below 60 seconds or above 7 days fall back to the 24-hour default.",
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
