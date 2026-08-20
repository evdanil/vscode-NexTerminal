# Contributing to Nexus Terminal

Thanks for being here. This is a small project with a high bar, and outside contributions are genuinely welcome — this guide exists so that the bar is written down rather than discovered in review.

Read it before opening a pull request. Most of it is short; the two sections that will actually affect whether your PR is accepted quickly are [Tests](#tests) and [One change per pull request](#one-change-per-pull-request).

---

## Licensing of contributions

This project is licensed under the **Apache License 2.0** (see [`LICENSE`](LICENSE)).

By submitting a pull request, you agree that your contribution is licensed under the same terms, as set out in section 5 of the Apache License 2.0:

> Unless You explicitly state otherwise, any Contribution intentionally submitted for inclusion in the Work by You to the Licensor shall be under the terms and conditions of this License, without any additional terms or conditions.

If you cannot agree to that — for example because your employer owns the copyright in your work and has not authorised the contribution — please say so in the pull request **before** it is reviewed, rather than after.

Do not paste code you did not write, or code from a project under an incompatible licence, into a contribution. If a change is derived from another source, say where it came from and under what licence.

---

## Reporting security problems

**Do not open a public issue for a security vulnerability.**

Use GitHub's [private vulnerability reporting](https://github.com/evdanil/vscode-NexTerminal/security/advisories/new) on this repository. That gives us a private channel to confirm the problem and prepare a fix before it is public.

This extension handles SSH credentials, serial devices, telnet sessions, port forwards and stored secrets, so please treat anything touching those as security-relevant. A short private report beats a perfect public one.

---

## Before you start

**Open an issue first for anything substantial.** A new feature, a new dependency, a new top-level UI surface, or a change to how credentials or connections are handled — discuss it before you build it. This is not bureaucracy: it is much cheaper for both of us to disagree about an approach in an issue than in a 4,000-line pull request.

You do not need an issue for a typo, an obvious bug fix, or a documentation correction. Just send it.

If you are unsure whether an idea fits, ask. "Would you take a PR that does X?" is a perfectly good issue.

---

## One change per pull request

A pull request should do **one thing**, and its title should be able to say what that thing is without the word "and".

This is the single most common reason a contribution takes a long time to land. Two features in one branch cannot be reviewed independently, cannot be reverted independently, and cannot be released independently — so a problem in either one blocks both. If you have already built two things on one branch, it is usually still worth splitting them before review rather than after.

Large changes are welcome. Large *mixed* changes are the problem.

---

## Development setup

You need Node.js and a recent VS Code — this extension targets `^1.105.0`, whose desktop extension host runs **Node 22**, which is what the code is type-checked against (`@types/node` 22). The release workflows build on Node 20, so either works for developing.

```bash
npm install
npm run compile        # type-check only, no emit
npm run build          # clean + type-check + bundle to dist/
npm test               # full suite with coverage
npm run test:unit      # unit tests only
npm run test:integration
npm run watch          # watch-mode type-checking
```

`npm run package:vsix` is **not** part of the normal loop and will fail on a fresh checkout: it runs `prepare:local-pty:required`, which demands prebuilt Local Shell PTY binaries for all six supported platforms under `native/local-pty-artifacts/`. CI manufactures those before packaging. You do not need a VSIX to develop or to open a pull request — use `npm run build` and the Extension Development Host below.

To run one test file or one test:

```bash
npx vitest run test/unit/nexusCore.test.ts
npx vitest run -t "pattern"
```

Run `npm run build`, then press <kbd>F5</kbd> in VS Code to launch an Extension Development Host with the extension loaded. The `Run Extension` configuration is committed to `.vscode/launch.json`, so F5 works on a fresh checkout. There is deliberately no pre-launch build task wired up — which means a stale `dist/` gives you a stale Development Host, so build first when you have changed anything.

**All four bundles must build.** esbuild emits two *host* targets — `dist/extension.js` (Node, the real extension) and `dist/webExtension.js` (browser, a deliberately degraded fallback) — plus two isolated workers, `dist/services/serial/serialSidecarWorker.js` and `dist/services/scripts/scriptWorker.js`. A Node-only import that reaches the browser graph breaks the web build, and `npm run build` will tell you.

The worker bundles must not import `vscode` — they run outside the extension host, where that module does not exist. **The build only half-enforces this, so do not rely on it.** `serialSidecarWorker` does not list `vscode` as external, so an accidental import fails to resolve and the build stops. `scriptWorker` *does* list it external (`esbuild.mjs`), so the identical mistake bundles cleanly and leaves a runtime `require("vscode")` in a worker that has no extension host around it — every script then fails at startup, with nothing said at build time. When you touch `src/services/scripts/scriptWorker.ts` or anything it imports, check that constraint by eye.

---

## Tests

This project has a specific, non-negotiable standard for tests, and it is stricter than "there is a test":

> **A test must fail against the specific wrong implementation it exists to prevent.**

Before you trust a regression test, ask what happens if the fix it guards were reverted or never written. If the test would still pass, it is not testing anything — delete it or rewrite it. The recurring trap is a fixture where the correct and the broken behaviour produce identical state.

The reliable way to check is to actually do it: apply the wrong implementation, confirm the test goes red, then restore. Saying so in the pull request ("reverting X fails this test, and only this test") makes review much faster, and it is the single thing most likely to get a PR merged without a round of questions.

Practical expectations:

- New behaviour comes with tests. Bug fixes come with a test that fails before the fix.
- Unit tests mock the VS Code API and use `InMemoryConfigRepository`.
- Don't weaken an existing assertion to make your change pass. If an existing test is genuinely wrong, say so explicitly in the PR and explain why — that is a legitimate correction, but it needs to be visible rather than quietly folded in.
- Don't fix a flaky test by adding retries, raising timeouts, or skipping it. Find out why it is flaky.

Run the full suite before you push, and report the real numbers in your PR. If something fails for a reason unrelated to your change, say which test and why you believe it is unrelated — don't round it down to "tests pass".

---

## Code style

There is **no linter or formatter** configured. That is deliberate, and it puts the burden on you:

**Write code that reads like the code around it.** Match the surrounding file's naming, structure, comment density and idiom. A change that is individually reasonable but stylistically foreign is harder to maintain than one that blends in.

- TypeScript, `strict` mode, ES2022 target, CommonJS output. No `any` escapes without a comment explaining why.
- Comments should explain *why*, not *what*. This codebase leans towards comments that record the reasoning behind a non-obvious decision — especially where a simpler-looking alternative is wrong. Those are valued; restating the code in English is not.
- **A comment that states incorrect reasoning is worse than no comment**, because the next reader trusts it. If you change behaviour, update the comment that explains it.

---

## Architecture notes

[`CLAUDE.md`](CLAUDE.md) contains a detailed description of the architecture and is worth reading before a substantial change. The short version:

- `NexusCore` is the single source of truth. UI reads immutable snapshots; changes flow out through observers.
- Config writes are serialised behind `configMutationLock`. Long-running network I/O must **not** run under the lock — capture and validate under it, then dispatch outside.
- Services are isolated according to risk: SSH in-process, scripts in worker threads, serial in a child process (native addon crash isolation). If you add something that can crash the host or hold an OS resource, follow the child-process pattern.
- Storage is `globalState` via the `ConfigRepository` interface, and it is shared across VS Code windows with last-writer-wins semantics. Read the doc comment at the top of `vscodeConfigRepository.ts` before adding a collection.

---

## User-facing text

Error messages, warnings and settings descriptions are part of the product.

- Say what happened, and what the user can do about it. A message that names a remedy is worth three that describe a failure.
- Don't promise what the code does not do. If a limit exists, state it plainly rather than omitting it.
- Match the existing voice: direct, specific, no exclamation marks, no apologising.

If your change adds or alters user-facing behaviour, update `README.md` and `docs/functional-documentation.md` in the same PR.

---

## Commits and pull requests

- **Conventional commit prefixes**: `feat:`, `fix:`, `docs:`, `test:`, `refactor:`, `perf:`, `chore:`, `ci:`. Scope where it helps (`fix(telnet): ...`).
- Write commit bodies that explain the reasoning, not just the change. "Why this, and why not the obvious alternative" is the useful part.
- Keep unrelated reformatting out of the diff.
- Rebase on `main` rather than merging it in, if you're comfortable doing so.

**Do not bump the version.** Leave `package.json` alone. Concurrent pull requests would otherwise collide on that one line, and release timing stays a maintainer decision.

To be concrete about what happens instead, since nothing automates it: the maintainer bumps the patch version in a separate commit when merging your work. There is no merge-time bump in CI — `release.yml` only sets `package.json` to match a tag that already exists at publish time, which is not the same thing. If you see `CLAUDE.md` say that every change pull request bumps the patch version, that rule is addressed to maintainer-authored pull requests, not to yours.

**Never put a line containing only `[release]` in a commit message.** That string on its own line is the live release trigger for this repository — it publishes to the VS Code Marketplace and Open VSX, irreversibly, and a published version can never be withdrawn or re-used.

### What not to commit

- Secrets, tokens, private keys, real hostnames or credentials — including in tests and fixtures.
- Anything under `docs/plans/`, `docs/superpowers/`, `.claude/`, `.specify/`, or `specs/`. These are local-only working notes and are already in `.gitignore`. Exactly **one** file under `specs/` is tracked — `specs/001-scripting-support/contracts/script-api.d.ts` — and the directory around it is still ignored, so do not add siblings to it expecting them to be committed.
- Generated output: `dist/`, `node_modules/`, `*.vsix`, coverage reports.

### New dependencies

Adding a runtime dependency is a decision with a long tail — supply-chain risk, bundle size, maintenance burden, and a native module can break the packaged extension on platforms you don't have. Open an issue first, and be ready to explain why the functionality justifies it and why it can't reasonably be written directly.

---

## What review looks like

Pull requests get an automated review pass and a maintainer review. Expect specific, direct comments about correctness, and expect to be asked to justify design decisions rather than just change them — "why this shape?" is a real question, and "because X breaks when Y" is the answer that ends it.

Changes that touch **credentials, TLS verification, network listeners, file-system access, or anything that spawns a process** get a deliberately harder look, and may be asked for a threat model in the PR description: what an attacker on the network or on the local machine could do with this, and what stops them.

Disagreement is fine and often productive. If you think a review comment is wrong, say so with reasoning — that has changed the outcome before and will again.

Nothing here is meant to be discouraging. Rigour applies to the code, not to the person writing it.

---

## Questions

Open an issue. A question is a legitimate use of the issue tracker, and an unanswered one is a bug in this document.
