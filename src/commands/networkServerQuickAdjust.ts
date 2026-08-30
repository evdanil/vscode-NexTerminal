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
import type { NetworkInterfaceOption } from "./networkInterfaceOptions";
import {
  NETWORK_SERVER_LABELS,
  currentPoolCount,
  dhcpCidrDerivation,
  dhcpCidrProblem,
  dhcpCurrentCidr,
  dhcpDerivedAddresses,
  dhcpInterfaceSubnetStatus,
  dhcpPoolProblem,
  dhcpRangeEndForCount,
  isAutoFillable,
  isContiguousMask,
  isDnsAutoFillable,
  isValidIpv4,
  refreshDhcpServerIdentifier,
  suggestBindAddressForPool
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
 * The pool a DHCP bind address is meant to serve, for the rows that compare the
 * two.
 *
 * Snapshotted per pass of the editor loop, like every other setting read here —
 * no watcher, no polling. Quick Adjust re-enumerates the NICs each time it is
 * opened, and a NIC appearing while an input box is up is not a case worth a
 * background subscription.
 */
interface PoolSubnetContext {
  readonly rangeStart: string | undefined;
  readonly subnet: string | undefined;
  /**
   * With a relay agent in front of it, serving a subnet this machine is not on
   * is the point, so none of the off-subnet reporting applies.
   */
  readonly allowRelayAgents: boolean;
}

function dhcpPoolSubnetContext(section: vscode.WorkspaceConfiguration): PoolSubnetContext {
  return {
    rangeStart: rawString(section, "rangeStart"),
    subnet: rawString(section, "subnet"),
    allowRelayAgents: section.get<boolean>("allowRelayAgents", false) === true
  };
}

/**
 * The NIC behind the configured bind address, resolved on every open.
 *
 * The setting stores an address, not an interface name, so the row alone cannot
 * say whether that address is still on this machine — a dock unplugged or a VPN
 * dropped since it was set leaves a value that looks fine and binds nothing.
 * Naming the interface it currently belongs to answers both questions at once,
 * and an address no NIC holds is called out rather than silently formatted.
 *
 * For DHCP the row answers one more question the address alone cannot: whether
 * the NIC is on the subnet the pool hands out. A server bound to `192.168.1.x`
 * offering `10.0.0.x` leases binds, listens and serves nothing usable, and
 * every individual setting behind that is valid.
 *
 * That question is asked for an all-interfaces bind too, which is why the
 * "every address on this machine" case no longer returns before reaching it.
 * Listening on every NIC is not the same as being on every subnet: with no NIC
 * on the pool's wire the DISCOVERs never arrive, and the row that used to be
 * the reassuring one was the only place the user was told nothing about it.
 */
function describeInterfaceDetail(configured: string | undefined, pool?: PoolSubnetContext): string {
  const bindsEveryInterface = !configured || configured === "0.0.0.0";
  const name = bindsEveryInterface ? undefined : networkInterfaceNameForAddress(configured);
  const base = bindsEveryInterface
    ? "Every IPv4 address on this machine — no single NIC, so no current IP to show."
    : name
      ? `${name} — current IP ${configured}`
      : `No interface on this machine currently holds ${configured} — current IP unknown.`;
  if (!pool) return base;
  const status = dhcpInterfaceSubnetStatus(
    configured,
    pool.subnet,
    pool.rangeStart,
    networkInterfaceBindOptions(),
    pool.allowRelayAgents
  );
  if (status !== "mismatch" && status !== "all-interfaces-off-subnet") return base;
  const cidr = dhcpCurrentCidr(pool.rangeStart, pool.subnet);
  // Two different faults, so two different sentences: one names a NIC that is
  // on the wrong wire, the other says there is no right wire to be on.
  const complaint =
    status === "all-interfaces-off-subnet"
      ? "no NIC on this machine is on the pool's subnet"
      : "not on the pool's subnet";
  return cidr ? `${base} · ${complaint} (${cidr})` : `${base} · ${complaint}`;
}

/** Whether one offered address sits on the pool's subnet, as a plain fact. */
function isOnPoolSubnet(
  address: string,
  pool: PoolSubnetContext,
  interfaces: readonly NetworkInterfaceOption[]
): boolean {
  // Deliberately asks with relay support switched off: "is this NIC on the
  // pool's subnet" has the same answer either way, and it is the *warning* that
  // a relay agent makes irrelevant, not the fact.
  return dhcpInterfaceSubnetStatus(address, pool.subnet, pool.rangeStart, interfaces, false) === "match";
}

/**
 * The Server Identifier a rebind implies, or `undefined` to leave it alone.
 *
 * REVIEW FINDING (P1) — the Interface row is the third place a bind address
 * changes, and the only one that was never taught this. The CIDR rows move the
 * pool under a fixed bind; this row moves the bind under a fixed pool, and
 * option 54 is a function of both. Switching from `10.0.0.5` to `10.0.0.6` used
 * to write `interface` alone, leaving the identifier — copied verbatim into
 * every OFFER/ACK and into the BOOTP `siaddr` a ZTP client boots from — naming
 * the address the socket no longer answers on.
 *
 * Nothing but a pass-through now: the whole "resolve for the new state, resolve
 * for the one it replaces, write only if the configured value is still the old
 * resolution" shape is {@link refreshDhcpServerIdentifier}, shared with the two
 * CIDR rows that had independently grown their own copy of it. The gate is
 * therefore identical by construction rather than by inspection: only a value
 * the PREVIOUS bind address would itself have resolved to is recomputed, so an
 * identifier the user typed survives a NIC change. The pool does not move here,
 * so both endpoints carry the same `rangeStart`/`subnet` and only the bind
 * address differs — which is exactly the question being asked.
 *
 * REVIEW FINDING (P1, fifth round — relay with an explicit held bind) — relay
 * mode used to abstain here unconditionally, and that was too broad. A relayed
 * pool is on a wire this machine holds no NIC on, so no NIC can be *suggested*
 * from the pool; but the address just picked in the Interface picker is one this
 * machine holds by construction, and it is the address the socket is about to
 * answer from. Rebinding `10.0.0.5` → `10.0.0.6` under a relay left option 54
 * and BOOTP `siaddr` naming `.5`, exactly the fault this row was added to fix,
 * with the relay flag as the only difference. The flag is now forwarded rather
 * than acted on here; `resolveDhcpServerIdentifier` holds the two-branch
 * contract and still abstains for a bind that names no single held address.
 *
 * An off-subnet pick is not special-cased either. The picker allows one (it
 * annotates the matching NICs rather than restricting the list), and the
 * resolver answers it under its own no-guess contract: without a relay the new
 * bind is not a `match`, so the question falls back to "is there a single NIC on
 * the pool's subnet" — that NIC when there is exactly one, `undefined` when
 * there are none or several. `undefined` leaves the configured identifier
 * untouched, because no confident answer is not a licence to write one.
 *
 * Written without {@link confirmAutoFill}, unlike the CIDR rows' identifier
 * write. Those rows derive a setting the user never opened a picker for; this
 * one is a side effect of a choice the Quick Pick itself already confirmed —
 * a second dialog would be asking the user to approve the NIC they just
 * approved.
 */
function rebindServerIdentifier(
  previousBind: string,
  nextBind: string,
  pool: PoolSubnetContext,
  interfaces: readonly NetworkInterfaceOption[],
  section: vscode.WorkspaceConfiguration
): string | undefined {
  return refreshDhcpServerIdentifier({
    next: { rangeStart: pool.rangeStart, subnet: pool.subnet, bindAddress: nextBind },
    previous: { rangeStart: pool.rangeStart, subnet: pool.subnet, bindAddress: previousBind },
    interfaces,
    allowRelayAgents: pool.allowRelayAgents,
    configuredServerId: rawString(section, "serverId")
  });
}

/**
 * The bind-address picker, enumerated per open — a VPN coming up or a dock
 * being unplugged changes the answer between one edit and the next. An address
 * the setting holds but this machine no longer has is kept in the list and
 * flagged, so confirming the current value cannot silently rebind the service
 * to every interface.
 *
 * For DHCP, the NICs already on the pool's subnet say so, and a single
 * unambiguous one is lifted to just below the all-interfaces row — the list is
 * usually short, but the one entry that is certainly right should not be found
 * by reading addresses octet by octet. Two or more matches are all annotated and
 * none is promoted: picking one of them would be a coin toss the editor has no
 * business making.
 *
 * A DHCP rebind carries the Server Identifier with it when that identifier is
 * still the old NIC's — see {@link rebindServerIdentifier}. TFTP passes no pool
 * and has no such setting, so the branch is inert there.
 */
async function editInterface(
  kind: NetworkServerKind,
  configured: string | undefined,
  pool?: PoolSubnetContext,
  section?: vscode.WorkspaceConfiguration
): Promise<QuickAdjustOutcome> {
  const current = configured === "0.0.0.0" ? "" : (configured ?? "");
  const options = networkInterfaceBindOptions();
  const known = options.some((option) => option.value === current)
    ? [...options]
    : [...options, { label: `${current} — not currently available`, value: current }];

  const suggestion = pool
    ? suggestBindAddressForPool(pool.rangeStart, pool.subnet, options, pool.allowRelayAgents)
    : undefined;
  if (suggestion && !suggestion.ambiguous) {
    const index = known.findIndex((option) => option.value === suggestion.address);
    // Index 1: immediately after the all-interfaces row, which keeps the lead.
    if (index > 1) known.splice(1, 0, ...known.splice(index, 1));
  }

  const pick = await vscode.window.showQuickPick<BindPick>(
    known.map((option) => {
      const notes: string[] = [];
      if (option.value === current) notes.push("current");
      if (pool && !isAllInterfacesValue(option.value) && isOnPoolSubnet(option.value, pool, options)) {
        notes.push("matches the pool subnet");
      }
      return {
        label: option.label,
        description: notes.length > 0 ? notes.join(" · ") : undefined,
        address: option.value
      };
    }),
    { title: `${SERVICE_LABELS[kind]} — Interface`, placeHolder: "Which NIC serves this service" }
  );
  if (!pick || pick.address === current) return "unchanged";
  // Both bind addresses are passed explicitly rather than re-read, so the gate
  // asks about the old NIC and the new one regardless of which write lands
  // first — `current` is the old address, already normalised out of "0.0.0.0".
  const serverId =
    kind === "dhcp" && pool && section
      ? rebindServerIdentifier(current, pick.address, pool, options, section)
      : undefined;
  await writeSetting(kind, "interface", pick.address.length > 0 ? pick.address : undefined);
  if (serverId !== undefined) await writeSetting("dhcp", "serverId", serverId);
  return "edited";
}

function isAllInterfacesValue(address: string): boolean {
  return address.length === 0 || address === "0.0.0.0";
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

/* `isAutoFillable` / `isDnsAutoFillable` moved to `networkServerSettings.ts`
   when the full form grew the same CIDR row: both editors have to answer "may
   this value be recomputed?" identically, and a gateway that survives in one
   and is clobbered in the other is a divergence that only shows up on
   someone's bench. */

const AUTO_FILL_LABELS: Readonly<Record<string, string>> = {
  subnet: "Subnet Mask",
  rangeStart: "Pool Start",
  rangeEnd: "Pool End",
  gateway: "Gateway",
  broadcast: "Broadcast",
  dns: "DNS",
  interface: "Interface"
};

/** One setting the editor is offering to write, with how it reads in the prompt. */
interface AutoFillWrite {
  readonly key: string;
  readonly value: SettingValue;
  /** What the summary shows; defaults to the value itself. */
  readonly display?: string;
}

function describeAutoFillWrite(write: AutoFillWrite): string {
  const shown = write.display ?? (Array.isArray(write.value) ? write.value.join(", ") : String(write.value));
  return `${AUTO_FILL_LABELS[write.key] ?? write.key} ${shown}`;
}

/**
 * The confirm-then-write half shared by every auto-fill offer.
 *
 * Confirmation is asked for rather than assumed. Nothing in the settings marks
 * a value as machine-suggested, so silence would be indistinguishable from the
 * editor overwriting fields the user never opened — and the prompt is skipped
 * entirely when there is nothing left to offer, which is the case that would
 * have been annoying.
 *
 * @returns Whether anything was written.
 */
async function confirmAutoFill(placeHolder: string, writes: readonly AutoFillWrite[]): Promise<boolean> {
  if (writes.length === 0) return false;
  const summary = writes.map(describeAutoFillWrite).join("  ·  ");
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
      placeHolder,
      ignoreFocusOut: true
    }
  );
  if (!pick?.confirmed) return false;
  for (const write of writes) {
    await writeSetting("dhcp", write.key, write.value);
  }
  return true;
}

function readDnsSetting(section: vscode.WorkspaceConfiguration): string[] {
  return section
    .get<string[]>("dns", [])
    .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
    .filter((entry) => entry.length > 0);
}

/**
 * The NIC to offer along with a pool that has just moved subnet, if there is
 * exactly one obvious answer.
 *
 * Only ever offered, never written on its own: rebinding the service is a
 * bigger change than filling in a gateway, and the one case where the editor is
 * sure — a single NIC already on the new subnet — is also the case where saying
 * so out loud costs nothing. Ambiguity (two NICs on that subnet) and silence
 * (none) both mean the picker stays the way to answer.
 *
 * @param interfaces Passed in rather than enumerated here so a caller that also
 *   needs the NIC list — {@link editNetworkCidr}, which derives the pool around
 *   this machine's addresses and resolves the server identifier from them —
 *   asks the platform once and cannot end up comparing two different answers.
 */
function offSubnetInterfaceWrite(
  section: vscode.WorkspaceConfiguration,
  rangeStart: string | undefined,
  subnet: string | undefined,
  interfaces: readonly NetworkInterfaceOption[]
): AutoFillWrite | undefined {
  const allowRelayAgents = section.get<boolean>("allowRelayAgents", false) === true;
  const bindAddress = rawString(section, "interface");
  const status = dhcpInterfaceSubnetStatus(bindAddress, subnet, rangeStart, interfaces, allowRelayAgents);
  if (status !== "mismatch") return undefined;
  const suggestion = suggestBindAddressForPool(rangeStart, subnet, interfaces, allowRelayAgents);
  if (!suggestion || suggestion.ambiguous) return undefined;
  return { key: "interface", value: suggestion.address };
}

/**
 * Offers the addresses a new pool start implies — gateway, broadcast, DNS — and
 * the NIC to serve them from when the pool has moved off the bound one.
 *
 * The pool's own end address is not part of the offer: {@link editPoolStart}
 * already recomputes it unconditionally to preserve the pool size, and asking
 * about something that has already happened would misreport what the answer
 * changes.
 *
 * The netmask in force is respected rather than assumed: an explicit `subnet`
 * of, say, `255.255.254.0` derives a `.255`-crossing broadcast and the gateway
 * below it, and only an unset mask falls back to /24.
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
  const dns = readDnsSetting(section);

  const writes: AutoFillWrite[] = [];
  if (isAutoFillable(rawString(section, "gateway"), previous?.gateway)) {
    writes.push({ key: "gateway", value: derived.gateway });
  }
  if (isAutoFillable(rawString(section, "broadcast"), previous?.broadcast)) {
    writes.push({ key: "broadcast", value: derived.broadcast });
  }
  if (isDnsAutoFillable(dns, previous?.dns)) writes.push({ key: "dns", value: [...derived.dns] });
  const bind = offSubnetInterfaceWrite(section, rangeStart, subnet, networkInterfaceBindOptions());
  if (bind) writes.push(bind);

  await confirmAutoFill(`Fill in the addresses that follow from ${rangeStart}?`, writes);
}

/**
 * A whole network, entered once as CIDR.
 *
 * Nothing new is stored: `192.168.2.0/24` is a shorthand for the `subnet`,
 * `rangeStart`, `rangeEnd`, `gateway` and `dns` keys that have always been the
 * real settings — the same precedent the Pool Count row set, which asks for a
 * count and stores the `rangeEnd` it implies. That is what makes the row need no
 * migration in either direction: it seeds itself from the settings already
 * there, and a `settings.json` reader still sees exactly the keys they did.
 *
 * The three keys the CIDR *is* — mask, pool start, pool end — are offered
 * together with the ones it merely implies. The implied set is gated the way
 * {@link offerPoolAutoFill} gates it, so a gateway the user typed survives a
 * network change; the defining three are not, because a pool left on the old
 * network after the mask moved to the new one is not a state the user could
 * have meant. Nothing is written without the confirmation either way.
 *
 * The server identifier (option 54) is offered too, but it is not derived from
 * the network like the rest: it is this machine's own address on the wire it
 * serves, so it comes from the serving NIC via `refreshDhcpServerIdentifier`.
 * Without it a `10.0.0.0/24` config keeps advertising the packaged
 * `192.168.2.1` for renewals, on a network no client can reach it at; taken
 * from the gateway instead, it advertises an address that belongs to the router
 * or to nothing. When no single address of this machine can be identified for
 * the new pool, nothing is offered for it at all. Relay mode narrows that
 * question rather than cancelling it: no NIC is suggested from a relayed pool's
 * subnet — this machine is deliberately not on it — but an explicit bind
 * address this machine currently holds is still where the service answers, so
 * it is still offered. Only an all-interfaces, unset or unheld bind abstains
 * there. The gateway is never a stand-in for the identifier in either mode.
 *
 * The pool is derived against this machine's own addresses, so re-applying the
 * network it is already on cannot produce a pool containing the very NIC the
 * service answers from.
 */
async function editNetworkCidr(
  rangeStart: string | undefined,
  subnet: string | undefined
): Promise<QuickAdjustOutcome> {
  const seed = dhcpCurrentCidr(rangeStart, subnet) ?? "";
  const entered = await vscode.window.showInputBox({
    title: "DHCP — Network (CIDR)",
    prompt:
      "The whole network in one go, e.g. 192.168.2.0/24. Not stored as such — it fills in the subnet mask, the pool and the gateway that follow from it.",
    placeHolder: seed.length > 0 ? seed : "192.168.2.0/24",
    value: seed,
    ignoreFocusOut: true,
    validateInput: (raw) => dhcpCidrProblem(raw)
  });
  if (entered === undefined) return "unchanged";
  // Submitting the seeded value unchanged still makes the offer, unlike the
  // plain text rows. Re-entering the network a config is already on is how a
  // pool that grew inconsistent with it gets straightened out, and the offer
  // costs an Escape — the row writes nothing without the confirmation below,
  // so browsing it still cannot mark the service as needing a restart.
  // Same NIC enumeration `offSubnetInterfaceWrite` reads, and for the same
  // reason it is filtered rather than taken raw from `os.networkInterfaces()`:
  // a WSL or Docker address has no business shaping a pool for a real wire.
  const interfaces = networkInterfaceBindOptions();
  const ownAddresses = interfaces.map((option) => option.value);
  const derived = dhcpCidrDerivation(entered, ownAddresses);
  if (!derived) {
    // A blank box, or anything the validator already refused, is silent — blank
    // means "leave it alone" and the box itself said the rest. The one case
    // worth a word is the network that IS usable in the abstract and only this
    // machine has no room in: the validator passes it (it asks about the
    // network, not about this host), so an unexplained Enter-does-nothing is
    // the alternative.
    if (dhcpCidrDerivation(entered)) {
      await vscode.window.showWarningMessage(
        `${entered.trim()} leaves no pool once this machine's own addresses on it are kept out — every address it could hand out is already taken here.`
      );
    }
    return "unchanged";
  }

  const section = settingsSection("dhcp");
  const previous = dhcpDerivedAddresses(rangeStart ?? DEFAULTS.rangeStart, subnet);
  const allowRelayAgents = section.get<boolean>("allowRelayAgents", false) === true;
  const dns = readDnsSetting(section);

  const writes: AutoFillWrite[] = [];
  if (rawString(section, "subnet") !== derived.subnet) writes.push({ key: "subnet", value: derived.subnet });
  if (rawString(section, "rangeStart") !== derived.rangeStart) {
    writes.push({ key: "rangeStart", value: derived.rangeStart });
  }
  if (rawString(section, "rangeEnd") !== derived.rangeEnd) {
    writes.push({
      key: "rangeEnd",
      value: derived.rangeEnd,
      display: `${derived.rangeEnd} (${String(derived.poolCount)} addresses)`
    });
  }
  if (isAutoFillable(rawString(section, "gateway"), previous?.gateway)) {
    writes.push({ key: "gateway", value: derived.gateway });
  }
  // Option 54 is this machine's address on the wire it serves, not an address
  // the network implies, so it is resolved from the NIC that will serve the new
  // pool. The bind address as it stands feeds BOTH resolutions: this row is
  // reached only from the Network (CIDR) input box, which cannot change the
  // `interface` setting as a side effect of itself, and the rebind below is an
  // offer that has written nothing yet — so the address this machine is on is
  // genuinely the same one either side, and the previous resolution is asking
  // "would this bind address already have produced this serverId under the
  // network as it stood". That is the gate — the PREVIOUS gateway is no longer
  // a value this offer would ever have written here, so it can no longer be
  // treated as a stale suggestion of its own.
  //
  // REVIEW FINDING (P1) — with relay agents allowed the derived GATEWAY is
  // never offered for it. A relayed pool is on the client subnet, so its
  // gateway is the CLIENT subnet's router, and writing it told every client to
  // renew (and to fetch a ZTP image from `siaddr`) at an address this service
  // does not answer on.
  //
  // REVIEW FINDING (P1, fifth round — relay with an explicit held bind) — the
  // fix for that was to skip the identifier entirely under relay, which was too
  // broad. "No address to resolve" is true of the relayed POOL and false of the
  // BIND: a service bound to a concrete address this machine holds answers from
  // that address with or without a relay in front of it. The flag is now
  // forwarded into the shared resolver instead of being decided here, so the
  // offer abstains only for a bind that names no single held address — see
  // `resolveDhcpServerIdentifier`'s two-branch contract.
  //
  // The shape below is `refreshDhcpServerIdentifier`, the same one the full
  // form's fill and the Interface row's rebind now go through; keeping three
  // hand-written copies of it is what made the relay defect a three-site fix.
  const resolvedServerId = refreshDhcpServerIdentifier({
    next: { rangeStart: derived.rangeStart, subnet: derived.subnet, bindAddress: rawString(section, "interface") },
    previous: {
      rangeStart: rangeStart ?? DEFAULTS.rangeStart,
      subnet,
      bindAddress: rawString(section, "interface")
    },
    interfaces,
    allowRelayAgents,
    configuredServerId: rawString(section, "serverId")
  });
  if (resolvedServerId !== undefined) writes.push({ key: "serverId", value: resolvedServerId });
  if (isAutoFillable(rawString(section, "broadcast"), previous?.broadcast)) {
    writes.push({ key: "broadcast", value: derived.broadcast });
  }
  if (isDnsAutoFillable(dns, previous?.dns)) writes.push({ key: "dns", value: [...derived.dns] });
  const bind = offSubnetInterfaceWrite(section, derived.rangeStart, derived.subnet, interfaces);
  if (bind) writes.push(bind);

  const written = await confirmAutoFill(
    `Apply ${derived.network}/${String(derived.prefix)} to these settings?`,
    writes
  );
  return written ? "edited" : "unchanged";
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
  const pool = dhcpPoolSubnetContext(section);
  return [
    {
      label: "$(plug) Interface",
      description: describeInterface(bindAddress),
      detail: describeInterfaceDetail(bindAddress, pool),
      run: () => editInterface("dhcp", bindAddress, pool, section)
    },
    {
      label: "$(symbol-numeric) Network (CIDR)",
      // Reverse-derived from the settings that exist, so an untouched config
      // shows its network without anything having been migrated.
      description: dhcpCurrentCidr(rangeStart, subnet) ?? "no usable netmask configured",
      detail: "Fills in the subnet mask, the pool and the gateway that follow from one network.",
      run: () => editNetworkCidr(rangeStart, subnet)
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
