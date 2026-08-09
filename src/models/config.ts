import type { PtyOutputObserver } from "../services/macroAutoTrigger";
import type * as vscode from "vscode";

export type AuthType = "password" | "key" | "agent";
export type TunnelConnectionMode = "isolated" | "shared" | "ask";
export type ResolvedTunnelConnectionMode = Exclude<TunnelConnectionMode, "ask">;
export type TunnelType = "local" | "reverse" | "dynamic";
export type SerialParity = "none" | "even" | "odd" | "mark" | "space";
export type SerialDataBits = 5 | 6 | 7 | 8;
export type SerialStopBits = 1 | 2;
export type SerialProfileMode = "standard" | "smartFollow";
export type SerialSessionStatus = "connected" | "waiting";
export type LocalShellLaunchMode = "vscodeProfile" | "custom";

export interface SshJumpProxy {
  type: "ssh";
  jumpHostId: string;  // references another ServerConfig.id
}

export interface Socks5Proxy {
  type: "socks5";
  host: string;
  port: number;
  username?: string;
  // password stored in SecretStorage: "proxy-password-{serverId}"
}

export interface HttpConnectProxy {
  type: "http";
  host: string;
  port: number;
  username?: string;
  // password stored in SecretStorage: "proxy-password-{serverId}"
}

export type ProxyConfig = SshJumpProxy | Socks5Proxy | HttpConnectProxy;

/** Marks a server as materialized by an inventory sync rather than added by hand. */
export interface ServerOrigin {
  sourceId: string; // InventorySourceConfig.id
  externalId: string; // InventoryDevice.externalId within that source
  syncedAt: number;
  /**
   * REVIEW FINDING (P1, adoption instance identity) — WHICH DEPLOYMENT of the
   * source's provider the sync that last wrote this record was reading from, as
   * `resolveProviderInstanceKey(provider, source.config)` reported it AT THAT
   * MOMENT (for NetBox, the normalized base URL — see models/inventory.ts).
   *
   * It is what scopes `externalId`, which is unique only WITHIN one deployment:
   * two NetBox instances both call their first device "device:1". So this field
   * is the third member of the ownership key, not a receipt — and unlike the
   * other two it records something about the SOURCE, which is exactly why it has
   * to be stamped on the SERVER.
   *
   * WHY IT LIVES HERE AND NOT ON THE SOURCE RECORD. `InventorySourceConfig.config`
   * is mutable: Edit Source can be pointed at a different deployment at any time,
   * and the servers already synced still came from the old one until a sync
   * against the new one actually rewrites them. Deriving the instance from the
   * source's CURRENT config when a server is detached ("Keep Servers", and the
   * import rollback's equivalent) therefore stamped every marker with a
   * deployment those servers' `externalId`s were never scoped by — after which a
   * source pointed at that second deployment could pass the instance guard and
   * adopt, then prune, records it had never synced. Recording what the sync
   * itself saw moves the identity onto a value no later edit can move underneath
   * it — the same discipline `syncedUsername` and `syncedAuthProfileId` follow.
   *
   * Written by every path that writes `origin`: the add path, the update path and
   * the adoption path all stamp the instance THIS run is talking to,
   * unconditionally and without carry-forward. There is no "the sync did not
   * write this field" case for it the way there is for `syncedUsername` — a sync
   * always reads its devices from some deployment — so `undefined` here means
   * only "the provider named no instance" (it does not implement `instanceKey`,
   * or its answer was rejected), never "unchanged since last time". Carrying an
   * older value forward when the current run cannot name an instance was rejected
   * for that reason: it would re-assert an identity this sync did not verify,
   * against a config that may since have been repointed.
   *
   * Optional for backward compat, exactly like the two stamps below: a server
   * synced before this field existed carries none. Absent is NOT "matches
   * anything" — it means a detach can copy no instance into the marker, so the
   * marker is a receipt rather than an adoption key and the server is simply not
   * adoptable (see DetachedServerOrigin.instanceKey, which reaches the same safe
   * state from the other side). The first sync after upgrading stamps it — the
   * origin-stamp comparison below counts a newly computed instance as a change,
   * so the write is not discarded as "unchanged" — so the affected population is
   * finite and only ever shrinks.
   */
  syncedInstanceKey?: string;
  /**
   * The username the sync itself last WROTE onto this server — `endpoint.username`
   * when the provider supplied one, otherwise the source's `defaultUsername` as of
   * that write. Recorded so a later sync can tell "still exactly what I stamped"
   * apart from "the user edited this", which comparing against the source's
   * *current* `defaultUsername` cannot: linking an auth profile rewrites
   * `defaultUsername` (the source form mirrors the profile's username into it), so
   * that comparison would call every already-synced server hand-edited the moment a
   * profile is chosen. See the AUTH 2 retro-apply rule in
   * services/inventory/syncEngine.ts, which is its only reader.
   *
   * Written ONLY where the sync writes `username` — the add path always, the update
   * path only when the endpoint supplied a username — and never inferred from the
   * record's current value, which would launder a hand-edit into "as stamped".
   *
   * Optional for backward compat: servers synced by a build before this field
   * existed have none, and the rule falls back to `defaultUsername` for them —
   * exactly the pre-existing behavior. Absent must never mean "ineligible".
   */
  syncedUsername?: string;
  /**
   * The auth profile the sync itself last LINKED on this server — the source's
   * resolved profile as of that write, and `undefined` when the sync linked none
   * (a profile-less source, or one whose reference no longer resolves).
   *
   * Recorded so a later sync can tell "the sync's own link, still exactly as
   * written" apart from "the user cleared the source's profile on THIS server".
   * Both leave `authProfileId` undefined, so without the stamp the retro-apply
   * rule reattaches the source's profile on the very next sync and a per-server
   * opt-out is impossible — the record satisfies every other clause again.
   *
   * Written ONLY where the sync writes `authProfileId` — the add path always
   * (whatever the source resolved to, `undefined` included), the update path only
   * when retro-apply actually fires — and never inferred from the record's current
   * value, which would launder a hand-edit into "as stamped" one sync later.
   *
   * Optional for backward compat, exactly like `syncedUsername`: servers synced by
   * a build before this field existed have none, which reads identically to a
   * server the sync deliberately linked nothing on. Both mean "the sync never put
   * a profile here" — precisely the state retro-apply is allowed to fill — so
   * absent must never mean "ineligible".
   *
   * Cleared alongside `authProfileId` by `NexusCore.removeAuthProfile` and by the
   * backup-import dangling sweep (commands/configCommands.ts) when the stamped
   * profile is DELETED: that clear is the system's doing, not a user opt-out, so
   * leaving the stamp behind would permanently exclude a server nobody ever
   * hand-configured. A stamp is only ever left standing against an `authProfileId`
   * the USER moved.
   */
  syncedAuthProfileId?: string;
  /**
   * The out-of-band address the sync itself last WROTE into `ipmiHost` — the
   * management endpoint the provider supplied as of that write (NetBox's
   * `oob_ip`), and `undefined` when the sync wrote none.
   *
   * Follows the `syncedAuthProfileId` discipline, NOT the `host`/`port` "the
   * device always wins" one, and that choice is the whole design: `ipmiHost`
   * shipped as a HAND-EDITED field before any sync could write it, so "device
   * always wins" would clobber every early adopter's manual entry on the first
   * post-upgrade sync — and a device that has no OOB endpoint at all would read
   * as "this field should be empty". The stamp records what the sync put there,
   * so the sync only ever fills an untouched field or overwrites one still
   * carrying exactly its own last value; a hand-typed value (no stamp, or a
   * stamp the value no longer equals) is left alone, and so is a value whose
   * device merely stopped reporting an address this fetch.
   *
   * Written ONLY where the sync writes `ipmiHost` — the add path always
   * (`undefined` included, so a source whose devices gain an `oob_ip` later
   * finds the stamps already there), the update path only when the write rule
   * fires — plus ONE stamp-only case, and never inferred from the record's
   * current value alone, which would launder a hand-edit into "as stamped" one
   * sync later.
   *
   * THE STAMP-ONLY CASE (matrix row 5a, see `syncOwnsIpmiHost` in the sync
   * engine): a record whose `ipmiHost` ALREADY EQUALS the device's out-of-band
   * address this fetch gains the stamp even though the value does not move. The
   * stamp is still the DEVICE's value, so the "never inferred from the record"
   * rule stands — equality with the device is the trigger, and a hand edit to
   * some third value stamps nothing. Its purpose is that the likeliest hand
   * entry there is (the user copied the address out of NetBox) would otherwise
   * be permanently unstampable and would go silently stale the first time the
   * BMC is re-addressed. Accepted residual: such a value is adopted into sync
   * ownership without the user asking — the same trade `syncedUsername` makes,
   * and the opt-out is unchanged (clear the field; absent value + present stamp
   * is hands-off forever).
   *
   * Optional for backward compat, exactly like the two stamps above: servers
   * synced by a build before this field existed have none. Absent means
   * HANDS-OFF rather than "eligible", which is the one asymmetry against
   * `syncedUsername`: there is no source-level default IPMI host to fall back
   * to, so a record carrying an `ipmiHost` with NO stamp is a hand entry and is
   * never overwritten — unless that value is the device's own current address,
   * per the stamp-only case above. (A record carrying neither is the
   * never-configured state the sync is free to fill.)
   */
  syncedIpmiHost?: string;
}

/**
 * ADOPT 1 — the receipt left on a server when the inventory source that
 * created it is removed with "Keep Servers". It records WHICH DEVICE the
 * server was mapped to, so that re-adding the same source can OFFER to
 * re-link (adopt) the kept record instead of adding a duplicate beside it.
 *
 * WHY A SEPARATE FIELD AND NOT A REDUCED `origin`. Three things depend on a
 * kept server having no `origin` at all, and each breaks if the marker is
 * folded into it:
 *  - the tree badges any `origin`-bearing server "(synced)" and tooltips
 *    "Synced from …" (ui/nexusTreeProvider.ts) — a kept server is NOT synced
 *    by anything, and there is no truthful "formerly synced" rendering today;
 *  - ownership resolution and the prune loop in
 *    services/inventory/syncEngine.ts key on `origin.sourceId`, and a dangling
 *    origin must never let any sync act on a record its source no longer
 *    manages (which is exactly why "Keep Servers" strips it);
 *  - the command layer derives which plan updates are adoptions from
 *    `before.origin === undefined`, which is exact only while a kept server
 *    carries no origin.
 *
 * MUTUALLY EXCLUSIVE WITH `origin`: adoption sets `origin` and clears this in
 * the same write. A record carrying both is malformed; the engine ignores the
 * marker on any server that has an `origin`, so such a record is inert rather
 * than dangerous.
 *
 * `sourceId`/`sourceName`/`detachedAt` are receipts — for copy and diagnosis,
 * never matching inputs (the whole problem is that a re-added source mints a
 * NEW id). `providerId`, `instanceKey` and `externalId` ARE the matching inputs;
 * see the ADOPT 1 eligibility rule in the sync engine for the endpoint
 * corroboration that goes with them.
 */
export interface DetachedServerOrigin {
  /** The removed source's id. A re-added source never matches it — receipt only. */
  sourceId: string;
  /** The removed source's name, so the UI can say which source kept this server. */
  sourceName: string;
  /** MATCHING INPUT — only a source of the same provider may adopt this record. */
  providerId: string;
  /**
   * MATCHING INPUT (REVIEW FINDING, P1 — cross-instance adoption) — WHICH
   * DEPLOYMENT of `providerId` this server was synced from, copied verbatim from
   * the server's own `ServerOrigin.syncedInstanceKey` at detach time (for NetBox,
   * the normalized base URL — see models/inventory.ts for the contract and for
   * why it can never contain a secret).
   *
   * COPIED FROM THE ORIGIN, NEVER RE-DERIVED FROM THE SOURCE'S CURRENT CONFIG
   * (REVIEW FINDING, P1 — the instance guard fed from the wrong place). A source
   * synced against deployment A and then edited to point at B — with no
   * successful sync in between — still owns servers whose `externalId`s are A's.
   * Re-deriving the key from `source.config` at removal time stamped all of them
   * with B, so a later B source with the same id and address passed the instance
   * guard and could adopt, and then prune, A's records and their credentials.
   * `ServerOrigin.syncedInstanceKey` is the only value that describes the
   * deployment those ids actually came from; see its doc for why it is recorded
   * per server rather than per source.
   *
   * `providerId` alone does not scope `externalId`: it is unique only within one
   * deployment, so a lab NetBox and a production NetBox both emit "device:1",
   * and private addresses overlap freely — 10.0.0.1:22 is the most ordinary
   * endpoint there is. Without this field the endpoint corroboration was the
   * only thing standing between the two, and it does not stand: the same id at
   * the same address across two instances is a coincidence a homelab reproduces
   * on the first try, and the consequence is a server changing owner, after
   * which the new owner's prune policy can delete it and its saved credentials.
   *
   * OPTIONAL, AND ITS ABSENCE MEANS NOT ADOPTABLE. Three ways a marker can lack
   * it: the provider offers no instance identity at all (the public provider API
   * is experimental, and `instanceKey` is optional on it); the server was synced
   * by a build from before `ServerOrigin.syncedInstanceKey` existed, so the
   * detach had nothing to copy; or the marker itself was written by a build of
   * this unreleased branch from before this field existed (developer machines
   * only — no shipped release contains `formerlySynced` in any form). All three
   * land in the same safe state, and the engine treats them identically: a marker
   * with no instance key matches nothing, so its server is added as a duplicate
   * and the plan says why. It is never compared as "equal to another absent key"
   * — that would re-create the exact collision this field removes. The middle
   * case repairs itself on the next successful sync, which stamps the origin
   * before there is anything to detach.
   */
  instanceKey?: string;
  /** MATCHING INPUT — the device this server was mapped to. */
  externalId: string;
  /**
   * REVIEW FINDING (P1, adoption auth provenance) — the auth profile the REMOVED
   * SOURCE'S SYNC had last linked on this server, copied verbatim from the
   * server's own `ServerOrigin.syncedAuthProfileId` at detach time, and
   * `undefined` when that sync had linked none.
   *
   * NOT a matching input — it decides nothing about adoption. It is the one piece
   * of the stripped origin that has to OUTLIVE the strip, because it is the only
   * record of whether the `authProfileId` the server still carries was the SYNC'S
   * doing or the USER'S, and both AUTH 2b (the unlink that rescues a server whose
   * key profile has lost its key file) and retro-apply's per-server opt-out are
   * decided on exactly that distinction.
   *
   * Without it, adoption re-stamped an origin whose `syncedAuthProfileId` was
   * unconditionally `undefined` — retro-apply cannot fill it in, because it does
   * not run while `authProfileId` is still set — leaving an adopted server
   * carrying a sync-applied link that AUTH 2b would then refuse to touch. If that
   * profile later lost its key file, the server could not connect and no sync
   * could repair it; and clearing the link by hand did not read as an opt-out
   * either, so the next sync reattached it.
   *
   * Optional and restored, never invented: adoption copies it back into the new
   * `origin` (services/inventory/syncEngine.ts), and a marker that carries none
   * restores none — which is bit-identical to a server the sync never linked
   * anything on, exactly as it should be. Cleared alongside `authProfileId` by
   * `NexusCore.removeAuthProfile` and by the backup-import dangling sweep when
   * the named profile is DELETED, on the same terms and for the same reason as
   * the origin stamp it mirrors: that clear is the system's doing, so a stamp
   * naming a profile that no longer exists must not outlive it and lock a record
   * nobody hand-configured out of retro-apply for good.
   */
  syncedAuthProfileId?: string;
  /**
   * OOB (PR-A REVIEW FINDING) — the out-of-band address the REMOVED SOURCE'S
   * SYNC had last written into `ipmiHost` on this server, copied verbatim from
   * the server's own `ServerOrigin.syncedIpmiHost` at detach time, and
   * `undefined` when that sync had written none.
   *
   * NOT a matching input — like `syncedAuthProfileId` beside it, it decides
   * nothing about adoption. It is preserved for exactly the same reason and
   * against exactly the same failure: it is the only record of whether the
   * `ipmiHost` the server still carries was the SYNC'S doing or the USER'S, and
   * the write rule (`syncOwnsIpmiHost`) is decided on precisely that
   * distinction.
   *
   * The failure it closes. Remove Source → Keep Servers → re-add the source →
   * Adopt used to strip the origin and restore no OOB stamp, so an adopted
   * server's sync-written address arrived looking hand-typed (matrix row 5) and
   * the sync could never update it again — permanently, and silently, for a
   * value the sync itself had put there. The earlier code framed that omission
   * as inherent ("the marker carries no OOB stamp to restore"); it was a
   * decision, and this field reverses it, on the same terms as the auth
   * provenance marker that had already reversed the identical decision one field
   * up. (The equal-value stamp-only rule, row 5a, softens the loss but does not
   * close it: it only rescues records whose address STILL equals the device's
   * current one, which is the opposite of the re-addressed BMC this receipt is
   * for.)
   *
   * Optional and restored, never invented: adoption copies it back into the new
   * `origin`, and a marker that carries none restores none — bit-identical to a
   * server the sync never wrote an address on. Nothing clears it, unlike
   * `syncedAuthProfileId`: an address names no other record, so it cannot dangle
   * when something else is deleted.
   */
  syncedIpmiHost?: string;
  detachedAt: number;
}

/** Scheme "Open BMC Web Console" opens a BMC's web UI with. See `ServerConfig.bmcWebProtocol`. */
export type BmcWebProtocol = "https" | "http";

export const BMC_WEB_PROTOCOLS: readonly BmcWebProtocol[] = ["https", "http"];

/**
 * The scheme a BMC web console open ACTUALLY uses, applied at every read site
 * (the untrusted-field discipline `resolveMacroRunTarget` set): absent, a
 * non-string, or anything outside the two literals resolves to `"https"` — the
 * compatibility default, and the safe one. `"http"` is the only value that can
 * downgrade the scheme, and only when it is spelled exactly.
 *
 * Interpolating the stored value into the URL instead would let an imported
 * record choose the scheme string outright, which is a different (and much
 * larger) question than "http or https".
 */
export function resolveBmcWebProtocol(server: Pick<ServerConfig, "bmcWebProtocol">): BmcWebProtocol {
  return (server.bmcWebProtocol as unknown) === "http" ? "http" : "https";
}

export interface ServerConfig {
  id: string;
  name: string;
  group?: string;
  host: string;
  port: number;
  username: string;
  authType: AuthType;
  keyPath?: string;
  isHidden: boolean;
  logSession?: boolean;
  multiplexing?: boolean;  // undefined = follow global, false = always standalone
  legacyAlgorithms?: boolean;
  /**
   * Out-of-band management address (IPMI / BMC / Redfish), e.g. `10.0.0.1` or
   * `bmc.example.com`. Nothing in the SSH connect path reads it — it exists so
   * `${profile.ipmiHost}` resolves when a macro is run against this profile
   * (services/profileTokens.ts, which is also where the value's SHAPE is
   * enforced: it can arrive from a backup import, so save-time checks are not
   * the reliable chokepoint).
   *
   * Optional and additive, like every other field added after 1.0 — records
   * written by older builds have none, and older builds round-trip it
   * untouched (servers are stored as whole objects under `nexus.servers`).
   */
  ipmiHost?: string;
  /**
   * The auth profile whose username and stored password are the BMC's
   * credentials — the SAME `AuthProfile` store `authProfileId` uses, linked
   * from a second field rather than modelled as a second concept (an IPMI
   * credential IS a username + password pair, and the org-wide "one universal
   * BMC credential" shape this exists for is one profile linked from many
   * servers).
   *
   * Resolved at RUN time, never copied onto the server: `${profile.ipmiUsername}`
   * reads the profile's `username`, and the password is read from the vault
   * under `authProfilePasswordSecretKey(id)` at the moment a run needs it.
   * Only those two are read — `authType` and `keyPath` mean nothing on this
   * link, so a `key`/`agent` profile is accepted and simply supplies a username.
   *
   * Cleared alongside `authProfileId` wherever a profile is DELETED
   * (`NexusCore.removeAuthProfile`, the backup-import dangling sweep in
   * commands/configCommands.ts) — a link naming a profile that no longer exists
   * resolves to nothing on every run, with nothing on screen to say why.
   */
  ipmiAuthProfileId?: string;
  /**
   * Scheme for "Open BMC Web Console". ABSENT MEANS `"https"` — the safe
   * default, and what every record written before this field existed implies.
   * Plenty of older iDRAC/iLO/IPMI cards serve their UI on plain HTTP and have
   * no TLS listener at all, which is the whole reason this is a field rather
   * than a hard-coded scheme.
   *
   * UNTRUSTED at every read site, like `TerminalMacro.runIn`: go through
   * `resolveBmcWebProtocol()`, never a direct read, so a `"HTTPS"`/`"ftp"`/
   * non-string from a hand-edited backup can neither choose the scheme nor
   * reach a URL.
   *
   * Never written by inventory sync — there is no stamp and no matrix row for
   * it; it is a fact about the hardware the user states once.
   */
  bmcWebProtocol?: BmcWebProtocol;
  openFileExplorerOnFirstConnect?: boolean;
  proxy?: ProxyConfig;
  authProfileId?: string;  // references AuthProfile.id; credentials resolved at connection time
  origin?: ServerOrigin;
  /** ADOPT 1 — see DetachedServerOrigin. Never set at the same time as `origin`. */
  formerlySynced?: DetachedServerOrigin;
}

/**
 * Shallow-plus-one-level clone: ServerConfig's own fields are primitives, but
 * `proxy`, `origin` and `formerlySynced` are nested objects, so a plain
 * `{...server}` would still share those references with the source. Used by
 * NexusCore.applyInventorySyncPlan to capture a structural snapshot of each
 * batch-written server AT WRITE TIME, before any later in-place mutation
 * (e.g. _renameFolderPath rewriting `server.group` on the very same object)
 * can change what the live map entry looks like out from under it.
 */
export function cloneServerConfig(server: ServerConfig): ServerConfig {
  return {
    ...server,
    proxy: server.proxy ? { ...server.proxy } : server.proxy,
    origin: server.origin ? { ...server.origin } : server.origin,
    formerlySynced: server.formerlySynced ? { ...server.formerlySynced } : server.formerlySynced
  };
}

function proxyConfigsEqual(a: ProxyConfig | undefined, b: ProxyConfig | undefined): boolean {
  if (a === b) return true;
  if (!a || !b || a.type !== b.type) return false;
  switch (a.type) {
    case "ssh":
      return a.jumpHostId === (b as SshJumpProxy).jumpHostId;
    case "socks5":
    case "http": {
      const other = b as Socks5Proxy | HttpConnectProxy;
      return a.host === other.host && a.port === other.port && a.username === other.username;
    }
  }
}

/**
 * Every member of ServerOrigin EXCEPT `syncedAt` — i.e. the ownership key plus
 * the stamps the sync writes as decision INPUTS for its own next run
 * (`syncedUsername`, `syncedAuthProfileId`, `syncedIpmiHost`).
 *
 * Exists for computeSyncPlan's `changed` check, which must be able to ask "did
 * this sync compute a stamp the record does not already carry?" without asking
 * "is this a different sync run?". `syncedAt` advances on every single run by
 * construction, so comparing origins WHOLESALE there would mark every owned
 * server as an update on every sync forever — a plan preview that always claims
 * to be rewriting the entire fleet, and a persist that always does.
 *
 * `serverOriginsEqual` below is defined in terms of this one so a member added
 * to ServerOrigin can only be forgotten in a single place.
 */
export function serverOriginStampsEqual(a: ServerOrigin | undefined, b: ServerOrigin | undefined): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.sourceId === b.sourceId &&
    a.externalId === b.externalId &&
    // REVIEW FINDING (P1, adoption instance identity) — the instance joins the
    // stamp comparison for exactly the reason AUTH 3a gave for `syncedUsername`:
    // a legacy owned server whose every user-visible field is already correct
    // computes this stamp for the FIRST time and changes nothing else, and an
    // `after` discarded as "unchanged" there would throw the new stamp away — so
    // that server would never gain one, and its marker would never be adoptable.
    // It is also what makes a source REPOINTED at another deployment rewrite the
    // stamps it owns on the very sync that first reads from the new one.
    a.syncedInstanceKey === b.syncedInstanceKey &&
    a.syncedUsername === b.syncedUsername &&
    a.syncedAuthProfileId === b.syncedAuthProfileId &&
    // The `ipmiHost` stamp joins for the same reason the two above it do, and
    // AUTH 3a's shape reaches it too: a server whose device supplies an
    // `oob_ip` EQUAL to the value the record already carries computes this
    // stamp for the first time and changes nothing else, and an `after`
    // discarded as "unchanged" there would throw the new stamp away — leaving
    // that server permanently stampless, i.e. read as a hand entry by every
    // later sync and never updated when the BMC is re-addressed.
    a.syncedIpmiHost === b.syncedIpmiHost
  );
}

function serverOriginsEqual(a: ServerOrigin | undefined, b: ServerOrigin | undefined): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  // Every member of ServerOrigin is compared, the `syncedUsername` /
  // `syncedAuthProfileId` / `syncedIpmiHost` stamps included: they are what the
  // retro-apply and OOB write rules read, so an origin that differs only there
  // is a materially different record. Leaving any of them out would let the
  // rollback merge in mergeServerConfigFields call two origins "equal" and drop
  // a freshly written stamp back to the pre-batch one — after which the next
  // sync would compare against a username, a profile link, or a BMC address the
  // record no longer carries.
  return serverOriginStampsEqual(a, b) && a.syncedAt === b.syncedAt;
}

/**
 * ADOPT 1 — `serverOriginsEqual`'s counterpart for `formerlySynced`, and a
 * named helper for the same reason that one is: both `serverConfigsEqual` and
 * `mergeServerConfigFields` need the comparison, so a member added to
 * DetachedServerOrigin can only be forgotten in a single place.
 *
 * Every member is compared, not just the two adoption MATCHING inputs
 * (`providerId` / `externalId` — see DetachedServerOrigin). `sourceId`,
 * `sourceName` and `detachedAt` are receipts, but a record whose receipt
 * changed is still a materially different record: they are what the UI tells
 * the user this server came from, and telling the two apart is exactly what
 * the rollback merge below needs in order to keep a freshly written marker
 * instead of reverting to a pre-batch one.
 *
 * The `!a || !b` line carries the load this whole feature turns on: present vs
 * absent must read as a DIFFERENCE. A marker is what makes a kept server
 * adoptable at all, so a comparator that shrugged at "one has it, the other
 * doesn't" would let a set-marker or clear-marker write compare as "unchanged"
 * — after which a rollback would discard it and the server would either stay
 * unadoptable forever or become adoptable again after the user detached it.
 */
function detachedOriginsEqual(a: DetachedServerOrigin | undefined, b: DetachedServerOrigin | undefined): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.sourceId === b.sourceId &&
    a.sourceName === b.sourceName &&
    a.providerId === b.providerId &&
    // Present-vs-absent reads as a difference here for the same reason the
    // `!a || !b` line above does, one field down: `instanceKey` is what makes a
    // marker adoptable AT ALL, so a comparator that shrugged at "one has it, the
    // other doesn't" would let a rollback replace a marker carrying an instance
    // with one that carries none — permanently unadoptable — and call the two
    // records identical while doing it.
    a.instanceKey === b.instanceKey &&
    a.externalId === b.externalId &&
    // REVIEW FINDING (P1, adoption auth provenance) — compared for the reason
    // every other member is: a rollback that called two markers equal while one
    // remembers the removed source's link and the other does not would restore
    // the forgetful one, and the adopted server would be back to carrying a
    // sync-applied profile nothing can prove the sync applied.
    a.syncedAuthProfileId === b.syncedAuthProfileId &&
    // OOB (PR-A REVIEW FINDING) — compared one field down for the identical
    // reason: a rollback that called two markers equal while one remembers the
    // out-of-band address the removed source wrote and the other does not would
    // restore the forgetful one, and the adopted server's BMC address would be
    // back to looking hand-typed, which no later sync can repair.
    a.syncedIpmiHost === b.syncedIpmiHost &&
    a.detachedAt === b.detachedAt
  );
}

/**
 * Field-wise structural comparison — the ServerConfig counterpart of
 * inventory.ts's sourceConfigUnchanged. Used (instead of `===`) wherever a
 * rollback needs to tell "still exactly what we wrote" apart from "changed
 * since, even if it's the same object reference" — see FINDING 2 in
 * NexusCore.applyInventorySyncPlan: _renameFolderPath and
 * removeFolderCascade both mutate `server.group` IN PLACE on the object
 * already sitting in the servers map, so a reference check (`a === b`) stays
 * true across that mutation and would wrongly call the entry "unchanged".
 */
export function serverConfigsEqual(a: ServerConfig, b: ServerConfig): boolean {
  return (
    a.id === b.id &&
    a.name === b.name &&
    a.group === b.group &&
    a.host === b.host &&
    a.port === b.port &&
    a.username === b.username &&
    a.authType === b.authType &&
    a.keyPath === b.keyPath &&
    a.isHidden === b.isHidden &&
    a.logSession === b.logSession &&
    a.multiplexing === b.multiplexing &&
    a.legacyAlgorithms === b.legacyAlgorithms &&
    a.ipmiHost === b.ipmiHost &&
    a.ipmiAuthProfileId === b.ipmiAuthProfileId &&
    a.bmcWebProtocol === b.bmcWebProtocol &&
    a.openFileExplorerOnFirstConnect === b.openFileExplorerOnFirstConnect &&
    a.authProfileId === b.authProfileId &&
    proxyConfigsEqual(a.proxy, b.proxy) &&
    serverOriginsEqual(a.origin, b.origin) &&
    detachedOriginsEqual(a.formerlySynced, b.formerlySynced)
  );
}

/**
 * Field-wise rollback merge for applyInventorySyncPlan's conditional restore
 * (REVIEW FINDING 1 / P2). Used only for a batch-UPDATED record (one that
 * existed before the batch touched it) whose current live entry has diverged
 * from `batchSnapshot` — the structural snapshot captured at write time —
 * because of a concurrent in-place mutation (e.g. _renameFolderPath /
 * removeFolderCascade rewriting `.group`) or a concurrent replace while this
 * batch's persist was still in flight.
 *
 * Without this, the caller's only options were "restore `prior` wholesale"
 * (which would also revert the concurrent edit — wrong) or "leave `current`
 * alone" (which keeps the REJECTED batch write's fields, e.g. a bogus host
 * from a sync that just failed to persist — also wrong). This merges the two:
 * for each of ServerConfig's own fields, a field that the concurrent mutation
 * actually touched (current differs from what THIS batch wrote) keeps its
 * CURRENT value; every other field falls back to `prior` (the pre-batch
 * value), discarding the batch's now-rejected write for that field.
 *
 * Only meaningful when `prior` is defined — a batch-CREATED record has no
 * pre-batch state to fall back to (see the call site in
 * NexusCore.applyInventorySyncPlan, which keeps `current` as-is instead of
 * calling this for that case).
 */
export function mergeServerConfigFields(prior: ServerConfig, batchSnapshot: ServerConfig, current: ServerConfig): ServerConfig {
  const merged: ServerConfig = { ...prior };
  if (current.name !== batchSnapshot.name) merged.name = current.name;
  if (current.group !== batchSnapshot.group) merged.group = current.group;
  if (current.host !== batchSnapshot.host) merged.host = current.host;
  if (current.port !== batchSnapshot.port) merged.port = current.port;
  if (current.username !== batchSnapshot.username) merged.username = current.username;
  if (current.authType !== batchSnapshot.authType) merged.authType = current.authType;
  if (current.keyPath !== batchSnapshot.keyPath) merged.keyPath = current.keyPath;
  if (current.isHidden !== batchSnapshot.isHidden) merged.isHidden = current.isHidden;
  if (current.logSession !== batchSnapshot.logSession) merged.logSession = current.logSession;
  if (current.multiplexing !== batchSnapshot.multiplexing) merged.multiplexing = current.multiplexing;
  if (current.legacyAlgorithms !== batchSnapshot.legacyAlgorithms) merged.legacyAlgorithms = current.legacyAlgorithms;
  if (current.ipmiHost !== batchSnapshot.ipmiHost) merged.ipmiHost = current.ipmiHost;
  if (current.ipmiAuthProfileId !== batchSnapshot.ipmiAuthProfileId) merged.ipmiAuthProfileId = current.ipmiAuthProfileId;
  if (current.bmcWebProtocol !== batchSnapshot.bmcWebProtocol) merged.bmcWebProtocol = current.bmcWebProtocol;
  if (current.openFileExplorerOnFirstConnect !== batchSnapshot.openFileExplorerOnFirstConnect) {
    merged.openFileExplorerOnFirstConnect = current.openFileExplorerOnFirstConnect;
  }
  if (current.authProfileId !== batchSnapshot.authProfileId) merged.authProfileId = current.authProfileId;
  if (!proxyConfigsEqual(current.proxy, batchSnapshot.proxy)) {
    merged.proxy = current.proxy ? { ...current.proxy } : current.proxy;
  }
  if (!serverOriginsEqual(current.origin, batchSnapshot.origin)) {
    merged.origin = current.origin ? { ...current.origin } : current.origin;
  }
  // ADOPT 1 — `formerlySynced` merges on exactly the same terms as `origin`
  // above, and needs to for the same reason: a concurrent Remove Source → Keep
  // Servers (which STAMPS the marker) or a concurrent adoption (which CLEARS
  // it) is the very kind of write this merge exists to protect. Falling back to
  // `prior`'s marker would either strip a marker the user just earned — the
  // server silently stops being adoptable, with nothing on screen to say so —
  // or re-stamp one an adoption just consumed, leaving a record carrying both
  // an `origin` and a stale marker (inert by the engine's own first clause, but
  // a lie about the record's history either way).
  if (!detachedOriginsEqual(current.formerlySynced, batchSnapshot.formerlySynced)) {
    merged.formerlySynced = current.formerlySynced ? { ...current.formerlySynced } : current.formerlySynced;
  }
  // id never changes across a rollback merge — always prior's (== current's,
  // == batchSnapshot's; the map key this is stored under is invariant).
  merged.id = prior.id;
  return merged;
}

export interface TunnelProfile {
  id: string;
  name: string;
  localPort: number;
  remoteIP: string;
  remotePort: number;
  defaultServerId?: string;
  autoStart: boolean;
  autoStop?: boolean;
  connectionMode?: TunnelConnectionMode;
  tunnelType?: TunnelType;
  remoteBindAddress?: string;
  localTargetIP?: string;
  localBindAddress?: string;
  notes?: string;
  browserUrl?: string;
}

export interface SerialDeviceHint {
  manufacturer?: string;
  serialNumber?: string;
  vendorId?: string;
  productId?: string;
}

export interface SerialProfile {
  id: string;
  name: string;
  group?: string;
  path: string;
  baudRate: number;
  dataBits: SerialDataBits;
  stopBits: SerialStopBits;
  parity: SerialParity;
  rtscts: boolean;
  logSession?: boolean;
  mode?: SerialProfileMode;
  deviceHint?: SerialDeviceHint;
}

export interface LocalShellProfile {
  id: string;
  name: string;
  group?: string;
  launchMode: LocalShellLaunchMode;
  vscodeProfileName?: string;
  shellPath?: string;
  shellArgs?: string[];
  cwd?: string;
  env?: Record<string, string>;
  startupCommand?: string;
}

/**
 * Narrow runtime handle exposed by SshPty / SmartSerialPty / SerialPty. Consumers
 * include the script runtime (observe I/O, write programmatically, lock input),
 * terminal tab commands (reset screen), and the extension deactivate hook
 * (flush a farewell banner before the host tears down).
 */
export interface SessionPtyHandle {
  addOutputObserver(observer: PtyOutputObserver): vscode.Disposable;
  setInputBlocked(blocked: boolean): void;
  /**
   * Write text to the underlying transport (SSH stream or serial port) on behalf of a script.
   * Bypasses the user-input lock (scripts own the lock) but silently no-ops if the session is
   * disconnected — the runtime's NexusCore.onDidChange subscription surfaces ConnectionLost.
   */
  writeProgrammatic(data: string): void;
  /**
   * Clear the visible terminal screen while preserving scrollback history. Emits the
   * clear-screen escape through the PTY's local `writeEmitter` only — never to the
   * remote transport (SSH stream or serial port), so the remote shell state and any
   * connected device remain untouched.
   */
  resetTerminal(): void;
  /**
   * Write a final farewell banner and tear down the transport while keeping the
   * terminal tab visible. Used when the extension host is shutting down (reload,
   * disable, update) so the user sees a clear message instead of a silently hung
   * tab. Implementations MUST NOT fire `closeEmitter` or call `dispose()`.
   */
  markShuttingDown(reason: string): void;
}

export interface ActiveSession {
  id: string;
  serverId: string;
  terminalName: string;
  startedAt: number;
  pty?: SessionPtyHandle;
}

export interface ActiveSerialSession {
  id: string;
  profileId: string;
  terminalName: string;
  startedAt: number;
  status?: SerialSessionStatus;
  pty?: SessionPtyHandle;
}

export interface ActiveLocalShellSession {
  id: string;
  profileId: string;
  terminalName: string;
  startedAt: number;
  pty?: SessionPtyHandle;
}

export interface TunnelRouteInfo {
  profileId: string;
  serverId: string;
  localPort: number;
  remoteIP: string;
  remotePort: number;
  connectionMode: ResolvedTunnelConnectionMode;
  tunnelType: TunnelType;
  remoteBindAddress?: string;
  localTargetIP?: string;
  localBindAddress?: string;
  startedAt: number;
}

export interface ActiveTunnel extends TunnelRouteInfo {
  id: string;
  bytesIn: number;
  bytesOut: number;
}

export interface TunnelRegistryEntry extends TunnelRouteInfo {
  ownerSessionId: string;
  lastSeen?: number;
}

export interface AuthProfile {
  id: string;       // UUID
  name: string;     // e.g. "Production Servers"
  username: string;
  authType: AuthType;
  keyPath?: string;  // only for authType === "key"
  // Password stored in SecretVault under "auth-profile-password-{id}"
  // Key passphrase stored in SecretVault under "auth-profile-passphrase-{id}"
}

/**
 * The credential fields a linked auth profile can take over on a server —
 * every key present is one the profile SUPPLIES, carrying the exact value it
 * supplies. A key that is absent is one the server keeps for itself.
 */
export type AuthProfileOwnedCredentials = Partial<Pick<ServerConfig, "username" | "authType" | "keyPath">>;

/**
 * REVIEW FINDING (P2) — THE ONE RULE for "which credential fields does this
 * auth profile actually own?", shared verbatim by all three layers that had
 * each been answering it their own way:
 *
 *   * the CONNECT path — `SilentAuthSshFactory.resolveServer` spreads this
 *     over the server, so an unowned field keeps the server's own value
 *     instead of being blanked by the profile;
 *   * the SAVE path — `preserveLinkedServerCredentials` (serverCommands.ts)
 *     restores ONLY the owned keys from the stored record, so an edit the form
 *     legitimately permitted survives Save;
 *   * the FORM path — `authProfileFilledKeys` (ui/formDefinitions.ts) seeds the
 *     webview's `profileFilledKeys` from this, and the two `onAutofill` mirrors
 *     (`authProfileCredentialMirror` in serverCommands.ts,
 *     `authProfileUsernameMirror` in inventoryCommands.ts) send exactly these
 *     keys, so the webview's own runtime record (`filledKeysFromValues`, which
 *     independently drops blanks) lands on the same set by construction.
 *
 * THE RULE: a profile owns a field only when it supplies a USABLE value for
 * it. Blank and whitespace-only are not usable values — a whitespace username
 * is reachable through an imported backup (`validateAuthProfile` only checks
 * length; the profile editor trims and refuses blanks), and a `key` profile
 * with no `keyPath` is reachable through the editor itself. Owning such a
 * field means overwriting a working credential with one no SSH login can use,
 * locking the form control that could repair it, and reverting the repair if
 * the control was unlocked anyway. `authType` is a closed enum that is never
 * blank, so it is always owned.
 *
 * Values are returned TRIMMED, matching what the profile editor stores and
 * what `authProfileUsernameMirror`/`fallbackUsernameForSource` already showed
 * and saved — so what a form displays is bit-identical to what a connection
 * uses. An `undefined` profile (no link, or an id that resolves to nothing)
 * owns nothing; the caller's own value stands everywhere.
 *
 * REVIEW FINDING (P2) — both string fields are TYPE-CHECKED, not merely
 * defaulted, before they are trimmed. `AuthProfile.keyPath` is declared
 * `string | undefined` and `validateAuthProfile` (utils/validation.ts) now
 * enforces exactly that at both boundaries a foreign record can enter through
 * (an imported backup and a globalState load), so a non-string reaching here
 * should be impossible. It is guarded anyway because this rule is called from
 * RENDERING paths — the tree's server tooltips, every form that carries the
 * Auth Profile select, the sync plan — where an exception is not a rejected
 * record but a blank sidebar or a form that never opens. A bare
 * `(profile.keyPath ?? "").trim()` throws on the one value it exists to
 * reject; this lands it in the same bucket blank already occupies, "supplies
 * no usable key path", which is both survivable and semantically right. Cheap
 * insurance against a profile built in-process, a future writer, or a boundary
 * someone adds later without this check.
 */
export function authProfileOwnedCredentials(profile: AuthProfile | undefined): AuthProfileOwnedCredentials {
  if (!profile) {
    return {};
  }
  const owned: AuthProfileOwnedCredentials = { authType: profile.authType };
  const username = typeof profile.username === "string" ? profile.username.trim() : "";
  if (username !== "") {
    owned.username = username;
  }
  const keyPath = typeof profile.keyPath === "string" ? profile.keyPath.trim() : "";
  if (keyPath !== "") {
    owned.keyPath = keyPath;
  }
  return owned;
}

/**
 * The username a connection to `server` will ACTUALLY log in as, given the auth
 * profile it links to (`undefined` for no link, or a link that resolves to
 * nothing). One line, but it is the one line the CONNECT path decides by —
 * `SilentAuthSshFactory.resolveServer` spreads `authProfileOwnedCredentials`
 * over the server, so an owned username replaces the server's and an unowned one
 * leaves it standing — and a linked server keeps its own `username` stored
 * UNDERNEATH the link, so `server.username` and this can legitimately differ.
 *
 * REVIEW FINDING (P2) — anything that tells the user, or a command line, which
 * account is in play must ask THIS rather than read `server.username`, or it
 * describes a login that will not happen. Callers: the deploy-key flow
 * (`resolveEffectiveUsername`, commands/serverCommands.ts) and `${profile.username}`
 * (commands/serverMacroCommands.ts), whose whole contract is "resolves to what
 * this server connects with".
 */
export function effectiveServerUsername(
  server: Pick<ServerConfig, "username">,
  profile: AuthProfile | undefined
): string {
  return authProfileOwnedCredentials(profile).username ?? server.username;
}

/**
 * REVIEW FINDING (P1) — the companion question THE ONE RULE above cannot
 * answer on its own: "can a server that brings NO key path of its own connect
 * through this profile?"
 *
 * `authType` is a closed enum and so is ALWAYS owned — deliberately, and that
 * stays (see below). The consequence is that a `key` profile with no key path
 * forces `authType: "key"` onto every server it is linked to while supplying
 * nothing for `keyPath`; `buildConnectConfig` (services/ssh/ssh2Connector.ts)
 * then throws `Missing keyPath for key auth on <server>` unless the SERVER
 * carries one itself. Such a profile is perfectly legitimate — it is the
 * shared-passphrase, per-server-key-file pattern the server form supports on
 * purpose (`updateProfileManagedFields` in ui/formHtml.ts leaves the Private
 * Key File control editable for exactly this profile, and
 * `preserveLinkedServerCredentials` keeps what you type into it). It is only
 * unusable where the server can have no key path of its own, which is every
 * server an inventory sync creates: the add path stamps the LINK only, with
 * `authType: "agent"` and no `keyPath`, and retro-apply targets precisely the
 * servers that still carry that shape.
 *
 * WHY NOT FIX THIS IN THE OWNERSHIP RULE INSTEAD (i.e. make such a profile own
 * no `authType` either) — three reasons, any one of them decisive:
 *
 *   * It would SILENTLY SUBSTITUTE the credentials the user did not choose.
 *     A synced server whose profile no longer owns `authType` keeps its own
 *     "agent", so the sync's servers go back to SSH-agent auth while the
 *     source's form still says the profile is linked and the profile still
 *     says key auth. Silently connecting with credentials nobody chose is the
 *     defect class this whole feature exists to remove, not a fix for it.
 *   * It would break the legitimate pattern above for every server whose own
 *     `authType` is not already "key". Linking such a profile to a manual
 *     password server plus a key file is a working, intended configuration
 *     today; dropping `authType` ownership turns it into a password login.
 *   * THE ONE RULE is per-field — "does the profile supply a usable value for
 *     THIS field" — and stays answerable from the profile alone. The question
 *     here is about a PAIRING (profile + a server that may or may not have a
 *     key path), so it belongs to whoever decides that pairing, which is what
 *     this predicate is for.
 *
 * Callers: the inventory source form's two persist helpers (reject the link at
 * the moment the user chooses it) and `computeSyncPlan` (refuse to stamp such
 * a link on adds OR through retro-apply, and warn) — see inventoryCommands.ts
 * and services/inventory/syncEngine.ts.
 *
 * Read off `authProfileOwnedCredentials` rather than off `profile.keyPath`
 * directly, so "supplies no usable key path" means exactly what it means
 * everywhere else — a whitespace-only path included.
 */
export function authProfileNeedsServerKeyPath(profile: AuthProfile | undefined): boolean {
  const owned = authProfileOwnedCredentials(profile);
  return owned.authType === "key" && owned.keyPath === undefined;
}

/** Which credential fields a server form submission actually carries USER INPUT
 *  for — see `formOfferedServerCredentials`. */
export interface FormOfferedServerCredentials {
  username: boolean;
  authType: boolean;
  keyPath: boolean;
}

/**
 * REVIEW FINDING (P1) — THE SAVE-SIDE INVARIANT, and the reason this whole
 * class of defect kept coming back one mirror image at a time.
 *
 *   A credential field on a LINKED server is user input only if the form
 *   actually OFFERED it. Everything else comes from the stored record —
 *   never from the submission, which may carry an echo of the profile, or
 *   nothing at all, for reasons that have nothing to do with intent.
 *
 * There are exactly three ways a credential key reaches the save path, and the
 * submission cannot tell them apart on its own:
 *
 *   * LOCKED — the profile supplies it (`authProfileOwnedCredentials`), so the
 *     control renders read-only holding the profile's value. A read-only
 *     control still submits, and writing that echo through would overwrite the
 *     server's own stored credential with the profile's, so unlinking later
 *     would leave the server on credentials it never had.
 *   * HIDDEN — the control is not on screen at all. `keyPath` is
 *     `visibleWhen: authType === "key"`, and `updateVisibility` (ui/formHtml.ts)
 *     DISABLES what it hides while the submit loop skips every disabled
 *     control, so the key simply is not in `values`. A hidden-and-disabled
 *     control is not evidence the user cleared anything.
 *   * OFFERED — visible and unlocked. Only this one is an answer.
 *
 * Deciding per-field on ownership ALONE closes one direction and opens its
 * mirror, which is what happened twice: restoring every field a link existed
 * for discarded the edits the form had legitimately permitted (a key path typed
 * under a `key` profile that carries none), and restoring only the OWNED fields
 * then erased the key path of a `key` server linked to a `password`/`agent`
 * profile — that profile owns `authType`, so the form renders "Password", which
 * hides the Private Key File control, which drops it from the submission, which
 * this could not put back because the profile does not own it. An unrelated
 * rename was enough to destroy the file, and the record's own `authType: "key"`
 * (restored, because `authType` IS owned) then failed with `Missing keyPath for
 * key auth` at the next connect.
 *
 * `submitted.authType` is the ORACLE for the hidden case, deliberately: it is
 * the form's OWN live value for the control every visibility rule here keys
 * off, so this reproduces what the form did rather than re-deriving what it
 * should have done. Those agree whenever the form is in sync; where they can
 * differ — a Save clicked in the round trip between choosing a profile and its
 * mirror landing — the form's own value is the honest one, and re-deriving from
 * the profile would resume erasing key paths in exactly that window.
 * `formValuesToServer` has already normalised it to a real `AuthType`, so a
 * malformed or absent submission degrades to "not offered", i.e. to keeping
 * what is stored.
 *
 * Read together with THE ONE RULE (`authProfileOwnedCredentials`) — this
 * answers a strictly wider question, so it consumes that rather than repeating
 * it. Callers: `preserveLinkedServerCredentials` (commands/serverCommands.ts),
 * the sole writer of a linked server's credentials from a form. The RENDER's
 * half of the same statement lives in `applyLinkedAuthProfileValues` /
 * `authProfileFilledKeys` (ui/formDefinitions.ts) plus the `visibleWhen` on the
 * key path descriptor; the two are bound together by a test that opens the real
 * form over a matrix of (record, profile) pairs and asserts the fields it
 * leaves visible-and-unlocked are exactly the ones this returns `true` for
 * (test/unit/authProfileSwitchTransition.test.ts).
 */
export function formOfferedServerCredentials(
  submitted: Pick<ServerConfig, "authType">,
  profile: AuthProfile | undefined
): FormOfferedServerCredentials {
  const owned = authProfileOwnedCredentials(profile);
  return {
    // Always rendered; only ownership can take it away.
    username: owned.username === undefined,
    // A closed enum is always owned, so this is `true` only where nothing
    // resolved — no link, or an id that names no profile, which is the same
    // state the form renders the record's own value unlocked for.
    authType: owned.authType === undefined,
    // The one field that can be taken away twice over.
    keyPath: owned.keyPath === undefined && submitted.authType === "key"
  };
}

/**
 * REVIEW FINDING (P1) — the profile facts a server form's render committed to,
 * reduced to exactly what the save path later re-reads, so a submission can be
 * checked against the profile it was actually composed against.
 *
 * WHAT IS IN IT, and why nothing else is: `formOfferedServerCredentials` and
 * `preserveLinkedServerCredentials` between them consume WHICH keys the profile
 * owns plus the VALUE of the one owned key the form displays as the server's
 * effective auth type. A profile edit that changes any of those changes what
 * the open form would have shown and what this submission means:
 *
 *   * gaining a key file turns a key path the user typed into an unowned field
 *     into a value the save now discards without a word;
 *   * losing one turns the profile's own mirrored path, sitting locked in that
 *     field, into "user input" that the save writes onto the server as its own;
 *   * gaining or losing a username does the same to the username field;
 *   * changing `authType` changes which credential control the form rendered at
 *     all.
 *
 * A profile's VALUES are excluded on purpose. A linked server never stores the
 * profile's username or key path — it keeps its own underneath the link — so a
 * value that changes while the form sits open changes nothing this submission
 * writes, and the link means the profile decides at connect time regardless of
 * whether this Save happens. Rejecting on that would refuse saves that are
 * correct.
 *
 * A string so the comparison is `===` and cannot itself drift; `undefined`
 * (no profile) has its own signature, so "the profile was deleted" never reads
 * as equal to any live shape.
 */
export function authProfileOwnershipSignature(profile: AuthProfile | undefined): string {
  const owned = authProfileOwnedCredentials(profile);
  return [
    owned.authType ?? "no-profile",
    owned.username !== undefined ? "username" : "-",
    owned.keyPath !== undefined ? "keyPath" : "-"
  ].join("|");
}

export function resolveTunnelType(profile: TunnelProfile): TunnelType {
  return profile.tunnelType ?? "local";
}

export function resolveSerialProfileMode(profile: Pick<SerialProfile, "mode">): SerialProfileMode {
  return profile.mode ?? "standard";
}
