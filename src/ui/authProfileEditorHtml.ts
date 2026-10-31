import { parseExternalArgumentsText } from "./externalCredentialForm";
import type { AuthProfile } from "../models/config";
import { escapeHtml } from "./shared/escapeHtml";
import { baseWebviewCss } from "./shared/webviewStyles";
import { baseWebviewJs } from "./shared/webviewScripts";
import { renderWebviewDocument } from "./shared/webviewDocument";
import { SSH_AGENT_FORM_NOTE } from "./settingsMetadata";

export function renderAuthProfileEditorHtml(
  profiles: AuthProfile[],
  selectedId: string | null,
  nonce: string,
  justSavedName?: string
): string {
  const profile = selectedId !== null ? profiles.find((p) => p.id === selectedId) : undefined;

  // Build profile selector options
  const selectorOptions = profiles
    .map(
      (p) =>
        `<div class="custom-select-option${p.id === selectedId ? " selected" : ""}" data-value="${escapeHtml(p.id)}">${escapeHtml(p.name)}</div>`
    )
    .join("\n        ");

  const newOption = `<div class="custom-select-option${selectedId === null && profiles.length > 0 ? " selected" : ""}" data-value="__new__">+ New Profile</div>`;

  const triggerLabel = profile ? profile.name : (profiles.length > 0 ? "Select a profile\u2026" : "+ New Profile");
  const hiddenValue = selectedId !== null ? escapeHtml(selectedId) : "__new__";

  const nameValue = profile?.name ?? "";
  const usernameValue = profile?.username ?? "";
  const authTypeValue = profile?.authType ?? "password";
  const keyPathValue = profile?.keyPath ?? "";
  const external = profile?.authType === "external" ? profile.external : undefined;
  const isNew = selectedId === null;
  const saveLabel = isNew ? "Create" : "Save";
  const deleteDisabled = isNew ? " disabled" : "";

  const authTypeOptions = [
    { label: "Password", value: "password" },
    { label: "Private Key", value: "key" },
    { label: "SSH Agent", value: "agent" },
    { label: "External Program", value: "external" }
  ];
  const authTypeOptionsHtml = authTypeOptions
    .map(
      (o) =>
        `<div class="custom-select-option${o.value === authTypeValue ? " selected" : ""}" data-value="${o.value}" id="authtype-option-${o.value}" role="option" aria-selected="${o.value === authTypeValue ? "true" : "false"}">${escapeHtml(o.label)}</div>`
    )
    .join("\n          ");
  const authTypeTriggerLabel = authTypeOptions.find((o) => o.value === authTypeValue)?.label ?? "Unknown authentication";

  return renderWebviewDocument({
    nonce,
    css: `    ${baseWebviewCss()}
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
    .save-indicator {
      display: none;
      font-size: 12px;
      font-weight: 600;
      color: var(--vscode-testing-iconPassed, #2ea043);
      margin-left: 4px;
    }
    .save-indicator.visible {
      display: inline;
    }
    .browse-row {
      display: flex;
      gap: 6px;
      align-items: center;
    }
    .browse-row input {
      flex: 1;
    }
    .conditional-field {
      display: none;
    }
    .conditional-field.visible {
      display: block;
    }`,
    body: `  <h2>Auth Profiles</h2>
  <div class="form-group">
    <label>Auth Profile</label>
    <div class="custom-select" id="profile-selector">
      <input type="hidden" id="profile-select-value" value="${hiddenValue}" />
      <div class="custom-select-trigger" tabindex="0">
        <span class="custom-select-text">${escapeHtml(triggerLabel)}</span>
      </div>
      <div class="custom-select-dropdown">
        ${selectorOptions}
        ${newOption}
      </div>
    </div>
    <span class="dirty-indicator" id="dirty-flag">Unsaved changes</span>
  </div>

  <div class="form-group">
    <label for="profile-name">Name</label>
    <input type="text" id="profile-name" value="${escapeHtml(nameValue)}" placeholder="Production Servers" />
    <div class="field-error" id="error-name"></div>
  </div>

  <div class="form-group conditional-field${authTypeValue !== "external" ? " visible" : ""}" id="username-field">
    <label for="profile-username">Username</label>
    <input type="text" id="profile-username" value="${escapeHtml(usernameValue)}" placeholder="root" />
    <div class="field-error" id="error-username"></div>
  </div>

  <div class="form-group">
    <label id="authtype-label">Authentication</label>
    <div class="custom-select" id="authtype-selector" data-select-only="true">
      <input type="hidden" id="authtype-select-value" value="${escapeHtml(authTypeValue)}" />
      <div class="custom-select-trigger" tabindex="0" role="combobox" aria-haspopup="listbox" aria-expanded="false" aria-controls="authtype-listbox" aria-labelledby="authtype-label authtype-value">
        <span class="custom-select-text" id="authtype-value">${escapeHtml(authTypeTriggerLabel)}</span>
      </div>
      <div class="custom-select-dropdown" id="authtype-listbox" role="listbox" aria-labelledby="authtype-label">
        ${authTypeOptionsHtml}
      </div>
    </div>
  </div>

  <div class="conditional-field${authTypeValue === "external" ? " visible" : ""}" id="external-field">
    <p class="hint">The program supplies the username and credentials when a new SSH connection signs in.</p>
    <div class="form-group">
      <label id="external-method-label">Authentication Method</label>
      <div class="custom-select" id="external-method-selector" data-select-only="true">
        <input type="hidden" id="external-method" value="${external?.method ?? "password"}" />
        <div class="custom-select-trigger" tabindex="0" role="combobox" aria-haspopup="listbox" aria-expanded="false" aria-controls="external-method-listbox" aria-labelledby="external-method-label external-method-value" aria-describedby="external-method-hint"><span class="custom-select-text" id="external-method-value">${external?.method === "key" ? "Private Key" : "Password"}</span></div>
        <div class="custom-select-dropdown" id="external-method-listbox" role="listbox" aria-labelledby="external-method-label">
          <div class="custom-select-option${external?.method !== "key" ? " selected" : ""}" data-value="password" id="external-method-option-password" role="option" aria-selected="${external?.method !== "key" ? "true" : "false"}">Password</div>
          <div class="custom-select-option${external?.method === "key" ? " selected" : ""}" data-value="key" id="external-method-option-key" role="option" aria-selected="${external?.method === "key" ? "true" : "false"}">Private Key</div>
        </div>
      </div>
      <div class="hint" id="external-method-hint">Nexus adds <span id="external-method-flag">${external?.method === "key" ? "--pkey" : "--pass"}</span>. Private keys supplied by the program must be unencrypted.</div>
    </div>
    <div class="form-group">
      <label for="external-executable">Executable</label>
      <div class="browse-row">
        <input type="text" id="external-executable" value="${escapeHtml(external?.invocation?.executable ?? "")}" aria-describedby="external-executable-hint error-external-executable" />
        <button type="button" class="btn-secondary" id="external-browse-btn">Browse</button>
      </div>
      <div class="hint" id="external-executable-hint">Absolute path on the extension host, which may be remote, in a container or WSL. For scripts, select the interpreter and put the script path in Arguments.</div>
      <div class="field-error" id="error-external-executable" aria-live="polite"></div>
    </div>
    <div class="form-group">
      <label for="external-arguments">Arguments</label>
      <textarea id="external-arguments" rows="4" aria-describedby="external-arguments-hint error-external-arguments">${escapeHtml(external?.invocation?.args.join("\n") ?? "")}</textarea>
      <div class="hint" id="external-arguments-hint">One argument per line. Spaces inside an argument are preserved. Do not add shell quotes or put passwords/tokens here; arguments are saved in configuration. Nexus adds --pass or --pkey for the selected method. Tilde and environment expansion are unavailable.</div>
      <div class="field-error" id="error-external-arguments" aria-live="polite"></div>
    </div>
    <div class="form-group form-group-checkbox">
      <label for="external-argument-expansion"><input type="checkbox" id="external-argument-expansion" aria-describedby="external-argument-expansion-hint external-argument-expansion-compatibility"${external?.invocation?.argumentExpansion === true ? " checked" : ""} /> Expand connection variables in arguments</label>
      <div class="hint" id="external-argument-expansion-hint">Optional. Use \${host}, \${port}, \${SessionName}, \${username}, \${profile}, or \${protocol}; write $\${host} for a literal \${host}. The server username is a lookup hint; the program supplies the SSH login. Session approval covers this template and values may differ for future connections.</div>
    </div>
    <div class="hint" id="external-argument-expansion-compatibility">Older NexTerminal versions cannot read profiles with argument expansion enabled; editing auth profiles in an older version can remove them from saved configuration. Back up your configuration and update all installations accessing this state first. Backups exported by older versions may omit these profiles.</div>
    <p class="hint">Saving does not run the program or grant approval. Interactive Connect asks you to review the complete invocation before approving it for this extension-host session.</p>
  </div>

  <div class="form-group conditional-field${authTypeValue === "password" ? " visible" : ""}" id="password-field">
    <label for="profile-password">Password</label>
    <input type="password" id="profile-password" value="" placeholder="${isNew ? "Enter password" : "Leave blank to keep existing"}" />
    <div class="hint">Passwords are stored securely and never displayed.</div>
  </div>

  <div class="form-group conditional-field${authTypeValue === "key" ? " visible" : ""}" id="keypath-field">
    <label for="profile-keypath">Private Key File</label>
    <div class="browse-row">
      <input type="text" id="profile-keypath" value="${escapeHtml(keyPathValue)}" placeholder="~/.ssh/id_ed25519" />
      <button type="button" class="btn-secondary" id="browse-btn">Browse</button>
    </div>
  </div>

  <div class="form-group conditional-field${authTypeValue === "agent" ? " visible" : ""}" id="agent-note">
    <div class="hint">${escapeHtml(SSH_AGENT_FORM_NOTE)}</div>
  </div>

  <div class="bottom-actions">
    <button type="button" class="btn-primary" id="save-btn">${escapeHtml(saveLabel)}</button>
    <span class="save-indicator${justSavedName ? " visible" : ""}" id="save-flag" role="status" aria-live="polite">✓ Saved</span>
    <div class="spacer"></div>
    <button type="button" class="btn-secondary" id="new-btn">New Profile</button>
    <button type="button" class="btn-secondary" id="delete-btn"${deleteDisabled}>Delete</button>
  </div>
  <section id="session-approvals" aria-labelledby="session-approvals-heading">
    <h3 id="session-approvals-heading">Session Approvals</h3>
    <p class="hint">Applies to all external credential profiles in this extension-host session, including profiles other than the one selected.</p>
    <button type="button" class="btn-secondary" id="revoke-external-btn">Revoke All External Credential Approvals</button>
    <div id="session-approvals-status" role="status" aria-live="polite"></div>
  </section>
  <div id="action-error" class="field-error" role="status" aria-live="polite"></div>
`,
    script: `    ${baseWebviewJs()}
    (function() {
      var vscode = acquireVsCodeApi();
      var parseExternalArgumentsText = ${parseExternalArgumentsText.toString()};
      var dirty = false;
      var currentId = ${selectedId !== null ? JSON.stringify(selectedId) : "null"};
      var saveFlag = document.getElementById("save-flag");

      function hideSaveFlag() {
        if (saveFlag) {
          saveFlag.classList.remove("visible");
        }
      }

      // A save just landed (baked into this render): show "✓ Saved" briefly, then
      // fade it. Editing again clears it immediately so a stale "Saved" never sits
      // next to unsaved changes.
      if (saveFlag && saveFlag.classList.contains("visible")) {
        setTimeout(hideSaveFlag, 3500);
      }

      function markDirty() {
        hideSaveFlag();
        if (!dirty) {
          dirty = true;
          document.getElementById("dirty-flag").classList.add("visible");
        }
      }

      function clearDirty() {
        dirty = false;
        document.getElementById("dirty-flag").classList.remove("visible");
      }

      function updateConditionalFields() {
        var authType = document.getElementById("authtype-select-value").value;
        var externalField = document.getElementById("external-field");
        var usernameField = document.getElementById("username-field");
        if (externalField) externalField.classList[authType === "external" ? "add" : "remove"]("visible");
        if (usernameField) usernameField.classList[authType !== "external" ? "add" : "remove"]("visible");
        var pwField = document.getElementById("password-field");
        var keyField = document.getElementById("keypath-field");
        var agentNote = document.getElementById("agent-note");
        if (authType === "password") {
          pwField.classList.add("visible");
          keyField.classList.remove("visible");
        } else if (authType === "key") {
          pwField.classList.remove("visible");
          keyField.classList.add("visible");
        } else {
          pwField.classList.remove("visible");
          keyField.classList.remove("visible");
        }
        if (authType === "agent") {
          agentNote.classList.add("visible");
        } else {
          agentNote.classList.remove("visible");
        }
      }

      function updateExternalControls() {
        updateConditionalFields();
        var mode = document.getElementById("authtype-select-value").value;
        ["username-field", "password-field", "keypath-field", "external-field"].forEach(function(id) {
          var group = document.getElementById(id);
          var active = group.classList.contains("visible");
          group.querySelectorAll("input, textarea, button").forEach(function(control) { control.disabled = !active; });
          group.querySelectorAll(".custom-select-trigger").forEach(function(control) { control.tabIndex = active ? 0 : -1; control.setAttribute("aria-disabled", active ? "false" : "true"); });
        });
        document.getElementById("external-method-flag").textContent = document.getElementById("external-method").value === "key" ? "--pkey" : "--pass";
      }
      updateExternalControls();
      document.getElementById("authtype-selector").addEventListener("click", updateExternalControls);
      document.getElementById("authtype-selector").addEventListener("keydown", function() { setTimeout(updateExternalControls, 0); });
      ["external-executable", "external-arguments"].forEach(function(id) { document.getElementById(id).addEventListener("input", markDirty); });
      document.getElementById("external-argument-expansion").addEventListener("change", markDirty);

      // Track changes
      document.getElementById("profile-name").addEventListener("input", markDirty);
      document.getElementById("profile-username").addEventListener("input", markDirty);
      document.getElementById("profile-password").addEventListener("input", markDirty);
      document.getElementById("profile-keypath").addEventListener("input", markDirty);

      // Custom select handlers
      initCustomSelects(function(wrapper, opt) {
        var value = opt.dataset.value;
        if (wrapper.id === "profile-selector") {
          if (dirty) {
            vscode.postMessage({ type: "confirmSwitch", targetValue: value });
          } else {
            vscode.postMessage({ type: "selectProfile", value: value });
          }
          wrapper.classList.remove("open");
          return;
        }
        if (wrapper.id === "external-method-selector") {
          selectCustomOption(wrapper, value); markDirty(); updateExternalControls();
        }
        if (wrapper.id === "authtype-selector") {
          selectCustomOption(wrapper, value);
          markDirty();
          updateConditionalFields();
        }
      });

      // Save
      document.getElementById("save-btn").addEventListener("click", function() {
        var name = document.getElementById("profile-name").value.trim();
        var username = document.getElementById("profile-username").value.trim();
        var authType = document.getElementById("authtype-select-value").value;
        var password = document.getElementById("profile-password").value;
        var keyPath = document.getElementById("profile-keypath").value.trim();

        // Validate
        var valid = true;
        if (!name) {
          document.getElementById("error-name").textContent = "Name cannot be empty";
          valid = false;
        } else {
          document.getElementById("error-name").textContent = "";
        }
        if (authType !== "external" && !username) {
          document.getElementById("error-username").textContent = "Username cannot be empty";
          valid = false;
        } else {
          document.getElementById("error-username").textContent = "";
        }
        var firstInvalid;
        function error(id, message) {
          document.getElementById("error-" + id).textContent = message;
          var field = document.getElementById(id);
          field.setAttribute("aria-invalid", message ? "true" : "false");
          if (message && !firstInvalid) firstInvalid = field;
          if (message) valid = false;
        }
        if (!name) firstInvalid = document.getElementById("profile-name");
        if (!username && authType !== "external" && !firstInvalid) firstInvalid = document.getElementById("profile-username");
        if (["password", "key", "agent", "external"].indexOf(authType) === -1) { document.getElementById("action-error").textContent = "Choose a supported Authentication type."; return; }
        if (authType === "external") {
          var executable = document.getElementById("external-executable").value;
          var args = [];
          error("external-executable", executable && (executable[0] === "/" || /^[A-Za-z]:[\\\\/]/.test(executable) || /^\\\\\\\\/.test(executable)) && !/[\\u0000-\\u001f\\u007f-\\u009f\\u061c\\u200e\\u200f\\u202a-\\u202e\\u2066-\\u2069]/.test(executable) ? "" : "Choose an absolute executable path without control characters.");
          try { args = parseExternalArgumentsText(document.getElementById("external-arguments").value); error("external-arguments", ""); }
          catch (e) { error("external-arguments", e.message); }
          if (!valid) { if (firstInvalid) firstInvalid.focus(); return; }
          var invocation = { executable: executable, args: args };
          if (document.getElementById("external-argument-expansion").checked) invocation.argumentExpansion = true;
          vscode.postMessage({ type: "save", id: currentId, name: name, authType: "external", external: { version: 1, method: document.getElementById("external-method").value, invocation: invocation } });
          return;
        }
        if (!valid) { if (firstInvalid) firstInvalid.focus(); return; }

        vscode.postMessage({
          type: "save",
          id: currentId,
          name: name,
          username: username,
          authType: authType,
          password: authType === "password" ? password : undefined,
          keyPath: authType === "key" ? keyPath : undefined
        });
      });

      // Delete
      document.getElementById("delete-btn").addEventListener("click", function() {
        if (currentId === null) return;
        vscode.postMessage({ type: "delete", id: currentId });
      });

      // New
      document.getElementById("new-btn").addEventListener("click", function() {
        if (dirty) {
          vscode.postMessage({ type: "confirmSwitch", targetValue: "__new__" });
        } else {
          vscode.postMessage({ type: "selectProfile", value: "__new__" });
        }
      });

      // Browse
      document.getElementById("browse-btn").addEventListener("click", function() {
        vscode.postMessage({ type: "browse" });
      });

      document.getElementById("external-browse-btn").addEventListener("click", function() { vscode.postMessage({ type: "externalExecutable" }); });
      document.getElementById("revoke-external-btn").addEventListener("click", function() { vscode.postMessage({ type: "revokeExternalApprovals" }); });

      // Messages from host
      window.addEventListener("message", function(event) {
        var msg = event.data;
        if (msg.type === "requestProfileSwitch" && typeof msg.targetValue === "string") {
          if (dirty) vscode.postMessage({ type: "confirmSwitch", targetValue: msg.targetValue });
          else vscode.postMessage({ type: "selectProfile", value: msg.targetValue });
        }
        if (msg.type === "externalExecutableResult" && typeof msg.path === "string") { document.getElementById("external-executable").value = msg.path; markDirty(); }
        if (msg.type === "externalApprovalsStatus") document.getElementById("session-approvals-status").textContent = msg.message;
        if (msg.type === "actionError") document.getElementById("action-error").textContent = msg.message;
        if (msg.type === "saved") {
          clearDirty();
        }
        if (msg.type === "browseResult" && msg.path) {
          document.getElementById("profile-keypath").value = msg.path;
          markDirty();
        }
      });
    })();`
  });
}
