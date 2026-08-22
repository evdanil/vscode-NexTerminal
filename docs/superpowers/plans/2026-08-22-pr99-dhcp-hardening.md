# PR #99 DHCP Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the pinned DHCP implementation bounded under pool exhaustion, contain malformed datagrams, validate every configuration ingress, and retain resource ownership after runtime errors.

**Architecture:** Keep exact runtime dependency `dhcp@0.2.20`, apply an auditable version-specific patch with `patch-package@8.0.1`, and expose packet rejection separately from socket failure. Move network-server configuration validation into a daemon-safe shared module used by settings, forms, env seed, and RPC.

**Tech Stack:** TypeScript, CommonJS dependency patching, Node child processes/UDP loopback, Vitest, `patch-package@8.0.1`.

**Spec:** `docs/superpowers/specs/2026-08-22-pr99-network-server-hardening-design.md`

## Global Constraints

- `dhcp` stays exactly pinned at `0.2.20`; patch application must fail closed.
- The patch preserves the dependency's MIT/GPL-2.0 license header and is committed as `patches/dhcp+0.2.20.patch`.
- A legacy allocator hang is executed only in a disposable child with deadline and unconditional cleanup.
- Packet rejection must not change a running adapter to `ERROR`; socket ownership errors remain fatal.
- Shared validation code must not import `vscode` and must be present in the daemon production bundle.
- Preserve contributor history and author tags; use `rtk` for every shell command segment.

---

## File map

- `package.json`, `package-lock.json`: postinstall patch tooling and exact graph.
- `patches/dhcp+0.2.20.patch`: reviewed dependency corrections.
- `src/services/networkServers/types/dhcp.d.ts`: patched event/state contracts.
- `src/services/networkServers/dhcp/engine/DhcpEngine.ts`: packet rejection and socket error policy.
- `src/services/networkServers/dhcp/DhcpAdapter.ts`: state/resource ownership.
- `src/services/networkServers/core/BaseNexusServer.ts`: disposal contract from `ERROR`.
- `src/services/networkServers/core/ServerManager.ts`: retain instances until disposal settles.
- `src/services/networkServers/networkServerConfigValidation.ts`: daemon-safe config parsers and field errors.
- `src/services/networkServers/networkServerManager.ts`: validated settings reads.
- `src/commands/networkServerSettings.ts`: form validation adapter.
- `src/services/networkServers/networkServerDaemon.ts`: validated env/RPC ingress.
- `test/fixtures/dhcpAllocatorProbe.js`: killable dependency behavior fixture.
- `test/integration/networkServers/dhcpDependencyHardening.test.ts`: allocator/dispatch containment.
- `test/integration/networkServers/dhcpRuntimeOwnership.test.ts`: adapter state and port ownership.
- `test/unit/networkServers/networkServerConfigValidation.test.ts`: pure schemas.
- Existing DHCP config/read/submit tests: integration with shared validation.

### Task 1: Install fail-closed dependency patching

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Create: `patches/dhcp+0.2.20.patch`

**Interfaces:**
- Produces: `postinstall = "patch-package --error-on-fail"`; installed `dhcp` always includes the reviewed patch.

- [ ] **Step 1: Add exact patch tooling**

Run:

```bash
rtk npm install --save-dev --save-exact patch-package@8.0.1
```

Add this script without replacing existing scripts:

```json
"postinstall": "patch-package --error-on-fail"
```

- [ ] **Step 2: Add an initially minimal marker patch and prove application**

Add a version-specific comment beside the `dhcp.js` license header explaining
that Nexus applies bounded allocator/dispatch corrections, then generate:

```bash
rtk npx patch-package dhcp
```

Expected: `patches/dhcp+0.2.20.patch` is created and contains only dependency
source paths.

- [ ] **Step 3: Verify a clean reinstall applies it and commit setup**

Use a temporary copy of the lockfile/package metadata or a fresh temporary
worktree; do not delete the shared worktree's dependency tree. Run `rtk npm ci`
there and assert the marker exists in `node_modules/dhcp/lib/dhcp.js`.

```bash
rtk git add package.json package-lock.json patches/dhcp+0.2.20.patch
rtk git commit -m "build(dhcp): apply pinned dependency patches"
```

### Task 2: Bound lease allocation and recover capacity

**Files:**
- Modify: `node_modules/dhcp/lib/dhcp.js` only as patch input
- Regenerate: `patches/dhcp+0.2.20.patch`
- Create: `test/fixtures/dhcpAllocatorProbe.js`
- Create: `test/integration/networkServers/dhcpDependencyHardening.test.ts`
- Modify: `src/services/networkServers/types/dhcp.d.ts`

**Interfaces:**
- Produces dependency events: `poolExhausted(req)`, `released(mac, address)`; allocator returns `string | null` in bounded time.

- [ ] **Step 1: Write the killable failing exhaustion test**

The fixture creates a server without calling `listen`, configures the inclusive
one-address range `192.0.2.10..192.0.2.10`, seeds that address as occupied, and
calls `_selectAddress` for a second MAC. It sends `{type:"result", value}` over
IPC if the call returns. The Vitest parent requires a result within 500 ms and
always sends SIGKILL/reaps in `finally`.

```ts
it("returns a controlled no-address result for an exhausted pool", async () => {
  const probe = fork(fixture, { stdio: ["ignore", "ignore", "pipe", "ipc"] });
  try {
    const reply = await messageWithin(probe, 500);
    expect(reply).toEqual({ type: "result", value: null });
  } finally {
    await killAndReap(probe);
  }
});
```

- [ ] **Step 2: Run red and record the timeout**

```bash
rtk npx vitest run test/integration/networkServers/dhcpDependencyHardening.test.ts -t "exhausted pool"
```

Expected: the parent deadline fires; cleanup reaps the child and Vitest exits.

- [ ] **Step 3: Patch bounded inclusive selection**

In dependency source:

- prune BOUND leases whose `bindTime + leasePeriod` is expired;
- prune OFFERED leases whose new numeric `offerTime` is older than 60 seconds;
- build a `Set` of occupied addresses;
- enumerate at most `lastIP - firstIP + 1` candidates, optionally from one
  random starting offset, wrapping once;
- return the first free formatted address or `null` after the bound.

In `handleDiscover`, create/retain the lease only after a non-null address is
selected. On `null`, remove a newly provisional state entry, emit
`poolExhausted`, and return without calling `sendOffer`. Set `offerTime` on a
successful OFFER.

Add a RELEASE dispatch branch that removes the matching MAC entry and emits
`released` with its former address. Do not release an address for a mismatched
client identifier.

- [ ] **Step 4: Regenerate the patch and add recovery tests**

```bash
rtk npx patch-package dhcp
```

Add cases for inclusive last address, expired BOUND reuse, expired OFFER reuse,
RELEASE reuse, static reservation preservation, and no invalid OFFER on null.

- [ ] **Step 5: Run, mutation-check, and commit**

```bash
rtk npx vitest run test/integration/networkServers/dhcpDependencyHardening.test.ts
```

Temporarily restore the unconditional loop in `node_modules`, confirm the
deadline case fails and reaps, reapply the patch, rerun, then commit:

```bash
rtk git add patches/dhcp+0.2.20.patch src/services/networkServers/types/dhcp.d.ts test/fixtures/dhcpAllocatorProbe.js test/integration/networkServers/dhcpDependencyHardening.test.ts
rtk git commit -m "fix(dhcp): bound lease allocation"
```

### Task 3: Contain packet failures separately from socket errors

**Files:**
- Modify patch input: `node_modules/dhcp/lib/dhcp.js`
- Regenerate: `patches/dhcp+0.2.20.patch`
- Modify: `src/services/networkServers/types/dhcp.d.ts`
- Modify: `src/services/networkServers/dhcp/engine/DhcpEngine.ts`
- Modify: `test/integration/networkServers/dhcpDependencyHardening.test.ts`

**Interfaces:**
- Produces dependency event: `packetError(error: Error, req?: unknown)`.
- Preserves dependency event: `error(error: Error)` for dgram socket ownership.

- [ ] **Step 1: Add failing malformed-input containment cases**

Using loopback and a non-privileged port, send a truncated datagram, a malformed
option length, an invalid/missing message type, and a valid request asking for
an unknown option. After each, assert `packetError` is observed, `error` is not,
the server still processes a later valid request, and close releases the port.

- [ ] **Step 2: Run red**

```bash
rtk npx vitest run test/integration/networkServers/dhcpDependencyHardening.test.ts -t "packetError|unknown option|remains responsive"
```

Expected: parse failures emit fatal `error`, and formatter/dispatch exceptions
can escape the existing parse-only catch.

- [ ] **Step 3: Patch the entire per-datagram boundary**

Wrap parse, shape gates, `message` emission, method dispatch, and response
format/send in one callback-level `try/catch`. Normalize non-Error throws with
`new Error(String(value))` and emit `packetError`. Keep the dgram socket's own
`error` listener unchanged. Unknown requested option strings are packet
rejections, never fatal server errors.

Regenerate `patches/dhcp+0.2.20.patch` and add `packetError`/`poolExhausted`/
`released` to the local declaration.

- [ ] **Step 4: Update engine policy**

Attach `packetError` and `poolExhausted` listeners that increment/drop/log at
warning level without `this.emit('error')`. Normalize unknown values in every
listener. Keep `error` fatal for runtime socket ownership failures.

- [ ] **Step 5: Run, mutation-check, and commit**

```bash
rtk npx vitest run test/integration/networkServers/dhcpDependencyHardening.test.ts test/unit/networkServers/dhcpConfig.test.ts
```

Temporarily route `packetError` through the fatal listener; the RUNNING/status
assertion must fail. Restore and commit all patch/engine/test files.

### Task 4: Add one authoritative network-server config parser

**Files:**
- Create: `src/services/networkServers/networkServerConfigValidation.ts`
- Create: `test/unit/networkServers/networkServerConfigValidation.test.ts`
- Modify: `src/services/networkServers/networkServerManager.ts`
- Modify: `src/commands/networkServerSettings.ts`
- Modify: `src/services/networkServers/networkServerDaemon.ts`
- Modify: existing DHCP read/submit tests.

**Interfaces:**
- Produces: `parseNetworkServerConfigs(value: unknown): ValidationResult<NetworkServerConfigs>`.
- Produces: `parseDhcpConfig(value: unknown): ValidationResult<DhcpAdapterConfig>`.
- Produces: `validateDhcpFormInput(input): string | undefined` using the same field validators.

- [ ] **Step 1: Define the result and pure helpers in tests**

```ts
export type ValidationResult<T> =
  | { ok: true; value: T; warnings: readonly string[] }
  | { ok: false; errors: readonly string[] };
```

Write table cases for all IPv4 scalars, DNS and option-150 arrays, bind address,
ordered range, contiguous mask, normalized MAC/static IPv4, integer port/lease,
string/array bounds, vendor TLV aggregate <=255 bytes, unknown keys, and omitted
defaults. Require field paths in every error.

- [ ] **Step 2: Run the new file red**

```bash
rtk npx vitest run test/unit/networkServers/networkServerConfigValidation.test.ts
```

Expected: module/functions do not exist.

- [ ] **Step 3: Implement the daemon-safe parser**

The module imports only network-server types and Node-safe pure helpers. Use
exact object/array/string/number checks, `Number.isSafeInteger`, dotted-quad
parsing, contiguous-mask bits, canonical lowercase colon-separated MACs, and
explicit constants for lengths. Return new copied objects; never cast input.

- [ ] **Step 4: Route every ingress through it**

- Settings reader: validate each raw field, retain valid siblings, use defaults
  for invalid settings, and report the collected warnings once.
- Form: return the first parser error without writing settings.
- Daemon env seed and `configure`/`start`/`restart`: reject invalid DTOs before
  `applyConfigs` or adapter creation.

- [ ] **Step 5: Run integration tests and mutation-check**

```bash
rtk npx vitest run test/unit/networkServers/networkServerConfigValidation.test.ts test/unit/networkServers/dhcpReadPathValidation.test.ts test/unit/networkServers/dhcpSubmitValidation.test.ts test/integration/networkServers/daemonBridge.test.ts
```

Temporarily bypass validation for DNS, static lease, and option 150 one at a
time; each corresponding regression must fail. Restore and commit:

```bash
rtk git add src/services/networkServers/networkServerConfigValidation.ts src/services/networkServers/networkServerManager.ts src/commands/networkServerSettings.ts src/services/networkServers/networkServerDaemon.ts test/unit/networkServers/networkServerConfigValidation.test.ts test/unit/networkServers/dhcpReadPathValidation.test.ts test/unit/networkServers/dhcpSubmitValidation.test.ts test/integration/networkServers/daemonBridge.test.ts
rtk git commit -m "fix(network-servers): validate daemon configuration"
```

### Task 5: Preserve adapter/manager ownership in ERROR and replacement races

**Files:**
- Modify: `src/services/networkServers/dhcp/DhcpAdapter.ts`
- Modify: `src/services/networkServers/core/BaseNexusServer.ts`
- Modify: `src/services/networkServers/core/ServerManager.ts`
- Create: `test/integration/networkServers/dhcpRuntimeOwnership.test.ts`

**Interfaces:**
- Produces: cleanup from all resource-owning states; an instance remains mapped until disposal settles.

- [ ] **Step 1: Add failing ownership tests**

Cover packet rejection staying RUNNING on the same port, a synthetic fatal
runtime error followed by stop/drop releasing the port, start from ERROR not
overwriting a live engine, and delayed disposal not overlapping replacement.

- [ ] **Step 2: Run red**

```bash
rtk npx vitest run test/integration/networkServers/dhcpRuntimeOwnership.test.ts
```

- [ ] **Step 3: Implement state-independent cleanup ownership**

`DhcpAdapter.start()` refuses/reaps any existing engine before replacement.
`stop()` detaches the engine only after taking a local owner and always attempts
its close. `BaseNexusServer.dispose()` invokes stop for `ERROR` when a subclass
can still own resources. `ServerManager.dropInstance()` awaits disposal before
deleting the map entry; on failure it retains the instance and propagates an
actionable error.

- [ ] **Step 4: Run, mutation-check, and commit**

```bash
rtk npx vitest run test/integration/networkServers/dhcpRuntimeOwnership.test.ts test/unit/networkServers/dhcpConfig.test.ts test/integration/networkServers/dhcpLeaseRestart.test.ts
```

Restore the old ERROR skip and delete-before-dispose separately; each ownership
test must fail. Restore and commit.

### Task 6: DHCP verification and review gate

- [ ] **Step 1: Prove clean-install patching**

Create a fresh temporary worktree at the task head, run `rtk npm ci`, verify
patch output and `rtk git status --short` clean, then remove only that exact
temporary worktree after recording its path.

- [ ] **Step 2: Run focused suite, compile, build, and audits**

```bash
rtk npm run compile
rtk npm run build
rtk npx vitest run test/integration/networkServers/dhcpDependencyHardening.test.ts test/integration/networkServers/dhcpRuntimeOwnership.test.ts test/integration/networkServers/dhcpLeaseRestart.test.ts test/unit/networkServers/dhcpBootOptions.test.ts test/unit/networkServers/dhcpConfig.test.ts test/unit/networkServers/dhcpLeasePersistence.test.ts test/unit/networkServers/dhcpReadPathValidation.test.ts test/unit/networkServers/dhcpSubmitValidation.test.ts test/unit/networkServers/networkServerConfigValidation.test.ts
rtk npm audit --omit=dev
rtk npm audit
```

- [ ] **Step 3: Independent spec and quality reviews**

Spec reviewer checks every dependency-patch/config/ownership requirement and
red/green evidence. Quality reviewer checks patch readability/license, bounded
loops, child cleanup, socket ownership, validation duplication, and scope.
Resolve findings before daemon/RPC work.
