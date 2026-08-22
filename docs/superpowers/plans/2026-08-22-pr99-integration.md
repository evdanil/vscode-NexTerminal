# PR #99 Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Integrate the reviewed PR #99 hardening with current `main`, produce final evidence and prose, and prepare—but do not publish—version `2.8.202`.

**Architecture:** Run subsystem plans sequentially on the maintainer branch, then merge current `origin/main` without rewriting contributor history. Resolve semantic overlaps, run clean-install/full verification, and make one maintainer-owned version/changelog commit only after code review is clean.

**Tech Stack:** Git, npm, TypeScript, Vitest, esbuild, VS Code extension packaging.

**Spec:** `docs/superpowers/specs/2026-08-22-pr99-network-server-hardening-design.md`

## Global Constraints

- Do not force-push or modify the contributor's branch.
- Do not publish `2.8.202`; release needs separate authorization.
- Preserve all contributor commits, authorship, and author tags.
- Merge current `origin/main`; do not reuse published version `2.8.201`.
- Every shell command segment uses `rtk`.

---

### Task 1: Reconcile all subsystem review gates

**Files:**
- Read: the TFTP, DHCP, and daemon plan verification reports and commits.
- Create: `.superpowers/sdd/2026-08-22-pr99-hardening/final-reconciliation.md`

- [ ] **Step 1: Verify commit and review inventory**

Record each task commit, red/green/mutation evidence, reviewer verdict, resolved
finding, and remaining platform limitation. Reject integration if any task lacks
both spec-compliance and quality approval.

- [ ] **Step 2: Run combined network-server suite**

```bash
rtk npx vitest run test/unit/networkServers test/integration/networkServers
rtk npm run compile
rtk npm run build
```

Record exact totals and exit codes.

### Task 2: Merge current main and resolve semantic overlaps

**Files:**
- Merge: current `origin/main` into `codex/pr99-review`.
- Inspect: `src/extension.ts`, `src/storage/vscodeConfigRepository.ts`, `package.json`, `package-lock.json`, `CHANGELOG.md`.

- [ ] **Step 1: Refresh and prove pre-merge identity**

```bash
rtk git fetch origin main
rtk git status --short
rtk git rev-parse HEAD
rtk git rev-parse origin/main
rtk git merge-tree --write-tree origin/main HEAD
```

Require clean status and record the merge-tree result.

- [ ] **Step 2: Merge without rewriting history**

```bash
rtk git merge --no-ff origin/main -m "Merge main into PR 99 integration"
```

Resolve conflicts with `apply_patch`. Confirm PR #100's corrected guarded
configuration writes and notification text remain, while PR #99 network-server
registrations/config reads remain.

- [ ] **Step 3: Run semantic-overlap tests**

```bash
rtk npx vitest run test/unit/vscodeConfigRepository.test.ts test/unit/networkServers test/integration/networkServers
rtk npm run compile
```

Commit conflict resolutions only if the merge commit did not contain them.

### Task 3: Run clean-install and unrestricted verification

- [ ] **Step 1: Verify patch application from a fresh temporary worktree**

Create a temporary worktree at integration HEAD, run `rtk npm ci`, compile,
build, and confirm `patch-package` reports `dhcp@0.2.20` applied. Record the
exact worktree path; remove only that worktree afterward.

- [ ] **Step 2: Run the unrestricted suite once**

```bash
rtk npm test
```

Record exact file/test/pass/fail/skip/coverage totals. Rerun any failure by file
before attributing it.

- [ ] **Step 3: Run dependency and artifact checks**

```bash
rtk npm audit --omit=dev
rtk npm audit
rtk npm run build:production
rtk npm run smoke:bundle
rtk git diff --check
rtk git status --short
```

Production audit must be clean. Document development-only advisories separately.

### Task 4: Add the maintainer version and changelog commit

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Write the 2.8.202 changelog entry**

Summarize embedded TFTP/DHCP servers, profile/settings integration, child-process
isolation, audited dependency patching, RFC-correct option negotiation,
bounded admission/windows/lease allocation, and validated lifecycle/RPC
boundaries. Do not claim a release date or publication.

- [ ] **Step 2: Set both root versions to 2.8.202**

Use `apply_patch` for `package.json` and the lockfile root/package entry. Do not
run an automatic version command that creates a tag.

- [ ] **Step 3: Verify and commit**

```bash
rtk npm run compile
rtk npx vitest run test/unit/networkServers test/integration/networkServers
rtk git diff --check
rtk git add package.json package-lock.json CHANGELOG.md
rtk git commit -m "chore: prepare 2.8.202 network servers"
```

### Task 5: Refresh PR evidence and request final review

**Files:**
- Create: `.superpowers/sdd/2026-08-22-pr99-hardening/pr99-body-final.md`
- Update: `docs/HANDOVER.md` only after local evidence is final.

- [ ] **Step 1: Draft exact PR prose locally**

Include contributor credit, exact head, architecture, security model, dependency
patch rationale, exact final test totals, platform limitations, current-main
integration, version 2.8.202 preparation, and explicit statement that merge and
release are separate maintainer decisions.

- [ ] **Step 2: Run final independent review**

Use a fresh reviewer for the complete `origin/main...HEAD` diff. Require no P0/
P1 findings and resolve actionable P2 findings or record an explicit maintainer
ruling.

- [ ] **Step 3: Update handover and report readiness**

Record commits, exact commands/results, unresolved platform-only limits, and
the next authorized remote action. Do not push, edit PR #99, or merge until the
user explicitly authorizes that external mutation.
