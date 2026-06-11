# Settings Guard + Forensics — Design

**Date:** 2026-06-11
**Status:** Approved (pending spec review)
**Target version:** 2.8.55

## Problem

An external tool (suspected corporate DLP/endpoint agent) periodically rewrites the
user-level `settings.json`, dropping array-valued keys. Observed cycle is roughly
every 3 hours. For Nexus users the damaging loss is the
`terminal.integrated.commandsToSkipShell` user override: without
`nexus.macro.run` / `nexus.macro.runBinding` in that list, Alt-based macro
shortcuts never reach the extension while a terminal is focused.

Nexus-own array settings (`nexus.terminal.passthroughKeys`,
`nexus.terminal.highlighting.rules`) are already resilient: a deleted key falls
back to the `package.json` default and an emptied/corrupt array is sanitized at
read time (v2.8.50, commits `0c8ba8b`, `5e3e011`). They need no writes.

`commandsToSkipShell` is consumed by VS Code core, not by the extension, so
read-time sanitization is impossible. The current defense (v2.8.53, commit
`2815584`) is a one-time dismissible hint plus a confirm-gated repair command —
a human must notice and click after every corruption cycle.

Identifying and stopping the external tool is the real fix, but it involves
corporate IT teams and will take time. This feature makes the extension
self-healing in the meantime and produces evidence to accelerate the IT hunt.

## Goals

1. Automatically restore stripped `commandsToSkipShell` entries with no user
   interaction (opt-out).
2. Record forensic evidence of every external mutation, usable by corporate IT
   to correlate against DLP/agent logs.

## Non-goals

- Auto-flipping boolean settings (`sendKeybindingsToShell`,
  `enableMenuBarMnemonics`). Boolean flips may be intentional user choices and
  are not the DLP signature (it drops arrays). They remain prompt-gated via the
  existing hint + `nexus.settings.fixMacroKeybindings`.
- Protecting non-Nexus-relevant settings.
- Identifying the writing process (no VS Code API for that; the report's
  timestamps enable external correlation instead).

## Design

New module `src/services/terminal/settingsGuard.ts` — pure, vscode-free logic
(project pattern, same as `skipShellRepair.ts` / `macroKeybindingBlockers.ts`),
with thin wiring in `extension.ts`.

### 1. Shadow (last-known-good)

- `globalState` key `nexus.settingsGuard.lastKnownGood`: per-scope snapshot of
  `terminal.integrated.commandsToSkipShell` (`globalValue`, `workspaceValue`,
  `workspaceFolderValue`) plus a timestamp.
- Updated on every configuration change where each defined level contains all
  `MACRO_SKIP_SHELL_COMMANDS` (healthy state). Never updated from a corrupt
  state.

### 2. Detection

- Listen to `workspace.onDidChangeConfiguration` for
  `terminal.integrated.commandsToSkipShell`, plus one check at activation
  (the DLP also runs while VS Code is closed; the startup check catches
  overnight damage).
- Corruption signature: a scope that previously held the Nexus commands now has
  the key vanished, the array emptied, or the Nexus entries missing.
- Own-write discrimination by **value comparison**, not timing flags: the guard
  remembers the exact value it (or the repair command) last wrote per scope;
  if the observed value equals it, the event is classified `own-write` and
  skipped. Robust against event-ordering races.

### 3. Restore policy

- **Whole key vanished or array emptied** (DLP signature) → restore the **full**
  last-known-good array for that scope. This also recovers the user's other
  entries (other extensions' skip-shell commands) that the DLP destroyed.
- **Array present but Nexus entries missing** → conservative: append only the
  Nexus commands via the existing `planSkipShellRepair`.
- Every auto-restore shows a non-modal toast:
  *"Nexus restored terminal settings modified by an external program."*
  Buttons: **Undo** (writes the pre-restore value back — safety valve against a
  false positive such as an intentional key removal), **Disable Guard**
  (sets `nexus.settingsGuard.enabled` to false), **Show Report**.

### 4. Rate limiting

Two independent limits; tripping either pauses the guard for the rest of the
session (detection and logging continue, writes stop):

- **Session cap: 12 restores.** Sized for multi-day sessions against a ~3-hour
  corruption cycle (24 h ≈ 8 cycles; 12 leaves headroom).
- **Burst guard: 3 restores within 10 minutes.** Catches a tight write-war
  (external tool reacting immediately to our write) without ever triggering on
  the spread-out DLP cycle.

On pause, a warning toast appears:
*"External program rewrote settings.json N times — Nexus auto-repair paused."*
Buttons: **Resume Guard** (re-arms: clears both counters and resumes
restoring), **Show Report**.

### 5. Forensics (always on, independent of the guard toggle)

- Watched keys: `terminal.integrated.commandsToSkipShell`,
  `terminal.integrated.sendKeybindingsToShell`,
  `window.enableMenuBarMnemonics`, `nexus.terminal.passthroughKeys`,
  `nexus.terminal.highlighting.rules`.
- Every mutation logged with: timestamp (ISO), key, scope, before → after
  (values truncated for size), classification
  (`external-strip` / `external-other` / `own-write` / `restore` / `undo`).
- Ring buffer of the last 50 events persisted in `globalState`
  (`nexus.settingsGuard.eventLog`) so the report survives restarts; live lines
  also written to a new Output Channel **"Nexus Settings Guard"**.
- New command `nexus.settingsGuard.showReport` ("Nexus: Show Settings Guard
  Report"): summary — total corruption count, first/last seen, affected keys,
  full timestamp list — followed by the event log. This is the artifact the
  user hands to corporate IT for correlation with DLP/agent logs.

### 6. Settings

- `nexus.settingsGuard.enabled` — boolean, **default `true`** (opt-out).
  Gates auto-restore writes only; forensic logging is always on.

## Risks & mitigations

| Risk | Mitigation |
| --- | --- |
| Settings Sync legitimately removes entries (user edited on another machine); guard re-adds them | Undo button on every restore toast; Disable Guard button; rate limits |
| Write war with the external tool | Burst guard (3 in 10 min) pauses writes; evidence-only mode continues |
| Guard's own writes trigger detection loop | Value-comparison own-write discrimination |
| globalState shadow goes stale across VS Code profiles/machines | Shadow only updated from healthy observed state on this machine; restore always passes through validation before writing |

## Testing

Pure logic in `settingsGuard.ts` unit-tested with vitest (project pattern —
no VS Code stubs needed):

- corruption-signature detection (vanished / emptied / partial-missing / healthy)
- shadow update rules (healthy-only)
- full-restore vs append decision
- own-write value comparison
- rate limiter: session cap, burst window, resume re-arm
- event-log ring buffer (cap 50, ordering, classification)

Wiring in `extension.ts` stays thin. Existing `skipShellRepair` tests
unchanged; repair command now also records its writes with the guard so they
classify as `own-write`.

## Release

- Version bump `2.8.54` → `2.8.55` (per repo versioning rules), changelog entry.
- Implementation delegated to a Sonnet-based sub-agent per repo workflow.
