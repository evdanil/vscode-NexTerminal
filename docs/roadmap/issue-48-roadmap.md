# IPMI/BMC Phases 2–4 — Design & Plan (issue #48 follow-up, post-PR #55)

Author context: Phase 1 merged (v2.8.95, PR #55): `ServerConfig.ipmiHost`, `${profile.*}` tokens with positive-charset validation at the substitution chokepoint (`src/services/profileTokens.ts`), `runIn: session|localTerminal|browser`, `nexus.server.runMacro`, shipped IPMI SOL + web-console templates. Ogun's answers: NetBox `oob_ip` is the sync source; ONE universal IPMI credential org-wide, wants assignment via an Auth profile; IPMI path must be independent of the SSH session and work "from the local shell or via a jump host".

---

## TL;DR

- **Phase 2 (NetBox `oob_ip` → `ipmiHost`)** is small and fully unblocked. The provider adds a second endpoint (`kind: "redfish"`, from `oob_ip`) in `mapEntry` (`src/services/inventory/providers/netboxProvider.ts:418-445`); the sync engine maps it into `ipmiHost` with a new `ServerOrigin.syncedIpmiHost` stamp that follows the **`syncedAuthProfileId` discipline** ("record what the sync wrote; only fill/overwrite what still matches the stamp"), *not* the `host`/`port` "device always wins" discipline — because Phase 1 users have already hand-typed `ipmiHost` and a device losing its `oob_ip` must never erase it. One PR, ~6 files.
- **Phase 3 (IPMI credentials via auth profiles)** should **reuse the existing `AuthProfile` store** via a new `ServerConfig.ipmiAuthProfileId` link — exactly what Ogun asked for ("assign IPMI credentials via an Auth profile"), and it inherits the editor, SecretStorage keys (`auth-profile-password-{id}`, `src/services/ssh/silentAuth.ts:20-22`), backup export (`src/commands/configCommands.ts:1216-1219`) and deletion sweep for free. Password reaches ipmitool via **terminal env injection** (`createTerminal({ env })` + `ipmitool -E`, which reads `IPMITOOL_PASSWORD` then `IPMI_PASSWORD` — set both), never argv, never the capture buffer. A new token `${profile.ipmiUsername}` joins the whitelist. Shipped SOL template flips to `-U ${profile.ipmiUsername} -E`, with masked prompt-into-env as the fallback when no credential is stored.
- **Phase 4 (jump-host routing)** — REVISED READING (owner correction): Ogun's "from the local shell or via a jump host" means *where ipmitool runs* — locally when the BMC is reachable, **on the jump host** when it isn't — not tunneling the IPMI connection to the local machine. That makes jump-host **execution** the primary deliverable (PR-C): a `localTerminal` macro on a server with an IPMI gateway delivers into a session terminal of the gateway server instead, reusing the existing connect-first machinery (`src/commands/serverMacroCommands.ts:260-349`), tokens still resolved against the target server. The UDP analysis below stands as background — `ipmitool -I lanplus` is RMCP+ over UDP/623 and nothing over SSH can tunnel UDP (`TunnelManager` is TCP end to end) — but it now merely *confirms* the jump-host-execution reading rather than constraining the ask; no expectation needs correcting on the issue. The **web console via ephemeral tunnel** (browsers can't run on the jump host, so TCP/443 tunneling is the only jump-host path for the web UI) is demoted to an optional follow-up (PR-D) on demonstrated demand.
- **Sequencing:** PR-A = Phase 2 (now). PR-B = Phase 3 (now; independent of A). PR-C = Phase 4 jump-host execution (needs only light confirmation from Ogun: gateway topology + ipmitool-on-bastion + the `-a` password prompt). PR-D = web-console tunnel (optional, on demand).

---

## Phase 2 — NetBox `oob_ip` → `ipmiHost`

### 2.1 Provider change (`src/services/inventory/providers/netboxProvider.ts`)

`mapEntry` (`:418-445`) already reads `primary_ip.address` (`:432-434`) and emits a single `ssh` endpoint (`:443`). Change:

- Read `obj.oob_ip` with the same defensive shape (`{ address?: unknown } | null | undefined`) and, when it carries a non-empty string address, append `{ kind: "redfish", host: stripCidr(address) }` to `endpoints`. `stripCidr` exists (`:63-66`). **Devices only** — NetBox VMs have no `oob_ip`, so the `kind === "vm"` branch emits nothing new (`vmVars` at `:384-394` already documents the VM field asymmetry precedent).
- No new API call, no new config field: `oob_ip` is on the same `/api/dcim/devices/` rows the pagination already fetches (`brief` mode is already stripped from user filters at `:20`, so full rows are guaranteed).
- **Endpoint-kind choice:** `"redfish"`, not `"ipmi-sol"`. Both are reserved (`src/models/inventory.ts:5`), but `oob_ip` is a generic OOB address and `ServerConfig.ipmiHost`'s own doc calls itself "IPMI / BMC / Redfish" (`src/models/config.ts:109-110`). The sync engine should select on *either* kind (below), so a third-party provider emitting `ipmi-sol` maps identically — the choice here is cosmetic, and `validateInventoryTree` only requires `kind` to be a string (`src/services/inventory/syncEngine.ts:1052-1054`), so no contract change.
- **Careful with the "skipped" bookkeeping:** the `skippedCount` warning ("devices without a primary IP were skipped") is currently keyed on `mapped.endpoints.length === 0` (`:521,526`). Once an OOB endpoint can exist without a primary IP, that predicate must become "has no `ssh` endpoint", or a device with only an `oob_ip` silently drops out of the warning while still being unmappable to SSH. (The device is still emitted either way — FIX 1's never-drop rule at `:396-416` is untouched, and `presentExternalIds` still protects it from pruning, `syncEngine.ts:316-321`.)

### 2.2 Sync-engine mapping (`src/services/inventory/syncEngine.ts`)

Add a sibling to `selectSshEndpoint` (`:59-66`):

```ts
/** First endpoint with kind "redfish" or "ipmi-sol" and a non-empty host. */
function selectManagementEndpoint(device: InventoryDevice) { ... }
```

Wire it into both write paths of `computeSyncPlan`:

- **Add path** (`:755-794`): `ipmiHost: mgmt?.host` on the new record, and `syncedIpmiHost: mgmt?.host` in the origin literal (`:787-793`) — recorded **unconditionally, `undefined` included**, mirroring the `syncedAuthProfileId` rationale at `:775-786` ("a source that gains one later must find the stamps already there").
- **Update path** (`:425-474`): `afterOrigin` carries `syncedIpmiHost: ownedServer.origin?.syncedIpmiHost` **forward verbatim by default** (same carry-forward-is-load-bearing argument as `syncedAuthProfileId`, `:452-465` — an unrelated device rename rebuilds `origin` from scratch and must not erase the stamp). Then the write rule (see matrix below) decides whether `after.ipmiHost` and the stamp move.
- **`changed` comparison** (`:719-726`): add `ownedServer.ipmiHost !== after.ipmiHost`. The origin-stamp half comes free once `serverOriginStampsEqual` learns the field (below) — and note AUTH 3a's precedent (`:704-714`): a legacy server whose device supplies an `oob_ip` **equal** to its hand-typed `ipmiHost` changes only the stamp, and discarding that `after` would strand the server stampless forever. The stamps-equal clause is what catches it.

### 2.3 `syncedIpmiHost` stamp semantics — the add/update/edit/rollback matrix

**Which discipline?** Not `host`/`port` ("always taken from the device", `:421-424`): Phase 1 shipped `ipmiHost` as a hand-edited field months before sync could write it, so "device always wins" would clobber every early adopter's manual entry on the first post-upgrade sync — and, worse, a device with **no** OOB endpoint would read as "the field should be empty". The correct model is the **`syncedUsername`/`syncedAuthProfileId` model** (`src/models/config.ts:43-92`): the stamp records what the sync itself last wrote, and the sync only writes where the record still carries exactly that.

Decision matrix (`cur` = `ownedServer.ipmiHost`, `stamp` = `origin.syncedIpmiHost`, `oob` = management endpoint's host this fetch):

| cur | stamp | oob | action | why |
|---|---|---|---|---|
| unset | unset | present | **write + stamp** | never configured — the retro-apply-eligible state, same as `syncedAuthProfileId === undefined && authProfileId === undefined` (`:499-527`) |
| unset | set | present | **leave alone** | user *cleared* a synced value — the per-server opt-out clause, verbatim from `:499-508` |
| == stamp | set | present, different | **write + re-stamp** | still exactly what the sync wrote → sync owns it |
| ≠ stamp | any | present | **leave alone; carry stamp forward** | hand-edit; never launder it into the stamp (`:56-60`: "never inferred from the record's current value") |
| set (hand) | unset | present | **leave alone** | legacy/Phase-1 hand entry; absent stamp must not mean "sync owns it". Accepted asymmetry vs. `syncedUsername`'s fallback (`:582-594`): there is no `defaultIpmiHost` to fall back to, so absent simply means hands-off |
| any | any | **absent** | **never touch `ipmiHost`; carry stamp forward** | mirrors the provider's own FIX-1 stance (`netboxProvider.ts:396-403`): losing an address at the source is routine maintenance, not a deletion. Accepted staleness: a genuinely removed BMC keeps its last-known address until the user clears it |

- **Rollback safety:** `serverOriginStampsEqual` (`config.ts:173-182`) gains `a.syncedIpmiHost === b.syncedIpmiHost`; `serverOriginsEqual` (`:184-195`) inherits it by construction ("a member added to ServerOrigin can only be forgotten in a single place", `:170-172`), which is what keeps `mergeServerConfigFields`' conditional origin restore (`:273-275`) from dropping a freshly written stamp. `ServerConfig.ipmiHost` itself is **already** in `serverConfigsEqual` (`:221`) and `mergeServerConfigFields` (`:265`) — Phase 1 paid that bill; nothing to do there. `cloneServerConfig` (`:136-142`) spreads `origin` one level deep — a new scalar member is covered.
- **Known downgrade skew (annotation from the device-template design review, A-M3):** an OLD build's update path rebuilds `origin` from a literal of known members only (`syncEngine.ts:425-466` as of that build), so one sync run on a pre-PR-A build erases `syncedIpmiHost` from every device it updates (any rename/IP change). Back on a new build the record reads as matrix row 5 — hand-set, hands-off forever — **silently**. The value itself survives; only sync ownership is lost. This cannot be prevented from the new build's side. Recovery is per-server: clearing `ipmiHost` re-enters the write-and-stamp state. Note the transport for this skew is a **downgrade or a backup round-trip through an old build** — globalState is per-machine (no `setKeysForSync` anywhere in `src/`), so Settings Sync is *not* a vector; earlier drafts that said "Settings Sync skew" meant this. Document in the PR description as a known limitation.

### 2.4 Validation: sync time vs use time

- **Use time stays the chokepoint** — `validateTokenValue` (`src/services/profileTokens.ts:481-500`) already refuses a hostile `ipmiHost` at every run, and `ServerConfig.ipmiHost`'s own doc names the substitution site as the enforcement point precisely because values arrive via sync/import (`config.ts:110-115`). Phase 2 adds **no trust** to synced values.
- **Sync time adds a warning, not a rejection:** export the address validator (`isAddressValue`, `profileTokens.ts:251-257` — pure module, no `vscode` import, safe for `syncEngine`) and, when a management endpoint's host fails it, **skip the write and warn** (`Device "X" has an out-of-band address that cannot be used ("…") — ignored.`). Storing a value the chokepoint will refuse on every run helps nobody, and warning at sync is the only moment the user can connect the bad value to its NetBox origin. The device's SSH mapping proceeds untouched.

### 2.5 Tests (fail-against-the-wrong-implementation, per CLAUDE.md)

- `test/unit/` (config model): two origins differing **only** in `syncedIpmiHost` → `serverOriginStampsEqual` false (fails if the comparator is forgotten — the exact vacuous-fixture trap: build them identical elsewhere). Merge-rollback fixture (CORRECTED per template-design review m6 — the earlier "concurrent edit touched `group`" version was vacuous: current and batchSnapshot agreed on the stamp, so comparator membership was unobservable): `current.origin` differs from `batchSnapshot.origin` **only** in `syncedIpmiHost` (a concurrent system-initiated clear landed while the batch was in flight) → `mergeServerConfigFields` must keep **current's** origin (the concurrent change is real); a comparator missing the member calls the two origins equal and silently restores the pre-batch origin, resurrecting the cleared stamp — which is exactly the divergence the fixture must observe.
- `test/unit/` (syncEngine): one fixture per matrix row above, each constructed so the *wrong* rule visibly diverges:
  - hand-edited `cur ≠ stamp` + device supplies a different `oob` → plan's `after.ipmiHost` is the hand edit (fails against "device always wins");
  - `cur === stamp` + new `oob` → overwritten + re-stamped (fails against "never write");
  - `cur` unset + `stamp` set → not reattached (fails against an implementation missing the opt-out clause);
  - legacy hand-set `cur`, no stamp → untouched (fails against "absent stamp = sync owns");
  - endpoint absent + sync-owned `cur` → carried forward with stamp intact (fails against "absent endpoint clears the field");
  - equal-value stamp-only change lands in `updates` (fails if the `changed` clause is forgotten — AUTH 3a's shape).
- `test/unit/` (provider): row with `oob_ip: { address: "10.9.9.9/24" }` → second endpoint `{ kind: "redfish", host: "10.9.9.9" }`; `oob_ip: null` → ssh only; **name + oob but no primary_ip** → redfish-only endpoints *and* still counted in the no-SSH warning (fails against the stale `endpoints.length === 0` predicate).

**Size:** one well-bounded PR. Files: `netboxProvider.ts`, `syncEngine.ts`, `models/config.ts` (ServerOrigin + comparators), `profileTokens.ts` (one `export`), tests. No UI change, no new settings.

---

## Phase 3 — IPMI credentials via Auth profiles

### 3.1 Model: reuse `AuthProfile`, add `ipmiAuthProfileId`

Ogun's ask is literally "assign IPMI credentials via an Auth profile within Nexus". The merged PR #53 model fits: `AuthProfile { id, name, username, authType, keyPath? }` with password in SecretStorage under `auth-profile-password-{id}` (`src/models/config.ts:416-424`; keys minted in `src/services/ssh/silentAuth.ts:20-26`; editor stores/clears the secret in `src/ui/authProfileEditorPanel.ts:231-248`; backup export already round-trips profile passwords, `src/commands/configCommands.ts:1216-1219`). An IPMI credential **is** a username+password pair — an `authType: "password"` profile models it with zero new storage machinery.

**Decision: a parallel link field, not a parallel concept.**

```ts
// ServerConfig (src/models/config.ts:95-125)
/** Auth profile whose username/password are the BMC's credentials. Same
 *  AuthProfile store as `authProfileId`; resolved at run time, never copied. */
ipmiAuthProfileId?: string;
```

- Rejected: a separate `IpmiCredentialProfile` store — would need its own tree, editor, backup section, secret keys and deletion sweep; buys nothing over filtering the existing picker.
- Rejected: per-server `ipmi-password-{serverId}` secrets — contradicts the stated "one universal credential across all hosts" usage; a single shared profile linked from many servers is the shape of the requirement.
- Bookkeeping bill (the Phase-1 checklist from the assessment, §1.2): `serverConfigsEqual` + `mergeServerConfigFields` (`config.ts:207-227`, `:252-280`) gain the field; `validateServerConfig` (`src/utils/validation.ts`) gets the tolerant type check; **`NexusCore.removeAuthProfile` (`src/core/nexusCore.ts:316`) must also clear `ipmiAuthProfileId` links**, and the backup-import dangling-reference sweep in `configCommands.ts` must treat it like `authProfileId` (the `syncedAuthProfileId` doc at `config.ts:85-91` explains why a system-initiated clear differs from a user opt-out — no stamp is involved here, so it's just the clear).
- **Sync interaction: none in this phase.** `computeSyncPlan` never reads or writes `ipmiAuthProfileId`, so no stamp is needed. (Source-level auto-assignment — "every server this NetBox source syncs gets the universal IPMI profile" — is a natural v2 that would reuse the AUTH 2 retro-apply machinery wholesale; deliberately deferred, see open questions.)

### 3.2 Token: `${profile.ipmiUsername}`

- `PROFILE_TOKEN_WHITELIST` (`src/services/profileTokens.ts:26`) gains `"ipmiUsername"`; its charset rule is `USERNAME_CHARSET` (`:287`) — the `default: return false` arm at `:495-498` forces this decision at add time by design. Labels/locations/guidance records (`:31-74`) get entries ("IPMI Username", "under Advanced options in the server form").
- Resolution is **not** a raw `ServerConfig` field, so it threads through the same seam Phase 1 built for the linked-profile username: `profileTokenServer` (`src/commands/serverMacroCommands.ts:383-387`) already rewrites `username` via `effectiveServerUsername` (`config.ts:514-519`); it now also resolves `ctx.core.getAuthProfile(server.ipmiAuthProfileId)?.username` into a synthetic field the resolver reads. Cleanest shape: widen `resolveProfileTokens`' input type from `Pick<ServerConfig, ProfileTokenName>` (`:903-907`) to a small `ProfileTokenFacts` record assembled by `profileTokenServer` — keeps `profileTokens.ts` pure and `vscode`-free.
- Missing link or blank profile username → the existing typed `missing` refusal with the Edit Server route (`:729-738`); the trimmed-blank rule comes free from `authProfileOwnedCredentials`' "usable value" discipline (`config.ts:482-496`).
- **Old-build degradation is already graceful:** a build whose whitelist lacks `ipmiUsername` treats it as an unknown token — sent verbatim with the "sent as-is" delivery note (`serverMacroCommands.ts:211-219`, `profileTokens.ts:916-925`). Visible, not silent; worth one line in docs/macros.md.

### 3.3 Password pathway: env injection, never argv

- **Mechanism:** `localTerminalTarget` (`serverMacroCommands.ts:140-155`) currently calls `vscode.window.createTerminal({ name })`. It becomes async-capable (the `MacroSendTarget.send` contract already allows `Promise<boolean>` — `browserTarget` uses it, `:161`) and, when a password is in hand, passes `createTerminal({ name, env: { IPMITOOL_PASSWORD: pw, IPMI_PASSWORD: pw } })`. **Both** variables: ipmitool's `-E` checks `IPMITOOL_PASSWORD` first, then `IPMI_PASSWORD` (ipmi_main.c), and setting both sidesteps version drift. The vault read uses `ctx.secretVault` (`src/commands/types.ts`, `CommandContext.secretVault`) with `authProfilePasswordSecretKey(server.ipmiAuthProfileId)`.
- **When to inject:** only for `runIn: "localTerminal"` runs whose resolved macro text references an IPMI token (`profileTokensUsed(macro.text)` includes `ipmiHost` or `ipmiUsername`, `profileTokens.ts:953-966`) **and** whose target server links an IPMI profile. Injecting into every local terminal any macro spawns would hand the credential to unrelated commands for no benefit; the token-usage gate is observable in the picker and documentable. (Alternative — an explicit per-macro checkbox — is cleaner consent but one more editor control; noted as an option if review prefers explicitness.)
- **Fallback when no password is stored (or no profile linked): masked prompt → env, not argv.** The run path prompts with a masked InputBox (the `macroVariablePrompt.ts` discipline: never remembered, cancel aborts) and injects the answer into the terminal env the same way. This means the **shipped SOL template can drop the `$password` variable entirely**:

  ```
  " ipmitool -I lanplus -H ${profile.ipmiHost} -U ${profile.ipmiUsername} -E sol activate\n"
  ```

  (`src/commands/macroCommands.ts:113-136`.) The `-P $password` form dies as documented practice — which was the assessment's §2.5 goal. Keep `$username` prompting? No: `${profile.ipmiUsername}`'s own `missing` refusal points at the server form; for users who genuinely want prompt-per-run, the old template text still works and the docs say so. **Template compatibility note:** templates are copied at insert time, so existing user macros are untouched; only new inserts get the `-E` form. A `-E` macro run on an old build (Settings Sync skew) spawns a terminal without the env var and ipmitool fails with its own clear "password not available" error — degraded but honest, worth a docs line.
- **Security notes (the checklist for the PR description):** password never enters `resolution.text`, so it can never hit `sendText`, remote `ps`, scrollback, or `TerminalCaptureBuffer`/Copy All (the NexTerminal-specific leak the assessment §2.5 identified); the chokepoint invariant that no substituted value may contain `$`/backtick (`profileTokens.ts:436-442`) is untouched because the password is not a substituted value; env vars are readable from `/proc/self/environ` by the same OS user only — strictly better than argv, same trust boundary as the SSH agent socket; the env var dies with the terminal.

### 3.4 UI

- **Server form** (`src/ui/formDefinitions.ts`): an "IPMI Auth Profile" select next to the `ipmiHost` field (`:211`), built on `authProfileSelectField` (`:175-180`), `advanced: true`. Lists all auth profiles — an `authType: "password"` profile is the expected shape, but nothing breaks with others (only `username` + stored password are ever read; `authType`/`keyPath` are ignored on this link, and the hint text says so). No changes to the auth-profile editor itself.
- Optional polish (cheap): the server tooltip line that shows the auth profile gains an "IPMI: <profile>" line; the `nexus.server.runMacro` picker's `missing` flag already covers the discoverability need (`serverMacroCommands.ts:80-84`).

### 3.5 Tests

- Env-injection unit test with mocked `vscode`: run a `localTerminal` macro using `${profile.ipmiHost}` against a server with a linked profile + vaulted password → assert `createTerminal` received the env pair **and** the password appears nowhere in the `sendText` payload (fails against the wrong implementation that substitutes into text — the test this feature exists to prevent).
- Gate test: same macro, server **without** IPMI tokens in text → no env injection (fails against "always inject").
- Fallback test: no stored password → prompt invoked, answer lands in env, cancel sends nothing.
- Model tests: records differing only in `ipmiAuthProfileId` → `serverConfigsEqual` false / merge preserves the concurrent edit; `removeAuthProfile` fixture where a server links the deleted profile via `ipmiAuthProfileId` **only** → link cleared (fails if the sweep only handles `authProfileId`).
- Token test: `${profile.ipmiUsername}` resolves through the link; blank profile username → `missing` refusal; charset refusal on `@args`-style value (the `USERNAME_CHARSET` positional-`@` rule, `profileTokens.ts:269-287`).

**Size:** medium PR — model + validation + sweep + token + env pathway + form select + template + docs. Independent of Phase 2 (touches disjoint code except `ServerConfig`), so either order merges cleanly.

---

## Phase 4 — Jump-host routing ("IPMI session independent of SSH session")

> **REVISED READING (owner correction, supersedes the framing below where they conflict):**
> Ogun means *running ipmitool on the jump host*, not tunneling the IPMI connection to the
> local system. Consequences for this section:
> - **Path B is the primary deliverable and becomes PR-C.** Its design below stands unchanged.
> - **Path A (web console via ephemeral tunnel) is demoted to optional PR-D** — still the only
>   way to reach a BMC *web UI* through a jump host (a browser cannot run remotely), but built
>   only on demonstrated demand.
> - §4.1 remains as background/justification, not as a message that must "correct" Ogun —
>   his ask is buildable as stated. Open questions to him shrink accordingly (see revised list).

### 4.1 Honest technical assessment first: the UDP problem

- IPMI lanplus (RMCP+) — the transport of the shipped SOL template — is **UDP port 623**. SOL payloads ride the same UDP session.
- Everything NexTerminal can forward is TCP: `TunnelManager`'s local mode is a TCP listener (`net.createServer`, `tunnelManager.ts:179`) piping into an SSH `direct-tcpip` channel (`openDirectTcp`, `:241`; contract at `src/services/ssh/contracts.ts:39`); reverse mode is `tcpip-forward` (`:294-347`); dynamic mode is SOCKS5 **CONNECT only** (`src/services/tunnel/socks5.ts:123` rejects every other command — no UDP ASSOCIATE). The SSH protocol itself has no UDP channel type. **Therefore: local `ipmitool -I lanplus` through any NexTerminal tunnel is impossible, full stop.** This must be stated on issue #48 rather than designed around quietly.
- Non-options, examined and rejected:
  - **SOCKS5 UDP ASSOCIATE**: not implementable over an SSH backhaul (same UDP-over-SSH wall).
  - **sshuttle/TUN-style VPN**: needs root + external tooling on both ends; far outside an extension's remit.
  - **UDP relay via `socat` on the jump host** (UDP↔TCP bridge into a tunnel): requires provisioning tooling on the bastion, breaks RMCP+ timing/retransmit assumptions, and is exactly the kind of half-working footgun the charset-not-quoting philosophy in this codebase argues against.
- What **does** work:
  - **TCP management planes through a tunnel**: BMC web console (HTTPS/443) and Redfish API (HTTPS/443) tunnel perfectly.
  - **Running ipmitool where UDP reachability already exists** — i.e., on the jump host itself, inside an SSH session NexTerminal already knows how to open (independent of any session to the *managed* server, satisfying Ogun's independence requirement).

### 4.2 Recommended architecture

**New field:** `ServerConfig.ipmiGatewayServerId?: string` — "reach this server's BMC via that server" (an id reference into the same server list, like `SshJumpProxy.jumpHostId`, `config.ts:15-18`). Advanced form select next to `ipmiHost`/`ipmiAuthProfileId`; unset = BMC is reachable locally (today's behavior, unchanged).

*Why not reuse `server.proxy` implicitly:* the SSH proxy chain describes how to reach the server's **SSH port**; the BMC network is frequently reachable only from a *different* bastion (or from the bastion but not from the final hop). Guessing would route traffic through the wrong box silently. The form can **pre-fill** the select from `proxy.jumpHostId` when it is an SSH jump — a suggestion, not an inference. (This also answers the assessment's old `$PROXY$` question: the jump host for IPMI is its own explicit field, not a token.)

**Path A — web console via ephemeral tunnel (PR-C1).**
1. `browserTarget` (`serverMacroCommands.ts:157-193`) grows a routing step: after `resolveMacroBrowserUrl` validates the URL, if the URL's hostname equals the server's `ipmiHost` (bracketed-IPv6 normalized) **and** `ipmiGatewayServerId` is set, establish an ephemeral local tunnel — `127.0.0.1:<os-assigned> → SSH(gateway) → ipmiHost:(url port ?? 443)` — then rewrite only the URL authority to `127.0.0.1:<port>` and open that. Doing the rewrite on the **parsed resolved URL** (not in the token pass) keeps `profileTokens.ts` routing-agnostic and its authority machinery (`:585-707`) untouched.
2. Tunnel mechanics: reuse `TunnelManager.start` (`tunnelManager.ts:81-121`) with a synthetic in-memory `TunnelProfile` (`config.ts:282-298`) — `connectionMode: "shared"` so auth/2FA happens once up front (the eager-connect pattern `tunnelCommands.ts:155-183` already uses). Two small manager changes are required: **(i)** support `localPort: 0` by reading back `listenerServer.address().port` into `activeTunnel.localPort` after `listen` (`:191` passes the profile port straight through today; reverse mode already has the read-back precedent with `allocatedPort`, `:320-328`); **(ii)** an `ephemeral` marker on `ActiveTunnel` so the Port Forwarding tree can render a transient "IPMI console → <server>" row with the existing stop action instead of looking up a stored profile. Lifecycle v1: the tunnel stays up (BMC consoles open websockets/KVM streams; killing it on page-load would break them), listed in the tree, stopped manually or on window close — `autoStop`-style idle reaping is v1.1.
3. The gateway hop composes with existing proxy chains for free: the ephemeral tunnel's SSH connection to the gateway goes through `ProxySshFactory` like any other connect, so a gateway that itself sits behind a jump chain works (`src/services/ssh/proxySshFactory.ts:75-117`, circular-chain guard at `:217-239`).
4. **Zero-code fallback that exists today** and should be documented regardless: a persistent `TunnelProfile` (localPort → BMC:443, default server = bastion, `browserUrl` set — `src/utils/tunnelProfile.ts:4-18`) already delivers web-console-via-jump-host by hand. The ephemeral path is the fleet-scale version of it, not new capability.

**Path B — SOL by running ipmitool on the jump host (PR-C2).**
1. For a `localTerminal` macro run where the target server has `ipmiGatewayServerId` set, the run offers/uses "on <gateway>" instead of a local terminal: resolve tokens against the **target** server exactly as today (chokepoint unchanged — the same charset that protects a local shell protects the remote one, `profileTokens.ts:448-480` explicitly reasons about the union of shells), then deliver the text into a **session terminal of the gateway server**, reusing `resolveServerSessionTarget` + `connectAndAwaitSessionTerminal` verbatim (`serverMacroCommands.ts:260-349` — the connect-first confirmation, the connect-failed vs timeout split, the pinned-target discipline all carry over by pointing them at the gateway's `ServerConfig`). SOL is interactive and needs a real PTY, which is why this rides a session terminal rather than `SshConnection.exec()` (`contracts.ts:41`, `ssh2Connector.ts:116-126` — no pty option, and a raw exec stream has no terminal UI anyway).
2. **Credentials on the remote hop — the honest limitation:** Phase 3's env injection cannot reach a remote shell (`createTerminal({env})` is local; SSH `SendEnv` is server-policy-gated), and sending `export IPMI_PASSWORD=…` as text would land the secret in remote history, scrollback, and `TerminalCaptureBuffer` — categorically out. v1 uses **`ipmitool -a`** (ipmitool prompts for the password itself on the remote tty, no echo, nothing stored): the jump-host template variant is ` ipmitool -I lanplus -H ${profile.ipmiHost} -U ${profile.ipmiUsername} -a sol activate\n`. A later refinement can type the stored password programmatically when the `Password:` prompt is observed (the `SessionPtyHandle.writeProgrammatic` + output-observer machinery the script runtime already has), but that is a deliberate scope cut for v1 — it needs the same care as script `expect` and shouldn't gate the feature.
3. Requires ipmitool installed on the bastion — a documentation fact, plus a decent error surface (the command's own `command not found` in the visible terminal is honest enough for v1).

**Ranking of alternatives** (for the issue write-up): (1) Paths A+B above — recommended; (2) persistent tunnel profiles per BMC — works today, tedious at fleet scale, remains the documented manual fallback; (3) Redfish-through-tunnel CLI tooling — real but a different feature (future); (4) SOCKS/dynamic for the browser — `vscode.env.openExternal` cannot set a browser proxy, rejected; (5) any UDP relay scheme — rejected per §4.1.

### 4.3 Phase 4 tests

- URL rewrite: resolved `https://[fe80::1]/` with gateway set → tunnel target `(fe80::1, 443)`, opened URL authority `127.0.0.1:<port>`, path/query preserved (fails against an implementation that rewrites non-authority occurrences of the host — the `?target=` lesson from `profileTokens.ts:519-533`).
- Port read-back: synthetic profile with `localPort: 0` → `ActiveTunnel.localPort` is the OS-assigned port (fails against the current pass-through).
- Gateway session routing: `localTerminal` macro + gateway set → text delivered to the gateway's session terminal, never a local terminal, and tokens resolved against the *target* server (fixture where target and gateway have different `ipmiHost` values — fails against resolving on the wrong server).
- Ephemeral tunnels use real TCP sockets in `test/integration/` per the existing TunnelManager convention (CLAUDE.md).

---

## Cut lines

- **No UDP tunneling of any kind** — not buildable over SSH; say so, don't fake it.
- **No generic `customFields` map / NetBox custom-field pass-through** — the whitelist stays curated (assessment §2.1 arguments unchanged); one-line extension later if a concrete need lands.
- **No sync-time clearing of `ipmiHost`** when `oob_ip` disappears (staleness accepted; matrix row 6).
- **No source-level IPMI auth-profile auto-assignment** in Phase 3 (deferred; open question 4 — and per the device-template design, the eventual mechanism is a template field, PR-T3, not a second source-level link).
- **No programmatic password typing on the jump host** in PR-C2 v1 (`-a` interactive prompt instead).
- **No per-server menu visibility** for any of this (the B5 anchored-regex constraint on `contextValue`, `src/ui/nexusTreeProvider.ts:65-68`, still stands; pickers flag, menus don't hide).
- **No `keyPath`/`authType` semantics on the IPMI link** — only `username` + stored password are read from the linked profile.

## Open questions for Ogun (revised — light confirmation, not a redesign; post on #48 before PR-C)

1. Is ipmitool installed on your bastions, and is a Nexus-opened SSH terminal on the jump host (auto-connected, command pre-filled) the shape you had in mind for "via a jump host"?
2. Is the IPMI gateway the **same bastion** as your SSH jump host, or a separate box? Per-server setting, or would a single global/default gateway serve better?
3. For jump-host SOL v1, the password is ipmitool's own interactive prompt on the bastion (`-a`) — acceptable, or do you keep `~/.ipmipass`-style config on the bastion anyway?
4. Since the credential is universal: should the **NetBox source** auto-assign the IPMI auth profile to every server it syncs (like the SSH auth profile does today), or is folder-level/manual assignment enough?
5. Do you also need the BMC **web console** reachable through the jump host? A browser can't run on the bastion, so that path would be a local TCP tunnel through it — optional PR-D, built only if you need it.
6. Does your `oob_ip` ever encode a non-standard port, or is it always a bare address (assumed)?

## NetBox-polish backlog (from Ogun's test report, issue #48 comment of 2026-08-09; owner has publicly committed to "another release which might address the rest")

Separate from the IPMI phases — these are inventory-import and form-UX items. Initial sizing (verify against code before committing):

1. **Saved import profiles** (S–M): the NetBox source currently re-prompts for filter parameters each sync setup; persist the filter query (e.g. `tag=…&site_id=…&status=active`) on the inventory-source record and offer saved definitions in a picker. Likely lives in the source config model + the add/edit source flow. Check what the source record already persists — this may be mostly UI.
2. **Bulk proxy-profile application to a folder tree** (M): apply a proxy config to a folder and all subfolders in one action. Touches tree commands + a bulk mutation over `ServerConfig.proxy`; needs care with sync-owned servers (hand-edit vs sync ownership semantics — same class of question as the `syncedIpmiHost` matrix).
3. **Primary-IP family preference** (S): imports currently take NetBox `primary_ip`, which yields IPv6 where both exist. Add a per-source option `auto | prefer-IPv4 | prefer-IPv6` mapping to `primary_ip4`/`primary_ip6`/`primary_ip` (all three are on the same device rows — no extra API calls). NOTE: decide whether the same preference should govern `oob_ip` selection in PR-A (NetBox `oob_ip` is a single field, so likely N/A — but document that).
4. **Jump-host dropdown search/sort** (S): the Proxy → Jump Host select in the server form is long and unordered. Minimum: sort by name. Better: type-to-filter (the webview form framework may need a filterable-select control — check `formDefinitions.ts`/`formHtml.ts` select rendering; if a filterable control is added, the new IPMI gateway and auth-profile selects from PR-B/PR-C should use it too).

Interplay to remember: #3's family preference and PR-A's `oob_ip` handling land in the same provider file; #4's filterable select is shared infrastructure for PR-B/PR-C pickers. Sequencing them adjacently avoids churn.

## Sequencing, sizing, risks

| PR | Content | Size | Gate |
|---|---|---|---|
| **PR-A** | Phase 2: provider + syncEngine + `syncedIpmiHost` stamp + tests | S | none — `oob_ip` confirmed |
| **PR-B** | Phase 3: `ipmiAuthProfileId` + `${profile.ipmiUsername}` + env injection + template flip + sweep + tests | M | none (independent of A; only textual overlap in `ServerConfig`) |
| **PR-C** | Phase 4 (primary, per owner's reading): `ipmiGatewayServerId` field + jump-host SOL routing (deliver localTerminal macros into a gateway session) + `-a` template variant + docs | S–M | Ogun's answers 1–3 (light confirmation) |
| **PR-D** | Optional: web console via ephemeral tunnel through the gateway (port-0 read-back, ephemeral tree row, browser authority rewrite) | M | Ogun's answer 5 — on demand only |
| **PR-E** | NetBox polish: saved import profiles (#1) + primary-IP family preference (#3) — same subsystem, one PR | S–M | none; owner publicly committed to a follow-up release |
| **PR-F** | Form/tree UX: sorted + filterable jump-host select (#4, shared control reused by PR-B/PR-C pickers). **ANNOTATION (device-template design):** backlog #2 (bulk proxy apply to folder tree) is DELETED from this PR — it is subsumed by the device-template design's manual "Apply Device Template to Folder" command, which also settles the ownership-semantics question (manual applies are unstamped hand edits). PR-F shrinks to the select control, pulled forward as PR-F1 in that design's sequencing | S | none |
| later | source-level IPMI profile assignment; idle-reaped tunnels; programmatic remote password; Redfish tooling | — | demand |

Each PR bumps the patch version per the release rules (CLAUDE.md), and per the workflow rules the implementation itself gets delegated to an Opus sub-agent when built.

**Risks**
1. **Stamp-semantics divergence** — `syncedIpmiHost` deliberately does *not* copy `host`/`port` ownership; the matrix in §2.3 is the spec, and the update-path comment block must say so or the next reader "fixes" it into device-always-wins. (This codebase's `syncedUsername` history is the cautionary tale — `config.ts:43-61`.)
2. **Env-var trust surface** — injecting the credential into a shell the user then owns is by design (auditability posture), but the gate ("only IPMI-token macros") must be tested, not just implemented, or every local macro run leaks the credential into its environment.
3. **Ephemeral-tunnel UI wiring** — `TunnelTreeProvider`/registry sync assume stored profiles; the `ephemeral` marker needs a deliberate render path or the tree shows orphaned rows. Flagged as the main unknown in PR-C1; investigate `tunnelRegistrySync.ts` interaction before committing to the synthetic-profile shape.
4. **Settings Sync skew** — `${profile.ipmiUsername}` on old builds degrades to a visible "sent as-is" note (good); a `-E` template on old builds fails with ipmitool's own error (acceptable, document); `ipmiGatewayServerId` on old builds is ignored and the macro runs locally — the one *silently different* behavior; the docs note should call it out.
5. **BMC TLS quirks through the tunnel** — cert CN mismatch on `127.0.0.1` is a browser warning users of self-signed BMC certs already see; some BMCs redirect to their absolute IP (breaks the tunnel illusion) — known limitation to document, not solvable client-side.
