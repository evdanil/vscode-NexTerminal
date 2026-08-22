# Handover — 2026-08-22

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

### PR #100 — 2.8.201, the overwrite-warning fix (`claude/highlighting-rules-settings-qhepdg`)

**Status: round-five findings, the post-round Memento-fidelity issue, and the final fail-open
finding are addressed. The implementation commit `b69eb62` received a clean review; four CodeQL
checks are green; and the reviewed PR #100 body plus the replacement issue #101 body are published.
Any later docs-only synchronization commit still requires clean review of the current PR head.
No merge or release has occurred.**

A user hit a false "another VS Code window overwrote your change" warning on an ordinary
EVE-NG re-sync **with no other window open**. Five review rounds found substantive issues:

1. The predicate compared stored content against the *pending* value — true of every genuine
   edit — so the whole detector rested on a reference check.
2. The direct VS Code 1.105 boundary was missed: `ExtensionMemento.update` synchronously
   JSON-clones every object/array update into its cache before returning its persistence promise.
   A caller-owned object therefore cannot be the post-update reference baseline; using it opens
   the reference gate on the next ordinary same-window save. Whole-state cache replacements from
   unrelated writers remain secondary examples of why a replacement does not identify a writer.
3. The baseline was a **live reference the core mutates in place** — `getServers` hands
   `NexusCore` the raw stored rows and `_renameFolderPath`/`removeFolderCascade` rewrite
   `server.group` on them (`nexusCore.ts:1223` documents this). A folder rename produced a
   false warning. Fixed with an immutable JSON snapshot (`lastSeenJson`).
4. The path the fix exists for became the most expensive one — three O(n) passes. Fixed by
   taking one pass over `value` and reusing it. **E3 was revised, not weakened** (see below).
5. The class-level contract and `lastSeenValue` doc still asserted the disproved premise; the
   CHANGELOG still said "loaded" where the code says "read or saved".

**Separate post-round boundary audit:** the test Memento had stored caller values by reference
rather than modelling VS Code's synchronous clone. It now clones first, and the repository
re-reads the actual cache object immediately after `update()` as the reference baseline. This was
the sixth numbered finding in the working notes, not a sixth review round.

**Current predicate** — three conditions, all required:
```
stored !== baselineRef                      // cheap gate; NOT evidence of a foreign write
&& storedJson !== baselineJson              // did content actually diverge?
&& storedJson !== valueJson                 // convergence stays silent (pre-existing rule, test E1)
```

`baselineRef` is re-read from the Memento cache immediately after the prior `update()` call and
before its persistence promise is awaited; it is never the caller-owned update value.
`baselineJson` is the immutable content snapshot, while `valueJson` is the already-computed JSON
for the pending save. If that post-update cache read throws, the detector clears both baseline
entries and logs the fail-open failure, then still awaits the already-returned persistence promise;
the cache-read error cannot replace a persistence rejection.

**E3 was changed deliberately** — it asserted *zero* serialization on the steady-state save
path, which was affordable only while the reference check was believed sound. It now pins one
**repository-added** pass over the pending value on every steady-state save. E3b/E3c pin two
repository-added passes after the cache object was replaced: that pending-value pass plus one over
the stored value. These counts exclude VS Code's own JSON clone and its storage marshalling. The
maintainer approved this trade explicitly. Do not quietly revert it.

**Audit answers:** six actual in-place assignments span server, serial, and local-shell group
mutations. The serialization budget is one repository-added pending-value pass in steady state and
two after reference replacement. The reviewed PR #100 body and replacement issue #101 body are
published; any later docs-only synchronization commit still requires clean review of the current
PR head. No merge or release has occurred.
The genuine residual caveat remains that a change not yet propagated into this host's Memento
cache is undetectable at this layer.

### PR #99 / branch `network-servers-only` @ `2c0b2ed` — Embedded TFTP + DHCP

External contribution from **Brandon Mejia (@kanekitakitos)** — the project's first. He has
confirmed Apache-2.0 inbound licensing and CONTRIBUTING compliance (on #92, carried over).

The live PR head is contributor branch `network-servers-only` at `2c0b2ed`, rebased directly
onto `main` `842057f` and currently reported clean/mergeable. Its twelve patches are
stable-patch-ID-identical to the former `claude/network-servers` history through `a9247f3`;
authorship was preserved. Retain `a9247f3` only as the pre-rebase verification source.

**Verification status:** `6577 passed / 2 skipped` is the independently reproduced pre-rebase
result. `6538 passed / 29 failed / 13 skipped` is contributor-reported for the current head. The
6,580 total reconciles, but no CI/check run verifies that result or the attribution of the
failures.

Eight follow-up fixes on the pre-rebase exact head covered the in-flight byte bound, 16-bit block
sequencing, synchronous transfer-slot reservation/release, start/bind rejection, served-root
validation, refusal of unsupported `netascii`, daemon child teardown, and effective PathGuard
symlink tests. Evidence remains weak or locally unprovable for throw-path slot release, the
cast-driven burst test, signal-specific teardown, and the macOS realpath assertion on Linux.
Current-head review must also inspect the additional post-wrap memory-bound fix and the deliberate
existing-test change from `netascii` to `octet` for option round-trip coverage.

**Local Servers:** the six files and 2,063 lines remain intact on fork `main` and
`feature/local-servers` at `6114ded`; no separate PR existed at audit time.

Keep current-head review and PR-description reconciliation open. Do not mutate issue #101 or
PR #99 remotely from this work.

---

## 3. TODO, in order

1. **#100:** require current-head Codex review and loop until clean. **Then ask the maintainer
   before merging or releasing.**
2. **#100:** merge with the `[release]` marker → 2.8.201. Verify the pipeline's *individual*
   publish steps (Marketplace + Open VSX), not just the top-level green.
3. **#99:** review the current `network-servers-only` head and reconcile the PR description.
   The current-head contributor-reported test result is not independently verified; do not
   dismiss or attribute its failures without evidence.
4. **#99:** Codex loop until clean. This is an unauthenticated network daemon — do not
   short-circuit it.
5. **#99:** write the feature's CHANGELOG entry (he correctly did not, per CONTRIBUTING) and
   bump the version. Then ask before merging.
6. **Local Servers:** if its separate work is resumed, start from the intact six files on fork
   `main` / `feature/local-servers` at `6114ded`; no separate PR existed at audit time.

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
- **`npm install` first on `network-servers-only`.** It adds a new runtime dependency (`dhcp`),
  and a worktree carrying stale `node_modules` fails the build with
  `Could not resolve "dhcp"` — which looks like a code defect and is not.
- Verification is `npm run build` then `npm test`. The full suite is ~6250 tests / 207 files.
  **~23 failures in `test/integration/scripts/*` are pre-existing flakes** under coverage load —
  they pass in isolation on `main` too. Confirm any failure is one of those before dismissing it.

---

## 5. Recurring failure modes in this work

Recorded because they recurred despite being known:

1. **Fixing the instance, not the claim.** Five rounds on #100 and eight on #95 came from
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
- **Issue #101 was updated from the reviewed handover after `b69eb62` received a clean review.**
  Keep the two sources semantically synchronized: future changes to this handover must update the
  issue body as well.
- The filename is stable rather than date-stamped so successive handovers replace it instead of
  accumulating. The date at the top is the thing to trust.
