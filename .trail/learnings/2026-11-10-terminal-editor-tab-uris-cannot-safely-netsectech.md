---
title: Terminal editor tab URIs cannot safely identify a serial session
author: NetSecTech
date: 2026-11-10
branch: codex/serial-send-box
id: l-d5f331f8
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
  - package.json
  - src/commands/profileCommands.ts
  - src/commands/serialCommands.ts
  - src/commands/types.ts
---

## Decided
Serial send-box actions use terminal/context and terminal/title/context, whose marshalled arguments identify an exact terminal. Omit the new actions from editor/title and editor/title/context: their resource URI cannot be bound to a public Terminal identity in VS Code 1.105. Terminal editors still offer the action inside the terminal body, and profile/session menus and the Command Palette remain available.

## Tried and ruled out
The old plan copied terminal/title, which is absent from the supported menu registry and is silently ignored. Editor chrome forwards a resource URI. Resolving its fragment/name or falling back to the active terminal can send to another session after a tab closes or a name is reused; refusing every click would leave an inert action. Do not use a proposed or private API to bridge it.

## Watch out
Keep explicit unknown URI targets fail-closed. Pin absence of the new command IDs in unsupported/excluded menu keys, without removing unrelated existing contributions as part of this feature.

In the code: src/commands/serialSendCommands.ts and package.json. Verified against microsoft/vscode tag 1.105.0: src/vs/workbench/services/actions/common/menusExtensionPoint.ts; src/vs/workbench/browser/parts/editor/editorTabsControl.ts lines 428-433; src/vs/workbench/api/common/extHostTerminalService.ts lines 466-486; terminalContextMenu.ts lines 39-46.
