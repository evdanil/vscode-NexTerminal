# Nexus Terminal Adoption Design

**Date:** 2026-04-14
**Status:** Approved (brainstorming phase). Next step: implementation plan via `superpowers:writing-plans`.
**Owner:** Repository owner (`evdanil`)
**Related governance:** `.specify/memory/constitution.md` v1.0.0

## 1. Context

- Nexus Terminal (`sentriflow.vscode-nexterminal`) is a mature VS Code extension at v2.7.72 with 222 commits. Feature surface: SSH, serial consoles, port forwarding (-L/-R/-D), SFTP, jump-host / SOCKS5 / HTTP CONNECT proxies, auth profiles, regex highlighting, macros with expect/send triggers, MobaXterm and SecureCRT import.
- Current installs: ~130, the majority inside the repository owner's company. Zero public marketplace reviews at the start of this plan.
- Adoption goal over the next 3–6 months: **quality signal** — marketplace credibility (listing presentation, first reviews, social proof), not raw install count.
- Primary persona: **network engineer**. Built-in product cues (Cisco legacy-algorithm toggle, multi-hop ProxyJump chains, MobaXterm/SecureCRT import, saved session trees, serial consoles, paste-safe terminal, sidecar-isolated `serialport`) fit this persona tightly; no VS Code extension currently dominates this lane.

## 2. Lead Positioning

> **Zero-footprint SSH client for VS Code — no Remote-SSH 300 MB server payload. The network engineer's MobaXterm / SecureCRT replacement.**

Remote-SSH installs ~300 MB of VS Code server on every remote host. That is (a) impossible on network devices that do not run Node.js (Cisco, Juniper, Arista, and similar), (b) wasteful when reaching devices through JumpServer / Teleport / CyberArk bastions, and (c) a recurring cost at enterprise scale (every engineer × every device). Nexus Terminal never touches the remote.

Secondary personas (devops, sysadmin, embedded) stay addressable via the feature list but MUST stay out of the hero during this push; focus wins the first reviews, dilution does not.

## 3. Strategy

Approach 1 — **Fix the storefront first, then drive traffic.** Four sequential phases:

1. Weeks 1–2: Marketplace listing surgery.
2. Weeks 3–4: First-reviews bootstrap.
3. Weeks 5–6: One coordinated community launch.
4. Week 8: Decision gate (double down / adjust / step back).

Rejected alternatives:
- **Approach 2** (launch without listing cleanup): burns the one launch moment on a listing that does not convert.
- **Approach 3** (differentiator feature polish first): speculative until adoption data exists. Deferred to phase 2 conditional on the week-8 decision.

## 4. Section 1 — Marketplace Listing Surgery (weeks 1–2)

### 4.1 `package.json` metadata

- `categories`: stay `["Other"]` — no better-fitting VS Code marketplace category exists. Discovery must come from keywords and copy.
- `description` (short): rewrite to lead with the zero-footprint differentiator, not the feature list. Draft:
  > *"Zero-footprint SSH, serial, and port-forwarding client for VS Code. No remote VS Code Server install — works with network devices, jump-host/bastion chains, and serial consoles where Remote-SSH can't go. Drop-in replacement for MobaXterm / SecureCRT."*
- `keywords`: replace the generic set with persona-tuned keywords. Draft: `ssh, serial terminal, port forwarding, no remote-ssh, zero footprint, network engineer, cisco, juniper, arista, iosxe, jump host, bastion, proxyjump, jumpserver, teleport, mobaxterm alternative, securecrt alternative, putty alternative, sftp, terminal macros`.
- `displayName`: unchanged — "Nexus Terminal".

### 4.2 README hero rewrite

- Replace lines 1–5 of `README.md` with a three-part hero: one-sentence pitch (zero-footprint / no 300 MB line); one sentence naming network engineers, jump-host users, and serial-console workers explicitly; one animated GIF above the fold.
- Insert a **comparison table** directly below the hero. Rows: Remote-SSH, Nexus Terminal, MobaXterm, SecureCRT, Putty. Columns: VS Code native / Works with Cisco + Juniper / No remote install / Jump host chains / Serial console / Price.
- Insert a **"Why not Remote-SSH?"** 3-Q&A FAQ block immediately after the comparison table.
- Push the existing feature enumeration below hero / comparison / FAQ. It remains as reference, not pitch.

### 4.3 Visuals

Five short GIFs (each 3–8 s, ≤2 MB, captured with ScreenToGif or Peek):

1. Connect to a Cisco device through a 3-hop ProxyJump chain, paste `show running-config`, watch the highlight rule fire on `% Error` and interface counters.
2. Serial Smart Follow surviving a COM port renumber on Windows.
3. SFTP drag-and-drop between two servers.
4. Macro with expect/send auto-answering a password prompt.
5. MobaXterm INI import, folder hierarchy preserved.

Each GIF referenced in the README. The VS Code marketplace renders README raw URLs, so no separate upload is required.

### 4.4 Section 1 acceptance

- A cold visitor on the marketplace listing can, within 15 seconds, answer: What is this? Who is it for? Why pick it over Remote-SSH?
- Listing copy, README, and visuals are consistent on the "zero-footprint for network engineers" frame.

## 5. Section 2 — First-Reviews Bootstrap (weeks 3–4)

### 5.1 Internal outreach

Identify 15–25 internal users with non-trivial usage (people who have asked questions, filed internal issues, or given verbal feedback). Send a short personal note — not a company-wide broadcast — asking for an honest review, with explicit "file bugs on GitHub instead of a low-star review" guidance. Expected yield: 5–8 reviews.

**Never script the review text, never review-swap, never self-review, never review under alts.** Honest reviews or none.

### 5.2 In-app review prompt (one PR, ~3–4 hrs engineering)

A single inline banner in the Nexus sidebar (not a toast, not a modal) that appears after the user has:

- connected ≥ 5 distinct sessions (SSH, serial, or tunnel), AND
- used the extension across ≥ 3 separate days, AND
- never been prompted before.

Buttons: **Leave a review** (opens the marketplace review URL), **Not now** (snoozes 30 days), **Don't ask again** (suppresses permanently).

State lives in `globalState`:
- `nexus.reviewPromptDismissed: boolean`
- `nexus.reviewPromptSnoozedUntil: number` (epoch ms)

Add a kill-switch setting `nexus.disableReviewPrompt` (default false) so a misconfiguration cannot nag.

**Constraints:**
- Never interrupts a terminal session.
- Never shown before the thresholds above.
- UI/UX reviewer gate per Constitution Principle V applies.
- Gating logic (connection count, day count, dismissed flag, snooze) MUST be unit-tested per Principle I.

### 5.3 Feedback-loop hygiene

- Monitor marketplace reviews + GitHub issues daily for 8 weeks.
- Respond within 48 hours to every review. Thank positive ones briefly; for negative ones, ask for a GitHub issue and state what will be fixed.
- When a review surfaces a real bug or pain point, fix it in the next patch release. Reference the fix in the release notes and optionally in a reply to the reviewer.

### 5.4 Section 2 acceptance

- Week 4: ≥ 5 public marketplace reviews, average ≥ 4.0 stars.
- In-app prompt shipped with UI/UX reviewer sign-off and passing unit tests for the gating logic.
- 100 % of reviews replied to within 48 hours.

## 6. Section 3 — Community Launch Push (weeks 5–6)

### 6.1 Primary artifact — one long-form blog post (week 5)

One first-person post, 1,200–2,000 words, published on the owner's domain or on dev.to / Medium / GitHub Pages. Working title:

> *"I built a VS Code extension that SSHes to 200 Cisco switches without Remote-SSH's 300 MB payload."*

Structure:

1. Cold open with the specific pain (2 paragraphs, concrete numbers).
2. Why Remote-SSH is the wrong tool here (short, factual, no snark).
3. What was built instead — introduce Nexus Terminal with 3–4 screenshots.
4. Comparison table (same one as in the README).
5. Install + a 60–90 s walkthrough GIF or embedded video.
6. Honest roadmap and remaining gaps.
7. Ask for reviews and GitHub issues.

**Tone guardrails:** never disparage Microsoft or Remote-SSH. Frame as "different tool for a different job." Network engineering is a small community with long memories for snark.

### 6.2 Demo video (week 5)

One 60–90 s screen recording, no voiceover required (captions work for social reposts). Sequence:

1. Nexus sidebar → ProxyJump 3-hop connect (15 s).
2. `show running-config` + highlight rules firing (15 s).
3. Serial Smart Follow surviving a COM port renumber (20 s).
4. Macro with expect/send answering a password prompt (15 s).
5. Marketplace + GitHub link outro (5 s).

Host on YouTube (unlisted acceptable), embed in the blog post, upload the same file natively to LinkedIn and Twitter (native uploads outperform links on both).

### 6.3 Distribution — one coordinated day, week 6

Post in this order on a single weekday morning, US Eastern time. Post once per channel, answer comments for 48 hours, move on. No re-posting.

- r/networking
- r/networkengineer
- r/cisco
- r/sysadmin
- Hacker News (Show HN) — once only
- LinkedIn personal post with the demo video uploaded natively
- Cisco DevNet Exchange / community forums where self-promotion is permitted

**Explicitly skipped:** paid ads, sponsored content, Product Hunt, Twitter/X (unless a pre-existing audience exists), influencer outreach.

### 6.4 Post-launch triage — weeks 6–8

- Reply to every substantive comment within 48 hours.
- Roll up issues filed in the 2 weeks post-launch into a new file `docs/plans/<launch-week-date>-post-launch-feedback.md` (filename literally starts with the launch-week date in ISO form, e.g., `2026-05-26-…`) and link back to the blog post.
- If a specific feature request appears ≥ 3 times, prioritize it for the next patch release.

### 6.5 Section 3 acceptance

- Blog post published week 6, demo video embedded, distribution completed in a single coordinated day.
- Every substantive comment on every channel replied to within 48 hours.
- Week 8: one patch release addressing the most-mentioned post-launch pain point, with release notes referencing the feedback explicitly.

## 7. Section 4 — Measurement & Success Criteria

### 7.1 Primary metrics (`docs/adoption/metrics.md`, updated weekly)

| Metric | Source | Baseline (week 0) | Target (week 8) |
|---|---|---|---|
| Marketplace installs | marketplace.visualstudio.com stats page | ~130 | 800–1,500 |
| External installs (installs − known internal count) | marketplace stats − internal estimate | near 0 | ≥ 500 |
| Public reviews (count) | marketplace listing | 0 | ≥ 8 |
| Average rating | marketplace listing | n/a | ≥ 4.3 |
| GitHub stars | `github.com/evdanil/vscode-NexTerminal` | current | +100 |

### 7.2 Leading indicators (check twice weekly)

- Review response latency < 48 h (always).
- GitHub issue triage rate ≥ 80 % within 7 days of filing (weeks 5–8).
- Blog referral traffic tracked via a `?utm=blog-launch` tag on the marketplace link.
- Subreddit upvote ratio + top-level comment sentiment (manually classified positive / neutral / negative) per channel.

### 7.3 Week-8 decision gate (pre-committed outcomes)

- **Double down:** installs ≥ 800 AND reviews ≥ 5 at ≥ 4.0 AND one subreddit post cleared 50 upvotes → queue phase 2 (Approach 3).
- **Adjust:** some but not all thresholds hit → rewrite listing hero around the narrower slice that actually resonated, re-run a smaller launch at week 12.
- **Step back:** < 400 external installs AND < 3 reviews → conduct 5 user-research calls with network engineers from the subreddit threads before any further adoption investment.

### 7.4 Explicitly not measured

- In-extension telemetry (no current telemetry exists; adding it for a marketing experiment violates Constitution Principle III and the extension's zero-telemetry trust posture).
- Competitor install counts (out of our control).

## 8. Section 5 — Risks, Non-Goals, Phase-2 Handoff

### 8.1 Risks and mitigations

| Risk | Why it could happen | Mitigation |
|---|---|---|
| HN / subreddit post gets harshly critical | Network engineers are skeptical and a factual error invites pile-on | Fact-check the blog: verify Remote-SSH payload size on current VS Code, device-family claims. Own mistakes publicly and amend |
| Negative early review tanks rating | One 1-star on a 0-review listing = 1.0 average | Sequence Section 2 before Section 3. Do not invert |
| In-app prompt comes off as nagware | Misconfigured thresholds or bug re-prompting dismissed users | UI/UX review gate (Principle V) + unit tests on gating (Principle I) + `nexus.disableReviewPrompt` kill switch |
| Microsoft ships a zero-footprint Remote-SSH mode | Out of our control | Moat is multi-factor: zero-footprint + serial + bastion chains + MobaXterm/SecureCRT import + persona cues. Defensible even if Microsoft matches one factor |
| Launch falls flat | Blog gets 3 upvotes, no pickup | Week-8 decision gate handles. No spiralling |
| Effort creep cannibalizes engineering time | Adoption work expands to fill available time | Hard timebox each sub-task. Cut scope (3 GIFs instead of 5) before extending timeline |

### 8.2 Non-goals (explicit)

- No paid ads, sponsored content, or Product Hunt push.
- No telemetry added to the extension.
- No feature engineering during weeks 1–6 except the in-app review prompt.
- No copy that disparages Microsoft or Remote-SSH.
- No review-swapping, self-reviews, or scripted wording.
- No persona broadening during this push (devops/sysadmin framing stays out of the hero).

### 8.3 Phase-2 handoff (week 8+, conditional on "double down")

If the week-8 gate is "double down," open a fresh brainstorming session — not a continuation of this plan. Inputs:

- `docs/adoption/metrics.md`.
- The post-launch feedback rollup created in §6.4 (dated at launch week).
- Top-3 feature themes aggregated from reviews + GitHub issues.

Candidate phase-2 topics (not committed here, selection deferred to data):

- Centralized configuration / team-shared profiles (enterprise adoption lever).
- Cisco IOS / Juniper Junos snippet libraries (persona deepening).
- JumpServer / Teleport metadata integration (bastion workflow lever).
- PlatformIO handoff (adjacent-persona lever for embedded).
- Microsoft marketplace featured-placement outreach.

### 8.4 Ownership and accountability

- Every sub-task in Sections 4, 5, and 6 tracked as a repo issue or PR referenced by the implementation plan.
- One-line status update appended weekly to `docs/adoption/metrics.md`: *"week N — shipped X, metric Y, next Z."*
- Constitution Principle II (explicit code review) and Principle V (UI/UX review) apply to any code landing from this plan, identical to feature work.

## 9. Dependencies

- **Constitution v1.0.0 (`.specify/memory/constitution.md`, ratified 2026-04-14)** governs any code produced during this plan: TDD for the in-app prompt (Principle I), explicit code review (II), simplicity (III), documentation currency (IV), UI/UX review for any sidebar surface touched (V).
- **`CLAUDE.md`** MUST be updated in the same PR that introduces the `nexus.reviewPromptDismissed` / `nexus.reviewPromptSnoozedUntil` storage keys, to honor Principle IV.
- **`docs/adoption/metrics.md`** is a new file created in week 0 as part of this plan.

## 10. Out of Scope

- Product roadmap changes beyond the in-app review prompt.
- Any pricing / monetization discussion (extension is Apache-2.0 and free; not revisited here).
- Internationalization / localization of listing copy.
- Marketplace analytics instrumentation beyond the UTM tag on the blog's marketplace link.
