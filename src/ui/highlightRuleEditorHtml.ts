import { escapeHtml } from "./shared/escapeHtml";
import { baseWebviewCss } from "./shared/webviewStyles";
import { baseWebviewJs } from "./shared/webviewScripts";
import { serializeForInlineScript } from "./shared/inlineScriptData";
import { renderWebviewDocument } from "./shared/webviewDocument";
import { regexSafetyWebviewJs } from "../utils/regexSafety";
import type { HighlightRule } from "../utils/highlightRuleValidation";
import { HIGHLIGHT_CONFLICT_RECOVERY, HIGHLIGHT_SETTINGS_REPAIR } from "./highlightProfileForm";

const COLOR_NAMES = [
  "black", "red", "green", "yellow", "blue", "magenta", "cyan", "white",
  "brightBlack", "brightRed", "brightGreen", "brightYellow", "brightBlue", "brightMagenta", "brightCyan", "brightWhite"
];

const COLOR_CSS: Record<string, string> = {
  black: "#000", red: "#cd3131", green: "#0dbc79", yellow: "#e5e510",
  blue: "#2472c8", magenta: "#bc3fbc", cyan: "#11a8cd", white: "#e5e5e5",
  brightBlack: "#666", brightRed: "#f14c4c", brightGreen: "#23d18b", brightYellow: "#f5f543",
  brightBlue: "#3b8eea", brightMagenta: "#d670d6", brightCyan: "#29b8db", brightWhite: "#fff"
};

function renderColorOptions(selected: string): string {
  const options = COLOR_NAMES.map(name => {
    const css = COLOR_CSS[name] ?? "";
    return `<div class="custom-select-option${name === selected ? " selected" : ""}" data-value="${escapeHtml(name)}"><span class="color-dot" style="background:${escapeHtml(css)};"></span> ${escapeHtml(name)}</div>`;
  });
  if (/^(3[0-7]|9[0-7])$/.test(selected)) {
    options.push(`<div class="custom-select-option selected" data-value="${escapeHtml(selected)}">Custom SGR code ${escapeHtml(selected)}</div>`);
  } else {
    options.push('<div class="custom-select-option" data-value="91">Custom SGR code 91</div>');
  }
  return options.join("\n        ");
}

export function renderHighlightRuleEditorHtml(rules: HighlightRule[], nonce: string, manager?: import("./highlightProfileEditorStore").HighlightEditorState): string {
  const colorsJson = serializeForInlineScript(COLOR_NAMES);
  const colorCssJson = serializeForInlineScript(COLOR_CSS);
  const rulesJson = serializeForInlineScript(rules);
  const managerJson = serializeForInlineScript(manager ?? null);
  const recoveryJson = serializeForInlineScript(HIGHLIGHT_SETTINGS_REPAIR);
  const conflictRecoveryJson = serializeForInlineScript(HIGHLIGHT_CONFLICT_RECOVERY);

  return renderWebviewDocument({
    nonce,
    css: `    ${baseWebviewCss()}
    #profile-repair-actions[hidden] {
      display: none;
    }
    #profile-manager { min-width: 0; }
    #profile-manager select {
      display: block;
      box-sizing: border-box;
      width: 100%;
      max-width: 100%;
      min-width: 0;
      padding: 5px 8px;
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border, transparent);
      font: inherit;
    }
    #profile-manager select:focus { outline: 1px solid var(--vscode-focusBorder); }
    #profile-manager .button-row { flex-wrap: wrap; }
    #profile-manager button { max-width: 100%; white-space: normal; }
    .rule-row {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 6px 8px;
      border: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.2));
      border-radius: 2px;
      margin-bottom: 4px;
      font-size: 13px;
    }
    .rule-row:hover {
      background: var(--vscode-list-hoverBackground, rgba(128,128,128,0.1));
    }
    .rule-pattern {
      flex: 1;
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 12px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .rule-label {
      font-family: var(--vscode-font-family, sans-serif);
      font-size: 13px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .rule-pattern-secondary {
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      margin-left: 6px;
    }
    .rule-row.rule-disabled .rule-pattern,
    .rule-row.rule-disabled .rule-label,
    .rule-row.rule-disabled .rule-pattern-secondary,
    .rule-row.rule-disabled .rule-color-swatch {
      opacity: 0.5;
    }
    .rule-color-swatch {
      display: inline-block;
      width: 16px;
      height: 16px;
      border-radius: 2px;
      border: 1px solid rgba(128,128,128,0.4);
      flex-shrink: 0;
    }
    .rule-flags {
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      min-width: 24px;
    }
    .rule-edit-btn, .rule-delete-btn {
      padding: 2px 8px;
      font-size: 12px;
    }
    .editor-section {
      margin-top: 16px;
      padding: 16px;
      border: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.2));
      border-radius: 4px;
      display: none;
    }
    .editor-section.visible {
      display: block;
    }
    .editor-section h4 {
      margin: 0 0 12px 0;
      font-size: 13px;
      font-weight: 600;
    }
    .checkbox-row {
      display: flex;
      gap: 16px;
      margin-top: 8px;
    }
    .checkbox-row label {
      display: flex;
      align-items: center;
      gap: 4px;
      font-weight: normal;
      font-size: 13px;
      cursor: pointer;
    }
    .preview-box {
      margin-top: 12px;
      padding: 10px 12px;
      background: var(--vscode-terminal-background, var(--vscode-editor-background));
      border: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.2));
      border-radius: 2px;
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 13px;
      line-height: 1.6;
      white-space: pre-wrap;
    }
    .hl-black { color: #000; } .hl-red { color: #cd3131; } .hl-green { color: #0dbc79; }
    .hl-yellow { color: #e5e510; } .hl-blue { color: #2472c8; } .hl-magenta { color: #bc3fbc; }
    .hl-cyan { color: #11a8cd; } .hl-white { color: #e5e5e5; } .hl-brightBlack { color: #666; }
    .hl-brightRed { color: #f14c4c; } .hl-brightGreen { color: #23d18b; } .hl-brightYellow { color: #f5f543; }
    .hl-brightBlue { color: #3b8eea; } .hl-brightMagenta { color: #d670d6; } .hl-brightCyan { color: #29b8db; }
    .hl-brightWhite { color: #fff; }
    .hl-bold { font-weight: bold; }
    .hl-underline { text-decoration: underline; }
    .color-dot {
      display: inline-block;
      width: 10px;
      height: 10px;
      border-radius: 50%;
      border: 1px solid rgba(128,128,128,0.4);
      vertical-align: middle;
    }
    .editor-error {
      font-size: 11px;
      color: var(--vscode-errorForeground, #f48771);
      margin-top: 4px;
      min-height: 16px;
    }
    .rules-dirty-indicator {
      display: none;
      align-self: center;
      color: var(--vscode-editorWarning-foreground, #cca700);
      font-size: 12px;
    }
    .rules-dirty-indicator.visible {
      display: inline;
    }
    .rules-empty-state {
      color: var(--vscode-descriptionForeground);
      font-style: italic;
      font-size: 12px;
    }`,
    body: `  <h3>Highlighting Rules</h3>
  <section id="profile-manager"${manager ? "" : " hidden"}>
    <div aria-live="polite"><div id="profile-highlighting-disabled" class="info-banner" hidden>
      Highlighting is off in the current settings. Enable nexus.terminal.highlighting.enabled in the applicable Settings scope for profiles to take effect.
      <button type="button" class="btn-secondary" id="profile-open-highlighting-settings">Open Highlighting Settings</button>
    </div></div>
    <label for="profile-select">Highlight profile</label>
    <select id="profile-select"></select>
    <label for="profile-name">Profile name</label>
    <input id="profile-name" type="text" maxlength="100" />
    <div class="button-row">
      <button type="button" class="btn-secondary" id="profile-create">Create empty</button>
      <button type="button" class="btn-secondary" id="profile-create-defaults">Create from defaults</button>
      <button type="button" class="btn-secondary" id="profile-rename">Rename</button>
      <button type="button" class="btn-secondary" id="profile-duplicate">Duplicate</button>
      <button type="button" class="btn-secondary" id="profile-delete">Delete</button>
    </div>
    <label for="profile-default">Global default</label>
    <select id="profile-default"></select>
    <div id="profile-workspace-override" class="setting-desc" hidden>Workspace settings override the global profile catalog or default. Changes here are saved globally and may not affect this workspace until its override is changed.</div>
    <div id="profile-workspace-note" class="setting-desc" hidden>Workspace legacy rules differ from global rules. Copy them explicitly to edit and save them globally.</div>
    <button type="button" class="btn-secondary" id="profile-workspace-copy" hidden>Copy workspace rules to selected profile</button>
    <div id="profile-validation-error" class="editor-error" aria-live="polite"></div>
    <div id="profile-repair-actions" class="button-row" hidden>
      <button type="button" class="btn-secondary" id="profile-repair-user">Open User Settings (JSON)</button>
      <button type="button" class="btn-secondary" id="profile-repair-workspace">Open Workspace Settings (JSON)</button>
    </div>
  </section>
  <div class="setting-desc">Rules use first-match precedence. Move specific rules above broader rules. Untick a rule to keep it but stop applying it.</div>

  <div id="rules-list"></div>
  <div id="rules-empty-state" class="rules-empty-state">No highlighting rules defined.</div>

  <div class="button-row" style="margin-top: 12px;">
    <button type="button" class="btn-secondary" id="add-rule-btn">+ Add Rule</button>
    <button type="button" class="btn-primary" id="apply-rules-btn" disabled>Apply</button>
    <button type="button" class="btn-secondary" id="cancel-rules-btn">Cancel</button>
    <span class="rules-dirty-indicator" id="rules-dirty-indicator" aria-live="polite">Unsaved changes</span>
    <button type="button" class="btn-secondary" id="reset-defaults-btn" style="margin-left: auto;">Reset to Defaults</button>
  </div>
  <div class="editor-error" id="save-error" aria-live="polite"></div>

  <div class="editor-section" id="editor-section">
    <h4 id="editor-title">Edit Rule</h4>

    <div class="form-group">
      <label for="edit-label">Label (optional)</label>
      <input type="text" id="edit-label" maxlength="100" placeholder="e.g. Critical / fatal errors" />
    </div>

    <div class="form-group">
      <label for="edit-description">Description (optional)</label>
      <input type="text" id="edit-description" maxlength="500" placeholder="What this rule matches and why" />
    </div>

    <div class="form-group">
      <label for="edit-pattern">Pattern (regex)</label>
      <input type="text" id="edit-pattern" placeholder="e.g. \\bERROR\\b" />
      <div class="editor-error" id="pattern-error"></div>
    </div>

    <div class="form-group">
      <label>Color</label>
      <div class="custom-select" id="color-select-wrapper">
        <input type="hidden" id="edit-color" value="red" />
        <div class="custom-select-trigger" tabindex="0">
          <span class="custom-select-text">red</span>
        </div>
        <div class="custom-select-dropdown">
          ${renderColorOptions("red")}
        </div>
      </div>
    </div>

    <div class="checkbox-row">
      <label><input type="checkbox" id="edit-flag-g" checked /> Global (g)</label>
      <label><input type="checkbox" id="edit-flag-i" checked /> Case-insensitive (i)</label>
    </div>

    <div class="checkbox-row">
      <label><input type="checkbox" id="edit-bold" /> Bold</label>
      <label><input type="checkbox" id="edit-underline" /> Underline</label>
    </div>

    <label style="margin-top: 12px; margin-bottom: 4px;">Preview</label>
    <div class="preview-box" id="preview-box">Connection ERROR: timeout on port 22
WARNING: disk usage at 90%
Server ready - OK
INFO: session started for user admin
DEBUG: packet sent 1024 bytes</div>

    <div class="button-row" style="margin-top: 12px;">
      <button type="button" class="btn-primary" id="save-rule-btn">Stage Rule</button>
      <button type="button" class="btn-secondary" id="cancel-edit-btn">Cancel</button>
      <button type="button" class="btn-danger" id="delete-rule-btn" title="Delete this rule and discard its unfinished edit" style="margin-left: auto; display: none;">Delete Rule</button>
    </div>
  </div>
`,
    script: `    ${baseWebviewJs()}
    (function() {
      var vscode = acquireVsCodeApi();
      var VALID_COLORS = ${colorsJson};
      var COLOR_CSS_MAP = ${colorCssJson};
      var SAMPLE_TEXT = "eth0: <BROADCAST,MULTICAST,UP> state UP\\nERROR: connection refused on port 443\\nWARNING: disk usage at 90%\\nINFO: session started for user admin\\n192.168.1.100 - ESTABLISHED\\nsshd: ACCEPTED publickey for root\\n5 input errors, 0 CRC, 0 frame, 3 overruns, 0 ignored";
      ${regexSafetyWebviewJs()}

      var manager = ${managerJson};
      var recoveryInstructions = ${recoveryJson};
      var conflictRecovery = ${conflictRecoveryJson};
      var profiles = manager ? JSON.parse(JSON.stringify(manager.catalog.profiles)) : null;
      var originalProfiles = profiles ? JSON.parse(JSON.stringify(profiles)) : null;
      var defaultProfileId = manager ? manager.catalog.defaultProfileId : null;
      var originalDefaultProfileId = defaultProfileId;
      var selectedProfileId = profiles && profiles.length ? (profiles.some(function(p) { return p.id === defaultProfileId; }) ? defaultProfileId : profiles[0].id) : null;
      var revision = manager ? manager.revision : null;
      var pendingSnapshot = null;
      var rules = manager ? ((profiles.find(function(p) { return p.id === selectedProfileId; }) || {}).rules || []) : ${rulesJson};
      var originalRules = JSON.parse(JSON.stringify(rules));
      var editingIndex = -1;
      var ruleGuardMessage = "Stage Rule to keep this rule edit, or use Cancel in the rule editor to discard it before continuing.";
      var priorRuleGuardError = "";
      var previewTimer = null;
      var regexCache = {};

      initCustomSelects();
      if (manager) initProfileManager();
      renderRulesList();
      setDirty(false);

      function setDirty(value) {
        var indicator = document.getElementById("rules-dirty-indicator");
        var applyBtn = document.getElementById("apply-rules-btn");
        indicator.classList.toggle("visible", !!value);
        applyBtn.disabled = !value || !!pendingSnapshot;
      }

      // Dirty is derived from actual content, not "something happened" — so
      // reordering back to the original order, or unticking a checkbox and
      // re-ticking it, clears the flag (and disables Apply) again instead of
      // sticking dirty on any touch.
      //
      // Compares NORMALIZED rules, not the raw arrays: the checkbox handler
      // deletes the enabled field when ticking a rule back on (see the
      // "change" listener below) so the saved payload stays clean, but a
      // rule saved with an explicit enabled: true (e.g. a hand-written or
      // imported settings.json) never had the key removed in the first
      // place. Diffing the raw JSON would then see "no enabled key" vs.
      // "enabled: true" as a real difference and stay dirty forever after an
      // untick/retick that changed nothing semantically. Normalizing both
      // sides so enabled: true and "absent" collapse to the same shape fixes
      // the comparison without touching what actually gets saved (stageRule
      // / the checkbox handler still omit the key on enable).
      function normalizeRulesForCompare(list) {
        var out = [];
        for (var i = 0; i < list.length; i++) {
          var copy = {};
          for (var key in list[i]) {
            if (Object.prototype.hasOwnProperty.call(list[i], key)) {
              copy[key] = list[i][key];
            }
          }
          if (copy.enabled === true) {
            delete copy.enabled;
          }
          out.push(copy);
        }
        return out;
      }

      function recomputeDirty() {
        var changed = manager
          ? JSON.stringify(normalizeProfilesForCompare(profiles)) !== JSON.stringify(normalizeProfilesForCompare(originalProfiles)) || defaultProfileId !== originalDefaultProfileId
          : JSON.stringify(normalizeRulesForCompare(rules)) !== JSON.stringify(normalizeRulesForCompare(originalRules));
        setDirty(changed);
      }

      function normalizeProfilesForCompare(list) {
        return list.map(function(profile) { return { id: profile.id, name: profile.name, rules: normalizeRulesForCompare(profile.rules) }; });
      }

      function currentProfile() { return profiles.find(function(p) { return p.id === selectedProfileId; }); }
      function finishRuleFirst() {
        if (!manager || !document.getElementById("editor-section").classList.contains("visible")) return true;
        var error = document.getElementById("save-error");
        if (error.textContent !== ruleGuardMessage) priorRuleGuardError = error.textContent;
        error.textContent = ruleGuardMessage;
        return false;
      }
      function selectProfile(id) {
        selectedProfileId = id;
        var profile = currentProfile();
        rules = profile ? profile.rules : [];
        document.getElementById("add-rule-btn").disabled = !profile;
        document.getElementById("reset-defaults-btn").disabled = !profile;
        document.getElementById("profile-name").value = profile ? profile.name : "";
        closeEditor();
        renderRulesList();
      }
      function refreshProfileSelectors() {
        var selector = document.getElementById("profile-select");
        var defaults = document.getElementById("profile-default");
        selector.innerHTML = ""; defaults.innerHTML = "";
        var none = document.createElement("option"); none.value = ""; none.textContent = "None"; defaults.appendChild(none);
        profiles.forEach(function(profile) {
          var opt = document.createElement("option"); opt.value = profile.id; opt.textContent = profile.name; selector.appendChild(opt);
          var def = document.createElement("option"); def.value = profile.id; def.textContent = profile.name; defaults.appendChild(def);
        });
        if (defaultProfileId && !profiles.some(function(profile) { return profile.id === defaultProfileId; })) {
          var missing = document.createElement("option"); missing.value = defaultProfileId; missing.textContent = "Missing profile: " + defaultProfileId; defaults.appendChild(missing);
        }
        selector.value = selectedProfileId || "";
        defaults.value = defaultProfileId || "";
      }
      function profileName() {
        var name = document.getElementById("profile-name").value.trim();
        if (!name || name.length > 100) { document.getElementById("save-error").textContent = "Enter a profile name of 1–100 characters."; return null; }
        return name;
      }
      function freshId() {
        var id;
        do { id = "profile-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2); }
        while (profiles.some(function(profile) { return profile.id === id; }));
        return id;
      }
      function uniqueProfileName(base) {
        var name = base.slice(0, 100), suffix = 2;
        while (profiles.some(function(p) { return p.name.toLowerCase() === name.toLowerCase(); })) {
          var ending = " (" + suffix++ + ")";
          name = base.slice(0, 100 - ending.length) + ending;
        }
        return name;
      }
      function addProfile(sourceRules, duplicate) {
        if (!finishRuleFirst()) return;
        var current = currentProfile();
        var input = document.getElementById("profile-name").value.trim();
        var name = !input || (current && input === current.name)
          ? uniqueProfileName(duplicate && current ? current.name.slice(0, 93) + " (copy)" : "New profile")
          : profileName();
        if (!name) return;
        if (profiles.some(function(p) { return p.name.toLowerCase() === name.toLowerCase(); })) {
          document.getElementById("save-error").textContent = "A profile with that name already exists. Choose a different name.";
          return;
        }
        if (profiles.length >= 100) { document.getElementById("save-error").textContent = "Maximum of 100 profiles reached."; return; }
        var profile = { id: freshId(), name: name, rules: JSON.parse(JSON.stringify(sourceRules)) };
        profiles.push(profile); selectedProfileId = profile.id;
        refreshProfileSelectors(); selectProfile(profile.id); recomputeDirty();
      }
      function updateScopeWarnings() {
        document.getElementById("profile-workspace-override").hidden = !manager.workspaceCatalogOverrides;
        document.getElementById("profile-workspace-note").hidden = !manager.workspaceLegacyRules;
        document.getElementById("profile-workspace-copy").hidden = !manager.workspaceLegacyRules;
      }
      function updateRecovery(state) {
        var errors = [];
        if (state.catalog.validationError) errors.push(state.catalog.validationError);
        if (state.effectiveValidationError && errors.indexOf(state.effectiveValidationError) < 0) errors.push(state.effectiveValidationError);
        if (state.effectiveMissingDefaultId) errors.push("Default highlight profile is missing: " + state.effectiveMissingDefaultId + ".");
        document.getElementById("profile-validation-error").textContent = errors.length ? errors.join(" ") + " " + recoveryInstructions : "";
        document.getElementById("profile-repair-actions").hidden = errors.length === 0;
      }
      function updateHighlightingEnabled(state) {
        document.getElementById("profile-highlighting-disabled").hidden = state.effectiveEnabled !== false;
      }
      function initProfileManager() {
        updateScopeWarnings();
        updateRecovery(manager);
        updateHighlightingEnabled(manager);
        refreshProfileSelectors(); selectProfile(selectedProfileId);
        if (manager.workspaceLegacyRules) {
          document.getElementById("profile-workspace-note").hidden = false;
          document.getElementById("profile-workspace-copy").hidden = false;
        }
        document.getElementById("profile-repair-user").addEventListener("click", function() { vscode.postMessage({ type: "openHighlightSettingsJson", scope: "user" }); });
        document.getElementById("profile-open-highlighting-settings").addEventListener("click", function() { vscode.postMessage({ type: "openHighlightingSettings" }); });
        document.getElementById("profile-repair-workspace").addEventListener("click", function() { vscode.postMessage({ type: "openHighlightSettingsJson", scope: "workspace" }); });
        document.getElementById("profile-select").addEventListener("change", function(e) { if (!finishRuleFirst()) { e.target.value = selectedProfileId || ""; return; } selectProfile(e.target.value); });
        document.getElementById("profile-default").addEventListener("change", function(e) { defaultProfileId = e.target.value || null; recomputeDirty(); });
        document.getElementById("profile-create").addEventListener("click", function() { addProfile([]); });
        document.getElementById("profile-create-defaults").addEventListener("click", function() { addProfile(manager.shippedRules || []); });
        document.getElementById("profile-rename").addEventListener("click", function() { var p = currentProfile(); var name = profileName(); if (!p || !name) return; p.name = name; refreshProfileSelectors(); recomputeDirty(); });
        document.getElementById("profile-duplicate").addEventListener("click", function() { var p = currentProfile(); if (p) addProfile(p.rules, true); });
        document.getElementById("profile-delete").addEventListener("click", function() { if (!finishRuleFirst()) return; if (currentProfile()) vscode.postMessage({ type: "confirmDeleteProfile", profileId: selectedProfileId, profileName: currentProfile().name }); });
        document.getElementById("profile-workspace-copy").addEventListener("click", function() { if (!finishRuleFirst()) return; var p = currentProfile(); if (!p || !manager.workspaceLegacyRules) return; p.rules = JSON.parse(JSON.stringify(manager.workspaceLegacyRules)); selectProfile(p.id); recomputeDirty(); });
      }

      function renderRulesList() {
        var list = document.getElementById("rules-list");
        list.innerHTML = "";
        document.getElementById("rules-empty-state").style.display = rules.length === 0 ? "" : "none";
        for (var i = 0; i < rules.length; i++) {
          var r = rules[i];
          var isEnabled = r.enabled !== false;
          var row = document.createElement("div");
          row.className = "rule-row" + (isEnabled ? "" : " rule-disabled");
          row.dataset.index = String(i);

          var enabledCb = document.createElement("input");
          enabledCb.type = "checkbox";
          enabledCb.className = "rule-enabled-cb";
          enabledCb.dataset.index = String(i);
          enabledCb.checked = isEnabled;
          enabledCb.title = isEnabled ? "Disable this rule" : "Enable this rule";

          var patSpan = document.createElement("span");
          patSpan.className = "rule-pattern";
          // The description tooltip lives on this span, not the row — the row
          // also contains the Up/Down/Edit/× buttons, and a row-wide title
          // attribute covers them with the tooltip too, blocking their own
          // titles (color swatch, checkbox) from showing.
          if (r.description) patSpan.title = r.description;
          if (r.label) {
            patSpan.classList.add("rule-label");
            patSpan.textContent = r.label;
            var patSecondary = document.createElement("span");
            patSecondary.className = "rule-pattern-secondary";
            patSecondary.textContent = r.pattern;
            patSpan.appendChild(patSecondary);
          } else {
            patSpan.textContent = r.pattern;
          }

          var colorSwatch = document.createElement("span");
          colorSwatch.className = "rule-color-swatch";
          colorSwatch.style.background = COLOR_CSS_MAP[r.color] || "#888";
          colorSwatch.title = r.color;

          var flagsSpan = document.createElement("span");
          flagsSpan.className = "rule-flags";
          var styleFlags = [];
          styleFlags.push("#" + (i + 1));
          if (r.flags) styleFlags.push(r.flags);
          if (r.bold) styleFlags.push("B");
          if (r.underline) styleFlags.push("U");
          flagsSpan.textContent = styleFlags.join(" ");

          var upBtn = document.createElement("button");
          upBtn.type = "button";
          upBtn.className = "btn-secondary rule-up-btn";
          upBtn.dataset.index = String(i);
          upBtn.textContent = "Up";

          var downBtn = document.createElement("button");
          downBtn.type = "button";
          downBtn.className = "btn-secondary rule-down-btn";
          downBtn.dataset.index = String(i);
          downBtn.textContent = "Down";

          var editBtn = document.createElement("button");
          editBtn.type = "button";
          editBtn.className = "btn-secondary rule-edit-btn";
          editBtn.dataset.index = String(i);
          editBtn.textContent = "Edit";

          var delBtn = document.createElement("button");
          delBtn.type = "button";
          delBtn.className = "btn-secondary rule-delete-btn";
          delBtn.dataset.index = String(i);
          delBtn.textContent = "\\u00D7";

          row.appendChild(enabledCb);
          row.appendChild(patSpan);
          row.appendChild(colorSwatch);
          row.appendChild(flagsSpan);
          row.appendChild(upBtn);
          row.appendChild(downBtn);
          row.appendChild(editBtn);
          row.appendChild(delBtn);
          list.appendChild(row);
        }
      }

      document.getElementById("rules-list").addEventListener("change", function(e) {
        var cb = e.target.closest(".rule-enabled-cb");
        if (!cb) return;
        var idx = parseInt(cb.dataset.index, 10);
        var rule = rules[idx];
        if (!rule) return;
        if (cb.checked) {
          delete rule.enabled;
        } else {
          rule.enabled = false;
        }
        renderRulesList();
        recomputeDirty();
      });

      document.getElementById("rules-list").addEventListener("click", function(e) {
        if (e.target.closest(".rule-enabled-cb")) {
          return;
        }
        var editBtn = e.target.closest(".rule-edit-btn");
        if (editBtn) {
          if (!finishRuleFirst()) return;
          openEditor(parseInt(editBtn.dataset.index, 10));
          return;
        }
        var delBtn = e.target.closest(".rule-delete-btn");
        if (delBtn) {
          var idx = parseInt(delBtn.dataset.index, 10);
          if (editingIndex === idx && !finishRuleFirst()) return;
          rules.splice(idx, 1);
          renderRulesList();
          recomputeDirty();
          if (editingIndex === idx) closeEditor();
          else if (editingIndex > idx) editingIndex--;
          return;
        }
        var upBtn = e.target.closest(".rule-up-btn");
        if (upBtn) {
          var upIdx = parseInt(upBtn.dataset.index, 10);
          if (upIdx > 0) {
            var item = rules.splice(upIdx, 1)[0];
            rules.splice(upIdx - 1, 0, item);
            // The item at upIdx swapped places with the item at upIdx-1 — keep
            // editingIndex pointed at whichever rule it was tracking, not at
            // whatever now happens to sit at the same array slot. Without this,
            // Stage Rule after a reorder can overwrite the WRONG rule's slot
            // (see the "moved index" regression in highlightRuleEditorHarness).
            if (editingIndex === upIdx) editingIndex = upIdx - 1;
            else if (editingIndex === upIdx - 1) editingIndex = upIdx;
            renderRulesList();
            recomputeDirty();
          }
          return;
        }
        var downBtn = e.target.closest(".rule-down-btn");
        if (downBtn) {
          var downIdx = parseInt(downBtn.dataset.index, 10);
          if (downIdx >= 0 && downIdx < rules.length - 1) {
            var item2 = rules.splice(downIdx, 1)[0];
            rules.splice(downIdx + 1, 0, item2);
            // Mirror of the Up case above.
            if (editingIndex === downIdx) editingIndex = downIdx + 1;
            else if (editingIndex === downIdx + 1) editingIndex = downIdx;
            renderRulesList();
            recomputeDirty();
          }
        }
      });

      document.getElementById("add-rule-btn").addEventListener("click", function() {
        if (!finishRuleFirst()) return;
        openEditor(-1);
      });

      document.getElementById("save-rule-btn").addEventListener("click", function() {
        var pattern = document.getElementById("edit-pattern").value.trim();
        if (!pattern) {
          showPatternError("Pattern is required.");
          return;
        }
        if (pattern.length > 500) {
          showPatternError("Pattern too long (max 500 chars).");
          return;
        }
        var safetyError = validateRegexSafety(pattern);
        if (safetyError) {
          showPatternError(safetyError);
          return;
        }
        var flags = buildFlags();
        try {
          var re = new RegExp(pattern, flags);
          if (re.test("")) {
            showPatternError("Pattern must not match empty strings.");
            return;
          }
        } catch (ex) {
          showPatternError("Invalid regex: " + ex.message);
          return;
        }
        var color = document.getElementById("edit-color").value;
        if (VALID_COLORS.indexOf(color) === -1 && !isValidSgrColor(color)) {
          showPatternError("Invalid color.");
          return;
        }
        var rule = { pattern: pattern, color: color, flags: flags };
        if (document.getElementById("edit-bold").checked) rule.bold = true;
        if (document.getElementById("edit-underline").checked) rule.underline = true;
        var label = document.getElementById("edit-label").value.trim();
        if (label) rule.label = label;
        var description = document.getElementById("edit-description").value.trim();
        if (description) rule.description = description;

        if (editingIndex >= 0 && editingIndex < rules.length) {
          // Row checkbox owns enabled state — the form has no control for it, so
          // carry over whatever the rule being edited already had.
          if (rules[editingIndex].enabled === false) rule.enabled = false;
          rules[editingIndex] = rule;
        } else {
          rules.push(rule);
        }
        renderRulesList();
        recomputeDirty();
        closeEditor();
      });

      document.getElementById("cancel-edit-btn").addEventListener("click", function() {
        closeEditor();
      });

      document.getElementById("delete-rule-btn").addEventListener("click", function() {
        if (editingIndex >= 0 && editingIndex < rules.length) {
          rules.splice(editingIndex, 1);
          renderRulesList();
          recomputeDirty();
          closeEditor();
        }
      });

      document.getElementById("apply-rules-btn").addEventListener("click", function() {
        if (!finishRuleFirst()) return;
        saveRules();
      });

      document.getElementById("cancel-rules-btn").addEventListener("click", function() {
        if (!finishRuleFirst()) return;
        if (manager) {
          vscode.postMessage({ type: "cancelCatalogDraft" });
          profiles = JSON.parse(JSON.stringify(originalProfiles)); defaultProfileId = originalDefaultProfileId;
          if (!currentProfile()) selectedProfileId = profiles.length ? profiles[0].id : null;
          refreshProfileSelectors(); selectProfile(selectedProfileId);
        } else { rules = JSON.parse(JSON.stringify(originalRules)); }
        renderRulesList();
        setDirty(false);
        closeEditor();
        document.getElementById("save-error").textContent = "";
      });

      document.getElementById("reset-defaults-btn").addEventListener("click", function() {
        if (!finishRuleFirst()) return;
        if (manager) {
          var profile = currentProfile(); if (!profile) return;
          profile.rules = JSON.parse(JSON.stringify(manager.shippedRules || [])); selectProfile(profile.id); recomputeDirty();
        } else { vscode.postMessage({ type: "resetDefaults" }); }
      });

      var patternInput = document.getElementById("edit-pattern");
      var flagG = document.getElementById("edit-flag-g");
      var flagI = document.getElementById("edit-flag-i");
      var boldCb = document.getElementById("edit-bold");
      var underlineCb = document.getElementById("edit-underline");
      var colorInput = document.getElementById("edit-color");

      function schedulePreview() {
        clearTimeout(previewTimer);
        previewTimer = setTimeout(updatePreview, 300);
      }

      patternInput.addEventListener("input", schedulePreview);
      flagG.addEventListener("change", schedulePreview);
      flagI.addEventListener("change", schedulePreview);
      boldCb.addEventListener("change", schedulePreview);
      underlineCb.addEventListener("change", schedulePreview);
      colorInput.addEventListener("change", schedulePreview);

      function buildFlags() {
        var f = "";
        if (flagG.checked) f += "g";
        if (flagI.checked) f += "i";
        return f;
      }

      function isValidSgrColor(value) {
        return /^(3[0-7]|9[0-7])$/.test(String(value));
      }

      function updatePreview() {
        var box = document.getElementById("preview-box");
        var pattern = patternInput.value.trim();
        if (!pattern) {
          box.textContent = SAMPLE_TEXT;
          showPatternError("");
          return;
        }
        var safetyError = validateRegexSafety(pattern);
        if (safetyError) {
          box.textContent = SAMPLE_TEXT;
          showPatternError(safetyError);
          return;
        }
        var flags = buildFlags();
        var cacheKey = pattern + "|" + flags;
        var regex = regexCache[cacheKey];
        if (!regex) {
          try {
            regex = new RegExp(pattern, flags);
            regexCache[cacheKey] = regex;
          } catch (ex) {
            box.textContent = SAMPLE_TEXT;
            showPatternError("");
            return;
          }
        }
        if (regex.test("")) {
          box.textContent = SAMPLE_TEXT;
          showPatternError("Pattern matches empty strings.");
          return;
        }
        showPatternError("");
        var color = colorInput.value;
        if (VALID_COLORS.indexOf(color) === -1 && !isValidSgrColor(color)) color = "red";
        var isBold = boldCb.checked;
        var isUnderline = underlineCb.checked;

        regex.lastIndex = 0;
        var html = "";
        var lastIdx = 0;
        var text = SAMPLE_TEXT;
        var match;
        var safeCount = 0;
        while ((match = regex.exec(text)) !== null && safeCount < 200) {
          safeCount++;
          if (match[0].length === 0) { regex.lastIndex++; continue; }
          if (match.index > lastIdx) {
            html += escapeHtml(text.slice(lastIdx, match.index));
          }
          var cls = VALID_COLORS.indexOf(color) !== -1 ? "hl-" + escapeHtml(color) : "hl-brightRed";
          if (isBold) cls += " hl-bold";
          if (isUnderline) cls += " hl-underline";
          html += '<span class="' + cls + '">' + escapeHtml(match[0]) + '</span>';
          lastIdx = match.index + match[0].length;
          if (!flags.includes("g")) break;
        }
        if (lastIdx < text.length) {
          html += escapeHtml(text.slice(lastIdx));
        }
        box.innerHTML = html;
      }

      function showPatternError(msg) {
        var el = document.getElementById("pattern-error");
        el.textContent = msg || "";
      }

      function openEditor(index) {
        editingIndex = index;
        var section = document.getElementById("editor-section");
        var title = document.getElementById("editor-title");
        var deleteBtn = document.getElementById("delete-rule-btn");

        if (index >= 0 && index < rules.length) {
          var r = rules[index];
          title.textContent = "Edit Rule " + (index + 1);
          document.getElementById("edit-label").value = r.label || "";
          document.getElementById("edit-description").value = r.description || "";
          patternInput.value = r.pattern;
          var f = r.flags || "gi";
          flagG.checked = f.indexOf("g") !== -1;
          flagI.checked = f.indexOf("i") !== -1;
          boldCb.checked = !!r.bold;
          underlineCb.checked = !!r.underline;
          var color = VALID_COLORS.indexOf(r.color) !== -1 || isValidSgrColor(r.color) ? r.color : "red";
          selectCustomOption(document.getElementById("color-select-wrapper"), color);
          deleteBtn.style.display = "";
        } else {
          title.textContent = "Add New Rule";
          document.getElementById("edit-label").value = "";
          document.getElementById("edit-description").value = "";
          patternInput.value = "";
          flagG.checked = true;
          flagI.checked = true;
          boldCb.checked = false;
          underlineCb.checked = false;
          selectCustomOption(document.getElementById("color-select-wrapper"), "red");
          deleteBtn.style.display = "none";
        }
        showPatternError("");
        section.classList.add("visible");
        updatePreview();
        patternInput.focus();
      }

      function closeEditor() {
        editingIndex = -1;
        document.getElementById("editor-section").classList.remove("visible");
        var error = document.getElementById("save-error");
        if (error.textContent === ruleGuardMessage) error.textContent = priorRuleGuardError;
        priorRuleGuardError = "";
      }

      function saveRules() {
        document.getElementById("save-error").textContent = "";
        if (manager) {
          if (pendingSnapshot) return;
          pendingSnapshot = { profiles: JSON.parse(JSON.stringify(profiles)), defaultProfileId: defaultProfileId };
          setDirty(true);
          vscode.postMessage({ type: "saveCatalog", profiles: pendingSnapshot.profiles, defaultProfileId: pendingSnapshot.defaultProfileId, revision: revision });
        } else { vscode.postMessage({ type: "saveRules", rules: rules }); }
      }

      window.addEventListener("message", function(event) {
        var msg = event.data;
        if (manager && msg.type === "confirmDeleteProfileResult" && msg.profileId === selectedProfileId && msg.confirmed) {
          if (!finishRuleFirst()) return;
          profiles = profiles.filter(function(p) { return p.id !== msg.profileId; });
          if (defaultProfileId === msg.profileId) defaultProfileId = null;
          selectedProfileId = profiles.length ? profiles[0].id : null;
          refreshProfileSelectors(); selectProfile(selectedProfileId); recomputeDirty();
        }
        if (manager && msg.type === "catalogUpdated") {
          updateRecovery(msg.state);
          updateHighlightingEnabled(msg.state);
          if (document.getElementById("apply-rules-btn").disabled && !pendingSnapshot && !document.getElementById("editor-section").classList.contains("visible")) {
            manager = msg.state; profiles = JSON.parse(JSON.stringify(manager.catalog.profiles)); originalProfiles = JSON.parse(JSON.stringify(profiles));
            defaultProfileId = manager.catalog.defaultProfileId; originalDefaultProfileId = defaultProfileId; revision = manager.revision;
            if (!currentProfile()) selectedProfileId = profiles.length ? profiles[0].id : null;
            updateScopeWarnings(); refreshProfileSelectors(); selectProfile(selectedProfileId); setDirty(false);
          } else if (!pendingSnapshot && msg.state.revision !== revision) { document.getElementById("save-error").textContent = "Highlight settings changed elsewhere. " + conflictRecovery; }
        }
        if (manager && msg.type === "catalogSaveResult") {
          if (msg.ok && pendingSnapshot) {
            originalProfiles = pendingSnapshot.profiles; originalDefaultProfileId = pendingSnapshot.defaultProfileId;
            revision = msg.revision; pendingSnapshot = null; recomputeDirty();
            document.getElementById("save-error").textContent = "";
          } else { pendingSnapshot = null; recomputeDirty(); document.getElementById("save-error").textContent = msg.message || "Could not save highlight profiles."; }
        }
        if (msg.type === "rulesUpdated") {
          rules = msg.rules;
          originalRules = JSON.parse(JSON.stringify(rules));
          renderRulesList();
          setDirty(false);
          if (editingIndex >= 0) closeEditor();
        }
        if (msg.type === "saveResult") {
          if (msg.ok) {
            originalRules = JSON.parse(JSON.stringify(rules));
            setDirty(false);
            document.getElementById("save-error").textContent = "";
          } else {
            document.getElementById("save-error").textContent = msg.message || "Could not save highlighting rules.";
          }
        }
      });
    })();`
  });
}
