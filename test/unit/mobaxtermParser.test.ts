import { describe, expect, it } from "vitest";
import { parseIniSections, parseMobaxtermSessions } from "../../src/utils/mobaxtermParser";

describe("parseIniSections", () => {
  it("parses sections with entries", () => {
    const text = `[SectionA]
key1=value1
key2=value2

[SectionB]
key3=value3
`;
    const sections = parseIniSections(text);
    expect(sections).toHaveLength(2);
    expect(sections[0].name).toBe("SectionA");
    expect(sections[0].entries.get("key1")).toBe("value1");
    expect(sections[0].entries.get("key2")).toBe("value2");
    expect(sections[1].name).toBe("SectionB");
    expect(sections[1].entries.get("key3")).toBe("value3");
  });

  it("strips BOM", () => {
    const text = "\uFEFF[Section]\nkey=val\n";
    const sections = parseIniSections(text);
    expect(sections).toHaveLength(1);
    expect(sections[0].name).toBe("Section");
  });

  it("handles CRLF line endings", () => {
    const text = "[Section]\r\nkey=val\r\n";
    const sections = parseIniSections(text);
    expect(sections).toHaveLength(1);
    expect(sections[0].entries.get("key")).toBe("val");
  });

  it("splits on first = only", () => {
    const text = "[Section]\nkey=val=ue=more\n";
    const sections = parseIniSections(text);
    expect(sections[0].entries.get("key")).toBe("val=ue=more");
  });

  it("skips comment lines", () => {
    const text = "[Section]\n; comment\n# hash comment\nkey=val\n";
    const sections = parseIniSections(text);
    expect(sections[0].entries.size).toBe(1);
    expect(sections[0].entries.get("key")).toBe("val");
  });

  it("ignores entries before any section", () => {
    const text = "orphan=value\n[Section]\nkey=val\n";
    const sections = parseIniSections(text);
    expect(sections).toHaveLength(1);
    expect(sections[0].entries.has("orphan")).toBe(false);
  });
});

describe("parseMobaxtermSessions", () => {
  it("extracts SSH sessions from Bookmarks section", () => {
    const text = `[Bookmarks]
SubRep=
ImgNum=42
MyServer=#109#0%192.168.1.1%22%admin%%-1%-1%%%22%%0%0%0%%%-1%0%0%0%%1080%%0%0%1#MobaFont%10%0%0%-1%15%236,236,236%30,30,30%180,180,192%0%-1%0%%xterm%-1%-1%_PC_Gone%0%-1%0%0%-1%1%0%0%%0%1%0#0#0`;
    const result = parseMobaxtermSessions(text);
    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0]).toEqual({
      name: "MyServer",
      host: "192.168.1.1",
      port: 22,
      username: "admin",
      folder: ""
    });
    expect(result.skippedCount).toBe(0);
  });

  it("extracts folder from SubRep with backslash to slash conversion", () => {
    const text = `[Bookmarks_1]
SubRep=Coronado\\CP1
ImgNum=42
Server1=#109#0%10.0.0.1%2222%root%%-1%
`;
    const result = parseMobaxtermSessions(text);
    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0].folder).toBe("Coronado/CP1");
    expect(result.sessions[0].port).toBe(2222);
    expect(result.sessions[0].username).toBe("root");
    expect(result.folders).toEqual(["Coronado/CP1"]);
  });

  it("skips non-SSH session types", () => {
    const text = `[Bookmarks]
SubRep=
ImgNum=42
SSHBox=#109#0%ssh.example.com%22%user%%-1%
RDPBox=#91#3%rdp.example.com%3389%user%%-1%
TelnetBox=#98#1%telnet.example.com%23%%%-1%
`;
    const result = parseMobaxtermSessions(text);
    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0].name).toBe("SSHBox");
    expect(result.skippedCount).toBe(2);
  });

  it("skips entries with empty host", () => {
    const text = `[Bookmarks]
SubRep=
ImgNum=42
NoHost=#109#0%%22%user%%-1%
`;
    const result = parseMobaxtermSessions(text);
    expect(result.sessions).toHaveLength(0);
    expect(result.skippedCount).toBe(1);
  });

  it("defaults to port 22 on bad port", () => {
    const text = `[Bookmarks]
SubRep=
ImgNum=42
BadPort=#109#0%host.example.com%abc%user%%-1%
`;
    const result = parseMobaxtermSessions(text);
    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0].port).toBe(22);
  });

  it("defaults to port 22 on missing port", () => {
    const text = `[Bookmarks]
SubRep=
ImgNum=42
NoPort=#109#0%host.example.com%%user%%-1%
`;
    const result = parseMobaxtermSessions(text);
    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0].port).toBe(22);
  });

  it("defaults missing username to user", () => {
    const text = `[Bookmarks]
SubRep=
ImgNum=42
NoUser=#109#0%host.example.com%22%%%-1%
`;
    const result = parseMobaxtermSessions(text);
    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0].username).toBe("user");
  });

  it("defaults to port 22 when parsed port is out of range", () => {
    const text = `[Bookmarks]
SubRep=
ImgNum=42
HugePort=#109#0%host.example.com%70000%user%%-1%
`;
    const result = parseMobaxtermSessions(text);
    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0].port).toBe(22);
  });

  it("truncates folder deeper than max depth", () => {
    const text = `[Bookmarks_1]
SubRep=A\\B\\C\\D
ImgNum=42
Deep=#109#0%deep.example.com%22%user%%-1%
`;
    const result = parseMobaxtermSessions(text);
    expect(result.sessions).toHaveLength(1);
    // normalizeFolderPath rejects > 3 depth, so folder falls back to ""
    expect(result.sessions[0].folder).toBe("");
  });

  it("handles multiple Bookmarks sections", () => {
    const text = `[Bookmarks]
SubRep=
ImgNum=42
Root=#109#0%root.example.com%22%root%%-1%

[Bookmarks_1]
SubRep=Production
ImgNum=42
Prod=#109#0%prod.example.com%22%deploy%%-1%

[Bookmarks_2]
SubRep=Staging
ImgNum=42
Stage=#109#0%staging.example.com%2200%dev%%-1%
`;
    const result = parseMobaxtermSessions(text);
    expect(result.sessions).toHaveLength(3);
    expect(result.sessions[0].folder).toBe("");
    expect(result.sessions[1].folder).toBe("Production");
    expect(result.sessions[2].folder).toBe("Staging");
    expect(result.sessions[2].port).toBe(2200);
    expect(result.folders).toEqual(["Production", "Staging"]);
  });

  it("handles BOM + CRLF combined", () => {
    const text = "\uFEFF[Bookmarks]\r\nSubRep=\r\nImgNum=42\r\nBOM=#109#0%bom.test%22%user%%-1%\r\n";
    const result = parseMobaxtermSessions(text);
    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0].host).toBe("bom.test");
  });

  it("collects unique folders", () => {
    const text = `[Bookmarks_1]
SubRep=SameFolder
ImgNum=42
A=#109#0%a.test%22%user%%-1%
B=#109#0%b.test%22%user%%-1%
`;
    const result = parseMobaxtermSessions(text);
    expect(result.sessions).toHaveLength(2);
    expect(result.folders).toEqual(["SameFolder"]);
  });

  it("returns empty result for no bookmarks sections", () => {
    const text = `[Misc]
key=value
`;
    const result = parseMobaxtermSessions(text);
    expect(result.sessions).toHaveLength(0);
    expect(result.skippedCount).toBe(0);
    expect(result.folders).toHaveLength(0);
  });
});
