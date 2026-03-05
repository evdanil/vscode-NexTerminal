import { escapeHtml } from "./shared/escapeHtml";
import { baseWebviewCss } from "./shared/webviewStyles";
import { baseWebviewJs } from "./shared/webviewScripts";

export interface HighlightRule {
  pattern: string;
  color: string;
  flags?: string;
  bold?: boolean;
  underline?: boolean;
}

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
  return COLOR_NAMES.map(name => {
    const css = COLOR_CSS[name] ?? "";
    return `<div class="custom-select-option${name === selected ? " selected" : ""}" data-value="${escapeHtml(name)}"><span class="color-dot" style="background:${escapeHtml(css)};"></span> ${escapeHtml(name)}</div>`;
  }).join("\n        ");
}

export function renderHighlightRuleEditorHtml(rules: HighlightRule[], nonce: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';" />
  <style nonce="${nonce}">
    ${baseWebviewCss()}
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
    #rules-list:empty::after {
      content: "No rules defined. Click \\\"+ Add Rule\\\" to get started.";
      color: var(--vscode-descriptionForeground);
      font-style: italic;
      font-size: 12px;
    }
  </style>
</head>
<body>
  <h3>Highlighting Rules</h3>

  <div id="rules-list"></div>

  <div class="button-row" style="margin-top: 12px;">
    <button type="button" class="btn-secondary" id="add-rule-btn">+ Add Rule</button>
    <button type="button" class="btn-secondary" id="reset-defaults-btn" style="margin-left: auto;">Reset to Defaults</button>
  </div>

  <div class="editor-section" id="editor-section">
    <h4 id="editor-title">Edit Rule</h4>

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
      <button type="button" class="btn-primary" id="save-rule-btn">Save Rule</button>
      <button type="button" class="btn-secondary" id="cancel-edit-btn">Cancel</button>
      <button type="button" class="btn-danger" id="delete-rule-btn" style="margin-left: auto; display: none;">Delete</button>
    </div>
  </div>

  <script nonce="${nonce}">
    ${baseWebviewJs()}
    (function() {
      var vscode = acquireVsCodeApi();
      var VALID_COLORS = ${JSON.stringify(COLOR_NAMES)};
      var COLOR_CSS_MAP = ${JSON.stringify(COLOR_CSS)};
      var SAMPLE_TEXT = "eth0: <BROADCAST,MULTICAST,UP> state UP\\nERROR: connection refused on port 443\\nWARNING: disk usage at 90%\\nINFO: session started for user admin\\n192.168.1.100 - ESTABLISHED\\nsshd: ACCEPTED publickey for root\\n5 input errors, 0 CRC, 0 frame, 3 overruns, 0 ignored";
      var REDOS_RE = /(\\+|\\*|\\{[^}]*\\})\\)(\\+|\\*|\\{)/;

      var rules = ${JSON.stringify(rules)};
      var editingIndex = -1;
      var previewTimer = null;
      var regexCache = {};

      initCustomSelects();
      renderRulesList();

      function renderRulesList() {
        var list = document.getElementById("rules-list");
        list.innerHTML = "";
        for (var i = 0; i < rules.length; i++) {
          var r = rules[i];
          var row = document.createElement("div");
          row.className = "rule-row";
          row.dataset.index = String(i);

          var patSpan = document.createElement("span");
          patSpan.className = "rule-pattern";
          patSpan.textContent = r.pattern;

          var colorSwatch = document.createElement("span");
          colorSwatch.className = "rule-color-swatch";
          colorSwatch.style.background = COLOR_CSS_MAP[r.color] || "#888";
          colorSwatch.title = r.color;

          var flagsSpan = document.createElement("span");
          flagsSpan.className = "rule-flags";
          var styleFlags = [];
          if (r.bold) styleFlags.push("B");
          if (r.underline) styleFlags.push("U");
          flagsSpan.textContent = styleFlags.join(" ");

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

          row.appendChild(patSpan);
          row.appendChild(colorSwatch);
          row.appendChild(flagsSpan);
          row.appendChild(editBtn);
          row.appendChild(delBtn);
          list.appendChild(row);
        }
      }

      document.getElementById("rules-list").addEventListener("click", function(e) {
        var editBtn = e.target.closest(".rule-edit-btn");
        if (editBtn) {
          openEditor(parseInt(editBtn.dataset.index, 10));
          return;
        }
        var delBtn = e.target.closest(".rule-delete-btn");
        if (delBtn) {
          var idx = parseInt(delBtn.dataset.index, 10);
          rules.splice(idx, 1);
          saveRules();
          renderRulesList();
          if (editingIndex === idx) closeEditor();
          else if (editingIndex > idx) editingIndex--;
        }
      });

      document.getElementById("add-rule-btn").addEventListener("click", function() {
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
        if (REDOS_RE.test(pattern)) {
          showPatternError("Pattern rejected: potential ReDoS (nested quantifiers).");
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
        if (VALID_COLORS.indexOf(color) === -1) {
          showPatternError("Invalid color.");
          return;
        }
        var rule = { pattern: pattern, color: color, flags: flags };
        if (document.getElementById("edit-bold").checked) rule.bold = true;
        if (document.getElementById("edit-underline").checked) rule.underline = true;

        if (editingIndex >= 0 && editingIndex < rules.length) {
          rules[editingIndex] = rule;
        } else {
          rules.push(rule);
        }
        saveRules();
        renderRulesList();
        closeEditor();
      });

      document.getElementById("cancel-edit-btn").addEventListener("click", function() {
        closeEditor();
      });

      document.getElementById("delete-rule-btn").addEventListener("click", function() {
        if (editingIndex >= 0 && editingIndex < rules.length) {
          rules.splice(editingIndex, 1);
          saveRules();
          renderRulesList();
          closeEditor();
        }
      });

      document.getElementById("reset-defaults-btn").addEventListener("click", function() {
        vscode.postMessage({ type: "resetDefaults" });
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

      function updatePreview() {
        var box = document.getElementById("preview-box");
        var pattern = patternInput.value.trim();
        if (!pattern) {
          box.textContent = SAMPLE_TEXT;
          showPatternError("");
          return;
        }
        if (REDOS_RE.test(pattern)) {
          box.textContent = SAMPLE_TEXT;
          showPatternError("Potential ReDoS: nested quantifiers.");
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
        if (VALID_COLORS.indexOf(color) === -1) color = "red";
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
          var cls = "hl-" + escapeHtml(color);
          if (isBold) cls += " hl-bold";
          if (isUnderline) cls += " hl-underline";
          html += '<span class="' + cls + '">' + escapeHtml(match[0]) + '</span>';
          lastIdx = regex.lastIndex;
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
          patternInput.value = r.pattern;
          var f = r.flags || "gi";
          flagG.checked = f.indexOf("g") !== -1;
          flagI.checked = f.indexOf("i") !== -1;
          boldCb.checked = !!r.bold;
          underlineCb.checked = !!r.underline;
          var color = VALID_COLORS.indexOf(r.color) !== -1 ? r.color : "red";
          selectCustomOption(document.getElementById("color-select-wrapper"), color);
          deleteBtn.style.display = "";
        } else {
          title.textContent = "Add New Rule";
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
      }

      function saveRules() {
        vscode.postMessage({ type: "saveRules", rules: rules });
      }

      window.addEventListener("message", function(event) {
        var msg = event.data;
        if (msg.type === "rulesUpdated") {
          rules = msg.rules;
          renderRulesList();
          if (editingIndex >= 0) closeEditor();
        }
      });
    })();
  </script>
</body>
</html>`;
}
