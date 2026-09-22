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

  it("holds a bad Port bad across a REPEATED alias too, not only inside one block — both paths state the same policy (⊘ testing `port === undefined` at the merge lets a second block's Port fill the slot the first block's garbage already claimed, so the identical two lines mean one thing written in one block and the opposite in two)", () => {
    const oneBlock = parseSshConfig("Host foo\n  Port notanumber\n  Port 2222\n");
    const twoBlocks = parseSshConfig("Host foo\n  Port notanumber\n\nHost foo\n  Port 2222\n");

    expect(oneBlock.entries[0].port).toBeUndefined();
    expect(twoBlocks.entries).toHaveLength(1);
    expect(twoBlocks.entries[0].port).toBeUndefined();
    // The second block really did contribute nothing, so it is the dead text the counter claims.
    expect(twoBlocks.duplicateAliasCount).toBe(1);
  });

  it("keeps a good first Port when a later block repeats the alias with a bad one, the other order round (⊘ validating at the merge instead of at the block lets the later garbage overwrite a working port)", () => {
    const result = parseSshConfig("Host foo\n  Port 2222\n\nHost foo\n  Port notanumber\n");
    expect(result.entries[0].port).toBe(2222);
  });

  it("still lets a later block supply a Port the earlier block never mentioned (⊘ setting the obtained bit for every block rather than only for the ones that wrote a Port blocks every merge, and a host whose Port lives in its second block imports on 22)", () => {
    const result = parseSshConfig("Host foo\n  HostName 10.0.0.83\n\nHost foo\n  Port 2222\n");
    expect(result.entries[0].port).toBe(2222);
    expect(result.duplicateAliasCount).toBe(0);
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

  it('RECOVERS from a quoted empty value, leaving a later line in the block free to supply the real one — importer policy, NOT ssh fidelity: OpenSSH 9.6 rejects the empty argument and `ssh -G` exits 255 with `Missing argument`, reading no further (⊘ storing "" hands the connector an IdentityFile that names no file, and the block\'s real key path is then discarded as a repeat)', () => {
    const result = parseSshConfig('Host box\n  IdentityFile ""\n  IdentityFile ~/.ssh/id_real\n');
    expect(result.entries[0].identityFile).toBe("~/.ssh/id_real");
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0].reason).toContain("has no value");
  });

  it("⊘ keeps only the FIRST IdentityFile and silently drops the rest, though OpenSSH ACCUMULATES them — a deliberate departure, since an imported server row holds exactly one key path (a last-wins rule would import the wrong key with nothing to show it happened)", () => {
    const result = parseSshConfig("Host box\n  IdentityFile ~/.ssh/id_first\n  IdentityFile ~/.ssh/id_second\n");
    expect(result.entries[0].identityFile).toBe("~/.ssh/id_first");
    expect(result.issues).toHaveLength(0);
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

  it("cancels a positive alias that a `!` on the same line negates, so `Host foo bar !foo` applies to `bar` alone (⊘ counting the negation and then emitting `foo` anyway imports the ONE host the user carved out, handing it the exception's destination, account and key)", () => {
    const result = parseSshConfig(`Host foo bar !foo
  HostName shared.example.com
  User ops
`);
    expect(result.entries.map((e) => e.alias)).toEqual(["bar"]);
    expect(result.entries[0]).toMatchObject({ host: "shared.example.com", user: "ops" });
    expect(result.negatedPatternCount).toBe(1);
  });

  it("cancels with a GLOB negation too — `!*.internal` subtracts every alias on the line that matches it (⊘ comparing the negation as a literal string leaves db.internal and app.internal imported, which is the exact shape `!` exists to write)", () => {
    const result = parseSshConfig(`Host db.internal app.internal edge.dmz !*.internal
  User ops
`);
    expect(result.entries.map((e) => e.alias)).toEqual(["edge.dmz"]);
    expect(result.entries.map((e) => e.alias)).not.toContain("db.internal");
  });

  it("cancels case-SENSITIVELY, as `match_pattern()` compares (⊘ an `i` flag makes `!foo` cancel `Foo` and drops a profile OpenSSH keeps — confirmed against OpenSSH_9.6p1: `ssh -G -F <file> Foo` on `Host Foo bar !foo` applies the block to `Foo`)", () => {
    const result = parseSshConfig("Host Foo bar !foo\n  User ops\n");
    expect(result.entries.map((e) => e.alias)).toEqual(["Foo", "bar"]);
  });

  it("⊘ still cancels an EXACT-case match, so dropping the `i` flag did not disable negation itself", () => {
    const result = parseSshConfig("Host foo bar !foo\n  User ops\n");
    expect(result.entries.map((e) => e.alias)).toEqual(["bar"]);
  });

  it("opens NO block when the negations cancel every alias on the line, so what follows describes nothing (⊘ opening a block with an empty alias list emits a nameless entry the tree renders as a blank server row)", () => {
    const result = parseSshConfig(`Host box
  HostName 10.0.0.80

Host foo !foo
  HostName cancelled.example.com
  User ops
`);
    expect(result.entries.map((e) => e.alias)).toEqual(["box"]);
    expect(result.entries[0].host).toBe("10.0.0.80");
    expect(result.entries.map((e) => e.alias)).not.toContain("");
    expect(result.entries.map((e) => e.alias)).not.toContain("foo");
  });

  it("⊘ still counts the negations it now applies — negatedPatternCount reports the `!` patterns, which is what it says, not the aliases they cancelled (dropping the counter once the subtraction works leaves the import summary claiming nothing on the line was skipped)", () => {
    const result = parseSshConfig("Host foo bar !foo !*.internal\n  User ops\n");
    expect(result.negatedPatternCount).toBe(2);
    expect(result.entries.map((e) => e.alias)).toEqual(["bar"]);
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

  it('ignores a quoted empty `Host ""` token and keeps the rest of the line — recovery, not fidelity: real ssh rejects the empty argument and abandons the config, which would cost the user every host in the file (⊘ pushing it emits a phantom entry whose alias is the empty string — a blank, unconnectable row in the server tree, same defect as the include-shaped phantom pinned below)', () => {
    const result = parseSshConfig('Host "" foo\n  HostName 10.0.0.81\n');
    expect(result.entries.map((e) => e.alias)).toEqual(["foo"]);
    expect(result.entries.map((e) => e.alias)).not.toContain("");
    expect(result.issues).toHaveLength(0);
  });

  it('reports `Host ""` on its own exactly as a bare `Host`: no patterns, no block, one issue — the recovery ssh does not do, since it would exit 255 on the empty argument (⊘ treating the empty token as a pattern opens a block for it and every following directive lands on a nameless entry)', () => {
    const result = parseSshConfig('Host ""\n  HostName 10.0.0.82\n');
    expect(result.entries).toHaveLength(0);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0].reason).toContain("no patterns");
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

  it("keeps a SINGLE-quoted value with spaces intact — argv_split() quotes on `'` exactly as it does on `\"`, and `ssh -G` reports `identityfile /tmp/my key` for it (⊘ tracking only the double quote splits at the space and hands the profile the unusable key path `'/tmp/my`)", () => {
    const result = parseSshConfig("Host box\n  IdentityFile '/tmp/my key'\n");
    expect(result.entries[0].identityFile).toBe("/tmp/my key");
    expect(result.entries[0].identityFile).not.toContain("'");
  });

  it("⊘ treats a `\"` inside single quotes and a `'` inside double quotes as literal characters — only the character that OPENED a run can close it (one shared boolean lets either quote close the other's run, so the rest of the line spills back out of quoting and splits at the next space)", () => {
    expect(parseSshConfig("Host box\n  IdentityFile '/tmp/it\"s here'\n").entries[0].identityFile).toBe('/tmp/it"s here');
    expect(parseSshConfig("Host box\n  IdentityFile \"/tmp/it's here\"\n").entries[0].identityFile).toBe("/tmp/it's here");
  });

  it("lets a quote open a quoted run MID-token and keeps the token going after it closes, as argv_split does (⊘ quoting only a token that STARTS with a quote splits `/tmp/'my key'.pub` into two arguments and loses the extension)", () => {
    expect(parseSshConfig("Host box\n  IdentityFile /tmp/'my key'.pub\n").entries[0].identityFile).toBe("/tmp/my key.pub");
    const fanned = parseSshConfig("Host 'a b' c\n  HostName 10.0.0.1\n");
    expect(fanned.entries.map((e) => e.alias)).toEqual(["a b", "c"]);
  });

  it("⊘ recognises `\\\\` inside single quotes but leaves an escaped space there alone — these are argv_split runs, NOT shell-style literal runs (a literal-run rule keeps the backslash in `'/tmp/a\\\\b'` and points IdentityFile at a path ssh never opens)", () => {
    expect(parseSshConfig("Host box\n  IdentityFile '/tmp/a\\\\b'\n").entries[0].identityFile).toBe("/tmp/a\\b");
    expect(parseSshConfig("Host box\n  IdentityFile '/tmp/my\\ key'\n").entries[0].identityFile).toBe("/tmp/my\\ key");
  });

  it("reads `\\'` as a literal single quote that neither opens nor closes a quoted run (⊘ opening a run on it swallows the following space and merges two Host patterns into one alias)", () => {
    const result = parseSshConfig("Host a\\'b c\n  HostName 10.0.0.1\n");
    expect(result.entries.map((e) => e.alias)).toEqual(["a'b", "c"]);
  });

  it("⊘ still ends the line at a `#` once a single-quoted value has closed (leaving the quote state stuck open turns ` # prod` into part of the key path)", () => {
    const result = parseSshConfig("Host box\n  IdentityFile '/tmp/my key' # prod\n");
    expect(result.entries[0].identityFile).toBe("/tmp/my key");
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
  it("resolves a relative Include against ~/.ssh for a USER config — never against the directory of the file doing the including, and never against a base the INCLUDED file's location suggests (⊘ the intuitive `dirname(includingFile)` rule reads a completely different file, here /etc/ssh/extra.conf; deciding the base per file rather than per walk reads that same decoy)", async () => {
    const io = makeIo({
      [sshPath("config")]: "Include /etc/ssh/main.conf\n",
      "/etc/ssh/main.conf": "Include extra.conf\n",
      "/etc/ssh/extra.conf": "Host decoy\n  HostName wrong.example.com\n",
      [sshPath("extra.conf")]: "Host fromhome\n  HostName right.example.com\n"
    });

    const result = await resolveSshConfig(sshPath("config"), io);

    expect(result.entries.map((e) => e.alias)).toEqual(["fromhome"]);
    expect(result.entries[0].host).toBe("right.example.com");
    // ⊘ The sibling-directory file must never be read: this walk is rooted in a
    // user config, so every relative Include in it resolves under ~/.ssh.
    expect(io.reads).not.toContain("/etc/ssh/extra.conf");
    expect(result.entries.map((e) => e.alias)).not.toContain("decoy");
  });

  it("resolves a relative Include against /etc/ssh when the ROOT is the system config, which is the other half of the ssh_config(5) rule (⊘ hard-coding ~/.ssh sends a user who imported /etc/ssh/ssh_config to their own config.d instead of the system's — reading a file ssh would not read there, and reporting the one it would as missing)", async () => {
    const io = makeIo({
      "/etc/ssh/ssh_config": "Include extra.conf\n",
      "/etc/ssh/extra.conf": "Host system\n  HostName right.example.com\n",
      [sshPath("extra.conf")]: "Host fromhome\n  HostName wrong.example.com\n"
    });

    const result = await resolveSshConfig("/etc/ssh/ssh_config", io);

    expect(result.entries.map((e) => e.alias)).toEqual(["system"]);
    expect(result.entries[0].host).toBe("right.example.com");
    expect(io.reads).not.toContain(sshPath("extra.conf"));
    expect(result.includeMissingCount).toBe(0);
  });

  it("⊘ does NOT expand `~user/...` in an Include path: it stays literal, resolves under the include base and is reported missing (deliberate — `~other` names ANOTHER account's home, and quietly reading OUR home instead would import a different file under a name the user would never question)", async () => {
    const otherHome = path.join(path.sep, "home", "other", "hosts.conf");
    const io = makeIo({
      [sshPath("config")]: "Include ~other/hosts.conf\n",
      [otherHome]: "Host theirs\n  HostName 10.0.0.85\n",
      [sshPath("hosts.conf")]: "Host ours\n  HostName 10.0.0.86\n"
    });

    const result = await resolveSshConfig(sshPath("config"), io);

    expect(result.entries).toHaveLength(0);
    expect(io.reads).toContain(sshPath("~other", "hosts.conf"));
    expect(io.reads).not.toContain(otherHome);
    expect(io.reads).not.toContain(sshPath("hosts.conf"));
    expect(result.includeMissingCount).toBe(1);
    expect(result.issues[0].reason).toContain("could not read");
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

  it("matches `?` and `[...]` against the basename, per glob(3) (⊘ compiling `?` as a regex `.*`, or `[12]` as literal text, either drags in host22.conf or finds nothing at all)", async () => {
    const io = makeIo({
      [sshPath("config")]: "Include config.d/host?.conf\nInclude config.d/set[12].conf\n",
      [sshPath("config.d", "host1.conf")]: "Host h1\n  HostName 10.0.0.21\n",
      [sshPath("config.d", "host22.conf")]: "Host h22\n  HostName 10.0.0.22\n",
      [sshPath("config.d", "set1.conf")]: "Host s1\n  HostName 10.0.0.23\n",
      [sshPath("config.d", "set9.conf")]: "Host s9\n  HostName 10.0.0.24\n"
    });

    const result = await resolveSshConfig(sshPath("config"), io);

    expect(result.entries.map((e) => e.alias)).toEqual(["h1", "s1"]);
    expect(result.entries.map((e) => e.alias)).not.toContain("h22");
    expect(result.entries.map((e) => e.alias)).not.toContain("s9");
  });

  /**
   * The listing io hands back is the whole of what a glob may match: what keeps
   * an include inside one directory is that the expander never descends, NOT the
   * `[^/]` in the compiled pattern — matching only ever runs on a basename, so
   * no test can tell `[^/]` from `.`. This one pins the property that IS
   * observable, with a listing that really does name a subdirectory, because the
   * fixture this replaced listed none and asserted the absence of a host that
   * nothing could have produced.
   */
  it("never descends into a subdirectory the listing names — no `**`, and no stat-then-recurse (⊘ implementing `**`-style matching, or recursing into any name that is not a file, pulls in a whole subtree the user never listed)", async () => {
    const deepPath = sshPath("config.d", "nested", "deep.conf");
    const files: Record<string, string> = {
      [sshPath("config")]: "Include config.d/*.conf\n",
      [sshPath("config.d", "real.conf")]: "Host real\n  HostName 10.0.0.25\n",
      [deepPath]: "Host deep\n  HostName 10.0.0.26\n"
    };
    const reads: string[] = [];
    const listed: string[] = [];
    const io: SshConfigIo & { reads: string[]; listed: string[] } = {
      reads,
      listed,
      async readFile(filePath: string): Promise<string | undefined> {
        reads.push(filePath);
        return Object.prototype.hasOwnProperty.call(files, filePath) ? files[filePath] : undefined;
      },
      async readDir(dir: string): Promise<string[]> {
        listed.push(dir);
        // Unlike makeIo, this listing names the SUBDIRECTORY as well as the file
        // — which is what a real readdir does, and what the expander must not
        // follow.
        if (dir === sshPath("config.d")) {
          return ["real.conf", "nested"];
        }
        if (dir === sshPath("config.d", "nested")) {
          return ["deep.conf"];
        }
        return [];
      }
    };

    const result = await resolveSshConfig(sshPath("config"), io);

    expect(result.entries.map((e) => e.alias)).toEqual(["real"]);
    expect(result.entries.map((e) => e.alias)).not.toContain("deep");
    expect(io.reads).not.toContain(deepPath);
    expect(io.listed).not.toContain(sshPath("config.d", "nested"));
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

  it("is lenient about an Include glob whose bracket range cannot compile: an issue, a count, and the rest of the import survives — ssh(1) 9.6 accepts the config and simply matches nothing (⊘ interpolating the pattern straight into `new RegExp` throws `SyntaxError: Range out of order in character class`, which escapes resolveSshConfig as a REJECTION and costs the user every host in the file)", async () => {
    const io = makeIo({
      [sshPath("config")]: "Include config.d/[z-a]\n\nHost survivor\n  HostName 10.0.0.52\n",
      [sshPath("config.d", "a.conf")]: "Host never\n  HostName 10.0.0.53\n"
    });

    // Asserted as RESOLVES, not merely "has these entries": the defect this pins
    // is a rejected promise, and a test that only awaits the value reports it as
    // a thrown error rather than as the contract violation it actually is.
    const run = resolveSshConfig(sshPath("config"), io);
    await expect(run).resolves.toBeTruthy();
    const result = await run;

    expect(result.entries.map((e) => e.alias)).toEqual(["survivor"]);
    expect(result.includeMissingCount).toBe(1);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0].reason).toContain("not a valid glob");
    expect(result.issues[0].file).toBe(sshPath("config"));
    expect(result.issues[0].line).toBe(1);
  });

  it("treats `[!]` as the literal characters glob(3) makes of it, an empty set being no set at all (⊘ mapping the leading `!` to `^` compiles `[^]`, which in JavaScript matches ANY single character, so `Include config.d/[!]` quietly swallows every one-character file in the directory)", async () => {
    const io = makeIo({
      [sshPath("config")]: "Include config.d/[!]\n\nHost survivor\n  HostName 10.0.0.54\n",
      [sshPath("config.d", "a")]: "Host onechar\n  HostName 10.0.0.55\n",
      [sshPath("config.d", "b")]: "Host otherchar\n  HostName 10.0.0.56\n"
    });

    const result = await resolveSshConfig(sshPath("config"), io);

    expect(result.entries.map((e) => e.alias)).toEqual(["survivor"]);
    expect(result.entries.map((e) => e.alias)).not.toContain("onechar");
    expect(result.entries.map((e) => e.alias)).not.toContain("otherchar");
    expect(result.includeMissingCount).toBe(1);
    expect(result.issues[0].reason).toContain("matched no files");
  });

  it("reads a `]` in FIRST position as an ordinary member of the set, per glob(3) (⊘ scanning for the terminator straight from the `[` ends the set immediately, and `[]a]` compiles to an empty class that matches nothing followed by a literal `a]`)", async () => {
    const io = makeIo({
      [sshPath("config")]: "Include config.d/[]a].conf\n",
      [sshPath("config.d", "a.conf")]: "Host member\n  HostName 10.0.0.57\n"
    });

    const result = await resolveSshConfig(sshPath("config"), io);

    expect(result.entries.map((e) => e.alias)).toEqual(["member"]);
    expect(result.includeMissingCount).toBe(0);
  });

  it("⊘ escapes a backslash inside a bracket class before copying it into the regex source, so the class still compiles (dropping the escape makes `[a\\]` an unterminated class, `new RegExp` throws, and a pattern that names a real file is reported as an invalid glob that matched nothing — glob(3)'s own backslash-as-escape rule is separately not modelled)", async () => {
    const io = makeIo({
      [sshPath("config")]: "Include config.d/[a\\].conf\n",
      [sshPath("config.d", "a.conf")]: "Host classy\n  HostName 10.0.0.58\n"
    });

    const result = await resolveSshConfig(sshPath("config"), io);

    expect(result.entries.map((e) => e.alias)).toEqual(["classy"]);
    expect(result.includeMissingCount).toBe(0);
    expect(result.issues).toHaveLength(0);
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

  it("resolves — never rejects — for an INCLUDED file of a few hundred thousand lines (⊘ splicing a child's lines with `assembled.push(...child)` spreads 200,000 elements as call arguments and V8 throws `RangeError: Maximum call stack size exceeded`; it escapes as a promise REJECTION, the import command has no catch, and the user gets a raw command-failure toast and zero hosts — from a ~1.6 MB file, well inside the 2 MiB the import path allows)", async () => {
    // Generated rather than fixtured: a file this size has no business in the
    // repo, and the defect is about the COUNT of lines, which a generator states
    // exactly. Only an INCLUDED file can hit it — the root's own lines are
    // pushed one at a time.
    const io = makeIo({
      [sshPath("config")]: "Include big.conf\n",
      [sshPath("big.conf")]: `${"# filler\n".repeat(200_000)}Host huge\n  HostName 10.0.0.99\n`
    });

    // Asserted as RESOLVES, not merely "has these entries": the contract this
    // pins is that the promise settles, and a test that only awaits the value
    // reports the violation as a thrown error rather than as what it is.
    const run = resolveSshConfig(sshPath("config"), io);
    await expect(run).resolves.toBeTruthy();
    const result = await run;

    expect(result.entries.map((e) => e.alias)).toEqual(["huge"]);
    // Line origins still survive the splice at that size.
    expect(result.entries[0].source).toBe(sshPath("big.conf"));
    expect(result.entries[0].line).toBe(200_001);
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

/**
 * The signal answers exactly one caller question — "is this file even an ssh
 * config?" — and it is asked AFTER resolveSshConfig has consumed every Include,
 * which can leave entries 0 / includes 0 / every counter 0 for a config that is
 * perfectly valid. These pin both halves: true for the shapes that import
 * nothing, false for the two formats the importer must not mistake for a config.
 */
describe("sawSshGrammar — the recognised-grammar signal", () => {
  it("is true for a defaults-only `Host *` config, which yields no entries at all (⊘ answering the question with entries.length reports a valid config as the wrong kind of file)", () => {
    const result = parseSshConfig("Host *\n  User ops\n  Port 2222\n");
    expect(result.entries).toHaveLength(0);
    expect(result.sawSshGrammar).toBe(true);
  });

  it("is true for a keyword-only config with no block header at all — globals are grammar too (⊘ keying the signal off Host/Match headers alone misses a config that is nothing but defaults)", () => {
    const result = parseSshConfig("User ops\nPort 2222\n");
    expect(result.entries).toHaveLength(0);
    expect(result.sawSshGrammar).toBe(true);
  });

  it("is true for a Match-only config (⊘ a signal that ignores Match calls a conditional-only config not an ssh config)", () => {
    expect(parseSshConfig('Match exec "true"\n  User vpn\n').sawSshGrammar).toBe(true);
  });

  it("survives the include splice: an include-only root whose glob resolves to nothing still reports grammar, though entries, includes and every counter come back zero (⊘ leaving the signal to the parse of the ASSEMBLED document reports false for the one shape it exists for — the Include line is consumed by the splice, so the document parsed is empty)", async () => {
    const io = makeIo({ [sshPath("config")]: "Include config.d/*\n" });

    const result = await resolveSshConfig(sshPath("config"), io);

    expect(result.entries).toHaveLength(0);
    expect(result.includes).toHaveLength(0);
    expect(result.wildcardPatternCount).toBe(0);
    expect(result.negatedPatternCount).toBe(0);
    expect(result.matchBlockCount).toBe(0);
    expect(result.includeMissingCount).toBe(1);
    expect(result.sawSshGrammar).toBe(true);
  });

  /**
   * The resolver ORs two independent sources: the assembler raises the flag for
   * every `Include` line the splice CONSUMES, and the parse of the assembled
   * document raises it for everything else. A fixture that supplies BOTH halves
   * cannot tell an OR from either assignment — which is what the single test
   * these two replace did, with an `Include` root AND a `Host` in the included
   * file. Each of these supplies exactly one half.
   */
  it("takes the PARSED document's grammar, for a root with no Include at all (⊘ `result.sawSshGrammar = result.sawSshGrammar` keeps only the assembler's half, and a lowercase `host`/`hostname` config — which the format sniffer's case-sensitive regex already fails to recognise — is then called the wrong kind of file and imported as a host list)", async () => {
    const io = makeIo({ [sshPath("config")]: "host inner\n  hostname 10.0.0.90\n" });

    const result = await resolveSshConfig(sshPath("config"), io);

    expect(result.entries.map((e) => e.alias)).toEqual(["inner"]);
    expect(result.sawSshGrammar).toBe(true);
  });

  it("takes the ASSEMBLER's grammar, for a root whose only grammar is the Include line the splice consumed (⊘ `result.sawSshGrammar = parsed.sawSshGrammar` keeps only the parsed document's half, and here that document is EMPTY: the Include line no longer exists and the directory it named holds nothing)", async () => {
    const io = makeIo({
      [sshPath("config")]: "Include config.d/*.conf\n",
      // The directory exists and is listable, and holds nothing the glob matches.
      [sshPath("config.d", ".keep")]: ""
    });

    const result = await resolveSshConfig(sshPath("config"), io);

    expect(result.entries).toHaveLength(0);
    expect(result.includeMissingCount).toBe(1);
    expect(result.sawSshGrammar).toBe(true);
  });

  it("⊘ is false for a CSV host list, whose lines open with a value and never with a keyword (a signal that counts any line the parser touched as grammar makes the importer treat a CSV as an ssh config and answer 'no hosts found' instead of naming the real format)", () => {
    const result = parseSshConfig("10.0.0.1,sw1,admin\n10.0.0.2,sw2,admin\n");
    expect(result.entries).toHaveLength(0);
    expect(result.sawSshGrammar).toBe(false);
  });

  it("⊘ is false for a MobaXterm INI body, whose `Key=value` lines DO parse as directives but carry no keyword this parser models (a signal keyed on 'the line matched KEYWORD_LINE_RE' is true here and misroutes every MobaXterm export)", () => {
    const result = parseSshConfig("[Bookmarks]\nSubRep=\nImgNum=42\nsw1=#109#0%10.0.0.1%22%admin%%-1%\n");
    expect(result.entries).toHaveLength(0);
    expect(result.sawSshGrammar).toBe(false);
  });

  it("⊘ is false when the root config cannot be read at all — nothing was parsed, so nothing was recognised", async () => {
    const result = await resolveSshConfig(sshPath("config"), makeIo({}));

    expect(result.sawSshGrammar).toBe(false);
  });
});
