# Nexus Script examples

Seven short, focused scripts that each demonstrate one facet of the scripting API. Copy any of them into your workspace's `.nexus/scripts/` directory to try them out.

| # | File | Pattern |
|---|---|---|
| 01 | [`01-hello.js`](./01-hello.js) | Basic `expect` / `sendLine` — the minimal shape of a script |
| 02 | [`02-if-branching.js`](./02-if-branching.js) | `waitAny` + `switch` to branch on which prompt appeared |
| 03 | [`03-while-loop.js`](./03-while-loop.js) | `while` loop with `try/catch` for retry-with-backoff |
| 04 | [`04-for-loop.js`](./04-for-loop.js) | `for...of` over a command list, capturing each command's output |
| 05 | [`05-poll-for-prompt.js`](./05-poll-for-prompt.js) | `poll` for device reboots and long-running tasks |
| 06 | [`06-interactive-flow.js`](./06-interactive-flow.js) | `prompt` / `confirm` / `alert` for human-in-the-loop steps |
| 07 | [`07-complete-procedure.js`](./07-complete-procedure.js) | Canonical multi-step procedure: everything combined |

## How to run an example

1. Open a folder in VS Code and make sure you have an active SSH or Serial session in Nexus Terminal.
2. Copy one of these files into `.nexus/scripts/` inside your workspace (create the folder if it doesn't exist).
3. `Cmd/Ctrl+Shift+P` → **Nexus: Run Nexus Script** → pick the script.
4. Watch progress in the **Nexus Scripts** Output Channel.

The first time you invoke any script command, Nexus writes `types/nexus-scripts.d.ts` + `jsconfig.json` alongside your scripts so the editor gives autocomplete and JSDoc hovers for `expect`, `sendLine`, `poll`, etc.

See [`docs/scripting.md`](../../docs/scripting.md) for the full user guide.

## A note about example-specific details

- `01-hello.js` expects a POSIX-style shell prompt (`$` or `#`) and the `uname` command.
- `05-poll-for-prompt.js` and `07-complete-procedure.js` use Cisco IOS XE-style prompts and commands; adapt the regexes to your hardware.
- `02-if-branching.js` assumes you're initiating an `ssh user@jumphost` from an already-open shell — not running it on a jumphost itself.

The patterns transfer directly to other devices; only the literal prompts and commands change.
