# PR #99 TFTP Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make optioned WRQ negotiation, retransmission windows, duplicate admission, and shutdown resource ownership correct and regression-tested.

**Architecture:** Keep `TransferSession` as the only protocol FSM, add one shared negotiated-window capacity, and make `TftpEngine` own pending peer identities and admission lifetimes explicitly. Tests drive the existing private entry point with gated promises so ownership races are deterministic.

**Tech Stack:** TypeScript, Node.js `fs/promises` and UDP, Vitest, RFC 2347/7440 state machines.

**Spec:** `docs/superpowers/specs/2026-08-22-pr99-network-server-hardening-design.md`

## Global Constraints

- Work on the maintainer branch; do not rewrite contributor commits or remove `@author kanekitakitos` tags.
- Every regression is observed failing on the current behavior before production code changes.
- Do not send external traffic; integration tests use loopback or direct private-entry calls.
- Keep `MAX_IN_FLIGHT_BYTES = 1 MiB`; advertise no window larger than retained retransmission capacity.
- Preserve compatibility with WRQ clients that send ACK(0), but standards-compliant DATA(1) must work without it.
- Run every shell command segment with `rtk`.

---

## File map

- `src/services/networkServers/tftp/engine/types.ts`: protocol and implementation limits.
- `src/services/networkServers/tftp/engine/protocol.ts`: option parsing and negotiated-value clamp.
- `src/services/networkServers/tftp/engine/TransferSession.ts`: WRQ/OACK FSM and retransmission queue.
- `src/services/networkServers/tftp/engine/TftpEngine.ts`: peer admission and stop ownership.
- `test/unit/networkServers/protocol.test.ts`: option-clamp boundaries.
- `test/unit/networkServers/transferSession.test.ts`: pure FSM and queue regressions.
- `test/integration/networkServers/tftpStress.test.ts`: standards-compliant optioned WRQ client.
- `test/integration/networkServers/tftpE2E.test.ts`: deterministic admission and shutdown races.

### Task 1: Correct WRQ OACK and retransmission queue behavior

**Files:**
- Modify: `src/services/networkServers/tftp/engine/TransferSession.ts`
- Modify: `test/unit/networkServers/transferSession.test.ts`
- Modify: `test/integration/networkServers/tftpStress.test.ts`

**Interfaces:**
- Consumes: `TransferSession.initForWRQ`, `handleDATA`, `handleACK`, `recordOutbound`.
- Produces: optioned WRQ accepts DATA(1) directly; acknowledged OACK is absent from retransmissions.

- [ ] **Step 1: Replace the nonstandard WRQ ACK(0) assertion with a failing DATA(1) regression**

Add a unit case with this behavior:

```ts
it("optioned WRQ accepts DATA(1) immediately after OACK", () => {
  const t = new TransferSession({
    peer: mkPeer(), opcode: Opcode.WRQ, filename: "w.bin",
    absFilePath: path.join(root, "w.bin"), mode: "octet",
    rawOptions: { blksize: "1400" }
  });
  const initial = t.initForWRQ(true);
  t.recordOutbound(initial);
  const result = t.handleDATA(1, Buffer.from("final"));
  expect(result.write?.equals(Buffer.from("final"))).toBe(true);
  expect(result.send[0]?.readUInt16BE(2)).toBe(1);
  expect(result.done).toBe(true);
  expect(t.phase).toBe(TransferPhase.Done);
  expect(t.consumeRetransmission()).toBeNull();
});
```

Retain a separate compatibility test showing `handleACK(0)` still moves an
optioned WRQ to `Receiving`, but rename it so the test no longer presents that
sequence as the RFC requirement.

- [ ] **Step 2: Add a failing RRQ OACK queue regression**

```ts
it("ACK(0) removes OACK before DATA retransmission tracking", () => {
  const t = makeOptionedRrqSession();
  const oack = t.initForRRQ(true, 1024);
  t.recordOutbound(oack);
  expect(t.handleACK(0).produceMore).toBe(true);
  t.recordOutbound([encodeDATA(1, Buffer.alloc(512))]);
  t.handleACK(1);
  expect(t.consumeRetransmission()).toBeNull();
});
```

- [ ] **Step 3: Run the two unit cases and record the intended failures**

Run:

```bash
rtk npx vitest run test/unit/networkServers/transferSession.test.ts -t "optioned WRQ accepts|ACK\(0\) removes"
```

Expected: WRQ returns `write: null`; queue assertions expose the retained OACK.

- [ ] **Step 4: Implement the minimal FSM and queue correction**

In `handleDATA`, before the generic phase rejection, accept block 1 as the
optioned-WRQ acknowledgment and process the same packet:

```ts
if (
  this.phase === TransferPhase.SendOACK &&
  this.opcode === Opcode.WRQ &&
  blockNum === 1
) {
  this.phase = TransferPhase.Receiving;
  this.clearOutboundUpToAck(0);
}
```

Change `clearOutboundUpToAck` so leading control entries (`blockNum === null`)
are removed by the first valid acknowledgment, including ACK(0), while numbered
entries are removed only for a nonzero cumulative ACK:

```ts
while (i < this.outboundQueue.length) {
  const packet = this.outboundQueue[i]!;
  if (packet.blockNum === null) { i++; continue; }
  if (ackBlockNum !== 0 && blockAtOrAfter(packet.blockNum, ackBlockNum)) { i++; continue; }
  break;
}
```

Update the stale WRQ comments to match RFC 2347.

- [ ] **Step 5: Make the stress client standards-compliant**

Change `doWRQ` so OACK triggers DATA(1), while ACK(0) from a no-option request
continues to trigger DATA(1). Use a helper that sends a block once and advances
`sent`, preventing duplicate DATA(1). Add an integration case that calls
`doWRQ(port, "optioned.bin", payload, { blksize: "128", windowsize: "4" })`
and verifies the on-disk payload byte-for-byte; the existing stress calls use
no options and cannot prove the corrected branch by themselves.

- [ ] **Step 6: Run focused tests**

Run:

```bash
rtk npx vitest run test/unit/networkServers/transferSession.test.ts test/integration/networkServers/tftpStress.test.ts
```

Expected: both files pass; the optioned stress case writes byte-identical data.

- [ ] **Step 7: Mutation-check and commit**

Temporarily restore the old `SendOACK` rejection and `ackBlockNum === 0` early
return one at a time; each named regression must fail. Restore the fix, rerun,
then commit:

```bash
rtk git add src/services/networkServers/tftp/engine/TransferSession.ts test/unit/networkServers/transferSession.test.ts test/integration/networkServers/tftpStress.test.ts
rtk git commit -m "fix(tftp): honor optioned WRQ handshake"
```

### Task 2: Align negotiated windows with retransmission capacity

**Files:**
- Modify: `src/services/networkServers/tftp/engine/types.ts`
- Modify: `src/services/networkServers/tftp/engine/protocol.ts`
- Modify: `src/services/networkServers/tftp/engine/TransferSession.ts`
- Modify: `test/unit/networkServers/protocol.test.ts`
- Modify: `test/unit/networkServers/transferSession.test.ts`

**Interfaces:**
- Produces: `MAX_RETRANSMISSION_PACKETS = 256`; `validateOptions` never returns a larger `windowsize`.
- Consumes: Task 1 queue behavior.

- [ ] **Step 1: Add failing validation boundaries**

```ts
it("clamps a tiny-block window to retransmission capacity", () => {
  const v = validateOptions({ blksize: "8", windowsize: "65535" });
  expect(v.windowsize).toBe(MAX_RETRANSMISSION_PACKETS);
});

it("does not clamp the retransmission boundary itself", () => {
  expect(validateOptions({ blksize: "8", windowsize: "256" }).windowsize).toBe(256);
  expect(validateOptions({ blksize: "8", windowsize: "257" }).windowsize).toBe(256);
});
```

- [ ] **Step 2: Run the boundary cases red**

Run:

```bash
rtk npx vitest run test/unit/networkServers/protocol.test.ts -t "retransmission capacity|retransmission boundary"
```

Expected: current validation returns 65,535 and 257.

- [ ] **Step 3: Export and apply one capacity constant**

Add to `types.ts`:

```ts
export const MAX_RETRANSMISSION_PACKETS = 256;
```

In `validateOptions`, calculate:

```ts
const maxWindow = Math.max(
  1,
  Math.min(MAX_RETRANSMISSION_PACKETS, Math.floor(MAX_IN_FLIGHT_BYTES / out.blksize)),
);
```

Replace the literal queue cap in `recordOutbound` with the same constant.
Document that 256 is below the 32,768 ambiguous half-range.

- [ ] **Step 4: Add a queue-retention invariant test**

Construct a session negotiated with 257 and record one full returned window.
Assert `opts.windowsize === 256`, exactly 256 packets are produced, and
retransmission returns all 256 block numbers starting at 1.

- [ ] **Step 5: Run, mutation-check, and commit**

Run:

```bash
rtk npx vitest run test/unit/networkServers/protocol.test.ts test/unit/networkServers/transferSession.test.ts
```

Temporarily remove `MAX_RETRANSMISSION_PACKETS` from the clamp; the boundary
test must fail. Restore, rerun, then commit:

```bash
rtk git add src/services/networkServers/tftp/engine/types.ts src/services/networkServers/tftp/engine/protocol.ts src/services/networkServers/tftp/engine/TransferSession.ts test/unit/networkServers/protocol.test.ts test/unit/networkServers/transferSession.test.ts
rtk git commit -m "fix(tftp): bound negotiated retransmission windows"
```

### Task 3: Serialize peer admission and make stop own in-flight work

**Files:**
- Modify: `src/services/networkServers/tftp/engine/TftpEngine.ts`
- Modify: `test/integration/networkServers/tftpE2E.test.ts`

**Interfaces:**
- Produces: unique pending peer keys, active-generation checks, and stop that settles admissions before final cleanup.

- [ ] **Step 1: Add a failing same-peer RRQ regression**

Use the existing `MessageEntryPoint` cast. Spy/gate `PathGuard.statFile` so two
same-`rinfo` calls overlap before either registers. Assert one `transfer:start`,
one admission owner, and every opened `FileHandle.close` is called after stop.

- [ ] **Step 2: Add failing same-peer WRQ and stop-during-admission regressions**

Gate `ensureWritableNew`/`fsPromises.open`. For duplicate WRQ, assert the losing
request cannot delete the successful session or close its handle. For stop,
begin admission, call `stop()`, release the gate, await both promises, and assert
zero active sessions/handles and no post-stop `transfer:start`.

- [ ] **Step 3: Run the three cases red**

Run:

```bash
rtk npx vitest run test/integration/networkServers/tftpE2E.test.ts -t "same-peer|stop during admission"
```

Expected: current code emits duplicate starts, loses an owner, or registers
after stop.

- [ ] **Step 4: Implement explicit ownership**

Add these fields:

```ts
private readonly pendingAdmissionKeys = new Set<string>();
private readonly admissionTasks = new Set<Promise<void>>();
private lifecycleGeneration = 0;
private acceptingRequests = false;
```

`start()` advances the generation and enables requests only after the guard is
valid. `handleNewRequest` synchronously rejects/ignores an already-pending key,
checks capacity with `pendingAdmissionKeys.size`, inserts the key, registers the
admission promise, and removes both in `finally`. Pass the captured generation
to `admitNewRequest`; before every map/handle registration verify it still
matches and requests are accepted. Close a just-opened WRQ handle on mismatch.

`stop()` disables requests and advances the generation before closing the
socket, awaits a snapshot of `admissionTasks`, then closes/clears all session and
write resources. Keep it idempotent.

- [ ] **Step 5: Run admission tests and full focused TFTP suite**

Run:

```bash
rtk npx vitest run test/integration/networkServers/tftpE2E.test.ts
rtk npx vitest run test/unit/networkServers/pathGuard.test.ts test/unit/networkServers/protocol.test.ts test/unit/networkServers/transferSession.test.ts test/integration/networkServers/adapterStartFailure.test.ts test/integration/networkServers/tftpE2E.test.ts test/integration/networkServers/tftpStress.test.ts
```

- [ ] **Step 6: Mutation-check and commit**

Temporarily bypass the pending-key check, then the generation check. The
same-peer and stop regressions must fail independently. Restore and commit:

```bash
rtk git add src/services/networkServers/tftp/engine/TftpEngine.ts test/integration/networkServers/tftpE2E.test.ts
rtk git commit -m "fix(tftp): own pending peer admissions"
```

### Task 4: TFTP verification and review gate

**Files:**
- Inspect: all Task 1-3 files
- Report: `.superpowers/sdd/2026-08-22-pr99-hardening/tftp-verification.md`

- [ ] **Step 1: Run compile and focused suite**

```bash
rtk npm run compile
rtk npx vitest run test/unit/networkServers/pathGuard.test.ts test/unit/networkServers/protocol.test.ts test/unit/networkServers/transferSession.test.ts test/integration/networkServers/adapterStartFailure.test.ts test/integration/networkServers/tftpE2E.test.ts test/integration/networkServers/tftpStress.test.ts
```

- [ ] **Step 2: Run independent spec-compliance review**

Reviewer checks RFC 2347 sequence, all queue/cap invariants, same-key ownership,
stop ordering, mutation evidence, scope, and author-tag preservation.

- [ ] **Step 3: Run independent code-quality review**

Reviewer checks async rejection handling, idempotence, leaked handles/timers,
test determinism, and absence of unrelated refactors. Resolve findings before
the DHCP plan begins.
