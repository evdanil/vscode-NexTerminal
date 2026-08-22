# PR #99 Network-Server Hardening Design

## Status

Approved in chat on 2026-08-22. This design follows the exact-head audit of
PR #99 at `2c0b2ed435daadb416a71217cb8655dc9c4656e5` and defines the maintainer
integration work required before merge.

## Objective

Make the embedded TFTP and DHCP services safe to integrate without rewriting
the feature or losing the contributor's history. The implementation must fix
the verified protocol, ownership, dependency, and child-process boundary
defects; add red-first regression evidence; preserve contributor commits and
`@author kanekitakitos` tags; and finish by integrating current `main`, bumping
the unreleased version to `2.8.202`, and documenting the feature.

## Non-goals

- Replacing TFTP or DHCP with a new product-level subsystem.
- Adding authentication to protocols that do not define it.
- Broadly refactoring the network-server UI or profile model.
- Claiming Windows/macOS behavior that is not exercised on those platforms.
- Publishing `2.8.202`; merge readiness and release authorization remain
  separate decisions.

## Evidence baseline

- Exact-head compile and build pass.
- Full suite: 229 files passed, 6,578 tests passed, 2 skipped, 0 failed.
- Focused TFTP suite: 6 files passed, 107 tests passed, 2 skipped.
- Focused daemon/DHCP suite: 8 files passed, 111 tests passed.
- Those green suites do not cover the defects below. Every new regression must
  first fail against the current implementation for the intended reason, then
  pass after the minimal fix. Where practical, restoring the wrong behavior
  after the fix must make the test fail again.

## Design decisions

### 1. Correct the TFTP state machine and retransmission invariants

The existing `TransferSession` remains the protocol state owner. No second FSM
will be introduced.

- An optioned WRQ remains in an OACK-waiting phase, but receipt of the
  standards-required DATA(1) transitions it directly to `Receiving` and
  processes that same payload. ACK(0) may remain tolerated for compatibility,
  but is not required and tests must no longer teach clients to send it.
- Acknowledging option negotiation removes the OACK control packet from the
  retransmission queue. For RRQ that acknowledgment is ACK(0); for WRQ it is
  the accepted DATA(1). Later retransmissions contain only packets that remain
  outstanding.
- One exported implementation limit will define retransmission capacity. The
  negotiated window is clamped to the minimum of the RFC limit, the one-MiB
  byte budget, the 16-bit half-range safety bound, and the retained-packet
  capacity. With the current queue this means no advertised window exceeds
  256 packets. The OACK reports the clamped value.
- New regression tests cover optioned WRQ DATA(1), OACK removal, boundaries at
  256/257, and retention of every packet in a negotiated window.

### 2. Give every pending TFTP admission a unique owner

Global `pendingAdmissions` is insufficient because it reserves capacity but
not the `${address}:${port}` identity used by every resource map.

- Replace or supplement the scalar with a pending-key set. The key is inserted
  synchronously before the first filesystem await and removed in `finally`.
- A duplicate request for a pending key is treated as a retransmission of the
  original request and does not create a second session. It may be ignored
  while the first admission completes; it must not overwrite or clean up the
  first owner's resources.
- Capacity is calculated from active sessions plus unique pending keys.
- `stop()` must prevent post-stop registration. In-flight admissions are
  tracked and settled before final resource cleanup, or detect the stopped
  generation before registering and close any resource they acquired.
- Deterministic tests gate filesystem promises to overlap two same-key
  requests, cover RRQ and WRQ ownership, and stop during admission. Assertions
  count opened and closed handles, emitted starts, active sessions, and map
  ownership rather than relying only on map size.

### 3. Keep the pinned DHCP package, but own its shipped corrections

For this PR, replacing the whole DHCP implementation would add more risk than
the bounded hardening it is meant to achieve. Runtime monkey-patching private
methods would be difficult to audit and fragile. The selected approach is a
checked-in `patch-package` patch against exact dependency `dhcp@0.2.20`.

The patch is part of the reviewed source and is applied automatically after a
clean dependency installation. CI must prove the patch applies; the package
remains exactly pinned so drift fails installation instead of silently losing
the correction.

The dependency patch must:

- replace the unconditional random-address loop with a bounded selection over
  the inclusive pool;
- detect an exhausted pool and return a controlled no-address outcome without
  formatting or sending an invalid OFFER;
- expire reclaimable leases using the fields the package actually stores and
  give provisional OFFER state a bounded lifetime;
- handle RELEASE so ordinary client lifecycle can return capacity;
- wrap the whole parse/dispatch/format path so one datagram cannot escape as an
  uncaught exception or event-loop hang;
- distinguish rejected packet/protocol input from socket ownership errors.

`DhcpEngine` logs and counts packet rejections without changing adapter status.
Actual socket errors remain fatal and flow through owned shutdown. Pool
exhaustion is observable but leaves the daemon responsive.

Tests run dangerous-to-hang legacy behavior only in disposable child
processes. A one-address pool proves that a second request does not wedge the
heartbeat/RPC path, and the harness always reaps the child in `finally`.

### 4. Centralize DHCP configuration validation

Add a daemon-safe validation module under `src/services/networkServers` that
does not import `vscode`. It validates and normalizes both TFTP and DHCP
configuration DTOs at every process boundary.

DHCP validation includes:

- every IPv4 scalar and IPv4 array, including DNS, bind/interface, next-server,
  and option 150 addresses;
- contiguous masks and ordered pool endpoints;
- valid normalized MAC keys and IPv4 values for static leases;
- integer ports/lease durations and bounded array/string/option sizes;
- vendor-option byte limits before the dependency formatter is invoked;
- exact known keys and safe defaults for omitted optional fields.

The form submit path and VS Code settings reader reuse the same pure validators
instead of maintaining weaker parallel rules. Invalid interactive input is
rejected with a field-specific message; malformed hand-edited settings degrade
to documented defaults with one diagnostic; malformed RPC/env-seed config is
rejected before resource creation.

### 5. Make JSON-line RPC a validated shared protocol

Introduce a shared, daemon-safe protocol module containing the closed request,
response, error, and notification variants plus runtime parsers.

- Request IDs are finite non-negative safe integers. Methods are from the
  closed method set and have method-specific parameters.
- Responses contain exactly one of `result` or `error`. The host stores the
  expected result validator with each pending request and validates before
  resolving it.
- Notifications use a closed event set and event-specific data schemas.
  Malformed `ready` cannot open the readiness gate.
- Unknown late response IDs are ignored and logged. A malformed message from
  the current child is a protocol failure: reject pending work, terminate that
  child, and leave the extension host alive.
- JSON-line framing has a fixed maximum line size on stdin and stdout. Invalid
  JSON or oversized input is rejected without unbounded accumulation.
- No shared protocol/config module imports `vscode`, so the daemon bundle stays
  standalone.

Tests use fake-child fixtures for malformed ready/events/results, wrong result
types, result-plus-error, invalid IDs, oversized lines, EOF, and pending-request
teardown. Each case asserts that user callbacks are not invoked with unchecked
data and the host remains responsive.

### 6. Give process escalation per-child ownership

The host-global SIGKILL timer becomes child-owned state.

- Each terminating child has its own escalation closure/timer, cleared only
  when that child exits.
- Starting or terminating a later generation cannot cancel an earlier
  generation's escalation.
- Teardown keeps the minimum exit/close observation needed to prove reaping;
  it does not indiscriminately remove every listener before ownership ends.
- Disposal is idempotent and rejects all pending/ready promises exactly once.

A Linux fixture that ignores SIGTERM proves two overlapping generations are
both reaped and records which one required SIGKILL. Cross-platform tests assert
only eventual exit/resource release unless run on the relevant platform.

### 7. Preserve resource ownership after runtime errors

An adapter may enter `ERROR` only while retaining an explicitly stoppable
engine or after cleanup has completed.

- Packet rejection never moves DHCP out of `RUNNING`.
- Starting from `ERROR` cannot overwrite a live engine.
- `stop()` and `dispose()` attempt cleanup from every state that may own a
  resource, including `ERROR`.
- Instance eviction occurs only after disposal completes; errors are surfaced
  while the manager retains enough ownership to retry cleanup.
- Start/stop/restart operations for one service are serialized so configuration
  refresh and shutdown cannot interleave resource transitions.

Tests prove malformed input does not change the bound port, ERROR-to-stop/drop
releases it, and delayed close cannot overlap a replacement start.

## Implementation sequence

1. TFTP WRQ/OACK and retransmission invariants.
2. TFTP per-peer admission and stop ownership.
3. DHCP dependency patch and exhaustion/packet-containment tests.
4. Shared configuration validation.
5. Shared RPC schemas and bounded framing.
6. Per-child escalation and adapter/manager lifecycle serialization.
7. Focused suites, full suite, compile, build, dependency audit, clean-install
   patch verification, and mutation checks.
8. Merge current `origin/main` into the maintainer branch, resolve semantic
   overlaps, rerun all verification, bump package/lockfile to `2.8.202`, and
   add the CHANGELOG entry.

Tasks that touch the same FSM, protocol, or lifecycle files run sequentially.
Independent reviewers perform spec-compliance and code-quality review after
each implementation task. No remote PR mutation or push occurs until the local
branch is verified and explicitly authorized.

## Alternatives rejected

### Replace DHCP immediately

Potentially cleaner long term, but it would add a second unreviewed server
implementation to an already large PR and broaden interoperability risk. Keep
replacement as a separately scoped follow-up after the bounded safety patch.

### Runtime monkey-patch `dhcp` private methods

Smallest line count, but ownership is hidden, TypeScript declarations become
fiction, and dependency internals can change without an installation failure.
The checked-in version-specific patch is more visible and fail-closed.

### Document dependency risk and merge unchanged

Rejected because the allocator's unconditional loop and incomplete dispatch
are reachable in the exact shipped code. Documentation cannot bound the event
loop or restore resource ownership.

## Completion criteria

- Every verified defect has a regression that was observed red against the
  named old behavior and green after the fix.
- TFTP and daemon/DHCP focused suites pass.
- Full compile, build, and unrestricted test suite pass with exact totals
  recorded.
- A clean dependency install applies the DHCP patch and leaves tracked files
  unchanged.
- Production dependency audit reports no known runtime vulnerabilities; any
  development-only advisory is separately documented.
- The integrated current-main tree passes the same verification.
- Git history retains the contributor's commits and attribution, with
  maintainer hardening commits on top.
- PR prose is refreshed from the final evidence and does not imply release
  authorization.
