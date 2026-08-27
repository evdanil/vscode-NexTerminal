/**
 * `nexus.networkServers.dhcp.allowRelayAgents` — the one DHCP setting that
 * existed only in `package.json` and the settings panel, and the two places
 * that quietly disagreed about it.
 *
 * 1. PROFILE ROUND TRIP. `captureDhcpProfileBody()` has always stored the flag
 *    (it arrives with `readDhcpConfig()`'s spread), but
 *    `networkServerProfileSettingUpdates()` listed no row for it, so restoring
 *    a profile left whatever the live settings happened to hold. That is
 *    invisible in the common case — restore onto the same machine you saved on
 *    and the value matches by accident — so the fixtures below deliberately
 *    restore a profile whose flag DIFFERS from what a restore would otherwise
 *    leave, which is the only shape where a missing row and a working one look
 *    different.
 *
 * 2. DAEMON INGRESS. `parseDhcpConfigAt`'s key allowlist did not list it, and
 *    `readDhcpConfig()` puts it on EVERY config the host sends — `false`
 *    included. Both node-daemon ingress paths run that parser, so the spawn
 *    seed and every `configure` RPC were rejected wholesale for an unknown key
 *    while the sidebar went on showing the user's settings.
 */

import { describe, expect, it } from "vitest";
import { networkServerProfileSettingUpdates } from "../../../src/commands/networkServerSettings";
import {
  parseDhcpConfig,
  parseNetworkServerConfigs,
  sanitizeDhcpConfig
} from "../../../src/services/networkServers/networkServerConfigValidation";
import { networkServerFormDefinition } from "../../../src/ui/formDefinitions";
import type { DhcpConfigProfile } from "../../../src/models/networkServerProfile";

function dhcpProfile(allowRelayAgents: boolean | undefined): DhcpConfigProfile {
  return {
    id: "p1",
    kind: "dhcp",
    name: "Bench",
    config: { rangeStart: "10.0.0.10", rangeEnd: "10.0.0.99", ...(allowRelayAgents === undefined ? {} : { allowRelayAgents }) }
  };
}

function settingValue(profile: DhcpConfigProfile, key: string): unknown {
  const row = networkServerProfileSettingUpdates(profile).find(([name]) => name === key);
  expect(row, `no restore row writes ${key}`).toBeDefined();
  return row![1];
}

describe("allowRelayAgents — profile capture and restore agree", () => {
  it("restores a profile that had relayed requests switched ON", () => {
    expect(settingValue(dhcpProfile(true), "allowRelayAgents")).toBe(true);
  });

  it("restores a profile that had them OFF, rather than leaving the live value", () => {
    // The important direction. Restoring a bench profile onto a machine where
    // the flag is currently on has to turn it off — a DHCP server that keeps
    // honouring an unauthenticated giaddr because a restore skipped the key is
    // a security posture the user believes they replaced.
    expect(settingValue(dhcpProfile(false), "allowRelayAgents")).toBe(false);
  });

  it("writes the packaged default for a profile saved before the key existed", () => {
    // An older profile carries no flag at all. `undefined` would leave the live
    // setting in place; `false` is what "this profile does not enable relays"
    // has to mean, matching how every other absent key is restored.
    expect(settingValue(dhcpProfile(undefined), "allowRelayAgents")).toBe(false);
  });
});

describe("allowRelayAgents — the DHCP form exposes it", () => {
  it("renders a checkbox seeded from the current configuration", () => {
    const on = networkServerFormDefinition("dhcp", { allowRelayAgents: true }).fields.find(
      (field) => "key" in field && field.key === "allowRelayAgents"
    );
    expect(on).toMatchObject({ type: "checkbox", value: true });
    const off = networkServerFormDefinition("dhcp", {}).fields.find(
      (field) => "key" in field && field.key === "allowRelayAgents"
    );
    // Unset must render unchecked, not "whatever the checkbox defaults to":
    // saving the form writes every key it renders, so a checkbox that opened
    // checked over an unset setting would switch relays on by being looked at.
    expect(off).toMatchObject({ type: "checkbox", value: false });
  });
});

describe("allowRelayAgents — daemon ingress accepts the key the host actually sends", () => {
  // Exactly the shape `readDhcpConfig()` produces: the flag is spread in
  // unconditionally, so it is present on every payload, `false` included.
  const HOST_CONFIG = {
    rangeStart: "10.0.0.10",
    rangeEnd: "10.0.0.99",
    subnet: "255.255.255.0",
    leaseTimeSec: 86_400,
    allowRelayAgents: false
  };

  it("does not reject the configure payload as an unknown key", () => {
    const parsed = parseNetworkServerConfigs({ dhcp: HOST_CONFIG });
    expect(parsed.ok).toBe(true);
  });

  it("keeps the value rather than merely tolerating the key", () => {
    // Accept-and-drop would leave the node daemon's config controller unable to
    // see a toggle as a change at all, so flipping the setting would apply on
    // the next restart and never through `configure`.
    const parsed = parseDhcpConfig({ ...HOST_CONFIG, allowRelayAgents: true });
    expect(parsed.ok && parsed.value.allowRelayAgents).toBe(true);
    const off = parseDhcpConfig(HOST_CONFIG);
    expect(off.ok && off.value.allowRelayAgents).toBe(false);
  });

  it("still refuses a non-boolean, and still refuses genuinely unknown keys", () => {
    const bad = parseDhcpConfig({ ...HOST_CONFIG, allowRelayAgents: "yes" });
    expect(bad.ok).toBe(false);
    expect(bad.ok === false && bad.errors[0]).toContain("dhcp.allowRelayAgents");
    // Widening the allowlist must not have turned it into a pass-through.
    const unknown = parseDhcpConfig({ ...HOST_CONFIG, allowRelayAgentss: true });
    expect(unknown.ok).toBe(false);
  });

  it("does not warn about the key on the settings-sanitizing path either", () => {
    const sanitized = sanitizeDhcpConfig({ ...HOST_CONFIG, allowRelayAgents: true });
    expect(sanitized.warnings).toEqual([]);
    expect(sanitized.value.allowRelayAgents).toBe(true);
  });
});
