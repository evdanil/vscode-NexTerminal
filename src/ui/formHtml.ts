import type { FormDefinition, FormFieldDescriptor, VisibleWhen } from "./formTypes";
import { escapeHtml } from "./shared/escapeHtml";
import { baseWebviewCss } from "./shared/webviewStyles";
import { baseWebviewJs } from "./shared/webviewScripts";

function renderHint(field: FormFieldDescriptor): string {
  if (!("hint" in field) || !field.hint) {
    return "";
  }
  return `\n  <div class="field-hint">${escapeHtml(field.hint)}</div>`;
}

function visibleWhenDataAttr(visibleWhen?: VisibleWhen): string {
  if (!visibleWhen) {
    return "";
  }
  const conditions = Array.isArray(visibleWhen) ? visibleWhen : [visibleWhen];
  return ` data-visible-when='${escapeHtml(JSON.stringify(conditions))}'`;
}

function visibleWhenAttrs(field: FormFieldDescriptor): string {
  return visibleWhenDataAttr(field.visibleWhen);
}

function renderField(field: FormFieldDescriptor): string {
  if (field.type === "html") {
    const vw = visibleWhenAttrs(field);
    return `<div class="form-group form-illustration"${vw}>${field.content}</div>`;
  }
  const key = escapeHtml(field.key);
  const id = `field-${key}`;
  const req = "required" in field && field.required ? " required" : "";
  const vw = visibleWhenAttrs(field);

  switch (field.type) {
    case "hidden":
      return `<input type="hidden" id="${id}" name="${key}" value="${escapeHtml(field.value ?? "")}" />`;

    case "text":
      if (field.scannable) {
        return `<div class="form-group"${vw}>
  <label for="${id}">${escapeHtml(field.label)}${field.required ? ' <span class="req">*</span>' : ""}</label>
  <div class="file-input-row">
    <input type="text" id="${id}" name="${key}" value="${escapeHtml(field.value ?? "")}" placeholder="${escapeHtml(field.placeholder ?? "")}"${req} />
    <button type="button" class="scan-btn" data-key="${key}">Scan</button>
  </div>${renderHint(field)}
  <div class="field-error" id="error-${key}"></div>
</div>`;
      }
      return `<div class="form-group"${vw}>
  <label for="${id}">${escapeHtml(field.label)}${field.required ? ' <span class="req">*</span>' : ""}</label>
  <input type="text" id="${id}" name="${key}" value="${escapeHtml(field.value ?? "")}" placeholder="${escapeHtml(field.placeholder ?? "")}"${req} />${renderHint(field)}
  <div class="field-error" id="error-${key}"></div>
</div>`;

    // A `<textarea>` here renders `field.value` bare, unlike the Macro Editor's
    // (`TEXTAREA_LEADING_NEWLINE` in `macroEditorHtml.ts`), because the HTML
    // parser discards one U+000A immediately after the start tag and neither
    // field this shell renders can tell: `shellArgs` splits on newlines and
    // filters empties (`splitArgs()`), and `startupCommand` is trimmed on save
    // (`readString()`), both in `localShellCommands.ts`. A NEW textarea field
    // whose value is stored verbatim needs the leading newline — without it,
    // opening the form and pressing Save silently drops the value's first line.
    case "textarea":
      return `<div class="form-group"${vw}>
  <label for="${id}">${escapeHtml(field.label)}${field.required ? ' <span class="req">*</span>' : ""}</label>
  <textarea id="${id}" name="${key}" rows="${field.rows ?? 4}" placeholder="${escapeHtml(field.placeholder ?? "")}"${req}>${escapeHtml(field.value ?? "")}</textarea>${renderHint(field)}
  <div class="field-error" id="error-${key}"></div>
</div>`;

    case "password":
      return `<div class="form-group"${vw}>
  <label for="${id}">${escapeHtml(field.label)}${field.required ? ' <span class="req">*</span>' : ""}</label>
  <input type="password" id="${id}" name="${key}" value="${escapeHtml(field.value ?? "")}" placeholder="${escapeHtml(field.placeholder ?? "")}" autocomplete="new-password"${req} />${renderHint(field)}
  <div class="field-error" id="error-${key}"></div>
</div>`;

    case "number": {
      const step = field.step !== undefined ? ` step="${field.step}"` : "";
      return `<div class="form-group"${vw}>
  <label for="${id}">${escapeHtml(field.label)}${field.required ? ' <span class="req">*</span>' : ""}</label>
  <input type="number" id="${id}" name="${key}" value="${field.value ?? ""}" min="${field.min ?? ""}" max="${field.max ?? ""}"${step} placeholder="${escapeHtml(field.placeholder ?? "")}"${req} />${renderHint(field)}
  <div class="field-error" id="error-${key}"></div>
</div>`;
    }

    case "select": {
      const selectedOpt = field.options.find((opt) => opt.value === field.value) ?? field.options[0];
      const selectedLabel = selectedOpt?.label ?? "";
      const selectedValue = field.value ?? field.options[0]?.value ?? "";
      const autofillAttr = field.autofill ? ' data-autofill="true"' : "";
      // The initial ownership record: which keys the ALREADY SELECTED option's
      // autofill fills. Omitted when it fills nothing, which the script reads
      // as the same empty set.
      const filledAttr = field.autofillFilledKeys && field.autofillFilledKeys.length > 0
        ? ` data-autofill-filled='${escapeHtml(JSON.stringify(field.autofillFilledKeys))}'`
        : "";
      // The initial restore record: for each key whose descriptor this render
      // ALREADY overwrote with the selected option's value, what that key held
      // before. Omitted when the render displaced nothing, which the script
      // reads as the same empty record.
      const displacedAttr = field.autofillDisplacedValues && Object.keys(field.autofillDisplacedValues).length > 0
        ? ` data-autofill-displaced='${escapeHtml(JSON.stringify(field.autofillDisplacedValues))}'`
        : "";
      const optionsHtml = field.options.map((opt) =>
        `<div class="custom-select-option${opt.value === selectedValue ? " selected" : ""}" data-value="${escapeHtml(opt.value)}">` +
        `<div class="custom-select-option-label">${escapeHtml(opt.label)}</div>` +
        (opt.description ? `<div class="custom-select-option-desc">${escapeHtml(opt.description)}</div>` : "") +
        `</div>`
      ).join("\n      ");
      return `<div class="form-group"${vw}>
  <label>${escapeHtml(field.label)}</label>
  <div class="custom-select" id="${id}" data-name="${key}"${autofillAttr}${filledAttr}${displacedAttr}>
    <input type="hidden" name="${key}" value="${escapeHtml(selectedValue)}" />
    <div class="custom-select-trigger" tabindex="0">
      <span class="custom-select-text">${escapeHtml(selectedLabel)}</span>
    </div>
    <div class="custom-select-dropdown">
      ${optionsHtml}
    </div>
  </div>${renderHint(field)}
  <div class="field-error" id="error-${key}"></div>
</div>`;
    }

    case "combobox": {
      const suggestionsHtml = field.suggestions.map((s) =>
        `<div class="custom-select-option" data-value="${escapeHtml(s)}">${escapeHtml(s)}</div>`
      ).join("\n      ");
      return `<div class="form-group"${vw}>
  <label for="${id}">${escapeHtml(field.label)}${field.required ? ' <span class="req">*</span>' : ""}</label>
  <div class="custom-combobox">
    <input type="text" id="${id}" name="${key}" value="${escapeHtml(field.value ?? "")}" placeholder="${escapeHtml(field.placeholder ?? "Type or select...")}" autocomplete="off"${field.required ? " required" : ""} />
    <div class="custom-select-dropdown">
      ${suggestionsHtml}
    </div>
  </div>${renderHint(field)}
  <div class="field-error" id="error-${key}"></div>
</div>`;
    }

    case "checkbox":
      return `<div class="form-group form-group-checkbox"${vw}>
  <label>
    <input type="checkbox" id="${id}" name="${key}"${field.value ? " checked" : ""} />
    ${escapeHtml(field.label)}
  </label>${renderHint(field)}
</div>`;

    case "file":
      return `<div class="form-group"${vw}>
  <label for="${id}">${escapeHtml(field.label)}</label>
  <div class="file-input-row">
    <input type="text" id="${id}" name="${key}" value="${escapeHtml(field.value ?? "")}" readonly />
    <button type="button" class="browse-btn" data-key="${key}">Browse</button>
    <button type="button" class="clear-btn" data-key="${key}" title="Clear">✕</button>
  </div>${renderHint(field)}
  <div class="field-error" id="error-${key}"></div>
</div>`;
  }
}

export function renderFormHtml(definition: FormDefinition, nonce?: string): string {
  const basicFields = definition.fields.filter((field) => !field.advanced);
  const advancedFields = definition.fields.filter((field) => field.advanced);
  const basicFieldsHtml = basicFields.map(renderField).join("\n");
  const advancedFieldsHtml = advancedFields.length > 0
    ? `<details class="advanced-fields">
      <summary>Advanced options</summary>
      ${advancedFields.map(renderField).join("\n      ")}
    </details>`
    : "";
  const fieldsHtml = [basicFieldsHtml, advancedFieldsHtml].filter(Boolean).join("\n");
  const csp = nonce
    ? `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';" />`
    : "";
  const nonceAttr = nonce ? ` nonce="${nonce}"` : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  ${csp}
  <style${nonceAttr}>
    ${baseWebviewCss()}
    body { max-width: 700px; }
    .advanced-fields {
      margin: 6px 0 18px;
      padding: 10px 12px 2px;
      border: 1px solid var(--vscode-panel-border, var(--vscode-input-border, rgba(128,128,128,0.35)));
      border-radius: 4px;
      background: var(--vscode-sideBar-background, var(--vscode-editor-background));
    }
    .advanced-fields summary {
      cursor: pointer;
      color: var(--vscode-foreground);
      font-weight: 600;
      font-size: 12px;
      margin-bottom: 10px;
    }
    .advanced-fields .form-group {
      margin-bottom: 14px;
    }
    .actions button[data-visible-when] {
      display: none;
    }
    .actions button[data-visible-when].field-visible {
      display: inline-flex;
    }
  </style>
</head>
<body>
  <h2>${escapeHtml(definition.title)}</h2>
  <form id="nexus-form">
    ${fieldsHtml}
    <div class="actions">
      <button type="submit" class="btn-primary">Save</button>
      ${definition.testable ? `<button type="button" class="btn-secondary" id="test-btn"${visibleWhenDataAttr(definition.testableWhen)}>Test Connection</button>` : ""}
      <button type="button" class="btn-secondary" id="cancel-btn">Cancel</button>
    </div>
  </form>
  <script${nonceAttr}>
    ${baseWebviewJs()}
    (function() {
      var vscode = acquireVsCodeApi();
      var form = document.getElementById("nexus-form");

      // ── WHICH MANAGED FIELDS THE LINKED AUTH PROFILE SUPPLIED ──────────
      // REVIEW FINDING (P2) — ownership is TRACKED, never inferred from what a
      // managed field currently holds. Every entry point into the form arrives
      // with those fields already populated: Edit prefills them from the
      // record, and Add prefills Default SSH Username from mostCommonUsername.
      // So "the field has a value" is evidence of nothing — least of all for
      // the profile that fills NOTHING (an imported profile whose username is
      // whitespace-only: authProfileUsernameMirror answers an EMPTY payload
      // precisely to leave the user's own value alone), where a value test
      // locks the very fallback the mirror just declined to touch and the user
      // is left unable to change it while that profile stays selected.
      //
      // The signal is the autofill itself: the keys the CURRENT profile's fill
      // response actually supplied, seeded at render time from the select's
      // data-autofill-filled attribute and replaced on every later transition
      // — emptied the moment a different profile is chosen (it has supplied
      // nothing yet), then rebuilt when that choice's fillFields answer lands.
      var profileFilledKeys = seededProfileFilledKeys();

      // ── WHAT THE PREVIOUS PROFILE DISPLACED ────────────────────────────
      // REVIEW FINDING (P2) — a selection hands over more than the ownership
      // flags: the profile being left behind also put ITS VALUES in the fields
      // it filled. Unlocking those fields without putting back what they held
      // before leaves the old profile's credentials sitting in editable
      // fields, indistinguishable from something the user typed — and that is
      // exactly how the save path then treats them. Pick a key profile that
      // carries a key path, then one that does not: the second owns no
      // keyPath, so preserveLinkedServerCredentials keeps the SUBMITTED one,
      // and the first profile's private key is written onto the server as its
      // own, from a field showing it unlocked as though it had been chosen.
      //
      // RESTORE, not clear. The honest value for a field the old profile
      // filled and the new one does not supply is the one it held before any
      // profile touched it: that is what the form then shows, what Save
      // persists (the submitted value equals the stored one, so the record is
      // unchanged), and what a connection resolves (an unowned key keeps the
      // server's own value) — three layers agreeing by construction. Clearing
      // agrees with none of them: it would drop a stored key path for merely
      // browsing the profile list, and empty a REQUIRED username that was
      // valid a moment ago, refusing a Save for a field the user never
      // touched.
      //
      // Captured at each fill, never once at form open, so an edit made in an
      // unlocked field BETWEEN two selections is what comes back — the entry
      // is always "what this field held immediately before a profile
      // overwrote it", not a frozen picture of the form's opening state.
      //
      // REVIEW FINDING (P1) — with ONE exception, seeded from the render:
      // where a form opens with a profile already selected, that profile's
      // values are already in its fields (the descriptors carry them — see
      // applyLinkedAuthProfileValues in formDefinitions.ts), so the very first
      // overwrite happened before this script ran and no fill can record it.
      // data-autofill-displaced carries what those fields would otherwise have
      // shown. Without it the render's substitution becomes permanent:
      // choosing (None) unlocks fields still holding the profile's
      // credentials, with nothing behind them to put back, and Save then
      // stores them on the record as its own.
      // Every form that can OPEN pre-linked seeds this, the inventory source
      // form's defaultUsername included: it renders that field from the
      // profile too, so the source's own stored fallback lives here and
      // nowhere else until the link is dropped.
      var profileDisplacedValues = seededProfileDisplacedValues();

      /** The render-time seed — the keys the initially selected profile fills. */
      function seededProfileFilledKeys() {
        var wrapper = document.getElementById("field-authProfileId");
        var raw = wrapper && wrapper.dataset ? wrapper.dataset.autofillFilled : "";
        var filled = {};
        if (!raw) {
          return filled;
        }
        try {
          var parsed = JSON.parse(raw);
          if (Array.isArray(parsed)) {
            for (var i = 0; i < parsed.length; i++) {
              filled[parsed[i]] = true;
            }
          }
        } catch (_error) {
          // Same posture as parseVisibleWhen: a malformed attribute leaves the
          // fields editable rather than taking the whole form script down.
        }
        return filled;
      }

      /** The other render-time seed — what the initially selected profile's
       *  values displaced when the descriptors were built. */
      function seededProfileDisplacedValues() {
        var wrapper = document.getElementById("field-authProfileId");
        var raw = wrapper && wrapper.dataset ? wrapper.dataset.autofillDisplaced : "";
        var displaced = {};
        if (!raw) {
          return displaced;
        }
        try {
          var parsed = JSON.parse(raw);
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            for (var key in parsed) {
              // Only strings: setFieldValue writes straight into a control's
              // value, and a restore is worthless if what it puts back is
              // "[object Object]".
              if (typeof parsed[key] === "string") {
                displaced[key] = parsed[key];
              }
            }
          }
        } catch (_error) {
          // Same posture as seededProfileFilledKeys — a malformed attribute
          // costs the restore, not the form.
        }
        return displaced;
      }

      /**
       * The ownership record a fill response implies. A key whose supplied
       * value is blank counts as NOT filled: the server and profile forms'
       * mirrors hand over profile.username verbatim, so a whitespace-only
       * username would otherwise lock a required field onto a value no login
       * can use — the same rule authProfileUsernameMirror applies before it
       * ever answers.
       */
      function filledKeysFromValues(values) {
        var filled = {};
        for (var key in values) {
          var value = values[key];
          if (value === undefined || value === null) continue;
          if (String(value).trim() === "") continue;
          filled[key] = true;
        }
        return filled;
      }

      /** A field's current value, or undefined when this form does not render
       *  that key — one managed-key list serves every form (see managedKeys),
       *  so a lookup for a key another form owns is expected to miss. */
      function fieldValue(key) {
        var el = form.elements[key];
        return el ? el.value : undefined;
      }

      /**
       * Writes a value into a field. Custom-select wrappers (authType) need
       * both halves — the hidden input the form submits AND the visible label
       * the trigger shows — so this is the one place either is written, shared
       * by the fill and the restore. Writing only the input would leave the
       * trigger showing the profile that is no longer selected.
       */
      function setFieldValue(key, value) {
        var el = form.elements[key];
        if (el) {
          el.value = value;
        }
        var wrapper = document.getElementById("field-" + key);
        if (wrapper && wrapper.classList && wrapper.classList.contains("custom-select")) {
          selectCustomOption(wrapper, value);
        }
      }

      /**
       * Remembers what this key held immediately before the profile that is
       * about to own it writes over the field. An entry already taken is never
       * overwritten: two selections can be in flight at once (each fill is a
       * webview round trip), and only the FIRST recording was made before any
       * profile's value had landed in that field.
       */
      function rememberDisplacedValue(key) {
        if (Object.prototype.hasOwnProperty.call(profileDisplacedValues, key)) {
          return;
        }
        var current = fieldValue(key);
        if (current !== undefined) {
          profileDisplacedValues[key] = current;
        }
      }

      /**
       * REVIEW FINDING (P2) — is this answer about the option that is selected
       * RIGHT NOW? An autofill is a round trip through the extension host, and
       * the user can outrun it: pick a profile, then pick (None) — or a
       * different profile — before the answer lands. Nothing else in this
       * script can tell that answer apart from a timely one, because it is
       * shaped identically; only the id it was composed for can, so the
       * fillFields answer echoes it (webviewFormPanel.ts).
       *
       * WHAT GOING WITHOUT COSTS, precisely: the selection already ran
       * releaseProfileOwnedFields, so the managed fields are unlocked and
       * holding the user's own values again. Applying the late answer writes
       * the DESELECTED profile's credentials over them and locks them to it,
       * and every save path downstream reads an unlinked submission as the
       * user's own input — preserveLinkedServerCredentials keeps all of it
       * (there is no link to preserve anything under), and
       * fallbackUsernameForSource stores the submitted username verbatim. A
       * source or server the user unlinked is then saved carrying the very
       * credentials they backed out of, from fields that showed them unlocked
       * as though they had been typed.
       *
       * Compared against the CONTROL, not against a variable this script keeps
       * in step: the control is what the user sees, what the submit loop reads,
       * and what every other selection path already writes through
       * selectCustomOption. A key this form does not render cannot be
       * correlated at all (another form's select — fieldValue's own expected
       * miss), so it is applied as before; the fills that matter here all name
       * a control this form has.
       */
      function fillAnswersCurrentSelection(msg) {
        var control = form.elements[msg.key];
        if (!control) {
          return true;
        }
        return control.value === msg.value;
      }

      /**
       * Ends the current profile's ownership: every value it displaced goes
       * back to its field, and the ownership record empties so the fields
       * unlock. Runs on EVERY transition — another profile, (None), or an
       * inline-created one — because each of them equally leaves the previous
       * profile's values behind in fields the user is now free to save.
       */
      function releaseProfileOwnedFields() {
        for (var key in profileDisplacedValues) {
          setFieldValue(key, profileDisplacedValues[key]);
        }
        profileDisplacedValues = {};
        profileFilledKeys = {};
        // Restoring authType can change which fields are visible at all (the
        // key path field follows it), so visibility is re-settled with the
        // lock, exactly as applyFillFields does on the way in.
        updateVisibility();
        updateProfileManagedFields();
      }

      /**
       * Applies an autofill answer. For the auth profile select the answer IS
       * the ownership record — these keys, and only these, came from the
       * profile just selected. Scoped by the echoed key so another
       * autofill-capable select's answer can never be read as the profile's,
       * and by the echoed value so an answer for an option the user has since
       * moved away from is discarded rather than applied
       * (fillAnswersCurrentSelection).
       */
      function applyFillFields(msg) {
        // Stale answers are dropped whole — values, ownership and all. A
        // partial application would be worse than none: the fields would show
        // one profile's values under another's lock.
        if (!fillAnswersCurrentSelection(msg)) {
          return;
        }
        var fillValues = msg.values;
        var isProfileFill = msg.key === "authProfileId";
        var nextFilledKeys = isProfileFill ? filledKeysFromValues(fillValues) : null;
        for (var fk in fillValues) {
          if (isProfileFill) {
            // A key supplied BLANK owns nothing (filledKeysFromValues), so
            // writing it would replace the user's own value with one nothing
            // downstream will keep — and, being unowned, it would not be
            // handed back by the next release either. Defence in depth: both
            // mirrors already send only the keys the profile owns.
            if (nextFilledKeys[fk] !== true) {
              continue;
            }
            rememberDisplacedValue(fk);
          }
          setFieldValue(fk, fillValues[fk]);
        }
        if (isProfileFill) {
          profileFilledKeys = nextFilledKeys;
        }
        updateVisibility();
        updateProfileManagedFields();
      }

      function parseVisibleWhen(raw) {
        if (!raw) {
          return [];
        }
        try {
          var parsed = JSON.parse(raw);
          return Array.isArray(parsed) ? parsed : [];
        } catch (_error) {
          return [];
        }
      }

      function updateVisibility() {
        var groups = document.querySelectorAll("[data-visible-when]");
        for (var gi = 0; gi < groups.length; gi++) {
          var group = groups[gi];
          var conditions = parseVisibleWhen(group.dataset.visibleWhen);
          var visible = true;
          for (var ci = 0; ci < conditions.length; ci++) {
            var control = form.elements[conditions[ci].field];
            var expectedValue = conditions[ci].value;
            var matches = Array.isArray(expectedValue)
              ? expectedValue.indexOf(control && control.value) !== -1
              : control && control.value === expectedValue;
            if (!matches) {
              visible = false;
              break;
            }
          }
          group.classList.toggle("field-visible", visible);
          if (group.tagName === "BUTTON") {
            group.disabled = !visible;
          }
          var inputs = group.querySelectorAll("input, select, textarea");
          for (var ii = 0; ii < inputs.length; ii++) {
            if (visible) {
              if (inputs[ii].dataset.wasRequired === "true") inputs[ii].required = true;
              inputs[ii].disabled = false;
            } else {
              inputs[ii].dataset.wasRequired = inputs[ii].required ? "true" : "false";
              inputs[ii].required = false;
              inputs[ii].disabled = true;
            }
          }
        }
        updateProfileManagedFields();
      }

      var watchedFields = {};
      var wfGroups = document.querySelectorAll("[data-visible-when]");
      for (var wi = 0; wi < wfGroups.length; wi++) {
        var wfConditions = parseVisibleWhen(wfGroups[wi].dataset.visibleWhen);
        for (var fi = 0; fi < wfConditions.length; fi++) {
          watchedFields[wfConditions[fi].field] = true;
        }
      }
      for (var fieldName in watchedFields) {
        var ctrl = form.elements[fieldName];
        if (ctrl) {
          ctrl.addEventListener("change", updateVisibility);
          ctrl.addEventListener("input", updateVisibility);
        }
      }
      updateVisibility();

      form.addEventListener("submit", function(e) {
        e.preventDefault();
        var values = {};
        for (var i = 0; i < form.elements.length; i++) {
          var el = form.elements[i];
          if (el.disabled) continue;
          if (!el.name) continue;
          if (el.type === "checkbox") {
            values[el.name] = el.checked;
          } else if (el.type === "number") {
            values[el.name] = el.value === "" ? undefined : Number(el.value);
          } else {
            values[el.name] = el.value;
          }
        }
        vscode.postMessage({ type: "submit", values: values });
      });

      document.getElementById("cancel-btn").addEventListener("click", function() {
        vscode.postMessage({ type: "cancel" });
      });

      var testBtn = document.getElementById("test-btn");
      if (testBtn) {
        testBtn.addEventListener("click", function() {
          var values = {};
          for (var i = 0; i < form.elements.length; i++) {
            var el = form.elements[i];
            if (el.disabled) continue;
            if (!el.name) continue;
            if (el.type === "checkbox") {
              values[el.name] = el.checked;
            } else if (el.type === "number") {
              values[el.name] = el.value === "" ? undefined : Number(el.value);
            } else {
              values[el.name] = el.value;
            }
          }
          vscode.postMessage({ type: "test", values: values });
        });
      }

      var browseBtns = document.querySelectorAll(".browse-btn");
      for (var bi = 0; bi < browseBtns.length; bi++) {
        (function(btn) {
          btn.addEventListener("click", function() {
            vscode.postMessage({ type: "browse", key: btn.dataset.key });
          });
        })(browseBtns[bi]);
      }

      var scanBtns = document.querySelectorAll(".scan-btn");
      for (var si = 0; si < scanBtns.length; si++) {
        (function(btn) {
          btn.addEventListener("click", function() {
            vscode.postMessage({ type: "scan", key: btn.dataset.key });
          });
        })(scanBtns[si]);
      }

      var clearBtns = document.querySelectorAll(".clear-btn");
      for (var cli = 0; cli < clearBtns.length; cli++) {
        (function(btn) {
          btn.addEventListener("click", function() {
            var input = document.getElementById("field-" + btn.dataset.key);
            if (input) input.value = "";
          });
        })(clearBtns[cli]);
      }

      function updateProfileManagedFields() {
        var profileWrapper = document.getElementById("field-authProfileId");
        if (!profileWrapper) return;
        var profileInput = profileWrapper.querySelector('input[name="authProfileId"]');
        if (!profileInput) return;
        var isLinked = profileInput.value && profileInput.value !== "";
        // One list, shared by every form that renders an authProfileId select.
        // The server/unified profile forms render username/authType/keyPath;
        // the inventory source form renders defaultUsername. The loop below
        // skips whatever a form doesn't render, so each locks exactly its own
        // mirrored fields with no cross-contamination.
        var managedKeys = ["username", "authType", "keyPath", "defaultUsername"];
        for (var mi = 0; mi < managedKeys.length; mi++) {
          var fieldId = "field-" + managedKeys[mi];
          var fieldEl = document.getElementById(fieldId);
          if (!fieldEl) continue;
          var group = fieldEl.closest ? fieldEl.closest(".form-group") : fieldEl.parentElement;
          if (!group) continue;
          // A managed field is locked only when the LINKED PROFILE supplied it
          // (see profileFilledKeys above). Two cases that separates, which a
          // test over the field's own value cannot:
          //   * a profile that fills nothing for this key (whitespace-only
          //     username; key profile with no key path) leaves the field
          //     editable whether it is empty or was prefilled by the form —
          //     locking an empty REQUIRED field is a dead end (nothing wrote
          //     it, nobody can type into it, Save is refused for a field there
          //     is no longer any way to fill), and locking a PREFILLED one
          //     freezes the user's own fallback, which is the value the save
          //     will actually store for such a profile;
          //   * a key the profile DID fill stays locked even once its value is
          //     cleared, because clearing a mirrored field does not hand
          //     ownership back.
          // Re-settles on every call, since profileFilledKeys is maintained at
          // each entry point: initial render, selection (pre-fill), the
          // fillFields answer, and an injected inline-created option.
          var locked = !!isLinked && profileFilledKeys[managedKeys[mi]] === true;
          var inputs = group.querySelectorAll("input, textarea");
          for (var ii = 0; ii < inputs.length; ii++) {
            var input = inputs[ii];
            if (input.type === "hidden") continue;
            if (input.dataset.baseReadonly === undefined) {
              input.dataset.baseReadonly = input.readOnly ? "true" : "false";
            }
            input.readOnly = locked || input.dataset.baseReadonly === "true";
            input.style.opacity = locked ? "0.6" : "";
          }
          var buttons = group.querySelectorAll("button");
          for (var bi = 0; bi < buttons.length; bi++) {
            var button = buttons[bi];
            if (button.dataset.baseDisabled === undefined) {
              button.dataset.baseDisabled = button.disabled ? "true" : "false";
            }
            button.disabled = locked || button.dataset.baseDisabled === "true";
            button.style.opacity = locked ? "0.6" : "";
          }
          // For custom-select wrappers (authType), also disable the trigger
          var customSelect = group.querySelector(".custom-select");
          if (customSelect) {
            var trigger = customSelect.querySelector(".custom-select-trigger");
            if (trigger) {
              if (locked) {
                trigger.style.pointerEvents = "none";
                trigger.style.opacity = "0.6";
              } else {
                trigger.style.pointerEvents = "";
                trigger.style.opacity = "";
              }
            }
          }
        }
      }

      initCustomSelects(function(wrapper, opt) {
        var value = opt.dataset.value;
        if (value && value.indexOf('__create__') === 0) {
          wrapper.classList.remove('open');
          vscode.postMessage({ type: 'createInline', key: wrapper.dataset.name });
          return;
        }
        selectCustomOption(wrapper, value);
        wrapper.dataset.prev = value;
        if (wrapper.dataset.autofill === 'true' && value) {
          vscode.postMessage({ type: 'autofill', key: wrapper.dataset.name, value: value });
        }
        if (wrapper.dataset.name === 'authProfileId') {
          // The newly chosen profile has supplied nothing yet — the previous
          // one's ownership dies with the selection, so the fields it filled
          // unlock, holding the values they had before that profile filled
          // them, until this profile's own fillFields says which of them it
          // fills. Also covers (None), which posts no autofill at all and so
          // gets no second chance to put anything back.
          releaseProfileOwnedFields();
        }
      });
      initCustomComboboxes();
      updateProfileManagedFields();

      window.addEventListener("message", function(event) {
        var msg = event.data;
        if (msg.type === "browseResult") {
          var browseInput = document.getElementById("field-" + msg.key);
          if (browseInput) browseInput.value = msg.path;
        }
        if (msg.type === "addSelectOption") {
          var wrapper = document.getElementById("field-" + msg.key);
          if (wrapper && wrapper.classList.contains('custom-select')) {
            var newOpt = document.createElement("div");
            newOpt.className = "custom-select-option";
            newOpt.dataset.value = msg.value;
            newOpt.textContent = msg.label;
            var dropdown = wrapper.querySelector('.custom-select-dropdown');
            var createOpt = dropdown.querySelector('.custom-select-option[data-value^="__create__"]');
            if (createOpt) {
              dropdown.insertBefore(newOpt, createOpt);
            } else {
              dropdown.appendChild(newOpt);
            }
            selectCustomOption(wrapper, msg.value);
            wrapper.dataset.prev = msg.value;
            // An option injected after inline creation is a selection like any
            // other, so it must run the same two follow-ups the user-click
            // path runs (see initCustomSelects below). Without them an
            // inline-created auth profile is selected but never mirrors its
            // username into the managed field, and never locks it.
            if (wrapper.dataset.autofill === 'true' && msg.value) {
              vscode.postMessage({ type: 'autofill', key: wrapper.dataset.name, value: msg.value });
            }
            if (wrapper.dataset.name === 'authProfileId') {
              // Same release as the user-click path above — an inline-created
              // profile starts owning nothing, and the profile it replaces
              // must hand back what it displaced on the way out.
              releaseProfileOwnedFields();
            }
          }
        }
        if (msg.type === "fillFields") {
          applyFillFields(msg);
        }
        if (msg.type === "validationError") {
          var errEls = document.querySelectorAll(".field-error");
          for (var ei = 0; ei < errEls.length; ei++) {
            errEls[ei].textContent = "";
          }
          var errors = msg.errors;
          for (var key in errors) {
            var errEl = document.getElementById("error-" + key);
            if (errEl) errEl.textContent = errors[key];
          }
        }
      });
    })();
  </script>
</body>
</html>`;
}
