import { escapeHtml } from "./shared/escapeHtml";
import { baseWebviewCss } from "./shared/webviewStyles";
import { baseWebviewJs } from "./shared/webviewScripts";
import { SETTINGS_META, CATEGORY_ORDER, CATEGORY_LABELS, type SettingMeta } from "./settingsMetadata";

interface SettingValues {
  [sectionDotKey: string]: unknown;
}

function renderToggle(meta: SettingMeta, value: boolean): string {
  return `<div class="form-group form-group-checkbox"${visibleWhenAttrs(meta)}>
  <label>
    <input type="checkbox" data-section="${escapeHtml(meta.section)}" data-key="${escapeHtml(meta.key)}"${value ? " checked" : ""} />
    ${escapeHtml(meta.label)}
  </label>
  ${meta.badge ? `<span class="setting-badge">${escapeHtml(meta.badge)}</span>` : ""}
  ${meta.description ? `<div class="setting-desc">${escapeHtml(meta.description)}</div>` : ""}
  <span class="save-indicator" data-for="${escapeHtml(meta.section)}.${escapeHtml(meta.key)}"></span>
</div>`;
}

function renderNumber(meta: SettingMeta, value: number): string {
  const unitHtml = meta.unit ? `<span class="unit-suffix">${escapeHtml(meta.unit)}</span>` : "";
  return `<div class="form-group"${visibleWhenAttrs(meta)}>
  <label>${escapeHtml(meta.label)}${meta.badge ? ` <span class="setting-badge">${escapeHtml(meta.badge)}</span>` : ""}</label>
  ${meta.description ? `<div class="setting-desc">${escapeHtml(meta.description)}</div>` : ""}
  <div class="number-with-unit">
    <input type="number" data-section="${escapeHtml(meta.section)}" data-key="${escapeHtml(meta.key)}" value="${value}" min="${meta.min ?? ""}" max="${meta.max ?? ""}" />
    ${unitHtml}
  </div>
  <span class="save-indicator" data-for="${escapeHtml(meta.section)}.${escapeHtml(meta.key)}"></span>
</div>`;
}

function renderDirectory(meta: SettingMeta, value: string): string {
  return `<div class="form-group"${visibleWhenAttrs(meta)}>
  <label>${escapeHtml(meta.label)}</label>
  ${meta.description ? `<div class="setting-desc">${escapeHtml(meta.description)}</div>` : ""}
  <div class="file-input-row">
    <input type="text" data-section="${escapeHtml(meta.section)}" data-key="${escapeHtml(meta.key)}" value="${escapeHtml(value)}" />
    <button type="button" class="browse-btn" data-section="${escapeHtml(meta.section)}" data-key="${escapeHtml(meta.key)}">Browse</button>
  </div>
  <span class="save-indicator" data-for="${escapeHtml(meta.section)}.${escapeHtml(meta.key)}"></span>
</div>`;
}

function renderEnum(meta: SettingMeta, value: string): string {
  const options = meta.enumOptions ?? [];
  const selected = options.find((o) => o.value === value) ?? options[0];
  const optionsHtml = options
    .map(
      (opt) =>
        `<div class="custom-select-option${opt.value === value ? " selected" : ""}" data-value="${escapeHtml(opt.value)}">${escapeHtml(opt.label)}</div>`
    )
    .join("\n        ");
  return `<div class="form-group"${visibleWhenAttrs(meta)}>
  <label>${escapeHtml(meta.label)}</label>
  ${meta.description ? `<div class="setting-desc">${escapeHtml(meta.description)}</div>` : ""}
  <div class="custom-select" data-section="${escapeHtml(meta.section)}" data-key="${escapeHtml(meta.key)}">
    <input type="hidden" value="${escapeHtml(selected?.value ?? "")}" />
    <div class="custom-select-trigger" tabindex="0">
      <span class="custom-select-text">${escapeHtml(selected?.label ?? "")}</span>
    </div>
    <div class="custom-select-dropdown">
      ${optionsHtml}
    </div>
  </div>
  <span class="save-indicator" data-for="${escapeHtml(meta.section)}.${escapeHtml(meta.key)}"></span>
</div>`;
}

function renderMultiCheckbox(meta: SettingMeta, values: string[]): string {
  const options = meta.checkboxOptions ?? [];
  const set = new Set(values);
  const checksHtml = options
    .map(
      (opt) =>
        `<label class="multi-check-label">
    <input type="checkbox" value="${escapeHtml(opt.value)}"${set.has(opt.value) ? " checked" : ""} />
    ${escapeHtml(opt.label)}
  </label>`
    )
    .join("\n    ");
  return `<div class="form-group"${visibleWhenAttrs(meta)}>
  <label>${escapeHtml(meta.label)}</label>
  <div class="multi-checkbox-group" data-section="${escapeHtml(meta.section)}" data-key="${escapeHtml(meta.key)}">
    ${checksHtml}
  </div>
  <span class="save-indicator" data-for="${escapeHtml(meta.section)}.${escapeHtml(meta.key)}"></span>
</div>`;
}

function visibleWhenAttrs(meta: SettingMeta): string {
  if (!meta.visibleWhen) return "";
  return ` data-visible-when-setting="${escapeHtml(meta.visibleWhen.setting)}" data-visible-when-value="${escapeHtml(String(meta.visibleWhen.value))}"`;
}

function renderSetting(meta: SettingMeta, values: SettingValues): string {
  const fullKey = `${meta.section}.${meta.key}`;
  const raw = values[fullKey];
  switch (meta.type) {
    case "boolean":
      return renderToggle(meta, raw !== false);
    case "number":
      return renderNumber(meta, typeof raw === "number" ? raw : (meta.min ?? 0));
    case "string":
      return `<div class="form-group"${visibleWhenAttrs(meta)}>
  <label>${escapeHtml(meta.label)}</label>
  ${meta.description ? `<div class="setting-desc">${escapeHtml(meta.description)}</div>` : ""}
  <input type="text" data-section="${escapeHtml(meta.section)}" data-key="${escapeHtml(meta.key)}" value="${escapeHtml(typeof raw === "string" ? raw : "")}" />
  <span class="save-indicator" data-for="${escapeHtml(meta.section)}.${escapeHtml(meta.key)}"></span>
</div>`;
    case "enum":
      return renderEnum(meta, typeof raw === "string" ? raw : (meta.enumOptions?.[0]?.value ?? ""));
    case "directory":
      return renderDirectory(meta, typeof raw === "string" ? raw : "");
    case "multi-checkbox":
      return renderMultiCheckbox(meta, Array.isArray(raw) ? raw as string[] : []);
  }
}

export function renderSettingsHtml(values: SettingValues, nonce: string): string {
  const grouped = new Map<string, SettingMeta[]>();
  for (const meta of SETTINGS_META) {
    let list = grouped.get(meta.category);
    if (!list) {
      list = [];
      grouped.set(meta.category, list);
    }
    list.push(meta);
  }

  let sectionsHtml = "";
  for (const cat of CATEGORY_ORDER) {
    const metas = grouped.get(cat);
    if (!metas || metas.length === 0) continue;
    const label = CATEGORY_LABELS[cat] ?? cat;
    sectionsHtml += `\n  <h3 id="section-${escapeHtml(cat)}">${escapeHtml(label)}</h3>\n`;
    for (const meta of metas) {
      sectionsHtml += `  ${renderSetting(meta, values)}\n`;
    }
  }

  // Cross-link buttons after Terminal section
  sectionsHtml += `
  <div class="button-row">
    <button type="button" class="btn-secondary" id="open-appearance-btn">Terminal Appearance\u2026</button>
    <button type="button" class="btn-secondary" id="open-macros-btn">Edit Macros\u2026</button>
  </div>`;

  // After Highlighting section
  sectionsHtml += `
  <div class="setting-desc" style="margin-top: 8px;">
    <a href="#" id="open-highlighting-json">Edit highlighting rules in settings.json</a>
  </div>`;

  // Reset button
  sectionsHtml += `
  <div class="button-row" style="margin-top: 24px; justify-content: flex-end;">
    <button type="button" class="btn-secondary" id="reset-all-btn">Reset All to Defaults</button>
  </div>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';" />
  <style nonce="${nonce}">
    ${baseWebviewCss()}
    .setting-desc {
      font-size: 12px;
      color: var(--vscode-descriptionForeground, var(--vscode-foreground));
      margin-bottom: 6px;
      line-height: 1.4;
    }
    .setting-desc a {
      color: var(--vscode-textLink-foreground, #3794ff);
      text-decoration: none;
    }
    .setting-desc a:hover {
      text-decoration: underline;
    }
    .setting-badge {
      display: inline-block;
      margin-left: 8px;
      padding: 1px 6px;
      font-size: 11px;
      border-radius: 2px;
      background: var(--vscode-badge-background, rgba(128,128,128,0.2));
      color: var(--vscode-badge-foreground, var(--vscode-foreground));
      vertical-align: middle;
      cursor: default;
    }
    .number-with-unit {
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .number-with-unit input {
      width: 100px;
      flex: none;
    }
    .unit-suffix {
      font-size: 12px;
      color: var(--vscode-descriptionForeground, var(--vscode-foreground));
    }
    .multi-checkbox-group {
      display: flex;
      flex-wrap: wrap;
      gap: 4px 12px;
    }
    .multi-check-label {
      display: flex;
      align-items: center;
      gap: 4px;
      font-size: 13px;
      font-weight: normal;
      cursor: pointer;
    }
    .save-indicator {
      display: none;
      font-size: 11px;
      color: var(--vscode-terminal-ansiGreen, #4ec9b0);
      margin-left: 6px;
    }
    .save-indicator.visible {
      display: inline;
    }
    .form-group[data-visible-when-setting] { display: none; }
    .form-group[data-visible-when-setting].field-visible { display: block; }
  </style>
</head>
<body>
  <div class="info-banner">
    Settings are stored in your global VS Code configuration and auto-save on change.
  </div>
  ${sectionsHtml}
  <script nonce="${nonce}">
    ${baseWebviewJs()}
    (function() {
      var vscode = acquireVsCodeApi();

      initCustomSelects();

      function showSaved(sectionKey) {
        var indicator = document.querySelector('.save-indicator[data-for="' + sectionKey + '"]');
        if (!indicator) return;
        indicator.textContent = "\\u2713 Saved";
        indicator.classList.add("visible");
        setTimeout(function() { indicator.classList.remove("visible"); }, 1200);
      }

      function saveSetting(section, key, value) {
        vscode.postMessage({ type: "saveSetting", section: section, key: key, value: value });
        showSaved(section + "." + key);
      }

      // Toggle (checkbox) handlers
      var toggles = document.querySelectorAll('input[type="checkbox"][data-section]');
      for (var ti = 0; ti < toggles.length; ti++) {
        (function(cb) {
          cb.addEventListener("change", function() {
            saveSetting(cb.dataset.section, cb.dataset.key, cb.checked);
            updateVisibility();
          });
        })(toggles[ti]);
      }

      // Number handlers
      var numbers = document.querySelectorAll('input[type="number"][data-section]');
      for (var ni = 0; ni < numbers.length; ni++) {
        (function(input) {
          var timer;
          input.addEventListener("input", function() {
            clearTimeout(timer);
            timer = setTimeout(function() {
              var val = parseInt(input.value, 10);
              if (!isNaN(val)) {
                saveSetting(input.dataset.section, input.dataset.key, val);
              }
            }, 500);
          });
        })(numbers[ni]);
      }

      // Text handlers
      var texts = document.querySelectorAll('input[type="text"][data-section]');
      for (var xi = 0; xi < texts.length; xi++) {
        (function(input) {
          var timer;
          input.addEventListener("input", function() {
            clearTimeout(timer);
            timer = setTimeout(function() {
              saveSetting(input.dataset.section, input.dataset.key, input.value);
            }, 500);
          });
        })(texts[xi]);
      }

      // Enum (custom-select) handlers
      var selects = document.querySelectorAll('.custom-select[data-section]');
      for (var si = 0; si < selects.length; si++) {
        (function(wrapper) {
          var hidden = wrapper.querySelector('input[type="hidden"]');
          hidden.addEventListener("change", function() {
            saveSetting(wrapper.dataset.section, wrapper.dataset.key, hidden.value);
          });
        })(selects[si]);
      }

      // Directory browse handlers
      var browseBtns = document.querySelectorAll('.browse-btn[data-section]');
      for (var bi = 0; bi < browseBtns.length; bi++) {
        (function(btn) {
          btn.addEventListener("click", function() {
            vscode.postMessage({ type: "browse", section: btn.dataset.section, key: btn.dataset.key });
          });
        })(browseBtns[bi]);
      }

      // Multi-checkbox handlers
      var multiGroups = document.querySelectorAll('.multi-checkbox-group[data-section]');
      for (var mi = 0; mi < multiGroups.length; mi++) {
        (function(group) {
          var checkboxes = group.querySelectorAll('input[type="checkbox"]');
          for (var ci = 0; ci < checkboxes.length; ci++) {
            checkboxes[ci].addEventListener("change", function() {
              var selected = [];
              var all = group.querySelectorAll('input[type="checkbox"]');
              for (var ai = 0; ai < all.length; ai++) {
                if (all[ai].checked) selected.push(all[ai].value);
              }
              saveSetting(group.dataset.section, group.dataset.key, selected);
            });
          }
        })(multiGroups[mi]);
      }

      // Cross-link buttons
      document.getElementById("open-appearance-btn").addEventListener("click", function() {
        vscode.postMessage({ type: "openAppearance" });
      });
      document.getElementById("open-macros-btn").addEventListener("click", function() {
        vscode.postMessage({ type: "openMacroEditor" });
      });
      document.getElementById("open-highlighting-json").addEventListener("click", function(e) {
        e.preventDefault();
        vscode.postMessage({ type: "openHighlightingJson" });
      });
      document.getElementById("reset-all-btn").addEventListener("click", function() {
        vscode.postMessage({ type: "resetAll" });
      });

      // Visibility handling for settings-level visibleWhen
      function updateVisibility() {
        var groups = document.querySelectorAll("[data-visible-when-setting]");
        for (var vi = 0; vi < groups.length; vi++) {
          var g = groups[vi];
          var settingKey = g.dataset.visibleWhenSetting;
          var expectedValue = g.dataset.visibleWhenValue;
          // Find the control for this setting
          var parts = settingKey.lastIndexOf(".");
          var sec = settingKey.substring(0, parts);
          var key = settingKey.substring(parts + 1);
          var ctrl = document.querySelector('[data-section="' + sec + '"][data-key="' + key + '"]');
          if (!ctrl) { g.classList.remove("field-visible"); continue; }
          var currentValue;
          if (ctrl.type === "checkbox") {
            currentValue = String(ctrl.checked);
          } else {
            currentValue = ctrl.value;
          }
          g.classList.toggle("field-visible", currentValue === expectedValue);
        }
      }
      updateVisibility();

      // Handle browse result and external config updates
      window.addEventListener("message", function(event) {
        var msg = event.data;
        if (msg.type === "browseResult") {
          var input = document.querySelector('input[type="text"][data-section="' + msg.section + '"][data-key="' + msg.key + '"]');
          if (input) {
            input.value = msg.path;
            saveSetting(msg.section, msg.key, msg.path);
          }
        }
        if (msg.type === "scrollTo") {
          var section = document.getElementById("section-" + msg.category);
          if (section) section.scrollIntoView({ behavior: "smooth" });
        }
        if (msg.type === "configUpdated") {
          // Refresh all field values from updated data
          var vals = msg.values;
          for (var fullKey in vals) {
            var dotIdx = fullKey.lastIndexOf(".");
            var s = fullKey.substring(0, dotIdx);
            var k = fullKey.substring(dotIdx + 1);
            var el = document.querySelector('[data-section="' + s + '"][data-key="' + k + '"]');
            if (!el) continue;
            if (el.type === "checkbox") {
              el.checked = !!vals[fullKey];
            } else if (el.type === "hidden") {
              el.value = String(vals[fullKey]);
              var wrapper = el.closest(".custom-select");
              if (wrapper) selectCustomOption(wrapper, String(vals[fullKey]));
            } else {
              el.value = String(vals[fullKey] || "");
            }
          }
          updateVisibility();
        }
      });
    })();
  </script>
</body>
</html>`;
}
