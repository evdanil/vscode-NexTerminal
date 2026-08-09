import { proxyConfigsEqual } from "../../models/config";
import type { DeviceTemplateProfile } from "../../models/deviceTemplate";
import type { InventorySourceConfig, TemplateRule } from "../../models/inventory";
import {
  describeFilterConditions,
  filterLabel,
  filterSpecificity,
  parseTemplateFilter,
  TEMPLATE_FIELD_SHORT_LABELS,
  unknownFilterKeys,
  type TemplatableField
} from "./templateApply";

/**
 * DEVICE TEMPLATES (issue #48 PR-T2, §7.2) — the PURE view/validation logic behind
 * the "Edit Template Rules…" QuickPick flow. Kept `vscode`-free (like every other
 * inventory service module) so the three-slot list rows, the InputBox live
 * feedback severities, and the save-time possible-overlap warnings are unit-tested
 * directly rather than through a mocked QuickPick. The command shell in
 * `commands/` is the thin orchestrator over these.
 */

/** The five templatable fields, alphabetically by short label — the order §7.2's `Sets:` detail shows. */
const FIELDS_BY_LABEL: TemplatableField[] = (["proxy", "authProfileId", "multiplexing", "legacyAlgorithms", "logSession"] as TemplatableField[]).sort(
  (a, b) => TEMPLATE_FIELD_SHORT_LABELS[a].localeCompare(TEMPLATE_FIELD_SHORT_LABELS[b])
);

/** The templatable fields a template sets, as their shared short labels ("Auth Profile, Proxy"). */
export function templateSetsLabels(template: DeviceTemplateProfile): string[] {
  return FIELDS_BY_LABEL.filter((f) => template.fields[f] !== undefined).map((f) => TEMPLATE_FIELD_SHORT_LABELS[f]);
}

/** One three-slot QuickPick row (UX-S1) for a rule, or the implicit floor row (UX-S4). */
export interface RuleListItem {
  /** The filter, or "(all devices)" for a catch-all / "(all devices — source default)" for the floor. */
  label: string;
  /** "→ <template name>" (or the source auth profile for the floor row). */
  description: string;
  /** "Specificity N  •  Sets: …" (or the floor's fill/overridden note). */
  detail: string;
  /** Present for a real rule row; absent for the implicit floor row. */
  ruleId?: string;
  /** True for the implicit source-default floor row, which routes to `editSource` (UX-S4). */
  floor?: boolean;
}

/**
 * §7.2 (UX-S1/S4) — the rule list rows, sorted by specificity DESCENDING, plus the
 * actionable implicit floor row when the source carries a source-level auth
 * profile. A rule whose template no longer resolves still shows (with a "(missing
 * template)" description) so it can be removed. `authProfileName` resolves the
 * source's auth profile id to its display name for the floor row.
 */
export function buildRuleListItems(
  source: Pick<InventorySourceConfig, "authProfileId">,
  rules: readonly TemplateRule[],
  templatesById: Map<string, DeviceTemplateProfile> | undefined,
  authProfileName: (id: string) => string | undefined
): RuleListItem[] {
  const items: RuleListItem[] = rules
    .map((rule) => {
      const template = templatesById?.get(rule.templateId);
      const spec = filterSpecificity(rule.filter);
      const sets = template ? templateSetsLabels(template) : [];
      const setsPart = sets.length > 0 ? `Sets: ${sets.join(", ")}` : "Sets nothing";
      return {
        label: filterLabel(rule.filter),
        description: `→ ${template ? template.name : "(missing template)"}`,
        detail: `Specificity ${spec}  •  ${setsPart}`,
        ruleId: rule.id,
        _spec: spec
      };
    })
    .sort((a, b) => b._spec - a._spec || a.label.localeCompare(b.label))
    .map(({ _spec, ...item }) => item);

  if (source.authProfileId !== undefined) {
    const name = authProfileName(source.authProfileId) ?? "(unknown)";
    // UX-S4 — actionable floor row: the source-level auth profile read as the
    // implicit catch-all fill rule, sitting below every explicit rule; selecting
    // it routes to `editSource` (where that field lives), never a no-op.
    items.push({
      label: "(all devices — source default)",
      description: `→ auth profile "${name}"`,
      detail: "Fill • Overridden by any rule that sets Auth Profile",
      floor: true
    });
  }
  return items;
}

export type FilterFeedbackSeverity = "info" | "warning";

/** §7.2 (UX-S2) live InputBox feedback: severity + message, and whether SAVE is blocked. */
export interface FilterFeedback {
  severity: FilterFeedbackSeverity;
  message: string;
  /** True only for empty values (§2.3) — the sole BLOCKING condition. */
  blocking: boolean;
}

/**
 * §7.2 (UX-S2) — the live, per-keystroke feedback for the filter InputBox.
 * Precedence: empty-value (blocking warning, §2.3 m9c) → unknown key (warning,
 * §2.2) → catch-all / `name=*` note (info, §2.3 m9b) → the plain "Matches devices
 * where … — specificity N" description (info, §2.3). `attributeKeys` is the
 * provider's declared list; undefined ⇒ no unknown-key check.
 */
export function filterFeedback(filterInput: string, attributeKeys: readonly string[] | undefined): FilterFeedback {
  const parsed = parseTemplateFilter(filterInput);
  if (parsed.emptyValueKeys.length > 0) {
    const keys = parsed.emptyValueKeys.map((k) => `${k}=`).join(", ");
    return {
      severity: "warning",
      message: `A filter value is empty (${keys}) — a condition with no value can never match. Remove it or give it a value.`,
      blocking: true
    };
  }
  const unknown = unknownFilterKeys(parsed, attributeKeys);
  if (unknown.length > 0) {
    const known = (attributeKeys ?? []).join(", ");
    return {
      severity: "warning",
      message: `Key '${unknown[0]}' is not one this source's provider reports — this rule will never match. Known keys: ${known}`,
      blocking: false
    };
  }
  if (parsed.specificity === 0) {
    // P2 (PR-T2 review) — the `name=*` note is claimed ONLY for an actual name
    // glob. A filter with zero PARSED conditions (`""`, `&`, `=x`) carries no
    // `name=*` at all, so it is a genuine catch-all; only a filter whose sole
    // remaining condition is a match-everything `name` glob gets the name=* note
    // (the old `trim() === ""` test mis-labelled every degenerate input as name=*).
    if (parsed.conditions.size === 0) {
      return { severity: "info", message: "Matches every device (catch-all).", blocking: false };
    }
    return { severity: "info", message: "`name=*` matches every device — it adds no specificity.", blocking: false };
  }
  return {
    severity: "info",
    message: `Matches devices where ${describeFilterConditions(parsed)} — specificity ${parsed.specificity}`,
    blocking: false
  };
}

/** Do two templates carry an identical `{mode, value}` for one field (the m9d/save suppression basis)? */
function fieldIdentical(a: DeviceTemplateProfile, b: DeviceTemplateProfile, field: TemplatableField): boolean {
  const fa = a.fields[field];
  const fb = b.fields[field];
  if (fa === undefined || fb === undefined) {
    return false;
  }
  if (fa.mode !== fb.mode) {
    return false;
  }
  if (field === "proxy") {
    return proxyConfigsEqual(a.fields.proxy!.value, b.fields.proxy!.value);
  }
  return (fa.value as unknown) === (fb.value as unknown);
}

/**
 * §3.3.1 rev8 (fixture 20d) — the SAVE-TIME possible-overlap warnings. The
 * disjointness proof is DROPPED (unsound against set-valued name+slug attributes):
 * warn on EVERY pair of rules at EQUAL specificity whose templates both set a
 * shared field with DIFFERING `{mode, value}`. The one sound suppression, decidable
 * from the templates alone: if every shared field carries an IDENTICAL `{mode,
 * value}` in both templates, the tie is unobservable and no warning fires. The
 * copy is CONDITIONAL ("if a device matches both…") — it never asserts overlap,
 * only what happens if one occurs. Non-blocking.
 */
export function saveOverlapWarnings(
  rules: readonly TemplateRule[],
  templatesById: Map<string, DeviceTemplateProfile> | undefined
): string[] {
  const warnings: string[] = [];
  const resolved = rules
    .map((rule) => ({ rule, template: templatesById?.get(rule.templateId), spec: filterSpecificity(rule.filter) }))
    .filter((r): r is { rule: TemplateRule; template: DeviceTemplateProfile; spec: number } => r.template !== undefined);
  for (let i = 0; i < resolved.length; i++) {
    for (let j = i + 1; j < resolved.length; j++) {
      const a = resolved[i];
      const b = resolved[j];
      if (a.spec !== b.spec) {
        continue; // unequal specificity can never tie (fixture 20d(e))
      }
      const shared = FIELDS_BY_LABEL.filter((f) => a.template.fields[f] !== undefined && b.template.fields[f] !== undefined);
      if (shared.length === 0) {
        continue; // no shared field (fixture 20d(e))
      }
      const differing = shared.filter((f) => !fieldIdentical(a.template, b.template, f));
      if (differing.length === 0) {
        continue; // every shared field identical → unobservable (fixture 20d(d))
      }
      warnings.push(
        // P3 (PR-T2 review) — name each rule's TEMPLATE so two identical filters
        // (`(all devices)` twice, or the same literal) are distinguishable.
        `Rules \`${filterLabel(a.rule.filter)}\` (→ "${a.template.name}") and \`${filterLabel(b.rule.filter)}\` (→ "${b.template.name}") ` +
          `have the same specificity and both set ${TEMPLATE_FIELD_SHORT_LABELS[differing[0]]}. ` +
          `If a device matches both, the winner is decided by a tie-break rather than by the order of these rules — make one more specific to choose deliberately.`
      );
    }
  }
  return warnings;
}
