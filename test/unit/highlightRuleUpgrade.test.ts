import { readFileSync } from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

import {
  DEFAULT_HIGHLIGHT_RULE_CATALOG,
  FORMER_DEFAULT_PATTERNS,
  upgradeHighlightRules
} from "../../src/utils/highlightRuleUpgrade";
import type { HighlightRule } from "../../src/utils/highlightRuleValidation";

const packageJsonPath = path.resolve(__dirname, "..", "..", "package.json");
const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
  contributes: { configuration?: { properties?: Record<string, any> } };
};
const shippedDefaults = (packageJson.contributes.configuration?.properties?.[
  "nexus.terminal.highlighting.rules"
].default ?? []) as HighlightRule[];

const CURRENT_IPV6 = shippedDefaults.find((rule) => rule.label === "IPv6 addresses")!;

/**
 * Historical IPv6 default patterns, pinned as literals because they no longer
 * exist anywhere in the tree — they only survive in users' saved settings.
 *
 * v1 shipped from the feature's introduction through v2.8.179; v2 (v1 plus the
 * trailing-`::` alternative) shipped v2.8.180 – v2.8.186.
 */
const IPV6_V1 =
  "\\b[0-9a-fA-F]{1,4}(?::[0-9a-fA-F]{1,4}){7}\\b|\\b(?:[0-9a-fA-F]{1,4}:){1,7}:[0-9a-fA-F]{1,4}\\b|::(?:[0-9a-fA-F]{1,4}:)*[0-9a-fA-F]{1,4}\\b";
const IPV6_V2 = `${IPV6_V1}|\\b(?:[0-9a-fA-F]{1,4}:){1,7}:(?!:)`;

describe("DEFAULT_HIGHLIGHT_RULE_CATALOG", () => {
  // ⊘ Catalog skew: the catalog is a pinned copy of package.json's defaults, so
  // any edit to a default label/description/pattern that is not mirrored here
  // would silently stop the upgrade backfilling the shipped text.
  it("is byte-equal to the shipped defaults (pattern, label, description, styling) in order", () => {
    expect(DEFAULT_HIGHLIGHT_RULE_CATALOG).toHaveLength(22);
    expect(DEFAULT_HIGHLIGHT_RULE_CATALOG).toHaveLength(shippedDefaults.length);
    expect(DEFAULT_HIGHLIGHT_RULE_CATALOG.map((entry) => ({ ...entry }))).toEqual(
      shippedDefaults.map((rule) => ({
        pattern: rule.pattern,
        label: rule.label,
        description: rule.description,
        // Styling is carried so the description backfill can tell whether the
        // shipped text still describes the rule the user is looking at; it
        // skews just as easily as the text, so it is pinned the same way.
        color: rule.color,
        bold: rule.bold,
        underline: rule.underline
      }))
    );
  });

  it("maps both historical IPv6 patterns onto the currently shipped one", () => {
    expect(FORMER_DEFAULT_PATTERNS[IPV6_V1]).toBe(CURRENT_IPV6.pattern);
    expect(FORMER_DEFAULT_PATTERNS[IPV6_V2]).toBe(CURRENT_IPV6.pattern);
    // No stale self-mapping: the current pattern is not itself a "former" one.
    expect(FORMER_DEFAULT_PATTERNS[CURRENT_IPV6.pattern]).toBeUndefined();
  });
});

describe("upgradeHighlightRules", () => {
  it("rewrites the v1 IPv6 pattern to the canonical one and backfills its text", () => {
    const stale: HighlightRule[] = [{ pattern: IPV6_V1, color: "magenta", flags: "g", enabled: false }];
    const result = upgradeHighlightRules(stale);

    expect(result.changed).toBe(true);
    expect(result.rules).toHaveLength(1);
    expect(result.rules[0].pattern).toBe(CURRENT_IPV6.pattern);
    expect(result.rules[0].label).toBe("IPv6 addresses");
    expect(result.rules[0].description).toBe(CURRENT_IPV6.description);
  });

  it("rewrites the v2 IPv6 pattern to the canonical one", () => {
    const stale: HighlightRule[] = [{ pattern: IPV6_V2, color: "magenta", flags: "g", enabled: false }];
    const result = upgradeHighlightRules(stale);

    expect(result.changed).toBe(true);
    expect(result.rules[0].pattern).toBe(CURRENT_IPV6.pattern);
  });

  it("never touches color, flags, bold, underline or enabled while upgrading", () => {
    const stale: HighlightRule[] = [
      { pattern: IPV6_V2, color: "brightGreen", flags: "gi", bold: true, underline: true, enabled: true }
    ];
    const result = upgradeHighlightRules(stale);

    expect(result.rules[0]).toMatchObject({
      color: "brightGreen",
      flags: "gi",
      bold: true,
      underline: true,
      enabled: true
    });
  });

  it("keeps a user-disabled IPv6 rule disabled after the pattern rewrite", () => {
    const result = upgradeHighlightRules([{ pattern: IPV6_V1, color: "magenta", enabled: false }]);
    expect(result.rules[0].enabled).toBe(false);
  });

  it("backfills label and description on an untouched default rule that has neither", () => {
    // Shipped styling for the Errors rule: red + bold.
    const stale: HighlightRule[] = [{ pattern: "\\bERR(?:OR)?\\b", color: "red", flags: "gi", bold: true }];
    const result = upgradeHighlightRules(stale);

    expect(result.changed).toBe(true);
    expect(result.rules[0].label).toBe("Errors");
    expect(result.rules[0].description).toBe("ERR / ERROR — general error keyword, bold red.");
  });

  it("treats an empty-string label/description as absent", () => {
    const stale: HighlightRule[] = [
      { pattern: "\\bERR(?:OR)?\\b", color: "red", bold: true, label: "", description: "" }
    ];
    const result = upgradeHighlightRules(stale);

    expect(result.changed).toBe(true);
    expect(result.rules[0].label).toBe("Errors");
    expect(result.rules[0].description).toBe("ERR / ERROR — general error keyword, bold red.");
  });

  /**
   * The shipped descriptions describe APPEARANCE as well as meaning ("…, bold
   * red."). Backfilling one onto a rule the user restyled would put a sentence
   * in the editor that contradicts the swatch next to it — a blank description
   * at least does not lie. The label is identity, not appearance, so it is
   * backfilled either way.
   */
  describe("description backfill is gated on the rule still looking like the default", () => {
    // ⊘ Discriminator against backfilling description unconditionally.
    it("gives a recoloured default rule its label but NOT the shipped description", () => {
      const stale: HighlightRule[] = [{ pattern: "\\bERR(?:OR)?\\b", color: "cyan", bold: true }];
      const result = upgradeHighlightRules(stale);

      expect(result.changed).toBe(true);
      expect(result.rules[0].label).toBe("Errors");
      expect(result.rules[0].description).toBeUndefined();
      expect(result.rules[0].color).toBe("cyan");
    });

    it("treats a dropped bold as a styling change (absent counts as false)", () => {
      const stale: HighlightRule[] = [{ pattern: "\\bERR(?:OR)?\\b", color: "red" }];
      const result = upgradeHighlightRules(stale);

      expect(result.rules[0].label).toBe("Errors");
      expect(result.rules[0].description).toBeUndefined();
    });

    it("counts an explicit bold:false as equal to the default's absent bold", () => {
      // ⊘ Fails against a strict `rule.bold === known.bold` comparison: the
      // editor writes the field out explicitly, package.json omits it, and the
      // two mean the same thing.
      const stale: HighlightRule[] = [
        { pattern: "\\bNOTICE\\b", color: "cyan", bold: false, underline: false }
      ];
      const result = upgradeHighlightRules(stale);

      expect(result.rules[0].label).toBe("Notices");
      expect(result.rules[0].description).toBe(
        "NOTICE — informational-but-notable log keyword, cyan."
      );
    });

    it("gates on underline too", () => {
      const stale: HighlightRule[] = [{ pattern: "https?://\\S+", color: "blue" }];
      const result = upgradeHighlightRules(stale);

      expect(result.rules[0].label).toBe("URLs");
      expect(result.rules[0].description).toBeUndefined();
    });
  });

  // ⊘ An implementation that unconditionally assigns the catalog text would
  // wipe the names users typed in the Highlighting Rules editor.
  it("never overwrites a non-empty user label or description", () => {
    const stale: HighlightRule[] = [
      { pattern: "\\bERR(?:OR)?\\b", color: "red", label: "My errors", description: "Mine." }
    ];
    const result = upgradeHighlightRules(stale);

    expect(result.changed).toBe(false);
    expect(result.rules[0].label).toBe("My errors");
    expect(result.rules[0].description).toBe("Mine.");
  });

  it("backfills only the missing half when the user named the rule but wrote no description", () => {
    const stale: HighlightRule[] = [
      { pattern: "\\bERR(?:OR)?\\b", color: "red", bold: true, label: "My errors" }
    ];
    const result = upgradeHighlightRules(stale);

    expect(result.changed).toBe(true);
    expect(result.rules[0].label).toBe("My errors");
    expect(result.rules[0].description).toBe("ERR / ERROR — general error keyword, bold red.");
  });

  // ⊘ Indexing FORMER_DEFAULT_PATTERNS as a plain object returns an inherited
  // Object.prototype member for keys like "constructor" — read as "this is a
  // former default", it would overwrite the user's pattern with a function.
  it("leaves a rule whose pattern collides with an Object.prototype key alone", () => {
    const mine: HighlightRule = { pattern: "constructor", color: "cyan" };
    const result = upgradeHighlightRules([mine]);

    expect(result.changed).toBe(false);
    expect(result.rules[0]).toBe(mine);
    expect(result.rules[0].pattern).toBe("constructor");
  });

  it("leaves unknown user rules untouched, by reference", () => {
    const mine: HighlightRule = { pattern: "\\bDEPLOYING\\b", color: "cyan", flags: "gi" };
    const stale: HighlightRule[] = [{ pattern: IPV6_V1, color: "magenta", enabled: false }, mine];
    const result = upgradeHighlightRules(stale);

    expect(result.changed).toBe(true);
    expect(result.rules).toHaveLength(2);
    expect(result.rules[1]).toBe(mine);
    expect(result.rules[1]).toEqual({ pattern: "\\bDEPLOYING\\b", color: "cyan", flags: "gi" });
  });

  it("never adds or removes rules — a snapshot without IPv6/UUID keeps them deleted", () => {
    const stale: HighlightRule[] = [
      { pattern: "\\bERR(?:OR)?\\b", color: "red" },
      { pattern: "\\bWARN(?:ING)?\\b", color: "yellow" }
    ];
    const result = upgradeHighlightRules(stale);

    expect(result.rules).toHaveLength(2);
    expect(result.rules.map((rule) => rule.pattern)).toEqual([
      "\\bERR(?:OR)?\\b",
      "\\bWARN(?:ING)?\\b"
    ]);
  });

  // ⊘ An implementation that always clones would report a write-worthy change
  // on every activation, rewriting settings.json forever.
  it("returns changed:false AND the same array reference when there is nothing to do", () => {
    const current: HighlightRule[] = shippedDefaults.map((rule) => ({ ...rule }));
    const result = upgradeHighlightRules(current);

    expect(result.changed).toBe(false);
    expect(result.rules).toBe(current);
  });

  it("no-ops on an empty array", () => {
    const empty: HighlightRule[] = [];
    const result = upgradeHighlightRules(empty);
    expect(result.changed).toBe(false);
    expect(result.rules).toBe(empty);
  });

  it("is idempotent — a second pass reports no further change", () => {
    const first = upgradeHighlightRules([{ pattern: IPV6_V1, color: "magenta", enabled: false }]);
    const second = upgradeHighlightRules(first.rules);
    expect(second.changed).toBe(false);
    expect(second.rules).toBe(first.rules);
  });
});
