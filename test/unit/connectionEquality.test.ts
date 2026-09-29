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

  it("compares effective multiplexing against the global default", () => {
    const on = { ...server, multiplexing: true };
    expect(serverConnectionEqual(server, on, { multiplexingDefault: true })).toBe(true);
    expect(serverConnectionEqual(server, on, { multiplexingDefault: false })).toBe(false);
    const off = { ...server, multiplexing: false };
    expect(serverConnectionEqual(server, off, { multiplexingDefault: false })).toBe(true);
    expect(serverConnectionEqual(server, off, { multiplexingDefault: true })).toBe(false);
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

describe("tunnelConnectionEqual — only the fields the resolved type uses", () => {
  const dynamic: TunnelProfile = { ...tunnel, tunnelType: "dynamic", remoteIP: "0.0.0.0", remotePort: 0 };
  const reverse: TunnelProfile = {
    ...tunnel, tunnelType: "reverse", remoteIP: "127.0.0.1", remoteBindAddress: "127.0.0.1",
    localTargetIP: "127.0.0.1", connectionMode: "shared"
  };

  it("ignores a noncanonical remoteIP/remotePort on a dynamic tunnel", () => {
    expect(tunnelConnectionEqual({ ...dynamic, remoteIP: "10.9.9.9", remotePort: 443 }, dynamic)).toBe(true);
  });
  it("detects a real dynamic change (localPort, localBindAddress)", () => {
    expect(tunnelConnectionEqual(dynamic, { ...dynamic, localPort: 5 })).toBe(false);
    expect(tunnelConnectionEqual(dynamic, { ...dynamic, localBindAddress: "0.0.0.0" })).toBe(false);
  });

  it("ignores remoteIP and a stored mode on a reverse tunnel", () => {
    expect(tunnelConnectionEqual({ ...reverse, remoteIP: "10.9.9.9", connectionMode: undefined }, reverse)).toBe(true);
  });
  it("detects a real reverse change (remotePort, remoteBindAddress, localTargetIP)", () => {
    expect(tunnelConnectionEqual(reverse, { ...reverse, remotePort: 9 })).toBe(false);
    expect(tunnelConnectionEqual(reverse, { ...reverse, remoteBindAddress: "0.0.0.0" })).toBe(false);
    expect(tunnelConnectionEqual(reverse, { ...reverse, localTargetIP: "10.0.0.5" })).toBe(false);
  });

  it("ignores reverse-only address fields on a local tunnel but not its remote target", () => {
    expect(tunnelConnectionEqual(tunnel, { ...tunnel, remoteBindAddress: "0.0.0.0", localTargetIP: "10.1.1.1" })).toBe(true);
    expect(tunnelConnectionEqual(tunnel, { ...tunnel, remoteIP: "10.0.0.2" })).toBe(false);
    expect(tunnelConnectionEqual(tunnel, { ...tunnel, remotePort: 3 })).toBe(false);
  });
});
