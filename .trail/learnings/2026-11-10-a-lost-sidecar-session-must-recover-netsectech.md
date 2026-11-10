---
title: A lost sidecar session must recover without replaying a write
author: NetSecTech
date: 2026-11-10
branch: codex/serial-send-box
id: l-e44cd301
scope: repo
status: active
src: agent
touches:
  - AGENTS.md
  - src/services/serial/serialPty.ts
  - src/services/serial/smartSerialPty.ts
  - test/unit/serialPty.test.ts
  - test/unit/smartSerialPty.test.ts
---

## Decided
Guarded user writes must preserve the existing missing-session lifecycle transition: Standard disconnects, and Smart Follow enters waiting and resumes discovery. Rethrow the failed write without retrying it. Run the transition only while both the captured physical session ID and connection epoch still match.

## Tried and ruled out
Directly awaiting the guarded transport write looked sufficient because failures already reach the composer, but a crashed sidecar can restart without emitting a disconnect notification. Its replacement rejects the old session ID and leaves the PTY falsely connected forever unless the write path performs recovery. Matching only the session ID also fails if an ID is reused: a delayed rejection can tear down the replacement connection.

## Watch out
Do not convert every driver write error into a disconnect or resend an uncertain payload after recovery. Preserve rejection semantics and guard against disposed or replaced transports. The failure can affect manual macros too because they share guarded user dispatch.

In the code: src/services/serial/serialPty.ts and smartSerialPty.ts sendUserInput; their existing disconnect handlers; test/unit/serialPty.test.ts and smartSerialPty.test.ts. Regression proofs remove recovery and the epoch guard independently. A Linux pseudo-device with the actual native driver, sidecar and manager reproduces the old failure after killing the worker; the fixed Smart Follow reconnects and only transmits a newly requested payload.
