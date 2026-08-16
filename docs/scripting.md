# Nexus Scripts — User Guide

Nexus Scripts let you automate multi-step terminal procedures in plain JavaScript, with full editor support, running against any live SSH, Serial, or Local Shell session.

- [When to use a script (vs. a macro)](#when-to-use-a-script-vs-a-macro)
- [Quickstart](#quickstart)
- [Script examples](#script-examples)
- [Anatomy of a script](#anatomy-of-a-script)
- [Header fields](#header-fields)
- [Script API reference](#script-api-reference)
  - [Waiting for output](#waiting-for-output)
  - [Sending input](#sending-input)
  - [Polling](#polling)
  - [Interacting with the user](#interacting-with-the-user)
  - [Utility](#utility)
  - [Reading files — nexus.fs](#reading-files--nexusfs)
  - [Modular scripts — nexus.include](#modular-scripts--nexusinclude)
  - [Macro coordination](#macro-coordination)
  - [Session metadata](#session-metadata)
- [Error handling](#error-handling)
- [Match window semantics](#match-window-semantics)
- [Macro coordination in detail](#macro-coordination-in-detail)
- [Input locking](#input-locking)
- [Common recipes](#common-recipes)
- [Settings](#settings)
- [Organising scripts into folders](#organising-scripts-into-folders)
- [Commands and views](#commands-and-views)
- [Troubleshooting](#troubleshooting)
- [Security and trust](#security-and-trust)
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

A script is a regular `.js` file — kept either in your workspace (under version control) or in Nexus's global storage when no folder is open. Writing one looks and feels exactly like writing any other async JavaScript — except the globals `waitFor`, `expect`, `sendLine`, `poll`, `prompt`, etc. talk to the terminal for you.

---

## Quickstart

1. **(Optional) Open a folder in VS Code.** When a folder is open, scripts live under `<workspace>/.nexus/scripts/` so they can travel with your repo. With no folder open, Nexus transparently stores scripts in its extension global-storage folder instead — every script command (run, new, edit, "Connect and Run Script…") still works.
2. **Open at least one SSH, Serial, or Local Shell session** through the Nexus sidebar.
3. **Create a script** at `.nexus/scripts/hello.js` (or simply run `Nexus: New Nexus Script` — it writes to the resolved scripts directory wherever it lives):
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
4. **Run it** — any of several equivalent ways:
   - `Cmd/Ctrl+Shift+P` → **Nexus: Run Nexus Script** (always shows the session picker).
   - In the **Nexus** sidebar, expand **Scripts** and click the inline **▶** button. This "quick-run" binds to the terminal you currently have focused; if no Nexus terminal is focused it falls back to the picker.
   - Open `hello.js` in the editor and click the **▶ Run in Nexus** CodeLens above the header — always shows the picker.
   - Right-click a server, serial, or Local Shell profile → **Connect/Open and Run Script…** — picks a script, opens the profile, and runs it against the new session.

   The session picker always renders — even when only one session is eligible — so you can see which terminal the script will drive before it starts. Auto-pick only happens when the script's `@target-profile` uniquely matches an active session.

   For Local Shell profiles, the VS Code terminal-profile dropdown only includes profiles with an explicit executable path. Source/autodetect profiles are not script-capable through extensions; configure WSL as a custom Local Shell profile with `wsl.exe` as the shell path and any distribution arguments in the shell arguments field.
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

## Script examples

Browse [`examples/scripts/`](../examples/scripts/) for runnable scripts that demonstrate branching, loops, retries, polling, user interaction, and complete multi-step procedures. In VS Code, use **Nexus: Open Script Examples** or the examples icon in the **Scripts** view title bar.

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
| `@target-type` | `ssh`, `serial`, or `local` | unrestricted | Filters the session picker so only matching sessions are offered. |
| `@target-profile` | server name, serial profile name, Local Shell profile name, or matching id | none | When a session of this profile is active, it's auto-selected without showing the picker. Duplicate names are disambiguated with a narrowed picker. |
| `@default-timeout` | duration: `1500ms`, `30s`, `5m` | `nexus.scripts.defaultTimeoutSeconds` (30s) | Used by `waitFor`/`expect`/`waitAny` when no per-call `timeout` is provided. |
| `@lock-input` | flag — no value | absent (terminal stays interactive) | Makes the bound terminal read-only for the run. User keystrokes are discarded with a one-shot notice line. |
| `@allow-macros` | comma-separated macro names | `[]` | Names of macros to keep enabled on the bound session while the script runs. Default policy (suspend-all) suspends everything else. |

### Header validation

- Unknown `@<tag>` names produce a warning in the Output Channel — the script still loads.
- Invalid values for `@target-type` (not `ssh` / `serial` / `local`) or `@default-timeout` (not `<n>ms|s|m`) block the run with a descriptive error.
- Duplicate fields are tolerated: the first occurrence wins and a warning is logged — **except `@allow-macros`, which concatenates** so you can spread a long allow-list across multiple lines.
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
| `timeout` | `number` (ms) | `@default-timeout` header or `nexus.scripts.defaultTimeoutSeconds` setting | Upper bound on the wait. |
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

### Reading files — nexus.fs

`nexus.fs` is the supported way for a script to read files: read-only, scoped, size-capped, and every access is logged. It's the alternative to the unsupported `await import("node:fs")` path described in [Security and trust](#security-and-trust).

#### `nexus.fs.readText(path)` → `Promise<string>`

Read a UTF-8 text file. Throws on failure — see the error table below.

```js
const banner = await nexus.fs.readText("./banner.txt");
log.info(banner);
```

#### `nexus.fs.readJson<T>(path)` → `Promise<T>`

`readText` + `JSON.parse`. A malformed file throws a `SyntaxError` with `code: "InvalidJson"` whose message names the requested path. Defaults to `Promise<any>`, so property access on the result type-checks without a cast; pass a type argument for a typed result.

```js
const config = await nexus.fs.readJson("./devices.json");
for (const device of config.devices) {
  // ...
}
```

#### `nexus.fs.exists(path)` → `Promise<boolean>`

`true` for any entry at the scoped path — file or directory. An out-of-scope path **throws** rather than returning `false`: there's no existence oracle outside the scope, so `exists` and `readText` fail the same way for a path you shouldn't be probing. A probe the filesystem never answers throws too (see **Deadline** below), and so does one it *refuses* — no permission to look, an erroring or unavailable filesystem provider — which throws `ReadFailed`. Only a genuine "nothing is there" answers `false`, so `false` always means "checked, nothing there", never "couldn't tell".

```js
if (await nexus.fs.exists("./credentials.json")) {
  const creds = await nexus.fs.readJson("./credentials.json");
}
```

**Path resolution.** A relative path resolves against **this script's own directory** — not the current working directory, not the workspace root. A resolved path is legal if it lands inside either of two roots:

- the script's own directory (and its subtree), or
- the configured Nexus scripts folder (`nexus.scripts.path`, default `.nexus/scripts`) and its subtree — whether or not the script itself lives there.

Both `..` traversal and absolute paths are accepted, as long as the *result* lands inside one of those two roots — `nexus.fs.readText("../shared/vars.json")` is fine if `../shared` is still under the scripts folder. A script run from outside the scripts folder entirely (e.g. the editor CodeLens on an arbitrary `.js` file) can still read its own folder subtree and the scripts folder — just nothing else. An `untitled:` script (unsaved editor buffer) has no on-disk folder, so every `nexus.fs` call throws `NoScriptDir` until you save it.

**Limits.** Files over the configured read cap — `nexus.scripts.maxReadSizeMb`, default **4 MiB**, settable between 1 and 16 MiB — throw `FileTooLarge`, normally without the file being read at all, since the size is checked first. The cap is snapshotted when a run starts, so changing the setting doesn't move the limit under a script that is already running. A FileSystemProvider that misreports a file's size is still caught, just one step later, by a second check against the actual bytes read. Non-UTF-8 content throws `NotUtf8`.

**Deadline.** A `nexus.fs` call never blocks longer than **30 seconds**. The limit is fixed (not configurable) and covers the **whole call**, measured from the moment your script makes it: both `readText` (its stat + read) and `exists` (its stat), *and* any time spent waiting for a slot when several `nexus.fs` calls are in flight at once. Reads and existence probes are each throttled and bounded the same way, on separate pools — a fan-out of `exists()` calls never waits behind slow reads, and never consumes the reads' capacity either. A call that never gets a slot is bounded exactly like one whose provider never answers. When the limit expires — a hung remote filesystem provider, a `file:` path on a dead network mount; neither offers any way to cancel an in-flight call — the call throws `ReadFailed` with a message ending in `timed out after 30s`. A timeout is never reported as a missing file, an empty read, or a `false` from `exists()`: "I couldn't tell" and "it's definitely not there" justify opposite actions in a script, so they get different outcomes.

**Logging.** Every call — success or refusal — writes a line to the **Nexus Scripts** Output Channel with the resolved path (successes also include the byte count). The one exception is a call whose 30-second deadline fires *after* its run was already stopped — that run's log has ended, so the timeout isn't appended to it.

**Error codes:**

| `err.code` | Thrown by | When |
|---|---|---|
| `"NoScriptDir"` | any `nexus.fs.*` call | The script is an unsaved `untitled:` buffer with no folder on disk. |
| `"InvalidPath"` | any `nexus.fs.*` call | The path is empty, not a string, contains a NUL byte, or (Windows) is drive-relative (`"C:file.txt"`). |
| `"PathOutsideScope"` | any `nexus.fs.*` call | The resolved path lands outside both allowed roots. |
| `"FileNotFound"` | `readText` | Nothing exists at the path, or it's a directory. |
| `"FileTooLarge"` | `readText` | The file is bigger than the run's effective cap (`nexus.scripts.maxReadSizeMb`, default 4 MiB). `err.sizeBytes` / `err.maxBytes` carry the numbers — `sizeBytes` is a lower bound when the true size could not be determined (a file that grew mid-read, or a provider that under-reported it, reports the cap + 1). |
| `"NotUtf8"` | `readText` | The bytes aren't valid UTF-8. |
| `"ReadFailed"` | `readText`, `exists` | The path resolved and passed the size check, but the read (or `exists`'s probe) itself failed — permissions, a misbehaving remote filesystem provider — or the operation timed out (30 seconds; see **Deadline** above). A failed `exists` probe throws this rather than answering `false`. |
| `"InvalidJson"` | `readJson` | The file read fine but isn't valid JSON. A `SyntaxError`, not a plain `Error`. |

`exists()` throws `NoScriptDir` / `InvalidPath` / `PathOutsideScope` under the same conditions as `readText`, plus `ReadFailed` when its probe fails outright (permissions, a provider error) or exceeds the 30-second deadline. It returns a plain boolean only when the filesystem actually answered.

An uncaught `nexus.fs` error is **not** one of the [expected error codes](#error-handling) — it toasts, the same as a syntax error would. If your script wants to branch on "this file might not be there", use `exists()` or wrap the call in `try/catch`.

### Modular scripts — nexus.include

`await nexus.include(path)` loads another `.js` file as a module and resolves to its exports. It is the supported way to split a long script into files, and the alternative to the `import` / `require` statements that a script body cannot use.

```js
// .nexus/scripts/lib/helpers.js — a plain .js file, NO @nexus-script marker
exports.login = async (user) => {
  await sendLine(user);
  await expect(/Password: $/);
};
exports.VERSION = "1.0";
```

```js
/**
 * @nexus-script
 * @name deploy
 */
const helpers = await nexus.include("./lib/helpers.js");
await helpers.login("admin");
```

**Three ways to export**, in precedence order:

| The module does | `include()` resolves to |
|---|---|
| `module.exports = something` | `something` — a reassigned `module.exports` always wins |
| `exports.a = 1; exports.b = 2` | the exports object, `{ a: 1, b: 2 }` |
| `return { retry, backoff }` | the returned value — used **only** when `exports` was never touched and `module.exports` was never reassigned |
| none of the above | `{}` (never `undefined`) |

The `return` form works because a module body genuinely *is* an async function body here, the same as a script body. A module that both touches `exports` and returns something keeps the CommonJS meaning: the returned value is ignored.

**Relative paths resolve against the file they are written in.** This is the rule for `nexus.include` *and* for `nexus.fs` inside an included file — so `lib/helpers.js` doing `nexus.fs.readText("./banner.txt")` reads `lib/banner.txt`, and a library folder that ships its own data files works no matter which script includes it. Nesting works the same way: an included file may include its own siblings, up to 16 levels deep.

**What may be included:**

- The specifier must be an explicit path ending in `.js` — case-insensitive. There is no implicit extension, no `index.js` directory resolution, no `node_modules` lookup and no bare specifiers, so "why did it load *that* file" is never a question. Data files go through `nexus.fs.readText` / `nexus.fs.readJson`; asking `include` for one throws `InvalidPath` and says so.
- **A library must not carry `@nexus-script`.** That marker means "entry point" — it is what the Scripts view, the CodeLens and the picker key on — so including a marked file throws `IncludeIsScript`. The flip side is the useful half: an unmarked `.js` file next to your scripts never appears in the Scripts view, the CodeLens or any picker. Nothing else is needed to keep libraries out of the UI.
- Header directives inside an included file (`@lock-input`, `@allow-macros`, `@target-type`, `@default-timeout`) are **never** honoured. Only the entry script's header is parsed; an included file must not be able to unlock the terminal or re-enable macros behind the entry script's back.
- Inside an included file, `module`, `exports` and `nexus` are function parameters — don't re-declare them with `const`/`let` (a `var` is fine). Doing so is a compile error (`Identifier 'nexus' has already been declared`) with no line number, like any syntax error. This matters when moving code out of an entry script, where `const nexus = …` is legal shadowing.
- Containment is unchanged: the resolved path must land inside the scripts folder or the entry script's own folder, exactly like `nexus.fs`. An `untitled:` (unsaved) script has no folder, so every include throws `NoScriptDir`.

**Loaded once per run.** Modules whose source was delivered are loaded at most once per run — later includes of the same file (however they spell the path) get back the *same* exports object, and compile or body failures are sticky: a module that threw keeps throwing the same error rather than half-running again. Refusals are different: a cycle, a missing file, a marked script or a path outside scope is re-evaluated (and re-read) on every call, so fixing the file and calling again works. Two includes of the same not-yet-loaded module — from `Promise.all`, or from two libraries reaching one helper — share a single read and a single execution.

Caching is per **run**, never per session: the edit → run loop always picks up your latest saved library code. Note the word *saved* — unlike the entry script, whose unsaved editor buffer is used when you run from the CodeLens, an included file is always read from disk. Save your libraries before running.

**Cycles are refused, not partially resolved.** If `a.js` includes `b.js` which includes `a.js`, the include throws `CircularInclude` with the loop spelled out — `main.js → lib/a.js → lib/b.js → lib/a.js` — in both the message and `err.cycle`. (CommonJS would hand back a half-built exports object; in an async module system the ancestor has not finished awaiting, so what you would get is arbitrarily incomplete.) A **diamond** is not a cycle: two different modules may both include the same helper, and they share one instance of it.

One shape the runtime cannot detect for you: if a module's body includes a module that is *itself still executing its body* (not a static cycle — the chain does not show it), the second include waits for an evaluation that is waiting for it, and the run hangs until `nexus.scripts.maxRuntimeSeconds` stops it. Keep top-level module bodies to definitions and cheap setup.

**Limits and cost.** Max 16 levels of nesting (`IncludeDepthExceeded`) and 64 distinct modules per run (`IncludeLimitExceeded`) — both far past any real layering, and both refused before the file is read. A run may also load at most **48 MiB of combined module source** in total, refused with `IncludeLimitExceeded` (`err.totalBytes`, `err.maxTotalBytes`) before the worker is ever handed the overage — the module count alone cannot bound memory, since each module may be as large as `nexus.scripts.maxReadSizeMb` allows, and that per-file cap still governs each file on its own. An include is a file read, so it shares everything `nexus.fs` reads have: the same effective size cap (`nexus.scripts.maxReadSizeMb`), the same UTF-8 requirement, the same fixed 30-second deadline, and the same read pool — an include can queue behind a `readText` fan-out, bounded by that same 30 seconds.

**Every load is logged** to the Nexus Scripts Output Channel, naming what you asked for and what it resolved to:

```
include ./lib/helpers.js → lib/helpers.js (1234 bytes)
include ./helpers.js → lib/helpers.js (cached)
include ./lib/a.js → CircularInclude (main.js → lib/a.js → lib/b.js → lib/a.js)
include ./tools.js → IncludeIsScript
include ./x.js → IncludeDepthExceeded (17 > 16)
```

**Error codes** (`nexus.fs`'s codes apply too — an include is a scoped file read):

| `err.code` | When | Extra fields |
|---|---|---|
| `"CircularInclude"` | The module is already on the chain including it | `cycle: string[]` |
| `"IncludeDepthExceeded"` | More than 16 levels of nesting | `depth`, `maxDepth` |
| `"IncludeLimitExceeded"` | More than 64 distinct modules in one run, or more than 48 MiB of combined module source | `count`, `maxModules` (count budget) / `totalBytes`, `maxTotalBytes` (source budget) |
| `"IncludeSyntaxError"` | The module's source does not parse | `module` |
| `"IncludeIsScript"` | The target carries `@nexus-script` | `module` |
| `"IncludeInternal"` | A protocol violation inside the runtime — please file an issue | — |
| `"InvalidPath"` | Not a `.js` path, empty, or otherwise unusable | — |
| `"PathOutsideScope"` / `"FileNotFound"` / `"FileTooLarge"` / `"NotUtf8"` / `"NoScriptDir"` / `"ReadFailed"` | As for `nexus.fs` — see the table above | — |

A module body that **throws** does not get an include code: its own error propagates unwrapped, so `err.code` and the stack are the module's own.

**File names and line numbers in stacks.** An uncaught error — from the entry script or from any included file — reports the real file name and the real line in the Output Channel (which the failure toast's **Show Output** button opens) and in `log.error(err)`. Two honest limits:

- **A syntax error has no line.** V8 reports no location at all when a script or module fails to compile, so the message names the file (`Failed to compile lib/helpers.js: Unexpected token ';'`) and stops there. Your editor's own diagnostics are the line-level answer.
- **A stack the script reads itself is not corrected.** `err.stack` inside a `catch` names the right file, but its line numbers are 2 higher than the file's (the runtime's own function wrapper). Pass the error to `log.error(err)` — or let it propagate — to get the corrected form.

**Module identity is the spelled path, not the inode.** On Windows, `./Lib.js` and `./lib.js` are the same module; everywhere else they are two — including on a **case-insensitive macOS volume** (APFS's default), where the disk would serve one file for both spellings but the include cache keeps them distinct, so the file's body runs twice and each spelling gets its own exports object. The same happens on a **remote Windows** host (remote path handling is always POSIX, because a URI carries no way to know the far host's OS) and for two **symlinked paths** to one file. Identity is deliberately lexical — no `stat` or `realpath` inside the cache and cycle checks, which also means no way to probe the volume's case behaviour — so the rule to remember is simply: **include each file by one spelling**. Double-loading is bounded like everything else (both spellings count against the module and byte budgets) and cannot affect containment.

**IntelliSense across files.** Every file — script or library — gets full API IntelliSense. What is *not* inferred automatically is the shape of a library's exports: `nexus.include()` is typed `Promise<any>`, and the `moduleDetection: force` setting that makes top-level `await` legal in every script also stops TypeScript from treating your libraries as modules to infer from. Two one-line opt-ins recover it:

```js
/** @type {typeof import("./lib/helpers.js")} */
const helpers = await nexus.include("./lib/helpers.js");
// helpers.login is now fully typed, and a typo in the name is an error

/** @type {import("./lib/helpers.js").DeviceInfo} */
const info = { hostname: "r1", uptimeSeconds: 5 };   // a @typedef exported by the library
```

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
| `session.type` | `"ssh" \| "serial" \| "local"` | Transport type. |
| `session.name` | `string` | Terminal title (display name). |
| `session.targetId` | `string` | Server id (for SSH), serial profile id (for serial), or Local Shell profile id (for local). |

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
| `"NoScriptDir"` / `"InvalidPath"` / `"PathOutsideScope"` / `"FileNotFound"` / `"FileTooLarge"` / `"NotUtf8"` / `"ReadFailed"` / `"InvalidJson"` | `nexus.fs.*` | See [Reading files — nexus.fs](#reading-files--nexusfs) for the full table. These are **not** silent expected codes — uncaught, they toast just like any other bug. |

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

If you want to shut a script down from the host side (e.g. a deploy pipeline's watchdog), call the `Nexus: Stop Nexus Script` command or rely on the workspace setting `nexus.scripts.maxRuntimeSeconds` — a default 30-minute overall cap that force-stops runaway scripts. Set it to `0` to disable the cap. The legacy `nexus.scripts.maxRuntimeMs` setting is still read when the seconds setting is absent.

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
} else if (session.type === "local") {
  // Local Shell: use local commands and paths.
  await expect(/[$#>] $/, { timeout: 10_000 });
  await sendLine("pwd");
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
| `nexus.scripts.defaultTimeoutSeconds` | number (seconds) | `30` | Default per-wait timeout when neither the script header nor the `opts.timeout` argument specifies one. The legacy `nexus.scripts.defaultTimeout` millisecond key is still read when the seconds setting is absent. |
| `nexus.scripts.macroPolicy` | `"suspend-all"` \| `"keep-enabled"` | `"suspend-all"` | Default macro policy while a script runs. |
| `nexus.scripts.maxReadSizeMb` | number (MiB) | `4` | Largest file `nexus.fs.readText` / `nexus.fs.readJson` will read; bigger files throw `FileTooLarge`. Range 1–16 MiB; values outside that range are clamped to the nearest bound, while non-numeric, zero, or negative values fall back to 4 MiB. Snapshotted when a run starts, so a change never applies to a script already running. |
| `nexus.scripts.maxRuntimeSeconds` | number (seconds) | `1800` (30 min) | Overall runtime cap. When a script exceeds this, it's stopped automatically and tagged with reason `max-runtime-exceeded`. Set `0` to disable. Positive values below 10 s are raised to the minimum effective cap; values above `2147483` are clamped to the largest safe timer delay. |
| `nexus.scripts.maxRuntimeMs` | number (ms) | `1800000` (30 min) | Legacy compatibility setting read only when `maxRuntimeSeconds` is absent. Values above `2147483647` are rejected/clamped. |

Settings changes take effect on the **next** script run — they don't retroactively alter runs already in flight.

---

## Organising scripts into folders

The scripts directory is a real filesystem folder, so the Scripts view mirrors
whatever directory structure you put under it — subfolders show up, in any
depth, whether or not they contain a script. Folders are yours to create — an
empty folder stays until you remove it.

- **New Script** accepts a `/`-separated path (e.g. `cisco/backup`), and
  creates any missing intermediate folders for you. A folder's right-click
  menu also has its own **New Script**, which pre-fills that folder as a
  prefix so you only type the leaf name.
- **New Folder** — the view's title bar button, or a folder's right-click
  menu for a nested folder — creates a real directory. It shows up
  immediately, even before you put anything in it.
- A folder's right-click menu also has **Reveal in Explorer**, which reveals
  that directory in VS Code's own Explorer view (not your OS file manager —
  use **Open Scripts Folder**, below, for that).
- Path segments are validated the same way folders are validated everywhere
  else in Nexus: `.` and `..` are rejected, depth is capped at 10 levels, and
  a `\` is rejected outright with a message telling you to use `/` instead —
  typing `cisco\backup` (a natural mistake on Windows) does not silently
  create a folder literally named `cisco\backup`, nor does it let a path like
  `../../../home/you/startup` escape the scripts directory.
- The Scripts view has its own `$(refresh)` **Refresh Scripts** button. Under
  the hood it also refreshes on its own when the scripts directory changes on
  disk — Nexus watches every file and folder in it, debounced by about
  300ms so a burst of saves or a directory rename only triggers one rescan.
- **Symlinked folders are listed but not watched.** If a folder inside your
  scripts directory is a symlink (or a Windows junction) pointing somewhere
  else, Nexus scans through it and shows the scripts inside — but VS Code's
  file watcher does not follow links nested inside the folder it watches, and
  offers no way to make it. So edits, additions and deletions made *in the
  link's target* do not refresh the view on their own. Such folders are drawn
  with a link icon and say so on hover; press **Refresh Scripts** to pick up
  changes. Running a script is unaffected, and **Connect and Run Script…**
  always rescans, so it never shows a stale list.
- **Scan limits.** To keep a misconfigured `nexus.scripts.path` (e.g.
  pointing at your whole home directory) from hanging the sidebar, the scan
  stops after 10 levels of nesting or 500 examined entries — every directory
  and file counts against that budget, `.js` scripts included. If the limit
  is hit, a "Stopped after 500 entries — some scripts may be hidden" row
  pins to the very top of the Scripts view; clicking it opens the
  `nexus.scripts.path` setting so you can point Nexus at a narrower folder.
  A folder nested more than 10 levels deep is a separate case: it still
  shows up in the tree, but Nexus doesn't look inside it, so a script
  placed there won't appear in the Scripts view or any picker. A "Some
  folders are nested deeper than 10 levels — scripts inside may be hidden"
  row pins near the top of the Scripts view whenever this happens.
  **Connect and Run Script…** says the same thing, because it runs the same
  bounded scan: if a limit was hit it appends the reason to the picker's
  placeholder, or — when the truncated scan matched nothing at all — to the
  "no scripts" message, so a scan that merely stopped looking is never
  reported as "there are none".
- **Names the Scripts view can't show are rejected up front.** Folders
  starting with `.`, anything called `node_modules`, and a top-level `types`
  folder are skipped by the scan (see the troubleshooting table below), so
  **New Folder** and **New Script** refuse them rather than creating a real
  directory that never appears — and that then reports "already exists" the
  next time you try. A `types` folder that isn't at the top level, like
  `cisco/types`, is fine.

## Commands and views

Registered under the `nexus.script.*` namespace and available in the Command Palette:

| Command | Default keybinding | What it does |
|---|---|---|
| `Nexus: Run Nexus Script` | `Ctrl+Alt+R` (macOS `⌘⌥R`) when an editor is focused on a `.js` file | Pick a script from a file dialog (or pass a URI argument from a CodeLens) and always show the session picker. |
| `Nexus: Quick Run in Active Terminal` | — | Bind the script to whichever Nexus terminal is currently focused — no picker. Falls back to the session picker if no terminal is focused or the focused terminal isn't a Nexus session. Wired to the sidebar's inline ▶ button. |
| `Nexus: Stop Nexus Script` | `Ctrl+Alt+S` (macOS `⌘⌥S`) when a script is running | Stop a running script. Prompts if more than one is running. |
| `Nexus: New Nexus Script` | — | Create a new script from a starter template in your configured scripts directory. Accepts a `/`-separated path (`cisco/backup`) to create it inside a folder, creating missing intermediate folders. |
| `Nexus: New Script Folder` (Scripts view title bar, or a folder's right-click menu) | — | Create a real directory under the scripts folder. Shows up immediately, even while empty. |
| `Nexus: Refresh Scripts` | — | Manually rescan the scripts directory, bypassing the ~300ms watcher debounce. |
| `Nexus: Edit Script` | — | Right-click a script → Edit. Opens the file in the editor. (Clicking the row no longer auto-opens the editor — it would be noisy.) |
| `Nexus: Delete Script` | — | Right-click a script in the sidebar. Asks for confirmation, then moves to Trash. |
| `Nexus: Open Scripts Folder` | — | Open the configured scripts directory in the OS file manager. (Before 2.8.77 it opened the *parent* directory instead — see below.) |
| `Connect/Open and Run Script…` (server, serial, or Local Shell right-click) | — | Pick a Nexus script, open the profile, and run the script against the new session once it registers. Scripts are filtered to those whose `@target-type` is compatible with the profile. SSH and Serial use a 90-second watchdog; Local Shell starts the run after the terminal session is created. |
| `Nexus: Show Nexus Scripts Output` | — | Open the **Nexus Scripts** Output Channel. |
| `Nexus: Open Scripting Guide` | — | Open this document in your browser. |
| `Nexus: Open Script Examples` | — | Open the bundled script examples in your browser. |

**UI surfaces:**

- **Nexus sidebar → Scripts** — mirrors the folder structure under the configured scripts directory: subfolders render as folders (whether or not they hold a script), sorted ahead of scripts, both alphabetically. Only `.js` files that carry the `@nexus-script` marker show as script rows; a folder's own right-click menu adds New Script (into that folder), New Folder, and Reveal in Explorer. Clicking a script row does **nothing by default** (prevents accidental editor churn); use the right-click menu for Edit / Run / Stop / Reveal / Delete, or the inline **▶** button for quick-run. **Drag a script onto a folder to move it there** — onto another script to put it in that script's folder, or onto empty space to move it back to the root. Since a folder here is a real directory, the drop renames the file, so an editor you have open on it follows along and Undo puts it back. Nexus refuses and tells you why in three cases: the script is running (stop it first — a running script is tracked by its path), a file of the same name is already in the target folder (nothing is ever overwritten), or the file is not inside the scripts folder. Folders themselves are not draggable, and one script moves per drag. The view's title bar has buttons for New Script, New Folder, Refresh Scripts, Open Scripts Folder, Open Scripting Guide, and Open Script Examples. The three-link empty state (New Script / Open Scripting Guide / Open Script Examples) shows only when there isn't a single marked script anywhere in the tree, and only at the root — a folder with no scripts of its own just renders empty, the same as any empty folder in a file explorer.
- **Editor CodeLens** — the inline `▶ Run in Nexus` action at the top of any script file. Flips to `◼ Stop` while a run is active on that file. Works on `file://`, `vscode-remote://`, and `untitled:` schemes. Always shows the session picker (the editor context is "I'm authoring" — deliberate target choice).
- **Nexus Settings panel → Scripts** — the same four settings as in `Settings` below, surfaced in the Nexus Settings panel webview (no need to open `settings.json`).
- **Connectivity Hub right-click → Connect/Open and Run Script…** — available on SSH, serial, and Local Shell profile items. Picks a compatible script (filtered by `@target-type`), opens the profile, then auto-runs the script once the session registers.
- **Status bar — run indicator** — when at least one script is running, the left status bar shows the current operation + elapsed time. Click to open the Output Channel. Tooltip contains a `◼ Stop` action per running script.
- **Status bar — input-lock indicator** — when an `@lock-input` script is running, a second left-aligned status bar item renders `$(lock) Terminal locked — click to stop`. Clicking stops the locking script. If multiple locked scripts run at once it shows a count and offers a QuickPick on click.
- **Output Channel** — the `Nexus Scripts` channel streams timestamped events. Lines are prefixed with `[hh:mm:ss.sss] ScriptName@SessionName` so you can correlate interleaved output when multiple scripts run at once.
- **Error toast** — if a script ends with an *unexpected* failure (syntax error, `TypeError`, worker crash — see **Error handling** above), VS Code surfaces an error toast with a **Show Output** button. Expected failures (`Timeout`, `ConnectionLost`, `Stopped`, `Cancelled`) don't toast.

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Script won't stop / runs forever | — | Open the Command Palette → `Nexus: Stop Nexus Script` (default `Ctrl+Alt+S` / `⌘⌥S`). The status bar tooltip also has a per-script ◼ Stop link. As a last resort, `nexus.scripts.maxRuntimeSeconds` (default 30 min, `0` disables) force-stops runaways automatically. The legacy `nexus.scripts.maxRuntimeMs` setting is still honored when seconds is not configured. |
| "▶ Run in Nexus" CodeLens doesn't appear above my file | Missing `@nexus-script` marker in the leading JSDoc block | Add it |
| Autocomplete is missing in my script | First-time scaffolding hasn't run yet | Trigger any Nexus script command once; reopen the file. If you edited `<scriptsDir>/types/nexus-scripts.d.ts` by hand, delete it — Nexus will rewrite it from the bundled version on the next run. |
| `expect` always times out | Pattern doesn't match the actual output (ANSI, anchors, banner noise) | Log `await tail()` in the `catch` to see what the session actually sent; tighten the pattern accordingly |
| First wait misses a prompt that's already on screen | Default lookback is 1 KB; output scrolled past | Pass `lookback: 4096` (or higher) on the first wait |
| A macro fires on top of my script and double-sends something | Default macro policy is `suspend-all`, but maybe `keep-enabled` was set | Check `nexus.scripts.macroPolicy` and any `@allow-macros` header |
| Stop button feels slow (>1 sec) | A native call is blocking the worker (rare) | Reload the window; if reproducible, file an issue |
| Web extension shows "not available in browser" | Expected — desktop-only for v1 | Use VS Code Desktop |
| Can't find where my scripts are stored without a workspace | No folder is open — Nexus uses the extension's global-storage folder | Run `Nexus: Open Scripts Folder` (or check `nexus.scripts.path` — absolute paths always win). |
| Error toast says the script "failed" on a normal `Timeout` | Shouldn't happen — expected codes are filtered | File an issue; include the Output Channel contents |
| A library file I only meant to `include` shows up in the Scripts view (or the ▶ CodeLens, or a picker) | It carries the `@nexus-script` marker, which means "entry point" | Remove the marker from the library. Unmarked `.js` files never appear in the Scripts view, the CodeLens or any picker — and only unmarked files can be included (`IncludeIsScript` otherwise) |
| `CircularInclude: main.js → lib/a.js → lib/b.js → lib/a.js` | Two modules include each other | Hoist the part they share into a third module that neither of them includes back. Partial exports are deliberately not offered — in an async module system the half-built object you would get back is arbitrarily incomplete |
| `IncludeSyntaxError` … `Identifier 'nexus' has already been declared` (or `'module'` / `'exports'`) | Inside an included file those three names are function parameters — a `const`/`let` re-declaration is a compile error there, even though it is legal shadowing in an entry script | Rename the local, or drop the declaration and use the parameter directly |
| `ReferenceError: exports is not defined` in a script I ran directly | `module` / `exports` exist only inside a file loaded by `nexus.include()`. An entry script is *run*, not imported | Move the reusable part into an included file and `nexus.include()` it. (The declarations type-check everywhere, so the editor will not flag this — the failure is at runtime, on purpose: silently discarding the assignment would be worse) |
| `helpers.something` has no autocomplete after `nexus.include()` | `include()` is typed `Promise<any>`; the shape of a library is not inferred automatically | Add one line above the call: `/** @type {typeof import("./lib/helpers.js")} */`. See [Modular scripts](#modular-scripts--nexusinclude) |
| An included library reads the wrong data file | A relative path resolves against **the file it is written in**, not the entry script | That is the rule — move the data file next to the library, or pass the path in from the entry script |
| A script hangs and only `maxRuntimeSeconds` stops it, with an include in the chain | A module's body included a module that was itself still executing its body — each waits for the other | Keep top-level module bodies to definitions and cheap setup; do the work in exported functions |
| A folder named `types` at the top level of my scripts folder doesn't appear in the sidebar at all | The generated `types/` at the *root* of the scripts directory (`<scriptsDir>/types/nexus-scripts.d.ts` + `jsconfig.json`) is intentionally hidden from the tree — it's Nexus's own scaffolding, not yours | Only the root-level `types/` is hidden. A `types/` folder anywhere else — e.g. `cisco/types/probe.js` — is a normal folder and shows its scripts like any other |
| Some scripts or folders seem to be missing from a very large or deeply nested scripts directory | The scan stops after 10 levels of nesting or 500 examined directories/files (scripts included), to keep a misconfigured `nexus.scripts.path` from hanging the sidebar | Point `nexus.scripts.path` at a narrower folder — click the "Stopped after 500 entries" row pinned at the top of the Scripts view to jump straight to that setting |
| The Scripts view shows a single "Scanning scripts…" row | The folder is changing faster than it can be listed (a bulk checkout, a sync client, or repeatedly switching `nexus.scripts.path`). Rather than show you the previous folder's contents as if they were current, the view says so | Nothing — it repaints itself once the folder settles. Clicking the row forces a refresh if you'd rather not wait |

---

## Security and trust

**Scripts run with the same privileges as the Nexus Terminal extension.** Treat a `.js` file you're about to run the same way you'd treat a shell script or a PowerShell script someone sent you — open it and read it first.

- Scripts execute as local Node code inside a `node:worker_threads` Worker thread (separate V8 isolate), **not** a full VS Code sandbox. They have full access to Node's `process` object, `globalThis`, and the Nexus script API. They cannot import the `vscode` API. **Everything else a Node process can do, a script can do**: `await import("node:fs")` and `await import("node:child_process")` work, so a script can read or write any file your user account can and spawn processes. The worker is a cheap-termination mechanism, not a sandbox — only run scripts you have read and trust. `nexus.fs` is the *supported* way to read files: it is read-only, scoped to the scripts folder and the script's own directory, capped at a configurable size (`nexus.scripts.maxReadSizeMb`, default 4 MiB), and every access is logged to the Nexus Scripts Output Channel. Direct Node imports are possible but unsupported — no compatibility promises, and stopping a script (`worker.terminate()`) does **not** kill child processes the script spawned.
- **`nexus.include()` is a module loader, not a security boundary.** An included file runs in the same isolate, with the same privileges, as the script that included it — it can do anything the entry script can. What include *does* enforce is where files come from: only `.js` files inside the scripts folder or the entry script's own folder, each one logged to the Output Channel as it loads. Read a library before you include it, the same as you would read a script before you run it.
- Secret prompts (`prompt(msg, { password: true })`) are masked in the input box and the returned value is never written to the Output Channel by the runtime. Anything the script explicitly logs — via `log.info(value)`, for example — is written verbatim, so don't hand-log the result of a password prompt.
- On a script's behalf, the runtime reads files only through `nexus.fs`, which refuses paths outside the scripts folder / the script's own folder and logs every read. It does re-write the bundled `<scriptsDir>/types/nexus-scripts.d.ts` + `jsconfig.json` on first run and after version bumps. If you customise those files in place, your edits are preserved only until the bundled version string changes — then they're overwritten. Keep local customisations in separate files.
- **Scripts refuse to start in Restricted Mode.** Nexus Terminal declares `capabilities.untrustedWorkspaces.supported: false` and additionally hard-refuses every script-start command when `vscode.workspace.isTrusted === false`, with a **Manage Workspace Trust** button in the error message. Trust the workspace first.

Bottom line: author your own scripts, or review scripts from others the same way you'd review a Bash script before running it.

---

## Limitations

- **Manual-only launch.** Scripts can't be auto-triggered from terminal output today — that's tracked for a future version because the target use cases (firmware changes, config pushes) are deliberately destructive and deserve human intent.
- **One script per session at a time.** Starting a second script on a busy session prompts you to stop the running one first. Running scripts on different sessions in parallel works fine.
- **Desktop only.** The web variant of Nexus Terminal shows a friendly "not available in browser" message instead of registering the commands.
- **No static `import` declarations.** The script body runs as an async function body; a top-level `import`/`require` statement doesn't work. To split a script across files, use [`nexus.include()`](#modular-scripts--nexusinclude) — and note that an included file is always read from disk, so **save your library files before running**; unsaved editor changes are picked up for the entry script only. Dynamic `await import(...)` of Node builtins technically works but is unsupported — see [Security and trust](#security-and-trust).
- **File access.** `nexus.fs` provides supported, read-only, scoped, logged reads; there is no write API. Anything beyond that runs with your full user permissions and is on you.

If you have a use case the current API can't express cleanly, open a GitHub issue with the procedure description.
