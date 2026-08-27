/**
 * End-to-end wiring for the DHCP form's CIDR row and NIC-first picker, run
 * through the REAL rendered webview script (`test/helpers/formScriptHarness`)
 * with the REAL derivation (`dhcpFormAutofillFields`) answering it.
 *
 * Both ends matter and a test that stops at either cannot see the defect this
 * feature is exposed to. The script decides WHICH fields post an autofill and
 * WHEN; the derivation decides what may be written back; and the stale-answer
 * guard in between decides whether a late answer is applied to a network the
 * user has already moved away from. Only the DOM is a stand-in.
 */

import { describe, expect, it } from "vitest";
import { openForm } from "../../helpers/formScriptHarness";
import { networkServerFormDefinition, type DhcpServerFormSeed } from "../../../src/ui/formDefinitions";
import { dhcpFormAutofillFields, dhcpInterfaceChoices } from "../../../src/commands/networkServerSettings";
import type { NetworkInterfaceOption } from "../../../src/commands/networkInterfaceOptions";
import type { FormMessage, FormValues } from "../../../src/ui/formTypes";

const INTERFACES: readonly NetworkInterfaceOption[] = [
  { label: "All interfaces (0.0.0.0)", value: "" },
  { label: "eth0 — 192.168.9.5", value: "192.168.9.5", netmask: "255.255.255.0" },
  { label: "eth1 — 10.0.0.5", value: "10.0.0.5", netmask: "255.255.255.0" }
];

function dhcpForm(seed: DhcpServerFormSeed = {}) {
  return networkServerFormDefinition("dhcp", seed, {
    interfaceOptions: dhcpInterfaceChoices(INTERFACES, seed.rangeStart, seed.subnet)
  });
}

function lastAutofill(posted: readonly FormMessage[]): Extract<FormMessage, { type: "autofill" }> {
  const message = [...posted].reverse().find((entry) => entry.type === "autofill");
  expect(message, "no autofill was posted").toBeDefined();
  return message as Extract<FormMessage, { type: "autofill" }>;
}

/** Answers an autofill the way `openFullForm` wires it, and delivers the result. */
function answerAutofill(harness: ReturnType<typeof openForm>): Record<string, string> | undefined {
  const message = lastAutofill(harness.posted);
  const fills = dhcpFormAutofillFields(message.key, message.value, message.values, INTERFACES);
  if (fills) {
    harness.deliver({ type: "fillFields", key: message.key, value: message.value, values: fills });
  }
  return fills;
}

describe("DHCP form — which controls post an autofill", () => {
  it("posts the form's current values along with the network the user committed", () => {
    const harness = openForm(dhcpForm({ rangeStart: "192.168.2.10", subnet: "255.255.255.0", gateway: "192.168.2.1" }));
    harness.type("cidr", "10.0.0.0/24");

    const message = lastAutofill(harness.posted);
    expect(message.key).toBe("cidr");
    expect(message.value).toBe("10.0.0.0/24");
    // Without the snapshot the answer cannot tell a hand-typed gateway from a
    // stale derived one, and the hand-typed one is destroyed. Its presence in
    // the payload is the whole reason the message grew a `values` field.
    expect(message.values?.gateway).toBe("192.168.2.1");
    expect(message.values?.subnet).toBe("255.255.255.0");
  });

  it("does not post for a text field that did not opt in", () => {
    const harness = openForm(dhcpForm({ rangeStart: "192.168.2.10" }));
    // Gateway, Pool Start and Subnet Mask are plain text rows. Wiring the
    // listener to every text input instead of the flagged ones would turn each
    // of them into a round trip and, worse, hand `dhcpFormAutofillFields` a
    // value it would have to be careful to ignore.
    harness.type("gateway", "10.0.0.1");
    harness.type("rangeStart", "10.0.0.20");
    harness.type("subnet", "255.255.0.0");
    expect(harness.posted.filter((message) => message.type === "autofill")).toEqual([]);
  });
});

describe("DHCP form — a network typed into the CIDR row", () => {
  it("fills the mask, the pool and the addresses that follow, and keeps the hand-set gateway", () => {
    const harness = openForm(dhcpForm({ rangeStart: "192.168.2.10", subnet: "255.255.255.0", gateway: "192.168.2.1" }));
    harness.type("cidr", "10.0.0.0/24");
    answerAutofill(harness);

    const values: FormValues = harness.submit();
    expect(values.subnet).toBe("255.255.255.0");
    expect(values.rangeStart).toBe("10.0.0.1");
    expect(values.poolCount).toBe(253);
    expect(values.broadcast).toBe("10.0.0.255");
    // The decision the user made survives the network change.
    expect(values.gateway).toBe("192.168.2.1");
  });

  it("replaces a gateway that was itself derived from the previous network", () => {
    const harness = openForm(
      dhcpForm({ rangeStart: "192.168.2.10", subnet: "255.255.255.0", gateway: "192.168.2.254" })
    );
    harness.type("cidr", "10.0.0.0/24");
    answerAutofill(harness);
    expect(harness.submit().gateway).toBe("10.0.0.254");
  });

  it("writes nothing at all for a network that describes no pool", () => {
    const harness = openForm(dhcpForm({ rangeStart: "192.168.2.10", subnet: "255.255.255.0" }));
    harness.type("cidr", "10.0.0.1/32");

    // The message is still posted — the extension host is what knows /32 has no
    // pool — but the answer is empty, so not one field moves. A derivation that
    // filled "as much as it could" would leave the mask on 255.255.255.255 with
    // the pool still on the old network.
    expect(answerAutofill(harness)).toBeUndefined();
    const values = harness.submit();
    expect(values.subnet).toBe("255.255.255.0");
    expect(values.rangeStart).toBe("192.168.2.10");
  });

  it("discards an answer for a network the user has already moved away from", () => {
    const harness = openForm(dhcpForm({ rangeStart: "192.168.2.10", subnet: "255.255.255.0" }));
    harness.type("cidr", "10.0.0.0/24");
    const message = lastAutofill(harness.posted);
    const fills = dhcpFormAutofillFields(message.key, message.value, message.values, INTERFACES)!;

    // The round trip is outrun: the user retypes before the answer lands.
    harness.type("cidr", "172.16.0.0/16");
    harness.deliver({ type: "fillFields", key: "cidr", value: "10.0.0.0/24", values: fills });

    const values = harness.submit();
    expect(values.cidr).toBe("172.16.0.0/16");
    // 10.0.0.x must not be half-applied under a row that now says 172.16.0.0/16.
    expect(values.subnet).toBe("255.255.255.0");
    expect(values.rangeStart).toBe("192.168.2.10");
  });
});

describe("DHCP form — a NIC picked from the interface select", () => {
  it("derives the network that NIC is on and fills the pool from it", () => {
    const harness = openForm(dhcpForm({ rangeStart: "192.168.2.10", subnet: "255.255.255.0" }));
    harness.choose("interface", "10.0.0.5");

    const message = lastAutofill(harness.posted);
    expect(message.key).toBe("interface");
    expect(message.value).toBe("10.0.0.5");
    answerAutofill(harness);

    const values = harness.submit();
    expect(values.interface).toBe("10.0.0.5");
    expect(values.cidr).toBe("10.0.0.0/24");
    expect(values.rangeStart).toBe("10.0.0.1");
    expect(values.subnet).toBe("255.255.255.0");
  });

  it("leaves the pool alone when the all-interfaces choice is picked", () => {
    const harness = openForm(dhcpForm({ rangeStart: "192.168.2.10", subnet: "255.255.255.0" }));
    harness.choose("interface", "");

    // A blank value posts no autofill at all (the script guards on it), and
    // even if one arrived there is no single NIC to name a network from.
    expect(harness.posted.filter((message) => message.type === "autofill")).toEqual([]);
    const values = harness.submit();
    expect(values.rangeStart).toBe("192.168.2.10");
    expect(values.interface).toBe("");
  });

  it("annotates the NIC already on the pool's subnet in the rendered dropdown", () => {
    const definition = dhcpForm({ rangeStart: "10.0.0.10", subnet: "255.255.255.0" });
    const field = definition.fields.find((entry) => "key" in entry && entry.key === "interface");
    expect(field).toMatchObject({
      type: "select",
      autofill: true,
      options: expect.arrayContaining([
        { label: "eth1 — 10.0.0.5", value: "10.0.0.5", description: "matches the pool subnet" }
      ])
    });
  });

  it("leaves the TFTP interface picker a plain select with no annotations", () => {
    // TFTP has no pool, so there is nothing for a NIC to imply and nothing for
    // a subnet comparison to say. Turning autofill on there would post a
    // message the TFTP form wires no handler for.
    const definition = networkServerFormDefinition("tftp", {}, { interfaceOptions: [...INTERFACES] });
    const field = definition.fields.find((entry) => "key" in entry && entry.key === "interface");
    expect(field).not.toHaveProperty("autofill");
    expect(field).toMatchObject({ type: "select" });
  });
});
