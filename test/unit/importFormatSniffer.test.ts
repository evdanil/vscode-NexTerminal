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
});
