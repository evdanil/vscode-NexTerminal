---
title: A run of carriage returns before a line feed is one line ending in session transcripts
author: NetSecTech
date: 2026-11-25
branch: fix/issue-338
cost: { minutes: 24, tokens: 83211 }
id: l-2ad17c9c
scope: repo
status: active
replaces: l-c6f3d672
src: agent
touches:
  - src/logging/transcriptTimestamps.ts
  - src/logging/transcriptLineEndings.ts
---

## Decided

Both transcript formatters treat a run of CRs plus an optional LF as one line ending, across any chunking. Plain CRLF never doubled; CR CR LF did, because timestamps run first and stamped between the CRs, so the LF conversion could not join them and its result depended on the timestamp setting. The run ends at a transport reset. LF mode holds at most 1024 undecided CRs and writes any excess as received: a transcript is a record, so keeping bytes beats collapsing an absurd run.

## Tried and ruled out

A regression since the option shipped: the logging code is identical in v2.8.317 and v2.8.323. An unbounded hold throws at 512 MiB of CRs, and saturating it drops received bytes. A pattern that requires the LF after a CR run, or anchors a trailing run at the end, backtracks quadratically (about 4 s at 64 KiB) on untrusted output. Collapsing LF CR or a leading CR: no evidence anyone needs it.

## Watch out

That the reporter of #338 has CR CR LF is inferred, not observed; check the raw output trace before telling them it is fixed. Terminals hide the extra CR while editors show an extra line, and Preserve still writes it as received.

In the code: src/logging/transcriptTimestamps.ts, src/logging/transcriptLineEndings.ts. The trace (nexus.logging.terminalOutputTrace) goes to globalStorage/sentriflow.vscode-nexterminal/logs/terminal-serial-<profileId>.log, not the folder Open Log Directory opens.
