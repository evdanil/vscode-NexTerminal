import { describe, expect, it } from "vitest";
import {
  serverConnectionEqual,
  tunnelConnectionEqual,
  type ServerConfig,
  type TunnelProfile
} from "../../src/models/config";

const server: ServerConfig = {
  id: "s1", name: "S", host: "h", port: 22, username: "u", authType: "password", isHidden: false
};
const tunnel: TunnelProfile = {
  id: "t1", name: "T", localPort: 1, remoteIP: "10.0.0.1", remotePort: 2, autoStart: false
};

describe("serverConnectionEqual — explicit default vs absent", () => {
  it.each<[string, Partial<ServerConfig>]>([
    ["protocol ssh", { protocol: "ssh" }],
    ["altHost empty/whitespace", { altHost: "  " }],
    ["keyPath empty", { keyPath: "" }],
    ["authProfileId empty", { authProfileId: "" }],
    ["multiplexing on (form default)", { multiplexing: true }],
    ["legacyAlgorithms false", { legacyAlgorithms: false }],
    ["addressless false", { addressless: false }],
    ["logSession written by the editor", { logSession: false }]
  ])("treats %s as equal to absent", (_label, patch) => {
    expect(serverConnectionEqual(server, { ...server, ...patch })).toBe(true);
    expect(serverConnectionEqual({ ...server, ...patch }, server)).toBe(true);
  });

  it.each<[string, Partial<ServerConfig>]>([
    ["protocol telnet", { protocol: "telnet" }],
    ["altHost set", { altHost: "alt" }],
    ["multiplexing off", { multiplexing: false }],
    ["legacyAlgorithms on", { legacyAlgorithms: true }],
    ["host", { host: "other" }],
    ["proxy", { proxy: { type: "ssh", jumpHostId: "j" } }]
  ])("still detects a real change: %s", (_label, patch) => {
    expect(serverConnectionEqual(server, { ...server, ...patch })).toBe(false);
  });

  it("ignores folder and hidden edits", () => {
    expect(serverConnectionEqual(server, { ...server, group: "g", isHidden: true })).toBe(true);
  });
});

describe("tunnelConnectionEqual — explicit default vs absent", () => {
  it.each<[string, Partial<TunnelProfile>]>([
    ["tunnelType local", { tunnelType: "local" }],
    ["localBindAddress 127.0.0.1", { localBindAddress: "127.0.0.1" }],
    ["localTargetIP 127.0.0.1", { localTargetIP: "127.0.0.1" }],
    ["remoteBindAddress 127.0.0.1", { remoteBindAddress: "127.0.0.1" }]
  ])("treats %s as equal to absent", (_label, patch) => {
    expect(tunnelConnectionEqual(tunnel, { ...tunnel, ...patch })).toBe(true);
    expect(tunnelConnectionEqual({ ...tunnel, ...patch }, tunnel)).toBe(true);
  });

  it("treats a reverse tunnel's absent mode as shared", () => {
    const reverse: TunnelProfile = { ...tunnel, tunnelType: "reverse" };
    expect(tunnelConnectionEqual(reverse, { ...reverse, connectionMode: "shared" })).toBe(true);
  });

  it.each<[string, Partial<TunnelProfile>]>([
    ["tunnelType dynamic", { tunnelType: "dynamic" }],
    ["localBindAddress 0.0.0.0", { localBindAddress: "0.0.0.0" }],
    ["connectionMode isolated", { connectionMode: "isolated" }],
    ["localPort", { localPort: 9 }]
  ])("still detects a real change: %s", (_label, patch) => {
    expect(tunnelConnectionEqual(tunnel, { ...tunnel, ...patch })).toBe(false);
  });

  it("ignores notes, name, browserUrl and autoStart", () => {
    expect(tunnelConnectionEqual(tunnel, { ...tunnel, notes: "n", name: "x", browserUrl: "u", autoStart: true })).toBe(true);
  });
});
