---
title: "Doubled transcript lines come from an extra carriage return, not from plain CRLF"
author: NetSecTech
date: 2026-11-25
branch: feat/quick-connect
cost: { minutes: 4, tokens: 106062 }
id: l-c6f3d672
scope: repo
status: active
src: agent
touches:
  - src/logging/transcriptTimestamps.ts
  - src/logging/transcriptLineEndings.ts
  - src/logging/sessionTranscriptLogger.ts
  - docs/terminal.md
---

## Decided

Nothing is merged yet; this records the diagnosis and the proposed fix for issue #338 (25 Nov comment). Plain CRLF never doubles in a saved transcript, under any timestamp or line-ending setting and any chunking. A device that sends CR CR LF does. Timestamps run before the line-ending conversion and treat a lone CR as a line boundary, so they stamp between the two CRs and the LF conversion can no longer join them. With LF selected, the result therefore depends on the timestamp setting: one line with timestamps off, two with them on (the default). With timestamps off, LF mode still leaves a CRLF for this stream.

Proposed: timestamps treat a run of CRs plus an optional LF as one boundary, also across chunks; LF mode collapses a run of CRs before LF and holds a count of pending CRs instead of a flag. A scratch prototype on v2.8.323 passed the 54 existing transcript tests, kept blank lines and CR progress output, and left Preserve's received bytes alone apart from dropping the false extra stamp.

## Tried and ruled out

A regression since the option shipped: the logging code and the logging setting definitions are identical in v2.8.317 and v2.8.323, and every transcript creation site passes the option. CRLF split across chunks or around an escape sequence: both come out as one line. LF CR and a leading CR also double, but the LF option never changed those, so they fit the report only if the reporter's 11 Nov "works now" was not a real check.

## Watch out

That the reporter's device sends CR CR LF is an inference from the symptom history, not observed. Confirm it with a raw output trace before telling them it is fixed, and leave LF CR alone unless the trace shows it. Terminals hide the extra CR, so the live view looks correct while editors show an extra line. The guide's claim that the option is independent of timestamps is wrong for this stream.

In the code: src/logging/transcriptTimestamps.ts, src/logging/transcriptLineEndings.ts, the format call in src/logging/sessionTranscriptLogger.ts, docs/terminal.md. Raw bytes: nexus.logging.terminalOutputTrace writes JSON-escaped "serial stdout" lines to globalStorage/sentriflow.vscode-nexterminal/logs/terminal-serial-<profileId>.log, which is not the folder Open Log Directory opens.
