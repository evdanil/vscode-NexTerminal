# UX Fixes Design — Feb 2026

## Problems

1. **No "Connect again" on connected servers** — once a server shows as connected, the inline menu only shows Disconnect; no way to open additional SSH terminals
2. **"Tunnel Patch Bay" is a confusing name** — rename to "Port Forwarding"
3. **Tunnel state icons are misleading** — inactive tunnels show a green arrow that looks like a play button but isn't clickable; active tunnels use `radio-tower` which doesn't communicate "running"
4. **Add/Edit forms use sequential input boxes** — terrible UX; replace with webview-based forms where all fields are visible at once

## Design

### 1. Multi-session connect

Add `nexus.server.connect` as an inline action on `nexus.serverConnected` items in `package.json` menus. Two-line change. Users see both Connect (plug icon) and Disconnect on connected servers.

### 2. Rename to "Port Forwarding"

Change `package.json` view name from "Tunnel Patch Bay" to "Port Forwarding". Update viewsWelcome text and tunnel monitor empty-state text. View ID `nexusTunnels` stays unchanged.

### 3. Circle-based tunnel state icons

| State | Icon | Color | Meaning |
|-------|------|-------|---------|
| Stopped | `circle-outline` | `descriptionForeground` (grey) | Inactive |
| Running | `circle-filled` | `testing.iconPassed` (green) | Active |

Inline action buttons remain `$(play)` / `$(debug-stop)` — those are the controls. The item icon shows status only.

### 4. Webview forms

**Architecture:** `WebviewFormPanel` — a reusable class that opens a `WebviewPanel`, renders an HTML form from a field schema, and returns form data via `postMessage`.

**Files:**
- `src/ui/formHtml.ts` — renders form HTML from a field descriptor array
- `src/ui/webviewFormPanel.ts` — manages the webview panel lifecycle, message passing
- Update command handlers in `src/commands/serverCommands.ts`, `tunnelCommands.ts`, `serialCommands.ts` to use webview forms instead of sequential input prompts

**Field descriptor type:**
```typescript
type FormField =
  | { type: "text"; key: string; label: string; required?: boolean; placeholder?: string; value?: string }
  | { type: "number"; key: string; label: string; required?: boolean; min?: number; max?: number; value?: number }
  | { type: "select"; key: string; label: string; options: { label: string; value: string }[]; value?: string }
  | { type: "checkbox"; key: string; label: string; value?: boolean }
  | { type: "file"; key: string; label: string; value?: string }
```

**Message protocol:**
- Extension → Webview: `{ type: "init", fields: FormField[], title: string, values: Record<string,unknown> }`
- Webview → Extension: `{ type: "submit", values: Record<string,unknown> }`
- Webview → Extension: `{ type: "cancel" }`
- Webview → Extension: `{ type: "browse", key: string }` (for file fields; extension opens native file dialog, sends path back)
- Extension → Webview: `{ type: "browseResult", key: string, path: string }`
- Extension → Webview: `{ type: "validationError", errors: Record<string,string> }`

**Form rendering:** Pure HTML/CSS using VS Code CSS variables. No bundler, no framework. The form HTML function generates a complete document with inline styles and a `<script>` that handles submit/cancel/browse via `acquireVsCodeApi().postMessage()`.

**Styling approach:** Uses `--vscode-input-background`, `--vscode-input-foreground`, `--vscode-input-border`, `--vscode-button-background`, `--vscode-button-foreground`, `--vscode-focusBorder` etc. Matches any VS Code theme automatically.

**Server form fields:**
1. Name (text, required)
2. Host (text, required)
3. Port (number, required, 1-65535, default 22)
4. Username (text, required)
5. Auth Type (select: Password / Private Key / Agent)
6. Key Path (file, conditional on auth type = key)
7. Group (select with existing groups + "Create new..." + free text fallback)
8. Hidden / Jump Host (checkbox)

**Tunnel form fields:**
1. Name (text, required)
2. Local Port (number, required, 1-65535)
3. Remote IP (text, required, default "127.0.0.1")
4. Remote Port (number, required, 1-65535)
5. Autostart (checkbox)
6. Connection Mode (select: Isolated / Shared / Ask every start)

**Serial form fields:**
1. Name (text, required)
2. Port Path (text, required, placeholder "COM3 or /dev/ttyUSB0")
3. Baud Rate (select: 9600/19200/38400/57600/115200/230400/460800/921600/Custom)
4. Data Bits (select: 8/7/6/5)
5. Stop Bits (select: 1/2)
6. Parity (select: None/Even/Odd/Mark/Space)
7. RTS/CTS (checkbox)
8. Group (select + create new)

**Panel behavior:**
- Opens as an editor tab (not sidebar webview)
- Title: "Add Server" / "Edit Server" / "Add Tunnel" etc.
- Single-column layout, labels above inputs
- "Save" and "Cancel" buttons at the bottom
- Panel auto-closes on save or cancel
- Only one form panel open at a time per form type
- Edit mode pre-fills all fields with existing values

**Validation:**
- Client-side: required fields, port range, number fields
- Server-side: same validation before saving (defense in depth)
- Validation errors shown inline below the offending field in red

**`src/ui/prompts.ts` disposition:** Keep `pickServer`, `pickTunnel`, `pickSerialProfile` QuickPick helpers (used for connect/disconnect). Remove `promptServerConfig`, `promptTunnelProfile`, `promptSerialProfile` — replaced by webview forms.
