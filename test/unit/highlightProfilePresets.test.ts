import { describe, expect, it, vi } from "vitest";
import { TerminalHighlighter } from "../../src/services/terminalHighlighter";
import { validateAndSanitizeHighlightRulesWithError } from "../../src/utils/highlightRuleValidation";
import { HIGHLIGHT_PROFILE_PRESETS } from "../../src/ui/highlightProfilePresets";

vi.mock("vscode", () => ({}));

function highlighter(name: string): TerminalHighlighter {
  const preset = HIGHLIGHT_PROFILE_PRESETS.find(candidate => candidate.name === name);
  if (!preset) throw new Error(`Missing preset: ${name}`);
  return new TerminalHighlighter({ enabled: true, rules: preset.rules });
}

describe("highlight profile presets", () => {
  it("ships a safe, nonempty set of rules for each named preset", () => {
    expect(HIGHLIGHT_PROFILE_PRESETS.map(preset => preset.name)).toEqual([
      "Cisco IOS / IOS XE", "Juniper Junos", "Arista EOS"
    ]);
    for (const { rules } of HIGHLIGHT_PROFILE_PRESETS) {
      expect(rules.length).toBeGreaterThan(0);
      expect(validateAndSanitizeHighlightRulesWithError(rules)).toMatchObject({ ok: true });
      for (const rule of rules) {
        expect(new RegExp(rule.pattern, rule.flags).test("")).toBe(false);
      }
    }
  });

  it("distinguishes Cisco brief interface states, syslog severity, and plain descriptions", () => {
    const engine = highlighter("Cisco IOS / IOS XE");
    const output = engine.apply([
      "Gi0/1    192.0.2.3     YES manual  up                    up",
      "Gi0/2    unassigned    YES unset   administratively down down",
      "Gi0/3    unassigned    YES unset   up                    down",
      "%LINK-3-UPDOWN: Interface GigabitEthernet0/3, changed state to down",
      " description keep this link down for testing"
    ].join("\r\n"));
    expect(output).toContain("\x1b[32mup                    up\x1b[39m");
    expect(output).toContain("\x1b[33madministratively down down\x1b[39m");
    expect(output).toContain("\x1b[31mup                    down\x1b[39m");
    expect(output).toContain("\x1b[33m%LINK-3-UPDOWN\x1b[39m");
    expect(output).toContain("\x1b[36m192.0.2.3\x1b[39m");
    expect(output).toContain("\r\n description keep this link down for testing");
  });

  it("distinguishes Junos Admin and Link column combinations and Establ in BGP output", () => {
    const engine = highlighter("Juniper Junos");
    const output = engine.apply([
      "ge-0/0/0.0    up    up   inet 192.0.2.5/31",
      "ge-0/0/1      up    down",
      "ge-0/0/2      down  down",
      "192.0.2.8 65001 42 52 0 0 12:32 Establ inet.0: 2/2/2/0",
      "error: configuration check failed",
      "description a neighbor is Active in standby"
    ].join("\n"));
    expect(output).toContain("\x1b[32mup    up\x1b[39m");
    expect(output).toContain("\x1b[31mup    down\x1b[39m");
    expect(output).toContain("\x1b[33mdown  down\x1b[39m");
    expect(output).toContain("\x1b[32mEstabl\x1b[39m inet.0:");
    expect(output).toContain("\x1b[36m192.0.2.5/31\x1b[39m");
    expect(output).toContain("\x1b[31merror:\x1b[39m configuration check failed");
    expect(output).toContain("\ndescription a neighbor is Active in standby");
  });

  it("colors EOS link status without coloring a description that mentions it", () => {
    const engine = highlighter("Arista EOS");
    const output = engine.apply([
      "Et1       disabled spare   connected    trunk  full  10G   10GBASE-SR",
      "Et2                        notconnect   1      auto  auto  Not Present",
      "Et3                        disabled     routed auto  auto  Not Present",
      "Et49/2                     errdisabled  multi-lane-intf",
      " description backup is connected to the lab"
    ].join("\n"));
    expect(output).toContain("disabled spare   \x1b[32mconnected\x1b[39m");
    expect(output).toContain("\x1b[31mnotconnect\x1b[39m");
    expect(output).toContain("\x1b[33mdisabled\x1b[39m     routed");
    expect(output).toContain("\x1b[31merrdisabled\x1b[39m");
    expect(output).toContain("\n description backup is connected to the lab");
  });
});
