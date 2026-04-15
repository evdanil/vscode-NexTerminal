# 2026-04-15 — Scripting support

**Status:** implemented on branch `001-scripting-support`, targeted for release `v2.8.0`.

The canonical design documents live in `specs/001-scripting-support/` (spec-kit artifacts; excluded from the public repo via `.gitignore`):

- `spec.md` — user stories (US1–US5), functional requirements (FR-001…FR-031), success criteria, edge cases.
- `plan.md` — technical context, constitution check, project structure.
- `research.md` — 12 design decisions (RES-01..RES-12) + codebase verification.
- `data-model.md` — runtime entity definitions.
- `contracts/` — authoritative TypeScript types (`script-api.d.ts`), header schema, settings contract, runtime event contract.
- `quickstart.md` — 5-minute user walkthrough.
- `tasks.md` — 62 implementation tasks, marked complete as they land.

## Summary

Introduces a workspace-scoped JavaScript scripting runtime for multi-step automation against SSH and Serial sessions. Each script runs in its own `node:worker_threads` Worker with an async `expect` / `send` API. The runtime reuses existing PTY output observers and VS Code modal dialogs; macros on the script's session are suspended for the run by default and restored on any exit path. IntelliSense is auto-seeded in the workspace on first script command.

## Relationship to prior plans

Supersedes the repo-root `scripting_support_plan.md` input draft. That draft was decomposed into the spec-kit artifacts above and removed.
