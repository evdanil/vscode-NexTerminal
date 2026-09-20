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
   * P2 (Codex review) — the guard is SHARED across providers and gets no
   * provider identity, but an addressless server can come from an IP-less NetBox
   * row (remedy: assign an address in NetBox), not only a stopped EVE-NG node.
   * So the message must NOT prescribe an EVE-NG-specific remedy.
   */
  it("is provider-NEUTRAL — it does not tell the user to start something in EVE-NG (⊘ EVE-NG-specific advice is wrong for an IP-less NetBox row)", () => {
    const message = addresslessUnavailableMessage(server({ addressless: true, host: "" }));
    expect(message).not.toMatch(/eve-ng/i);
    // Points at the inventory source as the general remedy.
    expect(message?.toLowerCase()).toContain("source");
  });
});

/**
 * WEB CONSOLE VARIANT — for a device whose inventory source offers a browser
 * console (a Proxmox guest with no qemu-guest-agent), the neutral message is
 * actively wrong in every clause: the address is not missing "yet", the guest is
 * not offline, and no amount of re-syncing will ever assign it one. The remedy
 * that does exist — Open Web Console, which needs only vmid + node — goes
 * unmentioned. The variant is OPT-IN on a capability the caller establishes,
 * which is what keeps the default answer provider-neutral.
 */
describe("addresslessUnavailableMessage — web-console variant", () => {
  it("points an addressless console-capable device at its web console instead of a re-sync (⊘ the neutral text tells the owner of an agentless guest to wait for an address that never arrives)", () => {
    const message = addresslessUnavailableMessage(server({ addressless: true, host: "" }), { webConsoleAvailable: true });
    expect(message).toContain("eve-r1");
    expect(message?.toLowerCase()).toContain("web console");
    // The three misleading clauses of the neutral text must all be gone.
    expect(message).not.toMatch(/yet/i);
    expect(message).not.toMatch(/offline/i);
    expect(message).not.toMatch(/re-sync/i);
  });

  it("leaves the message UNCHANGED for an addressless device with no console — an IP-less NetBox row (⊘ mentioning a console the row does not have sends the user hunting for a button that is not there)", () => {
    const neutral = addresslessUnavailableMessage(server({ addressless: true, host: "" }));
    expect(addresslessUnavailableMessage(server({ addressless: true, host: "" }), {})).toBe(neutral);
    expect(addresslessUnavailableMessage(server({ addressless: true, host: "" }), { webConsoleAvailable: false })).toBe(neutral);
    // The neutral text is the one the other five call sites keep getting.
    expect(neutral).toMatch(/re-sync the source/i);
    expect(neutral).not.toMatch(/web console/i);
  });

  it("still says nothing for an ADDRESSED server even when a console is available (⊘ a capability-first read turns the guard into a blanket refusal for every console-capable guest that has an address)", () => {
    expect(addresslessUnavailableMessage(server(), { webConsoleAvailable: true })).toBeUndefined();
  });
});
