---
title: Keep native terminal context when its target has closed
author: NetSecTech
date: 2026-11-10
branch: codex/serial-send-box
id: l-e0675ef8
scope: repo
status: active
src: agent
touches:
  - AGENTS.md
  - docs/functional-documentation.md
  - docs/serial.md
  - src/commands/serialSendCommands.ts
  - src/ui/serialSendPanel.ts
  - test/unit/serialSendCommands.test.ts
  - test/unit/serialSendPanel.test.ts
---

## Decided
Only a truly argument-free serial send-box command may use the active terminal or a session picker. Preserve native invocation arity/context through command registration. A stale native context whose first terminal no longer resolves must refuse, even if another selected terminal remains live.

## Tried and ruled out
Treating every undefined first argument as a Command Palette invocation looked fail-closed for object targets but was unsafe after VS Code marshaling. TerminalContextActionRunner passes the first target and selected-context array; ExtHostTerminalService resolves a closed terminal ID to undefined. Dropping the second argument made (undefined, [undefined]) open the active serial session instead of refusing the closed clicked target. A production-code reproducer and new regressions expose this boundary.

## Watch out
Do not infer the missing target from another selected terminal. Preserve ordinary zero-argument palette behavior and exact valid clicked-terminal identity. Both open and direct-input command handlers share this boundary, even though current native menus contribute only Open Send Box.

In the code: src/commands/serialSendCommands.ts and test/unit/serialSendCommands.test.ts. Verified against microsoft/vscode tag 1.105.0 terminalContextMenu.ts and extHostTerminalService.ts; the important distinction survives argument conversion in the second argument/arity.
