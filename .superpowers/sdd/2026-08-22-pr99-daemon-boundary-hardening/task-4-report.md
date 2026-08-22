# Task 4 — daemon request validation and operation serialization

Implementation commit: `8e2ad7b8ddb777d7b41c453385e1fe9dee84c562` (`fix(network-servers): validate daemon operations`)

Base confirmed before work: `544615a715d7d77dc74d9d4402a6f31a436fe815`; the worktree was clean.

## Delivered boundary behaviour

- Daemon stdin now uses `attachBoundedLineReader` and parses each decoded JSON value only through Task 1's `parseRpcRequest`; raw `readline`, raw DTO types, and permissive field guards are removed.
- Invalid JSON and every syntactically parseable invalid request produce a closed `INVALID_REQUEST` response before a manager or config operation. A safe supplied request id is preserved; absent, unsafe, or malformed ids use reserved response id `0`. The host client starts generated ids at `1`.
- Output is normalized as JSON before Task 1 envelope/event/result parsers validate it, so optional `undefined` fields never become malformed strict wire DTOs.
- `ServiceWorkflowQueue` now provides `enqueueMany`, `read`, `readMany`, and `close`. Multi-service reservations atomically reserve canonical `tftp` then `dhcp` tails, recovery after rejection remains reusable, cleanup is tail-identity-safe, and post-close requests reject while accepted tails drain.
- Configure acquires the affected service keys atomically; list reads both service keys; status/runtime reads take their service key. Start/stop/restart/cancel/config workflows therefore serialize per service while independent services remain concurrent.
- `createNetworkServerDaemonShutdown` owns the synchronous latch and one shared shutdown promise. EOF, SIGINT, SIGTERM, and framing failure stop acceptance, drain accepted workflows, flush runtime updates, dispose once, and exit once.

## RED/GREEN evidence

RED observations before their corresponding production changes:

- `rtk npx vitest run test/unit/networkServers/networkServerWorkflowQueue.test.ts` — 6 tests, 1 expected failure: `queue.enqueueMany is not a function`.
- `rtk npx vitest run test/integration/networkServers/daemonOperationSerialization.test.ts test/unit/networkServers/networkServerWorkflowQueue.test.ts` — expected missing shutdown helper and queue close failures (1 failed test plus 1 failed suite).
- `rtk npx vitest run test/unit/networkServers/networkServerWorkflowQueue.test.ts --testNamePattern='coherent read'` — expected `queue.read is not a function`.
- Strict wire-result validation initially exposed 3 actual runtime-result failures in the real daemon bridge; root cause was optional in-memory `undefined` DTO fields that JSON serialization correctly omits. Validation now checks the normalized wire JSON.

GREEN commands:

- `rtk npm run compile`
- `rtk npx vitest run test/integration/networkServers/daemonBridge.test.ts test/integration/networkServers/daemonOperationSerialization.test.ts` — 16 passed.
- `rtk npx vitest run test/unit/networkServers/networkServerWorkflowQueue.test.ts test/unit/networkServers/networkServerConfigController.test.ts test/unit/networkServers/networkServerManager.test.ts test/unit/networkServers/networkServerConfigValidation.test.ts test/unit/networkServers/networkServerRpcProtocol.test.ts test/unit/networkServers/boundedLineReader.test.ts test/integration/networkServers/daemonRpcSchema.test.ts test/integration/networkServers/daemonHostLifecycle.test.ts` — 151 passed.
- Final combined verification: 10 files, 167 passed; compile passed.
- `rtk npm run build` — passed; `dist/services/networkServers/networkServerDaemon.js` exists and the no-`vscode` import smoke check passed.
- `rtk git diff --check` — passed.

## Mutation checks (all restored)

- Replaced `parseRpcRequest(payload)` with a permissive synthetic `list` request: the closed invalid-request bridge test failed immediately.
- Bypassed `ServiceWorkflowQueue.enqueue`: 5 ordering/drain/close tests failed.
- Dropped the second multi-key reservation: the atomic TFTP/DHCP interleaving test failed.
- Bypassed `ServiceWorkflowQueue.read`: the coherent read ordering test failed.
- Removed shutdown `stopAccepting`: the controlled EOF/SIGINT/SIGTERM latch test failed because late work resolved.
- Skipped shutdown `drain`: the same test failed because disposal/flush preceded the accepted operation completion.

## Files

- `src/services/networkServers/networkServerDaemon.ts`
- `src/services/networkServers/networkServerDaemonShutdown.ts`
- `src/services/networkServers/networkServerWorkflowQueue.ts`
- `test/integration/networkServers/daemonBridge.test.ts`
- `test/integration/networkServers/daemonOperationSerialization.test.ts`
- `test/unit/networkServers/networkServerWorkflowQueue.test.ts`

The implementation commit left the worktree clean. This report is committed separately so it can record that immutable implementation SHA without creating a self-referential commit hash. Concerns: none.
