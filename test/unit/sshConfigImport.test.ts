import * as os from "node:os";
import { describe, expect, it } from "vitest";
import { convertSshConfig, expandSshTokens, localLoginName } from "../../src/utils/sshConfigImport";
import { parseSshConfig } from "../../src/utils/sshConfigParser";

/**
 * The pure half of the ssh-config importer: parse result in, importable
 * sessions out. No `vscode`, no `fs` — the command-level behaviour (dialogs,
 * size guard, dedupe against existing servers) lives in
 * `configImportExport.test.ts`.
 */
function convert(text: string, defaultUsername = "localuser") {
  return convertSshConfig(parseSshConfig(text), { defaultUsername });
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

  it("expands %h in HostName to the alias (⊘ passing it through creates a server at the literal host \"%h.example.com\" that can never resolve)", () => {
    const result = convert("Host web1\n  HostName %h.example.com\n");

    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0].host).toBe("web1.example.com");
    expect(result.unsupportedTokenCount).toBe(0);
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

  it("⊘ drops a HostName of \"\" rather than creating a server with an empty host", () => {
    const result = convert('Host web\n  HostName ""\n');

    expect(result.sessions).toHaveLength(0);
    expect(result.unsupportedTokenCount).toBe(1);
  });
});

describe("localLoginName", () => {
  it("returns a non-throwing string — activation and import paths both call it unguarded", () => {
    expect(typeof localLoginName()).toBe("string");
  });
});
