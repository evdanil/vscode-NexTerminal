import { escapeHtml } from "./shared/escapeHtml";
import { baseWebviewCss } from "./shared/webviewStyles";
import { baseWebviewJs } from "./shared/webviewScripts";
import { serializeForInlineScript } from "./shared/inlineScriptData";
import { renderWebviewDocument } from "./shared/webviewDocument";
import { getAssignedBinding } from "../macroBindingHelpers";
import type { MacroVariable, TerminalMacro } from "../models/terminalMacro";
import { MACRO_RUN_TARGETS, MACRO_RUN_TARGET_TRIGGER_CONFLICT_MESSAGE, macroProvidesIpmiCredentials, resolveMacroRunTarget } from "../models/terminalMacro";
import { regexSafetyWebviewJs } from "../utils/regexSafety";
import { buildMacroProfileSelectOptions, type MacroProfileOptionInput } from "./macroProfileOptions";
import { MAX_MACRO_VARIABLES, getValidMacroVariables, macroVariablesWebviewJs } from "../services/macroVariables";
import { PROFILE_TOKEN_TRIGGER_CONFLICT_MESSAGE, profileTokensWebviewJs } from "../services/profileTokens";
import { macroFolderField } from "../services/macroFolders";

/**
 * Emitted immediately after `<textarea>`, before the macro's own text.
 *
 * The HTML parser drops exactly ONE U+000A that follows a `<textarea>` start
 * tag — "newlines at the start of textarea elements are ignored as an authoring
 * convenience" (HTML Standard, "in body" insertion mode). Rendering the text
 * bare therefore hands the form a macro whose leading blank line is already
 * gone, and `MacroEditorPanel` saves `msg.text` verbatim (no trim, by design —
 * §4.9 "Text is sent exactly as saved"), so merely opening the editor on such a
 * macro and pressing Save rewrites it one line shorter with nothing reported.
 * Giving the parser a newline of our own to drop makes the strip land on a
 * character the macro does not own. Exactly one is dropped whatever follows, so
 * this is a no-op for every macro that does not start with a newline.
 *
 * This is the same mechanism, in the opposite direction, that the HTML
 * serialization spec mandates for `pre` / `textarea` / `listing`.
 *
 * It replaces a `text.replace(/\n/g, "\n")` that had stood on this line since
 * the editor was written and, replacing "\n" with itself, did nothing at all.
 */
const TEXTAREA_LEADING_NEWLINE = "\n";

/**
 * One repeatable variable row (docs/plans/2026-07-29-macro-variables.md §9.1):
 * two visible lines (name/label/default, then the two checkboxes + Remove) plus
 * a per-row error slot addressed by `data-var-error` (§9.2). `index` seeds the
 * row's error-slot addressing at render time; webview JS renumbers it on every
 * add/remove so it always matches the DOM order the save handler collects.
 */
function renderVariableRow(variable: MacroVariable, index: number): string {
  const name = escapeHtml(variable.name ?? "");
  const label = escapeHtml(variable.label ?? "");
  const isSecret = !!variable.secret;
  // §7.1 — a default is forbidden on a masked variable (it would be plaintext
  // in the store); never render one even if a malformed/legacy record has it.
  const defaultValue = isSecret ? "" : escapeHtml(variable.default ?? "");
  // `remember` is meaningless on a masked variable — never remembered regardless
  // of this flag — and `sanitizeImportedMacroVariables`/`toValidMacroVariable`
  // both strip it from a secret entry. Never render it as checked even if a
  // malformed/legacy record has it, and disable the control (same treatment as
  // `default` above) so the editor can't persist a `remember: false` that would
  // round-trip to a different shape than the rest of the app produces.
  const dontRemember = !isSecret && variable.remember === false;
  const removeLabel = escapeHtml(variable.name ? `Remove variable ${variable.name}` : "Remove variable");
  return `<div class="variable-row" data-var-row="${index}">
      <div class="variable-row-line1">
        <input type="text" class="var-name" value="${name}" placeholder="name" maxlength="32" />
        <input type="text" class="var-label" value="${label}" placeholder="label (optional)" />
        <input type="text" class="var-default" value="${defaultValue}"${isSecret ? " disabled" : ""} placeholder="default" />
      </div>
      <div class="variable-row-line2">
        <label><input type="checkbox" class="var-secret"${isSecret ? " checked" : ""} /> Mask input (never stored)</label>
        <label class="variable-remember-label${isSecret ? " muted" : ""}"><input type="checkbox" class="var-remember"${dontRemember ? " checked" : ""}${isSecret ? " disabled" : ""} /> Don't remember</label>
        <button type="button" class="btn-secondary variable-remove-btn" aria-label="${removeLabel}">Remove</button>
      </div>
      <div class="field-error" data-var-error="${index}"></div>
    </div>`;
}

/**
 * @param renderGeneration Which of the panel's renders this page IS. Baked in
 * next to `currentId` and posted straight back with every save/delete, where it
 * is the key the panel looks its own render-time answer up under
 * (`MacroEditorPanel.renderedRefs`) — not an answer in itself.
 *
 * The distinction is the point. The form is the longest-lived reference to a
 * macro in this feature, and the id alone cannot carry what was true when the
 * form was drawn: `MacroStore.save()` re-keys duplicates, so by the time the
 * message arrives the id can look perfectly unique while naming the OTHER twin.
 * A previous revision posted that fact back as a boolean, which cannot work —
 * a stale `false`, a forged `false` and a defaulted `false` are indistinguishable
 * from an honest one, so the page could assert its way past the check. A
 * generation can only ever NAME one of the host's records; the record itself
 * stays where the webview cannot reach it.
 *
 * The panel owns the numbering (`macroEditorPanel.ts`), because the one
 * definition of "how many macros carry this id" lives in
 * `services/macroMutation.ts`, which reaches `vscode` through `macroSettings`
 * and so cannot be imported here. It defaults to `0`, which the panel never
 * issues: a render-only caller (the byte-identity snapshot, a test) produces a
 * page whose save would be refused as coming from no render at all, rather than
 * one that claims something about an id.
 */
export function renderMacroEditorHtml(
  macros: TerminalMacro[],
  selectedIndex: number | null,
  nonce: string,
  profiles: MacroProfileOptionInput[] = [],
  folders: string[] = [],
  seedGroup?: string,
  renderGeneration = 0
): string {
  const macro = selectedIndex !== null ? macros[selectedIndex] : undefined;

  // Build macro selector options
  const selectorOptions = macros
    .map(
      (m, i) =>
        `<div class="custom-select-option${i === selectedIndex ? " selected" : ""}" data-value="${i}">${escapeHtml(m.name)}</div>`
    )
    .join("\n        ");

  const newMacroOption = `<div class="custom-select-option${selectedIndex === null && macros.length > 0 ? " selected" : ""}" data-value="__new__">+ New Blank Macro</div>`;

  const triggerLabel = macro ? macro.name : (macros.length > 0 ? "Select a macro\u2026" : "+ New Blank Macro");
  const hiddenValue = selectedIndex !== null ? String(selectedIndex) : "__new__";

  const bindingValue = macro ? (getAssignedBinding(macro) ?? "") : "";
  const triggerValue = macro?.triggerPattern ?? "";
  const cooldownValue = macro?.triggerCooldown ?? 3;
  const intervalValue = macro?.triggerInterval ?? "";
  const triggerInitiallyDisabled = macro?.triggerInitiallyDisabled ?? false;
  const triggerScope = macro?.triggerScope ?? "all-terminals";
  const triggerScopeOptions = [
    { value: "all-terminals", label: "All terminals (compatibility default)" },
    { value: "active-session", label: "Active terminal only - Recommended for secrets" },
    { value: "profile", label: "Matching profile only - Recommended for secrets" }
  ];
  const selectedScopeLabel = triggerScopeOptions.find((option) => option.value === triggerScope)?.label
    ?? triggerScopeOptions[0].label;
  const triggerScopeOptionsHtml = triggerScopeOptions.map((option) =>
    `<div class="custom-select-option${option.value === triggerScope ? " selected" : ""}" data-value="${escapeHtml(option.value)}">${escapeHtml(option.label)}</div>`
  ).join("\n        ");
  const triggerProfileId = macro?.triggerProfileId ?? "";

  // Issue #48 — where a run sends the resolved text. Read through
  // `resolveMacroRunTarget()` so a corrupt stored value renders as the
  // compatibility default instead of an empty select.
  const runIn = macro ? resolveMacroRunTarget(macro) : "session";
  const runInOptions = MACRO_RUN_TARGETS.map((target) => ({
    value: target,
    label:
      target === "session"
        ? "Session terminal (default) - sends to the connected session"
        : target === "localTerminal"
          ? "Local terminal - runs the text on this machine"
          : "Browser - the text is a URL, opened externally"
  }));
  const selectedRunInLabel = runInOptions.find((option) => option.value === runIn)?.label ?? runInOptions[0].label;
  // Issue #48 §3.3 — the credential opt-in, read through the model's own gate so
  // the checkbox can never render "on" for a macro a run would treat as off (a
  // non-boolean from legacy-settings absorption, or a flag left on a macro whose
  // "Run in" was later moved off Local terminal).
  const provideIpmi = macro ? macroProvidesIpmiCredentials(macro) : false;
  const provideIpmiVisible = runIn === "localTerminal";
  const runInOptionsHtml = runInOptions.map((option) =>
    `<div class="custom-select-option${option.value === runIn ? " selected" : ""}" data-value="${escapeHtml(option.value)}">${escapeHtml(option.label)}</div>`
  ).join("\n        ");

  const nameValue = macro?.name ?? "";
  const textValue = macro?.text ?? "";
  // §4.11 — the Folder field. For an existing macro, whatever
  // `macroFolderField()` says its stored group looks like in this input; for a
  // new macro, the caller's seed (e.g. `addToFolder`, §4.7).
  //
  // This deliberately does NOT sanitize. Sanitizing showed an empty field for a
  // stored-but-unrenderable group, which meant the one surface where §4.9.3
  // says the user can "correct it" displayed nothing to correct — and, worse,
  // handed the save path an empty value that deleted the stored path. The raw
  // string is rendered instead (escaped by `escapeHtml`, and withheld entirely
  // above `MAX_FOLDER_PATH_LENGTH` so a pathological multi-megabyte group can
  // never reach the DOM), with a notice explaining why the macro is at the
  // root. `macroEditorPanel.ts` preserves it verbatim if the user leaves it
  // alone, and validates normally the moment they touch it.
  const storedFolder = macro ? macroFolderField(macro.group) : undefined;
  const groupValue = storedFolder ? storedFolder.value : (seedGroup ?? "");
  const folderNotice =
    storedFolder?.state === "unrenderable"
      ? "This folder path isn't usable, so this macro shows at the root. Fix it (or clear it) and save; leaving it untouched keeps the stored value exactly as it is."
      : storedFolder?.state === "oversize"
        ? "This macro's stored folder path is too long to show here, so the macro shows at the root. Type a new path to replace it, or use Move to Folder → (root) to clear it; leaving this field empty keeps the stored value."
        : "";
  // Folded into the existing hint rather than added as its own element: an
  // empty conditional block on its own line leaves a whitespace-only line in
  // the rendered HTML, which `git diff --check` fails on via the snapshot test.
  const folderNoticeHtml = folderNotice ? `<strong>${escapeHtml(folderNotice)}</strong> ` : "";
  // Each option carries its own indentation and the whole block is empty when there
  // are no folders yet — which is the normal starting state. Interpolating an empty
  // string into an already-indented line would leave the indent behind as a
  // whitespace-only line, which `git diff --check` fails on via the rendered-HTML
  // snapshot. The other dropdowns in this file never hit that because their option
  // lists are static and always non-empty.
  const folderOptionsHtml = folders.map((f) =>
    `        <div class="custom-select-option" data-value="${escapeHtml(f)}">${escapeHtml(f)}</div>`
  ).join("\n");
  const isSecret = macro?.secret ?? false;
  // §4.2 — `variables` is untrusted at every read site; `getValidMacroVariables`
  // applies the shape guard so a corrupt legacy/Settings-Sync record never
  // reaches row rendering.
  const variables = macro ? getValidMacroVariables(macro) : [];
  const variableRowsHtml = variables.map((variable, i) => renderVariableRow(variable, i)).join("\n");
  const isNew = selectedIndex === null;
  const saveLabel = isNew ? "Create" : "Save";
  const deleteDisabled = isNew ? " disabled" : "";
  const profileOptions = buildMacroProfileSelectOptions(profiles, triggerProfileId);
  const profileIdsJson = serializeForInlineScript(profileOptions.map((profile) => profile.id));
  const selectedProfileLabel = profileOptions.find((profile) => profile.id === triggerProfileId)?.label
    ?? (profileOptions.length > 0 ? "Select a profile\u2026" : "No SSH, Serial, or Local Shell profiles");
  const triggerProfileOptionsHtml = profileOptions.length > 0
    ? profileOptions.map((profile) =>
      `<div class="custom-select-option${profile.id === triggerProfileId ? " selected" : ""}" data-value="${escapeHtml(profile.id)}">${escapeHtml(profile.label)}</div>`
    ).join("\n        ")
    : '<div class="custom-select-option selected" data-value="">No SSH, Serial, or Local Shell profiles</div>';
  const emptyStateHtml = macros.length === 0
    ? `<div class="empty-state">
    <div class="empty-title">No macros yet</div>
    <div class="empty-actions">
      <button type="button" class="btn-primary" id="empty-add-btn">Add Blank Macro</button>
      <button type="button" class="btn-secondary" id="empty-template-btn">Add Macro From Template</button>
    </div>
  </div>`
    : "";

  return renderWebviewDocument({
    nonce,
    css: `    ${baseWebviewCss()}
    .editor-textarea {
      min-height: 120px;
      line-height: 1.5;
    }
    .hint {
      font-size: 11px;
      color: var(--vscode-descriptionForeground, var(--vscode-foreground));
      margin-top: 4px;
    }
    .bottom-actions {
      display: flex;
      gap: 8px;
      margin-top: 20px;
      align-items: center;
    }
    .bottom-actions .spacer {
      flex: 1;
    }
    .dirty-indicator {
      display: none;
      font-size: 11px;
      color: var(--vscode-editorWarning-foreground, #cca700);
      margin-left: 8px;
    }
    .dirty-indicator.visible {
      display: inline;
    }
    .empty-state {
      margin-bottom: 18px;
      padding: 10px 0 14px 0;
      border-bottom: 1px solid var(--vscode-panel-border, var(--vscode-input-border, rgba(128,128,128,0.35)));
    }
    .empty-title {
      font-weight: 600;
      margin-bottom: 8px;
    }
    .empty-actions {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
    }
    .variable-remember-label.muted {
      opacity: 0.55;
    }`,
    body: `  ${emptyStateHtml}
  <div class="form-group">
    <label>Macro</label>
    <div class="custom-select" id="macro-selector">
      <input type="hidden" id="macro-select-value" value="${escapeHtml(hiddenValue)}" />
      <div class="custom-select-trigger" tabindex="0">
        <span class="custom-select-text">${escapeHtml(triggerLabel)}</span>
      </div>
      <div class="custom-select-dropdown">
        ${selectorOptions}
        ${newMacroOption}
      </div>
    </div>
    <span class="dirty-indicator" id="dirty-flag">Unsaved changes</span>
  </div>

  <div class="form-group">
    <label for="macro-name">Name</label>
    <input type="text" id="macro-name" value="${escapeHtml(nameValue)}" placeholder="My macro" />
    <div class="field-error" id="error-name"></div>
  </div>

  <div class="form-group">
    <label for="macro-text">Text</label>
    <textarea id="macro-text" class="editor-textarea" rows="6" placeholder="echo hello&#10;ls -la">${TEXTAREA_LEADING_NEWLINE}${escapeHtml(textValue)}</textarea>
    <div class="hint">Text is sent exactly as saved. Press Enter in the textarea to include a newline. \${profile.host}, \${profile.ipmiHost}, \${profile.ipmiUsername}, \${profile.port}, \${profile.username} and \${profile.name} are filled in from the server the macro is run against (right-click a server in the Connectivity Hub → Run Macro on Server…).</div>
    <div class="field-error" id="error-text"></div>
    <div class="variables-diagnostics" id="variables-diagnostics" aria-live="polite"></div>
  </div>

  <div class="form-group">
    <div class="variables-section-header">
      <label style="margin-bottom:0;">Variables<span class="field-error variables-header-error" id="error-variables"></span></label>
      <button type="button" class="btn-secondary" id="add-variable-btn">+ Add Variable</button>
    </div>
    <div id="variables-list">${variableRowsHtml}</div>
    <template id="variable-row-template">${renderVariableRow({ name: "" }, 0)}</template>
    <div class="hint">Referenced in the text as \${name} or $name. Undeclared placeholders are sent as-is.</div>
    <div class="variables-trigger-conflict" id="variables-trigger-conflict"></div>
  </div>

  <div class="form-group form-group-checkbox">
    <label>
      <input type="checkbox" id="macro-secret"${isSecret ? " checked" : ""} />
      Secret (hide value in sidebar and pickers; remote echo may still appear in terminal output)
    </label>
  </div>

  <div class="form-group">
    <label for="macro-run-in-wrapper">Run in</label>
    <div class="custom-select" id="macro-run-in-wrapper">
      <input type="hidden" id="macro-run-in" value="${escapeHtml(runIn)}" />
      <div class="custom-select-trigger" tabindex="0">
        <span class="custom-select-text">${escapeHtml(selectedRunInLabel)}</span>
      </div>
      <div class="custom-select-dropdown">
        ${runInOptionsHtml}
      </div>
    </div>
    <div class="field-error" id="error-runIn"></div>
    <div class="hint">Local terminal and Browser macros are run from a server profile (Connectivity Hub → right-click a server → Run Macro on Server…). Neither can auto-trigger.</div>
    <!-- B1 (issue #48 PR-B) — a legacy ipmitool macro defaults to Session terminal
         (absent runIn), which types the command into the connected SSH session, so
         it runs on the REMOTE host. Non-blocking hint (does NOT disable Save); shown
         only while Run in = Session terminal AND the text looks like ipmitool. -->
    <div class="hint" id="session-ipmitool-hint" style="display:none;">This looks like an ipmitool command. "Session terminal" types it into the connected SSH session, so it runs on the remote host. Choose "Local terminal" to run it from this machine, then tick "Provide IPMI credentials" to supply the BMC password.</div>
  </div>

  <!-- Issue #48 §3.3 — the IPMI credential opt-in. Shown only while Run in =
       Local terminal, where it is the only thing it can mean; the save handler
       drops the flag for every other target regardless of what is checked. -->
  <div class="form-group form-group-checkbox" id="provide-ipmi-group"${provideIpmiVisible ? "" : ' style="display:none;"'}>
    <label>
      <input type="checkbox" id="macro-provide-ipmi"${provideIpmi ? " checked" : ""} />
      Provide IPMI credentials to this macro's terminal
    </label>
    <div class="hint">Puts the server's IPMI password (from the IPMI Auth Profile linked in its server form) into the local terminal's environment as IPMITOOL_PASSWORD/IPMI_PASSWORD, so <code>ipmitool -E</code> can read it without the password ever appearing in the command line, the scrollback, or Copy All. Every command run in that terminal — by this macro or typed later — can read it. Leave this off unless the macro is an ipmitool command. If no password is stored, you are asked for one at run time and it is used for that run only.</div>
  </div>

  <div class="form-group">
    <label for="macro-trigger">Auto-Trigger Pattern</label>
    <input type="text" id="macro-trigger" value="${escapeHtml(triggerValue)}" placeholder="e.g., [Pp]assword:\\s*$" />
    <div class="field-error" id="error-trigger"></div>
    <div class="variables-trigger-conflict" id="variables-trigger-conflict-2"></div>
    <!-- Its own slot rather than a shared one: the variables/trigger conflict and the
         profile-token/trigger conflict can both apply to the same macro, and a shared
         element would let whichever handler ran last erase the other's message. -->
    <div class="variables-trigger-conflict" id="profile-trigger-conflict"></div>
    <div class="hint">Enter the JavaScript regex pattern only, without surrounding /slashes/ or flags. Avoid risky shapes like (.*)+; use line-bounded text like [^\\n]*. When matched, this macro's text is sent automatically (expect/send).</div>
  </div>

  <div class="form-group">
    <label for="macro-trigger-scope-wrapper">Auto-Trigger Scope</label>
    <div class="custom-select" id="macro-trigger-scope-wrapper">
      <input type="hidden" id="macro-trigger-scope" value="${escapeHtml(triggerScope)}" />
      <div class="custom-select-trigger" tabindex="0">
        <span class="custom-select-text">${escapeHtml(selectedScopeLabel)}</span>
      </div>
      <div class="custom-select-dropdown">
        ${triggerScopeOptionsHtml}
      </div>
    </div>
    <div class="hint">Existing macros with no saved scope still run on all terminals. For secret prompts, prefer active terminal or matching profile.</div>
  </div>

  <div class="form-group" id="trigger-profile-group">
    <label for="macro-trigger-profile-wrapper">Trigger Profile</label>
    <div class="custom-select" id="macro-trigger-profile-wrapper">
      <input type="hidden" id="macro-trigger-profile" value="${escapeHtml(triggerProfileId)}" />
      <div class="custom-select-trigger" tabindex="0">
        <span class="custom-select-text">${escapeHtml(selectedProfileLabel)}</span>
      </div>
      <div class="custom-select-dropdown">
        ${triggerProfileOptionsHtml}
      </div>
    </div>
    <div class="hint">Used only when scope is Matching profile. Pick the saved profile whose output should trigger this macro.</div>
    <div class="field-error" id="error-trigger-profile"></div>
  </div>

  <div class="form-group">
    <label for="macro-cooldown">Trigger Cooldown (seconds)</label>
    <input type="number" id="macro-cooldown" value="${escapeHtml(String(cooldownValue))}" min="0" max="300" step="1" />
    <div class="hint">Seconds between auto-triggers on the same terminal. Prevents echo-loops where server re-prompts after each response.</div>
  </div>

  <div class="form-group">
    <label for="macro-interval">Trigger Interval (seconds)</label>
    <input type="number" id="macro-interval" value="${escapeHtml(String(intervalValue))}" min="1" max="86400" step="1" placeholder="Optional" />
    <div class="hint">An interval macro starts only when its pattern matches the active terminal; delayed sends stay on that same session even if focus changes. Later matches on the same session send immediately if the interval has elapsed, or wait until it has. Nexus does not send again until the pattern matches again.</div>
  </div>

  <div class="form-group form-group-checkbox">
    <label>
      <input type="checkbox" id="macro-trigger-disabled"${triggerInitiallyDisabled ? " checked" : ""} />
      Start auto-trigger paused until manually resumed
    </label>
    <div class="hint">Useful for command macros that should wait for you to enable them after login. If the prompt already matched recently, resuming can trigger immediately.</div>
  </div>

  <div class="form-group">
    <label for="macro-binding">Keyboard Shortcut</label>
    <input type="text" id="macro-binding" value="${escapeHtml(bindingValue)}" placeholder="e.g., alt+m, alt+shift+5, ctrl+shift+a" />
    <div class="field-error" id="error-binding"></div>
    <div class="hint">Macros without a shortcut can still be run via <strong>Alt+S</strong> (quick pick). Supported: Alt, Alt+Shift, Ctrl+Shift with A-Z or 0-9.</div>
  </div>

  <div class="form-group">
    <label for="macro-folder">Folder</label>
    <div class="custom-combobox" id="macro-folder-wrapper">
      <input type="text" id="macro-folder" value="${escapeHtml(groupValue)}" placeholder="Type a folder path or pick existing..." autocomplete="off" />
      <div class="custom-select-dropdown">
${folderOptionsHtml}
      </div>
    </div>
    <div class="field-error" id="error-folder"></div>
    <div class="hint">${folderNoticeHtml}Optional. Groups this macro under a sidebar folder. Use "/" for nested folders (e.g. Cisco/Routers).</div>
  </div>

  <div class="bottom-actions">
    <button type="button" class="btn-primary" id="save-btn">${escapeHtml(saveLabel)}</button>
    <button type="button" class="btn-secondary" id="delete-btn"${deleteDisabled}>Delete</button>
    <div class="spacer"></div>
    <button type="button" class="btn-secondary" id="new-btn">New Blank Macro</button>
  </div>
  <!-- Storage failures (the macro store fails closed when it cannot name a secret's vault
       entry on disk) are not about any one field, so they get their own slot beside the Save
       button rather than blaming Name or Text. Populated only by a host-posted
       saveError with field "save"; see MacroEditorPanel.reportHandlerFailure(). -->
  <div class="field-error" id="error-save" aria-live="polite"></div>
`,
    script: `    ${baseWebviewJs()}
    (function() {
      var vscode = acquireVsCodeApi();
      var dirty = false;
      var currentIndex = ${selectedIndex !== null ? selectedIndex : "null"};
      var currentId = ${macro?.id ? JSON.stringify(macro.id) : "null"};
      // Which render drew this page (see renderGeneration). Travels with every
      // save/delete so the host can look up what IT knew about currentId then;
      // it is a key into the host's records, never a claim about the id.
      var currentRenderGeneration = ${Number.isSafeInteger(renderGeneration) ? renderGeneration : 0};
      var KNOWN_PROFILE_IDS = ${profileIdsJson};

      var VALID_PATTERN = /^(alt\\+[a-z0-9]|alt\\+shift\\+[a-z0-9]|ctrl\\+shift\\+[a-z0-9])$/;
      ${regexSafetyWebviewJs()}
      var MAX_VARIABLES = ${MAX_MACRO_VARIABLES};
      // §9.3 — the scan is authoritative in src/services/macroVariables.ts; this
      // webview must never re-implement it (mirrors the regexSafetyWebviewJs()
      // precedent above).
      ${macroVariablesWebviewJs()}
      // Issue #48 — same precedent, same reason: the token grammar and the
      // whitelist are interpolated from services/profileTokens.ts so the live
      // hints below say exactly what a run will do.
      ${profileTokensWebviewJs()}

      function isValidBinding(value) {
        return VALID_PATTERN.test(value.trim().toLowerCase());
      }

      function validateTriggerPattern(value) {
        if (!value) return "";
        var safetyError = validateRegexSafety(value);
        if (safetyError) return safetyError;
        try {
          var re = new RegExp(value);
          if (re.test("")) {
            return "Pattern must not match empty strings.";
          }
        } catch(e) {
          return e.message || "Invalid regex.";
        }
        return "";
      }

      function updateTriggerProfileState() {
        var scope = document.getElementById("macro-trigger-scope").value;
        var group = document.getElementById("trigger-profile-group");
        var input = document.getElementById("macro-trigger-profile");
        var isProfile = scope === "profile";
        group.style.display = isProfile ? "" : "none";
        input.disabled = !isProfile;
        if (!isProfile) {
          document.getElementById("error-trigger-profile").textContent = "";
        }
      }

      // Issue #48 §3.3 — the opt-in is meaningless on a session or browser macro,
      // so it is hidden there AND unchecked: leaving a checked-but-hidden box
      // would submit a consent the user cannot see. (The host drops the flag for
      // a non-local target anyway; this is the visible half of the same rule.)
      function updateProvideIpmiState() {
        var isLocal = document.getElementById("macro-run-in").value === "localTerminal";
        document.getElementById("provide-ipmi-group").style.display = isLocal ? "" : "none";
        if (!isLocal) {
          document.getElementById("macro-provide-ipmi").checked = false;
        }
      }

      function markDirty() {
        if (!dirty) {
          dirty = true;
          document.getElementById("dirty-flag").classList.add("visible");
        }
      }

      function clearDirty() {
        dirty = false;
        document.getElementById("dirty-flag").classList.remove("visible");
      }

      // ---- Variables (docs/plans/2026-07-29-macro-variables.md §9.1-§9.5) ----
      var variablesList = document.getElementById("variables-list");
      var variableRowTemplate = document.getElementById("variable-row-template");
      var TRIGGER_CONFLICT_MESSAGE = "A macro can prompt for input or auto-trigger, not both. For prompts on an automated flow, use a Script with prompt().";
      // The host enforces this same rule through validateMacroRunTarget()
      // (models/terminalMacro.ts); the message is interpolated from there so the
      // two cannot drift.
      var RUN_IN_CONFLICT_MESSAGE = ${serializeForInlineScript(MACRO_RUN_TARGET_TRIGGER_CONFLICT_MESSAGE)};
      // The host enforces this one in MacroEditorPanel's save handler, and
      // MacroAutoTrigger.reload() refuses to compile such a rule regardless.
      var PROFILE_TRIGGER_CONFLICT_MESSAGE = ${serializeForInlineScript(PROFILE_TOKEN_TRIGGER_CONFLICT_MESSAGE)};

      function updateRunInConflictWarning() {
        var triggerVal = document.getElementById("macro-trigger").value.trim();
        var runInVal = document.getElementById("macro-run-in").value;
        var errEl = document.getElementById("error-runIn");
        errEl.textContent = triggerVal && runInVal !== "session" ? RUN_IN_CONFLICT_MESSAGE : "";
      }

      function updateProfileTriggerConflictWarning() {
        var triggerVal = document.getElementById("macro-trigger").value.trim();
        var usesProfile = scanProfileTokens(document.getElementById("macro-text").value).used.length > 0;
        var el = document.getElementById("profile-trigger-conflict");
        var show = !!triggerVal && usesProfile;
        el.textContent = show ? PROFILE_TRIGGER_CONFLICT_MESSAGE : "";
        el.classList.toggle("visible", show);
      }

      // B1 — the same session/ipmitool HINT the host emits as a delivery note
      // (sessionIpmiHintNote, serverMacroCommands.ts), surfaced live in the editor.
      // Text/token inspection is sanctioned as a hint only (§3.3): this shows a
      // note, never blocks Save.
      function updateSessionIpmitoolHint() {
        var runInVal = document.getElementById("macro-run-in").value;
        var text = document.getElementById("macro-text").value;
        var used = scanProfileTokens(text).used;
        var usesIpmiToken = used.indexOf("ipmiHost") !== -1 || used.indexOf("ipmiUsername") !== -1;
        var looksIpmitool = /(^|\\s)ipmitool\\b/.test(text) || usesIpmiToken;
        var show = runInVal === "session" && looksIpmitool;
        document.getElementById("session-ipmitool-hint").style.display = show ? "" : "none";
      }

      // Row N's error slot is addressed by data-var-error="N" (§9.2). Renumbering
      // on every add/remove keeps that index equal to the row's DOM position,
      // which is also the position the save handler collects it at below.
      //
      // Also clears every row's error text here: a host-posted per-row error
      // addresses a row by position (data-var-error="N"), and add/remove changes
      // which row sits at position N — without this, a stale message can end up
      // pinned to a DIFFERENT row than the one that caused it.
      function renumberVariableRows() {
        var rows = variablesList.querySelectorAll(".variable-row");
        for (var i = 0; i < rows.length; i++) {
          rows[i].setAttribute("data-var-row", String(i));
          var errSlot = rows[i].querySelector(".field-error");
          if (errSlot) {
            errSlot.setAttribute("data-var-error", String(i));
            errSlot.textContent = "";
          }
        }
      }

      function updateRemoveAriaLabel(row) {
        var nameInput = row.querySelector(".var-name");
        var removeBtn = row.querySelector(".variable-remove-btn");
        var name = nameInput.value.trim();
        removeBtn.setAttribute("aria-label", name ? ("Remove variable " + name) : "Remove variable");
      }

      function collectDeclaredVariableNames() {
        var rows = variablesList.querySelectorAll(".variable-row");
        var names = [];
        for (var i = 0; i < rows.length; i++) {
          var n = rows[i].querySelector(".var-name").value.trim();
          if (n) names.push(n);
        }
        return names;
      }

      function updateTriggerConflictWarning() {
        var triggerVal = document.getElementById("macro-trigger").value.trim();
        // §9.4 — a wholly untouched row is "not yet filled in" and must not trip the
        // mutually-exclusive warning by itself, e.g. right after clicking
        // "+ Add Variable" once on an existing trigger macro. But a row the user has
        // started filling in counts even before the name is typed, otherwise the
        // conflict stays hidden right up until Save and then appears out of nowhere.
        var hasVars = collectDeclaredVariableNames().length > 0;
        if (!hasVars) {
          var pending = variablesList.querySelectorAll(".variable-row");
          for (var pi = 0; pi < pending.length; pi++) {
            if (rowHasContent(pending[pi])) { hasVars = true; break; }
          }
        }
        var show = !!triggerVal && hasVars;
        var w1 = document.getElementById("variables-trigger-conflict");
        var w2 = document.getElementById("variables-trigger-conflict-2");
        w1.textContent = show ? TRIGGER_CONFLICT_MESSAGE : "";
        w2.textContent = show ? TRIGGER_CONFLICT_MESSAGE : "";
        w1.classList.toggle("visible", show);
        w2.classList.toggle("visible", show);
      }

      var diagnosticsTimer = null;
      function scheduleDiagnostics() {
        if (diagnosticsTimer) clearTimeout(diagnosticsTimer);
        diagnosticsTimer = setTimeout(computeDiagnostics, 300);
      }

      // §9.3 — three hints, all non-blocking: (a) an undeclared placeholder with
      // a one-click fix, (b) a declared-but-unused variable, (c) the positive
      // confirmation once the macro is well-formed. Uses scanMacroPlaceholders()
      // from macroVariablesWebviewJs() above — never a second scanner.
      function computeDiagnostics() {
        var text = document.getElementById("macro-text").value;
        var declaredNames = collectDeclaredVariableNames();
        var scan = scanMacroPlaceholders(text, declaredNames);
        var container = document.getElementById("variables-diagnostics");
        container.innerHTML = "";

        var lines = [];
        for (var u = 0; u < scan.undeclared.length; u++) {
          (function(name) {
            var line = document.createElement("div");
            line.className = "diag-hint";
            var span = document.createElement("span");
            span.textContent = "$" + name + " is not declared and will be sent as-is.";
            line.appendChild(span);
            var btn = document.createElement("button");
            btn.type = "button";
            btn.className = "btn-secondary diag-add-btn";
            btn.textContent = 'Add variable "' + name + '"';
            btn.addEventListener("click", function() { addVariableRow(name); });
            line.appendChild(btn);
            lines.push(line);
          })(scan.undeclared[u]);
        }

        var unused = declaredNames.filter(function(n) { return scan.used.indexOf(n) === -1; });
        for (var w = 0; w < unused.length; w++) {
          (function(name) {
            var uline = document.createElement("div");
            uline.className = "diag-hint";
            uline.textContent = name + " is declared but $" + name + " / \${" + name + "} does not appear in the text.";
            lines.push(uline);
          })(unused[w]);
        }

        if (lines.length === 0 && scan.used.length > 0) {
          var okLine = document.createElement("div");
          okLine.className = "diag-positive";
          okLine.textContent = "Will prompt for: " + scan.used.join(", ");
          lines.push(okLine);
        }

        // Issue #48 — the same three-shape treatment for profile tokens: what
        // will be filled in from the server, and what looks like a token but is
        // not one. A misspelled token is NOT an error (it is sent as-is, exactly
        // like an undeclared placeholder), so it warns rather than blocks.
        var profileScan = scanProfileTokens(text);
        for (var pu = 0; pu < profileScan.unknown.length; pu++) {
          var badLine = document.createElement("div");
          badLine.className = "diag-hint";
          badLine.textContent =
            "\${profile." + profileScan.unknown[pu] + "} is not a profile token and will be sent as-is. Tokens: " +
            PROFILE_TOKEN_NAMES.join(", ") + ".";
          lines.push(badLine);
        }
        if (profileScan.used.length > 0) {
          var profileLine = document.createElement("div");
          profileLine.className = "diag-positive";
          profileLine.textContent = "Filled from the server profile at run time: " + profileScan.used.join(", ");
          lines.push(profileLine);
        }

        for (var li = 0; li < lines.length; li++) {
          container.appendChild(lines[li]);
        }
      }

      // Client-side pre-check of the §9.4 rules so the common cases never round-trip
      // to the host; the host (macroEditorPanel.ts) re-validates with
      // validateMacroVariables() regardless, since retainContextWhenHidden means
      // this script can be stale relative to a store changed externally.
      // The variables argument here is the already-filtered (blank rows removed)
      // array from collectVariablesForSave() — used for the array-level
      // MAX_VARIABLES count, which must not count a row that is "not yet filled
      // in" (§9.4). Per-row
      // validation instead walks the DOM directly, addressing each row's own
      // error slot by its actual position — a blank row is skipped (no error,
      // never blocks Save) rather than reported as an invalid empty name.
      /** True when the user has put anything in this row beyond an empty name. */
      function rowHasContent(row) {
        return !!(
          row.querySelector(".var-label").value.trim() ||
          row.querySelector(".var-default").value ||
          row.querySelector(".var-secret").checked ||
          row.querySelector(".var-remember").checked
        );
      }

      function validateVariablesClientSide(variables) {
        var ok = true;
        var seen = Object.create(null);
        var rows = variablesList.querySelectorAll(".variable-row");
        for (var i = 0; i < rows.length; i++) {
          var row = rows[i];
          var errEl = row.querySelector(".field-error");
          var name = row.querySelector(".var-name").value.trim();
          var msg = "";
          if (!name) {
            // A wholly untouched row is "not yet filled in" — skip it silently so an
            // accidental Add Variable click never blocks Save. But a row where the
            // user typed a label/default (or ticked a box) and just missed the name
            // must NOT be silently dropped by collectVariablesForSave(); report it.
            if (rowHasContent(row)) {
              msg = "Variable name is required.";
            }
          } else {
            if (!isValidVariableName(name)) {
              msg = '"' + name + '" is not a valid variable name.';
            } else if (seen[name]) {
              msg = 'Duplicate variable name "' + name + '".';
            } else {
              seen[name] = true;
              var isSecretRow = row.querySelector(".var-secret").checked;
              var defaultVal = row.querySelector(".var-default").value;
              if (isSecretRow && defaultVal) {
                msg = '"' + name + '" is masked and cannot have a default value.';
              }
            }
          }
          if (errEl) errEl.textContent = msg;
          if (msg) ok = false;
        }
        var arrayMsg = "";
        if (variables.length > MAX_VARIABLES) {
          arrayMsg = "A macro may declare at most " + MAX_VARIABLES + " variables.";
        }
        document.getElementById("error-variables").textContent = arrayMsg;
        if (arrayMsg) ok = false;
        return ok;
      }

      function collectVariablesForSave() {
        var rows = variablesList.querySelectorAll(".variable-row");
        var result = [];
        for (var i = 0; i < rows.length; i++) {
          var row = rows[i];
          var name = row.querySelector(".var-name").value.trim();
          // §9.4 — a blank row is "not yet filled in", not a declared variable;
          // never send it, and never let it count toward the 10-variable cap.
          if (!name) continue;
          var label = row.querySelector(".var-label").value.trim();
          var isSecretRow = row.querySelector(".var-secret").checked;
          var defaultVal = row.querySelector(".var-default").value;
          var dontRemember = row.querySelector(".var-remember").checked;
          var variable = { name: name };
          if (label) variable.label = label;
          if (isSecretRow) {
            variable.secret = true;
            // remember is meaningless on a masked variable — never emitted for one.
          } else {
            if (defaultVal) variable.default = defaultVal;
            if (dontRemember) variable.remember = false;
          }
          result.push(variable);
        }
        return result;
      }

      function bindVariableRow(row) {
        var nameInput = row.querySelector(".var-name");
        var labelInput = row.querySelector(".var-label");
        var secretInput = row.querySelector(".var-secret");
        var defaultInput = row.querySelector(".var-default");
        var rememberInput = row.querySelector(".var-remember");
        var removeBtn = row.querySelector(".variable-remove-btn");

        // A host-posted saveError (§9.2) writes into this row's error slot; edit
        // ANY field in the row and that message is stale — clear it rather than
        // leaving it pinned to input the user has since changed.
        function clearRowError() {
          var errEl = row.querySelector(".field-error");
          if (errEl) errEl.textContent = "";
        }

        nameInput.addEventListener("input", function() {
          markDirty();
          updateRemoveAriaLabel(row);
          scheduleDiagnostics();
          updateTriggerConflictWarning();
          clearRowError();
        });
        labelInput.addEventListener("input", function() { markDirty(); clearRowError(); });
        defaultInput.addEventListener("input", function() { markDirty(); clearRowError(); });
        secretInput.addEventListener("change", function() {
          markDirty();
          defaultInput.disabled = secretInput.checked;
          if (secretInput.checked) defaultInput.value = "";
          // remember is meaningless on a masked variable (§7.1 fix) — disable
          // and visually mute "Don't remember" the same way default already is.
          rememberInput.disabled = secretInput.checked;
          if (secretInput.checked) rememberInput.checked = false;
          var rememberLabel = rememberInput.closest("label");
          if (rememberLabel) rememberLabel.classList.toggle("muted", secretInput.checked);
          clearRowError();
        });
        rememberInput.addEventListener("change", function() { markDirty(); clearRowError(); });
        removeBtn.addEventListener("click", function() {
          row.parentNode.removeChild(row);
          renumberVariableRows();
          markDirty();
          scheduleDiagnostics();
          updateTriggerConflictWarning();
        });

        updateRemoveAriaLabel(row);
      }

      function addVariableRow(prefillName) {
        var rows = variablesList.querySelectorAll(".variable-row");
        if (rows.length >= MAX_VARIABLES) {
          document.getElementById("error-variables").textContent = "A macro may declare at most " + MAX_VARIABLES + " variables.";
          return;
        }
        var fragment = variableRowTemplate.content.cloneNode(true);
        var row = fragment.querySelector(".variable-row");
        if (prefillName) {
          row.querySelector(".var-name").value = prefillName;
        }
        variablesList.appendChild(row);
        var addedRow = variablesList.lastElementChild;
        bindVariableRow(addedRow);
        renumberVariableRows();
        markDirty();
        scheduleDiagnostics();
        updateTriggerConflictWarning();
        // §9.1 — "+ Add Variable" moves focus into the new row's name input.
        addedRow.querySelector(".var-name").focus();
      }

      var existingVariableRows = variablesList.querySelectorAll(".variable-row");
      for (var vi = 0; vi < existingVariableRows.length; vi++) {
        bindVariableRow(existingVariableRows[vi]);
      }
      document.getElementById("add-variable-btn").addEventListener("click", function() {
        addVariableRow();
      });

      function requestNewMacro() {
        if (dirty) {
          vscode.postMessage({ type: "confirmSwitch", targetValue: "__new__" });
        } else {
          vscode.postMessage({ type: "selectMacro", value: "__new__" });
        }
      }

      function requestAddFromTemplate() {
        if (dirty) {
          vscode.postMessage({ type: "confirmAddFromTemplate" });
        } else {
          vscode.postMessage({ type: "addFromTemplate" });
        }
      }

      var emptyAddBtn = document.getElementById("empty-add-btn");
      if (emptyAddBtn) {
        emptyAddBtn.addEventListener("click", requestNewMacro);
      }
      var emptyTemplateBtn = document.getElementById("empty-template-btn");
      if (emptyTemplateBtn) {
        emptyTemplateBtn.addEventListener("click", requestAddFromTemplate);
      }

      // Track changes
      document.getElementById("macro-name").addEventListener("input", markDirty);
      document.getElementById("macro-text").addEventListener("input", function() {
        markDirty();
        scheduleDiagnostics();
        updateProfileTriggerConflictWarning();
        updateSessionIpmitoolHint();
      });
      document.getElementById("macro-secret").addEventListener("change", markDirty);
      document.getElementById("macro-trigger").addEventListener("input", function() {
        markDirty();
        var val = this.value.trim();
        var errorEl = document.getElementById("error-trigger");
        errorEl.textContent = validateTriggerPattern(val);
        updateTriggerConflictWarning();
        updateRunInConflictWarning();
        updateProfileTriggerConflictWarning();
      });
      document.getElementById("macro-run-in").addEventListener("change", function() {
        markDirty();
        updateRunInConflictWarning();
        updateProvideIpmiState();
        updateSessionIpmitoolHint();
      });
      document.getElementById("macro-provide-ipmi").addEventListener("change", markDirty);
      document.getElementById("macro-trigger-scope").addEventListener("change", function() {
        markDirty();
        updateTriggerProfileState();
      });
      document.getElementById("macro-trigger-profile").addEventListener("input", function() {
        markDirty();
        var triggerValue = document.getElementById("macro-trigger").value.trim();
        if (triggerValue && document.getElementById("macro-trigger-scope").value === "profile" && !this.value.trim()) {
          document.getElementById("error-trigger-profile").textContent = "Matching profile scope requires a saved profile.";
        } else if (triggerValue && KNOWN_PROFILE_IDS.length > 0 && this.value.trim() && KNOWN_PROFILE_IDS.indexOf(this.value.trim()) === -1) {
          document.getElementById("error-trigger-profile").textContent = "Unknown profile.";
        } else {
          document.getElementById("error-trigger-profile").textContent = "";
        }
      });
      document.getElementById("macro-cooldown").addEventListener("input", markDirty);
      document.getElementById("macro-interval").addEventListener("input", markDirty);
      document.getElementById("macro-trigger-disabled").addEventListener("change", markDirty);
      document.getElementById("macro-binding").addEventListener("input", function() {
        markDirty();
        var val = this.value.trim();
        var errorEl = document.getElementById("error-binding");
        if (val && !isValidBinding(val)) {
          errorEl.textContent = "Invalid. Use alt+KEY, alt+shift+KEY, or ctrl+shift+KEY (A-Z, 0-9).";
        } else {
          errorEl.textContent = "";
        }
      });
      document.getElementById("macro-folder").addEventListener("input", function() {
        markDirty();
        document.getElementById("error-folder").textContent = "";
      });
      initCustomComboboxes();

      // Macro selector — confirm discard if dirty
      initCustomSelects(function(wrapper, opt) {
        var value = opt.dataset.value;
        if (wrapper.id === "macro-selector") {
          if (dirty) {
            vscode.postMessage({ type: "confirmSwitch", targetValue: value });
          } else {
            vscode.postMessage({ type: "selectMacro", value: value });
          }
          wrapper.classList.remove("open");
          return;
        }
        selectCustomOption(wrapper, value);
      });

      // Save
      document.getElementById("save-btn").addEventListener("click", function() {
        // A storage failure from the previous attempt must not sit there looking like the
        // verdict on this one. Cleared here rather than on success, because success closes
        // the loop via "saved" and a client-side validation abort below never reaches the host.
        document.getElementById("error-save").textContent = "";
        var name = document.getElementById("macro-name").value.trim();
        var text = document.getElementById("macro-text").value;
        var secret = document.getElementById("macro-secret").checked;
        var bindingVal = document.getElementById("macro-binding").value.trim().toLowerCase();
        var triggerVal = document.getElementById("macro-trigger").value.trim();
        var cooldownVal = parseInt(document.getElementById("macro-cooldown").value, 10);
        var intervalVal = parseInt(document.getElementById("macro-interval").value, 10);
        var triggerInitiallyDisabled = document.getElementById("macro-trigger-disabled").checked;
        var triggerScope = document.getElementById("macro-trigger-scope").value;
        var triggerProfileId = document.getElementById("macro-trigger-profile").value.trim();
        var runInVal = document.getElementById("macro-run-in").value;
        var provideIpmiVal = document.getElementById("macro-provide-ipmi").checked;
        var folderVal = document.getElementById("macro-folder").value.trim();

        // Validate
        var valid = true;
        if (!name) {
          document.getElementById("error-name").textContent = "Name cannot be empty";
          valid = false;
        } else {
          document.getElementById("error-name").textContent = "";
        }
        if (!text) {
          document.getElementById("error-text").textContent = "Text cannot be empty";
          valid = false;
        } else {
          document.getElementById("error-text").textContent = "";
        }
        if (bindingVal && !isValidBinding(bindingVal)) {
          document.getElementById("error-binding").textContent = "Invalid binding format.";
          valid = false;
        } else {
          document.getElementById("error-binding").textContent = "";
        }
        if (triggerVal) {
          var triggerError = validateTriggerPattern(triggerVal);
          if (triggerError) {
            document.getElementById("error-trigger").textContent = triggerError;
            valid = false;
          } else {
            document.getElementById("error-trigger").textContent = "";
          }
        } else {
          document.getElementById("error-trigger").textContent = "";
        }
        if (triggerVal && triggerScope === "profile" && !triggerProfileId) {
          document.getElementById("error-trigger-profile").textContent = "Matching profile scope requires a saved profile.";
          valid = false;
        } else if (triggerVal && triggerScope === "profile" && KNOWN_PROFILE_IDS.length > 0 && KNOWN_PROFILE_IDS.indexOf(triggerProfileId) === -1) {
          document.getElementById("error-trigger-profile").textContent = "Unknown profile.";
          valid = false;
        } else {
          document.getElementById("error-trigger-profile").textContent = "";
        }

        if (triggerVal && runInVal !== "session") {
          document.getElementById("error-runIn").textContent = RUN_IN_CONFLICT_MESSAGE;
          valid = false;
        } else {
          document.getElementById("error-runIn").textContent = "";
        }

        if (triggerVal && scanProfileTokens(text).used.length > 0) {
          valid = false;
          // Same fallback discipline as the variables conflict below: never
          // clobber a more specific regex error already sitting on the field.
          if (!document.getElementById("error-trigger").textContent) {
            document.getElementById("error-trigger").textContent = PROFILE_TRIGGER_CONFLICT_MESSAGE;
          }
        }

        var variablesForSave = collectVariablesForSave();
        if (!validateVariablesClientSide(variablesForSave)) {
          valid = false;
        }
        if (triggerVal && variablesForSave.length > 0) {
          valid = false;
          // Don't clobber a more specific (regex safety / empty-match) trigger
          // error already set above — the conflict message is the fallback.
          if (!document.getElementById("error-trigger").textContent) {
            document.getElementById("error-trigger").textContent = TRIGGER_CONFLICT_MESSAGE;
          }
        }
        if (!valid) {
          // Design §9.4 — ANY save-time failure scrolls to it, not just a
          // host-posted one. Find the first non-empty field error in document
          // order and bring it into view.
          var fieldErrors = document.querySelectorAll(".field-error");
          for (var fe = 0; fe < fieldErrors.length; fe++) {
            if (fieldErrors[fe].textContent) {
              fieldErrors[fe].scrollIntoView({ block: "center" });
              break;
            }
          }
          return;
        }

        vscode.postMessage({
          type: "save",
          index: currentIndex,
          id: currentId,
          renderGeneration: currentRenderGeneration,
          name: name,
          text: text,
          secret: secret,
          keybinding: bindingVal || null,
          triggerPattern: triggerVal || null,
          triggerCooldown: isNaN(cooldownVal) ? 3 : cooldownVal,
          triggerInterval: isNaN(intervalVal) || intervalVal < 1 ? null : intervalVal,
          triggerInitiallyDisabled: triggerInitiallyDisabled,
          triggerScope: triggerScope,
          triggerProfileId: triggerProfileId || null,
          runIn: runInVal,
          provideIpmiCredentials: provideIpmiVal,
          variables: variablesForSave,
          group: folderVal || null
        });
      });

      // Delete
      document.getElementById("delete-btn").addEventListener("click", function() {
        if (currentIndex === null) return;
        // Same reason as the save handler: a delete also goes through the store, and a
        // previous attempt's storage error must not be read as this one's verdict.
        document.getElementById("error-save").textContent = "";
        vscode.postMessage({ type: "delete", index: currentIndex, id: currentId, renderGeneration: currentRenderGeneration });
      });

      // New
      document.getElementById("new-btn").addEventListener("click", requestNewMacro);

      // Messages from host
      window.addEventListener("message", function(event) {
        var msg = event.data;
        if (msg.type === "saved") {
          clearDirty();
        }
        if (msg.type === "saveError") {
          // §9.2 — per-row errors address a data-var-error="N" slot, never
          // an id (rows have no stable id; N is the row's DOM position).
          if (msg.field === "variable" && typeof msg.row === "number") {
            var rowErrEl = document.querySelector('[data-var-error="' + msg.row + '"]');
            if (rowErrEl) {
              rowErrEl.textContent = msg.message || "Invalid variable.";
              rowErrEl.scrollIntoView({ block: "center" });
            }
          } else {
            var field = msg.field || "trigger";
            var errEl = document.getElementById("error-" + field);
            if (errEl) {
              errEl.textContent = msg.message || "Could not save macro.";
              errEl.scrollIntoView({ block: "center" });
            }
          }
        }
      });
      updateTriggerProfileState();
      updateProvideIpmiState();
      computeDiagnostics();
      updateTriggerConflictWarning();
      updateRunInConflictWarning();
      updateProfileTriggerConflictWarning();
      updateSessionIpmitoolHint();
    })();`
  });
}
