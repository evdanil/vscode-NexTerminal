# First-Time User UX Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or equivalent task-by-task execution. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Improve Nexus Terminal for first-time and low-VS Code-experience users by making core workflows discoverable, task-oriented, safer, and easier to diagnose.

**Architecture:** Keep changes inside existing VS Code contribution points, tree providers, command handlers, and webview renderers. Avoid new frameworks and avoid broad UI rewrites; add small, testable primitives that improve the current views.

**Tech Stack:** TypeScript, VS Code extension API, existing webview HTML renderers, Vitest unit tests, `package.json` contribution schema.

---

## Global Execution Rules

- Base branch: `feature/first-time-user-ux`.
- Do not work on `main`.
- Every implementation chunk gets its own branch and worktree under `.worktrees/`.
- Coder agents use model `gpt-5.5` with high reasoning.
- Review agents use model `gpt-5.5` with xhigh reasoning.
- New code/review agents must not use MCP servers, `tool_search`, `list_mcp_resources`, `list_mcp_resource_templates`, or `read_mcp_resource`.
- Every shell command in this repo must be prefixed with `rtk`.
- Each chunk branch must be reviewed before merging into `feature/first-time-user-ux`.
- Merge chunks back into the feature branch with `--no-ff` unless a conflict makes a normal merge clearer.
- Do not bump package version in chunk branches.

## Baseline Already Verified

- Worktree: `.worktrees/first-time-user-ux`
- Branch: `feature/first-time-user-ux`
- `rtk npm install` completed.
- `rtk npm run compile` passed.
- `rtk npm run test:unit` passed: 86 files, 1261 tests.

## Chunk Topology

| Chunk | Branch | Worktree | Primary Outcome |
| --- | --- | --- | --- |
| 1 | `feature/ftux-onboarding-actions` | `.worktrees/ftux-onboarding-actions` | First-run flow, profile quick actions, stronger empty states |
| 2 | `feature/ftux-connection-diagnostics` | `.worktrees/ftux-connection-diagnostics` | Test Connection command with actionable SSH diagnostics |
| 3 | `feature/ftux-settings-security` | `.worktrees/ftux-settings-security` | Simpler settings information architecture and Security & Data section |
| 4 | `feature/ftux-file-operations` | `.worktrees/ftux-file-operations` | Safer SFTP upload/download/delete progress and summaries |
| 5 | `feature/ftux-templates-help` | `.worktrees/ftux-templates-help` | Script/macro templates and inline task help |
| 6 | `feature/ftux-final-integration-docs` | `.worktrees/ftux-final-integration-docs` | Docs, contribution polish, final consistency pass |

## Chunk 1: First-Run Flow, Profile Actions, Empty States

**User-facing recommendations covered:** first-run setup wizard, profile-centric main view, stronger empty states, inline task help foundation.

**Owned files:**
- Modify: `src/ui/formTypes.ts`
- Modify: `src/ui/formHtml.ts`
- Modify: `src/ui/formDefinitions.ts`
- Modify: `src/ui/nexusTreeProvider.ts`
- Modify: `src/commands/profileCommands.ts`
- Modify: `src/commands/serverCommands.ts`
- Modify: `src/commands/serialCommands.ts`
- Modify: `src/extension.ts`
- Modify: `package.json`
- Test: `test/unit/formDefinitions.test.ts`
- Test: `test/unit/formHtml.test.ts`
- Test: `test/unit/nexusTreeProvider.test.ts`
- Test: `test/unit/packageContributions.test.ts`

### Task 1.1: Add Advanced Field Grouping To Existing Forms

- [ ] Add optional `advanced?: boolean` and `hint?: string` support consistently to `FormFieldDescriptor` variants in `src/ui/formTypes.ts`.
- [ ] Update `renderFormHtml` so fields marked `advanced: true` render inside one `<details class="advanced-fields">` block with summary text `Advanced options`.
- [ ] Keep advanced fields subject to existing `visibleWhen` handling.
- [ ] Keep all non-advanced required fields visible without expanding advanced options.
- [ ] Add CSS in `renderFormHtml` for `.advanced-fields`, `.advanced-fields summary`, and nested `.form-group` using VS Code theme variables.
- [ ] Add tests in `test/unit/formHtml.test.ts` proving advanced fields are grouped, hidden behind a details summary, and still carry `data-visible-when`.

Expected focused verification:

```bash
rtk ./node_modules/.bin/vitest run test/unit/formHtml.test.ts
```

### Task 1.2: Make Add Profile Feel Like A Guided First-Run Form

- [ ] In `src/ui/formDefinitions.ts`, mark nonessential SSH fields as advanced: auth profile, proxy fields, multiplexing, legacy algorithms, log session, folder.
- [ ] Keep SSH basic fields visible: profile type, name, host, port, username, authentication, private key file when key auth is selected.
- [ ] Mark serial advanced fields: data bits, stop bits, parity, RTS/CTS, log session, folder.
- [ ] Keep serial basic fields visible: profile type, name, connection mode, port path, baud rate, Smart Follow warning when selected.
- [ ] Add concise field hints for Host, Authentication, Private Key File, Port Path, Baud Rate, Folder, Proxy, and Legacy SSH Algorithms.
- [ ] Update `test/unit/formDefinitions.test.ts` to assert advanced flags for proxy/multiplexing/legacy/folder and no advanced flag for host/port/username/path/baud.

Expected focused verification:

```bash
rtk ./node_modules/.bin/vitest run test/unit/formDefinitions.test.ts
```

### Task 1.3: Add Profile Quick Actions

- [ ] Add command IDs to `package.json`: `nexus.profile.actions`, `nexus.server.testConnection`, and `nexus.serial.testConnection`.
- [ ] In `src/ui/nexusTreeProvider.ts`, assign `command: { command: "nexus.profile.actions", title: "Profile Actions", arguments: [this] }` to disconnected/connected `ServerTreeItem` and `SerialProfileTreeItem`.
- [ ] Preserve existing session node click-to-focus behavior.
- [ ] In `src/commands/profileCommands.ts`, register `nexus.profile.actions`.
- [ ] For server items, show a QuickPick with these entries in order: Connect, Test Connection, Browse Files when connected, Connect and Run Script, Edit, Duplicate, Copy Connection Info, Delete.
- [ ] For serial profile items, show: Connect, Test Connection, Connect and Run Script, Edit, Duplicate, Copy Port Info, Delete.
- [ ] Execute existing command IDs from the pick instead of duplicating business logic.
- [ ] Add `test/unit/nexusTreeProvider.test.ts` assertions that server and serial profile tree items expose the quick action command.
- [ ] Add command contribution tests in `test/unit/packageContributions.test.ts`.

Expected focused verification:

```bash
rtk ./node_modules/.bin/vitest run test/unit/nexusTreeProvider.test.ts test/unit/packageContributions.test.ts
```

### Task 1.4: Improve Empty States Without Adding A New View

- [ ] Rewrite `viewsWelcome` copy in `package.json` so each empty state names the next action in plain terms.
- [ ] Connectivity Hub welcome must include `Add Profile`, `Add SSH Server`, `Add Serial Profile`, and `Scan Serial Ports` links where command IDs already exist.
- [ ] File Explorer welcome must explain that browsing starts from a connected profile and include a command link to `nexus.files.browse`.
- [ ] Tunnels welcome must include `Add Tunnel`.
- [ ] Settings welcome must be added for `nexusSettings` with links to `nexus.settings.openPanel`, `nexus.config.export.backup`, and `nexus.config.import`.
- [ ] Add tests in `test/unit/packageContributions.test.ts` for all new/updated welcome links.

Expected focused verification:

```bash
rtk ./node_modules/.bin/vitest run test/unit/packageContributions.test.ts
```

### Chunk 1 Review Gate

Spec review prompt must verify:
- Add Profile is simpler on first open while advanced values remain available.
- Profile tree items now expose task-first quick actions.
- Empty states provide command links for first useful actions.

Code review prompt must check:
- No duplicated connect/edit/delete logic in quick actions.
- Webview HTML remains escaped except trusted developer-authored HTML.
- Existing form behavior and tests still pass.

Chunk verification before merge:

```bash
rtk npm run compile
rtk ./node_modules/.bin/vitest run test/unit/formHtml.test.ts test/unit/formDefinitions.test.ts test/unit/nexusTreeProvider.test.ts test/unit/packageContributions.test.ts
```

## Chunk 2: Connection Diagnostics

**User-facing recommendations covered:** better connection diagnostics and safer first connection attempts.

**Owned files:**
- Create: `src/services/ssh/connectionDiagnostics.ts`
- Modify: `src/commands/serverCommands.ts`
- Modify: `src/commands/serialCommands.ts`
- Modify: `package.json`
- Test: `test/unit/connectionDiagnostics.test.ts`
- Test: `test/unit/serverCommands.test.ts`
- Test: `test/unit/serialCommands.test.ts`
- Test: `test/unit/packageContributions.test.ts`

### Task 2.1: Add SSH Error Classification Helper

- [ ] Create `src/services/ssh/connectionDiagnostics.ts`.
- [ ] Export `ConnectionDiagnosticResult` with fields `ok`, `stage`, `title`, `detail`, and `suggestion`.
- [ ] Export `classifySshConnectionError(error: unknown): ConnectionDiagnosticResult`.
- [ ] Classify at least: DNS resolution, TCP timeout, connection refused, auth failure, host key changed/rejected, unsupported private key/passphrase, proxy failure, and unknown failure.
- [ ] Do not include passwords, passphrases, or private key contents in result strings.
- [ ] Add unit tests that feed representative `Error.message` values and assert stable, user-facing titles/suggestions.

Expected focused verification:

```bash
rtk ./node_modules/.bin/vitest run test/unit/connectionDiagnostics.test.ts
```

### Task 2.2: Add Server Test Connection Command

- [ ] Register `nexus.server.testConnection` in `src/commands/serverCommands.ts`.
- [ ] Accept a `ServerTreeItem`; otherwise show a QuickPick of configured servers.
- [ ] Run `ctx.sshFactory.connect(server)` inside `vscode.window.withProgress` with title `Testing connection to <name>...`.
- [ ] On success, dispose the returned connection and show `Connection test succeeded for <name>.`
- [ ] On failure, use `classifySshConnectionError` and show a modal or non-modal error with title plus detail; include one `Copy Details` action.
- [ ] `Copy Details` must copy sanitized diagnostic text only.
- [ ] Add unit tests for success, classified failure, QuickPick fallback, and disposal on success.

Expected focused verification:

```bash
rtk ./node_modules/.bin/vitest run test/unit/serverCommands.test.ts test/unit/connectionDiagnostics.test.ts
```

### Task 2.3: Add Serial Test Command

- [ ] Register `nexus.serial.testConnection` in `src/commands/serialCommands.ts`.
- [ ] Accept a `SerialProfileTreeItem`; otherwise show a QuickPick of configured serial profiles.
- [ ] For standard serial profiles, call the existing sidecar open/close path used by serial connect if a non-terminal probe API exists; if not, use the existing list/scan API to validate the configured path is present and report that the final open occurs on Connect.
- [ ] For Smart Follow profiles, report whether a matching device is currently present and whether the saved path exists.
- [ ] Add unit tests for present path, missing path, and no profiles.

Expected focused verification:

```bash
rtk ./node_modules/.bin/vitest run test/unit/serialCommands.test.ts
```

### Chunk 2 Review Gate

Spec review prompt must verify:
- The Test Connection command exists for SSH and Serial profiles.
- Diagnostics are actionable and do not leak secrets.
- Quick actions from Chunk 1 can invoke the test commands.

Code review prompt must check:
- No parallel custom SSH stack is introduced.
- Connections are disposed after tests.
- Error classification is centralized in `connectionDiagnostics.ts`.

Chunk verification before merge:

```bash
rtk npm run compile
rtk ./node_modules/.bin/vitest run test/unit/connectionDiagnostics.test.ts test/unit/serverCommands.test.ts test/unit/serialCommands.test.ts test/unit/packageContributions.test.ts
```

## Chunk 3: Settings Information Architecture And Security & Data

**User-facing recommendations covered:** simplified default settings view, consistent labels/units, security and backup clarity.

**Owned files:**
- Modify: `src/ui/settingsMetadata.ts`
- Modify: `src/ui/settingsTreeProvider.ts`
- Modify: `src/ui/settingsHtml.ts`
- Modify: `src/commands/settingsCommands.ts`
- Modify: `package.json`
- Test: `test/unit/settingsMetadata.test.ts`
- Test: `test/unit/settingsTreeProvider.test.ts`
- Test: `test/unit/settingsHtml.test.ts`
- Test: `test/unit/packageContributions.test.ts`

### Task 3.1: Add Security & Data Category

- [ ] Extend `SettingMeta["category"]` to include `securityData`.
- [ ] Add `securityData` to `CATEGORY_ORDER`, `CATEGORY_LABELS`, and `CATEGORY_ICONS`.
- [ ] Move Trust New Hosts metadata from SSH to Security & Data, keeping the same configuration key.
- [ ] Move Data Management tree group under the Security & Data category instead of a separate root group.
- [ ] Keep backup/export/import/reset/delete command IDs unchanged.
- [ ] Update `test/unit/settingsTreeProvider.test.ts` expected root category count/order.

Expected focused verification:

```bash
rtk ./node_modules/.bin/vitest run test/unit/settingsTreeProvider.test.ts test/unit/settingsMetadata.test.ts
```

### Task 3.2: Add Category Descriptions And Task-Oriented Settings Header

- [ ] Add `CATEGORY_DESCRIPTIONS` in `src/ui/settingsMetadata.ts`.
- [ ] Render category descriptions in `SettingsCategoryItem.tooltip`.
- [ ] Render the focused settings panel header as `Nexus: <Category>` with a one-sentence description.
- [ ] Replace the generic settings info banner with category-specific text in focused mode and concise global text in all-settings mode.
- [ ] Add tests in `test/unit/settingsHtml.test.ts` for focused category description rendering.

Expected focused verification:

```bash
rtk ./node_modules/.bin/vitest run test/unit/settingsHtml.test.ts
```

### Task 3.3: Clarify Security And Backup Copy

- [ ] In the Security & Data focused panel, render a short static section before controls that states: credentials are stored in VS Code SecretStorage, host keys are stored in VS Code global state, encrypted backup includes secrets only when the user creates a backup, sanitized export excludes secrets.
- [ ] Implement this as developer-authored static HTML in `settingsHtml.ts`; do not interpolate user-controlled data.
- [ ] Add tests asserting the security copy includes SecretStorage, host keys, encrypted backup, and sanitized export.

Expected focused verification:

```bash
rtk ./node_modules/.bin/vitest run test/unit/settingsHtml.test.ts
```

### Chunk 3 Review Gate

Spec review prompt must verify:
- Settings root is easier to scan and has no duplicate root-level data management group.
- Security-sensitive storage/backup behavior is explained clearly.
- Existing configuration keys remain compatible.

Code review prompt must check:
- No settings keys are renamed.
- Existing import/export/reset commands remain reachable.
- No user data is inserted into trusted raw HTML.

Chunk verification before merge:

```bash
rtk npm run compile
rtk ./node_modules/.bin/vitest run test/unit/settingsMetadata.test.ts test/unit/settingsTreeProvider.test.ts test/unit/settingsHtml.test.ts test/unit/packageContributions.test.ts
```

## Chunk 4: Safer SFTP File Operations

**User-facing recommendations covered:** safer file transfer UX, consistent progress, confirmation, overwrite handling, and operation summaries.

**Owned files:**
- Modify: `src/commands/fileCommands.ts`
- Modify: `src/ui/conflictResolution.ts`
- Modify: `src/ui/fileExplorerTreeProvider.ts` only if item labels or tooltips need supporting information
- Test: `test/unit/fileCommands.test.ts`
- Test: `test/unit/conflictResolution.test.ts` if a new test file is cleaner

### Task 4.1: Add Upload Conflict Handling

- [ ] Before uploading each local file, check remote destination with `ctx.sftpService.stat`.
- [ ] Reuse `resolveConflict` from `src/ui/conflictResolution.ts` for overwrite, skip, overwrite all, skip all, cancel.
- [ ] Keep directory upload out of scope unless the existing upload picker already supports directories; do not add directory upload in this chunk.
- [ ] Track uploaded, skipped, conflicts, failed, and canceled counts.
- [ ] Show a final information/warning summary after upload.
- [ ] Add tests for overwrite, skip, cancel, and failed upload counts.

Expected focused verification:

```bash
rtk ./node_modules/.bin/vitest run test/unit/fileCommands.test.ts
```

### Task 4.2: Improve Delete Summaries

- [ ] Keep the current modal confirmation.
- [ ] For single delete and multi-delete, track deleted and failed counts.
- [ ] Show `Deleted <name>.` after a successful single delete.
- [ ] Show `Deleted N items.` for all-success multi-delete.
- [ ] Show warning summary when one or more deletes fail.
- [ ] Keep progress notifications for single directory delete and multi-delete.
- [ ] Add tests for single success notification and multi-delete warning summary.

Expected focused verification:

```bash
rtk ./node_modules/.bin/vitest run test/unit/fileCommands.test.ts
```

### Task 4.3: Improve Download Summary Detail

- [ ] Keep existing single-file save behavior.
- [ ] For multi-download, include selected count in progress title.
- [ ] Keep existing recursive directory safety limit.
- [ ] Ensure cancellation and conflict summary messages include enough detail to know whether files were skipped, failed, or canceled.
- [ ] Add tests for progress title and warning detail.

Expected focused verification:

```bash
rtk ./node_modules/.bin/vitest run test/unit/fileCommands.test.ts
```

### Chunk 4 Review Gate

Spec review prompt must verify:
- Upload/download/delete always show progress for operations that can take time.
- Dangerous operations still ask for confirmation.
- Users get final summaries after operations.

Code review prompt must check:
- Path safety helpers are still used.
- Conflict handling is not duplicated.
- Failures in one multi-operation item do not hide other item results.

Chunk verification before merge:

```bash
rtk npm run compile
rtk ./node_modules/.bin/vitest run test/unit/fileCommands.test.ts
```

## Chunk 5: Script/Macro Templates And Inline Help

**User-facing recommendations covered:** starter templates and task-oriented help inside the UI.

**Owned files:**
- Modify: `src/commands/scriptCommands.ts`
- Modify: `src/commands/macroCommands.ts`
- Modify: `src/ui/macroEditorHtml.ts`
- Modify: `src/ui/macroEditorPanel.ts`
- Modify: `package.json`
- Add or modify examples under `examples/scripts/`
- Test: `test/unit/scripts/scriptCommands.test.ts`
- Test: `test/unit/macroEditorHtml.test.ts`
- Test: `test/unit/macroCommands.test.ts`
- Test: `test/unit/packageContributions.test.ts`

### Task 5.1: Add Script Template Picker

- [ ] Replace the single starter script body in `scriptCommands.ts` with a `SCRIPT_TEMPLATES` array.
- [ ] Provide templates: basic command, wait for prompt then send, capture command output, backup running config.
- [ ] `nexus.script.new` must ask for template first, then script name.
- [ ] Preserve current generated script behavior as the default first template.
- [ ] Add unit tests for template labels and generated script content.

Expected focused verification:

```bash
rtk ./node_modules/.bin/vitest run test/unit/scripts/scriptCommands.test.ts
```

### Task 5.2: Add Macro Starter Templates

- [ ] Add `nexus.macro.addFromTemplate` command.
- [ ] Provide templates: send command, send password when prompted, wait-and-send confirmation, scoped auto-trigger example.
- [ ] The command should create a macro through the existing macro store path, then open the macro editor.
- [ ] Do not store secret text in plaintext templates; secret macro template must set the secret flag and leave secret value blank.
- [ ] Add unit tests for template creation and secret handling.

Expected focused verification:

```bash
rtk ./node_modules/.bin/vitest run test/unit/macroCommands.test.ts
```

### Task 5.3: Improve Inline Help In Scripts And Macros Views

- [ ] Add command contribution for `nexus.macro.addFromTemplate`.
- [ ] Add Macros view welcome link to add from template.
- [ ] Add Scripts view welcome wording that names templates.
- [ ] In `macroEditorHtml.ts`, add a concise empty-state block when there are no macros with buttons for Add Macro and Add From Template.
- [ ] Add tests for package welcome links and macro editor empty state.

Expected focused verification:

```bash
rtk ./node_modules/.bin/vitest run test/unit/macroEditorHtml.test.ts test/unit/packageContributions.test.ts
```

### Chunk 5 Review Gate

Spec review prompt must verify:
- Users can start from working scripts/macros without reading docs first.
- Secret macro templates do not include real secret material.
- Existing script creation command remains compatible from the command palette.

Code review prompt must check:
- Template definitions are centralized arrays, not repeated string branches.
- Macro secrets still use secure storage paths.
- Generated script content remains valid JavaScript with `@nexus-script`.

Chunk verification before merge:

```bash
rtk npm run compile
rtk ./node_modules/.bin/vitest run test/unit/scripts/scriptCommands.test.ts test/unit/macroCommands.test.ts test/unit/macroEditorHtml.test.ts test/unit/packageContributions.test.ts
```

## Chunk 6: Final Integration, Docs, And Consistency

**User-facing recommendations covered:** final task-oriented help, documentation clarity, cross-feature consistency.

**Owned files:**
- Modify: `README.md`
- Modify: `docs/functional-documentation.md`
- Modify: `docs/scripting.md` only if script template behavior changes developer-facing docs
- Modify: `package.json` only for contribution text polish discovered after prior chunks
- Test: `test/unit/packageContributions.test.ts`

### Task 6.1: Add First-Time User Section To README

- [ ] Add a short “Getting Started” section after the intro.
- [ ] Cover: create a profile, connect, browse files, create tunnel, create script/macro, backup settings.
- [ ] Keep the section command/task oriented and avoid screenshots.

### Task 6.2: Update Functional Documentation

- [ ] Add or update sections for profile quick actions, connection test diagnostics, Security & Data settings, SFTP operation summaries, script templates, and macro templates.
- [ ] Make restore/backup semantics explicit: encrypted backup can include secrets; sanitized export is shareable and excludes secrets.

### Task 6.3: Final Contribution Consistency Pass

- [ ] Check command titles in `package.json` for plain language and consistent ellipses.
- [ ] Ensure all new commands have category `Nexus` where they appear in the command palette.
- [ ] Ensure destructive commands remain clearly titled and grouped as destructive where applicable.
- [ ] Add package contribution assertions for new command titles if no existing test covers them.

### Chunk 6 Review Gate

Spec review prompt must verify:
- Documentation covers every delivered UX improvement.
- No stale wording contradicts actual commands.
- No README links are broken.

Code review prompt must check:
- Docs and contribution text are accurate.
- No implementation code is changed except small contribution polish.

Chunk verification before merge:

```bash
rtk npm run compile
rtk ./node_modules/.bin/vitest run test/unit/packageContributions.test.ts
```

## Per-Chunk Worktree Commands

Run these from `/mnt/c/Devel/vscode-NexTerminal`.

```bash
rtk git worktree add .worktrees/ftux-onboarding-actions -b feature/ftux-onboarding-actions feature/first-time-user-ux
rtk git worktree add .worktrees/ftux-connection-diagnostics -b feature/ftux-connection-diagnostics feature/first-time-user-ux
rtk git worktree add .worktrees/ftux-settings-security -b feature/ftux-settings-security feature/first-time-user-ux
rtk git worktree add .worktrees/ftux-file-operations -b feature/ftux-file-operations feature/first-time-user-ux
rtk git worktree add .worktrees/ftux-templates-help -b feature/ftux-templates-help feature/first-time-user-ux
rtk git worktree add .worktrees/ftux-final-integration-docs -b feature/ftux-final-integration-docs feature/first-time-user-ux
```

Run `rtk npm install` in each chunk worktree before dispatching its coder agent unless `node_modules/` already exists in that worktree.

## Merge Procedure After Each Approved Chunk

Run from `.worktrees/first-time-user-ux`.

```bash
rtk git merge --no-ff feature/ftux-onboarding-actions
rtk npm run compile
rtk npm run test:unit
```

Use the same pattern for each chunk branch. If a later chunk depends on earlier merged code, create that later chunk worktree only after the dependency chunk has merged into `feature/first-time-user-ux`.

## Final Feature-Branch Verification

Run from `.worktrees/first-time-user-ux` after all chunks are merged:

```bash
rtk npm run compile
rtk npm run test:unit
rtk npm run build:production
rtk git diff --check
```

## Self-Review Notes

- All 10 accepted recommendations map to at least one chunk.
- The plan avoids a new UI framework and keeps changes inside existing extension surfaces.
- Compatibility is preserved by keeping existing command IDs and settings keys unless adding new commands.
- Security-sensitive additions explicitly avoid leaking secrets in diagnostics, templates, and help text.
