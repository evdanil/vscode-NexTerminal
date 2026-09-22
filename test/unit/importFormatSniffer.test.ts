import { describe, expect, it } from "vitest";
import { sniffImportFormat } from "../../src/utils/importFormatSniffer";

describe("sniffImportFormat", () => {
  it("detects nexus-json from a leading brace", () => {
    expect(sniffImportFormat('{"version":2,"servers":[]}')).toBe("nexus-json");
  });

  it("detects nexus-json even when leading whitespace precedes the brace", () => {
    expect(sniffImportFormat('  \n\t{"version":2}')).toBe("nexus-json");
  });

  it("detects nexus-json for broken JSON — a broken export is still not a host list", () => {
    expect(sniffImportFormat('{"version": 2, "servers": [')).toBe("nexus-json");
  });

  it("detects xml from a leading angle bracket", () => {
    expect(sniffImportFormat('<?xml version="1.0"?><VanDyke></VanDyke>')).toBe("xml");
  });

  it("detects xml even without an xml declaration", () => {
    expect(sniffImportFormat("<VanDyke><key name=\"Sessions\"/></VanDyke>")).toBe("xml");
  });

  it("detects mobaxterm from a [Bookmarks] section header", () => {
    expect(sniffImportFormat("[Bookmarks]\nSubRep=\nServer=#109#0%host%22%user%%-1%\n")).toBe("mobaxterm");
  });

  it("detects mobaxterm from a numbered [Bookmarks_N] section header", () => {
    expect(sniffImportFormat("[Bookmarks_12]\nSubRep=Prod\n")).toBe("mobaxterm");
  });

  it("detects mobaxterm when the section header has trailing CRLF", () => {
    expect(sniffImportFormat("[Bookmarks]\r\nSubRep=\r\n")).toBe("mobaxterm");
  });

  // Regression: parseIniSections() trims every line before matching (mobaxtermParser.ts),
  // so an indented [Bookmarks] header still parses fine — but the old sniffer required
  // `[` at column 0 and would sniff this as host-list, making importMobaxterm() reject a
  // file the parser itself accepts with a message claiming no [Bookmarks] section exists.
  it("detects mobaxterm when the section header is indented — the parser trims lines before matching, so the sniffer must too", () => {
    expect(sniffImportFormat("  [Bookmarks]\nSubRep=\nServer=#109#0%h%22%u%%-1%\n")).toBe("mobaxterm");
  });

  // Regression: parseIniSections() strips a leading UTF-8 BOM before matching sections
  // (mobaxtermParser.ts) — a real MobaXterm export can start with one. The old sniffer's
  // MOBAXTERM_BOOKMARKS_RE only tolerates `[ \t]*` before `[`, which does not match `﻿`,
  // so a BOM'd export sniffed as host-list and importMobaxterm() aborted before the parser
  // (which handles the BOM fine) ever ran.
  it("detects mobaxterm when the file starts with a UTF-8 BOM before [Bookmarks]", () => {
    expect(sniffImportFormat("﻿[Bookmarks]\nSubRep=\n")).toBe("mobaxterm");
  });

  // Pins the BOM-agnostic property for the other two positive rules too, since both already
  // pass today (they key off `firstNonWhitespace` via `\s`, which matches `﻿`) — a future
  // refactor of the leading-whitespace handling must not silently regress these.
  it("detects nexus-json when the file starts with a UTF-8 BOM before the brace", () => {
    expect(sniffImportFormat('﻿{"version":2}')).toBe("nexus-json");
  });

  it("detects xml when the file starts with a UTF-8 BOM before the angle bracket", () => {
    expect(sniffImportFormat("﻿<VanDyke></VanDyke>")).toBe("xml");
  });

  it("falls back to host-list for plain CSV rows", () => {
    expect(sniffImportFormat("10.0.0.1,sw1,admin\n10.0.0.2,sw2,admin\n")).toBe("host-list");
  });

  it("falls back to host-list for a bare hostname list", () => {
    expect(sniffImportFormat("sw1.example.com\nsw2.example.com\n")).toBe("host-list");
  });

  // The load-bearing case the whole chooser design exists for: a generic INI section
  // header is not mistaken for MobaXterm's specific [Bookmarks] signature, and (unlike
  // the inventory parser's own HOST_RE) the sniffer never claims a positive match for
  // it — it is simply "not any of the other three", same as any other host list.
  it("does not mistake a generic INI section for MobaXterm's [Bookmarks] signature", () => {
    expect(sniffImportFormat("[General]\nkey=value\n")).toBe("host-list");
  });

  it("falls back to host-list for empty input", () => {
    expect(sniffImportFormat("")).toBe("host-list");
  });

  it("falls back to host-list for whitespace-only input", () => {
    expect(sniffImportFormat("   \n\t\n")).toBe("host-list");
  });

  // An ~/.ssh/config used to land in the everything-else class, so picking it in
  // "Host List File…" ran it through the inventory parser, which reads `Host lab`
  // positionally and creates a server NAMED lab whose HOST is the literal word
  // "Host". Every test below fails against a sniffer with no ssh-config rule.
  describe("ssh-config", () => {
    it("classes a config whose first directive is a Host block (⊘ returning host-list here is what made `Host lab` a server at host \"Host\")", () => {
      expect(sniffImportFormat("Host lab\n  HostName 10.0.0.1\n  User admin\n")).toBe("ssh-config");
    });

    it("classes a config that opens with comments and a global block, where the first Host line is far down the file", () => {
      const text = "# work config\n\nServerAliveInterval 60\n\nHost bastion\n  HostName bastion.example.com\n";
      expect(sniffImportFormat(text)).toBe("ssh-config");
    });

    it("classes a config made only of defaults and HostName (no bare Host line to match)", () => {
      expect(sniffImportFormat("Host *\n  HostName fallback.example.com\n")).toBe("ssh-config");
    });

    it("classes an indented Host line — ssh accepts leading whitespace, so the sniffer must too", () => {
      expect(sniffImportFormat("\tHost lab\n\t  HostName 10.0.0.1\n")).toBe("ssh-config");
    });

    it("classes a BOM'd / CRLF config, the normal shape of one copied off Windows", () => {
      expect(sniffImportFormat("\uFEFFHost lab\r\n  HostName 10.0.0.1\r\n")).toBe("ssh-config");
    });

    it("⊘ leaves a lowercase `host name user` header a host-list — a whitespace-delimited CSV header is not an ssh config (⊘ a case-insensitive rule steals it)", () => {
      expect(sniffImportFormat("host name user port\n10.0.0.1 sw1 admin 22\n")).toBe("host-list");
    });

    it("⊘ leaves `Host=` alone: an INI key with no whitespace after the keyword is not a Host directive", () => {
      expect(sniffImportFormat("[Session]\nHost=10.0.0.1\n")).toBe("host-list");
    });

    it("⊘ does not steal a MobaXterm export that happens to contain a Host line — the [Bookmarks] signature is checked first", () => {
      expect(sniffImportFormat("[Bookmarks]\nSubRep=\nHost example\n")).toBe("mobaxterm");
    });

    it("⊘ does not steal a Nexus JSON export or an XML export containing the word Host", () => {
      expect(sniffImportFormat('{"version":2,"servers":[{"host":"Host lab"}]}')).toBe("nexus-json");
      expect(sniffImportFormat("<VanDyke>\nHost lab\n</VanDyke>")).toBe("xml");
    });

    it("⊘ a bare `Host` with nothing after it stays host-list — the pattern requires a pattern argument", () => {
      expect(sniffImportFormat("Host\nHost   \n")).toBe("host-list");
    });
  });
});
