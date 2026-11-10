---
title: Dedicated serial input needs explicit macro routing
author: NetSecTech
date: 2026-11-10
branch: codex/serial-send-box
id: l-f38ee7d3
scope: repo
status: active
src: agent
touches:
  - AGENTS.md
  - CHANGELOG.md
  - README.md
  - docs/functional-documentation.md
  - docs/serial.md
  - docs/terminal.md
  - src/commands/macroCommands.ts
  - src/commands/macroVariablePrompt.ts
  - src/commands/serialCommands.ts
  - src/commands/types.ts
---

## Decided
A serial send box gates native terminal input per session. Nexus-owned macros use an explicit guarded serial route that still honors script input locks, pins the selected PTY/connection before variable prompts, and preserves macro bytes. The text composer's EOL conversion and byte limit do not apply to macros.

## Tried and ruled out
Changing only automatic macro callbacks misses manual macros: both workbench terminal sendSequence and Terminal.sendText re-enter the same default PTY input path and would be silently blocked. Temporarily disabling the gate or adding escape markers cannot reliably distinguish trusted macro sends from third-party terminal input.

## Watch out
The live transport map drops disconnected Standard sessions while their native terminal tabs remain. Resolve manual macros through TerminalRegistry so a known disconnected serial owner refuses explicitly instead of falling back to a successful-looking native send. Capture its connection generation before prompts; never retarget to a newly active terminal.

In the code: src/commands/serialMacroTarget.ts, src/commands/macroCommands.ts, src/commands/macroVariablePrompt.ts, src/services/serial/serialUserInput.ts. Command-to-real-PTY tests and deliberate routing mutations cover this distinction.
