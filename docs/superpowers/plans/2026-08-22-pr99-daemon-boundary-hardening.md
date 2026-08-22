# PR #99 Daemon Boundary Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the network-server child protocol runtime-safe, line-bounded, generation-correct, and guaranteed to reap every child and serialize service lifecycle operations.

**Architecture:** Define the JSON-line contract once in a daemon-safe module with method/event-specific parsers, attach a bounded byte-oriented line reader on both sides, and store a result validator with every pending host request. Move termination timers to per-child ownership and serialize daemon service mutations through per-service promise chains plus one shutdown latch.

**Tech Stack:** TypeScript, Node.js child processes/streams, discriminated JSON messages, Vitest fixtures.

**Spec:** `docs/superpowers/specs/2026-08-22-pr99-network-server-hardening-design.md`

## Global Constraints

- No protocol/config module may import `vscode`.
- Maximum JSON-line size is exactly `1_048_576` bytes, including buffered content before `\n`.
- Malformed current-child output never reaches listeners or marks ready; it terminates that child and rejects pending work.
- Late responses with a well-formed unknown ID are logged/ignored, not treated as corruption.
- Every child owns its own SIGKILL escalation; Linux proves SIGKILL, other platforms prove eventual exit only.
- Service mutations serialize per service; shutdown is idempotent and refuses new mutations.
- Preserve contributor commits and tags; prefix all shell command segments with `rtk`.

---

## File map

- `src/services/networkServers/networkServerRpcProtocol.ts`: closed wire variants and runtime parsers.
- `src/services/networkServers/boundedLineReader.ts`: byte-bounded newline framing.
- `src/services/networkServers/daemonHost.ts`: typed pending requests, child-generation validation, per-child termination.
- `src/services/networkServers/networkServerDaemon.ts`: validated requests, bounded stdin, serialized dispatch/shutdown.
- `test/unit/networkServers/networkServerRpcProtocol.test.ts`: pure contract tests.
- `test/unit/networkServers/boundedLineReader.test.ts`: framing boundaries/chunks.
- `test/fixtures/mockNetworkServerDaemonMalformed.js`: controlled malformed child output.
- `test/fixtures/mockNetworkServerDaemonIgnoresSigterm.js`: escalation fixture.
- `test/integration/networkServers/daemonRpcSchema.test.ts`: host/child boundary behavior.
- `test/integration/networkServers/daemonHostEscalation.test.ts`: overlapping generations.
- `test/integration/networkServers/daemonOperationSerialization.test.ts`: service mutation/shutdown ordering.

### Task 1: Define and test the closed RPC contract

**Files:**
- Create: `src/services/networkServers/networkServerRpcProtocol.ts`
- Create: `test/unit/networkServers/networkServerRpcProtocol.test.ts`

**Interfaces:**
- Produces: `RpcMethod`, `RpcParams<M>`, `RpcResult<M>`, `RpcRequest<M>`.
- Produces: `parseRpcRequest`, `parseRpcEnvelope`, `parseRpcEvent`, `rpcResultParsers`.
- Consumes: config parser from the DHCP plan for configure/start/restart payloads.

- [ ] **Step 1: Write failing envelope and method tables**

Tests cover each exact method (`list`, `getStatus`, `configure`, `start`, `stop`,
`restart`, `cancelTransfer`, `getServiceRuntime`), safe-integer IDs, required and
forbidden params, service IDs `tftp|dhcp`, bounded transfer IDs, exclusive
result/error, error code/message, and all five closed events.

```ts
expect(parseRpcRequest({ id: 1, method: "stop", params: { id: "tftp" } })).toMatchObject({ ok: true });
expect(parseRpcRequest({ id: NaN, method: "stop", params: { id: "tftp" } })).toMatchObject({ ok: false });
expect(parseRpcEnvelope({ id: 1, result: null, error: null })).toMatchObject({ ok: false });
expect(parseRpcEvent({ event: "ready", data: {} })).toMatchObject({ ok: false });
```

- [ ] **Step 2: Run red**

```bash
rtk npx vitest run test/unit/networkServers/networkServerRpcProtocol.test.ts
```

- [ ] **Step 3: Implement discriminated parsers**

Use a local result type `{ok:true,value:T}|{ok:false,error:string}`. Reject
arrays/null, prototype-inherited fields, unknown keys, unsafe IDs, unknown
methods/events/status strings, unbounded strings/arrays, and wrong nested DTOs.
Define one result parser per method; runtime snapshots validate their service
discriminator/shape rather than relying on property presence alone.

- [ ] **Step 4: Run, mutation-check, and commit**

```bash
rtk npx vitest run test/unit/networkServers/networkServerRpcProtocol.test.ts
```

Replace the strict envelope parser with the prior `id + result-property` guard;
the result-plus-error case must fail. Restore and commit:

```bash
rtk git add src/services/networkServers/networkServerRpcProtocol.ts test/unit/networkServers/networkServerRpcProtocol.test.ts
rtk git commit -m "feat(network-servers): define runtime RPC contract"
```

### Task 2: Bound JSON-line framing

**Files:**
- Create: `src/services/networkServers/boundedLineReader.ts`
- Create: `test/unit/networkServers/boundedLineReader.test.ts`

**Interfaces:**
- Produces: `MAX_RPC_LINE_BYTES = 1_048_576`.
- Produces: `attachBoundedLineReader(stream, {onLine,onError,maxBytes?}): () => void`.

- [ ] **Step 1: Add failing chunk/framing tests**

Cover one/multiple lines per chunk, a line split across UTF-8 chunks, CRLF,
empty lines, exactly max bytes, max+1 before newline, repeated oversized data
without buffer growth, EOF with/without final line, and disposal removing
listeners.

- [ ] **Step 2: Run red**

```bash
rtk npx vitest run test/unit/networkServers/boundedLineReader.test.ts
```

- [ ] **Step 3: Implement byte-oriented framing**

Accumulate `Buffer` chunks, search byte `0x0a`, reject and clear when buffered
bytes exceed the limit, strip one trailing `0x0d`, decode complete lines as
UTF-8, and return a disposer. Once an oversize error fires, detach from the
stream so later bytes cannot rebuild the buffer.

- [ ] **Step 4: Run, mutation-check, and commit**

Mutate the comparison from `>` to `>=`; the exact-boundary case must fail.
Restore and commit both files.

### Task 3: Validate every host-side response and notification

**Files:**
- Modify: `src/services/networkServers/daemonHost.ts`
- Create: `test/fixtures/mockNetworkServerDaemonMalformed.js`
- Create: `test/integration/networkServers/daemonRpcSchema.test.ts`

**Interfaces:**
- Consumes: Task 1 parsers and Task 2 line reader.
- Produces: `PendingRequest` stores its method/result parser; protocol failure terminates only the producing child generation.

- [ ] **Step 1: Add malformed-child scenarios**

The fixture selects behavior from an env value and emits: invalid JSON,
oversized line, malformed ready, null status event, invalid connection, unknown
event, result+error, wrong result for the pending method, duplicate/unknown IDs,
stdout EOF while alive, and valid messages after each invalid line.

Tests assert malformed ready never sets `isReady`, listeners are never invoked
with invalid data, pending calls reject with `Daemon protocol error`, the child
is reaped, and a later `ensureStarted` uses a clean generation. A well-formed
late unknown ID is only logged.

- [ ] **Step 2: Run red**

```bash
rtk npx vitest run test/integration/networkServers/daemonRpcSchema.test.ts
```

- [ ] **Step 3: Route host input through strict parsers**

Replace stdout `readline` with `attachBoundedLineReader`. Change `request` to a
generic method-contract function and store `method` plus its result parser in
`PendingRequest`. Parse envelopes before looking up IDs, validate a success
result against the pending method, and call `failChildProtocol(child, reason)`
for malformed output. Guard every callback with the child instance/generation
that produced it. Validate notifications before invoking listeners.

Attach stdin write callbacks/errors to reject the matching pending request;
honor backpressure without losing the timeout.

- [ ] **Step 4: Run focused host tests and mutation-check**

```bash
rtk npx vitest run test/integration/networkServers/daemonRpcSchema.test.ts test/integration/networkServers/daemonHostLifecycle.test.ts test/unit/networkServers/networkServerManager.test.ts
```

Restore the prior permissive event guard; malformed-ready test must fail.
Restore, then commit host, fixture, and tests.

### Task 4: Validate daemon requests and serialize operations

**Files:**
- Modify: `src/services/networkServers/networkServerDaemon.ts`
- Create: `test/integration/networkServers/daemonOperationSerialization.test.ts`
- Modify: `test/integration/networkServers/daemonBridge.test.ts`

**Interfaces:**
- Consumes: Task 1 request parser, Task 2 line reader, shared config parser.
- Produces: one mutation queue per service and one idempotent shutdown promise.

- [ ] **Step 1: Add invalid request and ordering regressions**

Send invalid IDs/methods/params/configs and assert structured `INVALID_REQUEST`
without manager calls. Gate a service stop, issue start/restart concurrently,
and assert acquisition order is stop then replacement start. Trigger stdin EOF
and SIGTERM together; assert `disposeAll` and exit response occur once and no
new request is accepted after shutdown begins.

- [ ] **Step 2: Run red**

```bash
rtk npx vitest run test/integration/networkServers/daemonBridge.test.ts test/integration/networkServers/daemonOperationSerialization.test.ts
```

- [ ] **Step 3: Implement validated bounded dispatch**

Use `attachBoundedLineReader(process.stdin, ...)`, `parseRpcRequest`, and the
method-specific typed dispatch. Add:

```ts
const serviceQueues = new Map<NetworkServerKind, Promise<void>>();
let shutdownPromise: Promise<void> | undefined;
let shuttingDown = false;
```

`enqueueServiceOperation(id, operation)` chains after the prior promise even if
it rejected, removes only its own tail, and rejects when `shuttingDown`.
Serialize start/stop/restart/cancel/config operations that mutate the same
service; read-only status/runtime waits behind the current mutation for a
coherent snapshot. `configure` acquires both service queues in fixed
`tftp`-then-`dhcp` order because one request can update both configs; `list`
waits for both tails in that same order. `shutdown()` sets the latch first and
returns the same promise to EOF/SIGINT/SIGTERM callers.

- [ ] **Step 4: Run, mutation-check, and commit**

Bypass the queue and shutdown latch separately; ordering and once-only tests
must fail. Restore and commit daemon/tests.

### Task 5: Give SIGKILL escalation per-child ownership

**Files:**
- Modify: `src/services/networkServers/daemonHost.ts`
- Create: `test/fixtures/mockNetworkServerDaemonIgnoresSigterm.js`
- Create: `test/integration/networkServers/daemonHostEscalation.test.ts`

**Interfaces:**
- Produces: `killTimers: Map<ChildProcess, Timeout>` or equivalent closure-owned timers cleared by that child's exit only.

- [ ] **Step 1: Add the two-generation failing test**

First fixture reports PID and ignores SIGTERM but never becomes ready. After its
ready timeout, immediately start a second ready fixture and dispose it before
the first child's two-second escalation. Assert both PIDs disappear; on Linux,
record that the first required SIGKILL. Emergency cleanup in `finally` reaps any
remaining PID.

- [ ] **Step 2: Run red**

```bash
rtk npx vitest run test/integration/networkServers/daemonHostEscalation.test.ts
```

Expected: terminating child B clears child A's global timer and A remains alive
until emergency cleanup.

- [ ] **Step 3: Implement child-owned escalation**

Replace `killTimer` with a per-child map or closure. Install a one-shot exit
observer that clears only that child's timer. Do not `removeAllListeners()`;
detach bridge-specific listeners while retaining reaping observation. Current
child/readline state changes remain guarded by identity.

- [ ] **Step 4: Run, mutation-check, and commit**

```bash
rtk npx vitest run test/integration/networkServers/daemonHostEscalation.test.ts test/integration/networkServers/daemonHostLifecycle.test.ts
```

Restore a single timer field; the two-generation test must fail. Restore and
commit host/fixture/test.

### Task 6: Daemon verification and review gate

- [ ] **Step 1: Run focused suites, compile, and daemon bundle smoke**

```bash
rtk npm run compile
rtk npm run build
rtk npx vitest run test/unit/networkServers/networkServerRpcProtocol.test.ts test/unit/networkServers/boundedLineReader.test.ts test/integration/networkServers/daemonRpcSchema.test.ts test/integration/networkServers/daemonOperationSerialization.test.ts test/integration/networkServers/daemonHostEscalation.test.ts test/integration/networkServers/daemonHostLifecycle.test.ts test/integration/networkServers/daemonBridge.test.ts
rtk rg -n "vscode" dist/services/networkServers/networkServerDaemon.js
```

Expected: tests/build pass; final `rg` exits 1 with no unresolved `vscode`
literal/import in the daemon bundle.

- [ ] **Step 2: Independent spec-compliance review**

Review every request/result/event shape, line limit, child-generation failure,
per-child timer, service ordering, shutdown latch, and red/green evidence.

- [ ] **Step 3: Independent code-quality review**

Review parser duplication/complexity, stream cleanup/backpressure, timer/PID
ownership, listener exceptions, platform claims, and fixture emergency cleanup.
Resolve all findings before final integration.
