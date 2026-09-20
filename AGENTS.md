# AGENTS.md

## Shell commands

Always prefix shell commands with `rtk` in this repository. In command chains,
prefix each segment separately:

```bash
rtk git status && rtk npm run compile
```

Use raw commands only when debugging `rtk` itself or when explicitly requested.

## What this is

**Nexus Terminal** (`vscode-nexterminal`) — VS Code extension: SSH/telnet/serial
terminals, tunnels, SFTP, TFTP/DHCP. TypeScript strict (ES2022, CommonJS),
esbuild bundler, Vitest. Targets VS Code ^1.105 (Node 22 extension host,
`@types/node` 22); CI builds on Node 20 — either works locally.

## Commands

- `npm run compile` — type-check only. This is the only static check; **no linter/formatter is configured**.
- `npm run build` — clean + type-check + all esbuild bundles + native artifact prep.
- `npm test` (coverage), `npm run test:unit`, `npm run test:integration`.
- Single test: `npx vitest run test/unit/nexusCore.test.ts`; by name: `npx vitest run -t "pattern"`.
- Integration tests run one at a time with 30s timeouts by design (real child processes/sockets) — never "fix" a timing flake with retries or skips; find the cause.
- `npm run package:vsix` fails on a fresh checkout (needs prebuilt PTY binaries for all six platforms from CI). You don't need a VSIX to develop.
- F5 (Extension Development Host) has no pre-launch build — run `npm run build` first or you get a stale `dist/`.

## Build constraint: five bundles

esbuild emits `dist/extension.js`, `dist/webExtension.js`, `dist/services/serial/serialSidecarWorker.js`, `dist/services/scripts/scriptWorker.js`, `dist/services/networkServers/networkServerDaemon.js`. A Node-only import reaching the browser graph breaks the web build. Worker/daemon bundles must not import `vscode` — **the build only half-enforces this**: `scriptWorker` lists `vscode` external, so the bad import bundles cleanly and fails only at runtime. When touching `scriptWorker.ts` or anything it imports, check by eye.

## Never do these

- **Never put `[release]` on its own line in a commit message** — that exact line is the opt-in release trigger and publishes irreversibly to the Marketplace and Open VSX. Releases happen only on the maintainer's explicit say-so. Never write `[skip release]` (dead string, matches nothing). When a release IS asked for, the sanctioned path is pushing the `v{version}` tag, which `release.yml` and `publish-openvsx.yml` trigger on directly — not writing the marker line.
- Don't bump `package.json` version on outside-contributor PRs (maintainer bumps on merge). Maintainer-authored change PRs do bump the patch version — **CI enforces it**: the `Version bump` check fails any PR whose version has not moved past `main`'s, because a later release onto an existing tag fails with an opaque "tag already exists". A docs-only or chore PR still needs the bump; it does not need a CHANGELOG entry if nothing a user can observe changed.
- Don't commit: `.claude/`, `.specify/`, `docs/plans/`, `docs/superpowers/` (a few legacy files are still tracked — don't add new ones), `specs/` except `specs/001-scripting-support/contracts/script-api.d.ts`, `dist/`, `coverage/`, `*.vsix`, secrets or real hostnames.
- No model identifiers in commit messages, PR text, or comments.
- Don't edit published CHANGELOG entries (they ship inside installed VSIXs); corrections go in a new entry.
- No new runtime dependency without discussion first — open an issue and justify it.

## Conventions

- Conventional commit prefixes (`feat:`, `fix:`, `docs:`, `test:`, `refactor:`, `perf:`, `chore:`, `ci:`); bodies explain the reasoning, not just the change.
- Comments explain *why*, not *what*; a comment stating wrong reasoning is worse than none — update it when behavior changes.
- User-facing changes: update `README.md` and `docs/functional-documentation.md` in the same PR; add a CHANGELOG entry. Update what is actually wrong or missing — do not pad a file with a line that documents nothing new, and say so in review if that is your conclusion.

## Shipping a user-facing change

Every rule here exists because it was broken and shipped. Work them explicitly and record the answers in the PR, not in your head.

- **Census the surfaces, and ask the right question.** A capability is not shipped until every surface that could offer it does, or states why not. Enumerate: `package.json` `menus` (`view/item/context`, title, `commandPalette`), the row-click **Profile Actions** quick pick (`profileCommands.ts` — it reads the same `contextValue` markers the menus do), tooltips, the status bar, and the notifications the flow can dead-end in. The question is **"should this surface now offer it?"** — not "does this surface still work?". *Open Web Console shipped right-click-only because the census proved the quick pick did not break, and never asked whether it should gain the action.*
- **A refusal must name a remedy that can actually happen.** "Re-sync the source once it has an address" is a lie to a guest whose agent will never report one. If the remedy depends on a provider capability, make the message capability-aware, or state what is true and stop. Prefer an actionable notification (a button that runs the command) over prose describing a feature the reader then has to go find.
- **Verify every exclusion from a sweep.** Renaming or removing a string across the codebase, anything you decide to leave gets its reason checked against the code path — never accepted from a summary or a plausible category ("that one is the other command's message"). Then pin it: see the absence rule below. *A stale "run Refresh Lab Status" toast reached Proxmox users this way, pointing at a command the same function had already run four lines later.*
- **Reachability you create is yours.** "Pre-existing, out of scope" is a fair limit — unless your change is what made the data reachable. Rendering an unsanitized provider name into a modal that previously showed only counts is a defect you introduced, not one you inherited.
- **Prose is part of the change.** When behaviour moves, grep the prose for claims about it: README, `docs/functional-documentation.md`, contract doc comments, and the WHY comments at each call site. A doc asserting the opposite of the code is how the next maintainer deletes a guard believing it pointless.
- **Text from an inventory provider is untrusted.** It reaches confirmation dialogs and audit buffers. Sanitize where it *enters* a composed string (`flattenProviderText` and its neighbours in `src/models/inventory.ts`), never at the render site — a site that has to remember is a site that will forget. Never widen a character class without a test for what it must not break (ZWJ sequences, combining marks, the tag block).

## Testing standard (enforced)

> A test must fail against the specific wrong implementation it exists to prevent.

Apply the broken implementation, confirm the test goes red, restore, report the result. Unit tests mock the VS Code API and use `InMemoryConfigRepository`; integration tests spawn real processes/sockets (fixtures in `test/fixtures/`).

**Pin absences, not just behaviour.** When a string, hint or action is deliberately removed, assert it is gone (`expect(msg).not.toContain("Refresh Lab Status")`). A test that only checks the new wording passes again the day someone restores the old one — which is how the same EVE-NG hint came back twice.

## Architecture in one screen

- `extension.ts:activate()` instantiates and wires everything; `NexusCore` (`src/core/nexusCore.ts`) is the single source of truth — UI reads immutable snapshots, changes propagate via observers.
- `configMutationLock` is a **convention at the command layer, not an enforced invariant**: hold it across multi-step read-validate-write spans only; never run network I/O under it.
- Service isolation by risk: SSH in-process, scripts in worker threads, serial and the TFTP/DHCP daemon in child processes. New crash-prone or native-hosting code follows the child-process pattern.
- Storage is VS Code `globalState` via `ConfigRepository`, last-writer-wins across windows — read the doc comment atop `vscodeConfigRepository.ts` before adding a collection.
- Native Rust components: `native/local-pty` (Local Shell PTY) and `native/network-server-daemon` (TFTP/DHCP), packaged by `scripts/install*Artifacts.mjs`.

## Where the detail lives

- `CLAUDE.md` — full architecture walkthrough (imports this file)
- `CONTRIBUTING.md` — contribution bar and review expectations
- `docs/HANDOVER.md` — maintainer's standing rules
- `docs/release.md` — maintainer-only release checklist

<!-- graft:start -->
## Graft — repo context graph

This repo is indexed in `graft/`: small linked markdown nodes that explain each
system and carry exact file:line spans, kept in sync with the code through git.

For ANY task here — understanding how something works, finding where code lives,
or scoping a change — get context from the graph before grepping or opening
source files. Re-ask freely (it's cheap) and reuse literal identifiers you
already have (symbol, error string, file name) as the query. New to this repo?
Run `graft map` first — a token-budgeted orientation (dir clusters, hubs,
hotspots), no LLM, no key.

- Run `graft ask "<your question>" --source` → ranked nodes with the relevant
  code spans inlined (each hit's ≤8-line crux by default; `--full` for whole
  definitions when the crux isn't enough). Match the tool to the task shape:
  for understanding or editing, the top node IS the answer — cite its
  `covers:` file:line spans and edit straight from `--source`. For
  exhaustive tasks ("every occurrence / every caller of this pattern"), ranked
  results are top-N, not complete — run `graft grep "<literal>"` instead
  (exhaustive over indexed files, grouped by enclosing symbol), falling back
  to raw `grep -rn` only for unindexed files.
- `graft skeleton <file>` → every definition's signature + span, ~10× cheaper
  than reading the file; use it to skim an API surface.
- `graft callers <symbol>` gives precomputed, exact edges — who calls this.
  Add `--direction out` for what it calls, or `--depth N` to walk
  transitively for the full blast radius. For structural questions, skip
  ranking and use this directly.
- Or browse: `graft/INDEX.md` lists every node; follow the links.
- Monorepos and folders of multiple repos rank fairly across sub-projects —
  hits carry `[scope/]` labels naming which one they're from. Narrow with
  `graft ask "<task>" --in <scope>/` once you know where you're working.

If a returned span is truncated ("+N more lines"), open the file at that exact
range before finalizing. Only open source files when a node genuinely lacks a
needed detail, and then at the exact file:line the node points to — never
re-read whole files.

After big code changes, refresh the graph with `graft build` (deterministic,
no API key, $0).
<!-- graft:end -->
