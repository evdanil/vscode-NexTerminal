import { ADVANCED_SECTION_LABEL, type FormDefinition, type FormFieldDescriptor, type VisibleWhen } from "./formTypes";
import { escapeHtml } from "./shared/escapeHtml";
import { baseWebviewCss } from "./shared/webviewStyles";
import { baseWebviewJs } from "./shared/webviewScripts";

/** A select option, mirrored from the `select` field descriptor's shape. */
type SelectOption = { label: string; value: string; description?: string; fillValue?: string };

/**
 * Orders a FILTERABLE select's options into two pinned buckets around the
 * sorted real options. The empty-value `(None)` / `(Assign later)` sentinel
 * pins at the TOP; any `__create__*` inline-create affordance pins at the
 * BOTTOM — its declared home, where users expect "create" to live and where it
 * sat before PR-F1 made these selects filterable. Everything between is sorted
 * by label, case-insensitive and locale-aware. Each pin rule reads the option's
 * VALUE shape, never a hardcoded label, so a differently-worded `(Select …)`
 * sentinel (value `""`) still leads and a renamed create option still trails.
 * Within a bucket declared order is preserved. Non-filterable selects never
 * reach here — their declared order is emitted untouched.
 */
export function sortFilterableOptions(options: SelectOption[]): SelectOption[] {
  const isCreate = (value: string): boolean => value.startsWith("__create__");
  const isEmptySentinel = (value: string): boolean => value === "";
  const topPinned = options.filter((opt) => isEmptySentinel(opt.value));
  const bottomPinned = options.filter((opt) => isCreate(opt.value));
  const rest = options.filter((opt) => !isEmptySentinel(opt.value) && !isCreate(opt.value));
  // Copy before sort: `filter` already returned a fresh array, but keep the
  // intent explicit — the caller's `field.options` is never reordered in place.
  rest.sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: "base" }));
  return [...topPinned, ...rest, ...bottomPinned];
}

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
  if (field.type === "section") {
    return `<div class="form-section"${visibleWhenAttrs(field)}>${escapeHtml(field.label)}</div>`;
  }
  const key = escapeHtml(field.key);
  const id = `field-${key}`;
  const req = "required" in field && field.required ? " required" : "";
  const vw = visibleWhenAttrs(field);

  switch (field.type) {
    case "hidden":
      return `<input type="hidden" id="${id}" name="${key}" value="${escapeHtml(field.value ?? "")}" />`;

    case "text": {
      // Opt-in only: a field that declares no `autofill` emits the empty string
      // here, so its markup is byte-for-byte what it has always been.
      const textAutofillAttr = field.autofill ? ' data-autofill="true"' : "";
      if (field.scannable) {
        return `<div class="form-group"${vw}>
  <label for="${id}">${escapeHtml(field.label)}${field.required ? ' <span class="req">*</span>' : ""}</label>
  <div class="file-input-row">
    <input type="text" id="${id}" name="${key}" value="${escapeHtml(field.value ?? "")}" placeholder="${escapeHtml(field.placeholder ?? "")}"${req}${textAutofillAttr} />
    <button type="button" class="scan-btn" data-key="${key}">Scan</button>
  </div>${renderHint(field)}
  <div class="field-error" id="error-${key}"></div>
</div>`;
      }
      return `<div class="form-group"${vw}>
  <label for="${id}">${escapeHtml(field.label)}${field.required ? ' <span class="req">*</span>' : ""}</label>
  <input type="text" id="${id}" name="${key}" value="${escapeHtml(field.value ?? "")}" placeholder="${escapeHtml(field.placeholder ?? "")}"${req}${textAutofillAttr} />${renderHint(field)}
  <div class="field-error" id="error-${key}"></div>
</div>`;
    }

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
      const defaultsFrom = field.defaultsFrom
        ? ` data-defaults-from='${escapeHtml(JSON.stringify(field.defaultsFrom))}'`
        : "";
      return `<div class="form-group"${vw}>
  <label for="${id}">${escapeHtml(field.label)}${field.required ? ' <span class="req">*</span>' : ""}</label>
  <input type="number" id="${id}" name="${key}" value="${field.value ?? ""}" min="${field.min ?? ""}" max="${field.max ?? ""}"${step} placeholder="${escapeHtml(field.placeholder ?? "")}"${req}${defaultsFrom} />${renderHint(field)}
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
      // A filterable select sorts+pins its options at render time; a plain one
      // emits them in declared order, byte-for-byte as before.
      const renderedOptions = field.filterable ? sortFilterableOptions(field.options) : field.options;
      // FIX B (PR #64 Codex round 2) — a real option in a fillTarget select carries
      // its raw `fillValue` as `data-fill-value`, so the change handler can fill the
      // target field synchronously at pick time (no async round trip). Emitted iff
      // the option declares one: the (None)/`__create__` sentinels carry none, so
      // picking them never fills. `""` is a real value (empty-filter definition) and
      // is emitted as `data-fill-value=""` — distinct from the attribute's absence.
      const optionsHtml = renderedOptions.map((opt) =>
        `<div class="custom-select-option${opt.value === selectedValue ? " selected" : ""}" data-value="${escapeHtml(opt.value)}"${opt.fillValue !== undefined ? ` data-fill-value="${escapeHtml(opt.fillValue)}"` : ""}>` +
        `<div class="custom-select-option-label">${escapeHtml(opt.label)}</div>` +
        (opt.description ? `<div class="custom-select-option-desc">${escapeHtml(opt.description)}</div>` : "") +
        `</div>`
      ).join("\n      ");
      // The synchronous fill's target form key, carried on the wrapper (FIX B).
      const fillTargetAttr = field.fillTarget ? ` data-fill-target="${escapeHtml(field.fillTarget)}"` : "";
      if (field.filterable) {
        // The filter input carries NO `name`, so the submit loop skips it and
        // the value the form posts stays the hidden input's — a filterable
        // select still CONSTRAINS its value to an option (unlike the combobox).
        // The `custom-select-no-matches` row starts hidden; the client shows it
        // only when the filter hides every real option and no create affordance
        // applies (see initCustomSelects in webviewScripts.ts).
        const filterLabel = escapeHtml(`Filter ${field.label} options`);
        return `<div class="form-group"${vw}>
  <label>${escapeHtml(field.label)}</label>
  <div class="custom-select filterable" id="${id}" data-name="${key}"${autofillAttr}${filledAttr}${displacedAttr}${fillTargetAttr}>
    <input type="hidden" name="${key}" value="${escapeHtml(selectedValue)}" />
    <div class="custom-select-trigger" tabindex="0">
      <span class="custom-select-text">${escapeHtml(selectedLabel)}</span>
    </div>
    <div class="custom-select-dropdown">
      <div class="custom-select-filter-row">
        <input type="text" class="custom-select-filter" placeholder="Filter…" aria-label="${filterLabel}" autocomplete="off" />
      </div>
      ${optionsHtml}
      <div class="custom-select-no-matches" style="display: none;" role="status" aria-live="polite">No matches</div>
    </div>
  </div>${renderHint(field)}
  <div class="field-error" id="error-${key}"></div>
</div>`;
      }
      return `<div class="form-group"${vw}>
  <label>${escapeHtml(field.label)}</label>
  <div class="custom-select" id="${id}" data-name="${key}"${autofillAttr}${filledAttr}${displacedAttr}${fillTargetAttr}>
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
    ? `<details class="advanced-fields"${definition.expandAdvanced ? " open" : ""}>
      <summary>${ADVANCED_SECTION_LABEL}</summary>
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
    .form-section {
      margin: 22px 0 12px;
      padding-bottom: 6px;
      border-bottom: 1px solid var(--vscode-panel-border, var(--vscode-input-border, rgba(128,128,128,0.35)));
      font-size: 11px;
      font-weight: 600;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      opacity: 0.85;
    }
    .form-section:first-child {
      margin-top: 4px;
    }
    .actions button[data-visible-when] {
      display: none;
    }
    .actions button[data-visible-when].field-visible {
      display: inline-flex;
    }
    /* Save while an autofill round trip is outstanding. APPEARANCE ONLY — the
       button stays natively clickable and its click is deferred, not dropped
       (see "SAVE MUST NOT OUTRUN AN AUTOFILL ROUND TRIP" in the script below).
       Dimmed like the shared \`:disabled\` rules so it reads as held, and
       \`progress\` rather than \`not-allowed\` because the Save is coming. */
    .actions button.save-held {
      opacity: 0.5;
      cursor: progress;
    }
    .actions button.save-held:hover {
      background: var(--vscode-button-background);
    }
  </style>
</head>
<body>
  <h2>${escapeHtml(definition.title)}</h2>
  <form id="nexus-form">
    ${fieldsHtml}
    <div class="actions">
      <button type="submit" class="btn-primary" id="save-btn">Save</button>
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
       *
       * REVIEW FINDING (P2) — and, for the DHCP path, scoped by the SNAPSHOT
       * the request carried, so a target field hand-edited while the answer was
       * in flight keeps the user's edit — see autofillSnapshot and the note on
       * pendingAutofills.
       *
       * REVIEW FINDING (P1) — and, where two requests want the SAME field,
       * ranked by the order the user made the gestures in rather than the order
       * the answers came back in (mayFillOver, and the sixth finding on
       * pendingAutofills).
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
        // Read once, not per key: collecting inside the loop would compare the
        // later keys against a form this very loop has already been writing to.
        var requestSnapshot = isProfileFill ? undefined : autofillSnapshot(msg.requestId);
        var liveValues = requestSnapshot ? collectFormValues() : undefined;
        // The keys this answer actually wrote, so the ownership record it takes
        // over below covers exactly those and not the ones it was refused.
        var writtenKeys = [];
        for (var fk in fillValues) {
          if (!isProfileFill && requestSnapshot && !mayFillOver(fk, msg.requestId, liveValues, requestSnapshot)) {
            // Either hand-edited since this request went out — the host decided
            // what it was allowed to overwrite from the snapshot above, so its
            // answer for THIS key is reasoning about a value that no longer
            // exists — or claimed by a request the user made LATER, whose own
            // answer outranks this one. Every other key in the same answer is
            // still good and still applied.
            continue;
          }
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
          writtenKeys.push(fk);
        }
        if (isProfileFill) {
          profileFilledKeys = nextFilledKeys;
        }
        updateVisibility();
        updateProfileManagedFields();
        if (!isProfileFill) {
          // After updateVisibility, not before: hiding a group disables its
          // controls and collectFormValues skips disabled ones, so recording
          // earlier would store a value for a field the next comparison will
          // not even see.
          rememberAutofillWrites(writtenKeys, msg.requestId);
        }
      }

      /**
       * May request \`requestId\`'s answer write \`key\`? Three questions in
       * precedence order — see the sixth REVIEW FINDING on pendingAutofills for
       * the race this exists to settle and why provenance rather than value is
       * what separates a hand edit from an older answer's write.
       */
      function mayFillOver(key, requestId, liveValues, requestSnapshot) {
        var owner = autofillFieldOwners[key];
        // A gesture the user made AFTER this one has already had its answer
        // write this field. It outranks this one whatever the snapshot says,
        // including the case where the field still agrees with this request's
        // snapshot and no hand-edit test would object.
        if (owner && owner.id > requestId) {
          return false;
        }
        // Untouched since this request went out: the host reasoned about the
        // value that is still there, and its answer stands as it always has.
        if (liveValues[key] === requestSnapshot[key]) {
          return true;
        }
        // Moved. That is the user's own edit — which wins — UNLESS what is
        // sitting there is exactly what an OLDER request's answer put there and
        // nothing has touched it since, in which case this later gesture's
        // answer supersedes it.
        return !!owner && owner.id < requestId && owner.value === liveValues[key];
      }

      /**
       * Records this answer as the last autofill to have written each of these
       * fields, and WHAT it left there — the value read back off the form
       * rather than taken from the fill payload, so it is in the same shape the
       * comparison in mayFillOver will meet it in (a pool count is filled as a
       * string and collected as a Number).
       *
       * Never recorded for a profile fill: that path has its own ownership
       * record (profileFilledKeys / profileDisplacedValues), carries no request
       * snapshot to rank against, and no form renders both an authProfileId
       * select and a DHCP autofill row.
       */
      function rememberAutofillWrites(keys, requestId) {
        if (requestId === undefined || keys.length === 0) {
          return;
        }
        var settled = collectFormValues();
        for (var wi = 0; wi < keys.length; wi++) {
          autofillFieldOwners[keys[wi]] = { id: requestId, value: settled[keys[wi]] };
        }
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

      /* TELNET (Phase 0, MINOR-3) — a numeric field whose DEFAULT follows
         another control (the server form's Port following Protocol: 22 for ssh,
         23 for telnet).

         P2-A (Codex) — the swap tracks whether the value is AUTO-DERIVED, not
         whether it merely looks like a default. Asking "is this one of the
         mapped defaults?" cannot tell a hand-set SSH-on-23 apart from the telnet
         default, so a protocol round-trip silently rewrote it to 22 — breaking
         the "hand-set values are retained" contract this hook is supposed to
         keep. A value is auto-derived only if it matched the SOURCE'S OWN
         default at render time, and it stops being auto the moment the user
         types into the field. A dirty flag alone is not enough: the seeded value
         is judged before any typing happens. */
      var defaultsTargets = document.querySelectorAll("[data-defaults-from]");
      for (var di = 0; di < defaultsTargets.length; di++) {
        (function(input) {
          var spec;
          try {
            spec = JSON.parse(input.dataset.defaultsFrom);
          } catch (_error) {
            return;
          }
          if (!spec || !spec.field || !spec.defaults) return;
          var source = form.elements[spec.field];
          if (!source) return;
          /* Auto-derived iff the rendered value is exactly the default for the
             protocol the form OPENED on. A telnet server on 23 is auto; an SSH
             server on 23 is the user's own choice and is never touched again. */
          var isAuto = String(input.value) === String(spec.defaults[source.value]);
          input.addEventListener("input", function() { isAuto = false; });
          input.addEventListener("change", function() { isAuto = false; });
          var applyDefault = function() {
            if (!isAuto) return;
            var wanted = spec.defaults[source.value];
            if (wanted === undefined) return;
            if (String(input.value) !== String(wanted)) {
              input.value = String(wanted);
              /* Still auto: this write is the hook's own, not the user's. */
              isAuto = true;
            }
          };
          source.addEventListener("change", applyDefault);
          source.addEventListener("input", applyDefault);
        })(defaultsTargets[di]);
      }

      /**
       * Everything this form would submit right now, in the shape the
       * extension host reads (FormValues). One definition rather than the
       * four near-identical copies this script used to carry: submit, Test
       * Connection, the inline-create snapshot and — new — the autofill
       * payload all need exactly the same collection, and a fifth copy is how
       * they drift apart. Disabled controls are skipped because a hidden
       * field's value is not part of the form's answer (updateVisibility
       * disables what it hides).
       */
      function collectFormValues() {
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
        return values;
      }

      /**
       * ── SAVE MUST NOT OUTRUN AN AUTOFILL ROUND TRIP ────────────────────
       * Six findings have landed on this one mechanism, and they are recorded
       * in the order they were made. What each of them settles, so a reader
       * after the seventh can find the one they need:
       *   1. Save is HELD for the round trip, request by request (P1).
       *   2. A request is identified by a minted id, never by the key/value it
       *      asked about (P2).
       *   3. The hold is visual only — the native \`disabled\` property swallows
       *      the very click it was meant to postpone (P1, ABANDONED twice).
       *   4. The commit fires on Enter as well as on blur, or nothing is
       *      pending when the implicit submission arrives (P1).
       *   5. Each request keeps its own values snapshot, so a target field
       *      hand-edited while the answer was in flight survives it (P2).
       *   6. Where two outstanding requests want the same field, the NEWER
       *      gesture's answer wins it — whichever answer arrives first (P1).
       *
       * REVIEW FINDING (P1) — an autofill is a round trip through the
       * extension host, and a Save clicked while one is in flight submits the
       * fields as they were BEFORE the answer landed. For the DHCP editor's
       * CIDR row that is silent data loss in both directions: the old subnet,
       * pool and gateway are saved as though nothing had been typed, and the
       * network that WAS typed is discarded with them, because "cidr" is an
       * input shape the settings layer deliberately never writes (see
       * DHCP_CIDR_FIELD_KEY). The user sees a network go in and a save go
       * through, and gets neither.
       *
       * Racing faster is not available — the answer is asynchronous by
       * construction — so Save is held instead. Requests are tracked one by
       * one rather than by a flag, because several can be outstanding at once:
       * committing the CIDR row and then picking a NIC posts two, and a flag
       * would re-open Save on the first answer with the second still in the
       * air — the same race, one round trip later.
       *
       * REVIEW FINDING (P2) — each request is identified by a REQUEST ID this
       * script mints, not by the key and value it asked about. Key and value
       * do not identify anything: the same pair can be asked twice before
       * either answer returns (type a network, change it, change it back), and
       * two identical tokens in the pending list are indistinguishable. Each
       * request is answered TWICE in the usual case (fillFields, then the
       * terminator), so the first request's pair of answers would release BOTH
       * of those entries — retiring an outstanding request that has not been
       * answered at all, and letting a deferred Save fire over a snapshot its
       * own answer was about to correct. Ids are unique per request whatever
       * was asked, so an answer can only ever release the request it answers.
       * Key and value still travel with the answer for a different job — they
       * decide whether the FILL is still about the option now selected (see
       * fillAnswersCurrentSelection) — and both are echoed on both answers.
       *
       * A submit attempted meanwhile is DEFERRED, not dropped, and ONE check
       * does that: pendingAutofills non-empty at the top of the form's own
       * "submit" handler means remember the intent and fire it when the last
       * answer lands, over values collected then — which is exactly what the
       * user meant by Save. Every route into a submission arrives at that one
       * handler: Enter in a text field, a click on Save, and the click that
       * fired this round trip in the first place and is still in flight when it
       * is posted. Nothing else may stand in front of it.
       *
       * REVIEW FINDING (P1, fifth round) — HOLDING SAVE IS NOT THE BUTTON'S
       * JOB. The Save button is marked held VISUALLY and only visually (the
       * save-held class plus aria-busy, applied in postAutofill and cleared in
       * autofillSettled); its native \`disabled\` property is never set. Two
       * rounds were spent trying to make \`disabled\` safe, and both are recorded
       * here as ABANDONED so a third attempt is not made.
       *
       * \`disabled\` on a type="submit" button does not merely grey it: the
       * browser then refuses to dispatch click, and therefore submit, on that
       * button at all. That makes it a second gate in front of the deferral
       * above — one that SWALLOWS a submit instead of deferring it, which is
       * precisely the silent loss this whole block exists to prevent. Both
       * timings failed for the same reason:
       *   * disabling synchronously from the "change" that posts the request
       *     lands mid-gesture. Clicking Save while the CIDR row still has focus
       *     delivers mousedown on the button, then the blur-driven "change" —
       *     which is what calls postAutofill — then mouseup, then click. The
       *     button is disabled by the time the browser weighs that click, so no
       *     click, no "submit" event, and the user's Save is simply gone;
       *   * deferring the disable by one macrotask (setTimeout(fn, 0)) only
       *     narrows that window. A macrotask runs when the queue next drains,
       *     which is not when the user's finger comes up: hold the button down
       *     longer than one tick — a duration no API bounds and no pointer
       *     hardware promises — and the disable still lands between mousedown
       *     and mouseup, with the same swallowed click.
       * There is no third timing to try, because the events being raced are the
       * user's own. So the mechanism is gone rather than re-tuned: a class and
       * an ARIA attribute cannot suppress a dispatch, every submit the user
       * makes reaches the deferral, and nothing about the hold depends on
       * elapsed time any more.
       *
       * The cost is that Save can be clicked repeatedly while a round trip is
       * out, and that is deliberately not de-duplicated: each attempt sets the
       * same deferredSubmit flag, and postSubmit fires once, when the last
       * answer lands.
       *
       * REVIEW FINDING (P1) — the submit handler's deferral only works if
       * something is PENDING by the time submit is dispatched, and a commit
       * does not only happen on blur. The round trip is started from "change"
       * on purpose (deriving a
       * whole pool from 192.168.2.0/2 on the way to /24 would overwrite the
       * fields the user is about to see filled correctly), and "change" on a
       * text input is a blur-time event. Enter does NOT blur: it is the
       * browser's implicit submission, and the input still holds focus while the
       * form submits. So the deferral was reached with pendingAutofills empty —
       * nothing in flight because nothing had been committed — and the submit
       * went straight out over the network the user had just replaced, with the
       * replacement discarded. Same silent loss as the P1 above, one event
       * earlier: "cidr" is never persisted (DHCP_CIDR_FIELD_KEY), so the typed
       * network survives nowhere else.
       *
       * The commit is therefore ALSO fired from "keydown" on Enter, and no
       * preventDefault goes with it. Submission is the DEFAULT ACTION of that
       * key event, and a default action runs only after every listener for the
       * event has returned; postAutofill is synchronous, so the pending entry
       * exists before the form's own "submit" is dispatched and the deferral
       * above sees it — exactly as it does for the click path. Cancelling the
       * event instead would mean re-submitting the form by hand, which is more
       * machinery for the same result.
       *
       * Both listeners call ONE commit, gated on the field having actually been
       * edited (an "input" event since the last commit). The gate is not
       * tidiness:
       *   * whichever listener fires first clears it, so if this engine also
       *     fires "change" for an Enter-driven submission the second one posts
       *     nothing. A duplicate round trip would be harmless — ids make
       *     concurrent requests independent (P2 above) — but one that cannot be
       *     minted needs no de-duplication at all;
       *   * "change" already means "the user edited this", and Enter does not.
       *     Enter in an untouched CIDR row is plain "save", and deriving from it
       *     would be destructive rather than merely wasteful: dhcpCidrFormFills
       *     writes subnet, rangeStart and poolCount UNCONDITIONALLY (they are
       *     what the network says, not suggestions the host may decline), so a
       *     hand-typed pool start would be replaced by the network's first host
       *     on the way out — and the snapshot guard below cannot catch it,
       *     because the snapshot is taken after that edit and the field still
       *     agrees with it;
       *   * a value written back BY an answer (applyFillFields → setFieldValue)
       *     dispatches no "input" and so is not an edit — the normalised CIDR
       *     the host echoes does not ask to be derived a second time.
       *
       * The pointer path is unchanged and is still the blur-driven "change".
       * The two gestures reach the same hazard through different events and each
       * needs its own listener: a click blurs the field and never produces a
       * keydown, an Enter produces a keydown and never blurs the field.
       *
       * A request is released by whichever of its two answers arrives:
       * fillFields when there were values to fill, and the unconditional
       * autofillSettled that follows it. The terminator is what makes this
       * safe rather than merely usual — a derivation that fills nothing (a
       * /32, a network that describes no pool) sends no fillFields at all, and
       * releasing on fillFields alone would leave Save dead until the form was
       * reopened.
       *
       * REVIEW FINDING (P2) — each pending request also KEEPS the values
       * snapshot it was sent with, because the host's decision about what it
       * may overwrite is made against that snapshot and the user can edit a
       * target field after it was taken.
       *
       * The host gates gateway, broadcast, serverId and dns on isAutoFillable
       * against the snapshot the request carried: blank, or still holding what
       * the PREVIOUS network derived. Commit a CIDR, then — while the round
       * trip is out — hand-type a gateway, and that gating is answering a
       * question about a value the field no longer holds. fillAnswersCurrentSelection
       * cannot catch it: it asks only whether the field the request was ABOUT
       * (msg.key, the CIDR row) still holds the value it was about, and it
       * does. The initiating row is untouched; it is the TARGET that moved.
       *
       * So the answer is re-checked field by field against the snapshot before
       * anything is written (applyFillFields): a target still holding what it
       * held at request time is filled as before, one that has since diverged
       * is left alone, and the rest of the same answer still lands. Skipping
       * the whole answer instead would throw away the mask and pool the user
       * asked for over one edited gateway.
       *
       * An answer whose requestId matches no pending entry is applied
       * unconditionally, exactly as before — same leniency as
       * fillAnswersCurrentSelection's "a control this form does not render is
       * applied as before". There is no snapshot to judge it against, and the
       * only things that reach that state are a hand-built message and an
       * answer that arrived after its own terminator.
       *
       * REVIEW FINDING (P1, sixth round) — WHEN TWO REQUESTS OVERLAP, ARRIVAL
       * ORDER IS NOT INTENT. Everything above makes concurrent requests
       * INDEPENDENT; none of it RANKS them. Commit the CIDR row and then pick a
       * different NIC before either answer lands, and both requests derive the
       * same fields from two different networks — subnet, rangeStart and
       * poolCount are written unconditionally by dhcpCidrFormFills whichever
       * trigger reached it. The per-request snapshot check then settles them by
       * luck: the CIDR answer lands first and fills its network, and the NIC
       * answer that follows finds those targets no longer holding what ITS
       * snapshot took, reads that as a hand edit (finding 5) and skips them.
       * The form is left bound to the NIC the user picked LAST holding the pool
       * of the network they typed FIRST, and a deferred Save persists exactly
       * that pairing.
       *
       * A hand edit and an older answer's write cannot be told apart by value,
       * so they are told apart by PROVENANCE: every answer records, for each
       * field it wrote, its own request id and the value it left there
       * (autofillFieldOwners, rememberAutofillWrites). A later answer meeting a
       * target that has moved then asks WHO moved it — the user, or a request
       * older than itself — and supersedes only the second. The other direction
       * is ranked off the same record: an older answer never writes over a
       * field a NEWER request's answer has already claimed, even where the
       * field still agrees with the older request's own snapshot and the
       * hand-edit test would have waved it through (mayFillOver).
       *
       * Ranking by ID rather than by ARRIVAL is the whole point. Ids are minted
       * in gesture order (postAutofill), and gesture order is what the user
       * meant; the order two round trips happen to return in is the extension
       * host's scheduling and says nothing about intent.
       *
       * Per FIELD, not per answer. "Suppress an older answer entirely while a
       * newer request is outstanding" was the other way to close this, and it
       * is wrong here because the two fill sets are not the same set: under a
       * relay agent a NIC pick fills the server identifier ALONE
       * (dhcpRelayBindFills), so dropping the CIDR answer wholesale would throw
       * away the subnet and pool the user typed with nothing arriving to
       * replace them — and \`cidr\` is never persisted (DHCP_CIDR_FIELD_KEY), so
       * the typed network would survive nowhere. That is the same silent loss
       * the first finding in this block exists to prevent, one round trip
       * later. The newer gesture wins the fields it actually claims; the older
       * answer still lands on every field the newer one leaves alone.
       *
       * What this deliberately does NOT do is un-write an older answer whose
       * fields the newer request never mentions: nothing arrives to replace
       * them, and a rollback would have to invent what the form should hold
       * instead. The case that matters there — a NIC whose own network fills
       * nothing at all — is caught where it can be answered properly, at the
       * Save the pairing would otherwise reach: dhcpInterfaceNetworkProblem
       * refuses a submission whose picked interface implies an unfillable
       * network rather than letting a new bind persist beside an unrelated pool
       * (networkServerSettings.ts).
       *
       * Holding Save is untouched by any of it. A suppressed WRITE does not
       * retire a REQUEST: each answer still releases its own id and only its
       * own (autofillSettled), so a deferred Save keeps waiting for the newer
       * request too and fires over the values that request's own answer leaves
       * behind.
       *
       * A narrow, accepted gap: provenance is tracked by VALUE, not by a
       * separate "the user touched this" flag, so a hand edit that happens to
       * retype exactly what an older answer had already written there reads
       * identically to that older write never having been touched at all —
       * mayFillOver's third rule lets the newer answer supersede it, same as
       * it would the older answer's own untouched field. The two are, in that
       * one case, genuinely indistinguishable from what the DOM alone can
       * show; closing it needs a real edit flag independent of value, which
       * is more machinery than a coincidence this specific is worth. The
       * ordinary case — a hand edit to anything OTHER than the older
       * answer's own value — is unaffected and still wins.
       */
      var pendingAutofills = [];
      /** Field name → { id, value }: the last autofill answer to have written
       *  that field, and what it left in it. Ownership of a field for ranking
       *  purposes, nothing else — see the sixth finding above. */
      var autofillFieldOwners = {};
      var deferredSubmit = false;
      var nextAutofillRequestId = 1;
      var saveBtn = document.getElementById("save-btn");

      /* The "a round trip is outstanding" mark on Save: appearance and
         assistive semantics, never behaviour — see "HOLDING SAVE IS NOT THE
         BUTTON'S JOB" above for why the native disabled property is not touched
         here. aria-busy rather than aria-disabled: the click IS honoured, just
         not yet, and telling a screen reader the control is unavailable would
         be the same lie the disabled attribute used to tell the browser. */
      function markSaveHeld(held) {
        if (!saveBtn) return;
        saveBtn.classList.toggle("save-held", held);
        if (held) {
          saveBtn.setAttribute("aria-busy", "true");
        } else {
          saveBtn.removeAttribute("aria-busy");
        }
      }

      /**
       * REVIEW FINDING (P1) — previousValue is what THIS FIELD held immediately
       * before the gesture being reported, and it exists because for a SELECT
       * the snapshot cannot say. A select is applied to the DOM before the
       * round trip is posted (selectCustomOption runs first, so the trigger and
       * the hidden input already show the new option), which means the
       * snapshot's entry for this key is the NEW value on both sides of the
       * change. A host that needs the pre-selection value — the DHCP editor's
       * bind address, whose option 54 gate asks "what would this fill have
       * written BEFORE the NIC moved" — cannot recover it from the snapshot,
       * and reusing the new one silently answers that question with the new
       * NIC. Two NICs on one subnet is where that shows: switching 10.0.0.5 to
       * 10.0.0.6 leaves a server identifier of .5 looking hand-set, and the
       * DHCP socket then answers from .6 while telling clients to renew at .5.
       *
       * Sent only when the caller has one to send. A TEXT field's commit
       * changes only itself and never moves the bind address, so the CIDR row
       * passes nothing and the host keeps its existing "same address either
       * side" reading for that trigger.
       */
      function postAutofill(key, value, previousValue) {
        var requestId = nextAutofillRequestId++;
        // Collected ONCE and used twice — the payload the host reasons over and
        // the copy this script judges the answer against have to be the same
        // object, or the two ends are comparing different forms.
        var snapshot = collectFormValues();
        pendingAutofills.push({ id: requestId, snapshot: snapshot });
        /* Marked in the same breath as the push, with no timer between them,
           because nothing about event DISPATCH depends on this any more — the
           deferral in the submit handler is what actually holds Save. The
           macrotask that used to sit here was protecting an in-flight click
           from the disabled attribute; with the attribute gone there is nothing
           left for it to protect. */
        markSaveHeld(true);
        var request = { type: 'autofill', key: key, value: value, values: snapshot, requestId: requestId };
        if (previousValue !== undefined) request.previousValue = previousValue;
        vscode.postMessage(request);
      }

      /** The values snapshot the still-pending request was sent with, or
       *  undefined when nothing pending matches — see the note on
       *  pendingAutofills for why that case applies the answer as before.
       *  Always read BEFORE autofillSettled retires the entry, which is why the
       *  message handler applies the fill first and settles second. */
      function autofillSnapshot(requestId) {
        if (requestId === undefined) return undefined;
        for (var pi = 0; pi < pendingAutofills.length; pi++) {
          if (pendingAutofills[pi].id === requestId) return pendingAutofills[pi].snapshot;
        }
        return undefined;
      }

      /** One answer — a fill, an empty answer, or a failure — has come back.
       *  Idempotent per request: the first of the two answers releases it and
       *  the second finds nothing to release, so an answer can never pay off
       *  a DIFFERENT request that is still outstanding. An answer for a
       *  request this form never made (another panel's shape, a hand-built
       *  test message) carries an id this script never minted, matches
       *  nothing, and is ignored. */
      function autofillSettled(requestId) {
        if (requestId === undefined) return;
        var index = -1;
        for (var si = 0; si < pendingAutofills.length; si++) {
          if (pendingAutofills[si].id === requestId) {
            index = si;
            break;
          }
        }
        if (index === -1) return;
        pendingAutofills.splice(index, 1);
        if (pendingAutofills.length > 0) return;
        markSaveHeld(false);
        if (deferredSubmit) {
          deferredSubmit = false;
          postSubmit();
        }
      }

      function postSubmit() {
        vscode.postMessage({ type: "submit", values: collectFormValues() });
      }

      /* An autofill-capable TEXT field — the DHCP editor's Network (CIDR) row.
         The same round trip the autofill-capable SELECT below already makes,
         fired on COMMIT rather than on "input": a network is only meaningful
         once it is committed, and deriving a whole pool from 192.168.2.0/2 on
         the way to /24 would overwrite the very fields the user is about to
         see filled correctly. The values snapshot rides along because the
         answer decides what it may overwrite — a hand-typed gateway survives,
         a stale derived one does not. Fields that did not opt in carry no
         data-autofill attribute and are not touched by this loop.

         A commit is EITHER of the two gestures that end an edit: blur, which
         is what "change" is, and Enter, which submits the form without
         blurring anything. See the fourth REVIEW FINDING on pendingAutofills
         for why both are needed, why one shared commit rather than two, why
         the "edited" gate is load-bearing and why no preventDefault. */
      var autofillInputs = document.querySelectorAll('input[data-autofill="true"]');
      for (var afi = 0; afi < autofillInputs.length; afi++) {
        (function(input) {
          /* Set by the user's own editing — typing, pasting, dropping text,
             undo — and cleared by the commit it belongs to. A programmatic
             write (setFieldValue, and so applyFillFields) dispatches no "input"
             event and is deliberately not an edit. */
          var edited = false;
          function commitAutofill() {
            if (!edited) return;
            edited = false;
            postAutofill(input.name, input.value);
          }
          input.addEventListener("input", function() {
            edited = true;
          });
          input.addEventListener("change", commitAutofill);
          input.addEventListener("keydown", function(event) {
            if (event.key === "Enter") commitAutofill();
          });
        })(autofillInputs[afi]);
      }

      form.addEventListener("submit", function(e) {
        e.preventDefault();
        if (pendingAutofills.length > 0) {
          deferredSubmit = true;
          return;
        }
        postSubmit();
      });

      document.getElementById("cancel-btn").addEventListener("click", function() {
        vscode.postMessage({ type: "cancel" });
      });

      var testBtn = document.getElementById("test-btn");
      if (testBtn) {
        testBtn.addEventListener("click", function() {
          vscode.postMessage({ type: "test", values: collectFormValues() });
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
          setCustomSelectOpen(wrapper, false);
          var trigger = wrapper.querySelector('.custom-select-trigger');
          if (trigger) trigger.focus();
          // Snapshot current field values so an inline-create handler can act on
          // what the user has typed (issue #48 PR-E: "Save current filter as…"
          // needs the current Device Filter text). Same collection the submit
          // handler uses.
          vscode.postMessage({ type: 'createInline', key: wrapper.dataset.name, values: collectFormValues() });
          return;
        }
        // Read BEFORE selectCustomOption writes the new option into the hidden
        // input this reads through: after that call the control holds the NEW
        // value and the old one is gone from the DOM entirely. dataset.prev is
        // NOT the place to get it — it is written here and at the
        // addSelectOption path below but read nowhere and seeded nowhere, so on
        // the first selection after the form opens it is simply undefined,
        // exactly when the configured value is the one a host would need.
        // fieldValue reads the control the render seeded, so the very first
        // change reports the value the form opened with.
        var previousValue = fieldValue(wrapper.dataset.name);
        selectCustomOption(wrapper, value);
        wrapper.dataset.prev = value;
        // FIX B (PR #64 Codex round 2) — a fillTarget select fills its target
        // field SYNCHRONOUSLY from the chosen option's raw data-fill-value, before
        // Save can be clicked (no async round trip to outrun). Only real options
        // carry the attribute, so (None) is a no-op that never clears the target,
        // and the __create__ sentinel already returned above. An empty-filter
        // definition carries data-fill-value="" and fills "" (its own copy). A
        // later hand edit to the target simply overwrites this — nothing re-resolves
        // the picker at submit — so hand-edit-wins holds. Independent of the
        // auth-profile mirror machinery: this touches neither profileFilledKeys nor
        // profileDisplacedValues.
        if (wrapper.dataset.fillTarget && opt.dataset.fillValue !== undefined) {
          setFieldValue(wrapper.dataset.fillTarget, opt.dataset.fillValue);
        }
        if (wrapper.dataset.autofill === 'true' && value) {
          // The values snapshot rides along for the same reason the text
          // autofill above carries it: an answer may have to keep what the
          // user typed. The auth-profile mirror ignores it; the DHCP interface
          // picker derives a whole pool from the chosen NIC and cannot
          // without it. previousValue rides along for what the snapshot CANNOT
          // say (see postAutofill): this selection is already in the DOM, so
          // the snapshot's copy of this key is the new option on both sides of
          // the change.
          postAutofill(wrapper.dataset.name, value, previousValue);
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
            // FIX B (PR #64 Codex round 2) — an inline-created option (e.g. a just-
            // saved filter) carries its raw fill value too, so re-picking it later
            // fills the target synchronously like every render-time option.
            if (msg.fillValue !== undefined) {
              newOpt.dataset.fillValue = msg.fillValue;
            }
            // P1 — mirror the initial render's label+desc structure so an
            // inline-created row carries its query line (msg.description) like
            // every other option, instead of a bare label-only node.
            var newLabelEl = document.createElement("div");
            newLabelEl.className = "custom-select-option-label";
            newLabelEl.textContent = msg.label;
            newOpt.appendChild(newLabelEl);
            if (msg.description) {
              var newDescEl = document.createElement("div");
              newDescEl.className = "custom-select-option-desc";
              newDescEl.textContent = msg.description;
              newOpt.appendChild(newDescEl);
            }
            var dropdown = wrapper.querySelector('.custom-select-dropdown');
            var createOpt = dropdown.querySelector('.custom-select-option[data-value^="__create__"]');
            var inserted = false;
            // For a filterable select the reals are rendered in locale-aware
            // sorted order (sortFilterableOptions), with (None) pinned top and
            // the create row bottom. Slot the inline-created item into its
            // alphabetical position among the reals rather than dropping it at
            // the tail — so it lands where the user would next look for it.
            if (wrapper.classList.contains('filterable')) {
              var newLabel = msg.label || '';
              var siblings = dropdown.querySelectorAll('.custom-select-option');
              for (var soi = 0; soi < siblings.length; soi++) {
                var sib = siblings[soi];
                var sibVal = sib.dataset.value || '';
                // Reals only: never order against the (None) or create sentinels.
                if (sibVal === '' || sibVal.indexOf('__create__') === 0) continue;
                var sibLabelEl = sib.querySelector('.custom-select-option-label');
                var sibLabel = sibLabelEl ? sibLabelEl.textContent : sib.textContent;
                if (newLabel.localeCompare(sibLabel, undefined, { sensitivity: 'base' }) < 0) {
                  dropdown.insertBefore(newOpt, sib);
                  inserted = true;
                  break;
                }
              }
            }
            if (!inserted) {
              // Non-filterable, or sorts after every existing real: land just
              // before the create row (its declared tail slot), or append.
              if (createOpt) {
                dropdown.insertBefore(newOpt, createOpt);
              } else {
                dropdown.appendChild(newOpt);
              }
            }
            // Captured before the selection lands, for the same reason and in
            // the same order as the user-click path above. The DHCP interface
            // picker cannot reach here (it renders no inline-create row, and
            // the DHCP form wires no onCreateInline, so nothing ever posts
            // addSelectOption for it) — but the auth profile select IS both
            // autofill-capable and inline-creatable, and leaving one of the two
            // selection paths reporting nothing is how the next autofill host
            // that needs a pre-selection value finds it only half wired.
            var previousValue = fieldValue(wrapper.dataset.name);
            selectCustomOption(wrapper, msg.value);
            wrapper.dataset.prev = msg.value;
            // FIX B — mirror the user-click path's synchronous fill for a
            // fillTarget select (the inline-created saved filter was saved FROM
            // the current field, so this re-affirms that value in the DOM).
            if (wrapper.dataset.fillTarget && msg.fillValue !== undefined) {
              setFieldValue(wrapper.dataset.fillTarget, msg.fillValue);
            }
            // An option injected after inline creation is a selection like any
            // other, so it must run the same two follow-ups the user-click
            // path runs (see initCustomSelects below). Without them an
            // inline-created auth profile is selected but never mirrors its
            // username into the managed field, and never locks it.
            if (wrapper.dataset.autofill === 'true' && msg.value) {
              postAutofill(wrapper.dataset.name, msg.value, previousValue);
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
          // Released AFTER the fill is applied, so a submit this answer frees
          // is collected over the filled fields rather than the stale ones.
          applyFillFields(msg);
          autofillSettled(msg.requestId);
        }
        if (msg.type === "autofillSettled") {
          autofillSettled(msg.requestId);
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
