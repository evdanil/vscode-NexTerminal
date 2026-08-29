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
        for (var fk in fillValues) {
          if (!isProfileFill && requestSnapshot && liveValues[fk] !== requestSnapshot[fk]) {
            // Hand-edited since this request went out. The host decided what it
            // was allowed to overwrite from the snapshot above, so its answer
            // for THIS key is reasoning about a value that no longer exists —
            // every other key in the same answer is still good and still
            // applied.
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
       * A submit attempted meanwhile is DEFERRED, not dropped. The disabled
       * button stops a LATER click from ever reaching the form, but two kinds
       * of submit still do reach it and silently swallowing either is its own
       * defect: Enter in a text field submits a form regardless of what the
       * buttons look like, and the click that fired this round trip in the
       * first place is still in flight when it is posted (which is why the
       * button is not disabled until the gesture carrying that click is over —
       * see postAutofill). Either fires once the last answer lands, over values
       * collected then — which is exactly what the user meant by Save.
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
       */
      var pendingAutofills = [];
      var deferredSubmit = false;
      var nextAutofillRequestId = 1;
      var saveBtn = document.getElementById("save-btn");

      function postAutofill(key, value) {
        var requestId = nextAutofillRequestId++;
        // Collected ONCE and used twice — the payload the host reasons over and
        // the copy this script judges the answer against have to be the same
        // object, or the two ends are comparing different forms.
        var snapshot = collectFormValues();
        pendingAutofills.push({ id: requestId, snapshot: snapshot });
        vscode.postMessage({ type: 'autofill', key: key, value: value, values: snapshot, requestId: requestId });
        /**
         * REVIEW FINDING (P2) — the disable is deferred by one MACROTASK, and
         * that is the whole point of the setTimeout.
         *
         * A click on Save while the CIDR row still has focus dispatches, in
         * one gesture: mousedown on the button, then the blur-driven "change"
         * on the input — which is what calls this function — then mouseup,
         * then click. Disabling here and now happens BETWEEN the mousedown and
         * the click, and a browser re-reads "disabled" as it is about to
         * dispatch each of those: the click never fires, so the form's own
         * "submit" never fires, so the deferral in the submit handler never
         * sees it. The user's Save is silently dropped and they have to click
         * a second time.
         *
         * A macrotask runs after the events already queued for the CURRENT
         * gesture have been delivered, and long before any follow-up click a
         * human could make — so the in-flight click still reaches the submit
         * handler and is deferred there, while a later click still finds the
         * button held. A microtask would NOT do: microtasks drain between
         * event dispatches, i.e. still ahead of the queued click.
         *
         * The guard is for the request that settles before its own deferred
         * disable runs (nothing outstanding any more): disabling then would
         * strand Save on a round trip that is already over.
         */
        setTimeout(function() {
          if (saveBtn && pendingAutofills.length > 0) saveBtn.disabled = true;
        }, 0);
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
        if (saveBtn) saveBtn.disabled = false;
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
         fired on "change" rather than "input": a network is only meaningful
         once it is committed, and deriving a whole pool from 192.168.2.0/2 on
         the way to /24 would overwrite the very fields the user is about to
         see filled correctly. The values snapshot rides along because the
         answer decides what it may overwrite — a hand-typed gateway survives,
         a stale derived one does not. Fields that did not opt in carry no
         data-autofill attribute and are not touched by this loop. */
      var autofillInputs = document.querySelectorAll('input[data-autofill="true"]');
      for (var afi = 0; afi < autofillInputs.length; afi++) {
        (function(input) {
          input.addEventListener("change", function() {
            postAutofill(input.name, input.value);
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
          // without it.
          postAutofill(wrapper.dataset.name, value);
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
              postAutofill(wrapper.dataset.name, msg.value);
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
