# Terminal Tab Commands — Design

**Date:** 2026-04-15
**Status:** Approved for implementation planning

## Summary

Add three commands to the right-click context menu of Nexus-created terminal tabs, mirroring the equivalent PuTTY commands:

1. **Reset Terminal** — send an RIS reset sequence to unwedge a garbled xterm state.
2. **Clear Scrollback** — wipe the VS Code terminal scrollback and the local capture buffer.
3. **Copy All to Clipboard** — copy the accumulated session output (ANSI-stripped plain text) to the system clipboard.

The commands are scoped to Nexus-owned terminals (SSH, Standard Serial, Smart Follow Serial) and appear only on terminal tab right-click (`terminal/title/context`), not inside the terminal body.

## Motivation

Network engineers working with noisy devices (Cisco IOS, serial consoles, legacy firmware) regularly see terminals become corrupted by stray binary output, and they regularly want to capture long transcripts without enabling file logging. PuTTY users expect these three commands by muscle memory; Nexus Terminal should match that behavior for its core audience.

## Scope

### In scope

- Three new commands, registered via `package.json`.
- `terminal/title/context` menu contributions gated on a `nexus.isNexusTerminal` context key.
- A per-session in-memory ring buffer for captured output, sized to match the user's `terminal.integrated.scrollback` setting.
- Wiring into all three existing Pty classes (`sshPty.ts`, `serialPty.ts`, `smartSerialPty.ts`).

### Out of scope

- Copying with ANSI/color codes preserved.
- Persisting the ring buffer across terminal close/reopen.
- Menu entries inside the terminal body (`terminal/context`) — intentionally skipped to avoid clashing with users who bind right-click to paste.
- Editor-tab header menu (`editor/title/context`) — VS Code routes terminal-in-editor tab right-clicks through `terminal/title/context`, so no separate contribution is needed.

## Architecture

### New module: `src/services/terminal/terminalCaptureBuffer.ts`

Line-based ring buffer. ANSI-strips incoming data on ingest using the existing `stripTerminalCodes` helper from `sessionTranscriptLogger.ts` (extracted into a shared module if not already exported).

Public API:

```ts
class TerminalCaptureBuffer {
  constructor(maxLines: number);
  append(data: string): void;  // strips ANSI, appends lines, enforces cap
  clear(): void;
  getText(): string;           // joined with "\n", no trailing newline
  setMaxLines(n: number): void;
}
```

`maxLines` comes from `vscode.workspace.getConfiguration("terminal.integrated").get<number>("scrollback") ?? 1000` at construction. The buffer subscribes to `onDidChangeConfiguration` and updates its cap on `terminal.integrated.scrollback` changes, trimming if the new cap is smaller.

Partial lines are held in a pending-line field and flushed when a newline arrives; on buffer read, the pending fragment is included as the last line.

### Pty changes

Each of `sshPty.ts`, `serialPty.ts`, `smartSerialPty.ts`:

- Instantiate a `TerminalCaptureBuffer` alongside the existing `SessionTranscript`.
- In every data path that currently calls `transcript.write(text)`, also call `captureBuffer.append(text)`.
- Dispose the buffer (`clear()` + unsubscribe config listener) when the Pty closes.
- Expose three public methods:
  - `resetTerminal()` — fires `"\x1bc"` through `writeEmitter`.
  - `clearScrollback()` — calls `captureBuffer.clear()`. Does **not** invoke the VS Code clear command itself; the command handler does that so that the terminal lookup happens in one place.
  - `copyAllToClipboard()` — returns `captureBuffer.getText()`.

To keep the Pty classes from repeating capture-buffer wiring, a small mixin/helper module or shared base is acceptable but not required — three near-identical additions are fine given the existing structure.

### Terminal registry

Add a `TerminalRegistry` (either as a new file `src/services/terminal/terminalRegistry.ts` or as methods on `NexusCore`):

```ts
class TerminalRegistry {
  register(terminal: vscode.Terminal, pty: NexusPty): void;
  get(terminal: vscode.Terminal): NexusPty | undefined;
  unregister(terminal: vscode.Terminal): void;  // called on onDidCloseTerminal
}
```

Where `NexusPty` is a narrow interface exposing the three methods above. The concrete `SshPty`, `SerialPty`, `SmartSerialPty` classes all implement it.

The registry is populated in the connect handlers (`serverCommands.ts`, `serialCommands.ts`) immediately after `vscode.window.createTerminal(...)`. It is cleared via `vscode.window.onDidCloseTerminal`.

### Context key

On every `onDidChangeActiveTerminal` event, set:

```ts
vscode.commands.executeCommand(
  "setContext",
  "nexus.isNexusTerminal",
  registry.get(activeTerminal) !== undefined
);
```

VS Code's terminal tab right-click activates the tab before showing the menu in practice, so the context key reflects the intended target. If this proves flaky in testing, the fallback is to drop the `when` clause and have the command handlers silently no-op on non-Nexus terminals.

### Command handlers

Registered in `extension.ts` during `activate()`:

- `nexus.terminal.reset` — receives `vscode.Terminal` from menu → registry lookup → `pty.resetTerminal()`. Shows a status-bar tick on success.
- `nexus.terminal.clearScrollback` — lookup → `pty.clearScrollback()` → `vscode.commands.executeCommand("workbench.action.terminal.clear")`. Ordering: clear the ring buffer before the VS Code command so both stay in sync even if the VS Code command fails.
- `nexus.terminal.copyAll` — lookup → `text = pty.copyAllToClipboard()` → `vscode.env.clipboard.writeText(text)` → info message `"Copied N lines to clipboard"` (where N is the number of newlines in the copied text). If the buffer is empty, show a warning toast `"Nothing to copy"` and skip the clipboard write.

### `package.json`

```json
{
  "commands": [
    { "command": "nexus.terminal.reset", "title": "Reset Terminal", "category": "Nexus" },
    { "command": "nexus.terminal.clearScrollback", "title": "Clear Scrollback", "category": "Nexus" },
    { "command": "nexus.terminal.copyAll", "title": "Copy All to Clipboard", "category": "Nexus" }
  ],
  "menus": {
    "terminal/title/context": [
      { "command": "nexus.terminal.reset", "when": "nexus.isNexusTerminal", "group": "nexus@1" },
      { "command": "nexus.terminal.clearScrollback", "when": "nexus.isNexusTerminal", "group": "nexus@2" },
      { "command": "nexus.terminal.copyAll", "when": "nexus.isNexusTerminal", "group": "nexus@3" }
    ],
    "commandPalette": [
      { "command": "nexus.terminal.reset", "when": "nexus.isNexusTerminal" },
      { "command": "nexus.terminal.clearScrollback", "when": "nexus.isNexusTerminal" },
      { "command": "nexus.terminal.copyAll", "when": "nexus.isNexusTerminal" }
    ]
  }
}
```

Grouping all three under `nexus@N` keeps them together and separate from VS Code's built-in title entries.

## Data flow

```
ssh/serial byte stream
    │
    ├──► transcript.write(text)           (existing — ANSI-stripped file logging)
    ├──► writeEmitter.fire(text)          (existing — drives xterm display)
    └──► captureBuffer.append(text)       (NEW — ANSI-stripped ring buffer)
```

Reset command:
```
handler → pty.resetTerminal() → writeEmitter.fire("\x1bc")
```

Clear Scrollback command:
```
handler → pty.clearScrollback() (captureBuffer.clear())
        → executeCommand("workbench.action.terminal.clear")
```

Copy All command:
```
handler → text = pty.copyAllToClipboard() (captureBuffer.getText())
        → vscode.env.clipboard.writeText(text)
        → info message
```

## Testing

### Unit tests

`test/unit/terminalCaptureBuffer.test.ts`:

- Appends plain lines, reads them back joined by `\n`.
- Strips ANSI codes on ingest.
- Enforces line cap (overflow drops oldest).
- Handles partial lines (no newline) — kept as pending, returned on `getText()`.
- `clear()` empties the buffer.
- `setMaxLines(n)` trims if new cap is smaller; preserves if larger.
- Reacts to `terminal.integrated.scrollback` config change.

Optionally, small addition to each existing Pty unit test to assert the buffer is populated when data is received — but this is a light-touch check, not a full integration test.

### Manual verification

- Reset unwedges a session after `cat /dev/urandom | head -c 1000`.
- Clear Scrollback empties VS Code's scrollback and empties the copy-all buffer.
- Copy All produces pastable plain text; verify on SSH, Standard Serial, and Smart Follow Serial.
- Menu items appear only on Nexus tabs, not on a plain `vscode.window.createTerminal()` (the extension doesn't create those, but a user could via another extension).

## Risks & open questions

- **Context key lag** — documented above; fallback is silent no-op.
- **Smart Follow reconnect output** — status lines like `[Nexus Serial] Switched to COM5` are already written to the terminal and would therefore appear in Copy All output. Acceptable: the transcript logger captures the same lines and users have never reported this as a concern.
- **Memory growth** — worst case 1000 lines × N sessions. With typical line length ~80 chars, that's ~80 KB per session. Negligible.
- **Config-change timing** — if the user lowers `terminal.integrated.scrollback` mid-session, we trim; if they raise it, the buffer starts filling from its current size. No backfill (we don't have history).

## Versioning

Per `CLAUDE.md`, bump `package.json` patch version when this ships (e.g. 2.7.70 → 2.7.71).
