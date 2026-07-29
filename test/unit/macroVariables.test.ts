import { describe, expect, it } from "vitest";
import {
  getValidMacroVariables,
  hasMacroVariables,
  isValidVariableName,
  MACRO_PLACEHOLDER_SOURCE,
  MACRO_VARIABLE_NAME_PATTERN,
  macroVariablesWebviewJs,
  MAX_MACRO_VARIABLES,
  scanPlaceholders,
  substituteMacroVariables,
  validateMacroVariables
} from "../../src/services/macroVariables";
import { serializeForInlineScript } from "../../src/ui/shared/inlineScriptData";
import type { MacroVariable, TerminalMacro } from "../../src/models/terminalMacro";

describe("isValidVariableName", () => {
  it("accepts simple identifiers", () => {
    expect(isValidVariableName("host")).toBe(true);
    expect(isValidVariableName("_private")).toBe(true);
    expect(isValidVariableName("aws_region2")).toBe(true);
  });

  it("rejects names starting with a digit", () => {
    expect(isValidVariableName("2host")).toBe(false);
  });

  it("rejects names with disallowed characters", () => {
    expect(isValidVariableName("host-name")).toBe(false);
    expect(isValidVariableName("host name")).toBe(false);
    expect(isValidVariableName("host.name")).toBe(false);
  });

  it("rejects names longer than 32 characters", () => {
    expect(isValidVariableName("a".repeat(32))).toBe(true);
    expect(isValidVariableName("a".repeat(33))).toBe(false);
  });

  it("rejects non-string input", () => {
    expect(isValidVariableName(undefined)).toBe(false);
    expect(isValidVariableName(5)).toBe(false);
    expect(isValidVariableName(null)).toBe(false);
  });
});

describe("scanPlaceholders", () => {
  it("finds a declared braced placeholder", () => {
    const scan = scanPlaceholders("ping ${host}", ["host"]);
    expect(scan.used).toEqual(["host"]);
    expect(scan.undeclared).toEqual([]);
  });

  it("finds a declared bare placeholder", () => {
    const scan = scanPlaceholders("ping $host", ["host"]);
    expect(scan.used).toEqual(["host"]);
  });

  it("captures names greedily — $hostname with only host declared is undeclared, not a partial match", () => {
    const scan = scanPlaceholders("$hostname", ["host"]);
    expect(scan.used).toEqual([]);
    expect(scan.undeclared).toEqual(["hostname"]);
  });

  it("reports declared names in declaration order, once each, regardless of appearance order or repeats", () => {
    const scan = scanPlaceholders("$password $host $host $username $password", ["host", "username", "password"]);
    expect(scan.used).toEqual(["host", "username", "password"]);
  });

  it("undeclared names appear in first-appearance order, deduped", () => {
    const scan = scanPlaceholders("$foo $bar $foo", []);
    expect(scan.undeclared).toEqual(["foo", "bar"]);
  });

  it("a declared name that never appears produces no entry in used", () => {
    const scan = scanPlaceholders("no placeholders here", ["port"]);
    expect(scan.used).toEqual([]);
  });

  it("$${host} as the only occurrence of a declared name produces zero prompts (escape, not a use)", () => {
    const scan = scanPlaceholders("$${host}", ["host"]);
    expect(scan.used).toEqual([]);
    expect(scan.undeclared).toEqual([]);
  });

  it("$${aws_region} (undeclared) is not reported as an undeclared use either", () => {
    const scan = scanPlaceholders("$${aws_region}", []);
    expect(scan.undeclared).toEqual([]);
  });

  it("does not match $$, $(cmd), ${#arr[@]}, $1, ${}, or ${x", () => {
    const scan = scanPlaceholders("$$ $(cmd) ${#arr[@]} $1 ${} ${x", ["cmd", "arr", "x"]);
    expect(scan.used).toEqual([]);
    expect(scan.undeclared).toEqual([]);
  });
});

describe("substituteMacroVariables", () => {
  it("substitutes a declared braced placeholder", () => {
    expect(substituteMacroVariables("ping ${host}", { host: "10.0.0.1" })).toBe("ping 10.0.0.1");
  });

  it("substitutes a declared bare placeholder", () => {
    expect(substituteMacroVariables("ping $host", { host: "10.0.0.1" })).toBe("ping 10.0.0.1");
  });

  it("substitutes both forms in the same text", () => {
    expect(
      substituteMacroVariables("ipmitool -H $host -U ${username}", { host: "10.0.0.1", username: "root" })
    ).toBe("ipmitool -H 10.0.0.1 -U root");
  });

  it("leaves an undeclared placeholder untouched, in both forms", () => {
    expect(substituteMacroVariables("$foo ${bar}", {})).toBe("$foo ${bar}");
  });

  it("un-escapes $${x} to ${x} when x is declared", () => {
    // `host` is declared but has no entered value — the real flow can never
    // produce a `values` map holding an unprompted name (only used-and-prompted
    // names ever land in `values`), so the declaration is expressed via
    // `declaredNames` instead of an artificial `values` entry.
    expect(substituteMacroVariables("$${host}", {}, ["host"])).toBe("${host}");
  });

  it("un-escapes $$x to $x when x is declared (bare form)", () => {
    expect(substituteMacroVariables("$$host", { host: "unused" })).toBe("$host");
  });

  it("leaves $${aws_region} fully intact (both dollars) when aws_region is undeclared — Terraform's escape survives", () => {
    const text = "cat > main.tf <<EOF\n$${aws_region}\nEOF";
    expect(substituteMacroVariables(text, {})).toBe(text);
  });

  it("does not touch $$, $(cmd), ${#arr[@]}, or $1", () => {
    const text = "$$ $(cmd) ${#arr[@]} $1";
    expect(substituteMacroVariables(text, { cmd: "x", arr: "y" })).toBe(text);
  });

  it("does not touch ${} or an unclosed ${x", () => {
    const text = "before ${} middle ${x after";
    expect(substituteMacroVariables(text, { x: "value" })).toBe(text);
  });

  it("adjacent placeholders ${a}${b} both substitute correctly", () => {
    expect(substituteMacroVariables("${a}${b}", { a: "1", b: "2" })).toBe("12");
  });

  describe("explicit declaredNames argument (declared vs. has-a-value are different sets)", () => {
    it("a declared-but-valueless name's escape is still honoured", () => {
      expect(substituteMacroVariables("$${host}", {}, ["host"])).toBe("${host}");
    });

    it("a declared-but-valueless name used unescaped (never prompted) is left verbatim", () => {
      expect(substituteMacroVariables("$host", {}, ["host"])).toBe("$host");
    });

    it("omitting declaredNames falls back to the keys of values", () => {
      expect(substituteMacroVariables("ping $host", { host: "10.0.0.1" })).toBe("ping 10.0.0.1");
      expect(substituteMacroVariables("$${host}", { host: "10.0.0.1" })).toBe("${host}");
    });
  });

  it("absent, empty, or non-array variables leave text unaffected via an empty values map", () => {
    const text = "show version with $host and ${username}\n";
    expect(substituteMacroVariables(text, {})).toBe(text);
  });

  describe("security: entered values are never rescanned or reinterpreted", () => {
    it("a value containing ${host} is emitted literally, not re-substituted", () => {
      const result = substituteMacroVariables("$password", { password: "${host}", host: "10.0.0.1" });
      expect(result).toBe("${host}");
    });

    it("a value containing $otherVar is emitted literally, not re-substituted", () => {
      const result = substituteMacroVariables("$a", { a: "$b", b: "resolved" });
      expect(result).toBe("$b");
    });

    it("a value containing a backtick-replacement pattern ($`) is emitted byte-for-byte", () => {
      const result = substituteMacroVariables("prefix $password suffix", { password: "pa$`word" });
      expect(result).toBe("prefix pa$`word suffix");
    });

    it("a value containing $& is emitted byte-for-byte, not the whole match", () => {
      const result = substituteMacroVariables("prefix $password suffix", { password: "pa$&word" });
      expect(result).toBe("prefix pa$&word suffix");
    });

    it("a value containing $' is emitted byte-for-byte", () => {
      const result = substituteMacroVariables("prefix $password suffix", { password: "pa$'word" });
      expect(result).toBe("prefix pa$'word suffix");
    });

    it("a value containing $1 (a capture-group reference) is emitted byte-for-byte", () => {
      const result = substituteMacroVariables("prefix $password suffix", { password: "pa$1word" });
      expect(result).toBe("prefix pa$1word suffix");
    });

    it("a value containing literal $$ is emitted byte-for-byte, not collapsed", () => {
      const result = substituteMacroVariables("prefix $password suffix", { password: "pa$$word" });
      expect(result).toBe("prefix pa$$word suffix");
    });

    it("a value combining every JS replacement-pattern token survives byte-for-byte", () => {
      const nasty = "$& $` $' $1 $2 $$ end";
      const result = substituteMacroVariables("value=$password", { password: nasty });
      expect(result).toBe(`value=${nasty}`);
    });
  });

  describe("security: Object.prototype names are not treated as declared", () => {
    // `${constructor}` / `$toString` are valid variable names by the §4 pattern, so a
    // lookup that used `name in values` or a bare `{}` map would resolve them off the
    // prototype chain and substitute `undefined` into text the user never declared.
    // `__proto__` is the one of these that actually broke in practice: unlike
    // `constructor`/`toString`/`hasOwnProperty`/`valueOf` (writable, own-property
    // assignment shadows the inherited one just fine), assigning `values["__proto__"]
    // = x` on a plain object literal is intercepted by Object.prototype's legacy
    // accessor and changes the object's prototype instead of creating an own
    // property — an entered value would silently vanish rather than substitute.
    for (const name of ["constructor", "toString", "hasOwnProperty", "valueOf", "__proto__"]) {
      it(`leaves an undeclared \${${name}} untouched`, () => {
        expect(substituteMacroVariables(`a \${${name}} b`, { host: "x" })).toBe(`a \${${name}} b`);
        expect(substituteMacroVariables(`a $${name} b`, { host: "x" })).toBe(`a $${name} b`);
      });
    }

    it("still substitutes such a name when it IS genuinely declared", () => {
      expect(substituteMacroVariables("a ${constructor} b", { constructor: "ok" })).toBe("a ok b");
    });

    it("scanPlaceholders reports them as undeclared, not used", () => {
      const scan = scanPlaceholders("$toString ${constructor}", ["host"]);
      expect(scan.used).toEqual([]);
      expect(scan.undeclared).toEqual(["toString", "constructor"]);
    });
  });

  it("stays linear on a large (64 KiB) input with many placeholders", () => {
    const chunk = "show ip route $host\n";
    const text = chunk.repeat(Math.ceil((64 * 1024) / chunk.length));
    const start = Date.now();
    const result = substituteMacroVariables(text, { host: "10.0.0.1" });
    const elapsed = Date.now() - start;
    expect(result).not.toContain("$host");
    expect(elapsed).toBeLessThan(1000);
  });
});

describe("hasMacroVariables (§4.2 untrusted-shape guard)", () => {
  it("false when variables is absent", () => {
    expect(hasMacroVariables({})).toBe(false);
  });

  it("false when variables is an empty array", () => {
    expect(hasMacroVariables({ variables: [] })).toBe(false);
  });

  it("false when variables is a non-array with a truthy .length (e.g. a string)", () => {
    // The exact case from §4.2: `variables: "abc"` must NOT be treated as declared.
    expect(hasMacroVariables({ variables: "abc" as unknown as MacroVariable[] })).toBe(false);
  });

  it("false when variables is an object with a .length field", () => {
    expect(hasMacroVariables({ variables: { length: 5 } as unknown as MacroVariable[] })).toBe(false);
  });

  it("true when variables is a non-empty array", () => {
    expect(hasMacroVariables({ variables: [{ name: "host" }] })).toBe(true);
  });
});

describe("getValidMacroVariables", () => {
  it("returns [] for absent/non-array/empty shapes", () => {
    expect(getValidMacroVariables({})).toEqual([]);
    expect(getValidMacroVariables({ variables: [] })).toEqual([]);
    expect(getValidMacroVariables({ variables: "abc" as unknown as MacroVariable[] })).toEqual([]);
  });

  it("filters out entries with an invalid or missing name, keeping the rest", () => {
    const variables = [
      { name: "host" },
      { name: "2bad" },
      { notAName: true },
      null,
      "garbage",
      { name: "username" }
    ] as unknown as MacroVariable[];
    const result = getValidMacroVariables({ variables });
    expect(result.map((v) => v.name)).toEqual(["host", "username"]);
  });

  describe("full field validation (§4.2 review fix)", () => {
    it("drops a non-string label but keeps the variable", () => {
      const variables = [{ name: "host", label: 42 }] as unknown as MacroVariable[];
      expect(getValidMacroVariables({ variables })).toEqual([{ name: "host" }]);
    });

    it("drops a non-string default but keeps the variable", () => {
      const variables = [{ name: "host", default: 42 }] as unknown as MacroVariable[];
      expect(getValidMacroVariables({ variables })).toEqual([{ name: "host" }]);
    });

    it("drops a non-boolean secret (treated as not secret)", () => {
      const variables = [{ name: "host", secret: "yes" }] as unknown as MacroVariable[];
      expect(getValidMacroVariables({ variables })).toEqual([{ name: "host" }]);
    });

    it("drops a non-boolean remember", () => {
      const variables = [{ name: "host", remember: "no" }] as unknown as MacroVariable[];
      expect(getValidMacroVariables({ variables })).toEqual([{ name: "host" }]);
    });

    it("dedupes duplicate names, first occurrence wins", () => {
      const variables = [
        { name: "host", label: "First" },
        { name: "host", label: "Second" }
      ] as unknown as MacroVariable[];
      expect(getValidMacroVariables({ variables })).toEqual([{ name: "host", label: "First" }]);
    });

    it("strips default and remember from a secret entry", () => {
      const variables = [
        { name: "password", secret: true, default: "leaked", remember: false }
      ] as unknown as MacroVariable[];
      expect(getValidMacroVariables({ variables })).toEqual([{ name: "password", secret: true }]);
    });
  });
});

describe("validateMacroVariables (§9.4)", () => {
  it("accepts a well-formed set", () => {
    const variables: MacroVariable[] = [{ name: "host" }, { name: "username" }, { name: "password", secret: true }];
    expect(validateMacroVariables(variables)).toEqual([]);
  });

  it("flags an invalid name", () => {
    const errors = validateMacroVariables([{ name: "2bad" }]);
    expect(errors.some((e) => e.index === 0)).toBe(true);
  });

  it("flags duplicate names", () => {
    const errors = validateMacroVariables([{ name: "host" }, { name: "host" }]);
    expect(errors.some((e) => e.index === 1 && /duplicate/i.test(e.message))).toBe(true);
  });

  it("flags more than the maximum allowed variables", () => {
    const variables = Array.from({ length: MAX_MACRO_VARIABLES + 1 }, (_, i) => ({ name: `v${i}` }));
    const errors = validateMacroVariables(variables);
    expect(errors.some((e) => e.index === undefined && /at most/i.test(e.message))).toBe(true);
  });

  it("flags a secret variable with a non-empty default", () => {
    const errors = validateMacroVariables([{ name: "password", secret: true, default: "hunter2" }]);
    expect(errors.some((e) => /masked/i.test(e.message))).toBe(true);
  });

  it("does not flag a secret variable with no default", () => {
    const errors = validateMacroVariables([{ name: "password", secret: true }]);
    expect(errors).toEqual([]);
  });

  it("flags variables declared alongside a triggerPattern", () => {
    const errors = validateMacroVariables([{ name: "host" }], { triggerPattern: "[Pp]assword:" });
    expect(errors.some((e) => /auto-trigger/i.test(e.message))).toBe(true);
  });

  it("does not flag an empty variable list even with a triggerPattern present", () => {
    const errors = validateMacroVariables([], { triggerPattern: "[Pp]assword:" });
    expect(errors).toEqual([]);
  });
});

describe("macroVariablesWebviewJs", () => {
  it("exports both scan functions by name", () => {
    const js = macroVariablesWebviewJs();
    expect(js).toContain("function isValidVariableName(");
    expect(js).toContain("function scanMacroPlaceholders(");
  });

  // Cross-checked by embedded source string, not by executing the generated JS
  // (no `new Function`/`eval` in tests) — mirrors the existing
  // `regexSafety.test.ts` precedent, which only exercises the TS side directly.
  it("embeds the exact same name-validation pattern source used by isValidVariableName", () => {
    const js = macroVariablesWebviewJs();
    expect(js).toContain(serializeForInlineScript(MACRO_VARIABLE_NAME_PATTERN.source));
  });

  it("embeds the exact same placeholder-scan pattern source used by scanPlaceholders — cannot drift (§9.3)", () => {
    const js = macroVariablesWebviewJs();
    expect(js).toContain(serializeForInlineScript(MACRO_PLACEHOLDER_SOURCE));
  });
});

describe("integration: resolving a macro's declared-and-used variables end to end", () => {
  function makeMacro(overrides: Partial<TerminalMacro> = {}): TerminalMacro {
    return { name: "IPMI SOL", text: "ipmitool -H $host -U $username -P $password sol activate\n", ...overrides };
  }

  it("substitutes only the declared names that actually appear, leaving the rest untouched", () => {
    const macro = makeMacro({
      variables: [{ name: "host" }, { name: "username" }, { name: "password", secret: true }, { name: "port" }]
    });
    const declared = getValidMacroVariables(macro);
    const scan = scanPlaceholders(macro.text, declared.map((v) => v.name));
    expect(scan.used).toEqual(["host", "username", "password"]); // "port" never appears — no prompt
    const resolved = substituteMacroVariables(macro.text, { host: "10.0.0.1", username: "root", password: "s3cr3t" });
    expect(resolved).toBe("ipmitool -H 10.0.0.1 -U root -P s3cr3t sol activate\n");
  });
});
