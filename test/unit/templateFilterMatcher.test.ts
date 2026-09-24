import { describe, expect, it } from "vitest";
import {
  deviceMatchesFilter,
  describeFilterConditions,
  filterSpecificity,
  knownKeysList,
  parseTemplateFilter,
  unknownFilterKeys
} from "../../src/services/inventory/templateApply";
import type { InventoryDevice } from "../../src/models/inventory";
import { createBuiltInProviders } from "../../src/services/inventory/builtInProviders";

/**
 * DEVICE TEMPLATES (issue #48 PR-T2) — the pure matcher: parse (§2.3), specificity
 * (§3.1), and `deviceMatchesFilter` (§2.3). Fixture 20c's parse cases plus the
 * name-glob / set-valued / case-folding semantics, each built to fail against the
 * specific wrong implementation its comment names.
 */

function dev(overrides: Partial<InventoryDevice> = {}): InventoryDevice {
  return { externalId: "device:1", name: "core-sw-1", endpoints: [], ...overrides };
}

describe("parseTemplateFilter / filterSpecificity — §2.3 / §3.1 (fixture 20c)", () => {
  it("20c(a) — keys are case-folded, so `Role=switch&role=router` is ONE key with two OR values, specificity 1 (kills case-sensitive key handling)", () => {
    const parsed = parseTemplateFilter("Role=switch&role=router");
    expect([...parsed.conditions.keys()]).toEqual(["role"]);
    expect([...parsed.conditions.get("role")!].sort()).toEqual(["router", "switch"]);
    expect(parsed.specificity).toBe(1);
  });

  it("20c(b) — a filter of only `name=*` is zero conditions: catch-all at specificity 0 (kills a free rank boost from a match-everything glob)", () => {
    const parsed = parseTemplateFilter("name=*");
    expect(parsed.specificity).toBe(0);
    // ...but it still MATCHES every device (candidacy via deviceMatchesFilter).
    expect(deviceMatchesFilter(dev({ name: "anything" }), parsed)).toBe(true);
  });

  it("20c(b') — `name=*` combined with a real key keeps specificity from the real key only", () => {
    expect(filterSpecificity("name=*&role=switch")).toBe(1);
  });

  it("20c(c) — an empty value (`role=`) is surfaced in emptyValueKeys for the save layer, and can never match (kills storable dead conditions)", () => {
    const parsed = parseTemplateFilter("role=");
    expect(parsed.emptyValueKeys).toEqual(["role"]);
    expect(deviceMatchesFilter(dev({ attributes: { role: ["switch"] } }), parsed)).toBe(false);
  });

  it("20c(d) — filter key `tag` is aliased to the `tags` attribute (kills the tag/tags key mismatch, m10)", () => {
    const parsed = parseTemplateFilter("tag=core");
    expect([...parsed.conditions.keys()]).toEqual(["tags"]);
    expect(deviceMatchesFilter(dev({ attributes: { tags: ["core", "prod"] } }), parsed)).toBe(true);
  });

  it("distinct-key counting: `role=switch&role=router` is 1, `site=syd&tag=x` is 2 (kills counting conditions)", () => {
    expect(filterSpecificity("role=switch&role=router")).toBe(1);
    expect(filterSpecificity("site=syd&tag=x")).toBe(2);
  });

  it("Codex round 1 #3 — the normalized tie-break key encodes values, so a comma-bearing single value does NOT collide with two distinct values (kills the unescaped join that suppressed a real tie warning)", () => {
    // `role=a%2Cb` is ONE value "a,b"; `role=a&role=b` is two values "a","b".
    // With an unescaped comma join both become `role=a,b` and their tie is silently
    // rule-id-ordered instead of warned. Encoding the values keeps them distinct.
    const single = parseTemplateFilter("role=a%2Cb").normalized;
    const pair = parseTemplateFilter("role=a&role=b").normalized;
    expect(single).not.toBe(pair);
    // Genuinely identical filters still collide (dedup / same-filter suppression preserved).
    expect(parseTemplateFilter("role=a&role=b").normalized).toBe(parseTemplateFilter("role=b&role=a").normalized);
    expect(parseTemplateFilter("role=switch&site=syd").normalized).toBe(parseTemplateFilter("site=syd&role=switch").normalized);
  });

  it("catch-all (absent/empty/whitespace) is specificity 0 and matches everything", () => {
    for (const f of [undefined, "", "   "]) {
      const parsed = parseTemplateFilter(f);
      expect(parsed.specificity).toBe(0);
      expect(deviceMatchesFilter(dev(), parsed)).toBe(true);
    }
  });
});

describe("deviceMatchesFilter — §2.3 semantics", () => {
  it("set-valued attribute matches if ANY element matches — name OR slug (kills single-vocabulary matching)", () => {
    const d = dev({ attributes: { site: ["Sydney", "syd"] } });
    expect(deviceMatchesFilter(d, parseTemplateFilter("site=syd"))).toBe(true); // slug
    expect(deviceMatchesFilter(d, parseTemplateFilter("site=Sydney"))).toBe(true); // display name
    expect(deviceMatchesFilter(d, parseTemplateFilter("site=melbourne"))).toBe(false);
  });

  it("value comparison is case-insensitive and trimmed", () => {
    const d = dev({ attributes: { role: ["Switch"] } });
    expect(deviceMatchesFilter(d, parseTemplateFilter("role=SWITCH"))).toBe(true);
  });

  it("AND across distinct keys, OR within a key", () => {
    const d = dev({ attributes: { role: ["switch"], site: ["syd"] } });
    expect(deviceMatchesFilter(d, parseTemplateFilter("role=switch&site=syd"))).toBe(true);
    expect(deviceMatchesFilter(d, parseTemplateFilter("role=switch&site=mel"))).toBe(false); // AND fails
    expect(deviceMatchesFilter(d, parseTemplateFilter("role=router&role=switch"))).toBe(true); // OR
  });

  it("a key the device has no attribute for fails the condition (the rule does not match)", () => {
    expect(deviceMatchesFilter(dev({ attributes: { role: ["switch"] } }), parseTemplateFilter("tenant=acme"))).toBe(false);
  });

  it("Codex round 1 #2 — a mixed-case device attribute key (`Role`) from a third-party provider matches a lowercased `role=` filter (kills the case-sensitive `attributes[key]` lookup that returned undefined → no match)", () => {
    // `unknownFilterKeys` accepts `Role` case-insensitively, so the filter is
    // considered valid; the lookup must match it case-insensitively too.
    expect(deviceMatchesFilter(dev({ attributes: { Role: "switch" } }), parseTemplateFilter("role=switch"))).toBe(true);
    expect(deviceMatchesFilter(dev({ attributes: { Role: ["switch", "router"] } }), parseTemplateFilter("role=router"))).toBe(true);
    // A direct lowercase hit is unaffected (regression: NetBox path stays green).
    expect(deviceMatchesFilter(dev({ attributes: { role: "switch" } }), parseTemplateFilter("role=switch"))).toBe(true);
    // Genuinely absent key still fails, mixed-case or not.
    expect(deviceMatchesFilter(dev({ attributes: { Role: "switch" } }), parseTemplateFilter("tenant=acme"))).toBe(false);
  });

  it("Codex round 2 #1 — a filter key colliding with an Object.prototype member (`constructor`/`__proto__`/`toString`) fails the condition instead of reading the inherited member and throwing in `.trim()` (kills the bare `attributes[key]` prototype read that aborts the whole sync)", () => {
    // A normal object literal inherits `constructor` (a function), `toString` (a
    // function) and `__proto__` (the prototype object). A bare `attributes[key]`
    // returns those instead of undefined, and the next `.trim()` throws — aborting
    // the entire sync. The lookup must be own-property-only: a non-own key fails the
    // condition exactly as a genuinely-absent key does. No throw, returns false.
    const d = dev({ attributes: { role: "switch" } });
    for (const proto of ["constructor", "__proto__", "toString"]) {
      expect(() => deviceMatchesFilter(d, parseTemplateFilter(`${proto}=x`))).not.toThrow();
      expect(deviceMatchesFilter(d, parseTemplateFilter(`${proto}=x`))).toBe(false);
    }
    // An own attribute that happens to share the name still matches (own read intact).
    expect(deviceMatchesFilter(dev({ attributes: { constructor: "x" } }), parseTemplateFilter("constructor=x"))).toBe(true);
  });

  it("the reserved `name` key globs device.name — a `*` glob, anchored, no user regex", () => {
    expect(deviceMatchesFilter(dev({ name: "core-sw-1" }), parseTemplateFilter("name=core-*"))).toBe(true);
    expect(deviceMatchesFilter(dev({ name: "edge-sw-1" }), parseTemplateFilter("name=core-*"))).toBe(false);
    // A regex metacharacter in the glob is literal, never a pattern.
    expect(deviceMatchesFilter(dev({ name: "coreXsw" }), parseTemplateFilter("name=core.sw"))).toBe(false);
    expect(deviceMatchesFilter(dev({ name: "core.sw" }), parseTemplateFilter("name=core.sw"))).toBe(true);
  });
});

describe("describeFilterConditions / unknownFilterKeys — §7.2 live feedback", () => {
  it("describes conditions as 'key is v [or v] AND key is v'", () => {
    expect(describeFilterConditions(parseTemplateFilter("role=switch&site=syd"))).toBe("role is 'switch' AND site is 'syd'");
    expect(describeFilterConditions(parseTemplateFilter("role=switch&role=router"))).toBe("role is 'router' or 'switch'");
  });

  it("unknownFilterKeys flags keys outside the declared list; `name` and the `tag`→`tags` alias are always known; no list ⇒ no unknowns", () => {
    const keys = ["role", "site", "tag", "name"];
    expect(unknownFilterKeys(parseTemplateFilter("sites=syd"), keys)).toEqual(["sites"]);
    expect(unknownFilterKeys(parseTemplateFilter("tag=core&name=x"), keys)).toEqual([]);
    expect(unknownFilterKeys(parseTemplateFilter("role=switch"), keys)).toEqual([]);
    expect(unknownFilterKeys(parseTemplateFilter("whatever=1"), undefined)).toEqual([]);
  });

  // Issue #163 (item 1) — the list a user is shown must be the list the validator
  // accepts. `unknownFilterKeys` always accepts `name`, so a provider that does not
  // declare it (or declares `[]`) must still see it listed — once.
  it.each([
    ["an empty list", [], "name"],
    ["a list lacking `name`", ["zone", "rack-unit"], "zone, rack-unit, name"],
    ["a list containing `name`", ["zone", "name"], "zone, name"],
    ["a list containing `Name` (compared the way the validator compares)", ["Name", "zone"], "Name, zone"]
  ])("knownKeysList for %s lists every key the validator accepts, `name` exactly once", (_label, keys, expected) => {
    const listed = knownKeysList(keys as string[]);
    expect(listed).toBe(expected);
    // Every listed key passes the validator it describes.
    const everyListedKey = listed.split(", ").map((k) => `${k}=x`).join("&");
    expect(unknownFilterKeys(parseTemplateFilter(everyListedKey), keys as string[])).toEqual([]);
  });

  // Codex on #164 — a provider registered through the public API supplies these
  // keys, and the list is spliced into text this extension writes (the Rule Filter
  // prompt and both Known-keys warnings).
  /** Typing each listed key exactly as shown must pass the validator the list describes. */
  function expectEveryListedKeyAccepted(listed: string, keys: string[]): void {
    const typed = listed.split(", ").map((k) => `${k}=x`).join("&");
    expect(unknownFilterKeys(parseTemplateFilter(typed), keys)).toEqual([]);
  }

  it("knownKeysList never shows a line break, bidi override or zero-width character: a key holding one is shown percent-encoded (\u2298 advertising `zo ne` for a declared `zo\\nne`; \u2298 provider text reshaping the prompt or the warnings)", () => {
    const keys = ["zo\nne", "rack\u202Eunit", "ro\u200Ble", "\u200B", "zone"];
    const listed = knownKeysList(keys);

    expect(listed).toBe("zo%0Ane, rack%E2%80%AEunit, ro%E2%80%8Ble, %E2%80%8B, zone, name");
    expect(listed).not.toMatch(/[\n\u202E\u200B]/);
    expectEveryListedKeyAccepted(listed, keys);
  });

  // Codex on #164 — the filter syntax is a URL query string (URLSearchParams), so
  // `&` and `=` split a typed key and `+` / `%xx` decode. Such a key still works
  // typed percent-encoded (`a%2Bb=x` reads back as `a+b`), so it is listed that
  // way rather than hidden; surrounding space, case and `tag` need no encoding.
  it("knownKeysList lists a key the filter syntax would misread by its percent-encoded spelling, and keeps plain keys plain (\u2298 advertising `a&b`, which types as two keys; \u2298 hiding `a+b`, which works as `a%2Bb`)", () => {
    const keys = ["a&b", "a=b", "a+b", "a%20b", " zone ", "tag", "Name"];
    const listed = knownKeysList(keys);

    expect(listed).toBe("a%26b, a%3Db, a%2Bb, a%2520b, zone, tag, Name");
    expectEveryListedKeyAccepted(listed, keys);
  });

  it("knownKeysList leaves out only a key no spelling can express, without throwing (\u2298 a whitespace-only key shown as an empty slot; \u2298 a lone surrogate crashing the prompt through `encodeURIComponent`)", () => {
    const keys = ["   ", "\uD800", "zone"];

    expect(knownKeysList(keys)).toBe("zone, name");
  });

  // Codex on #164 — the list is joined with ", ", so a key holding a comma would
  // read as two keys; and a key made only of ZWJ, variation selectors, tag
  // characters or combining marks would be an entry nobody can see. Neither is
  // plain ASCII, so both are shown encoded.
  it("knownKeysList shows a key holding a comma percent-encoded, so each listed entry is one key (\u2298 `rack, zone` reading as two keys)", () => {
    const keys = ["rack, zone", "a,b", "zone"];
    const listed = knownKeysList(keys);

    expect(listed).toBe("rack%2C%20zone, a%2Cb, zone, name");
    expect(listed.split(", ")).toHaveLength(keys.length + 1);
    expectEveryListedKeyAccepted(listed, keys);
  });

  it("knownKeysList shows a key with no visible character percent-encoded (\u2298 a ZWJ, variation selector, tag characters or a lone combining mark listed as an invisible entry)", () => {
    const keys = ["\u200D", "\uFE0F", "\u{E0067}\u{E0062}", "\u0301", "zone"];
    const listed = knownKeysList(keys);

    expect(listed).toBe("%E2%80%8D, %EF%B8%8F, %F3%A0%81%A7%F3%A0%81%A2, %CC%81, zone, name");
    expectEveryListedKeyAccepted(listed, keys);
  });

  // Codex on #164 — a Hangul Filler (U+3164) or Braille blank (U+2800) is a
  // "letter" or "symbol" that renders blank, and a key such as `\u2014 key` collides
  // with the prompt's own " \u2014 " separator. Rather than chase such cases one
  // predicate at a time, anything beyond plain ASCII is shown encoded.
  it("knownKeysList shows every key beyond plain ASCII percent-encoded, visible or not (\u2298 a blank-rendering Hangul Filler or Braille blank; \u2298 `\u2014 key` blending into the prompt's \u2014 separator)", () => {
    const keys = [
      "caf\u00e9",
      "\u{1F469}\u200D\u{1F4BB}",
      "\u{1F3F4}\u{E0067}\u{E0062}\u{E0073}\u{E0063}\u{E0074}\u{E007F}",
      "\u3164",
      "\u2800",
      "\u2014 key",
      // `encodeURIComponent` leaves these ASCII marks unescaped (Codex on #164);
      // the encoded spelling escapes them too, so "percent-encoded" means exactly that.
      "!",
      "a*b",
      "(x)",
      "~t",
      "it's"
    ];
    const listed = knownKeysList(keys);

    expect(listed).toBe(
      [
        "caf%C3%A9",
        "%F0%9F%91%A9%E2%80%8D%F0%9F%92%BB",
        "%F0%9F%8F%B4%F3%A0%81%A7%F3%A0%81%A2%F3%A0%81%B3%F3%A0%81%A3%F3%A0%81%B4%F3%A0%81%BF",
        "%E3%85%A4",
        "%E2%A0%80",
        "%E2%80%94%20key",
        "%21",
        "a%2Ab",
        "%28x%29",
        "%7Et",
        "it%27s",
        "name"
      ].join(", ")
    );
    expect(listed).not.toMatch(/[^\x21-\x7E ]/); // nothing but printable ASCII and the list's own spaces
    expectEveryListedKeyAccepted(listed, keys);
  });

  it("knownKeysList shows plain-ASCII keys (letters, digits, `_`, `.`, `-`) exactly as declared (\u2298 encoding a key that needs none)", () => {
    expect(knownKeysList(["site", "ip6", "if_name", "dns.name", "sub-net"])).toBe("site, ip6, if_name, dns.name, sub-net, name");
  });

  it("every built-in provider's key list renders exactly as declared (\u2298 a display rule that alters NetBox, EVE-NG, Proxmox or GNS3 keys)", () => {
    const providers = createBuiltInProviders();
    expect(providers.map((p) => p.id)).toEqual(["netbox", "eve-ng", "proxmox", "gns3"]);
    for (const provider of providers) {
      expect(provider.attributeKeys, provider.id).toBeDefined();
      expect(knownKeysList(provider.attributeKeys!), provider.id).toBe(provider.attributeKeys!.join(", "));
    }
  });
});
