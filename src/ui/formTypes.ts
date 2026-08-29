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
  /**
   * `autofill` opts a text input into the same round trip an autofill-capable
   * SELECT already makes: on `change` (commit, not keystroke — a half-typed
   * network must never be derived from) the webview posts
   * `{type: "autofill", key, value, values}` and applies whatever `fillFields`
   * comes back. The DHCP editor's Network (CIDR) row is the first user: what a
   * network implies for the mask, the pool and the gateway is arithmetic the
   * extension host owns, not the webview.
   *
   * Default false → today's markup, byte-for-byte. A field that does not set it
   * emits no `data-autofill` attribute and wires no listener.
   */
  | ({ type: "text"; key: string; label: string; required?: boolean; placeholder?: string; value?: string; scannable?: boolean; autofill?: boolean } & FormFieldCommon)
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
  /**
   * `values` — the same snapshot `createInline` above carries, for the same
   * reason: an autofill answer often has to decide what it is ALLOWED to
   * overwrite, and only the form knows what its fields currently hold. The DHCP
   * editor's CIDR row needs it to keep a hand-typed gateway while still
   * replacing one a previous derivation wrote (`isAutoFillable` in
   * `networkServerSettings.ts`). Optional and additive: the auth-profile and
   * device-template mirrors answer from the chosen id alone and ignore it.
   *
   * **Safety argument, and it is an argument rather than a guarantee:** this
   * snapshot is collected from every enabled named control, so on a form that
   * has password inputs (the SOCKS5 / HTTP proxy passwords on the server edit
   * and unified profile forms) it carries whatever is currently typed into
   * them. That is safe today only because no password-bearing form's
   * `onAutofill` reads `values` — `serverCommands.ts` and `profileCommands.ts`
   * both declare `(key, value)` and answer from the chosen auth-profile id
   * alone; the only handler that takes the third parameter is the DHCP editor's
   * (`networkServerCommands.ts`), on a form with no password field. Nothing in
   * the type system enforces that, so the two forms' declared arity is pinned
   * by tests (`serverCommands.test.ts`, `profileCommands.test.ts`). A new
   * handler that wants to read `values` on a form with a password field is a
   * change that needs re-reviewing, not one that is safe by construction.
   *
   * `requestId` is minted by the webview, one per request, and is what the
   * webview correlates the answers against. `WebviewFormPanel` echoes it back
   * on both `fillFields` and `autofillSettled` without inspecting it; no
   * `onAutofill` handler sees it or needs to. See the "SAVE MUST NOT OUTRUN AN
   * AUTOFILL ROUND TRIP" comment in formHtml.ts for why key and value cannot
   * do that job.
   */
  | { type: "autofill"; key: string; value: string; values?: FormValues; requestId?: number }
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
   *
   * `requestId` echoes the request itself, and is what releases the webview's
   * hold on Save. It is a separate question from `value`: `value` says which
   * OPTION the payload describes (so a stale fill can be dropped), while the id
   * says which REQUEST has been answered (so a repeated key/value pair — the
   * same network typed, changed and retyped — cannot release a sibling request
   * that is still outstanding).
   */
  | { type: "fillFields"; key: string; value: string; values: Record<string, string>; requestId?: number }
  /**
   * One `autofill` request has been answered — with a fill, with nothing, or
   * with a failure. Posted for EVERY request, immediately after the
   * `fillFields` it accompanies when there is one.
   *
   * REVIEW FINDING (P1) — the webview disables Save while an autofill is in
   * flight, because a Save that beats the answer submits the values the answer
   * was about to replace (for the DHCP CIDR row: the previous network's pool,
   * with the typed network discarded, since `cidr` is never written as a
   * setting). `fillFields` cannot release it: a derivation that fills nothing
   * — a /32, a network that describes no pool — answers `undefined`, no
   * `fillFields` is posted, and Save would stay disabled until the form was
   * reopened. Hence a terminator that is unconditional rather than a payload
   * that is not.
   *
   * `requestId` echoes the request this terminates; it, and not the key/value
   * pair, is what the webview matches against its pending list.
   */
  | { type: "autofillSettled"; key: string; value: string; requestId?: number };
