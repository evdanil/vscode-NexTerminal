# Nexus Terminal Macro Guide

Macros send saved text to a Nexus terminal. They are useful for commands you
type often, login prompts, confirmation prompts, and simple expect/send
automation that does not need a full script.

## Quick Start: Your First Macro

1. Open the Nexus sidebar.
2. Open **Terminal Macros**.
3. Select **Add Macro From Template**.
4. Choose **Send command**.
5. Edit the name and text if you want.
6. Connect to an SSH or Serial profile.
7. Select the macro's play button in the Macros view.

The template includes a trailing newline, so running it sends the command and
presses Enter.

## Blank Macros vs Template Macros

Use **Add Macro From Template** when you are learning macros or want a safe
starting point. Templates fill in common fields such as newline handling,
secret storage, trigger patterns, and trigger scope.

Use **Add Blank Macro** when you already know the exact text and options you
want. A blank macro starts with no auto-trigger behavior, so it only runs when
you run it manually or assign a shortcut.

Built-in templates include:

- **Send command**: sends a normal command to the active terminal.
- **Send password when prompted**: creates a secret active-session trigger with
  no sample password stored.
- **Wait and send confirmation**: sends `yes` when a confirmation prompt
  appears.
- **Scoped auto-trigger example**: shows a prompt-triggered command that starts
  paused until you resume it.

## Sending Text and Newlines

Macro text is sent exactly as saved. In examples, `\n` means an actual newline.
In the Macro Editor, press Enter to create that newline; typing `\n` sends
those two characters.

- `show version` followed by a new line sends `show version` and presses Enter.
- `configure terminal` followed by a new line and then `interface gi0/1` sends
  two commands when each line ends with Enter.
- `admin` sends `admin` without pressing Enter.
- A blank line in the editor is also sent as a newline.

For prompts such as usernames, passwords, and confirmations, include a newline
when the remote side expects Enter after the response.

## Secret Macros

Secret macros store their text in VS Code SecretStorage instead of the normal
macro metadata store. They are intended for values such as passwords, tokens, or
enable secrets.

Protected:

- The macro text is stored through VS Code SecretStorage.
- The Macros view does not show the secret value.
- Copying all macros as JSON redacts secret text.

Not protected:

- The macro name, trigger pattern, trigger scope, profile match, keybinding, and
  other metadata are not secret.
- **Copy Value** writes the secret to the operating system clipboard as plain
  text.
- Running the macro sends the secret to the terminal session and the remote
  host.
- If the remote system echoes the secret, terminal output, scrollback, logs, or
  transcript files may contain it.
- Anyone with access to the VS Code profile, SecretStorage backend, terminal
  session, clipboard, or remote host may be able to access the value.

For secret auto-triggers, prefer **Active session** or **Matching profile** scope
instead of **All terminals**.

A host or background session can trigger a secret macro by printing text that
matches the pattern. For passwords and tokens, use **Active session** or
**Matching profile**, keep the regex narrow, and avoid **All terminals**.

## Keybindings

Use **Assign Shortcut** from a macro's context menu to choose a shortcut. Nexus
supports these forms:

- `alt+m`
- `alt+shift+5`
- `ctrl+shift+a`

Keys can use A-Z or 0-9. If you assign a shortcut already used by another macro,
Nexus moves the shortcut to the new macro.

Macros without shortcuts are still available from the macro picker with
`Alt+S`.

If VS Code or the integrated terminal intercepts macro shortcuts, run
**Nexus: Fix Macro Keybindings** from the Command Palette.

## Auto-Trigger Basics

Add a **Trigger Pattern** to make a macro run when terminal output matches a
regular expression. Nexus watches SSH and Serial terminal output, removes ANSI
escape codes and most control characters, keeps a bounded tail buffer, and tests
the trigger pattern against that buffer.

Enter only the JavaScript regex pattern, without surrounding slashes or flags.
Use `[Pp]assword:\s*$`, not `/password:\s*$/i`. Macro triggers do not have a
separate flags field.

Rules to keep in mind:

- A pattern must not match the empty string.
- Nexus rejects patterns that can match an empty string, are longer than the
  allowed limit, or use risky shapes such as nested quantifiers like `(.*)+` or
  repeated alternation like `(yes|no)*`.
- Matching text is removed from the buffer after a match, even if cooldown stops
  the macro from firing. This prevents one prompt from repeatedly retriggering
  the same macro.
- Global auto-trigger behavior is controlled by
  `nexus.terminal.macros.autoTrigger`.

## Trigger Scope

Each auto-trigger can be scoped.

**All terminals**

The current default when no explicit trigger scope is set, kept for compatibility
with older macros. Any Nexus terminal output can match the pattern. Use this for
harmless, broad helpers only. For passwords, tokens, and other sensitive
responses, choose **Active session** or **Matching profile** instead.

**Active session**

The macro only matches the terminal that is currently active. This is safer for
passwords and prompts because it reduces the chance that a background session
receives input.

**Matching profile**

The macro only matches sessions opened from the selected profile. This is useful
when a prompt or command is specific to one device type, lab, or host.

## Profile Matching

Choose **Matching profile** in the Macro Editor, then select the profile. Nexus
stores the profile id with the macro. During auto-trigger evaluation, the macro
only runs when the terminal session's profile id matches that stored id.

If the profile is deleted or the macro has no stored profile id, the trigger
does not run in **Matching profile** scope. Reopen the macro and select the
profile again.

## Cooldown vs Interval

Cooldown and interval solve different problems.

**Cooldown** is for normal prompt-response macros. After the macro fires, the
same macro cannot fire again on that terminal until the cooldown has elapsed.
If another match appears during cooldown, Nexus ignores that match and does not
schedule a delayed retry.

Example: a password macro has `triggerCooldown: 5`. It fires at `12:00:00`.
Another `Password:` prompt arrives at `12:00:02`; it is ignored. A later prompt
at `12:00:06` can fire.

**Interval** is for prompt-gated polling. When the trigger pattern matches,
Nexus sends the macro once. Later matches on the same session send immediately
if the interval has elapsed, or wait until it has. Nexus does not send again
until the pattern matches again. For interval macros, the interval controls the
next matched prompt; `triggerCooldown` does not control that cadence.

Example: a macro has pattern `router#\s*$`, text `show clock\n`, and
`triggerInterval: 10`. When the active terminal shows `router#`, Nexus sends
`show clock\n` immediately. If another `router#` prompt appears 10 seconds or
more after that send, Nexus sends again immediately. If the prompt appears
sooner, Nexus waits until the 10-second interval has elapsed, then sends once.

Interval ownership matters. The terminal that first matches the interval macro
owns delayed sends for that macro. Ownership continues even if focus changes,
until you pause the macro, disconnect the session, dispose the terminal
observer, edit the macro so the interval no longer applies, or otherwise clear
the interval state.

Use interval macros carefully. A broad shell prompt pattern with a short interval
can create noisy command loops.

## Pause and Resume

Use **Pause Auto-Trigger** and **Resume Auto-Trigger** from the Macros view.

For regular auto-triggers, pausing prevents matches from firing. Resuming
reevaluates buffered terminal output, so a recently seen prompt can fire
immediately.

For interval macros, pausing clears interval ownership and timing state. The
macro must match the trigger pattern again after resume before a new interval
cycle starts, unless buffered output still contains a matching prompt and
reevaluation arms it immediately.

If **Start auto-trigger paused** is enabled, the macro starts paused after reload
or startup until you resume it.

## Regex Examples

Use patterns that describe the prompt you actually expect. Overly broad patterns
can send input to the wrong prompt, repeat too often, or match normal command
output.

### Password Prompts

```regex
(?:[Pp]assword|passphrase):\s*$
```

Why: matches common password and passphrase prompts at the end of the current
buffer. The final `\s*$` allows trailing spaces but avoids matching a sentence
in the middle of output.

Risk: adding `.*` before the prompt can make the regex slower and easier to
match in unrelated banners.

### Enable or Configuration Prompts

```regex
(?:^|\n)(?:enable|configure terminal)\?\s*\[yes/no\]:[ \t]*(?:\n|$)
```

Why: anchors the prompt to a buffer or line boundary without requiring regex
flags, allows only the expected command words, and requires the `[yes/no]:`
shape.

Risk: a broad pattern such as `yes/no` may match documentation, warnings, or
command output instead of an interactive prompt.

### Interface Status Prompts

```regex
(?:^|\n)Interface\s+\S+\s+is\s+(?:administratively\s+)?down[ \t]*(?:\n|$)
```

Why: matches a complete interface status line at a buffer or line boundary and
handles both `down` and `administratively down` without relying on multiline
regex flags.

Risk: if this macro sends a remediation command, scope it to a matching profile
or active session. Interface status output is common and can appear during
read-only checks.

### Paging Prompts

```regex
(?:--More--|Press any key to continue)\s*$
```

Why: covers two common pager prompts and anchors them to the buffer end. A macro
using this pattern usually sends a space (` `) or `\n`.

Risk: pager prompts can repeat quickly. Use a cooldown, or consider disabling
paging with a command such as `terminal length 0` when appropriate.

### Error Banners

```regex
(?:^|\n)% ?(?:Error|Invalid input|Incomplete command)\b[^\n]*(?:\n|$)
```

Why: Cisco-style errors often start with `%`. The pattern anchors to a buffer or
line boundary, lists specific error classes, and avoids relying on multiline
regex flags.

Risk: avoid triggering a macro that automatically retries the same failed
command unless the retry condition is very specific. Otherwise you can create a
loop.

### Shell Prompts

```regex
(?:^|\n)[A-Za-z0-9._-]+@[A-Za-z0-9._-]+:[^\r\n]*[#$]\s*$
```

Why: matches a common `user@host:path$` or `user@host:path#` prompt at the end of
the buffer. The `(?:^|\n)` part makes the prompt start at a line boundary.

Risk: prompt formats vary. A very broad pattern such as `[$#]\s*$` is convenient
but can match command output ending in `$` or `#`. Use active-session or profile
scope, and avoid short intervals with broad shell prompt patterns.

## Regex References

- [MDN: Regular expressions](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Guide/Regular_expressions)
- [MDN: RegExp reference](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/RegExp)
- [regular-expressions.info](https://www.regular-expressions.info/)
- [regex101 JavaScript flavor tester](https://regex101.com/)

Nexus uses JavaScript regular expressions. Test patterns with the JavaScript
flavor, then keep them as narrow as practical for the terminal prompt you want.
