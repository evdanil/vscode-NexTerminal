import type { AuthProfile } from "../models/config";
import { escapeHtml } from "./shared/escapeHtml";
import { baseWebviewCss } from "./shared/webviewStyles";
import { baseWebviewJs } from "./shared/webviewScripts";

export function renderAuthProfileEditorHtml(
  profiles: AuthProfile[],
  selectedId: string | null,
  nonce: string
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
  const isNew = selectedId === null;
  const saveLabel = isNew ? "Create" : "Save";
  const deleteDisabled = isNew ? " disabled" : "";

  const authTypeOptions = [
    { label: "Password", value: "password" },
    { label: "Private Key", value: "key" },
    { label: "SSH Agent", value: "agent" }
  ];
  const authTypeOptionsHtml = authTypeOptions
    .map(
      (o) =>
        `<div class="custom-select-option${o.value === authTypeValue ? " selected" : ""}" data-value="${o.value}">${escapeHtml(o.label)}</div>`
    )
    .join("\n          ");
  const authTypeTriggerLabel = authTypeOptions.find((o) => o.value === authTypeValue)?.label ?? "Password";

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';" />
  <style nonce="${nonce}">
    ${baseWebviewCss()}
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
    }
  </style>
</head>
<body>
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

  <div class="form-group">
    <label for="profile-username">Username</label>
    <input type="text" id="profile-username" value="${escapeHtml(usernameValue)}" placeholder="root" />
    <div class="field-error" id="error-username"></div>
  </div>

  <div class="form-group">
    <label>Authentication</label>
    <div class="custom-select" id="authtype-selector">
      <input type="hidden" id="authtype-select-value" value="${escapeHtml(authTypeValue)}" />
      <div class="custom-select-trigger" tabindex="0">
        <span class="custom-select-text">${escapeHtml(authTypeTriggerLabel)}</span>
      </div>
      <div class="custom-select-dropdown">
        ${authTypeOptionsHtml}
      </div>
    </div>
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

  <div class="bottom-actions">
    <button type="button" class="btn-primary" id="save-btn">${escapeHtml(saveLabel)}</button>
    <button type="button" class="btn-secondary" id="delete-btn"${deleteDisabled}>Delete</button>
    <div class="spacer"></div>
    <button type="button" class="btn-secondary" id="new-btn">New Profile</button>
  </div>

  <script nonce="${nonce}">
    ${baseWebviewJs()}
    (function() {
      var vscode = acquireVsCodeApi();
      var dirty = false;
      var currentId = ${selectedId !== null ? JSON.stringify(selectedId) : "null"};

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

      function updateConditionalFields() {
        var authType = document.getElementById("authtype-select-value").value;
        var pwField = document.getElementById("password-field");
        var keyField = document.getElementById("keypath-field");
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
      }

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
        if (!username) {
          document.getElementById("error-username").textContent = "Username cannot be empty";
          valid = false;
        } else {
          document.getElementById("error-username").textContent = "";
        }
        if (!valid) return;

        vscode.postMessage({
          type: "save",
          id: currentId,
          name: name,
          username: username,
          authType: authType,
          password: password,
          keyPath: keyPath
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

      // Messages from host
      window.addEventListener("message", function(event) {
        var msg = event.data;
        if (msg.type === "saved") {
          clearDirty();
        }
        if (msg.type === "browseResult" && msg.path) {
          document.getElementById("profile-keypath").value = msg.path;
          markDirty();
        }
      });
    })();
  </script>
</body>
</html>`;
}
