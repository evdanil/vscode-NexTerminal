/**
 * The NAME of the form's advanced disclosure, as the user reads it on screen —
 * one definition, because messages elsewhere send people to it by name
 * ("turn on X under …"), and a message naming a section no form draws is worse
 * than one that names no section at all. `renderFormHtml` renders the summary
 * from this; `expandAdvanced` below opens it.
 */
export const ADVANCED_SECTION_LABEL = "Advanced options";

export interface VisibleWhenCondition {
  field: string;
  value: string | string[];
}

export type VisibleWhen = VisibleWhenCondition | VisibleWhenCondition[];

/**
 * TELNET (Phase 0, MINOR-3) — "this numeric field's DEFAULT follows another
 * field's value". `field` names the control to watch; `defaults` maps that
 * control's values to the default this field should hold for each.
 *
 * THE RULE THAT MAKES IT SAFE (P2-A): the value is swapped only while it is
 * AUTO-DERIVED — it matched the source's own default when the form rendered, and
 * the user has not typed into it since. Anything hand-set is left alone forever
 * after.
 *
 * "Auto-derived", not "looks like a default": those differ exactly where it
 * matters. A hand-set SSH-on-23 is byte-identical to the telnet default, so a
 * value-only test rewrote it to 22 on a protocol round-trip — silently
 * destroying a deliberate choice, which is the opposite of this contract. A
 * dirty flag alone is not sufficient either, because the seeded value has to be
 * judged before the user touches anything.
 */
export interface FieldDefaultsFrom {
  field: string;
  defaults: Record<string, number>;
}

interface FormFieldCommon {
  advanced?: boolean;
  hint?: string;
  visibleWhen?: VisibleWhen;
}

export type FormFieldDescriptor =
  | ({ type: "hidden"; key: string; value?: string } & FormFieldCommon)
  | ({ type: "text"; key: string; label: string; required?: boolean; placeholder?: string; value?: string; scannable?: boolean } & FormFieldCommon)
  | ({ type: "textarea"; key: string; label: string; required?: boolean; placeholder?: string; value?: string; rows?: number } & FormFieldCommon)
  | ({ type: "password"; key: string; label: string; required?: boolean; placeholder?: string; value?: string } & FormFieldCommon)
  | ({ type: "number"; key: string; label: string; required?: boolean; min?: number; max?: number; step?: number | "any"; placeholder?: string; value?: number; defaultsFrom?: FieldDefaultsFrom } & FormFieldCommon)
  /**
   * `autofillFilledKeys` is the render-time half of field-ownership tracking
   * (see `updateProfileManagedFields` in formHtml.ts): the form keys the
   * CURRENTLY SELECTED option's autofill fills. The webview locks exactly
   * these until the next selection replaces them with the keys that
   * selection's `fillFields` answer actually filled. Only meaningful
   * alongside `autofill`.
   *
   * `autofillDisplacedValues` is the render-time half of the RESTORE
   * (`profileDisplacedValues` in formHtml.ts): for each key whose descriptor
   * this render already overwrote with the selected option's value, the value
   * the field would otherwise have shown — the record's own. The webview seeds
   * its restore record from it, so deselecting hands those values straight
   * back, exactly as a mid-session switch does. A key the option supplies no
   * usable value for is not overwritten, so it has no entry and needs none.
   */
  /**
   * `filterable` opts a select into the type-to-filter + sorted-options
   * treatment (a filter input at the top of the dropdown, options rendered
   * locale-sorted with `(None)`/`__create__*` sentinels pinned). Default
   * false → today's markup and ordering, byte-for-byte. Reach for it on
   * selects whose option list grows unbounded (server / auth-profile pickers),
   * never on small fixed-domain ones (auth type, proxy type) where a filter is
   * noise.
   *
   * `fillTarget` + option `fillValue` (issue #48 PR-E, PR #64 Codex round 2)
   * are the SYNCHRONOUS, no-round-trip counterpart to `autofill`: a select
   * whose `fillTarget` names another form key fills THAT key straight from the
   * chosen option's raw `fillValue` in the webview, before Save can be clicked.
   * The saved-filter picker uses this so a Save that races the old async fill
   * can no longer carry a stale Device Filter. Only real options carry a
   * `fillValue` (the raw query string, `""` included); the `(None)` sentinel
   * has none, so picking it is a no-op that never clears the target, and the
   * `__create__` sentinel routes to inline-create before any fill. Unlike
   * `autofill`, this never touches the auth-profile mirror/ownership machinery.
   */
  | ({ type: "select"; key: string; label: string; options: { label: string; value: string; description?: string; fillValue?: string }[]; value?: string; filterable?: boolean; autofill?: boolean; autofillFilledKeys?: string[]; autofillDisplacedValues?: Record<string, string>; fillTarget?: string } & FormFieldCommon)
  | ({ type: "combobox"; key: string; label: string; suggestions: string[]; required?: boolean; placeholder?: string; value?: string } & FormFieldCommon)
  | ({ type: "checkbox"; key: string; label: string; value?: boolean } & FormFieldCommon)
  | ({ type: "file"; key: string; label: string; value?: string } & FormFieldCommon)
  /** Raw HTML injected without escaping. `content` must only contain trusted, developer-authored markup — never user-controlled data. */
  | ({ type: "html"; content: string } & FormFieldCommon)
  /**
   * A group heading. Carries no `key`, so it submits nothing and never appears
   * in `FormValues` — the fields that follow it, up to the next `section`, are
   * the group. Distinct from `html`, which is styled as a bordered illustration
   * card and widens the whole form (`body:has(.form-illustration)`); this is a
   * plain rule-and-label, so every form's groups read alike and the label is
   * escaped rather than trusted as markup.
   */
  | ({ type: "section"; label: string } & FormFieldCommon);

export interface FormDefinition {
  title: string;
  fields: FormFieldDescriptor[];
  /** When true, a "Test Connection" button is rendered in the form footer. */
  testable?: boolean;
  /** Optional visibility rule for the "Test Connection" button. */
  testableWhen?: VisibleWhen;
  /**
   * Renders the "Advanced options" section already open. Set by a caller that
   * is sending the user to a field living inside it — an error naming
   * "IPMI / BMC Host" is a dead end if the form opens with that field
   * collapsed out of sight.
   */
  expandAdvanced?: boolean;
}

export type FormValues = Record<string, string | number | boolean | undefined>;

export type FormMessage =
  | { type: "submit"; values: FormValues }
  | { type: "cancel" }
  | { type: "browse"; key: string }
  | { type: "scan"; key: string }
  /**
   * `values` (issue #48 PR-E) — a snapshot of the form's current field values at
   * the moment the "Create new…" sentinel was chosen, so an inline-create handler
   * can act on what the user has typed so far (the saved-filter "Save current
   * filter as…" affordance needs the current Device Filter text). Optional and
   * additive: handlers that only need the `key` (auth profile, device template)
   * ignore it.
   */
  | { type: "createInline"; key: string; values?: FormValues }
  | { type: "autofill"; key: string; value: string }
  | { type: "test"; values: FormValues };

export type ExtensionMessage =
  | { type: "browseResult"; key: string; path: string }
  | { type: "validationError"; errors: Record<string, string> }
  | { type: "addSelectOption"; key: string; value: string; label: string; description?: string; fillValue?: string }
  /**
   * `key` echoes the `autofill` message this answers, so the webview can
   * attribute the filled values to the select that asked for them.
   *
   * REVIEW FINDING (P2) — `value` echoes the OPTION that autofill asked about,
   * which is what makes the answer discardable. An autofill is a round trip;
   * the user can move on before it returns, and without the echo a late answer
   * for a profile that is no longer selected is applied anyway — writing that
   * profile's credentials into fields the release has just unlocked, where the
   * save path reads them as the user's own. The webview compares this against
   * the select's CURRENT value and drops anything that does not match (see
   * `fillAnswersCurrentSelection` in formHtml.ts).
   */
  | { type: "fillFields"; key: string; value: string; values: Record<string, string> };
