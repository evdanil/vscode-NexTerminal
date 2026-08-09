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

If you want a macro that asks you for input every time it runs — a host, a
username, a password — skip ahead to **Variables**, below, and start from the
**IPMI SOL console** template instead of **Send command**.

## Blank Macros vs Template Macros

Use **Add Macro From Template** when you are learning macros or want a safe
starting point. Templates fill in common fields such as newline handling,
secret storage, trigger patterns, and trigger scope.

Use **Add Blank Macro** when you already know the exact text and options you
want. A blank macro starts with no auto-trigger behavior, so it only runs when
you run it manually or assign a shortcut.

Built-in templates include:

- **Send command**: sends a normal command to the active terminal.
- **Send password when prompted**: creates a paused secret active-session
  trigger with no sample password stored. Enter the secret, save, then resume
  auto-trigger when you are ready.
- **Wait and send confirmation**: sends `yes` when a confirmation prompt
  appears.
- **Scoped auto-trigger example**: shows a prompt-triggered command that starts
  paused until you resume it.
- **IPMI SOL console**: opens a serial-over-LAN console with `ipmitool`,
  reading the BMC address, the BMC username and the BMC password from the server
  profile — a complete worked example of **Profile tokens** and of
  **Providing IPMI credentials** (both below). Nothing is prompted for.
- **IPMI Power Status / IPMI Power On / IPMI Power Off (hard, no OS shutdown)**:
  chassis power control, in the same shape as the SOL template. Power Off is an
  abrupt power cut, not a graceful shutdown — that is why it says so in its name.
- **Launch IPMI web console**: opens a server's BMC web interface in the
  browser, using the profile's IPMI / BMC Host.

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
- A masked **variable** value (see **Variables**, below) is never persisted or
  remembered, but once it is sent it is subject to the same terminal/host
  echo, scrollback, and clipboard caveats listed above for secret macro text.

For secret auto-triggers, prefer **Active session** or **Matching profile** scope
instead of **All terminals**.

A host or background session can trigger a secret macro by printing text that
matches the pattern. For passwords and tokens, use **Active session** or
**Matching profile**, keep the regex narrow, and avoid **All terminals**.

## Variables

Macros can declare named variables and prompt for them before the macro's
text is sent. Reference a declared variable in the text as either `$host` or
`${host}` — both forms work once `host` is declared. If a placeholder's name
was never declared as a variable, Nexus sends it exactly as written (an
undeclared `$host` reaches the terminal unchanged) — a typo in a variable name
fails silently rather than blocking the macro, so watch the live hints under
the Text field in the Macro Editor to catch that.

### Declaring a variable

Open a macro in the Macro Editor and use the new **Variables** section, or
start from the **IPMI SOL console** template (see Quick Start, above). Each
variable has:

- **Name** — must match `/^[A-Za-z_][A-Za-z0-9_]{0,31}$/` (letters, digits, and
  underscore; must not start with a digit).
- **Label** (optional) — the prompt text shown in the input box. Defaults to
  the variable's name.
- **Default** — a prefilled value. Not allowed on a masked variable, since a
  default would be plaintext in the macro store.
- **Mask input (never stored)** — shows the input box as a password field and
  never remembers the entered value, even across runs in the same window.
- **Don't remember** — non-secret variables remember the last value entered in
  the current VS Code window by default; check this box to turn that off for
  one variable. Remembered values live in memory only, are scoped to the
  current window, and are lost on reload — nothing about them is ever written
  to disk.

A macro may declare up to 10 variables.

### Syntax

| Written | Meaning |
|---|---|
| `${name}` — `name` declared | replaced with the entered value |
| `$name` — `name` declared | replaced with the entered value |
| `${name}` / `$name` — **not** declared | **passed through untouched** |
| `$${name}` / `$$name` — `name` declared | literal `${name}` / `$name` (escape) |
| `$${name}` / `$$name` — **not** declared | **passed through untouched, `$$` intact** |
| `$$`, `$(cmd)`, `${#arr[@]}`, `$1` | never touched |

Only declared variables whose placeholder actually appears (unescaped) in the
text are prompted for, once each, in declaration order — a variable you
declare but never reference in the text produces no prompt.

Empty input is accepted as a legitimate value. Pressing Enter through a prompt
with nothing typed substitutes an empty string, which can produce a malformed
command (for example `-H  -U root`); that is your call to make, and Nexus does
not block it.

Remembering (see **Don't remember**, above) happens step by step as you move
forward through the prompts, not only once the whole sequence sends
successfully. If you cancel partway through — for example you enter the host,
then press Esc at the username prompt — the host value you already entered is
still remembered for the next time you run the macro, even though nothing was
sent this time.

### Worked example: a macro that prompts for one value

Variables are for values that genuinely change per run. The shipped IPMI
templates no longer use any — everything they need is on the server profile
(see **Profile tokens** and **Providing IPMI credentials**, below) — so here is
the shape when something really is per-run:

```
Text:      ipmitool -I lanplus -H ${profile.ipmiHost} -U ${profile.ipmiUsername} -E chassis bootdev $device
Run in:    Local terminal
Variables: device (Boot device)
```

The address and the username are read from the server profile you run the macro
against; only `$device` is asked for. Running it prompts once, then sends the
filled-in command line to a local terminal — even if you switch to a different
terminal tab while the prompt is still open.

### Which terminal receives the macro

This is a real behavioral difference between the two send paths, and it is
easy to miss:

- A macro with **no** declared variables is sent through the same
  immediate, same-tick path Nexus has always used: whatever terminal is
  active at the moment you invoke it.
- A macro that declares variables is different: the target terminal is
  captured at the moment you invoke the macro, *before* any prompts are
  shown, and the resolved text is sent to that same terminal even if you
  switch to a different tab while the prompts are still open (see **Worked
  example**, above).

One consequence: the variable-free path sends through VS Code's own
text-sending command, which resolves VS Code's own `${workspaceFolder}` /
`${env:FOO}`-style variables before the text reaches the terminal. The
variables path sends directly to the terminal instead and does not perform
that resolution — so `${workspaceFolder}` or `${env:FOO}` written into a
variables-macro's text is sent to the terminal literally (and, per the Syntax
table above, passed through untouched unless you also happen to declare a
macro variable with that exact name).

### No automatic quoting

Values are substituted exactly as entered — Nexus does not add quotes around
them. On a shell where you want quoting, most commonly for a password that
could contain shell metacharacters, add it yourself in the macro text:

```
ipmitool -I lanplus -H $host -U $username -P '${password}' sol activate
```

Nexus does not add the quotes in `'${password}'` automatically, because this
extension's other main audience is network-device CLIs (Cisco IOS, Juniper,
Arista, and similar) where wrapping a value in single quotes would corrupt the
command instead of protecting it. Add quoting yourself only on a shell where
you know it applies.

### Variables and auto-trigger do not mix

A macro can prompt for input, or auto-trigger from terminal output — not both.
Prompting means opening an input box, which cannot happen safely from a
background pattern match running on a possibly-inactive terminal. If you need
a fully automated flow that also needs to compute values or branch on
conditions, use a **Script** with `prompt()` instead — see the Scripts
documentation. Scripts have loops, conditionals, and timeouts that macros
intentionally do not.

If a macro somehow ends up with both a trigger pattern and variables (this
cannot happen through config import — sanitization strips the trigger in
exactly this case; the two real sources are legacy `nexus.terminal.macros`
settings absorption, which persists entries verbatim, or a direct edit to
Nexus's stored state), Nexus treats it as a plain, non-auto-triggering macro:
no zap icon, no enable/disable toggle, and the macro's tooltip in the sidebar
reads `Auto-trigger suppressed: macro has variables`.

### Avoiding remote shell history

Many shells support a leading-space convention that skips a command from being
recorded in that shell's own history. In bash or zsh, set
`HISTCONTROL=ignorespace` and start the macro's text with a single space:

```
 ipmitool -I lanplus -H $host -U $username -P '${password}' sol activate
```

This only affects the remote shell's own history file. It does not change
anything about how Nexus stores or remembers the macro or its variables — see
**Not protected**, above.

## Profile tokens

A macro can pull facts out of the **server profile it is run against**, so you
do not retype what Nexus already knows. Write them as `${profile.<field>}`:

| Token | Resolves to |
|---|---|
| `${profile.name}` | the profile's name |
| `${profile.host}` | its SSH host |
| `${profile.port}` | its SSH port |
| `${profile.username}` | the username it connects as — the linked **auth profile**'s where one supplies it, the server's own otherwise |
| `${profile.ipmiHost}` | its **IPMI / BMC Host** (Advanced section of the server form — filled in automatically on servers synced from a NetBox device that carries an out-of-band IP) |
| `${profile.ipmiUsername}` | the username of its **IPMI Auth Profile** (Advanced section of the server form). The BMC's own account, separate from the SSH one; only the profile's username and saved password are used, never its authentication type or key file |

Nothing else is exposed — key paths, ids and inventory bookkeeping are
deliberately not addressable.

Profile tokens are a different namespace from macro variables, so they never
collide: a macro can declare a variable named `host` and use `$host` **and**
`${profile.host}` in the same text; the first is still prompted for, the second
is filled in from the profile. `$${profile.host}` escapes the token and sends
the literal text. A token that is not in the table above is sent as-is — a typo
is never fatal, and the send confirmation says which token went out verbatim.

### Running a profile macro

Right-click a server in the Connectivity Hub and choose **Run Macro on Server…**
(also available from **Profile Actions**). The picker lists every macro, with
profile-token macros first. Tokens then resolve against **that server** — not
against whatever terminal happens to be active.

If the server has no value for a field the macro needs (typically **IPMI / BMC
Host**), the run is refused with a message naming the server and the field, and
an **Edit Server** button. Nexus never sends a command containing an unresolved
token, and never one with the argument silently emptied.

Values are also checked before they are substituted, and every token is
checked:

| Token | Accepted |
|---|---|
| `${profile.host}`, `${profile.ipmiHost}` | letters, digits, `.`, `-`, `_`, `:` — the address only, no `https://` and no path. `[` and `]` only as a whole bracketed IPv6 literal, with an optional port: `[fe80::1]`, `[::ffff:10.0.0.1]`, `[fe80::1]:623` |
| `${profile.port}` | digits |
| `${profile.username}`, `${profile.ipmiUsername}` | letters, digits, `.`, `_`, `-`, and at most one `@` *between* the name and the realm — `admin`, `first.last`, `user@REALM.EXAMPLE.COM`. A leading, trailing or repeated `@` is refused |
| `${profile.name}` | letters, digits (any language — accents included), spaces, and `.`, `-`, `_`, `/`, `:`, `,`, `+`. Everything else is refused |

No value may contain a `$` or a backtick, in any token. A profile carrying shell
syntax — which can reach your config through an inventory sync or an imported
backup — refuses the run instead of executing it, and the message names the
offending value and what the field accepts. This is a charset check, not
quoting: the rest of the command line is still yours to quote (see **No
automatic quoting**).

The shell a **Local terminal** macro lands in is whichever default profile you
have configured — PowerShell or Command Prompt on Windows, zsh on macOS, usually
bash on Linux — so a profile **name** is checked against an *allowed* set rather
than a list of banned characters. A character is on that list only if it does
nothing in *any* of those four shells: it cannot make one execute something,
expand something, or throw away the rest of your command line.

That allowed set is: letters, digits and accents in any language, a space, and
the eight punctuation marks `.`, `-`, `_`, `/`, `:`, `,`, `+`. Anything else —
`(`, `)`, `{`, `}`, `%`, `!`, `*`, `?`, `[`, `]`, `~`, `#`, `^`, `=`, `@`,
quotes, `;`, `\|`, `&`, `<`, `>`, `\`, `$`, a backtick, and symbols such as `°`
or an emoji — is refused, and the message tells you what *is* accepted.

**Why an allowed set and not a banned one.** Earlier versions of Nexus banned a
list of shell metacharacters in a profile name, and that list needed widening
four times, each time because one more character turned out to have a role
somebody had not enumerated: PowerShell evaluates `(…)` even in argument
position; cmd.exe expands `%VAR%` while it parses the line; bash expands `!!`
into a previous command, and `*`, `?`, `[`, `]` and `~` into filenames and home
directories, before anything runs; `#` starts a comment, so it silently *deletes*
the rest of the command your macro was written to send. The fifth was the one
that settled it: a `^` at the start of a line is bash **quick substitution**
(`^old^new^`, shorthand for `!!:s/old/new/`), which rewrites your previous
command and runs the result — and the old list had explicitly reasoned that `^`
was harmless because it is only an escape character in cmd.exe.

Meanwhile the *address*, *port* and *username* fields, which have always used an
allowed set, needed no such widening. An allowed set refuses a character nobody
has thought about yet; a banned list waves it through. `=` and `@` show what that
buys: `=ls` at the start of a word is a zsh path expansion (on by default, and
zsh is the default shell on macOS), and `@name` in PowerShell splices the
contents of a session variable into a command's arguments. Neither was on any
banned list; both are simply absent from the allowed one. (`@` stays legal in
**Username**, where `user@REALM` is a real account name — but only *between* the
name and the realm. A username of `@args` is a single word beginning with `@`,
which is the splatting form itself, so a leading, trailing or repeated `@` is
refused there too.)

Rename the profile — `Core Switch DC1` rather than `Core Switch (DC1)`,
`Rack A - Spare` rather than `Rack A [Spare]`, `Device 4` rather than
`Device #4`, `Rack 4 - Spare` rather than `Rack 4 ^ Spare` — or escape the token
(`$${profile.name}`) if you only want the literal text. Ordinary labels are
unaffected: `Rack 4 / Ünit 2`, `dc1.rack4.unit2`, `DC1: Core Switch` and
`Ærø-Süd Ünit 2` all resolve.

`${profile.host}` and `${profile.ipmiHost}` still accept square brackets, but
only as a **whole bracketed IPv6 literal** — `[fe80::1]` or `[fe80::1]:623`, and
the part inside the brackets has to parse as an IPv6 address. A value with a
bracket anywhere else (`a[b]c`) or a bracket expression dressed up as an address
(`[abc]`) is refused: unquoted in a local command it is a glob, not an address.

### IPv6 in a browser macro

Store the address the way you would type it anywhere else — `fe80::1`, no
brackets. In a **Browser** macro the whole text is a URL, and a URL needs an
IPv6 address bracketed *where the address is the host*, so Nexus adds the
brackets there: `https://${profile.ipmiHost}/` on a server whose IPMI / BMC Host
is `fe80::1` opens `https://[fe80::1]/`. Nothing else changes shape — a value you
already stored bracketed (`[fe80::1]`, `[fe80::1]:623`) is used as written and
never double-bracketed, and a host:port that merely contains a colon
(`bmc.example.com:8443`) is left exactly as it is.

The brackets are added **only in the host part of the URL** — between `://` and
the next `/`, `?` or `#`. A token anywhere else is a value, not a host, and gets
the address exactly as you stored it:

```
https://${profile.host}/status           →  https://[fe80::1]/status
https://gateway/connect?to=${profile.host}  →  https://gateway/connect?to=fe80::1
https://gateway/host/${profile.host}     →  https://gateway/host/fe80::1
```

Each token in a macro is decided on its own, so a macro that uses one in the host
and one in the query gets brackets on the first and not the second. The scheme
may itself come from a prompted variable — `${scheme}://${profile.ipmiHost}/` is
recognised as a URL and its host bracketed, exactly as a literal `https://` one
is (an *escaped* `$${scheme}` is literal text, so it is not a scheme). If the
macro text has no `scheme://` at all, nothing is bracketed — the text is not a
URL, and Nexus refuses it with that message instead.

**Session terminal** and **Local terminal** macros get the raw value, with no
brackets added: `-H fe80::1` is what `ipmitool` expects. If you need the
bracketed form on a command line, store it bracketed — it is accepted for both
address fields.

A macro that uses profile tokens cannot auto-trigger, whichever **Run in** it
has: a rule fired by terminal output has no server to resolve the tokens
against. The macro editor refuses the combination, and a macro that reaches the
store some other way (a hand-edited settings file, an import) simply never
compiles a trigger rule.

## Providing IPMI credentials

`ipmitool` can read the BMC password from the environment instead of the command
line — that is what its `-E` flag does, and it is why the shipped IPMI templates
use `-E` and never `-P`. A password on a command line is visible in `ps` on the
machine that runs it, in the terminal's scrollback, and in Nexus's own
*Copy All to Clipboard* transcript; a password in the environment is readable
only by the same OS user, and dies with the terminal.

Two things have to be in place.

**1. Link an IPMI Auth Profile to the server.** In the server form, under
Advanced, beside **IPMI / BMC Host**. It is the same auth profile store you use
for SSH — an IPMI credential is a username and a password, which is exactly what
an auth profile holds — so one shared BMC account can be linked from every
server in the fleet. Only its **username** and its saved **password** are used
here; its authentication type and key file are ignored on this link, so a
`key` or `agent` profile is accepted and simply supplies a username. The
username is also what `${profile.ipmiUsername}` resolves to.

**2. Tick "Provide IPMI credentials" on the macro.** It appears in the macro
editor under **Run in**, and only when Run in is *Local terminal* — the only
place it can mean anything. Ticking it puts the linked profile's password into
that macro's terminal as `IPMITOOL_PASSWORD` and `IPMI_PASSWORD` (both, because
which one ipmitool honours has changed between versions). Every command the
macro runs in that terminal can read it, which is why it is off unless you turn
it on, and why the hint says to leave it off for anything that is not an
ipmitool command.

If no password is stored for the linked profile — or no profile is linked at all
— Nexus asks for one when the macro runs: masked, used for that run only, never
saved. Cancelling the prompt cancels the run; a terminal without the variable is
not what you asked for.

A macro that uses `${profile.ipmiHost}` or `${profile.ipmiUsername}` **without**
the checkbox still runs. `ipmitool -E` then prompts or fails on its own, and the
send confirmation tells you which switch is missing. Token usage is a hint, never
an authorization: a macro's text is something anyone can write, so it can never
be what decides that a stored password is handed over.

### Capability settings are never imported

**Provide IPMI credentials** is stripped from every macro that arrives from
outside this installation — a shared bundle *and* a restored backup, without
exception. A shared macro could otherwise arrive already armed, and its first
run would hand the BMC password to whatever its text does with the environment,
with you never having seen the checkbox. Provenance is not something the import
can check (a backup file is an ordinary file; nothing in it says whose it is),
so the rule is the same on both paths and worth remembering in one sentence:
after a restore, re-tick the box on the IPMI macros you trust.

Inserting a template is not an import — it is you, on this machine, asking for a
specific command — so the shipped IPMI templates keep the flag they ship with.

## One-click BMC actions

Two commands on a server's right-click menu do the common jobs without going
through the macro picker:

- **Connect BMC Serial Console** opens a local terminal already running
  ` ipmitool -I lanplus -H <IPMI / BMC Host> -U <IPMI username> -E sol activate`,
  with the credential environment supplied exactly as a ticked macro would get
  it. Choosing the command *is* the consent — there is no stored record here to
  arrive pre-armed from somewhere else, which is what the macro checkbox exists
  to guard against.
- **Open BMC Web Console** opens the BMC's web interface in your default
  browser. HTTPS unless the server's **BMC Web Protocol** (Advanced, beside the
  other IPMI fields) is set to HTTP — some older iDRAC/iLO cards serve nothing
  else, and HTTP sends your BMC login in clear text over the management network,
  so it is a per-server opt-in. There is no auto-login: it opens the address, and
  the BMC asks for whatever it asks for.

Both are listed on every server, configured or not — the menu never hides them —
and a server missing a piece gets an error naming the field and where to set it,
with an **Edit Server** button that opens the form with Advanced already
expanded.

## Where a macro runs

**Run in**, in the macro editor, decides where the resolved text goes:

- **Session terminal** (default, and what every existing macro does) — the
  connected session. From **Run Macro on Server…** that means a session *of
  that server*; if it is not connected, Nexus offers to connect first.
- **Local terminal** — a new VS Code terminal on your own machine. This is
  where `ipmitool` runs. As in a session, the macro's own trailing newline
  decides whether the line executes.
- **Browser** — the text is a URL, opened with your default browser. Only
  `http://` and `https://` are accepted; anything else is refused. A profile
  address that is a bare IPv6 literal is bracketed for you (see **IPv6 in a
  browser macro**).

Local terminal and Browser macros need a server profile to resolve against, so
run them from **Run Macro on Server…**. Neither can auto-trigger: firing a
browser window, or a local command, on every matching line of terminal output
is not something a pattern match should be able to do.

An older Nexus build that does not know **Run in** treats such a macro as an
ordinary session macro. The shipped **Launch IPMI web console** template
therefore stores its URL without a trailing newline: on such a build it is
pasted into a terminal rather than executed.

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

If your macro shortcuts (`Alt+S`, `Alt+<key>`) do nothing, the usual cause is
`terminal.integrated.sendKeybindingsToShell` being set to `true` — that setting
overrides `commandsToSkipShell` and lets the terminal swallow the shortcuts. It
must be `false`. Nexus shows a one-time hint when it detects this (or a missing
`commandsToSkipShell` entry, or `window.enableMenuBarMnemonics` capturing Alt
shortcuts); clicking **Fix Keybindings** on that hint, or running **Nexus: Fix
Macro Keybindings** from the Command Palette, corrects all three.

## Organising macros into folders

The Macros view groups macros into folders, the same way the Connectivity Hub
groups servers and serial profiles.

Folders are yours to create — an empty folder stays until you remove it.

- **New Folder** — the `$(new-folder)` button in the Macros view title bar.
  Enter a path (`Cisco/Routers` for a nested folder); it appears immediately,
  empty, and survives a reload. Naming a folder that already exists is a
  no-op with an info message rather than an error.
- **Move to Folder** — right-click a macro and choose **Move to Folder** to
  move just that one macro. Run the same command from the Command Palette
  with nothing selected and it opens a multi-select quick pick of every
  macro first, then a folder picker (existing folders, **New folder…**, or
  **(root)**) — this is the fastest way to sort a flat pile of macros into
  folders in one pass.
- **Drag a macro onto a folder** — moves that one macro into the folder.
  Dragging onto the root of the tree clears the macro's folder. The Macros
  view does not support multi-select drag; use **Move to Folder** from the
  palette for moving several macros at once.
- **Reordering inside a folder** — **Move Up** / **Move Down** swap a macro
  with the previous or next macro in the *same* folder, not the physically
  adjacent row in the tree. At the top or bottom of a folder, the status bar
  says "Already at the top/bottom of this folder"; at the root it says
  "...of the list". Folders themselves always sort alphabetically ahead of
  macros — only the macros inside a folder (and at the root) keep the order
  you put them in, which is what **Move Up** / **Move Down** and the **Run
  Macro** quick pick both honor.
- **Remove Folder** — right-click a folder and choose **Remove Folder (keep
  macros)**. This never deletes a macro: every macro directly in that folder,
  and any macro in a nested subfolder, moves up to the removed folder's
  parent (or to the root, if the removed folder had no parent), keeping its
  place in any sub-structure that's left. Renaming a folder works the same
  way — it only rewrites the folder path stored on affected macros.
- **Add Macro from a folder** — right-click a folder and choose **Add Macro**
  to open the Macro Editor with that folder pre-filled in the **Folder**
  field.

The Macro Editor's **Folder** field accepts the same `/`-separated paths and
offers your existing folders in a dropdown as you type. Leaving it blank (or
clearing it) puts the macro at the root.

Two same-named macros in different folders are only distinguished from each
other by folder in **Run Macro**'s quick pick — check the `detail` line under
each entry if you have duplicates across folders.

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
- Avoid those risky shapes by anchoring to the prompt, replacing broad repeats
  with line-bounded text such as `[^\n]*`, or using bounded repeats such as
  `(?:yes|no){1,3}` when repetition is required.
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

**Interval** is for prompt-gated polling. An interval macro starts only when its
pattern matches the active terminal. That terminal owns delayed sends for the
macro even if focus changes. Later matches on that same session send immediately
if the interval has elapsed, or wait until it has. Nexus does not send again
until the pattern matches again. For interval macros, the interval controls the
next matched prompt; `triggerCooldown` does not control that cadence.

Example: a macro has pattern `router#\s*$`, text `show clock\n`, and
`triggerInterval: 10`. When the active terminal shows `router#`, Nexus sends
`show clock\n` immediately. If another `router#` prompt appears 10 seconds or
more after that send, Nexus sends again immediately. If the prompt appears
sooner, Nexus waits until the 10-second interval has elapsed, then sends once.

Interval ownership matters. The terminal that first matches the interval macro
must be active, and it owns delayed sends for that macro. Ownership continues
even if focus changes, until you pause the macro, disconnect the session,
dispose the terminal observer, edit the macro so the interval no longer applies,
or otherwise clear the interval state.

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

Pause/resume state, interval ownership, and cooldown timers all follow the macro
itself, not its position in the list. Reordering macros with **Move Up** /
**Move Down**, or deleting a different macro, never moves a pause (or an active
trigger) onto the wrong macro.

### Duplicate macro identities

Macros are identified internally by a unique id. Two macros can end up sharing
one — from a hand-edited stored macro list, or from a Nexus version that predates
the rule. Every path that writes macros today assigns fresh ids to duplicates as
it writes, so a backup restore and a legacy `nexus.terminal.macros` absorption
both arrive already de-duplicated; what survives is a conflict that was written
to storage before the rule existed. Nexus cannot tell such macros apart, so it
will not guess: while the conflict exists, **neither macro auto-triggers**. Each
one that has an auto-trigger pattern is shown in the Macros view with a warning
icon and a tooltip saying so (a macro with no pattern has no trigger to suppress,
so it keeps its normal icon). Nexus does not rewrite the ids on its own, at
startup or at any other time, because for a secret macro that would mean deciding
which macro owns the stored password. The rewrite happens only as part of a
change you make.

To fix it, use **Move Up** or **Move Down** on any macro. That re-saves the list,
which assigns fresh ids, and both macros go back to normal. Reordering keeps
working on a flagged macro because it acts on the row you clicked — Nexus checks
that the macro still sitting at that row is the one the row was drawn for, which
is a question the shared id cannot answer but the position can.

Everything that has to identify a flagged macro from something other than a
clicked row refuses instead of guessing: the macro editor will not save or delete
one, because all it has is the id.

A click on a flagged row is acted on only while that macro is still exactly where
the row was drawn. If the list changes underneath an open dialog — you confirm a
delete, type a shortcut, answer the paste prompt — Nexus tells you it can no
longer tell the two apart rather than writing to the wrong one. That holds even
though the change that shifted the list also assigned fresh ids: what decides it
is that the id was shared **at the moment you clicked**, not whether it still
looks shared by the time the write happens. (The write gives one of the two a
fresh id, so the shared id survives on exactly one macro — and which one that
is depends on details you cannot see, so it may well be the macro a write must
not land on.)

Refreshing the view and retrying resolves that, and so does reordering any
macro.

Running a macro manually, and its keyboard shortcut, are unaffected.

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
