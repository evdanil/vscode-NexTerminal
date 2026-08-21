# Handover — 2026-08-21

Written for the agent picking this up. `main` is at **`842057f` / 2.8.200**, released.

---

## 1. Standing rules — read before doing anything

These are not preferences. Breaking them has consequences that cannot be undone.

- **Releasing is opt-in and only on the maintainer's explicit say-so.** A merge commit
  containing a line that is exactly `[release]` publishes to the VS Code Marketplace and
  Open VSX **irreversibly**. A published version can never be withdrawn or re-used.
  Never add that marker on your own initiative.
- **Every change PR bumps the patch version** in `package.json`. Merging does not release.
- **Never write the literal string `[skip release]`** — it does nothing and cannot match
  the opt-in marker.
- **Do not edit published CHANGELOG entries.** They ship inside installed VSIXs; editing
  them makes the repo disagree with what users have. Corrections go in a *new* entry that
  names which claims it replaces.
- **Designated branch:** `claude/highlighting-rules-settings-qhepdg`. Do not push to other
  branches without explicit permission. `claude/network-servers` was authorised separately.
- **Never use `NODE_TLS_REJECT_UNAUTHORIZED`** — it is process-global and the extension host
  is shared with every other installed extension.
- **Do not dismiss CodeQL alerts** on the maintainer's behalf. There is no code-scanning
  tooling in this session anyway.
- **Local-only, never commit:** `docs/plans/`, `docs/superpowers/`, `.claude/`, `.specify/`,
  `specs/*` (one whitelisted file: `specs/001-scripting-support/contracts/script-api.d.ts`).
  This file is a deliberate exception, committed on the maintainer's explicit instruction —
  see §7.
- **No model identifiers** in commit messages, PR titles/bodies, code comments, or anything
  pushed to the repository.

### The testing standard, which is enforced here

> A test must fail against the specific wrong implementation it exists to prevent.

Not "a test that passes". Write it, apply the broken implementation, **confirm it goes red**,
restore. Report the mutation result. This repo has been bitten twice by tests that looked
like guards and passed against the bug — `pathGuard.test.ts:243` was one, using a shallow
path where the correct and broken implementations behave identically.

---

## 2. Open work

### PR #100 — 2.8.201, the overwrite-warning fix (`claude/highlighting-rules-settings-qhepdg` @ `07fd600`)

**Status: awaiting Codex round five. Verified 6256/6256, build clean. Intended to release once clean.**

A user hit a false "another VS Code window overwrote your change" warning on an ordinary
EVE-NG re-sync **with no other window open**. Four Codex rounds so far, all real:

1. The predicate compared stored content against the *pending* value — true of every genuine
   edit — so the whole detector rested on a reference check.
2. That reference check's premise was false. `Memento.update` rewrites the extension's whole
   key/value blob, and ~9 writers outside `VscodeConfigRepository` disturb it
   (`extension.ts:848`,`:1010` tree collapse state; `settingsGuardController.ts:248,283,649,705`;
   `vscodeColorSchemeStorage.ts:17`; `extension.ts:255`,`:395`).
3. The baseline was a **live reference the core mutates in place** — `getServers` hands
   `NexusCore` the raw stored rows and `_renameFolderPath`/`removeFolderCascade` rewrite
   `server.group` on them (`nexusCore.ts:1223` documents this). A folder rename produced a
   false warning. Fixed with an immutable JSON snapshot (`lastSeenJson`).
4. The path the fix exists for became the most expensive one — three O(n) passes. Fixed by
   taking one pass over `value` and reusing it. **E3 was revised, not weakened** (see below).
5. The class-level contract and `lastSeenValue` doc still asserted the disproved premise; the
   CHANGELOG still said "loaded" where the code says "read or saved".

**Current predicate** — three conditions, all required:
```
stored !== baseline                        // cheap gate; NOT evidence of a foreign write
&& JSON(stored) !== JSON(baseline)         // did content actually diverge?
&& JSON(stored) !== JSON(value)            // convergence stays silent (pre-existing rule, test E1)
```

**E3 was changed deliberately** — it asserted *zero* serialization on the steady-state save
path, which was affordable only while the reference check was believed sound. It now pins
**exactly one** pass per save and never both sides; E3b/E3c cover the replaced-reference and
warning paths. The maintainer approved this trade explicitly. Do not quietly revert it.

**Open questions put to Codex, unanswered:** are there *other* in-place mutators of
handed-out rows? Is the serialization budget right when re-derived from the code rather than
from my tests? Is the PR description stale after four rounds?

### PR #99 / branch `claude/network-servers` @ `a9247f3` — Embedded TFTP + DHCP

External contribution from **Brandon Mejia (@kanekitakitos)** — the project's first. He has
confirmed Apache-2.0 inbound licensing and CONTRIBUTING compliance (on #92, carried over).

We took over the remaining fixes with his knowledge (told on #99 before the work started).
**We branched from his head, so his four commits and authorship are intact** — verify with
`git merge-base --is-ancestor 500e525 origin/claude/network-servers`. It merges as his feature.

**Eight fixes pushed on top of his commits**, one per finding:

| Commit | Fix |
|---|---|
| `95083d5` | P1 — bound the negotiated window's in-flight bytes |
| `52f27e5` | P1 — 16-bit block-number sequence comparison |
| `75a464f` | P1 — reserve transfer slot synchronously, release on every path |
| `6875ccc` | P1 — a start that cannot bind must reject, not report success |
| `d876f47` | P2 — validate the served root at startup |
| `e510c82` | P2 — refuse `netascii` rather than serving raw bytes |
| `f53fefa` | P2 — kill the daemon child that never reported ready |
| `a9247f3` | make the PathGuard symlink guards actually bite |

**Verification — reproduced independently, not taken on trust.** The agent reported build
clean and 6577 passed / 2 skipped (229 files); I re-ran it on a fresh checkout of the branch
and got **the identical numbers**. The pre-existing `test/integration/scripts/*` flakes did not
surface in either run, so there is nothing to dismiss. Every mutation the agent reports was run
by editing source in place, running the suite, and restoring.

**One trap when verifying:** the first build I ran **failed** with
`Could not resolve "dhcp"` at `DhcpEngine.ts:46`. That is *not* a code defect — it is the new
runtime dependency missing from a stale `node_modules`. Run `npm install` first.

**Caveats the agent disclosed — treat these as open, not closed:**
- The `finally` that releases a reserved slot on a **throw** out of `admitNewRequest` has
  **no test**. Every failure path currently `return`s, so a deterministic throw could not be
  constructed without contorting the fixture. Its first attempt at this mutation *passed both
  ways* and it replaced it — but this specific path is unguarded.
- The `maxTransfers` burst test drives `handleMessage` through an `as unknown as` cast, because
  a real socket cannot deliver a deterministic burst. The property under test is exactly "every
  request runs its synchronous prefix before any resumes".
- Removing **only** the SIGTERM from daemon teardown still passes — the SIGKILL escalation kills
  the child inside the test window. The tests assert "the process dies", not by which signal.
- `pathGuard.test.ts:61` (the macOS `realpathSync` assertion) **cannot be mutation-demonstrated
  on Linux** — both forms pass. It is a portability fix with no local proof.

**Two things the agent changed beyond the brief, both flagged by it rather than slipped in:**
- It found an *additional* bug in `produceNextSendPackets`: after a block-number wrap its window
  bound stopped bounding, draining the rest of the file into memory in one call. Same root cause
  as P1-3, fixed and tested.
- It changed an existing test, `"WRQ netascii with options … round-trip"`, to round-trip `octet`,
  since `netascii` is now refused. What that test covers (the option round-trip) is untouched.
  This is a behaviour change, not a quiet weakening — but review it as one.

**Design decisions worth knowing:**
- `MAX_IN_FLIGHT_BYTES = 1 MiB`. `windowsize` is **clamped**, not rejected (RFC 2347 §2 /
  RFC 7440 §3 permit the server to answer lower). `blksize` is untouched — that is the client's
  MTU choice. The clamp lives in `validateOptions` because that is the only place option strings
  become numbers, so it lands *before* the OACK is built; clamping later would answer with one
  window and serve another.
- Mod-65536 comparison costs one block of window width for one round after each wrap. Never a
  stall, never an over-fill.

**Why those P1s existed and we nearly missed them:** the first two reviews (mine, and a
commissioned expert review) both aimed at `PathGuard`, because that is where the PR's history
was. They verified those fixes by executing the attacks and found no escapes — and
"no escapes found" then read as a conclusion about the feature when it was only a conclusion
about one file. Codex looked at the transfer engine, adapter error paths and daemon lifecycle,
which nobody had examined, and found four P1s including an unauthenticated remote DoS
(`blksize` 65464 × `windowsize` 65535 ≈ 4.3 GB allocated before a byte is sent; nothing bounded
the product). **Lesson: scope reviews by surface, not by history.**

---

## 3. TODO, in order

1. **#100:** read Codex round five, verify each finding against the code, fix, push, re-nudge.
   Loop until clean. **Then ask the maintainer before merging.**
2. **#100:** merge with the `[release]` marker → 2.8.201. Verify the pipeline's *individual*
   publish steps (Marketplace + Open VSX), not just the top-level green.
3. **#99:** verify the eight fixes independently — do not trust the agent's report or mine.
   Re-run the mutation checks, especially the four the agent flagged as weak or unprovable
   (see its caveats above). **Its first attempt at one mutation passed both ways** and it
   caught that itself; assume there may be another it did not catch.
   **`npm install` before building** — see §4.
4. **#99:** rebase `claude/network-servers` onto `main`. **`README.md` and `package.json` will
   conflict — that is our mess**, caused by the 2.8.200 retitle landing after Brandon branched.
   Resolve it ourselves; do not ask him to.
5. **#99:** Codex loop until clean. This is an unauthenticated network daemon — do not
   short-circuit it.
6. **#99:** write the feature's CHANGELOG entry (he correctly did not, per CONTRIBUTING) and
   bump the version. Then ask before merging.
7. **Ask Brandon about Local Servers** — ~2,063 lines, 12 commands, 5 settings keys, its own
   globalState collection. He read "split out" as *remove*, not *raise separately*, so it is
   in limbo and no PR exists. He may be sitting on finished work believing it was rejected.

### Deferred, recorded on #95 rather than lost

1. **Serialise the six unlocked config writers** — or establish they are safe.
   `tunnelCommands.ts:406,450`, `serialCommands.ts:915,924`, `localShellCommands.ts:807,813`
   call `core.addOrUpdate*` directly with no `configMutationLock`. `addOrUpdate*` is
   read-modify-write over the whole collection and persists the entire list, so two concurrent
   calls can lose a write. **Highest-value of these four.**
2. Remove `external: ["vscode"]` from the `scriptWorker` esbuild entry so the build actually
   enforces worker isolation (`serialSidecarWorker` already does; `scriptWorker` does not).
3. Automate the merge-time version bump, or knowingly keep it manual.
4. Reconcile the CLAUDE.md / CONTRIBUTING versioning split once (3) settles.

### Maintainer-side, not ours

- Dismiss the CodeQL `js/disabling-certificate-validation` alert as Won't fix. Justification
  text was drafted: the TLS opt-in is per-source, off by default, never process-global.
- Test EVE-NG Community node connectivity + Start/Stop.
- Decide on `dhcp@0.2.20` — pinned exactly, but unmaintained since 2020 and parsing untrusted
  LAN input in a process that may hold port 67. Brandon reimplemented most of what it was for;
  vendoring the used subset is a live option.
- Brandon's 43 `@author kanekitakitos` tags. No other file in the repo uses `@author`. **We
  deliberately did not remove them** — his name on his work, his call.

---

## 4. How this project works

- **Every change goes through Codex.** Comment `@codex review` on the PR. Ask it specific,
  falsifiable questions rather than "please review" — the sharpest findings came from naming
  the thing you are least sure of.
- **Verify the verdict is on the current head.** Codex has landed on stale commits three times
  here. Check `commit_id` on the review before believing "clean".
- **Do not merge before the review returns.** 2.8.199 shipped with three factual errors because
  a review was requested and then not waited for.
- Expert reviews via `Agent` (Opus or Fable) in isolated worktrees for implementation and
  adversarial review; Codex is the gate.
- **`npm install` first on `claude/network-servers`.** It adds a new runtime dependency (`dhcp`),
  and a worktree carrying stale `node_modules` fails the build with
  `Could not resolve "dhcp"` — which looks like a code defect and is not.
- Verification is `npm run build` then `npm test`. The full suite is ~6250 tests / 207 files.
  **~23 failures in `test/integration/scripts/*` are pre-existing flakes** under coverage load —
  they pass in isolation on `main` too. Confirm any failure is one of those before dismissing it.

---

## 5. Recurring failure modes in this work

Recorded because they recurred despite being known:

1. **Fixing the instance, not the claim.** Four rounds on #100 and eight on #95 came from
   repairing what the reviewer pointed at and leaving identical claims standing elsewhere.
   *Sweep for the claim across `src/`, `docs/`, `CLAUDE.md`, `CHANGELOG.md`.*
2. **Describing async lifecycle from the happy path** rather than following what the settle
   handler awaits, which catch swallows, which loop does what.
3. **Asserting mechanism not executed.** Distinguish "read from the code" from "ran it".
   Several claims survived review by sounding plausible.
4. **Prose about code gets less scrutiny than code.** Every #98/#100 finding was in prose
   describing correct code. Release notes need the same rigour as the diff.
5. **Scoping a review by history instead of by surface** — see §2, PR #99.

---

## 6. Key file map

| Concern | Location |
|---|---|
| Cross-window overwrite detection | `src/storage/vscodeConfigRepository.ts` (`guardedUpdate`) |
| In-place row mutation (the trap) | `src/core/nexusCore.ts:1223`, `_renameFolderPath` |
| Release trigger | `.github/workflows/auto-release.yml` (`^[[:space:]]*\[release\][[:space:]]*$`) |
| TFTP sandbox | `src/services/networkServers/tftp/engine/PathGuard.ts` |
| TFTP transfer state | `.../engine/TransferSession.ts`, `TftpEngine.ts` |
| Daemon bridge | `src/services/networkServers/daemonHost.ts` |
| Status poll warm-up | `src/services/inventory/inventoryStatusPoll.ts` (§4.12.6 in functional docs) |

---

## 7. About this file

Committed to `docs/HANDOVER.md` on the maintainer's explicit instruction, after the conflict
was raised twice: internal planning docs are normally local-only (`CLAUDE.md`, and
`.gitignore:160` excludes `docs/plans/`). The exception was made because a gitignored file dies
with its container and would never reach a fresh agent.

Placement notes for whoever maintains it:

- `docs/**` is listed in `.vscodeignore`, so this does **not** ship in the VSIX. No user-facing
  impact.
- It is under `docs/` rather than `docs/plans/` deliberately. A tracked file inside a gitignored
  directory is a trap — it survives `git clean` inconsistently and misleads anyone who assumes
  the directory is ignored.
- The same content is mirrored at **issue #101**, which is where it was published first. If you
  update one, update the other or delete the stale copy. Two sources of truth is worse than one
  in the wrong place.
- The filename is stable rather than date-stamped so successive handovers replace it instead of
  accumulating. The date at the top is the thing to trust.
