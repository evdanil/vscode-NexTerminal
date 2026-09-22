import * as os from "node:os";
import { describe, expect, it } from "vitest";
import { convertSshConfig, expandSshTokens, localLoginName } from "../../src/utils/sshConfigImport";
import { parseSshConfig, type SshConfigEntry, type SshConfigParseResult } from "../../src/utils/sshConfigParser";

/**
 * The pure half of the ssh-config importer: parse result in, importable
 * sessions out. No `vscode`, no `fs` — the command-level behaviour (dialogs,
 * size guard, dedupe against existing servers) lives in
 * `configImportExport.test.ts`.
 */
function convert(text: string, defaultUsername = "localuser") {
  return convertSshConfig(parseSshConfig(text), { defaultUsername });
}

/**
 * A parse result carrying exactly these entries and nothing else. Built from a
 * real empty parse rather than an object literal, so it keeps every counter
 * the parser adds without this file having to track them — the converter is
 * what is under test here, not the parser's shape.
 */
function parsedWith(entries: SshConfigEntry[]): SshConfigParseResult {
  return { ...parseSshConfig(""), entries };
}

describe("convertSshConfig", () => {
  it("gives an IdentityFile host key auth and the key's path — the whole point of the feature (⊘ hardcoded authType \"password\" prompts every key-based host for a password that does not exist)", () => {
    const result = convert("Host web\n  HostName web.example.com\n  User deploy\n  IdentityFile /keys/id_ed25519\n");

    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0].authType).toBe("key");
    expect(result.sessions[0].keyPath).toBe("/keys/id_ed25519");
  });

  it("expands ~ in IdentityFile — ssh2Connector readFile()s keyPath verbatim, so a stored ~/.ssh/id_ed25519 is an ENOENT at connect time", () => {
    const result = convert("Host web\n  IdentityFile ~/.ssh/id_ed25519\n");

    expect(result.sessions[0].keyPath).toBe(`${os.homedir()}/.ssh/id_ed25519`);
  });

  it("⊘ leaves ~otheruser/... verbatim — expanding it would hand another user's home to this server", () => {
    const result = convert("Host web\n  IdentityFile ~bob/.ssh/id_ed25519\n");

    expect(result.sessions[0].keyPath).toBe("~bob/.ssh/id_ed25519");
    expect(result.sessions[0].keyPath).not.toContain(os.homedir());
  });

  it("⊘ leaves a host with no IdentityFile on password auth and sets no keyPath (kills a blanket authType: \"key\")", () => {
    const result = convert("Host web\n  HostName web.example.com\n");

    expect(result.sessions[0].authType).toBe("password");
    expect(result.sessions[0].keyPath).toBeUndefined();
  });

  it("treats `IdentityFile none` as ssh_config(5)'s \"no identity file\" sentinel, not a path (⊘ storing keyPath \"none\" makes the profile key-auth on a file the connector cannot read, so it never connects)", () => {
    const result = convert("Host web\n  HostName web.example.com\n  IdentityFile none\n");

    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0].keyPath).toBeUndefined();
    expect(result.sessions[0].authType).toBe("password");
    // Not a key we failed to use — a key the user said not to use. The counter
    // the confirm modal reports must not claim a loss that did not happen.
    expect(result.droppedIdentityFileCount).toBe(0);
    expect(result.skippedCount).toBe(0);
  });

  it("⊘ only the exact lowercase word `none` is the sentinel — a real path keeps key auth, including one that merely contains or is named after it (kills a substring or case-insensitive match)", () => {
    const paths = ["/keys/none.pem", "/keys/none", "none.pem", "None", "NONE", "./none"];

    for (const p of paths) {
      const result = convert(`Host web\n  IdentityFile ${p}\n`);
      expect(result.sessions[0].authType, p).toBe("key");
      expect(result.sessions[0].keyPath, p).toBe(p);
    }
  });

  it("carries a backslash-escaped space in IdentityFile through to keyPath (⊘ the tokenizer flushing at the escaped space stores `/tmp/my\\` and the profile is key-auth on a path that does not exist)", () => {
    const result = convert("Host web\n  IdentityFile /tmp/my\\ key\n");

    expect(result.sessions[0].keyPath).toBe("/tmp/my key");
    expect(result.sessions[0].authType).toBe("key");
  });

  it("⊘ keeps a quoted `none` a sentinel — ssh strips the quotes before comparing, so `\"none\"` disables the identity file just as the bare word does", () => {
    const result = convert('Host web\n  IdentityFile "none"\n');

    expect(result.sessions[0].keyPath).toBeUndefined();
    expect(result.sessions[0].authType).toBe("password");
  });

  it("expands %h in HostName to the alias (⊘ passing it through creates a server at the literal host \"%h.example.com\" that can never resolve)", () => {
    const result = convert("Host web1\n  HostName %h.example.com\n");

    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0].host).toBe("web1.example.com");
    expect(result.unsupportedTokenCount).toBe(0);
  });

  it("expands %h in IdentityFile to the RESOLVED hostname, not the alias (⊘ expanding it to the alias stores a key path that does not exist — and since an IdentityFile makes the profile key-auth, the connection fails on it)", () => {
    const result = convert("Host foo\n  HostName 127.0.0.1\n  IdentityFile /tmp/id_%h\n");

    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0].keyPath).toBe("/tmp/id_127.0.0.1");
    expect(result.sessions[0].keyPath).not.toBe("/tmp/id_foo");
    expect(result.sessions[0].authType).toBe("key");
    expect(result.droppedIdentityFileCount).toBe(0);
  });

  it("⊘ still expands %h in HostName itself to the ALIAS — the two sites take different values, and moving IdentityFile's fix to the HostName site breaks the host instead", () => {
    const result = convert("Host web1\n  HostName %h.example.com\n  IdentityFile /keys/id_%h\n");

    expect(result.sessions[0].host).toBe("web1.example.com");
    expect(result.sessions[0].host).not.toBe("%h.example.com");
    // Downstream of HostName, %h is the resolved host — i.e. the EXPANDED HostName.
    expect(result.sessions[0].keyPath).toBe("/keys/id_web1.example.com");
  });

  it("uses the alias for %h in IdentityFile when the block sets no HostName — there the alias IS the resolved host", () => {
    const result = convert("Host foo\n  IdentityFile /tmp/id_%h\n");

    expect(result.sessions[0].keyPath).toBe("/tmp/id_foo");
  });

  it("expands %% to a literal percent, and reads %%h as a literal \"%h\" rather than an expansion (⊘ a naive replace() of %h first turns the escape into an expansion)", () => {
    expect(expandSshTokens("a%%b", "web")).toBe("a%b");
    expect(expandSshTokens("%%h", "web")).toBe("%h");
    expect(expandSshTokens("%h%%%h", "web")).toBe("web%web");
  });

  it("SKIPS and counts a host whose HostName keeps an unexpandable token (⊘ importing it yields a row that looks imported and can never connect)", () => {
    const result = convert("Host one\n  HostName %h.example.com\n\nHost two\n  HostName %C.example.com\n\nHost three\n  HostName %d\n");

    expect(result.sessions.map((s) => s.name)).toEqual(["one"]);
    expect(result.unsupportedTokenCount).toBe(2);
    // Rolled into the count the confirm modal reports as "wildcard or unsupported".
    expect(result.skippedCount).toBe(2);
  });

  it("⊘ treats a trailing bare % as unexpandable rather than passing it through", () => {
    expect(expandSshTokens("host%", "web")).toBeUndefined();
    expect(convert("Host one\n  HostName host%\n").sessions).toHaveLength(0);
  });

  it("keeps the HOST but drops the key when only the IdentityFile has an unexpandable token — a host that cannot be connected at all is not the same loss as one that falls back to a password", () => {
    const result = convert("Host web\n  HostName web.example.com\n  IdentityFile ~/.ssh/%C_key\n");

    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0].host).toBe("web.example.com");
    expect(result.sessions[0].authType).toBe("password");
    expect(result.sessions[0].keyPath).toBeUndefined();
    expect(result.droppedIdentityFileCount).toBe(1);
    // NOT counted as a skipped entry: nothing was skipped, the host imported.
    expect(result.unsupportedTokenCount).toBe(0);
    expect(result.skippedCount).toBe(0);
  });

  it("names the profile after the alias and defaults the port to 22, the user to the injected local login name, and the folder to none", () => {
    const result = convert("Host lab\n  HostName 10.0.0.1\n");

    expect(result.sessions[0]).toMatchObject({ name: "lab", host: "10.0.0.1", port: 22, username: "localuser", folder: "" });
    // ssh config has no folder concept — no group is invented for it.
    expect(result.folders).toEqual([]);
  });

  it("prefers the block's own User over the injected default, and its Port over 22", () => {
    const result = convert("Host lab\n  HostName 10.0.0.1\n  User admin\n  Port 2222\n");

    expect(result.sessions[0].username).toBe("admin");
    expect(result.sessions[0].port).toBe(2222);
  });

  it("uses the alias as the host for a block with no HostName — that is what ssh does, so the block is a real host", () => {
    const result = convert("Host router.example.com\n  User admin\n");

    expect(result.sessions[0].host).toBe("router.example.com");
  });

  it("counts wildcard, negated and Match skips into skippedCount so the confirm modal's \"wildcard or unsupported\" figure is the whole truth (⊘ reporting only token drops undercounts a config that is mostly defaults blocks)", () => {
    const text = "Host *\n  User root\n\nHost !bad good\n  HostName good.example.com\n\nMatch host lab\n  User labuser\n";
    const result = convert(text);

    expect(result.sessions.map((s) => s.name)).toEqual(["good"]);
    // 1 wildcard (`*`) + 1 negation (`!bad`) + 1 Match block.
    expect(result.skippedCount).toBe(3);
  });

  it("⊘ drops an entry whose host is empty rather than creating a server with an empty host", () => {
    // Fed as a parse RESULT rather than as config text: the parser's own
    // handling of a quoted-empty `HostName` is its business (and has changed),
    // while the rule under test here is the converter's — an entry that
    // reaches it with nothing in `host` must not become a row.
    const result = convertSshConfig(parsedWith([{ alias: "web", host: "", line: 1 }]));

    expect(result.sessions).toHaveLength(0);
    expect(result.unsupportedTokenCount).toBe(1);
  });

  /**
   * THE INVARIANT THE STORAGE LAYER ENFORCES SILENTLY. An ssh server with an
   * empty username fails `validateServerConfig`, and
   * `VscodeConfigRepository.getServers` DROPS such a row on the next read with
   * only a `console.warn` — so a server written that way is in the tree,
   * connects for the session, and is gone after a reload. `??` cannot see the
   * difference between "no User" and `User ""`, which is why the check is a
   * trim and not a nullish coalesce.
   */
  it("treats a blank User as NO user, so the caller's default is what lands (⊘ `??` keeps the empty string and writes a row storage discards on the next reload)", () => {
    const result = convertSshConfig(parsedWith([{ alias: "web", host: "web.example.com", user: "", line: 1 }]), {
      defaultUsername: "localuser"
    });

    expect(result.sessions[0].username).toBe("localuser");
    expect(result.missingUsernameCount).toBe(1);
  });

  it("counts the entries that took the default username, so a caller with an EMPTY default knows it has to ask (⊘ reporting nothing leaves the caller writing username-less rows that vanish on reload)", () => {
    const result = convert(
      "Host one\n  HostName one.example.com\n\nHost two\n  HostName two.example.com\n  User deploy\n\nHost three\n  HostName three.example.com\n"
    );

    expect(result.sessions).toHaveLength(3);
    // `two` declares a User; the other two fall back.
    expect(result.missingUsernameCount).toBe(2);
  });

  it("⊘ counts NO missing username for a config where every block declares User (kills a counter that reports the entry count)", () => {
    const result = convert("Host one\n  HostName one.example.com\n  User deploy\n");

    expect(result.missingUsernameCount).toBe(0);
  });

  /**
   * ProxyJump is parsed and then dropped: Nexus models jump hosts natively
   * (`proxyJumpHostId`) but mapping an alias-valued `ProxyJump` onto one needs
   * a rule this importer does not have yet. A host behind a bastion therefore
   * imports as a DIRECT connection to a private address, where every connect
   * times out with nothing to explain it — so the loss is flagged per entry and
   * the confirm modal names it with the remedy.
   */
  it("flags and counts a host whose ProxyJump is dropped, keeping the host (⊘ importing it silently leaves a profile that can only ever time out)", () => {
    const result = convert(
      "Host db\n  HostName 10.0.5.7\n  User deploy\n  ProxyJump bastion\n\nHost direct\n  HostName direct.example.com\n  User deploy\n"
    );

    expect(result.sessions).toHaveLength(2);
    expect(result.sessions[0].droppedProxyJump).toBe(true);
    expect(result.sessions[0].host).toBe("10.0.5.7");
    expect(result.sessions[1].droppedProxyJump).toBeUndefined();
    expect(result.droppedProxyJumpCount).toBe(1);
    // Not a skip: the host imported, it just lost its jump.
    expect(result.skippedCount).toBe(0);
  });

  it("⊘ does not count a ProxyJump for an entry that was SKIPPED anyway — the user cannot set a jump host on a profile that does not exist", () => {
    const result = convert("Host db\n  HostName %C.example.com\n  ProxyJump bastion\n");

    expect(result.sessions).toHaveLength(0);
    expect(result.droppedProxyJumpCount).toBe(0);
  });

  it("flags the per-entry IdentityFile loss as well as totalling it — the modal counts over the rows it will actually write (⊘ a total-only report names hosts a re-import is not touching)", () => {
    const result = convert(
      "Host kept\n  HostName kept.example.com\n  IdentityFile ~/.ssh/%C_key\n\nHost plain\n  HostName plain.example.com\n"
    );

    expect(result.sessions[0].droppedIdentityFile).toBe(true);
    expect(result.sessions[1].droppedIdentityFile).toBeUndefined();
    expect(result.droppedIdentityFileCount).toBe(1);
  });

  it("⊘ flags no IdentityFile loss for `IdentityFile none` — the user said there was no key, so there is nothing for them to go and fix", () => {
    const result = convert("Host web\n  HostName web.example.com\n  IdentityFile none\n");

    expect(result.sessions[0].droppedIdentityFile).toBeUndefined();
    expect(result.droppedIdentityFileCount).toBe(0);
  });
});

describe("localLoginName", () => {
  it("returns a non-throwing string — activation and import paths both call it unguarded", () => {
    expect(typeof localLoginName()).toBe("string");
  });
});
