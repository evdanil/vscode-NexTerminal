# Nexus Terminal Adoption — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Spec:** `docs/plans/2026-04-14-adoption-design.md`
**Constitution:** `.specify/memory/constitution.md` v1.0.0 (ratified 2026-04-14)

**Goal:** Over 8 weeks, convert the Nexus Terminal marketplace listing from a generic feature list into a zero-footprint Remote-SSH alternative aimed at network engineers, bootstrap the first 5+ public reviews, execute one coordinated community launch, and reach a pre-committed decision at week 8.

**Architecture:** Four sequential phases. Phase 1 = listing surgery (docs + `package.json`, no new runtime code). Phase 2 = internal outreach + one in-app review prompt service gated strictly (TDD, UI/UX reviewed, kill-switch setting). Phase 3 = one blog post + one demo video + one coordinated distribution day. Phase 4 = weekly metrics cadence + pre-committed week-8 decision.

**Tech Stack (the engineering in Task 5 only; all other tasks produce docs/content):**
- TypeScript strict, ES2022, CommonJS (per Constitution Engineering Constraints)
- Vitest + v8 coverage for unit tests (`npm run test:unit`)
- VS Code `globalState` for prompt state (mirrors existing `vscodeColorSchemeStorage.ts` pattern)
- esbuild bundler, no configuration change

**Reviewer gates (per Constitution):**
- Principle II (code review): every code-bearing task ends with a reviewed PR.
- Principle V (UI/UX review): Task 5 adds a sidebar banner — UI/UX reviewer sign-off required before merge.

---

## Phase 0: Pre-flight (Day 1, ~30 min)

### Task 0: Baseline capture and worktree

**Files:**
- Modify: none
- Capture: install count, star count, rating from marketplace listing (for Task 11 baseline)

- [ ] **Step 1: Record current marketplace numbers**

Open `https://marketplace.visualstudio.com/items?itemName=sentriflow.vscode-nexterminal` in a browser. Write down the exact values in a scratch note (to be committed in Task 11):
- Install count: `<record>`
- Average rating / review count: `<record>` (should be 0 / n/a)
- Trend direction from last month: `<record>`

- [ ] **Step 2: Record current GitHub stars**

```bash
gh repo view evdanil/vscode-NexTerminal --json stargazerCount,forkCount
```

Expected: JSON with `stargazerCount` and `forkCount`. Record the number.

- [ ] **Step 3: Create a worktree for this plan**

Per `CLAUDE.md`'s "Feature development uses git worktrees in the `.worktrees/` directory":

```bash
cd /mnt/c/Devel/vscode-NexTerminal
git worktree add .worktrees/adoption-2026-04-14 -b feat/adoption-2026-04-14
cd .worktrees/adoption-2026-04-14
```

Expected: new branch `feat/adoption-2026-04-14` created off `main`. All subsequent edits happen inside this worktree until phase merges back.

- [ ] **Step 4: Verify baseline build passes before any changes**

```bash
npm run compile && npm run test:unit
```

Expected: clean compile, all unit tests pass. If either fails, fix on `main` before continuing.

---

## Phase 1: Marketplace Listing Surgery (Weeks 1–2)

### Task 1: Rewrite `package.json` metadata

**Files:**
- Modify: `package.json` (lines 4 and 19–30 in v2.7.72; re-locate in current version)

**Why this task:** The listing's short description and keyword set are the single most-surfaced strings when a cold user searches the marketplace. Leading with the zero-footprint differentiator beats leading with the feature list.

- [ ] **Step 1: Read the current metadata**

```bash
sed -n '1,40p' package.json
```

Confirm the current `description` field and `keywords` array.

- [ ] **Step 2: Rewrite `description`**

Replace the current `description` value with:

```
Zero-footprint SSH, serial, and port-forwarding client for VS Code. No remote VS Code Server install — works with network devices, jump-host/bastion chains, and serial consoles where Remote-SSH can't go. Drop-in replacement for MobaXterm / SecureCRT.
```

Constraint: keep on one line in JSON (the marketplace renders it as a short subtitle). No embedded newlines.

- [ ] **Step 3: Replace `keywords`**

Replace the existing `keywords` array with:

```json
"keywords": [
  "ssh",
  "serial terminal",
  "port forwarding",
  "no remote-ssh",
  "zero footprint",
  "network engineer",
  "cisco",
  "juniper",
  "arista",
  "iosxe",
  "jump host",
  "bastion",
  "proxyjump",
  "jumpserver",
  "teleport",
  "mobaxterm alternative",
  "securecrt alternative",
  "putty alternative",
  "sftp",
  "terminal macros"
]
```

Constraint: keep `categories` as `["Other"]` — no better-fitting marketplace category exists; do not add speculative categories.

- [ ] **Step 4: Bump patch version**

Per `CLAUDE.md` "Versioning & Releases": every marketplace-tagged commit must bump the patch version. If the current version is `2.7.72`, set it to `2.7.73`.

- [ ] **Step 5: Verify `package.json` parses**

```bash
node -e "JSON.parse(require('fs').readFileSync('package.json'))"
```

Expected: no output (success). Any error = fix the JSON before committing.

- [ ] **Step 6: Commit**

```bash
git add package.json
git commit -m "docs: retarget marketplace description and keywords for network engineers"
```

### Task 2: Rewrite the README hero, comparison table, and FAQ

**Files:**
- Modify: `README.md` (insert hero + comparison + FAQ above the existing "Features" section; preserve the rest as reference)

**Why this task:** 166 lines of feature list is comprehensive but does not sell. A cold visitor needs a 15-second read that answers "What? Who for? Why over Remote-SSH?" before the feature list appears.

- [ ] **Step 1: Replace the current opening (lines 1–5) with the new hero**

Open `README.md`. Replace lines 1–5 with exactly:

```markdown
# Nexus Terminal

**Zero-footprint SSH for VS Code.** No remote VS Code Server install. Works with network devices (Cisco, Juniper, Arista), jump-host chains, and serial consoles where Remote-SSH can't go.

Built for network engineers and anyone who SSHes through a bastion, runs serial consoles, or needs a lightweight MobaXterm / SecureCRT replacement inside VS Code.

![Hero demo — ProxyJump chain to a Cisco device + serial console](media/demos/hero-proxyjump-serial.gif)
```

(The GIF file is produced in Task 3. The `![…]` line can land first; GitHub tolerates the broken image until Task 3 lands.)

- [ ] **Step 2: Insert the comparison table immediately after the hero**

After the hero block, add:

```markdown
## Why Nexus Terminal?

| Capability | Nexus Terminal | Remote-SSH (Microsoft) | MobaXterm | SecureCRT | PuTTY |
|---|---|---|---|---|---|
| Runs inside VS Code | ✅ | ✅ | ❌ | ❌ | ❌ |
| Works with Cisco / Juniper / Arista | ✅ | ❌ (no Node.js on device) | ✅ | ✅ | ✅ |
| No remote install (zero footprint) | ✅ | ❌ (~300 MB VS Code Server per host) | ✅ | ✅ | ✅ |
| Multi-hop jump-host chains | ✅ (ProxyJump, SOCKS5, HTTP CONNECT) | Limited | ✅ | ✅ | Limited |
| Serial consoles (COM/tty) | ✅ (sidecar-isolated, Smart Follow) | ❌ | ✅ | ❌ | Partial |
| Port forwarding (-L / -R / -D SOCKS5) | ✅ | Partial | ✅ | ✅ | ✅ |
| SFTP file explorer | ✅ | via Remote-SSH | ✅ | Paid | ❌ |
| Expect/send macros | ✅ | ❌ | ✅ | ✅ | ❌ |
| Price | Free, Apache-2.0 | Free | Paid (personal license) | Paid | Free |
```

Constraint: every cell must be factually verifiable. Do not mark a competitor ❌ on a capability they actually have; audit each row before publishing.

- [ ] **Step 3: Insert the "Why not Remote-SSH?" FAQ block immediately after the table**

Add:

```markdown
### Why not Remote-SSH?

**Q: Remote-SSH already ships with VS Code. Why install anything else?**
A: Remote-SSH installs ~300 MB of VS Code Server on every remote host the first time you connect. That's fine on a dev box, but it's impossible on a Cisco switch (no Node.js), wasteful on a shared JumpServer bastion, and a recurring storage + security-review cost when every engineer × every device adds another install. Nexus Terminal is a pure SSH/serial/tunnel client — it never touches the remote.

**Q: So this isn't a Remote-SSH replacement?**
A: Correct. Remote-SSH is built to edit remote files and run a VS Code workspace on a remote dev box — use it for that. Nexus Terminal is built to open terminals to anything that speaks SSH, including devices Remote-SSH can't touch.

**Q: Can I use both?**
A: Yes. They address different jobs and do not interfere.
```

- [ ] **Step 4: Verify the rest of the README still begins cleanly**

```bash
sed -n '1,80p' README.md
```

Confirm: hero → comparison → FAQ → existing "Features" section begins in that order. No duplicated H1, no broken headings.

- [ ] **Step 5: Commit**

```bash
git add README.md
git commit -m "docs: lead README with zero-footprint pitch, comparison table, and Remote-SSH FAQ"
```

### Task 3: Capture and wire five README GIFs

**Files:**
- Create: `media/demos/hero-proxyjump-serial.gif`
- Create: `media/demos/smart-follow-com-port.gif`
- Create: `media/demos/sftp-drag-drop.gif`
- Create: `media/demos/macro-expect-send.gif`
- Create: `media/demos/mobaxterm-import.gif`
- Modify: `README.md` (embed the four non-hero GIFs in the existing Features section alongside their described capabilities)

**Tooling:** ScreenToGif on Windows or Peek on Linux. Target per GIF: 3–8 seconds, ≤ 2 MB on disk, ≥ 800 px wide, 12–15 fps. VS Code marketplace strips images > 5 MB silently, so ≤ 2 MB is a safety margin.

- [ ] **Step 1: Prepare a clean demo workspace**

Create a throwaway VS Code profile with: default theme, font size 14, only the Nexus sidebar visible. Pre-seed the extension with 3 sample servers (one reachable, two in a ProxyJump chain), one serial profile with Smart Follow enabled, one SFTP-capable server, and a macro with `triggerPattern` set to a password prompt regex.

This seeding is deliberately ephemeral — delete the workspace after recording so no credentials leak.

- [ ] **Step 2: Record GIF 1 — hero (ProxyJump + Cisco)**

Scenario: open Nexus sidebar → right-click a Cisco-labelled server → **Connect** → terminal opens after 2 jump hops → paste `show running-config | inc interface` → highlight rule fires on interface names. Target length: 6–8 seconds.

Save as `media/demos/hero-proxyjump-serial.gif`. Confirm file size ≤ 2 MB:

```bash
ls -lh media/demos/hero-proxyjump-serial.gif
```

If > 2 MB, re-record at lower fps or shorter duration before continuing.

- [ ] **Step 3: Record GIF 2 — Smart Follow**

Scenario: a connected serial terminal → unplug USB-to-serial adapter → reconnect on a different COM port → Smart Follow silently reattaches. Target length: 7–8 seconds.

Save as `media/demos/smart-follow-com-port.gif`. Verify size.

- [ ] **Step 4: Record GIF 3 — SFTP drag-and-drop**

Scenario: expand SFTP explorer for a connected server → drag a file from one remote directory to another. Target length: 3–5 seconds.

Save as `media/demos/sftp-drag-drop.gif`. Verify size.

- [ ] **Step 5: Record GIF 4 — macro expect/send**

Scenario: SSH connection hits a password prompt → macro with `triggerPattern: "password:"` auto-sends the password → session continues. Target length: 4–5 seconds.

Save as `media/demos/macro-expect-send.gif`. Verify size.

- [ ] **Step 6: Record GIF 5 — MobaXterm import**

Scenario: run `Nexus: Import from MobaXterm` → pick an INI file → folder hierarchy appears in sidebar matching the source. Target length: 4–6 seconds.

Save as `media/demos/mobaxterm-import.gif`. Verify size.

- [ ] **Step 7: Embed the four non-hero GIFs in the existing Features section**

In `README.md`, locate each feature bullet listed below and add the matching GIF on the line directly beneath its paragraph:

- Serial Smart Follow bullet → `![Smart Follow COM port renumber](media/demos/smart-follow-com-port.gif)`
- SFTP File Explorer bullet → `![SFTP drag-and-drop](media/demos/sftp-drag-drop.gif)`
- Terminal Macros / auto-trigger bullet → `![Macro expect/send auto-answering a password prompt](media/demos/macro-expect-send.gif)`
- Import from MobaXterm / SecureCRT bullet → `![MobaXterm INI import](media/demos/mobaxterm-import.gif)`

The hero GIF reference from Task 2 is already in place; confirm it now resolves.

- [ ] **Step 8: Render check**

Open `README.md` in VS Code's built-in preview (`Ctrl+Shift+V`) and scroll. All five images must render. Broken image = wrong path; fix before commit.

- [ ] **Step 9: Commit**

```bash
git add media/demos/ README.md
git commit -m "docs: add five marketplace demo GIFs showing key network-engineer flows"
```

### Phase 1 checkpoint: package, install locally, confirm marketplace preview

- [ ] **Step 1: Package the VSIX**

```bash
npm run package:vsix
```

Expected: a new `vscode-nexterminal-2.7.73.vsix` in the repo root.

- [ ] **Step 2: Install the local VSIX into a clean VS Code instance**

Use the VS Code command `Extensions: Install from VSIX…`. Open the Extensions sidebar, click on Nexus Terminal's details view. Verify:

- Description reads the new zero-footprint pitch.
- README renders: hero → GIF → comparison → FAQ → feature list.
- All five GIFs appear and play.

- [ ] **Step 3: Request code review (Principle II)**

Open a PR from `feat/adoption-2026-04-14` against `main` titled *"Phase 1: marketplace listing surgery (description, keywords, README hero, GIFs)"*. Request review from a second human or run `/coderabbit:review`. Do not merge until review is complete.

- [ ] **Step 4: Merge and tag release**

After review sign-off:

```bash
git checkout main
git merge --no-ff feat/adoption-2026-04-14
git tag v2.7.73
git push origin main --tags
```

Then publish to the marketplace via the project's existing release process.

---

## Phase 2: First-Reviews Bootstrap (Weeks 3–4)

### Task 4: Prepare and send internal outreach

**Files:**
- Create: `docs/adoption/outreach-note.md` (the exact text of the note sent to internal users, committed for transparency; no list of recipients in-repo to protect privacy)

**Why this task:** The first 5 reviews cross the marketplace's "unrated" threshold and unlock social proof for every subsequent visitor. Asking once, honestly, to users with non-trivial experience gets this done in week 3.

- [ ] **Step 1: Build the outreach list locally (not in-repo)**

In a private scratch file, list 15–25 engineers inside your company who have:
- Asked you a question about Nexus Terminal in the last 60 days, OR
- Filed an internal bug/request against it, OR
- Verbally mentioned using it regularly.

Explicitly exclude: people you manage directly (review asks from managers read coercive), people who installed but never gave feedback (no signal), anyone who expressed dissatisfaction without a filed bug (steer them to GitHub first).

- [ ] **Step 2: Draft the outreach note**

Create `docs/adoption/outreach-note.md` with:

```markdown
# Internal Outreach Note — Nexus Terminal

Used: weeks 3–4 of the 2026-04-14 adoption plan.

---

Hi <name>,

You've been using Nexus Terminal for a while now — thanks for the feedback so far. The extension is publicly available on the VS Code Marketplace but doesn't have any reviews yet, which makes it hard for people outside our company to find.

If you've found it useful, an honest review on the marketplace helps a lot:

https://marketplace.visualstudio.com/items?itemName=sentriflow.vscode-nexterminal

If you've hit bugs or want features that aren't there yet, please file an issue instead — I'd rather fix the problem than get a low-star review:

https://github.com/evdanil/vscode-NexTerminal/issues

Either way, thanks.
```

Constraint: no scripting of review text, no prompts about star count, no language suggesting a reward or reciprocation. Honest reviews or none, per the design spec §5.1.

- [ ] **Step 3: Commit the note template**

```bash
git add docs/adoption/outreach-note.md
git commit -m "docs: commit outreach note template for first-reviews bootstrap"
```

- [ ] **Step 4: Send the notes over the next 3 business days**

Send individually (not a mailing list). Personalize one sentence per recipient referencing what you know of their use case — network device access, serial lab work, etc. Do not send more than ~8 per day so responses are manageable.

- [ ] **Step 5: Track responses in a private scratch file**

For each recipient, record: note sent (date), acknowledged (Y/N), reviewed (Y/N), issue filed instead (Y/N). Do not commit this tracker — it contains names.

- [ ] **Step 6: After 10 business days, measure yield**

Count marketplace reviews added since the notes went out. Expected: 5–8. If fewer than 5 by day 10, do not re-send — proceed to Task 5 and 6 anyway; the launch push in Phase 3 will pick up more reviews.

### Task 5: Implement the in-app review prompt (TDD)

**Files:**
- Create: `src/storage/vscodeReviewPromptStorage.ts`
- Create: `src/services/reviewPromptService.ts`
- Create: `test/unit/reviewPromptService.test.ts`
- Modify: `src/ui/nexusTreeProvider.ts` (add an inline banner TreeItem when the service says "show")
- Modify: `src/extension.ts` (instantiate the service, wire it to NexusCore session events)
- Modify: `package.json` (add `nexus.disableReviewPrompt` setting under `contributes.configuration`)
- Modify: `CLAUDE.md` (document the new `nexus.review.*` globalState keys per Principle IV)

**Why this task:** A single, deferrable, one-time prompt drives the cumulative review total up over weeks/months without nagging. Every constraint in this task exists because an over-aggressive prompt earns 1-star reviews instead of 5-star ones.

**Design (from spec §5.2):**

Eligibility predicate (pure function):
```
eligible(state, now) =
    !state.dismissed
 && !setting.disableReviewPrompt
 && state.connectionCount >= 5
 && state.distinctDays.length >= 3
 && (state.snoozedUntil == null || now >= state.snoozedUntil)
```

Lifecycle transitions:
- On new session (SSH / serial / tunnel): increment `connectionCount`, add today's ISO date (`YYYY-MM-DD`) to `distinctDays` (deduplicated). Persist.
- On "Leave a review" button: open marketplace URL, set `dismissed = true`. Persist.
- On "Not now": set `snoozedUntil = now + 30 days`. Persist.
- On "Don't ask again": set `dismissed = true`. Persist.

Storage keys (all under `globalState`):
- `nexus.review.connectionCount`: `number`, default `0`
- `nexus.review.distinctDays`: `string[]` (ISO `YYYY-MM-DD`), default `[]`
- `nexus.review.dismissed`: `boolean`, default `false`
- `nexus.review.snoozedUntil`: `number | undefined` (epoch ms), default `undefined`

- [ ] **Step 1: Create the storage wrapper**

Create `src/storage/vscodeReviewPromptStorage.ts`:

```typescript
import * as vscode from "vscode";

const CONNECTION_COUNT_KEY = "nexus.review.connectionCount";
const DISTINCT_DAYS_KEY = "nexus.review.distinctDays";
const DISMISSED_KEY = "nexus.review.dismissed";
const SNOOZED_UNTIL_KEY = "nexus.review.snoozedUntil";

export interface ReviewPromptState {
  connectionCount: number;
  distinctDays: string[];
  dismissed: boolean;
  snoozedUntil: number | undefined;
}

export interface ReviewPromptStorage {
  read(): ReviewPromptState;
  write(state: ReviewPromptState): Promise<void>;
}

export class VscodeReviewPromptStorage implements ReviewPromptStorage {
  constructor(private readonly context: vscode.ExtensionContext) {}

  read(): ReviewPromptState {
    return {
      connectionCount: this.context.globalState.get<number>(CONNECTION_COUNT_KEY, 0),
      distinctDays: this.context.globalState.get<string[]>(DISTINCT_DAYS_KEY, []),
      dismissed: this.context.globalState.get<boolean>(DISMISSED_KEY, false),
      snoozedUntil: this.context.globalState.get<number | undefined>(SNOOZED_UNTIL_KEY, undefined),
    };
  }

  async write(state: ReviewPromptState): Promise<void> {
    await this.context.globalState.update(CONNECTION_COUNT_KEY, state.connectionCount);
    await this.context.globalState.update(DISTINCT_DAYS_KEY, state.distinctDays);
    await this.context.globalState.update(DISMISSED_KEY, state.dismissed);
    await this.context.globalState.update(SNOOZED_UNTIL_KEY, state.snoozedUntil);
  }
}
```

This mirrors the existing `src/storage/vscodeColorSchemeStorage.ts` pattern.

- [ ] **Step 2: Write the first failing test (ineligible by default)**

Create `test/unit/reviewPromptService.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { ReviewPromptService, type ReviewPromptState } from "../../src/services/reviewPromptService";

function freshState(overrides: Partial<ReviewPromptState> = {}): ReviewPromptState {
  return {
    connectionCount: 0,
    distinctDays: [],
    dismissed: false,
    snoozedUntil: undefined,
    ...overrides,
  };
}

describe("ReviewPromptService.isEligible", () => {
  it("is ineligible by default with zero sessions", () => {
    const service = ReviewPromptService.fromState(freshState(), { disabled: false });
    expect(service.isEligible(Date.now())).toBe(false);
  });
});
```

- [ ] **Step 3: Run the test — verify it fails**

```bash
npx vitest run test/unit/reviewPromptService.test.ts
```

Expected: failure with a module-not-found error (service doesn't exist yet). This is the intended TDD red state.

- [ ] **Step 4: Create the service skeleton to turn the test green**

Create `src/services/reviewPromptService.ts`:

```typescript
export interface ReviewPromptState {
  connectionCount: number;
  distinctDays: string[];
  dismissed: boolean;
  snoozedUntil: number | undefined;
}

export interface ReviewPromptSettings {
  disabled: boolean;
}

const MIN_CONNECTIONS = 5;
const MIN_DISTINCT_DAYS = 3;

export class ReviewPromptService {
  private constructor(
    private state: ReviewPromptState,
    private readonly settings: ReviewPromptSettings,
  ) {}

  static fromState(state: ReviewPromptState, settings: ReviewPromptSettings): ReviewPromptService {
    return new ReviewPromptService(state, settings);
  }

  isEligible(now: number): boolean {
    if (this.settings.disabled) return false;
    if (this.state.dismissed) return false;
    if (this.state.snoozedUntil != null && now < this.state.snoozedUntil) return false;
    if (this.state.connectionCount < MIN_CONNECTIONS) return false;
    if (this.state.distinctDays.length < MIN_DISTINCT_DAYS) return false;
    return true;
  }
}
```

- [ ] **Step 5: Run the test — verify it passes**

```bash
npx vitest run test/unit/reviewPromptService.test.ts
```

Expected: 1 passed.

- [ ] **Step 6: Add the remaining gating tests**

Append to `test/unit/reviewPromptService.test.ts`:

```typescript
describe("ReviewPromptService.isEligible (thresholds)", () => {
  it("is eligible once all thresholds are met", () => {
    const service = ReviewPromptService.fromState(
      freshState({ connectionCount: 5, distinctDays: ["2026-04-14", "2026-04-15", "2026-04-16"] }),
      { disabled: false },
    );
    expect(service.isEligible(Date.now())).toBe(true);
  });

  it("is ineligible if dismissed, regardless of thresholds", () => {
    const service = ReviewPromptService.fromState(
      freshState({
        connectionCount: 100,
        distinctDays: ["2026-04-14", "2026-04-15", "2026-04-16"],
        dismissed: true,
      }),
      { disabled: false },
    );
    expect(service.isEligible(Date.now())).toBe(false);
  });

  it("is ineligible while snoozed", () => {
    const now = 1_700_000_000_000;
    const service = ReviewPromptService.fromState(
      freshState({
        connectionCount: 5,
        distinctDays: ["2026-04-14", "2026-04-15", "2026-04-16"],
        snoozedUntil: now + 1_000,
      }),
      { disabled: false },
    );
    expect(service.isEligible(now)).toBe(false);
  });

  it("is eligible again once snooze expires", () => {
    const now = 1_700_000_000_000;
    const service = ReviewPromptService.fromState(
      freshState({
        connectionCount: 5,
        distinctDays: ["2026-04-14", "2026-04-15", "2026-04-16"],
        snoozedUntil: now - 1,
      }),
      { disabled: false },
    );
    expect(service.isEligible(now)).toBe(true);
  });

  it("is ineligible when the kill-switch setting is on", () => {
    const service = ReviewPromptService.fromState(
      freshState({ connectionCount: 5, distinctDays: ["2026-04-14", "2026-04-15", "2026-04-16"] }),
      { disabled: true },
    );
    expect(service.isEligible(Date.now())).toBe(false);
  });
});
```

- [ ] **Step 7: Run all tests — verify all pass**

```bash
npx vitest run test/unit/reviewPromptService.test.ts
```

Expected: 6 passed.

- [ ] **Step 8: Add the mutation tests (session tracking + lifecycle buttons)**

Append:

```typescript
describe("ReviewPromptService.recordSession", () => {
  it("increments connectionCount and adds today's date once per day", () => {
    const service = ReviewPromptService.fromState(freshState(), { disabled: false });
    service.recordSession(new Date("2026-04-14T10:00:00Z"));
    service.recordSession(new Date("2026-04-14T23:00:00Z"));
    service.recordSession(new Date("2026-04-15T00:05:00Z"));
    const next = service.getState();
    expect(next.connectionCount).toBe(3);
    expect(next.distinctDays).toEqual(["2026-04-14", "2026-04-15"]);
  });

  it("does not record sessions once dismissed (avoids unnecessary writes)", () => {
    const service = ReviewPromptService.fromState(freshState({ dismissed: true }), { disabled: false });
    service.recordSession(new Date("2026-04-14T10:00:00Z"));
    expect(service.getState().connectionCount).toBe(0);
  });
});

describe("ReviewPromptService lifecycle buttons", () => {
  it("dismissPermanently sets dismissed = true", () => {
    const service = ReviewPromptService.fromState(freshState(), { disabled: false });
    service.dismissPermanently();
    expect(service.getState().dismissed).toBe(true);
  });

  it("snooze sets snoozedUntil to 30 days from now", () => {
    const now = Date.UTC(2026, 3, 14, 12, 0, 0);
    const service = ReviewPromptService.fromState(freshState(), { disabled: false });
    service.snooze(now);
    const expected = now + 30 * 24 * 60 * 60 * 1000;
    expect(service.getState().snoozedUntil).toBe(expected);
  });

  it("markReviewed sets dismissed = true (asked once, lifecycle closed)", () => {
    const service = ReviewPromptService.fromState(freshState(), { disabled: false });
    service.markReviewed();
    expect(service.getState().dismissed).toBe(true);
  });
});
```

- [ ] **Step 9: Run — verify all tests fail on the new methods**

```bash
npx vitest run test/unit/reviewPromptService.test.ts
```

Expected: 9 failures on the new methods (`recordSession`, `dismissPermanently`, `snooze`, `markReviewed`, `getState` — none exist yet).

- [ ] **Step 10: Implement the missing methods**

Extend `src/services/reviewPromptService.ts`:

```typescript
const SNOOZE_MS = 30 * 24 * 60 * 60 * 1000;

// inside class ReviewPromptService:

recordSession(when: Date): void {
  if (this.state.dismissed) return;
  const day = toIsoDay(when);
  const distinctDays = this.state.distinctDays.includes(day)
    ? this.state.distinctDays
    : [...this.state.distinctDays, day];
  this.state = {
    ...this.state,
    connectionCount: this.state.connectionCount + 1,
    distinctDays,
  };
}

dismissPermanently(): void {
  this.state = { ...this.state, dismissed: true };
}

snooze(now: number): void {
  this.state = { ...this.state, snoozedUntil: now + SNOOZE_MS };
}

markReviewed(): void {
  this.state = { ...this.state, dismissed: true };
}

getState(): ReviewPromptState {
  return { ...this.state };
}

// top-level helper:
function toIsoDay(when: Date): string {
  const y = when.getUTCFullYear();
  const m = String(when.getUTCMonth() + 1).padStart(2, "0");
  const d = String(when.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}
```

- [ ] **Step 11: Run — verify all tests pass**

```bash
npx vitest run test/unit/reviewPromptService.test.ts
```

Expected: all 9 passed.

- [ ] **Step 12: Add the `nexus.disableReviewPrompt` setting**

Modify `package.json` under `contributes.configuration.properties`:

```json
"nexus.disableReviewPrompt": {
  "type": "boolean",
  "default": false,
  "description": "Suppress the in-app 'Leave a review' banner that can appear in the Nexus sidebar after sustained use. Set to true to turn it off entirely."
}
```

- [ ] **Step 13: Wire the service into `extension.ts`**

In `src/extension.ts`, inside `activate()`:

```typescript
import { VscodeReviewPromptStorage } from "./storage/vscodeReviewPromptStorage";
import { ReviewPromptService } from "./services/reviewPromptService";

// inside activate():
const reviewStorage = new VscodeReviewPromptStorage(context);
const reviewPrompt = ReviewPromptService.fromState(
  reviewStorage.read(),
  { disabled: vscode.workspace.getConfiguration("nexus").get<boolean>("disableReviewPrompt", false) },
);

const persistReviewState = () => reviewStorage.write(reviewPrompt.getState());

context.subscriptions.push(
  nexusCore.onDidChange((event) => {
    if (event?.type === "session-registered") {
      reviewPrompt.recordSession(new Date());
      void persistReviewState();
      treeProvider.refresh();
    }
  }),
);
```

Constraint: emit a typed `session-registered` event from `NexusCore.registerSession` (and serial/tunnel equivalents). If `onDidChange` does not currently carry a typed event payload, extend it minimally — do not refactor the whole observer. Principle III (YAGNI): add only the one event type this task needs.

- [ ] **Step 14: Add the sidebar banner TreeItem**

In `src/ui/nexusTreeProvider.ts`, at the top of `getChildren()` when the request is for the root node:

```typescript
if (this.reviewPrompt?.isEligible(Date.now())) {
  items.unshift(this.createReviewBanner());
}
```

Where `createReviewBanner()` returns a `TreeItem` with:
- Label: *"Help others find Nexus Terminal — leave a review?"*
- Icon: `$(star-empty)`
- Inline context menu with three commands: `nexus.review.leave`, `nexus.review.snooze`, `nexus.review.dismiss`.

Register the three commands in `extension.ts`. Each command calls the corresponding service method, persists state, and refreshes the tree.

- [ ] **Step 15: Run the full unit suite**

```bash
npm run test:unit
```

Expected: all tests pass, coverage not regressed vs. previous baseline.

- [ ] **Step 16: Update `CLAUDE.md` with the new storage keys**

In the `### Storage` section of `CLAUDE.md`, after the existing `nexus.servers`, `nexus.tunnels`, `nexus.serialProfiles` list, add:

```markdown
- Review prompt state keys: `nexus.review.connectionCount`, `nexus.review.distinctDays`, `nexus.review.dismissed`, `nexus.review.snoozedUntil`. Governed by `ReviewPromptService` in `src/services/reviewPromptService.ts`. Kill switch: setting `nexus.disableReviewPrompt`.
```

Per Constitution Principle IV, this change ships in the same PR.

- [ ] **Step 17: Manual smoke test in a Dev Host**

Launch the Extension Development Host (`F5`). In `Developer: Inspect Extension Host > Workspace State`, manually set:
- `nexus.review.connectionCount` = 5
- `nexus.review.distinctDays` = `["2026-04-14","2026-04-15","2026-04-16"]`

Reload the window. Confirm the banner appears in the Nexus sidebar. Click **Not now** → banner disappears. Re-open the sidebar a minute later → banner stays gone (snoozed).

Repeat for **Don't ask again** (banner never returns this session). Repeat for **Leave a review** (opens marketplace URL, banner gone).

- [ ] **Step 18: Request UI/UX reviewer sign-off (Principle V)**

Tag the designated UI/UX reviewer on the PR. They MUST evaluate:
- Banner does not interrupt terminal focus.
- Wording is non-coercive.
- Keyboard accessibility (tab order, screen reader label).
- Dark/light/high-contrast theme behavior.

Address or acknowledge every finding before merging.

- [ ] **Step 19: Commit**

```bash
git add src/storage/vscodeReviewPromptStorage.ts \
        src/services/reviewPromptService.ts \
        test/unit/reviewPromptService.test.ts \
        src/ui/nexusTreeProvider.ts \
        src/extension.ts \
        package.json \
        CLAUDE.md
git commit -m "feat: add gated in-app review prompt service with kill-switch setting"
```

- [ ] **Step 20: Bump, release, publish**

Bump `package.json` version → `2.7.74`. Tag `v2.7.74`. Package VSIX. Publish to marketplace.

### Task 6: Establish daily review + issue monitoring routine

**Files:**
- Create: `docs/adoption/monitoring-checklist.md`

**Why this task:** Review response latency < 48 hours is the leading indicator in the design (§7.2). Without an explicit routine, weeks slip and the signal decays.

- [ ] **Step 1: Write the monitoring checklist**

Create `docs/adoption/monitoring-checklist.md`:

```markdown
# Nexus Terminal adoption monitoring (daily, weeks 3–10)

Run once per business day. 10 minutes max.

1. Open the marketplace listing's review tab. For each new review since yesterday:
   - Positive (≥ 4 star): reply thanking the reviewer, mention one concrete upcoming improvement if honest.
   - Negative (≤ 3 star): reply within 48h. Ask for a GitHub issue with repro. State one concrete thing you'll look at.
2. Open the GitHub issues tab. For each new issue since yesterday:
   - Acknowledge in a comment within 24h (even if "triaging, will follow up").
   - Label it (`bug`, `enhancement`, `docs`, `question`).
   - If it surfaces a review pain point, link the review in the issue body.
3. If a review mentions a fixable bug, open a matching GitHub issue and reference the review URL.
4. At end-of-week, append one line to `docs/adoption/metrics.md`:
   > week N — reviews +X, avg rating Y.Y, issues +Z, closed W.
```

- [ ] **Step 2: Commit and start the routine**

```bash
git add docs/adoption/monitoring-checklist.md
git commit -m "docs: add daily review and issue monitoring checklist"
```

Begin executing the checklist daily.

---

## Phase 3: Community Launch Push (Weeks 5–6)

### Task 7: Write and fact-check the blog post

**Files:**
- Create: `docs/adoption/blog-post.md` (source manuscript — commits make revision history auditable; publish elsewhere as agreed)

**Why this task:** One high-quality long-form post is the only content artifact in this plan. It carries the message into every community channel and lives on as a referral source.

- [ ] **Step 1: Draft the blog post**

Working title: *"I built a VS Code extension that SSHes to 200 Cisco switches without Remote-SSH's 300 MB payload."*

Create `docs/adoption/blog-post.md`. Follow the exact structure from spec §6.1:
1. Cold open with the specific pain (2 paragraphs, concrete numbers).
2. Why Remote-SSH is the wrong tool *here* (factual, no snark).
3. What was built (3–4 screenshots — same GIFs as README, plus any additional).
4. Comparison table (copy verbatim from README to keep the message identical).
5. Install + 60–90 s walkthrough (embed the video from Task 8).
6. Honest roadmap + gaps.
7. Ask for reviews on the marketplace (URL with `?utm=blog-launch`) + GitHub issues.

Target length: 1,200–2,000 words. Short enough to read on a coffee break, long enough to earn trust.

- [ ] **Step 2: Fact-check every claim**

Every number in the post must be verifiable. Specifically:

- **"~300 MB VS Code Server payload"**: launch a fresh remote host, run `code .` via Remote-SSH, measure `~/.vscode-server/` size. Record exact size. If current is materially different (e.g., < 150 MB or > 500 MB), update every instance of "300 MB" in the post, README, and comparison table.
- **"Cisco / Juniper / Arista don't run Node.js"**: confirm with current device OS documentation. If any vendor has shipped a Linux namespace that could host Node, soften to "most production images".
- **JumpServer / Teleport / CyberArk mentions**: confirm the product names and their positioning (bastion) are correct.
- **MobaXterm / SecureCRT / PuTTY license and VS Code integration claims**: verify current vendor positioning, particularly "paid" vs "free" and whether any vendor ships a VS Code extension.

Record the verification evidence in a commit message for future reference.

- [ ] **Step 3: Commit the draft**

```bash
git add docs/adoption/blog-post.md
git commit -m "docs: draft launch blog post with fact-check evidence in message body"
```

- [ ] **Step 4: Peer review (Principle II applied to content)**

Ask one network engineer (ideally from outside your immediate team) to read the draft and flag any factual error or tone problem. Address before publishing.

- [ ] **Step 5: Hold for publication**

The post does not go live until Task 9's coordinated launch day. Keep it in the worktree.

### Task 8: Produce the 60–90 s demo video

**Files:**
- Create: `media/demos/launch-demo.mp4` (source file, committed via Git LFS if > 50 MB, else directly)

**Why this task:** LinkedIn and Twitter native video uploads outperform external links by a wide margin. A silent captioned clip works across every target channel without further work.

- [ ] **Step 1: Script the video shot-by-shot**

Write the beats in `docs/adoption/video-script.md`:

- 00:00–00:15 — ProxyJump 3-hop connect
- 00:15–00:30 — `show running-config` + highlight rules firing
- 00:30–00:50 — Serial Smart Follow surviving a COM port renumber
- 00:50–01:05 — Macro with expect/send auto-answering a password prompt
- 01:05–01:10 — marketplace + GitHub link outro

No voiceover required. Use on-screen captions to narrate each step.

- [ ] **Step 2: Record**

Same clean workspace from Task 3. Record with OBS Studio (Linux/Windows). Output: 1080p, 30 fps, H.264, mp4. Target file size ≤ 50 MB.

- [ ] **Step 3: Add captions**

Any tool that burns captions into the video (Kapwing, ffmpeg + SRT, DaVinci Resolve). Captions must be legible at 480p — LinkedIn downscales aggressively on mobile.

- [ ] **Step 4: Commit**

```bash
git add media/demos/launch-demo.mp4 docs/adoption/video-script.md
git commit -m "docs: add launch-day 90s demo video"
```

- [ ] **Step 5: Upload to YouTube (unlisted)**

Upload as unlisted. Capture the URL and record it in `docs/adoption/blog-post.md` at the embed point.

### Task 9: Coordinate launch-day distribution

**Files:**
- Modify: `docs/adoption/blog-post.md` (publish externally and record the final URL + UTM-tagged marketplace link in the manuscript for traceability)

**Why this task:** One coordinated morning across all channels beats a drip. Drips fragment attention and dilute each channel's signal.

- [ ] **Step 1: Pick the launch weekday**

Pick a Tuesday or Wednesday morning (US Eastern). Avoid Mondays (crowded feeds), Fridays (low engagement), and any day in the week of a major US holiday.

- [ ] **Step 2: Publish the blog post at 07:00 ET**

Publish to whichever host you committed to (own domain / dev.to / Medium / GitHub Pages). Ensure the `?utm=blog-launch` tag is on every marketplace link. Commit the final published URL back into `docs/adoption/blog-post.md` as a front-matter line.

- [ ] **Step 3: Post to r/networking at 09:00 ET**

Title: *"Built a VS Code SSH client that doesn't install 300 MB on every remote host — made it for network work behind JumpServer."*
Body: 3-paragraph TL;DR + link to blog post. No marketplace link in the body (Reddit throttles sellers). Let the blog deliver the click.

- [ ] **Step 4: Post to r/networkengineer and r/cisco at 09:15 ET and 09:30 ET**

Slightly different framing per sub (see spec §6.3). Do not copy-paste; each sub notices.

- [ ] **Step 5: Post to r/sysadmin at 09:45 ET**

Framing: jump host + SFTP + macros + zero remote install.

- [ ] **Step 6: Submit Show HN at 10:00 ET**

Title: *"Show HN: Nexus Terminal — zero-footprint SSH client for VS Code."*
URL: the blog post.
Go once. If it flops, do not resubmit.

- [ ] **Step 7: LinkedIn native video post at 10:30 ET**

Upload the `launch-demo.mp4` natively. Caption: 2 sentences + link to blog. Tag 3–5 network-engineer contacts.

- [ ] **Step 8: Cisco DevNet Exchange / other network communities at 11:00 ET**

Where self-promotion is permitted. One post per community.

- [ ] **Step 9: Commit the published URL**

```bash
git add docs/adoption/blog-post.md
git commit -m "docs: record final published blog URL and launch-day timestamps"
```

### Task 10: 48-hour response vigil + post-launch feedback rollup

**Files:**
- Create: `docs/plans/<launch-week-date>-post-launch-feedback.md` at the end of the 2-week post-launch window (filename literally starts with the launch-week's Monday ISO date, e.g., `2026-05-26-post-launch-feedback.md`).

**Why this task:** Half the adoption lift in launches of this shape comes from how the author handles criticism in real time. Silence after a contentious comment reads as abandonment.

- [ ] **Step 1: For 48 hours after each post, reply to every substantive comment within 2 hours**

Substantive = asks a question, makes a counter-argument, reports a bug, makes a feature request. Skip pure upvote/downvote reactions.

Tone: factual, non-defensive, concede mistakes, thank people by name when they flag a genuine issue.

- [ ] **Step 2: Track comment signal per channel**

In a private scratch file, for each channel record: upvote ratio at 24h and 48h, number of substantive comments, sentiment (positive/neutral/negative).

- [ ] **Step 3: Open GitHub issues for any actionable bug or feature request**

Link back to the source comment. Label appropriately.

- [ ] **Step 4: At end of week 7, compile the post-launch feedback rollup**

Create `docs/plans/<launch-week-date>-post-launch-feedback.md` with sections:
- Per-channel signal summary (upvotes, comments, sentiment).
- Top 3 feature requests (by frequency).
- Top 3 bug reports.
- Anything that invalidates the positioning.

- [ ] **Step 5: Commit**

```bash
git add docs/plans/<launch-week-date>-post-launch-feedback.md
git commit -m "docs: roll up 2-week post-launch feedback by channel and theme"
```

- [ ] **Step 6: Ship one patch addressing the most-mentioned pain point**

Pick the single most-cited bug or feature request. Implement following Constitution Principles I (TDD) and II (review). Mention the fix in the patch release notes, referencing the issue and the blog post comment that surfaced it.

---

## Phase 4: Measurement & Triage (Weeks 0–8, concurrent with Phases 1–3)

### Task 11: Create `docs/adoption/metrics.md` with baselines

**Files:**
- Create: `docs/adoption/metrics.md`

**Why this task:** The week-0 baseline must be recorded before any change ships, otherwise attribution is impossible at week 8.

- [ ] **Step 1: Create the file**

Use the exact values captured in Task 0.

```markdown
# Nexus Terminal adoption metrics

Tracker for the 2026-04-14 adoption plan. See `docs/plans/2026-04-14-adoption-design.md` §7 for target rationale.

| Week | Date | Installs | External installs (est.) | Reviews | Avg rating | GitHub stars | Notes |
|---|---|---|---|---|---|---|---|
| 0 | 2026-04-14 | <value-from-task-0-step-1> | ~0 | 0 | n/a | <value-from-task-0-step-2> | baseline captured before listing surgery |
```

Week 0 row is the first entry. Subsequent weeks append as new rows.

- [ ] **Step 2: Commit**

```bash
git add docs/adoption/metrics.md
git commit -m "docs: record week-0 adoption metrics baseline"
```

### Task 12: Weekly metrics cadence

**Files:**
- Modify: `docs/adoption/metrics.md` (append one row per week)

- [ ] **Step 1: Every Monday morning for 8 weeks**

Check marketplace stats + GitHub stars. Append a new row to the table with current values and a one-line note describing what shipped that week (e.g., "Task 2 merged: README hero live").

- [ ] **Step 2: Commit weekly**

```bash
git add docs/adoption/metrics.md
git commit -m "docs: metrics — week N"
```

### Task 13: Week-8 decision execution

**Files:**
- Modify: `docs/adoption/metrics.md` (add a "Week-8 decision" section below the table)
- Create or modify: `docs/plans/2026-06-09-adoption-phase-2-or-pivot.md` depending on which outcome triggers

**Why this task:** The decision gate is pre-committed in the design (§7.3). Executing it honestly — even if the honest call is "step back" — is the point.

- [ ] **Step 1: Collect the metric snapshot**

At end of week 8, record: total installs, external installs (installs − known internal count), review count, average rating, top subreddit post upvotes, GitHub stars delta vs week 0.

- [ ] **Step 2: Apply the decision gate**

Using spec §7.3:

- **Double down** if: installs ≥ 800 AND reviews ≥ 5 at ≥ 4.0 AND one subreddit post cleared 50 upvotes.
- **Step back** if: external installs < 400 AND reviews < 3.
- **Adjust** otherwise.

Write the decision and the numbers that produced it in `docs/adoption/metrics.md` under a new "Week-8 decision" section.

- [ ] **Step 3: Kick off the next session**

Per spec §8.3, open a new `superpowers:brainstorming` session with inputs:
- `docs/adoption/metrics.md`
- The post-launch feedback rollup from Task 10
- Top 3 themes from reviews and issues

**Double down** → brainstorm Approach 3 (differentiator feature polish): candidate topics listed in spec §8.3.
**Adjust** → brainstorm a narrower-positioning relaunch at week 12.
**Step back** → brainstorm a 5-person user-research call plan before any further investment.

- [ ] **Step 4: Commit**

```bash
git add docs/adoption/metrics.md
git commit -m "docs: week-8 adoption decision — <double-down|adjust|step-back>"
```

---

## Self-Review

**Spec coverage** (against `docs/plans/2026-04-14-adoption-design.md`):

- §4.1 package.json metadata → Task 1 ✅
- §4.2 README hero + comparison + FAQ → Task 2 ✅
- §4.3 Visuals (5 GIFs) → Task 3 ✅
- §4.4 Section 1 acceptance → Phase 1 checkpoint ✅
- §5.1 Internal outreach → Task 4 ✅
- §5.2 In-app review prompt (all constraints incl. kill-switch, gating, UI/UX review) → Task 5 ✅
- §5.3 Feedback-loop hygiene → Task 6 ✅
- §5.4 Section 2 acceptance → Phase 2 (Tasks 4–6 collectively) ✅
- §6.1 Blog post → Task 7 ✅
- §6.2 Demo video → Task 8 ✅
- §6.3 Distribution → Task 9 ✅
- §6.4 Post-launch triage + feedback rollup → Task 10 ✅
- §7 Measurement (metrics.md, leading indicators, decision gate) → Tasks 11–13 ✅
- §8.1 Risks → mitigations embedded across Tasks 2, 5, 7, 13 ✅
- §8.2 Non-goals → encoded as constraints in Tasks 1, 5, 7, 9 ✅
- §8.3 Phase-2 handoff → Task 13 Step 3 ✅
- §8.4 Ownership → weekly commits in Tasks 6, 10, 12 ✅
- §9 Dependencies (Constitution principles, CLAUDE.md update) → Task 5 Steps 15, 16, 18 ✅

**Placeholder scan:** no `TBD`, `TODO`, or "implement later". Two intentional angle-bracket placeholders appear:
- Task 0 Step 1 (`<record>`) — values written down in a scratch note before Task 11 starts.
- Task 11 Step 1 (`<value-from-task-0-step-1>`) — directly quotes what Task 0 captured.

These are not implementer-facing gaps; they are dataflow markers connecting two tasks.

**Type consistency:** service method names and property names used consistently across Task 5 Steps 1–14: `ReviewPromptService`, `ReviewPromptState`, `ReviewPromptSettings`, `fromState`, `isEligible`, `recordSession`, `dismissPermanently`, `snooze`, `markReviewed`, `getState`. Storage class matches (`VscodeReviewPromptStorage`, `ReviewPromptStorage` interface). Setting key `nexus.disableReviewPrompt` is spelled identically in the package.json entry, the service constructor, and `CLAUDE.md` (Task 5 Step 16).

---

## Execution Handoff

Plan complete and saved to `docs/plans/2026-04-14-adoption-implementation-plan.md`.

Two execution options:

1. **Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration. Best for Tasks 1, 2, 5 where code/docs diffs are contained.
2. **Inline Execution** — execute tasks in this session using `superpowers:executing-plans`, batch execution with checkpoints.

Tasks 3, 7, 8, 9, 10 involve work that cannot be automated by any agent (recording your screen, writing a personal blog post in your voice, posting to social channels under your account). Those remain human-executed regardless of which option you pick for the automatable tasks.

**Which approach?**
