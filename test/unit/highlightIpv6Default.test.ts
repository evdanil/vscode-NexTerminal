import { readFileSync } from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { validateRegexSafety } from "../../src/utils/regexSafety";

/**
 * Behaviour matrix for the SHIPPED IPv6 default pattern.
 *
 * The pattern is read out of package.json rather than copied here on purpose:
 * these tests must pin what users actually get, not a duplicate that can drift.
 *
 * The bug this guards: the pre-2.8.187 compressed-form alternative
 * `(?:H:){1,7}:H\b` permitted exactly ONE hextet after `::`, so
 * `fe80::b3ff:fe1e:8329` highlighted only `fe80::b3ff` — the address was
 * visibly cut in half in the terminal.
 */
const packageJsonPath = path.resolve(__dirname, "..", "..", "package.json");
const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
  contributes: { configuration?: { properties?: Record<string, any> } };
};

const defaultRules = (packageJson.contributes.configuration?.properties?.["nexus.terminal.highlighting.rules"]
  .default ?? []) as Array<{
  pattern: string;
  color: string;
  flags?: string;
  label?: string;
  description?: string;
  enabled?: boolean;
}>;

const ipv6Rule = defaultRules.find((rule) => rule.label === "IPv6 addresses")!;

function matchesIn(sample: string): string[] {
  const regex = new RegExp(ipv6Rule.pattern, ipv6Rule.flags ?? "g");
  return [...sample.matchAll(regex)].map((m) => m[0]);
}

describe("shipped IPv6 highlighting default", () => {
  it("exists, stays disabled by default, and is a safe pattern", () => {
    expect(ipv6Rule).toBeDefined();
    expect(ipv6Rule.enabled).toBe(false);
    expect(ipv6Rule.color).toBe("magenta");
    expect(validateRegexSafety(ipv6Rule.pattern).ok).toBe(true);
  });

  // ⊘ Rows 3–5 and 8 are the discriminators against the pre-2.8.187 pattern:
  // each one matched only up to the FIRST hextet after `::`.
  const positives: Array<[input: string, expected: string]> = [
    ["2001:0db8:85a3:0000:0000:8a2e:0370:7334", "2001:0db8:85a3:0000:0000:8a2e:0370:7334"],
    ["2001:db8::1", "2001:db8::1"],
    ["2001:db8::8a2e:370:7334", "2001:db8::8a2e:370:7334"],
    ["fe80::b3ff:fe1e:8329", "fe80::b3ff:fe1e:8329"],
    ["fe80::1%eth0", "fe80::1"],
    ["2001:db8::/32", "2001:db8::"],
    ["::1", "::1"],
    ["inet6 addr: fe80::20c:29ff:fe0e:1234/64", "fe80::20c:29ff:fe0e:1234"],
    ["fe80::", "fe80::"],
    ["2001:db8::", "2001:db8::"]
  ];

  it.each(positives)("matches %s whole → %s", (input, expected) => {
    expect(matchesIn(input)).toEqual([expected]);
  });

  /**
   * IPv4-mapped and IPv4-embedded forms (RFC 4291 §2.2 forms 3 and the
   * NAT64/`::ffff:` families). `ss -tn`, `netstat -an`, Java/Go servers bound
   * to a dual-stack socket and every NAT64 gateway print these constantly.
   *
   * ⊘ Every row here is a discriminator against a hex-only IPv6 pattern: with
   * no dotted-quad alternative, `::ffff:192.168.1.1` matched only `::ffff:`
   * (or `::ffff` + a separate IPv4 hit from the IPv4 rule) — the address was
   * cut at the colon and the two halves were coloured by different rules.
   * The alternation ORDER carries these: each v4-tail alternative is placed
   * BEFORE its hex-only counterpart, because JS alternation is first-match,
   * not longest-match.
   */
  const v4Embedded: Array<[input: string, expected: string]> = [
    ["::ffff:192.168.1.1", "::ffff:192.168.1.1"],
    ["peer ::ffff:10.0.0.5:22 users", "::ffff:10.0.0.5"],
    ["2001:db8::192.168.1.1", "2001:db8::192.168.1.1"],
    ["64:ff9b::1.2.3.4", "64:ff9b::1.2.3.4"],
    ["::1.2.3.4", "::1.2.3.4"],
    ["1:2:3:4:5:6:7.8.9.10", "1:2:3:4:5:6:7.8.9.10"],
    ["fe80::5:1.2.3.4", "fe80::5:1.2.3.4"]
  ];

  it.each(v4Embedded)("matches the IPv4-embedded form %s whole → %s", (input, expected) => {
    expect(matchesIn(input)).toEqual([expected]);
  });

  const negatives = [
    "a lone :: scope operator std::vector",
    "std::map<int,int>",
    "time was 12:30:45",
    "MAC aa:bb:cc:dd:ee:ff stays for MAC rule",
    "::",
    // ⊘ The dotted-quad alternatives must not turn the IPv6 rule into a second
    // IPv4 rule: a plain v4 address, and a v4 host:port socket pair, belong to
    // the IPv4 rule alone.
    "ip 192.168.1.1 plain v4",
    "x.y 1.2.3.4:8080 socket"
  ];

  it.each(negatives)("does not match %s", (input) => {
    expect(matchesIn(input)).toEqual([]);
  });

  it("stays linear on a pathological colon storm", () => {
    const storm = ":".repeat(10_000) + "z";
    const regex = new RegExp(ipv6Rule.pattern, ipv6Rule.flags ?? "g");
    const started = Date.now();
    void [...storm.matchAll(regex)];
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  // The dotted-quad alternatives added in v2.8.187 are the ones that could
  // reintroduce catastrophic backtracking: hextet-and-colon runs that end in
  // digits and dots are exactly what they have to give up on.
  it("stays linear on a hex:colon storm with a dotted tail", () => {
    const storm = ("1:".repeat(200) + "1.2.3.").repeat(200) + "z";
    const regex = new RegExp(ipv6Rule.pattern, ipv6Rule.flags ?? "g");
    const started = Date.now();
    void [...storm.matchAll(regex)];
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});
