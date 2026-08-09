/**
 * Pure decision core for a filterable custom-select's filter + Enter model.
 *
 * The live control runs this same logic INLINE inside `baseWebviewJs()`
 * (`webviewScripts.ts`), where it is wired to the DOM — the form-script harness
 * stubs `initCustomSelects`, so no test executes that string. This module lifts
 * the two decisions §A depends on out of the DOM so they can be unit-tested for
 * real:
 *   - `computeFilterableSelectState` — given the option list and the current
 *     filter query, which options are visible, which one carries the transient
 *     keyboard highlight, and whether the "No matches" row shows.
 *   - `enterSelectionValue` — the value a bare Enter commits, or `null` when
 *     Enter is inert.
 *
 * The §A guarantee falls straight out of `highlightIndex`: the highlight is only
 * ever the FIRST REAL match of a non-empty query. An empty query or a zero-match
 * typo yields `-1`, so Enter (which follows the highlight and nothing else) is
 * inert and can NEVER land on the `(None)` / `__create__` sentinels without an
 * explicit ArrowDown-to-highlight or a click. Keep this file and the inline
 * `applyFilter` / Enter handler in `webviewScripts.ts` in lockstep; the DOM
 * wiring (display toggling, scrollIntoView, event dispatch) is the part that
 * stays DOM-only and is smoke-checked by string assertions in the tests.
 */

export interface FilterableOption {
  /** The option's `data-value`; `""` is the (None) sentinel, `__create__*` the create affordance. */
  value: string;
  /** The option's full visible text (label + description) — what the query matches against. */
  text: string;
}

export interface FilterableSelectState {
  /** Per-option visibility, index-aligned to the input options. */
  visible: boolean[];
  /** Index of the highlighted option, or `-1` when nothing is highlighted. */
  highlightIndex: number;
  /** Whether the "No matches" row should be shown. */
  showNoMatches: boolean;
}

export function isCreateOptionValue(value: string): boolean {
  return value.indexOf("__create__") === 0;
}

/**
 * A "real" option is one the user can pick as an actual value: not the
 * empty-value (None) sentinel, not the `__create__` affordance. Highlighting and
 * "No matches" both reckon over these alone.
 */
export function isRealOptionValue(value: string): boolean {
  return value !== "" && !isCreateOptionValue(value);
}

export function computeFilterableSelectState(
  options: FilterableOption[],
  query: string
): FilterableSelectState {
  const q = (query || "").trim().toLowerCase();
  const hasCreateOption = options.some((opt) => isCreateOptionValue(opt.value));
  const visible: boolean[] = new Array(options.length);
  let realVisible = 0;
  let highlightIndex = -1;
  for (let i = 0; i < options.length; i++) {
    const opt = options[i];
    // Match against the option's full text — label AND description.
    const match = !q || opt.text.toLowerCase().indexOf(q) !== -1;
    // The `__create__` affordance is ALWAYS visible while filtering — the
    // "nothing matched, make one" escape hatch — and (None) filters like any
    // other option.
    const show = isCreateOptionValue(opt.value) ? true : match;
    visible[i] = show;
    if (show && isRealOptionValue(opt.value)) {
      realVisible++;
      // Auto-highlight the FIRST real match, but only while a query is active.
      // An empty query leaves highlightIndex at -1 (plain dropdown, no transient
      // highlight), matching the client's clearHighlight().
      if (q && highlightIndex === -1) {
        highlightIndex = i;
      }
    }
  }
  // "No matches" is only meaningful when there is no create affordance to fall
  // back on; when a create option is present it stays visible and speaks for the
  // empty result itself.
  const showNoMatches = realVisible === 0 && !hasCreateOption;
  return { visible, highlightIndex, showNoMatches };
}

/**
 * The option value a bare Enter selects for a given filter state, or `null` when
 * Enter is inert. This is the whole §A model in one line: Enter follows the
 * highlight, and the highlight is only ever a real option.
 */
export function enterSelectionValue(
  options: FilterableOption[],
  state: FilterableSelectState
): string | null {
  if (state.highlightIndex < 0 || state.highlightIndex >= options.length) {
    return null;
  }
  return options[state.highlightIndex].value;
}
