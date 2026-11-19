---
title: A disconnected quick serial tab can still be saved
author: NetSecTech
date: 2026-11-19
branch: fix/quick-connect-types
id: l-19632127
scope: repo
status: active
src: agent
touches:
  - CHANGELOG.md
  - README.md
  - docs/functional-documentation.md
  - docs/serial.md
  - docs/ssh-and-telnet.md
  - docs/terminal.md
  - package-lock.json
  - package.json
  - src/commands/networkServerProfileCommands.ts
  - src/commands/profileCommands.ts
---

## Decided

Track a temporary serial connection with its exact VS Code terminal and reuse Standard Serial PTY creation. Record when it first opens so Save remains available after a transport disconnect while the tab still exists. Share port ownership with the saved serial commands so temporary owners participate in the same access checks. Publish the new Serial Profile only after storage succeeds.

## Tried and ruled out

The saved-profile connector requires a persisted profile to validate a late driver open and register its session. Persisting a draft to reuse that connector would expose it as a regular profile and give it profile-scoped routes before the user saves.

## Watch out

Treat a transport-close signal as release of the port reservation and a terminal-close signal as removal of the save target. A disconnected tab remains a valid record of its settings. Native context menu calls carry an exact target. Only the no-argument palette command may find a terminal by focus or ask the user to select it.

In the code: src/commands/quickConnectCommands.ts, src/commands/serialCommands.ts, src/commands/profileCommands.ts.
