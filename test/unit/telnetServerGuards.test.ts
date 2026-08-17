import { describe, expect, it } from "vitest";
import { telnetUnsupportedMessage } from "../../src/utils/protocolGuards";
import type { ServerConfig } from "../../src/models/config";

function server(overrides: Partial<ServerConfig> = {}): ServerConfig {
  return {
    id: "s1",
    name: "eve-r1",
    host: "10.0.0.1",
    port: 23,
    username: "",
    authType: "password",
    isHidden: false,
    ...overrides
  };
}

describe("telnetUnsupportedMessage", () => {
  // ⊘ A guard that fires for every server breaks SFTP, tunnels and key deploy
  // for the whole SSH fleet — the failure mode of getting the polarity wrong.
  it("says nothing for an SSH server, explicit or default", () => {
    expect(telnetUnsupportedMessage(server(), "SFTP file browsing")).toBeUndefined();
    expect(telnetUnsupportedMessage(server({ protocol: "ssh" }), "SFTP file browsing")).toBeUndefined();
  });

  it("names both the feature and the server for a telnet server", () => {
    const message = telnetUnsupportedMessage(server({ protocol: "telnet" }), "SFTP file browsing");
    expect(message).toContain("SFTP file browsing");
    expect(message).toContain("eve-r1");
    expect(message).toContain("telnet");
  });

  // ⊘ A guard reading `server.protocol === "telnet"` directly would let a
  // hand-edited backup carrying "TELNET" past it and straight into the SSH path.
  it("resolves the protocol rather than trusting the stored value", () => {
    expect(telnetUnsupportedMessage({ name: "x", protocol: "TELNET" } as unknown as ServerConfig, "Tunnels")).toBeUndefined();
  });
});
