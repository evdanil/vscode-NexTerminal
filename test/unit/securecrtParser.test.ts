import { describe, expect, it } from "vitest";
import {
  parseSecureCrtSessionFile,
  parseSecureCrtDirectory
} from "../../src/utils/securecrtParser";

describe("parseSecureCrtSessionFile", () => {
  it("parses a standard SSH2 session", () => {
    const content = `S:"Protocol Name"=SSH2
S:"Hostname"=prod.example.com
D:"[SSH2] Port"=00000016
S:"Username"=deploy
`;
    const result = parseSecureCrtSessionFile(content, "Production", "Servers");
    expect(result).toEqual({
      name: "Production",
      host: "prod.example.com",
      port: 22,
      username: "deploy",
      folder: "Servers"
    });
  });

  it("parses SSH1 sessions", () => {
    const content = `S:"Protocol Name"=SSH1
S:"Hostname"=legacy.example.com
D:"[SSH2] Port"=00000016
S:"Username"=admin
`;
    const result = parseSecureCrtSessionFile(content, "Legacy", "");
    expect(result).toBeDefined();
    expect(result!.host).toBe("legacy.example.com");
  });

  it("returns undefined for Telnet protocol", () => {
    const content = `S:"Protocol Name"=Telnet
S:"Hostname"=switch.example.com
S:"Username"=admin
`;
    const result = parseSecureCrtSessionFile(content, "Switch", "Network");
    expect(result).toBeUndefined();
  });

  it("returns undefined for RLogin protocol", () => {
    const content = `S:"Protocol Name"=RLogin
S:"Hostname"=unix.example.com
S:"Username"=root
`;
    const result = parseSecureCrtSessionFile(content, "Unix", "");
    expect(result).toBeUndefined();
  });

  it("returns undefined for missing hostname", () => {
    const content = `S:"Protocol Name"=SSH2
D:"[SSH2] Port"=00000016
S:"Username"=user
`;
    const result = parseSecureCrtSessionFile(content, "NoHost", "");
    expect(result).toBeUndefined();
  });

  it("returns undefined for empty hostname", () => {
    const content = `S:"Protocol Name"=SSH2
S:"Hostname"=
D:"[SSH2] Port"=00000016
S:"Username"=user
`;
    const result = parseSecureCrtSessionFile(content, "EmptyHost", "");
    expect(result).toBeUndefined();
  });

  it("parses hex port correctly: 00000016 = 22", () => {
    const content = `S:"Protocol Name"=SSH2
S:"Hostname"=host.test
D:"[SSH2] Port"=00000016
`;
    const result = parseSecureCrtSessionFile(content, "Test", "");
    expect(result!.port).toBe(22);
  });

  it("parses hex port correctly: 00001F90 = 8080", () => {
    const content = `S:"Protocol Name"=SSH2
S:"Hostname"=host.test
D:"[SSH2] Port"=00001F90
`;
    const result = parseSecureCrtSessionFile(content, "Test", "");
    expect(result!.port).toBe(8080);
  });

  it("defaults to port 22 when port field is missing", () => {
    const content = `S:"Protocol Name"=SSH2
S:"Hostname"=host.test
S:"Username"=user
`;
    const result = parseSecureCrtSessionFile(content, "Test", "");
    expect(result!.port).toBe(22);
  });

  it("keeps empty username", () => {
    const content = `S:"Protocol Name"=SSH2
S:"Hostname"=host.test
D:"[SSH2] Port"=00000016
S:"Username"=
`;
    const result = parseSecureCrtSessionFile(content, "Test", "");
    expect(result!.username).toBe("");
  });

  it("keeps empty username when field is absent", () => {
    const content = `S:"Protocol Name"=SSH2
S:"Hostname"=host.test
D:"[SSH2] Port"=00000016
`;
    const result = parseSecureCrtSessionFile(content, "Test", "");
    expect(result!.username).toBe("");
  });

  it("normalizes folder path", () => {
    const content = `S:"Protocol Name"=SSH2
S:"Hostname"=host.test
D:"[SSH2] Port"=00000016
`;
    const result = parseSecureCrtSessionFile(content, "Test", " Production / Web ");
    expect(result!.folder).toBe("Production/Web");
  });

  it("truncates folder deeper than max depth to empty", () => {
    const content = `S:"Protocol Name"=SSH2
S:"Hostname"=host.test
D:"[SSH2] Port"=00000016
`;
    const result = parseSecureCrtSessionFile(content, "Test", "A/B/C/D");
    expect(result!.folder).toBe("");
  });

  it("handles CRLF line endings", () => {
    const content = `S:"Protocol Name"=SSH2\r\nS:"Hostname"=host.test\r\nD:"[SSH2] Port"=00000016\r\n`;
    const result = parseSecureCrtSessionFile(content, "Test", "");
    expect(result).toBeDefined();
    expect(result!.host).toBe("host.test");
  });

  it("returns undefined when protocol is missing", () => {
    const content = `S:"Hostname"=host.test
D:"[SSH2] Port"=00000016
S:"Username"=user
`;
    const result = parseSecureCrtSessionFile(content, "NoProto", "");
    expect(result).toBeUndefined();
  });

  it("ignores Z: (binary) entries", () => {
    const content = `S:"Protocol Name"=SSH2
S:"Hostname"=host.test
D:"[SSH2] Port"=00000016
Z:"Some Binary"=0102030405
`;
    const result = parseSecureCrtSessionFile(content, "Test", "");
    expect(result).toBeDefined();
    expect(result!.host).toBe("host.test");
  });
});

describe("parseSecureCrtDirectory", () => {
  it("parses multiple files and collects results", () => {
    const files = [
      {
        name: "Server1",
        folder: "Production",
        content: `S:"Protocol Name"=SSH2\nS:"Hostname"=s1.test\nD:"[SSH2] Port"=00000016\nS:"Username"=admin`
      },
      {
        name: "Server2",
        folder: "Staging",
        content: `S:"Protocol Name"=SSH2\nS:"Hostname"=s2.test\nD:"[SSH2] Port"=00001F90\nS:"Username"=dev`
      }
    ];
    const result = parseSecureCrtDirectory(files);
    expect(result.sessions).toHaveLength(2);
    expect(result.sessions[0].host).toBe("s1.test");
    expect(result.sessions[0].port).toBe(22);
    expect(result.sessions[1].host).toBe("s2.test");
    expect(result.sessions[1].port).toBe(8080);
    expect(result.skippedCount).toBe(0);
    expect(result.folders).toEqual(["Production", "Staging"]);
  });

  it("skips non-SSH sessions and counts them", () => {
    const files = [
      {
        name: "SSHServer",
        folder: "",
        content: `S:"Protocol Name"=SSH2\nS:"Hostname"=ssh.test\nD:"[SSH2] Port"=00000016`
      },
      {
        name: "TelnetSwitch",
        folder: "",
        content: `S:"Protocol Name"=Telnet\nS:"Hostname"=telnet.test`
      },
      {
        name: "RLoginBox",
        folder: "",
        content: `S:"Protocol Name"=RLogin\nS:"Hostname"=rlogin.test`
      }
    ];
    const result = parseSecureCrtDirectory(files);
    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0].name).toBe("SSHServer");
    expect(result.skippedCount).toBe(2);
  });

  it("returns empty result for empty input", () => {
    const result = parseSecureCrtDirectory([]);
    expect(result.sessions).toHaveLength(0);
    expect(result.skippedCount).toBe(0);
    expect(result.folders).toHaveLength(0);
  });

  it("collects unique folders sorted", () => {
    const files = [
      {
        name: "A",
        folder: "Zulu",
        content: `S:"Protocol Name"=SSH2\nS:"Hostname"=a.test\nD:"[SSH2] Port"=00000016`
      },
      {
        name: "B",
        folder: "Alpha",
        content: `S:"Protocol Name"=SSH2\nS:"Hostname"=b.test\nD:"[SSH2] Port"=00000016`
      },
      {
        name: "C",
        folder: "Alpha",
        content: `S:"Protocol Name"=SSH2\nS:"Hostname"=c.test\nD:"[SSH2] Port"=00000016`
      }
    ];
    const result = parseSecureCrtDirectory(files);
    expect(result.folders).toEqual(["Alpha", "Zulu"]);
  });
});
