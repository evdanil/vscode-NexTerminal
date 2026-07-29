/**
 * Pure scan/substitute/validate helpers for macro variables (prompted input
 * substitution). No `vscode` import — directly unit-testable, and safe to run
 * unmodified inside the macro editor's webview (see `macroVariablesWebviewJs()`
 * below), which must never re-implement this scan (docs/plans/2026-07-29-macro-variables.md §9.3).
 *
 * See docs/plans/2026-07-29-macro-variables.md §5 for the full syntax table and
 * rationale — this file implements §5.2 (substitution algorithm) and §5.3
 * (which variables get prompted) exactly as specified there.
 */
import { serializeForInlineScript } from "../ui/shared/inlineScriptData";
import type { MacroVariable, TerminalMacro } from "../models/terminalMacro";

/** `${name}` — /^[A-Za-z_][A-Za-z0-9_]{0,31}$/ (max 32 chars total). */
export const MACRO_VARIABLE_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,31}$/;

export const MAX_MACRO_VARIABLES = 10;

/**
 * `\$(\$?)(?:\{(name)\}|(name))` — group 1 is the optional escape `$`, group 2
 * the braced name, group 3 the bare name. Linear, no nested quantifiers, safe on
 * large (64 KiB) inputs. Kept as a source string (not a compiled RegExp) so the
 * exact same pattern can be embedded, byte-for-byte, into the webview JS export.
 */
export const MACRO_PLACEHOLDER_SOURCE = String.raw`\$(\$?)(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))`;

function placeholderRegex(): RegExp {
  // Fresh instance per call — never share a single RegExp's `lastIndex` across calls.
  return new RegExp(MACRO_PLACEHOLDER_SOURCE, "g");
}

export function isValidVariableName(name: unknown): name is string {
  return typeof name === "string" && MACRO_VARIABLE_NAME_PATTERN.test(name);
}

export interface PlaceholderScan {
  /** Declared names whose placeholder actually appears, unescaped, in the text — in declaration order. */
  used: string[];
  /** Names referenced, unescaped, that are NOT declared — in first-appearance order. */
  undeclared: string[];
}

/**
 * Scans `text` for `$name` / `${name}` placeholders against `declaredNames` (§5.3).
 *
 * Escaped occurrences (`$$name` / `$${name}`) never count as a "use" — of a declared
 * name (that's the escape, §5.1) or an undeclared one (still just passed through,
 * §5 table) — so `$${host}` as the only occurrence produces zero entries in `used`.
 */
export function scanPlaceholders(text: string, declaredNames: readonly string[]): PlaceholderScan {
  const declared = new Set(declaredNames);
  const usedSet = new Set<string>();
  const undeclared: string[] = [];
  const seenUndeclared = new Set<string>();

  const re = placeholderRegex();
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    const escaped = match[1] === "$";
    if (escaped) continue;
    const name = match[2] ?? match[3];
    if (declared.has(name)) {
      usedSet.add(name);
    } else if (!seenUndeclared.has(name)) {
      seenUndeclared.add(name);
      undeclared.push(name);
    }
  }

  const used = declaredNames.filter((name) => usedSet.has(name));
  return { used, undeclared };
}

/**
 * §5.2 substitution algorithm, implemented EXACTLY as specified — this is
 * security-relevant, not a style choice:
 *
 *   name = braced ?? bare;  escaped = matched "$$"
 *   if name is NOT declared     → push the matched text verbatim   (always, escaped or not)
 *   else if escaped             → push the match minus one leading "$"
 *   else                        → push values[name]
 *
 * Builds the output by APPENDING TO AN ARRAY and joining — never `text.replace(re, value)`.
 * In string-replacement mode, JavaScript interprets `$&`, `` $` ``, `$'`, `$1`, `$$`
 * *inside the replacement value itself*; a password of ``pa$`word`` under
 * `String.replace` would splice arbitrary preceding text into the output. Array-append
 * treats every entered value as an opaque, never-rescanned, never-reinterpreted string.
 *
 * `declaredNames` is DELIBERATELY separate from the keys of `values`: "declared" and
 * "has an entered value" are different sets. Only placeholders that actually appear
 * unescaped get prompted (§5.3), so a name whose sole occurrence is `$${name}` is
 * declared but valueless — and it is exactly that name whose escape must still be
 * honoured. Deriving declaredness from `values` collapses the two and leaves `$$` on
 * the wire where the syntax table promises `$`. Omitting the argument falls back to
 * the keys of `values`, which is correct whenever every declared name was prompted.
 */
export function substituteMacroVariables(
  text: string,
  values: Readonly<Record<string, string>>,
  declaredNames?: readonly string[]
): string {
  // A Set, not an object map: `__proto__`, `constructor` and `toString` are all
  // valid variable names under MACRO_VARIABLE_NAME_PATTERN.
  const declared = declaredNames !== undefined ? new Set(declaredNames) : new Set(Object.keys(values));

  const out: string[] = [];
  let lastIndex = 0;

  const re = placeholderRegex();
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    const full = match[0];
    const escaped = match[1] === "$";
    const name = match[2] ?? match[3];

    out.push(text.slice(lastIndex, match.index));

    if (!declared.has(name)) {
      out.push(full); // not declared — always verbatim, escaped or not
    } else if (escaped) {
      out.push(full.slice(1)); // declared escape — un-escape by dropping one leading "$"
    } else if (Object.prototype.hasOwnProperty.call(values, name)) {
      out.push(values[name]); // entered value — never rescanned, never a replacement pattern
    } else {
      out.push(full); // declared but never prompted (no unescaped use) — leave it alone
    }

    lastIndex = match.index + full.length;
  }
  out.push(text.slice(lastIndex));

  return out.join("");
}

/**
 * §4.2 — `variables` is untrusted at every read site: `nexus.terminal.macros`
 * legacy absorption persists entries verbatim, so a corrupt shape (`"abc"`,
 * `{ length: 5 }`) can reach the store. Every read site must use
 * `Array.isArray(macro.variables) && macro.variables.length > 0` — not `?.length`,
 * which a non-array truthy-`.length` value would satisfy.
 */
export function hasMacroVariables(macro: Pick<TerminalMacro, "variables">): boolean {
  return Array.isArray(macro.variables) && macro.variables.length > 0;
}

/**
 * Narrows one raw entry to a usable `MacroVariable`, dropping fields whose type is
 * wrong rather than trusting them.
 *
 * Every field is checked, not just `name`. The macro editor renders `label` and
 * `default` straight into HTML via `escapeHtml`, which calls `.replaceAll` on its
 * argument — a numeric `label` would throw inside `renderMacroEditorHtml`, leaving
 * `panel.webview.html` unassigned and the Macro Editor permanently blank, including
 * for the user trying to open it to delete the bad entry.
 *
 * That is reachable: `VscodeMacroStore.absorbLegacySettingsIfPresent()` persists
 * `nexus.terminal.macros` entries verbatim on every activation, Settings Sync replay
 * included, without passing them through `sanitizeImportedMacro` (§4.2).
 */
function toValidMacroVariable(entry: unknown): MacroVariable | undefined {
  if (!entry || typeof entry !== "object") return undefined;
  const raw = entry as Record<string, unknown>;
  if (!isValidVariableName(raw.name)) return undefined;

  const variable: MacroVariable = { name: raw.name };
  if (typeof raw.label === "string") variable.label = raw.label;
  if (raw.secret === true) variable.secret = true;
  // `default` and `remember` are meaningless on a masked variable and are dropped
  // here too, matching what `sanitizeImportedMacroVariables` does on the import path.
  if (!variable.secret) {
    if (typeof raw.default === "string") variable.default = raw.default;
    if (raw.remember === false) variable.remember = false;
  }
  return variable;
}

/**
 * The `variables` array filtered down to entries usable at runtime (valid name).
 * Returns `[]` for anything failing the §4.2 shape guard (non-array, empty, or
 * every entry malformed) — callers must not treat an empty result as "no
 * declaration existed" when deciding auto-trigger eligibility; use
 * `hasMacroVariables()` for that (§6.1 uses the raw shape check, not this filter).
 */
export function getValidMacroVariables(macro: Pick<TerminalMacro, "variables">): MacroVariable[] {
  if (!hasMacroVariables(macro)) return [];
  const out: MacroVariable[] = [];
  const seen = new Set<string>();
  for (const entry of macro.variables as unknown[]) {
    const variable = toValidMacroVariable(entry);
    // Deduped by name: the editor and the import sanitizer both reject duplicates,
    // but legacy settings absorption does not — and a duplicate would otherwise be
    // prompted for twice ("1 of 2", "2 of 2", same question) with only the second
    // answer surviving into the substitution map.
    if (!variable || seen.has(variable.name)) continue;
    seen.add(variable.name);
    out.push(variable);
  }
  return out;
}

/**
 * Returns a copy of `macro` whose `variables` have been normalized to the storable /
 * shareable shape — invalid entries dropped, duplicates collapsed, and `default` /
 * `remember` stripped from masked entries. The key is removed entirely when nothing
 * survives.
 *
 * Needed because `getValidMacroVariables()` only protects *read* sites, and not every
 * consumer of a macro is a read site: `Copy All as JSON`, share export, and legacy
 * settings absorption all pass `macro.variables` through verbatim. A masked variable
 * carrying a plaintext `default` — which the editor blocks but a hand-written
 * settings.json or share file does not — would otherwise reach globalState, the
 * clipboard, and an exported share file, even though the runtime never uses it.
 */
export function withSanitizedVariables<T extends Pick<TerminalMacro, "variables">>(macro: T): T {
  if (!hasMacroVariables(macro)) {
    if (macro.variables === undefined) return macro;
    const stripped = { ...macro };
    delete stripped.variables;
    return stripped;
  }
  const variables = getValidMacroVariables(macro);
  const out = { ...macro };
  if (variables.length > 0) out.variables = variables;
  else delete out.variables;
  return out;
}

export interface MacroVariableValidationError {
  /** Row index into the (pre-filter) variables array; undefined for array-level issues. */
  index?: number;
  message: string;
}

/**
 * §9.4 editor validation rules, as a reusable pure helper (host-side enforcement
 * happens in macroEditorPanel.ts; this is the shared logic so it can't drift from
 * the webview's client-side pre-check). Returns an empty array when `variables`
 * is valid and, if `triggerPattern` is supplied, does not conflict with it.
 */
export function validateMacroVariables(
  variables: MacroVariable[],
  options: { triggerPattern?: string } = {}
): MacroVariableValidationError[] {
  const errors: MacroVariableValidationError[] = [];

  if (variables.length > MAX_MACRO_VARIABLES) {
    errors.push({ message: `A macro may declare at most ${MAX_MACRO_VARIABLES} variables.` });
  }

  const seen = new Set<string>();
  variables.forEach((variable, index) => {
    if (!isValidVariableName(variable.name)) {
      errors.push({ index, message: `"${variable.name}" is not a valid variable name.` });
    } else if (seen.has(variable.name)) {
      errors.push({ index, message: `Duplicate variable name "${variable.name}".` });
    } else {
      seen.add(variable.name);
    }

    if (variable.secret && typeof variable.default === "string" && variable.default.length > 0) {
      errors.push({ index, message: `"${variable.name}" is masked and cannot have a default value.` });
    }
  });

  if (variables.length > 0 && options.triggerPattern) {
    errors.push({
      message:
        "A macro can prompt for input or auto-trigger, not both. For prompts on an automated flow, use a Script with prompt()."
    });
  }

  return errors;
}

/**
 * Webview-JS twin of `isValidVariableName()` + `scanPlaceholders()`, following the
 * `regexSafetyWebviewJs()` precedent (src/utils/regexSafety.ts) — inlined into the
 * macro editor's `<script>` so the live diagnostics (§9.3) can never drift from the
 * authoritative TypeScript implementation above.
 */
export function macroVariablesWebviewJs(): string {
  return `
      function isValidVariableName(name) {
        var namePattern = new RegExp(${serializeForInlineScript(MACRO_VARIABLE_NAME_PATTERN.source)});
        return typeof name === "string" && namePattern.test(name);
      }
      function scanMacroPlaceholders(text, declaredNames) {
        // Object.create(null) — a plain {} would report "$toString" / "$constructor"
        // as declared-and-used via the prototype chain, drifting from the Set-based
        // TypeScript scan above. Variable names may legitimately be "constructor".
        var declared = Object.create(null);
        for (var i = 0; i < declaredNames.length; i++) declared[declaredNames[i]] = true;
        var usedSet = Object.create(null);
        var undeclared = [];
        var seenUndeclared = Object.create(null);
        var re = new RegExp(${serializeForInlineScript(MACRO_PLACEHOLDER_SOURCE)}, "g");
        var match;
        while ((match = re.exec(text)) !== null) {
          var escaped = match[1] === "$";
          var name = match[2] !== undefined ? match[2] : match[3];
          if (escaped) continue;
          if (declared[name]) {
            usedSet[name] = true;
          } else if (!seenUndeclared[name]) {
            seenUndeclared[name] = true;
            undeclared.push(name);
          }
        }
        var used = declaredNames.filter(function (name) { return usedSet[name]; });
        return { used: used, undeclared: undeclared };
      }
`;
}
