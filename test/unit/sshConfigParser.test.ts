import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
  MAX_INCLUDE_DEPTH,
  parseSshConfig,
  resolveSshConfig,
  type SshConfigIo
} from "../../src/utils/sshConfigParser";

const HOME_SSH = path.join(os.homedir(), ".ssh");

function sshPath(...parts: string[]): string {
  return path.join(HOME_SSH, ...parts);
}

/**
 * Filesystem stand-in. readDir deliberately answers in REVERSE-sorted order so
 * any test that depends on glob ordering is testing the parser's own sort, not
 * the fixture's insertion order.
 */
function makeIo(files: Record<string, string>): SshConfigIo & { reads: string[] } {
  const reads: string[] = [];
  return {
    reads,
    async readFile(filePath: string): Promise<string | undefined> {
      reads.push(filePath);
      return Object.prototype.hasOwnProperty.call(files, filePath) ? files[filePath] : undefined;
    },
    async readDir(dir: string): Promise<string[]> {
      const prefix = dir.endsWith(path.sep) ? dir : dir + path.sep;
      const names = new Set<string>();
      for (const key of Object.keys(files)) {
        if (key.startsWith(prefix)) {
          const rest = key.slice(prefix.length);
          if (!rest.includes(path.sep)) {
            names.add(rest);
          }
        }
      }
      return [...names].sort().reverse();
    }
  };
}

describe("parseSshConfig — keywords", () => {
  it("reads keywords in ANY case, because ssh_config keywords are case-insensitive (⊘ matching the canonical spelling exactly silently drops every host written as `hostname`/`PORT`, which is most real configs)", () => {
    const result = parseSshConfig(`Host box
  hostname 10.0.0.1
  PORT 2222
  UsEr root
  PROXYJUMP bastion
  identityfile ~/.ssh/id_ed25519
`);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]).toMatchObject({
      alias: "box",
      host: "10.0.0.1",
      port: 2222,
      user: "root",
      proxyJump: "bastion",
      identityFile: "~/.ssh/id_ed25519"
    });
  });

  it("keeps the FIRST value of a repeated keyword, per ssh_config(5) first-obtained-value (⊘ a plain `map.set()` per line makes the LAST value win and connects the user to the wrong box, with the wrong port and the wrong account)", () => {
    const result = parseSshConfig(`Host box
  HostName first.example.com
  Port 2200
  User alice
  HostName second.example.com
  Port 2299
  User bob
`);
    expect(result.entries[0].host).toBe("first.example.com");
    expect(result.entries[0].port).toBe(2200);
    expect(result.entries[0].user).toBe("alice");
    // ⊘ The later values must not appear anywhere in the entry.
    expect(result.entries[0].host).not.toBe("second.example.com");
    expect(result.entries[0].port).not.toBe(2299);
    expect(result.entries[0].user).not.toBe("bob");
  });

  it("validates Port only AFTER first-value-wins picked it, so a garbage first Port stays garbage (⊘ skipping invalid values while scanning lets the second Port win and silently invents a first-match-wins violation)", () => {
    const result = parseSshConfig(`Host box
  Port notanumber
  Port 2222
`);
    expect(result.entries[0].port).toBeUndefined();
    expect(result.entries[0].port).not.toBe(2222);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0].reason).toContain("not a number");
  });

  it("drops an out-of-range Port instead of persisting it (⊘ a bare parseInt hands 70000 to the connector, which fails at dial time with no clue why)", () => {
    const result = parseSshConfig("Host box\n  Port 70000\n");
    expect(result.entries[0].port).toBeUndefined();
    expect(result.issues[0].reason).toContain("1-65535");
  });

  it("accepts the `Keyword=value` spelling ssh_config also allows (⊘ splitting on whitespace only parses `Port=2222` as an unknown keyword and loses the port)", () => {
    const result = parseSshConfig("Host box\n  HostName=10.0.0.9\n  Port = 2222\n");
    expect(result.entries[0].host).toBe("10.0.0.9");
    expect(result.entries[0].port).toBe(2222);
  });

  it("records a keyword with no value as an issue and still emits the host (⊘ dereferencing args[0] blindly throws, or writes `undefined` into the entry as if it were a real hostname)", () => {
    const result = parseSshConfig("Host box\n  HostName\n  Port\n");
    expect(result.entries).toHaveLength(1);
    // HostName never took a value, so the alias remains the host.
    expect(result.entries[0].host).toBe("box");
    expect(result.entries[0].port).toBeUndefined();
    expect(result.issues.map((i) => i.reason)).toEqual(["HostName has no value", "Port has no value"]);
  });

  it("ignores keywords it does not model rather than failing the file (⊘ treating an unknown keyword as an error aborts the import of a config that ssh itself reads fine)", () => {
    const result = parseSshConfig(`Host box
  HostName 10.0.0.1
  ServerAliveInterval 30
  ForwardAgent yes
  StrictHostKeyChecking no
`);
    expect(result.entries).toHaveLength(1);
    expect(result.issues).toHaveLength(0);
  });
});

describe("parseSshConfig — Host patterns", () => {
  it("fans `Host a b c` out into one entry per pattern, all sharing the block (⊘ taking only the first token silently loses two of the three hosts the user wrote)", () => {
    const result = parseSshConfig(`Host web1 web2 web3
  User deploy
  Port 2222
`);
    expect(result.entries.map((e) => e.alias)).toEqual(["web1", "web2", "web3"]);
    expect(result.entries.every((e) => e.user === "deploy" && e.port === 2222)).toBe(true);
    // No HostName in the block, so each alias is its own host.
    expect(result.entries.map((e) => e.host)).toEqual(["web1", "web2", "web3"]);
  });

  it("uses the ALIAS as the host when the block has no HostName, because that is exactly what ssh does (⊘ requiring HostName drops every `Host server.example.com` block — the most common shape in a hand-written config — as if it were not a host at all)", () => {
    const result = parseSshConfig(`Host plain.example.com
  User ops

Host named
  HostName 10.0.0.2
`);
    expect(result.entries).toHaveLength(2);
    expect(result.entries[0]).toMatchObject({ alias: "plain.example.com", host: "plain.example.com", user: "ops" });
    expect(result.entries[1]).toMatchObject({ alias: "named", host: "10.0.0.2" });
  });

  it("skips a negated pattern — a `!` subtracts from a pattern set and names no host (⊘ importing `!staging` creates a phantom server literally called `!staging` that can never be reached)", () => {
    const result = parseSshConfig(`Host prod !staging
  User ops
`);
    expect(result.entries.map((e) => e.alias)).toEqual(["prod"]);
    expect(result.negatedPatternCount).toBe(1);
    // ⊘ Neither spelling of the negated pattern may survive.
    expect(result.entries.map((e) => e.alias)).not.toContain("!staging");
    expect(result.entries.map((e) => e.alias)).not.toContain("staging");
  });

  it("skips AND counts a wildcard pattern — `Host *` is a defaults block (⊘ importing it creates a bogus server named `*`, and dropping it without counting leaves the import summary claiming nothing was skipped)", () => {
    const result = parseSshConfig(`Host *
  User default

Host gw.*.example.com
  User net

Host lab?
  User lab

Host real
  HostName 10.0.0.3
`);
    expect(result.entries.map((e) => e.alias)).toEqual(["real"]);
    expect(result.wildcardPatternCount).toBe(3);
    expect(result.entries.map((e) => e.alias)).not.toContain("*");
  });

  it("does NOT leak a `Host *` defaults block's settings onto later hosts (⊘ merging global defaults into every entry imports a username the user never set on that host)", () => {
    const result = parseSshConfig(`Host *
  User globaluser
  Port 9999

Host box
  HostName 10.0.0.4
`);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].user).toBeUndefined();
    expect(result.entries[0].port).toBeUndefined();
  });

  it("keeps the FIRST block's HostName when a later block repeats the alias with nothing new, and counts that dead block (⊘ last-block-wins overwrites a working host with a later stub, and an uncounted dead block hides it from the import summary)", () => {
    const result = parseSshConfig(`Host box
  HostName original.example.com

Host other
  HostName other.example.com

Host box
  HostName shadow.example.com
`);
    expect(result.entries.map((e) => e.host)).toEqual(["original.example.com", "other.example.com"]);
    expect(result.duplicateAliasCount).toBe(1);
    expect(result.entries.map((e) => e.host)).not.toContain("shadow.example.com");
  });

  it("carries BOTH blocks' settings when the same alias appears twice (⊘ dropping the later block wholesale imports `foo` with no user, though `ssh -G -F <file> foo` reports one — first-match-wins is per OPTION, not per block)", () => {
    const result = parseSshConfig(`Host foo
  HostName example.test

Host foo
  User bob
`);

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]).toMatchObject({ alias: "foo", host: "example.test", user: "bob" });
    // ⊘ Nothing was skipped here — the later block's User is in the entry, so
    // reporting it as a skipped duplicate would be a lie to the import summary.
    expect(result.duplicateAliasCount).toBe(0);
  });

  it("lets the EARLIER block win a field they both set, while still merging the fields it left unset (⊘ a merge that overwrites turns first-value-wins into last-value-wins for every repeated alias)", () => {
    const result = parseSshConfig(`Host foo
  HostName first.example.test
  User alice

Host foo
  HostName second.example.test
  User bob
  Port 2222
`);

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].host).toBe("first.example.test");
    expect(result.entries[0].user).toBe("alice");
    expect(result.entries[0].host).not.toBe("second.example.test");
    expect(result.entries[0].user).not.toBe("bob");
    // Port was never obtained from the first block, so the later one supplies it.
    expect(result.entries[0].port).toBe(2222);
  });

  it("merges Port, IdentityFile and ProxyJump too, not only User (⊘ a merge that special-cases one keyword still loses the key path, and a host ssh reaches with a key imports without one)", () => {
    const result = parseSshConfig(`Host foo
  HostName example.test

Host foo
  Port 2222
  IdentityFile ~/.ssh/id_foo
  ProxyJump bastion
`);

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]).toMatchObject({
      host: "example.test",
      port: 2222,
      identityFile: "~/.ssh/id_foo",
      proxyJump: "bastion"
    });
  });

  it("takes a later block's HostName when the first block declared none — the alias sitting in `host` there is a fallback, not a value ssh obtained (⊘ treating the fallback as a set value imports `foo` as host `foo` while ssh connects to example.test)", () => {
    const result = parseSshConfig(`Host foo
  User bob

Host foo
  HostName example.test
`);

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].host).toBe("example.test");
    expect(result.entries[0].user).toBe("bob");
    expect(result.entries[0].host).not.toBe("foo");
  });

  it("counts a repeated block ONLY when it contributed nothing, and keeps the first block's line (⊘ counting every repeat reports merged hosts as skipped, and moving the coordinate points the user at a block that named nothing)", () => {
    const result = parseSshConfig(`Host foo
  HostName example.test
  User alice

Host foo
  HostName shadow.test
  User bob

Host foo
  Port 2222
`);

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].port).toBe(2222);
    // Only the middle block is dead text; the third one merged a Port.
    expect(result.duplicateAliasCount).toBe(1);
    expect(result.entries[0].line).toBe(1);
  });

  it("records an issue for a `Host` line with no patterns instead of emitting a nameless entry (⊘ an empty alias becomes an unnamed, unusable server row)", () => {
    const result = parseSshConfig("Host\nHost real\n");
    expect(result.entries.map((e) => e.alias)).toEqual(["real"]);
    expect(result.issues[0].reason).toContain("no patterns");
  });

  it("ignores directives that appear before any Host block — they are globals, not a host (⊘ attaching them to the next block imports settings the user scoped to everything, as if they were per-host)", () => {
    const result = parseSshConfig(`User globaluser
Port 9999

Host box
  HostName 10.0.0.5
`);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].user).toBeUndefined();
    expect(result.entries[0].port).toBeUndefined();
  });
});

describe("parseSshConfig — Match blocks", () => {
  it("skips a Match block whole and counts it, because its condition cannot be evaluated statically (⊘ importing Match bodies produces hosts that only exist under an `exec` test that never ran)", () => {
    const result = parseSshConfig(`Host box
  HostName 10.0.0.6

Match host *.internal exec "test -f /tmp/vpn"
  User vpnuser
  ProxyJump vpn-gw

Host after
  HostName 10.0.0.7
`);
    expect(result.entries.map((e) => e.alias)).toEqual(["box", "after"]);
    expect(result.matchBlockCount).toBe(1);
    // ⊘ The Match body must not bleed into the block that preceded it.
    expect(result.entries[0].user).toBeUndefined();
    expect(result.entries[0].proxyJump).toBeUndefined();
  });

  it("does not record an Include that sits inside a Match block (⊘ following it imports hosts gated behind a condition that was never evaluated)", () => {
    const result = parseSshConfig(`Match exec "true"
  Include conditional.conf

Host box
  HostName 10.0.0.8
`);
    expect(result.includes).toHaveLength(0);
    expect(result.matchBlockCount).toBe(1);
    expect(result.entries).toHaveLength(1);
  });
});

describe("parseSshConfig — lexical handling", () => {
  it("handles CRLF line endings (⊘ splitting on \\n alone leaves a trailing \\r glued to every value, so the host becomes `10.0.0.1\\r` and never resolves)", () => {
    const result = parseSshConfig("Host box\r\n  HostName 10.0.0.1\r\n  Port 2222\r\n");
    expect(result.entries[0].host).toBe("10.0.0.1");
    expect(result.entries[0].port).toBe(2222);
  });

  it("strips a UTF-8 BOM (⊘ leaving it makes the first keyword `\\uFEFFHost`, which no keyword match recognises — the whole first block vanishes)", () => {
    const result = parseSshConfig("﻿Host box\n  HostName 10.0.0.1\n");
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].alias).toBe("box");
  });

  it("handles BOM and CRLF together, the normal shape of a config copied off Windows (⊘ handling only one of the two still loses the first block)", () => {
    const result = parseSshConfig("﻿Host box\r\n  HostName 10.0.0.1\r\n");
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].host).toBe("10.0.0.1");
  });

  it("ignores comment lines and blank lines, including an indented comment (⊘ a naive `startsWith(\"#\")` on the raw line treats an indented comment as a keyword and files an issue for every commented-out host)", () => {
    const result = parseSshConfig(`# top comment

Host box

    # indented comment
  HostName 10.0.0.1

`);
    expect(result.entries).toHaveLength(1);
    expect(result.issues).toHaveLength(0);
  });

  it("drops a trailing comment but keeps a `#` inside a token, matching strdelim (⊘ splitting on any `#` truncates a hostname like `web#1`; ignoring comments entirely imports `10.0.0.1 # prod` as the hostname)", () => {
    const result = parseSshConfig(`Host web#1
  HostName 10.0.0.1 # prod box
  User ops#2
`);
    expect(result.entries[0].alias).toBe("web#1");
    expect(result.entries[0].host).toBe("10.0.0.1");
    expect(result.entries[0].user).toBe("ops#2");
  });

  it("keeps a quoted value with spaces intact (⊘ splitting on whitespace truncates `\"~/my keys/id\"` at the space and points IdentityFile at a file that does not exist)", () => {
    const result = parseSshConfig('Host box\n  IdentityFile "~/my keys/id_ed25519"\n');
    expect(result.entries[0].identityFile).toBe("~/my keys/id_ed25519");
  });

  it("joins a backslash-escaped space into the token and drops the backslash — `ssh -G` reports `identityfile /tmp/my key` for it (⊘ flushing at the escaped space records `/tmp/my\\`, a path that does not exist, and makes the profile key-auth on it)", () => {
    const result = parseSshConfig("Host box\n  IdentityFile /tmp/my\\ key\n");
    expect(result.entries[0].identityFile).toBe("/tmp/my key");
    expect(result.entries[0].identityFile).not.toContain("\\");
  });

  it("escapes a tab the same way a space is escaped (⊘ handling only \" \" leaves a tab flushing the token early)", () => {
    const result = parseSshConfig("Host box\n  IdentityFile /tmp/my\\\tkey\n");
    expect(result.entries[0].identityFile).toBe("/tmp/my\tkey");
  });

  it("reads `\\\\` as one literal backslash", () => {
    const result = parseSshConfig("Host box\n  IdentityFile /tmp/a\\\\b\n");
    expect(result.entries[0].identityFile).toBe("/tmp/a\\b");
  });

  it("⊘ keeps the backslashes in a Windows key path, which holds no recognised escape (a blanket \"drop every backslash\" rule hands the connector C:Usersme.sshid_rsa)", () => {
    const result = parseSshConfig("Host box\n  IdentityFile C:\\Users\\me\\.ssh\\id_rsa\n");
    expect(result.entries[0].identityFile).toBe("C:\\Users\\me\\.ssh\\id_rsa");
  });

  it("⊘ keeps a trailing backslash at end of line as a literal backslash — ssh_config has no line continuation, so it cannot mean one", () => {
    const result = parseSshConfig("Host box\n  IdentityFile /tmp/key\\\n  User ops\n");
    expect(result.entries[0].identityFile).toBe("/tmp/key\\");
    // The next line is still its own directive, not a continuation of this one.
    expect(result.entries[0].user).toBe("ops");
    expect(result.issues).toHaveLength(0);
  });

  it("⊘ recognises `\\\\` and `\\\"` inside quotes but leaves an escaped space there alone — inside quotes a space needs no escape, so OpenSSH treats `\\ ` as an unrecognised escape and keeps the backslash", () => {
    expect(parseSshConfig('Host box\n  IdentityFile "/tmp/a\\\\b"\n').entries[0].identityFile).toBe("/tmp/a\\b");
    expect(parseSshConfig('Host box\n  IdentityFile "/tmp/my\\ key"\n').entries[0].identityFile).toBe("/tmp/my\\ key");
  });

  it("reads `\\\"` as a literal quote that neither opens nor closes a quoted run (⊘ toggling on it swallows the following space and merges two Host patterns into one alias)", () => {
    const result = parseSshConfig('Host a\\"b c\n  HostName 10.0.0.1\n');
    expect(result.entries.map((e) => e.alias)).toEqual(['a"b', "c"]);
  });

  it("⊘ leaves `\\#` as a literal backslash-hash, matching argv_split's unrecognised-escape rule — the backslash opens the token, which is what stops the `#` starting a comment", () => {
    const result = parseSshConfig("Host box\n  IdentityFile \\#odd/key\n");
    expect(result.entries[0].identityFile).toBe("\\#odd/key");
    expect(result.entries[0].identityFile).not.toBe("#odd/key");
  });

  it("⊘ still ends the line at a `#` that opens a token even now that escapes are honoured (a backslash earlier in the line must not turn the rest of it into data)", () => {
    const result = parseSshConfig("Host box\n  IdentityFile /tmp/my\\ key # the prod key\n");
    expect(result.entries[0].identityFile).toBe("/tmp/my key");
  });

  it("returns an empty result for an empty or comment-only file, without an issue (⊘ reporting a parse failure on a legitimately empty config sends the user hunting a bug that is not there)", () => {
    const result = parseSshConfig("\n# nothing here\n\n");
    expect(result.entries).toHaveLength(0);
    expect(result.issues).toHaveLength(0);
    expect(result.includes).toHaveLength(0);
  });
});

describe("parseSshConfig — Include is data, not I/O", () => {
  it("returns Include patterns verbatim, with their line, and resolves NOTHING (⊘ a parser that touches the filesystem cannot be unit-tested from a string and drags `fs` into the web bundle)", () => {
    const result = parseSshConfig(`Include config.d/*.conf ~/other.conf

Host box
  HostName 10.0.0.1
`);
    expect(result.includes).toEqual([{ line: 1, patterns: ["config.d/*.conf", "~/other.conf"] }]);
    expect(result.entries).toHaveLength(1);
    // ⊘ Nothing about include resolution may be reported by the pure layer.
    expect(result.includeMissingCount).toBe(0);
    expect(result.includeCycleCount).toBe(0);
    expect(result.includeDepthExceededCount).toBe(0);
    expect(result.issues).toHaveLength(0);
  });

  it("records an Include with no path as an issue (⊘ pushing an empty pattern list sends the resolver off to glob the empty string)", () => {
    const result = parseSshConfig("Include\n");
    expect(result.includes).toHaveLength(0);
    expect(result.issues[0].reason).toContain("no path");
  });
});

describe("resolveSshConfig — include resolution", () => {
  it("resolves a relative Include against ~/.ssh, NOT against the including file's directory (⊘ the intuitive `dirname(includingFile)` rule reads a completely different file — here /etc/ssh/extra.conf — which is what OpenSSH does not do)", async () => {
    const io = makeIo({
      "/etc/ssh/ssh_config": "Include extra.conf\n",
      "/etc/ssh/extra.conf": "Host decoy\n  HostName wrong.example.com\n",
      [sshPath("extra.conf")]: "Host fromhome\n  HostName right.example.com\n"
    });

    const result = await resolveSshConfig("/etc/ssh/ssh_config", io);

    expect(result.entries.map((e) => e.alias)).toEqual(["fromhome"]);
    expect(result.entries[0].host).toBe("right.example.com");
    // ⊘ The sibling-directory file must never be read.
    expect(io.reads).not.toContain("/etc/ssh/extra.conf");
    expect(result.entries.map((e) => e.alias)).not.toContain("decoy");
  });

  it("expands a leading `~` in an Include path (⊘ leaving the tilde literal makes the resolver look for a directory actually named `~`, and every include silently goes missing)", async () => {
    const io = makeIo({
      [sshPath("config")]: "Include ~/elsewhere/hosts.conf\n",
      [path.join(os.homedir(), "elsewhere", "hosts.conf")]: "Host tilde\n  HostName 10.0.0.10\n"
    });

    const result = await resolveSshConfig(sshPath("config"), io);

    expect(result.entries.map((e) => e.alias)).toEqual(["tilde"]);
    expect(result.includeMissingCount).toBe(0);
  });

  it("uses an absolute Include path as given (⊘ joining it onto ~/.ssh produces ~/.ssh/etc/ssh/... and finds nothing)", async () => {
    const io = makeIo({
      [sshPath("config")]: "Include /etc/ssh/shared.conf\n",
      "/etc/ssh/shared.conf": "Host shared\n  HostName 10.0.0.11\n"
    });

    const result = await resolveSshConfig(sshPath("config"), io);

    expect(result.entries.map((e) => e.alias)).toEqual(["shared"]);
  });

  it("expands a glob over the directory listing, in sorted order (⊘ `node:fs`'s globSync typechecks against @types/node 22 and throws at runtime on the Node 20 CI builds on; relying on readdir order makes which duplicate wins depend on the filesystem)", async () => {
    const io = makeIo({
      [sshPath("config")]: "Include config.d/*.conf\n",
      [sshPath("config.d", "10-first.conf")]: "Host dup\n  HostName first.example.com\n",
      [sshPath("config.d", "20-second.conf")]: "Host dup\n  HostName second.example.com\nHost only2\n  HostName 10.0.0.12\n",
      [sshPath("config.d", "notes.txt")]: "Host ignored\n  HostName nope.example.com\n"
    });

    const result = await resolveSshConfig(sshPath("config"), io);

    expect(result.entries.map((e) => e.alias)).toEqual(["dup", "only2"]);
    // Sorted expansion means 10-first.conf is parsed first, so it wins the alias.
    expect(result.entries[0].host).toBe("first.example.com");
    expect(result.duplicateAliasCount).toBe(1);
    // ⊘ `*.conf` must not drag in the non-matching file.
    expect(result.entries.map((e) => e.alias)).not.toContain("ignored");
  });

  it("matches `?` and `[...]` but never crosses a directory with `*`, per glob(3) (⊘ implementing `**`-style matching pulls in a whole subtree the user never listed)", async () => {
    const io = makeIo({
      [sshPath("config")]: "Include config.d/host?.conf\nInclude config.d/set[12].conf\n",
      [sshPath("config.d", "host1.conf")]: "Host h1\n  HostName 10.0.0.21\n",
      [sshPath("config.d", "host22.conf")]: "Host h22\n  HostName 10.0.0.22\n",
      [sshPath("config.d", "set1.conf")]: "Host s1\n  HostName 10.0.0.23\n",
      [sshPath("config.d", "set9.conf")]: "Host s9\n  HostName 10.0.0.24\n",
      [sshPath("config.d", "nested", "deep.conf")]: "Host deep\n  HostName 10.0.0.25\n"
    });

    const result = await resolveSshConfig(sshPath("config"), io);

    expect(result.entries.map((e) => e.alias)).toEqual(["h1", "s1"]);
    expect(result.entries.map((e) => e.alias)).not.toContain("h22");
    expect(result.entries.map((e) => e.alias)).not.toContain("s9");
    expect(result.entries.map((e) => e.alias)).not.toContain("deep");
  });

  it("does not let a wildcard match a dotfile, per glob(3) (⊘ a regex-only `*` sweeps up editor backups and `.bak` droppings sitting next to the real configs)", async () => {
    const io = makeIo({
      [sshPath("config")]: "Include config.d/*\n",
      [sshPath("config.d", "real.conf")]: "Host real\n  HostName 10.0.0.26\n",
      [sshPath("config.d", ".hidden.conf.swp")]: "Host hidden\n  HostName 10.0.0.27\n"
    });

    const result = await resolveSshConfig(sshPath("config"), io);

    expect(result.entries.map((e) => e.alias)).toEqual(["real"]);
    expect(result.entries.map((e) => e.alias)).not.toContain("hidden");
  });

  it("splices included content AT the Include line, so an earlier include beats a later block (⊘ appending included entries after the root's own inverts first-match-wins and hands the user the shadowed definition)", async () => {
    const io = makeIo({
      [sshPath("config")]: "Include early.conf\n\nHost box\n  HostName from-root.example.com\n",
      [sshPath("early.conf")]: "Host box\n  HostName from-include.example.com\n"
    });

    const result = await resolveSshConfig(sshPath("config"), io);

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].host).toBe("from-include.example.com");
    expect(result.entries[0].host).not.toBe("from-root.example.com");
    expect(result.duplicateAliasCount).toBe(1);
  });

  it("splices a trailing Include after the root's own blocks, so the root wins there (⊘ resolving includes first, before the root file's own entries, breaks the mirror image of the same rule)", async () => {
    const io = makeIo({
      [sshPath("config")]: "Host box\n  HostName from-root.example.com\n\nInclude late.conf\n",
      [sshPath("late.conf")]: "Host box\n  HostName from-include.example.com\n"
    });

    const result = await resolveSshConfig(sshPath("config"), io);

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].host).toBe("from-root.example.com");
    expect(result.duplicateAliasCount).toBe(1);
  });

  it("tags each entry with the file it came from (⊘ losing the source makes an issue in a 12-file include tree unattributable)", async () => {
    const io = makeIo({
      [sshPath("config")]: "Include sub.conf\nHost root\n  HostName 10.0.0.30\n",
      [sshPath("sub.conf")]: "Host sub\n  HostName 10.0.0.31\n"
    });

    const result = await resolveSshConfig(sshPath("config"), io);

    expect(result.entries.map((e) => e.source)).toEqual([sshPath("sub.conf"), sshPath("config")]);
  });
});

describe("resolveSshConfig — include guards", () => {
  it(`stops descending past ${MAX_INCLUDE_DEPTH} levels and counts the refusal (⊘ no cap lets a deep or generated include tree recurse until the stack blows, taking the whole import with it)`, async () => {
    const files: Record<string, string> = {
      [sshPath("config")]: "Include c1.conf\n"
    };
    // c1..c16 each include the next; c16 sits at depth 16, so ITS include is
    // the first one the cap must refuse.
    for (let i = 1; i <= MAX_INCLUDE_DEPTH; i++) {
      files[sshPath(`c${i}.conf`)] = `Host h${i}\n  HostName 10.0.0.${i}\nInclude c${i + 1}.conf\n`;
    }
    files[sshPath(`c${MAX_INCLUDE_DEPTH + 1}.conf`)] = "Host toodeep\n  HostName 10.9.9.9\n";

    const io = makeIo(files);
    const result = await resolveSshConfig(sshPath("config"), io);

    expect(result.entries.map((e) => e.alias)).toEqual(
      Array.from({ length: MAX_INCLUDE_DEPTH }, (_, i) => `h${i + 1}`)
    );
    expect(result.includeDepthExceededCount).toBe(1);
    expect(result.issues.some((i) => i.reason.includes(`deeper than ${MAX_INCLUDE_DEPTH}`))).toBe(true);
    // ⊘ The file past the cap must never be read, and must contribute nothing.
    expect(io.reads).not.toContain(sshPath(`c${MAX_INCLUDE_DEPTH + 1}.conf`));
    expect(result.entries.map((e) => e.alias)).not.toContain("toodeep");
  });

  it("refuses a file that includes itself, counting the cycle (⊘ no visited-set means `Include config` inside ~/.ssh/config recurses until the depth cap — or forever — and the import hangs)", async () => {
    const io = makeIo({
      [sshPath("config")]: "Host box\n  HostName 10.0.0.40\nInclude config\n"
    });

    const result = await resolveSshConfig(sshPath("config"), io);

    expect(result.entries.map((e) => e.alias)).toEqual(["box"]);
    expect(result.includeCycleCount).toBe(1);
    expect(result.issues.some((i) => i.reason.includes("cycle"))).toBe(true);
    // ⊘ The root must be read exactly once.
    expect(io.reads.filter((p) => p === sshPath("config"))).toHaveLength(1);
  });

  it("refuses a mutual a→b→a include cycle (⊘ a per-branch depth counter alone still re-reads both files 16 times over, turning a two-file loop into 16 duplicate blocks)", async () => {
    const io = makeIo({
      [sshPath("config")]: "Include a.conf\n",
      [sshPath("a.conf")]: "Host a\n  HostName 10.0.0.41\nInclude b.conf\n",
      [sshPath("b.conf")]: "Host b\n  HostName 10.0.0.42\nInclude a.conf\n"
    });

    const result = await resolveSshConfig(sshPath("config"), io);

    expect(result.entries.map((e) => e.alias)).toEqual(["a", "b"]);
    expect(result.includeCycleCount).toBe(1);
    expect(result.duplicateAliasCount).toBe(0);
    expect(io.reads.filter((p) => p === sshPath("a.conf"))).toHaveLength(1);
  });

  it("expands the SAME file again under a second Host, because that is not a cycle (⊘ a whole-walk visited set skips the second `Include common` as a cycle, so `b` imports without the User/IdentityFile ssh(1) gives it — silently, and with a bogus cycle in the summary)", async () => {
    // `Host x` / `Include common` repeated per host is an ordinary layout. Under
    // the textual splice the second expansion is NOT redundant: it feeds a
    // different open block.
    const io = makeIo({
      [sshPath("config")]: "Host a\n  Include common.conf\n\nHost b\n  Include common.conf\n",
      [sshPath("common.conf")]: "User deploy\n  IdentityFile ~/.ssh/id_deploy\n"
    });

    const result = await resolveSshConfig(sshPath("config"), io);

    expect(result.entries.map((e) => ({ alias: e.alias, user: e.user, identityFile: e.identityFile }))).toEqual([
      { alias: "a", user: "deploy", identityFile: "~/.ssh/id_deploy" },
      { alias: "b", user: "deploy", identityFile: "~/.ssh/id_deploy" }
    ]);
    // ⊘ Nothing cyclic happened, so nothing may be reported as one.
    expect(result.includeCycleCount).toBe(0);
    expect(result.issues.some((i) => i.reason.includes("cycle"))).toBe(false);
    // The file really was read twice — the assertion above is not passing
    // because a single read happened to satisfy both blocks.
    expect(io.reads.filter((p) => p === sshPath("common.conf"))).toHaveLength(2);
  });

  it("still refuses a cycle when the looping file is ALSO included innocently elsewhere (⊘ swapping the visited set for no guard at all makes the repeated-include fix recurse forever on a self-include)", async () => {
    const io = makeIo({
      [sshPath("config")]: "Host a\n  Include leaf.conf\n\nHost b\n  Include loop.conf\n",
      [sshPath("leaf.conf")]: "User leafuser\n",
      // loop.conf pulls in leaf.conf (fine — leaf is closed by now) and itself.
      [sshPath("loop.conf")]: "Include leaf.conf\nInclude loop.conf\n"
    });

    const result = await resolveSshConfig(sshPath("config"), io);

    expect(result.entries.map((e) => ({ alias: e.alias, user: e.user }))).toEqual([
      { alias: "a", user: "leafuser" },
      { alias: "b", user: "leafuser" }
    ]);
    expect(result.includeCycleCount).toBe(1);
    expect(io.reads.filter((p) => p === sshPath("loop.conf"))).toHaveLength(1);
    expect(io.reads.filter((p) => p === sshPath("leaf.conf"))).toHaveLength(2);
  });

  it("is lenient about a missing include: an issue, a count, and every other host still imported (⊘ throwing on a stale `Include work.conf` costs the user all 200 hosts because of one deleted file)", async () => {
    const io = makeIo({
      [sshPath("config")]: "Include gone.conf\n\nHost survivor\n  HostName 10.0.0.50\n"
    });

    const result = await resolveSshConfig(sshPath("config"), io);

    expect(result.entries.map((e) => e.alias)).toEqual(["survivor"]);
    expect(result.includeMissingCount).toBe(1);
    expect(result.issues[0].reason).toContain("could not read");
    expect(result.issues[0].file).toBe(sshPath("gone.conf"));
  });

  it("is lenient about a glob that matches nothing (⊘ treating an empty expansion as a hard error kills the import for an empty, perfectly legal config.d directory)", async () => {
    const io = makeIo({
      [sshPath("config")]: "Include config.d/*.conf\n\nHost survivor\n  HostName 10.0.0.51\n"
    });

    const result = await resolveSshConfig(sshPath("config"), io);

    expect(result.entries.map((e) => e.alias)).toEqual(["survivor"]);
    expect(result.includeMissingCount).toBe(1);
    expect(result.issues[0].reason).toContain("matched no files");
  });

  it("returns an empty result, not a rejection, when the root config itself cannot be read (⊘ letting the read error escape turns 'you have no ~/.ssh/config' into an unhandled promise rejection)", async () => {
    const io = makeIo({});

    const result = await resolveSshConfig(sshPath("config"), io);

    expect(result.entries).toHaveLength(0);
    expect(result.includeMissingCount).toBe(1);
    expect(result.issues[0].reason).toContain("could not read");
  });

  it("carries the pure layer's counters and issues up through the walk, tagged with their file (⊘ a resolver that rebuilds the result from entries alone reports zero skipped wildcards and zero Match blocks no matter what the files held)", async () => {
    const io = makeIo({
      [sshPath("config")]: "Include sub.conf\nHost *\n  User default\n",
      [sshPath("sub.conf")]: "Match host *.internal\n  User vpn\n\nHost sub\n  Port bad\n"
    });

    const result = await resolveSshConfig(sshPath("config"), io);

    expect(result.wildcardPatternCount).toBe(1);
    expect(result.matchBlockCount).toBe(1);
    expect(result.entries.map((e) => e.alias)).toEqual(["sub"]);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0].file).toBe(sshPath("sub.conf"));
    expect(result.issues[0].reason).toContain("not a number");
  });

  it("follows every pattern on a multi-pattern Include line, left to right (⊘ resolving only patterns[0] silently drops the second half of `Include work.conf home.conf`)", async () => {
    const io = makeIo({
      [sshPath("config")]: "Include work.conf home.conf\n",
      [sshPath("work.conf")]: "Host work\n  HostName 10.0.0.60\n",
      [sshPath("home.conf")]: "Host home\n  HostName 10.0.0.61\n"
    });

    const result = await resolveSshConfig(sshPath("config"), io);

    expect(result.entries.map((e) => e.alias)).toEqual(["work", "home"]);
  });
});

/**
 * OpenSSH's `Include` is TEXTUAL: readconf.c reads the included file's lines in
 * place, inside whatever block is open at the `Include` line — which is why
 * ssh_config(5) documents it as usable "inside a Match or Host block to perform
 * conditional inclusion".
 *
 * Every test here fails against the shape this replaced, which re-parsed each
 * included file as a STANDALONE document and so threw away every directive
 * ahead of its first `Host` line.
 */
describe("resolveSshConfig — Include is textual, not a standalone re-parse", () => {
  it("gives the ENCLOSING Host block the pre-`Host` directives of the file it Includes, exactly as `ssh -G foo` reports them (⊘ re-parsing the include as its own document discards HostName/User entirely, so `foo` imports with its alias as its host and no user at all)", async () => {
    const io = makeIo({
      [sshPath("config")]: "Host foo\n  Include foo.conf\n",
      [sshPath("foo.conf")]: "HostName example.test\nUser bob\n"
    });

    const result = await resolveSshConfig(sshPath("config"), io);

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]).toMatchObject({ alias: "foo", host: "example.test", user: "bob" });
    // ⊘ The standalone-re-parse bug's exact output: alias as host, no user.
    expect(result.entries[0].host).not.toBe("foo");
    expect(result.entries[0].user).not.toBeUndefined();
    // ⊘ And the included directives must not invent a second, nameless entry.
    expect(result.entries.map((e) => e.alias)).toEqual(["foo"]);
  });

  it("lets an included file's own `Host` block END the enclosing one, so directives after the Include in the PARENT belong to the new block (⊘ scoping the include's effect to the included file re-opens the parent's block afterwards and files `User after` under `foo`)", async () => {
    const io = makeIo({
      [sshPath("config")]: "Host foo\n  Include sub.conf\n  User after\n",
      [sshPath("sub.conf")]: "HostName from-include.test\nHost bar\n  HostName bar.test\n"
    });

    const result = await resolveSshConfig(sshPath("config"), io);

    expect(result.entries.map((e) => e.alias)).toEqual(["foo", "bar"]);
    // The pre-`Host` line of sub.conf still lands on the enclosing block...
    expect(result.entries[0]).toMatchObject({ alias: "foo", host: "from-include.test" });
    // ...and `Host bar` closed it, so the parent's trailing User belongs to bar.
    expect(result.entries[1]).toMatchObject({ alias: "bar", host: "bar.test", user: "after" });
    // ⊘ `foo` must not pick up the directive that followed the Include.
    expect(result.entries[0].user).toBeUndefined();
  });

  it("treats an Include with no enclosing block as global defaults, importing nothing from it (⊘ synthesising a block to hold the spliced directives invents a phantom entry with an empty alias; leaking them forward hands `box` a user the config scoped to everything)", async () => {
    const io = makeIo({
      [sshPath("config")]: "Include defaults.conf\n\nHost box\n  HostName 10.0.0.70\n",
      [sshPath("defaults.conf")]: "User globaluser\nPort 9999\n"
    });

    const result = await resolveSshConfig(sshPath("config"), io);

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]).toMatchObject({ alias: "box", host: "10.0.0.70" });
    expect(result.entries[0].user).toBeUndefined();
    expect(result.entries[0].port).toBeUndefined();
    // ⊘ No phantom entry, under any spelling of "no alias".
    expect(result.entries.map((e) => e.alias)).not.toContain("");
    expect(result.entries.map((e) => e.alias)).not.toContain("defaults.conf");
    expect(result.issues).toHaveLength(0);
  });

  it("applies first-value-wins ACROSS the splice boundary: a value set before the Include beats the same keyword inside it (⊘ merging the included file's values over the block's own inverts ssh_config(5) first-obtained-value and connects as the wrong user)", async () => {
    const io = makeIo({
      [sshPath("config")]: "Host foo\n  User first\n  Include late.conf\n",
      [sshPath("late.conf")]: "User second\nHostName late.test\n"
    });

    const result = await resolveSshConfig(sshPath("config"), io);

    expect(result.entries[0].user).toBe("first");
    expect(result.entries[0].user).not.toBe("second");
    // The include IS applied — the keyword the block had not set still lands,
    // so the assertion above is not passing because nothing was spliced.
    expect(result.entries[0].host).toBe("late.test");
  });

  it("reports entry and issue lines as lines of the FILE they came from, not of the spliced document (⊘ handing back the assembled document's own line numbers points the user at line 4 of a two-line include that exists nowhere on disk)", async () => {
    const io = makeIo({
      [sshPath("config")]: "Host a\n  HostName 10.0.0.71\nInclude sub.conf\n",
      [sshPath("sub.conf")]: "Host b\n  Port bad\n"
    });

    const result = await resolveSshConfig(sshPath("config"), io);

    expect(result.entries.map((e) => ({ alias: e.alias, source: e.source, line: e.line }))).toEqual([
      { alias: "a", source: sshPath("config"), line: 1 },
      { alias: "b", source: sshPath("sub.conf"), line: 1 }
    ]);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0].file).toBe(sshPath("sub.conf"));
    // `Port bad` is line 2 of sub.conf, and line 4 of the spliced document.
    expect(result.issues[0].line).toBe(2);
    expect(result.issues[0].line).not.toBe(4);
  });

  it("does not follow a later Include that a PREVIOUSLY SPLICED file left inside an open Match (⊘ discovering includes by re-parsing each file standalone cannot see the leaked Match, follows the include, and the `Host` inside it exits the Match — importing a host gated behind a condition nobody evaluated)", async () => {
    const io = makeIo({
      // The parent's own text has no Match in it, which is the whole trap: only
      // the assembled stream shows that `Include gated.conf` is conditional.
      [sshPath("config")]:
        "Include opener.conf\nInclude gated.conf\n\nHost plain\n  HostName 10.0.0.80\n",
      [sshPath("opener.conf")]: 'Match exec "test -f /tmp/vpn"\n  User vpnuser\n',
      [sshPath("gated.conf")]: "Host gated\n  HostName 10.0.0.81\n"
    });

    const result = await resolveSshConfig(sshPath("config"), io);

    // `Host plain` is the line that ends the leaked Match, so it still imports.
    expect(result.entries.map((e) => e.alias)).toEqual(["plain"]);
    // ⊘ The conditional host must not appear, and its file must never be read.
    expect(result.entries.map((e) => e.alias)).not.toContain("gated");
    expect(io.reads).not.toContain(sshPath("gated.conf"));
    expect(result.matchBlockCount).toBe(1);
  });

  it("lets a Match opened inside an included file keep covering the PARENT's following lines (⊘ force-closing the block at end-of-include hands `box` the conditional `User`, which is a value ssh(1) only applies when the Match condition holds)", async () => {
    // The deliberate choice: the splice is textual, so readconf.c's single
    // Match state machine spans the file boundary. See assembleDocument.
    const io = makeIo({
      [sshPath("config")]: "Host box\n  HostName 10.0.0.82\nInclude opener.conf\n  User conditional\n",
      [sshPath("opener.conf")]: 'Match exec "true"\n'
    });

    const result = await resolveSshConfig(sshPath("config"), io);

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]).toMatchObject({ alias: "box", host: "10.0.0.82" });
    // ⊘ The conditional value must not reach the block the Include interrupted.
    expect(result.entries[0].user).toBeUndefined();
    expect(result.entries[0].user).not.toBe("conditional");
    expect(result.matchBlockCount).toBe(1);
  });

  it("merges a repeated alias that arrives from an INCLUDED file, exactly as one repeated in the same file (⊘ dropping the later block wholesale loses the User and key an included fragment adds to a host the root already declared — the splice is where most repeats actually come from)", async () => {
    const io = makeIo({
      [sshPath("config")]: "Host foo\n  HostName example.test\n\nInclude extra.conf\n",
      [sshPath("extra.conf")]: "Host foo\n  User bob\n  IdentityFile ~/.ssh/id_foo\n"
    });

    const result = await resolveSshConfig(sshPath("config"), io);

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]).toMatchObject({
      alias: "foo",
      host: "example.test",
      user: "bob",
      identityFile: "~/.ssh/id_foo"
    });
    expect(result.duplicateAliasCount).toBe(0);
    // Coordinates stay on the block that named the host.
    expect(result.entries[0].source).toBe(sshPath("config"));
    expect(result.entries[0].line).toBe(1);
  });

  it("resumes following Includes after a `Host` line closes the leaked Match (⊘ latching the Match flag once it is set swallows every remaining Include in the file and loses hosts ssh reads fine)", async () => {
    const io = makeIo({
      [sshPath("config")]: "Include opener.conf\nHost anchor\n  HostName 10.0.0.83\nInclude later.conf\n",
      [sshPath("opener.conf")]: 'Match exec "true"\n',
      [sshPath("later.conf")]: "Host later\n  HostName 10.0.0.84\n"
    });

    const result = await resolveSshConfig(sshPath("config"), io);

    expect(result.entries.map((e) => e.alias)).toEqual(["anchor", "later"]);
    expect(io.reads).toContain(sshPath("later.conf"));
  });
});
