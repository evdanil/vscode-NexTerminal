# Nexus Scripts — User Guide

Nexus Scripts let you automate multi-step terminal procedures in plain JavaScript, with full editor support, running against any live SSH or Serial session.

- [When to use a script (vs. a macro)](#when-to-use-a-script-vs-a-macro)
- [Quickstart](#quickstart)
- [Anatomy of a script](#anatomy-of-a-script)
- [Header fields](#header-fields)
- [Script API reference](#script-api-reference)
  - [Waiting for output](#waiting-for-output)
  - [Sending input](#sending-input)
  - [Polling](#polling)
  - [Interacting with the user](#interacting-with-the-user)
  - [Utility](#utility)
  - [Macro coordination](#macro-coordination)
  - [Session metadata](#session-metadata)
- [Error handling](#error-handling)
- [Match window semantics](#match-window-semantics)
- [Macro coordination in detail](#macro-coordination-in-detail)
- [Input locking](#input-locking)
- [Common recipes](#common-recipes)
- [Settings](#settings)
- [Commands and views](#commands-and-views)
- [Troubleshooting](#troubleshooting)
- [Limitations](#limitations)

---

## When to use a script (vs. a macro)

Nexus Terminal already ships with [Terminal Macros](../README.md#features), including auto-triggered "expect/send" pairs for single-shot reactions like "send the stored password when `Password:` appears". Macros are ideal when you want to react to a single prompt, once, and keep the terminal in the user's hands.

Scripts exist for the work that macros can't express:

- **Multi-step procedures.** E.g. a router IOS downgrade: enter ROMMON, set config registers, boot a packaged image, poll for the login banner, capture an image name from a directory listing, run an install, wait through a reboot, then repeat. Chaining macros for this is brittle and fragile.
- **Conditional branching.** "Wait for one of N prompts and do different things depending on which matched."
- **Loops and retries.** "Retry this flaky command up to 5 times with exponential back-off."
- **Human-in-the-loop steps.** "Pause, ask the user to insert a USB stick and click OK, then continue."
- **Polling.** "Send a carriage return every 2 seconds for up to 15 minutes until the device comes back."

A script is a regular `.js` file in your workspace. Writing one looks and feels exactly like writing any other async JavaScript — except the globals `waitFor`, `expect`, `sendLine`, `poll`, `prompt`, etc. talk to the terminal for you.

---

## Quickstart

1. **Open a folder in VS Code.** Scripts live in the workspace and are managed like any other source file (so they can live under version control).
2. **Open at least one SSH or Serial session** through the Nexus sidebar.
3. **Create a script** at `.nexus/scripts/hello.js`:
   ```js
   /**
    * @nexus-script
    * @name Hello
    * @target-type ssh
    */

   const prompt = await expect(/[$#] $/, { timeout: 10_000 });
   log.info("shell ready:", prompt.text);

   await sendLine("uname -a");
   const out = await expect(/[$#] $/);
   log.info("kernel:", out.before.trim());
   ```
4. **Run it** — any of three equivalent ways:
   - `Cmd/Ctrl+Shift+P` → **Nexus: Run Nexus Script** and pick `hello.js`.
   - In the **Nexus** sidebar, expand **Scripts** and click the file.
   - Open `hello.js` in the editor and click the **▶ Run in Nexus** CodeLens above the header.

   If more than one SSH session is active, you'll be asked to pick one.
5. **Watch it run.** The **Nexus Scripts** Output Channel prints each event:
   ```text
   [12:01:33.221] Hello  start (session: web-1, ssh)
   [12:01:33.245] Hello  → waitFor /[$#] $/
   [12:01:33.512] Hello  ← matched
   [12:01:33.514] Hello  log info: shell ready: ubuntu@web-1:~$
   [12:01:33.515] Hello  → send "uname -a\r"
   [12:01:33.517] Hello  → waitFor /[$#] $/
   [12:01:33.612] Hello  ← matched
   [12:01:33.613] Hello  log info: kernel: Linux web-1 6.2.0 ...
   [12:01:33.614] Hello  end: completed (393ms)
   ```

The first time you run any script command in this workspace, Nexus writes `types/nexus-scripts.d.ts` + `jsconfig.json` next to your scripts so the editor gives autocomplete, JSDoc hovers, and inline type-checking for every primitive.

---

## Anatomy of a script

Every script has two parts: a **JSDoc header** and an **async body**.

```js
/**
 * @nexus-script                       // required marker
 * @name Router IOS Downgrade          // display name
 * @target-type serial                 // only run against serial sessions
 * @default-timeout 30s                // default wait timeout
 */

// Async body — plain JavaScript. `await` any API primitive.
await expect(/ROMMON>/i);
await sendLine("boot");
```

**The header must be the first JSDoc block in the file** and must contain `@nexus-script` on one of its lines. If the marker appears after the first executable statement (e.g. after `const x = 1`), the file is not recognized as a Nexus script.

The body runs inside an `async` function, so:

- `await` every call to a Nexus primitive (`await expect(...)`, `await sendLine(...)`, etc.).
- Top-level `await` works — you don't need to wrap your code in `(async () => {...})()`.
- Regular JavaScript (`if`, `while`, `for...of`, `try/catch`, destructuring, closures, imports of the globals) all work as expected.
- You can `throw` to fail the run with an error message; the Output Channel logs it and the final state is `failed`.

---

## Header fields

Every field except `@nexus-script` is optional.

| Tag | Value | Default | Notes |
|---|---|---|---|
| `@nexus-script` | flag — no value | — | Required marker. Files without this are not Nexus scripts. |
| `@name` | single-line string | filename without `.js` | Display name in tree, CodeLens, picker, and status bar. |
| `@description` | single-line string | empty | Shown as tooltip in the sidebar. |
| `@target-type` | `ssh` or `serial` | unrestricted | Filters the session picker so only matching sessions are offered. |
| `@target-profile` | server name or serial profile name | none | When a session of this profile is active, it's auto-selected without showing the picker. |
| `@default-timeout` | duration: `1500ms`, `30s`, `5m` | `nexus.scripts.defaultTimeout` (30s) | Used by `waitFor`/`expect`/`waitAny` when no per-call `timeout` is provided. |
| `@lock-input` | flag — no value | absent (terminal stays interactive) | Makes the bound terminal read-only for the run. User keystrokes are discarded with a one-shot notice line. |
| `@allow-macros` | comma-separated macro names | `[]` | Names of macros to keep enabled on the bound session while the script runs. Default policy (suspend-all) suspends everything else. |

### Header validation

- Unknown `@<tag>` names produce a warning in the Output Channel — the script still loads.
- Invalid values for `@target-type` (not `ssh` / `serial`) or `@default-timeout` (not `<n>ms|s|m`) block the run with a descriptive error.
- Duplicate fields are tolerated; the first occurrence wins and a warning is logged.
- Only the first JSDoc block in the file is examined.

---

## Script API reference

Every API function is an async global. TypeScript signatures live in the auto-seeded `nexus-scripts.d.ts`; below is the functional reference with examples.

### Waiting for output

#### `waitFor(pattern, opts?)` → `Promise<Match | null>`

Wait for `pattern` to match new output from the bound session. Resolves with a `Match` on success or `null` on timeout.

```js
const m = await waitFor(/Login: $/, { timeout: 10_000 });
if (!m) {
  log.warn("no login prompt — giving up");
  return;
}
log.info("got prompt:", m.text);
```

#### `expect(pattern, opts?)` → `Promise<Match>`

Like `waitFor`, but **throws** a `TimeoutError` instead of returning `null` on timeout. Use `expect` when "this pattern must appear" is part of the script's contract. Use `waitFor` when you want to branch on whether the pattern appeared.

```js
try {
  await expect(/Password:/i, { timeout: 5_000 });
} catch (err) {
  if (err.code === "Timeout") {
    log.error(`no password prompt after ${err.elapsedMs}ms`);
  }
  throw err;
}
```

#### `waitAny(patterns, opts?)` → `Promise<{ index, match }>`

Wait for the first of several patterns to match. Returns the `index` into the `patterns` array plus the `match` details.

```js
const r = await waitAny(
  [/password:/i, /passphrase:/i, /denied/i, /[$#] $/],
  { timeout: 20_000 }
);
switch (r.index) {
  case 0: /* password prompt */ break;
  case 1: /* passphrase prompt */ break;
  case 2: throw new Error("auth denied");
  case 3: /* already logged in */ break;
}
```

**`Match` object shape:**

| Field | Type | Meaning |
|---|---|---|
| `text` | `string` | The full matched substring. |
| `groups` | `string[]` | Regex capture groups. Empty array for string patterns; `[]` for regexes with no groups. |
| `before` | `string` | Output between the previous cursor position and the match — useful for capturing command output between prompts. |

**`opts` for `waitFor` / `expect` / `waitAny`:**

| Option | Type | Default | Notes |
|---|---|---|---|
| `timeout` | `number` (ms) | `@default-timeout` header or `nexus.scripts.defaultTimeout` setting | Upper bound on the wait. |
| `lookback` | `number` | `1024` on the first wait of the script, `0` afterwards | Bytes of recent output to scan before waiting for new bytes. See [match window semantics](#match-window-semantics). |

### Sending input

#### `send(text)` → `Promise<void>`

Write raw `text` to the bound session. No line terminator appended.

```js
await send("X");              // send a single letter
await send("ABC\x03");        // send "ABC" then Ctrl-C
```

#### `sendLine(text)` → `Promise<void>`

`send(text + "\r")` — the normal "type this line and press Enter" shape.

```js
await sendLine("show version");
```

#### `sendKey(key)` → `Promise<void>`

Send a named control key. Legal values:

| Category | Keys |
|---|---|
| Ctrl combos | `ctrl-a` · `ctrl-b` · `ctrl-c` · `ctrl-d` · `ctrl-e` · `ctrl-k` · `ctrl-l` · `ctrl-n` · `ctrl-p` · `ctrl-r` · `ctrl-u` · `ctrl-w` · `ctrl-z` |
| Navigation | `enter` · `esc` · `tab` · `space` · `backspace` |
| Arrows | `up` · `down` · `left` · `right` |
| Paging | `home` · `end` · `page-up` · `page-down` |
| Function | `f1` — `f12` |

```js
await sendKey("ctrl-c");      // cancel a running command
await sendKey("esc");          // exit a pager like `less`
```

### Polling

#### `poll({ send, until, every, timeout })` → `Promise<Match>`

Repeatedly send `send` (a string) on a fixed cadence, watching for `until`. Resolves with the `Match` as soon as `until` matches; throws `Timeout` if the overall `timeout` elapses first.

| Option | Type | Notes |
|---|---|---|
| `send` | `string` | Text to send on each tick. Minimum tick is 50 ms. |
| `until` | `string \| RegExp` | Pattern that ends the poll loop. |
| `every` | `number` (ms) | Tick interval. |
| `timeout` | `number` (ms) | Total wall-clock budget. |

Use `poll` when a device is busy for a long time and a plain `expect` would time out. Typical use: wait for a device to finish rebooting after a firmware install.

```js
await poll({
  send: "\r",
  until: /Press RETURN to get started/i,
  every: 2_000,
  timeout: 15 * 60_000      // up to 15 minutes
});
```

### Interacting with the user

All three show native VS Code modal dialogs.

#### `prompt(message, opts?)` → `Promise<string>`

Ask for free-text input. Returns `""` on cancel.

| Option | Type | Notes |
|---|---|---|
| `default` | `string` | Pre-fill the input box. |
| `password` | `boolean` | When true, mask input and exclude the value from the Output Channel. |

```js
const name = await prompt("Hostname to configure", { default: "router-01" });
const pw = await prompt("Enable password", { password: true });
```

#### `confirm(message)` → `Promise<boolean>`

Native modal with **OK** and **Cancel** buttons. Resolves `true` when the user picks **OK**, `false` on **Cancel** or dismiss.

```js
if (!(await confirm("Reboot device now?"))) {
  log.info("user declined");
  return;
}
```

#### `alert(message)` → `Promise<void>`

Native modal with an **OK** button only. Resolves when the user dismisses it.

```js
await alert("Insert USB stick and click OK to continue.");
```

### Utility

#### `sleep(ms)` → `Promise<void>`

Wait for a fixed duration.

```js
await sleep(500);
```

#### `tail(n?)` → `Promise<string>`

Return the last `n` characters of the stripped output buffer (ANSI already removed). Defaults to 512, caps at the buffer length (64 KiB). Use this inside a `catch` block or after a `waitFor` that returned `null` to see what actually arrived:

```js
const m = await waitFor(/OK/, { timeout: 1_000 });
if (!m) log.warn("no OK — recent output:", await tail());
```

`tail(0)` returns an empty string. The buffer is rolling, so very old output (>64 KiB ago) is not available.

#### `log.info(...)` / `log.warn(...)` / `log.error(...)` → `void`

Write a level-tagged line to the **Nexus Scripts** Output Channel. Accepts multiple arguments — objects are JSON-stringified.

```js
log.info("step 1 complete");
log.warn("ping lost:", loss, "%");
log.error("auth failed for", session.name);
```

`log` is not async — it doesn't block the script. Password values entered through `prompt(msg, { password: true })` are excluded from log events; any other values you pass to `log.*` are written verbatim — don't log secrets.

### Macro coordination

By default, all macros on the script's bound session are **suspended** for the duration of the run. Macros on unrelated sessions keep firing. You can override this four ways:

- **Per-script header** — `@allow-macros name1, name2` keeps those named macros enabled for the run.
- **Workspace setting** — `nexus.scripts.macroPolicy = "keep-enabled"` inverts the default so all macros fire unless the script explicitly denies them.
- **Runtime API** — the `macros` global:
  ```js
  macros.allow("hostname-prompt");    // allow one (or an array)
  macros.deny("password");             // block one (or an array), overrides allow
  macros.disableAll();                 // deny everything
  macros.restore();                    // revert to the state at script start
  ```
- **Script exit** — on any exit path (success, stop, crash, connection lost) the prior macro state is restored automatically.

See [Macro coordination in detail](#macro-coordination-in-detail) for the full semantics.

### Session metadata

A read-only `session` global describes the session the script is bound to:

| Field | Type | Notes |
|---|---|---|
| `session.id` | `string` | Stable session id (matches `ActiveSession.id` in NexusCore). |
| `session.type` | `"ssh" \| "serial"` | Transport type. |
| `session.name` | `string` | Terminal title (display name). |
| `session.targetId` | `string` | Server id (for SSH) or serial profile id (for serial). |

Use it to branch on context, e.g. to change behaviour based on whether you're running against a lab device or production:

```js
if (session.name.startsWith("prod-")) {
  if (!(await confirm(`This is production (${session.name}). Really continue?`))) {
    return;
  }
}
```

> **Note**: `session` is populated after the script connects, so it won't be available synchronously at the very top of the body; safest to reference it inside an `async` context (which is everything in a script body).

---

## Error handling

Every script runs inside an async function, so normal `try / catch / finally` applies. Three error codes are worth handling explicitly:

| `err.code` | Thrown by | When |
|---|---|---|
| `"Timeout"` | `expect`, `waitAny`, `poll` | The pattern didn't appear within the wait budget. |
| `"ConnectionLost"` | any in-flight `expect` / `send` / `poll` / `prompt` | The bound session disconnected mid-wait. |
| `"InvalidKey"` | `sendKey` | An unknown control-key name was passed. |

A typical error-handler:

```js
try {
  await expect(/# $/);
  await sendLine("install add file ...");
  await poll({ send: "", until: /Press RETURN/, every: 5_000, timeout: 15 * 60_000 });
} catch (err) {
  if (err.code === "Timeout") {
    log.error(`timed out on ${err.pattern} after ${err.elapsedMs}ms`, "recent output:", await tail());
  } else if (err.code === "ConnectionLost") {
    log.error("session dropped — manual intervention required");
  } else {
    log.error("unexpected:", err.message);
  }
  throw err;                   // re-throw so the run ends with state=failed
}
```

Uncaught exceptions end the run with final state `failed`. The Output Channel logs the error message and stack. Macros, input lock, and output observers are **always released automatically** regardless of how the run ends — you do **not** need a `finally { macros.restore() }` block. `macros.restore()` exists so a mid-run script can revert a temporary allow/deny; if the script ends before it calls it, the runtime does the same thing on your behalf.

Nexus distinguishes two flavours of failure and the UI treats them differently:

- **Expected failures** — an uncaught `Timeout`, `ConnectionLost`, `Stopped`, or `Cancelled`. These are the documented error contract; the run ends quietly in `failed` and nothing pops up.
- **Unexpected failures** — a syntax error, `TypeError`, module-load error, or a Worker crash. VS Code surfaces an error toast with a **Show Output** button so the stack is one click away.

If you want to shut a script down from the host side (e.g. a deploy pipeline's watchdog), call the `Nexus: Stop Nexus Script` command or rely on the workspace setting `nexus.scripts.maxRuntimeMs` — a default 30-minute overall cap that force-stops runaway scripts.

---

## Match window semantics

Understanding how `expect` / `waitFor` scan output matters when you're debugging "why didn't my pattern match?"

- Each running script owns a rolling buffer of the session's recent output (default 64 KiB; ANSI escapes stripped at write time so patterns match on the same characters the user sees).
- The buffer has a **forward-only cursor**. The first wait scans the last 1 KB of output **plus** any new output that arrives; subsequent waits only scan output that arrives after the previous wait's match.
- Once a wait matches, the cursor advances past the match. The same prompt can't accidentally satisfy two consecutive waits.
- If a wait's pattern doesn't match immediately, the runtime re-scans on every new output chunk until it matches or the timeout fires.
- Per-call `lookback` overrides the default (use `lookback: 4096` if you know you've got a large banner or quick prompt you want to re-match).

Common pitfalls:

- **Pattern matches too aggressively**, catching a promptish substring inside normal output. Use a more specific regex (anchor with `$`, include device-specific prefixes like `^Router# $`).
- **Pattern doesn't match despite visible output**, because ANSI color escapes split the pattern. Remember the buffer holds stripped text — write patterns against the printable characters.
- **First prompt never appears**, because the remote has already printed it before the script attaches. Increase `lookback` on the first wait: `await expect(/[$#] $/, { lookback: 4096 })`.

---

## Macro coordination in detail

This is the single most common cause of surprises when you start mixing scripts with auto-trigger macros. The model:

1. When a script starts, the runtime installs a **macro filter** on the bound session only. Other active sessions are completely untouched.
2. The filter has three components:
   - `defaultAllow` — determined at script start from `nexus.scripts.macroPolicy` (`"suspend-all"` → `false`, `"keep-enabled"` → `true`).
   - `allowList` — populated from the header's `@allow-macros` field.
   - `denyList` — empty at start.
3. For every macro on the bound session, at trigger-evaluation time:
   - If the macro's name is in `denyList` → block.
   - Else if it's in `allowList` → allow.
   - Else → `defaultAllow`.
4. `macros.allow("x")` adds to `allowList`; `macros.deny("x")` adds to `denyList`; `macros.disableAll()` clears both lists and flips `defaultAllow = false`; `macros.restore()` reverts to the state at start.
5. When the script ends — success, stop, crash, or connection lost — the filter is popped and the prior macro state returns.

**Why this matters**: a typical script sends credentials with `sendLine(...)`. If you have an auto-trigger macro for `Password:`, the macro would also fire and write the password a second time, producing double-entry. Running a script with the default policy avoids this collision automatically.

**When to opt macros back in**: when your script deliberately leans on one — e.g. a "hostname-prompt" macro that fires every time the device prompts for its hostname, and you want that behaviour to keep working because your script doesn't know every hostname. Add `@allow-macros hostname-prompt` to the header.

---

## Input locking

By default the user can type in the terminal while a script is running. This is deliberate: it lets you intervene, copy output, send a Ctrl-C, etc.

If you want the terminal to be **read-only** for the duration of the run, add the `@lock-input` flag to the header:

```js
/**
 * @nexus-script
 * @name Hands-off procedure
 * @lock-input
 */
```

The first time the user presses a key during the locked period, the terminal shows a single explanatory line:

```text
[Nexus] Terminal is locked while a script is running. Stop the script to send input.
```

Subsequent keystrokes are silently dropped until the script ends. The lock is released automatically on every exit path.

The lock affects only the terminal UI — the script's own `send` / `sendLine` / `sendKey` calls always go through.

---

## Common recipes

### Retry with exponential back-off

See [`03-while-loop.js`](../examples/scripts/03-while-loop.js).

```js
for (let attempt = 0; attempt < 5; attempt++) {
  try {
    await sendLine("ping -c 1 target");
    const r = await expect(/(\d+)% packet loss/, { timeout: 5_000 });
    if (Number(r.groups[0]) === 0) break;
  } catch (err) {
    if (err.code !== "Timeout") throw err;
  }
  await sleep(500 * (attempt + 1));
}
```

### Wait for one of N prompts

See [`02-if-branching.js`](../examples/scripts/02-if-branching.js).

```js
const r = await waitAny([/password:/i, /passphrase:/i, /[$#] $/], { timeout: 15_000 });
if (r.index === 0) await sendLine(await prompt("Password", { password: true }));
if (r.index === 1) await sendLine(await prompt("Passphrase", { password: true }));
```

### Loop over a command list and capture each output

See [`04-for-loop.js`](../examples/scripts/04-for-loop.js).

```js
const results = {};
for (const cmd of ["hostname", "uptime", "uname -sr"]) {
  await sendLine(cmd);
  const m = await expect(/[$#] $/);
  results[cmd] = m.before.split("\n").slice(1).join("\n").trim();
}
```

### Wait through a reboot

See [`05-poll-for-prompt.js`](../examples/scripts/05-poll-for-prompt.js).

```js
await sendLine("reload");
await expect(/Proceed with reload/i);
await sendLine("");
await poll({
  send: "\r",
  until: /Press RETURN to get started/i,
  every: 2_000,
  timeout: 5 * 60_000
});
```

### Ask the user to do something physical

See [`06-interactive-flow.js`](../examples/scripts/06-interactive-flow.js).

```js
await alert("Insert USB stick with the image and click OK.");
await sendLine("dir usbflash0:");
```

### Branch on session metadata

```js
if (session.type === "serial") {
  // Serial: longer timeouts and poll harder.
  await poll({ send: "\r", until: /ROMMON>/i, every: 500, timeout: 20_000 });
} else {
  // SSH: we expect quick responses.
  await expect(/[$#] $/, { timeout: 5_000 });
}
```

---

## Settings

| Key | Type | Default | Notes |
|---|---|---|---|
| `nexus.scripts.path` | string | `.nexus/scripts` | Workspace-relative directory where scripts live. Created automatically on first script command. |
| `nexus.scripts.defaultTimeout` | number (ms) | `30000` | Default per-wait timeout when neither the script header nor the `opts.timeout` argument specifies one. |
| `nexus.scripts.macroPolicy` | `"suspend-all"` \| `"keep-enabled"` | `"suspend-all"` | Default macro policy while a script runs. |
| `nexus.scripts.maxRuntimeMs` | number (ms) | `1800000` (30 min) | Overall runtime cap. When a script exceeds this, it's stopped automatically and tagged with reason `max-runtime-exceeded`. Set `0` to disable. Minimum effective cap is 10 s. |

Settings changes take effect on the **next** script run — they don't retroactively alter runs already in flight.

---

## Commands and views

Registered under the `nexus.script.*` namespace and available in the Command Palette:

| Command | Default keybinding | What it does |
|---|---|---|
| `Nexus: Run Nexus Script` | `Ctrl+Alt+R` (macOS `⌘⌥R`) when an editor is focused on a `.js` file | Pick a script from a file dialog (or pass a URI argument from a CodeLens) and always show the session picker. |
| `Nexus: Quick Run in Active Terminal` | — | Bind the script to whichever Nexus terminal is currently focused — no picker. Falls back to the session picker if no terminal is focused or the focused terminal isn't a Nexus session. Wired to the sidebar's inline ▶ button. |
| `Nexus: Stop Nexus Script` | `Ctrl+Alt+S` (macOS `⌘⌥S`) when a script is running | Stop a running script. Prompts if more than one is running. |
| `Nexus: New Nexus Script` | — | Create a new script from a starter template in your configured scripts directory. |
| `Nexus: Edit Script` | — | Right-click a script → Edit. Opens the file in the editor. (Clicking the row no longer auto-opens the editor — it would be noisy.) |
| `Nexus: Delete Script` | — | Right-click a script in the sidebar. Asks for confirmation, then moves to Trash. |
| `Nexus: Open Scripts Folder` | — | Reveal the configured scripts directory in the OS file manager. |
| `Connect and Run Script…` (server / serial right-click) | — | Pick a Nexus script, connect to the profile, and run the script against the new session once it registers. Scripts are filtered to those whose `@target-type` is compatible with the profile. 90-second watchdog warns if the script never starts. |
| `Nexus: Show Nexus Scripts Output` | — | Open the **Nexus Scripts** Output Channel. |
| `Nexus: Open Scripting Guide` | — | Open this document in your browser. |
| `Nexus: Run Nexus Script on Target` | — | Internal variant (hidden from the Command Palette) taking `(uri, sessionId)` — used by the sidebar menu. |

**UI surfaces:**

- **Nexus sidebar → Scripts** — lists all `.js` files under the configured directory that carry the `@nexus-script` marker. Right-click any script for Run / Stop / Reveal / Delete. The view's title bar has a `+` button that runs `New Nexus Script`. Empty state (no folder / no scripts) shows inline help links.
- **Editor CodeLens** — the inline `▶ Run in Nexus` action at the top of any script file. Flips to `◼ Stop` while a run is active on that file. Works on `file://`, `vscode-remote://`, and `untitled:` schemes.
- **Status bar — run indicator** — when at least one script is running, the left status bar shows the current operation + elapsed time. Click to open the Output Channel. Tooltip contains a `◼ Stop` action per running script.
- **Status bar — input-lock indicator** — when an `@lock-input` script is running, a second left-aligned status bar item renders `$(lock) Terminal locked — click to stop`. Clicking stops the locking script. If multiple locked scripts run at once it shows a count and offers a QuickPick on click.
- **Output Channel** — the `Nexus Scripts` channel streams timestamped events. Lines are prefixed with `[hh:mm:ss.sss] ScriptName@SessionName` so you can correlate interleaved output when multiple scripts run at once.
- **Error toast** — if a script ends with an *unexpected* failure (syntax error, `TypeError`, worker crash — see **Error handling** above), VS Code surfaces an error toast with a **Show Output** button. Expected failures (`Timeout`, `ConnectionLost`, `Stopped`, `Cancelled`) don't toast.

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Script won't stop / runs forever | — | Open the Command Palette → `Nexus: Stop Nexus Script` (default `Ctrl+Alt+S` / `⌘⌥S`). The status bar tooltip also has a per-script ◼ Stop link. As a last resort, `nexus.scripts.maxRuntimeMs` (default 30 min) force-stops runaways automatically. |
| "▶ Run in Nexus" CodeLens doesn't appear above my file | Missing `@nexus-script` marker in the leading JSDoc block | Add it |
| Autocomplete is missing in my script | First-time scaffolding hasn't run yet | Trigger any Nexus script command once; reopen the file. If you edited `<scriptsDir>/types/nexus-scripts.d.ts` by hand, delete it — Nexus will rewrite it from the bundled version on the next run. |
| `expect` always times out | Pattern doesn't match the actual output (ANSI, anchors, banner noise) | Log `await tail()` in the `catch` to see what the session actually sent; tighten the pattern accordingly |
| First wait misses a prompt that's already on screen | Default lookback is 1 KB; output scrolled past | Pass `lookback: 4096` (or higher) on the first wait |
| A macro fires on top of my script and double-sends something | Default macro policy is `suspend-all`, but maybe `keep-enabled` was set | Check `nexus.scripts.macroPolicy` and any `@allow-macros` header |
| Stop button feels slow (>1 sec) | A native call is blocking the worker (rare) | Reload the window; if reproducible, file an issue |
| Web extension shows "not available in browser" | Expected — desktop-only for v1 | Use VS Code Desktop |
| `Nexus: New Nexus Script` says "open a folder" | No folder is open | Open a folder first — Nexus needs somewhere to create the file. (Running an *existing* script does not require an open folder.) |
| Error toast says the script "failed" on a normal `Timeout` | Shouldn't happen — expected codes are filtered | File an issue; include the Output Channel contents |

---

## Security and trust

**Scripts run with the same privileges as the Nexus Terminal extension.** Treat a `.js` file you're about to run the same way you'd treat a shell script or a PowerShell script someone sent you — open it and read it first.

- Scripts execute inside a `node:worker_threads` Worker thread (separate V8 isolate), **not** a full VS Code sandbox. They have full access to Node's `process` object, `globalThis`, and the Nexus script API. They cannot import `vscode`, read your workspace files, or spawn subprocesses — those capabilities are deliberately omitted from the global surface (see **Limitations**). But that isolation is a *convenience* for correctness and cheap termination, not a security boundary against hostile code.
- Secret prompts (`prompt(msg, { password: true })`) are masked in the input box and the returned value is never written to the Output Channel by the runtime. Anything the script explicitly logs — via `log.info(value)`, for example — is written verbatim, so don't hand-log the result of a password prompt.
- The runtime never reads your workspace outside the configured `nexus.scripts.path` directory (default `.nexus/scripts`). It does re-write the bundled `<scriptsDir>/types/nexus-scripts.d.ts` + `jsconfig.json` on first run and after version bumps. If you customise those files in place, your edits are preserved only until the bundled version string changes — then they're overwritten. Keep local customisations in separate files.

Bottom line: author your own scripts, or review scripts from others the same way you'd review a Bash script before running it.

---

## Limitations

- **Manual-only launch.** Scripts can't be auto-triggered from terminal output today — that's tracked for a future version because the target use cases (firmware changes, config pushes) are deliberately destructive and deserve human intent.
- **One script per session at a time.** Starting a second script on a busy session prompts you to stop the running one first. Running scripts on different sessions in parallel works fine.
- **Desktop only.** The web variant of Nexus Terminal shows a friendly "not available in browser" message instead of registering the commands.
- **No module imports.** Scripts are plain JavaScript executed in a Worker; `import` / `require` don't work. All API primitives are pre-injected as globals.
- **No process spawning.** The Worker sandbox doesn't expose `child_process` or other Node capabilities. If you need to run something locally before your procedure, do it in a separate terminal or a pre-step script.
- **No file I/O.** Use `prompt` / `confirm` / `alert` for human input; scripts can't read or write workspace files directly.

These constraints are intentional — they keep the surface small, the mental model simple, and the runtime safely killable. If you have a use case the current API can't express cleanly, open a GitHub issue with the procedure description.
