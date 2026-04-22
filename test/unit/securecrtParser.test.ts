import { describe, expect, it } from "vitest";
import {
  parseSecureCrtSessionFile,
  parseSecureCrtDirectory,
  parseSecureCrtXmlExport
} from "../../src/utils/securecrtParser";
import { MAX_FOLDER_DEPTH } from "../../src/utils/folderPaths";

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

  it("defaults empty username to user", () => {
    const content = `S:"Protocol Name"=SSH2
S:"Hostname"=host.test
D:"[SSH2] Port"=00000016
S:"Username"=
`;
    const result = parseSecureCrtSessionFile(content, "Test", "");
    expect(result!.username).toBe("user");
  });

  it("defaults username to user when field is absent", () => {
    const content = `S:"Protocol Name"=SSH2
S:"Hostname"=host.test
D:"[SSH2] Port"=00000016
`;
    const result = parseSecureCrtSessionFile(content, "Test", "");
    expect(result!.username).toBe("user");
  });

  it("defaults to port 22 when parsed port is out of range", () => {
    const content = `S:"Protocol Name"=SSH2
S:"Hostname"=host.test
D:"[SSH2] Port"=00011170
`;
    const result = parseSecureCrtSessionFile(content, "Test", "");
    expect(result!.port).toBe(22);
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
    const tooDeep = Array.from({ length: MAX_FOLDER_DEPTH + 1 }, (_, i) => `L${i}`).join("/");
    const result = parseSecureCrtSessionFile(content, "Test", tooDeep);
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

describe("parseSecureCrtXmlExport", () => {
  it("parses nested SSH sessions and collects folders", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<VanDyke version="3.0">
  <key name="Sessions">
    <key name="SSH">
      <key name="Prod">
        <key name="App">
          <dword name="Is Session">1</dword>
          <string name="Protocol Name">SSH2</string>
          <string name="Hostname">app.example.com</string>
          <dword name="[SSH2] Port">2222</dword>
          <string name="Username">deploy</string>
        </key>
      </key>
      <key name="Core">
        <key name="Db">
          <dword name="Is Session">1</dword>
          <string name="Protocol Name">SSH2</string>
          <string name="Hostname">db.example.com</string>
          <dword name="[SSH2] Port">22</dword>
        </key>
      </key>
    </key>
  </key>
</VanDyke>`;
    const result = parseSecureCrtXmlExport(xml);
    expect(result.sessions).toHaveLength(2);
    expect(result.sessions).toEqual(
      expect.arrayContaining([
        {
          name: "App",
          host: "app.example.com",
          port: 2222,
          username: "deploy",
          folder: "SSH/Prod"
        },
        {
          name: "Db",
          host: "db.example.com",
          port: 22,
          username: "user",
          folder: "SSH/Core"
        }
      ])
    );
    expect(result.folders).toEqual(["SSH/Core", "SSH/Prod"]);
    expect(result.skippedCount).toBe(0);
  });

  it("skips non-SSH sessions and SSH sessions without hostname", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<VanDyke version="3.0">
  <key name="Sessions">
    <key name="RDP">
      <key name="Desktop">
        <dword name="Is Session">1</dword>
        <string name="Protocol Name">RDP</string>
        <string name="Hostname">rdp.example.com</string>
      </key>
    </key>
    <key name="Default">
      <dword name="Is Session">1</dword>
      <string name="Protocol Name">SSH2</string>
    </key>
    <key name="SSH">
      <key name="Good">
        <dword name="Is Session">1</dword>
        <string name="Protocol Name">SSH2</string>
        <string name="Hostname">good.example.com</string>
      </key>
    </key>
  </key>
</VanDyke>`;
    const result = parseSecureCrtXmlExport(xml);
    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0].name).toBe("Good");
    expect(result.skippedCount).toBe(2);
  });

  it("uses port fallback and username fallback", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<VanDyke version="3.0">
  <key name="Sessions">
    <key name="SSH">
      <key name="BadPort">
        <dword name="Is Session">1</dword>
        <string name="Protocol Name">SSH2</string>
        <string name="Hostname">bad.example.com</string>
        <dword name="[SSH2] Port">70000</dword>
        <string name="Username"/>
      </key>
      <key name="NoPort">
        <dword name="Is Session">1</dword>
        <string name="Protocol Name">SSH2</string>
        <string name="Hostname">nop.example.com</string>
      </key>
    </key>
  </key>
</VanDyke>`;
    const result = parseSecureCrtXmlExport(xml);
    const bad = result.sessions.find((session) => session.name === "BadPort");
    const noPort = result.sessions.find((session) => session.name === "NoPort");
    expect(bad?.port).toBe(22);
    expect(bad?.username).toBe("user");
    expect(noPort?.port).toBe(22);
    expect(noPort?.username).toBe("user");
  });

  it("truncates XML folder depth to first three segments", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<VanDyke version="3.0">
  <key name="Sessions">
    <key name="SSH">
      <key name="Switches">
        <key name="Draglines">
          <key name="CCTV">
            <key name="DL01">
              <dword name="Is Session">1</dword>
              <string name="Protocol Name">SSH2</string>
              <string name="Hostname">deep.example.com</string>
            </key>
          </key>
        </key>
      </key>
    </key>
  </key>
</VanDyke>`;
    const result = parseSecureCrtXmlExport(xml);
    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0].folder).toBe("SSH/Switches/Draglines");
    expect(result.folders).toEqual(["SSH/Switches/Draglines"]);
  });

  it("returns empty result when Sessions key is missing", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<VanDyke version="3.0">
  <key name="Security"/>
</VanDyke>`;
    const result = parseSecureCrtXmlExport(xml);
    expect(result.sessions).toHaveLength(0);
    expect(result.skippedCount).toBe(0);
    expect(result.folders).toHaveLength(0);
  });

  it("throws on malformed XML", () => {
    expect(() => parseSecureCrtXmlExport("<VanDyke><key name=\"Sessions\">")).toThrow("Invalid XML format");
  });

  it("ignores entity definitions when processEntities is disabled", () => {
    const xml = `<?xml version="1.0"?>
<!DOCTYPE foo [<!ENTITY xxe "injected">]>
<VanDyke version="3.0">
  <key name="Sessions">
    <key name="Server">
      <dword name="Is Session">1</dword>
      <string name="Protocol Name">SSH2</string>
      <string name="Hostname">safe.example.com</string>
    </key>
  </key>
</VanDyke>`;
    const result = parseSecureCrtXmlExport(xml);
    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0].host).toBe("safe.example.com");
  });
});
