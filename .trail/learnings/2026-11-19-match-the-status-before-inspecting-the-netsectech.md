---
title: Match the status before inspecting the columns around it
author: NetSecTech
date: 2026-11-19
branch: feat/highlight-presets
id: l-6b95de5a
scope: repo
status: active
src: agent
touches:
  - CHANGELOG.md
  - README.md
  - docs/functional-documentation.md
  - docs/terminal.md
  - src/ui/highlightRuleEditorHtml.ts
  - test/helpers/highlightRuleEditorHarness.ts
  - test/unit/highlightProfileEditorDom.test.ts
---

## Decided

Start each status rule with the status text and check the preceding columns only at that candidate position. Use bounded lookbehind and require a real nonspace name before treating what precedes an EOS state as a populated Name column.

## Tried and ruled out

Putting the column lookbehind first made the regex inspect many unrelated positions. On a space-filled synthetic span, the Arista preset still had not finished before cancellation despite using only bounded quantifiers. Matching the status first and separating column padding from the optional name brought all three presets under 2 ms per roughly 9 KB span in the local Node probe.

## Watch out

Bounded patterns can still backtrack over overlapping whitespace groups. Exercise long blank spans and padded table rows when changing terminal-wide rules, as well as the expected colors on real-looking output. Nexus only exposes the g and i flags, so explicit line boundaries handle multiple lines in a terminal span.

In the code: src/ui/highlightProfilePresets.ts, test/unit/highlightProfilePresets.test.ts.
