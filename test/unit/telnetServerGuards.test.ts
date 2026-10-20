import { describe, expect, it } from "vitest";
import { addresslessUnavailableMessage, telnetUnsupportedMessage } from "../../src/utils/protocolGuards";
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

describe("addresslessUnavailableMessage", () => {
  it("says nothing for a non-addressless server (⊘ a blanket refusal breaks every ordinary server)", () => {
    expect(addresslessUnavailableMessage(server())).toBeUndefined();
    expect(addresslessUnavailableMessage(server({ addressless: false }))).toBeUndefined();
  });

  it("names the server and explains the no-address state for an addressless one", () => {
    const message = addresslessUnavailableMessage(server({ addressless: true, host: "" }));
    expect(message).toContain("eve-r1");
    expect(message?.toLowerCase()).toContain("no console address");
  });

  /**
   * The guard is shared across providers and receives no provider identity.
   * Manual endpoint editing is available for every placeholder; resync is
   * conditional on the source later reporting an address.
   */
  it("offers a manual endpoint and conditional resync without implying an address will appear", () => {
    const message = addresslessUnavailableMessage(server({ addressless: true, host: "" }));
    expect(message).toContain("no console address.");
    expect(message).toContain("edit the profile's Host, Port and connection settings.");
    expect(message).toContain("Re-sync the source if it later reports an address.");
    expect(message).not.toMatch(/no console address yet|offline|hasn't assigned|re-sync the source once it has an address/i);
    expect(message).not.toMatch(/eve-ng|netbox|containerlab/i);
  });
});

/**
 * WEB CONSOLE VARIANT — for a device whose inventory source offers a browser
 * console (a Proxmox guest with no qemu-guest-agent), the neutral message's
 * manual endpoint and conditional resync remedies do not open that console.
 * Open Web Console needs only vmid + node, so the variant is OPT-IN on a
 * capability the caller establishes and keeps the default answer provider-neutral.
 */
describe("addresslessUnavailableMessage — web-console variant", () => {
  it("points an addressless console-capable device at its web console instead of profile endpoint advice", () => {
    const message = addresslessUnavailableMessage(server({ addressless: true, host: "" }), { webConsoleAvailable: true });
    expect(message).toContain("eve-r1");
    expect(message?.toLowerCase()).toContain("web console");
    // The old temporal, availability and resync claims must stay out of this branch.
    expect(message).not.toMatch(/yet/i);
    expect(message).not.toMatch(/offline/i);
    expect(message).not.toMatch(/re-sync/i);
  });

  it("leaves the message UNCHANGED for an addressless device with no console — an IP-less NetBox row (⊘ mentioning a console the row does not have sends the user hunting for a button that is not there)", () => {
    const neutral = addresslessUnavailableMessage(server({ addressless: true, host: "" }));
    expect(addresslessUnavailableMessage(server({ addressless: true, host: "" }), {})).toBe(neutral);
    expect(addresslessUnavailableMessage(server({ addressless: true, host: "" }), { webConsoleAvailable: false })).toBe(neutral);
    // The neutral fallback stays shared with call sites that have no console capability.
    expect(neutral).toContain("Re-sync the source if it later reports an address.");
    expect(neutral).not.toMatch(/web console/i);
  });

  it("still says nothing for an ADDRESSED server even when a console is available (⊘ a capability-first read turns the guard into a blanket refusal for every console-capable guest that has an address)", () => {
    expect(addresslessUnavailableMessage(server(), { webConsoleAvailable: true })).toBeUndefined();
  });
});
