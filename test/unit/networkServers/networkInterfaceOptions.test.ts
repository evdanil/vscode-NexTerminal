/**
 * @author kanekitakitos
 *
 * Unit tests for the bind-address picker's two halves:
 *  1. `networkInterfaceBindOptions()` (`src/commands/networkInterfaceOptions.ts`)
 *     — what this machine currently offers, read from a mocked `node:os`.
 *  2. `bindInterfaceField` inside `networkServerFormDefinition`
 *     (`src/ui/formDefinitions.ts`) — how a CONFIGURED address is reconciled
 *     against that live list. The two are deliberately separate: the enumerator
 *     never sees the setting, and the form never enumerates.
 *
 * The reconciliation is the half worth pinning down. A `select` silently renders
 * its first option for a value it does not carry, so an address the setting
 * holds but the machine no longer has would display as "All interfaces" and Save
 * would then rebind the service to every interface without the user asking.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const networkInterfaces = vi.hoisted(() => vi.fn());

vi.mock("node:os", () => ({ networkInterfaces }));

import { ALL_INTERFACES_OPTION, networkInterfaceBindOptions } from "../../../src/commands/networkInterfaceOptions";
import { networkServerFormDefinition } from "../../../src/ui/formDefinitions";
import type { FormFieldDescriptor } from "../../../src/ui/formTypes";

type FakeAddress = { address: string; family: string; internal: boolean };

function ipv4(address: string, internal = false): FakeAddress {
  return { address, family: "IPv4", internal };
}

function ipv6(address: string, internal = false): FakeAddress {
  return { address, family: "IPv6", internal };
}

function interfaceField(definition: { fields: FormFieldDescriptor[] }): Extract<
  FormFieldDescriptor,
  { type: "select" }
> {
  const field = definition.fields.find((f) => "key" in f && f.key === "interface");
  if (!field || field.type !== "select") {
    throw new Error("the form no longer renders an `interface` select");
  }
  return field;
}

beforeEach(() => {
  networkInterfaces.mockReset();
});

describe("networkInterfaceBindOptions", () => {
  it("leads with the all-interfaces choice, whose value is empty so Save clears the setting", () => {
    networkInterfaces.mockReturnValue({ eth0: [ipv4("10.0.0.5")] });
    const options = networkInterfaceBindOptions();
    expect(options[0]).toEqual({ label: "All interfaces (0.0.0.0)", value: "" });
    expect(ALL_INTERFACES_OPTION.value).toBe("");
  });

  it("labels each address as `<name> — <address>`", () => {
    networkInterfaces.mockReturnValue({ "Wi-Fi": [ipv4("192.168.1.20")] });
    expect(networkInterfaceBindOptions()[1]).toEqual({ label: "Wi-Fi — 192.168.1.20", value: "192.168.1.20" });
  });

  it("offers IPv4 only", () => {
    networkInterfaces.mockReturnValue({
      eth0: [ipv6("fe80::1"), ipv4("10.0.0.5"), ipv6("2001:db8::1")]
    });
    expect(networkInterfaceBindOptions().map((o) => o.value)).toEqual(["", "10.0.0.5"]);
  });

  it("drops loopback and other internal addresses while an external one remains", () => {
    networkInterfaces.mockReturnValue({
      lo: [ipv4("127.0.0.1", true)],
      "vEthernet (WSL)": [ipv4("172.28.1.1", true)],
      eth0: [ipv4("10.0.0.5")]
    });
    expect(networkInterfaceBindOptions().map((o) => o.value)).toEqual(["", "10.0.0.5"]);
  });

  it("re-runs including internal addresses when nothing external exists", () => {
    networkInterfaces.mockReturnValue({
      lo: [ipv4("127.0.0.1", true)],
      eth0: [ipv6("fe80::1")]
    });
    expect(networkInterfaceBindOptions()).toEqual([
      { label: "All interfaces (0.0.0.0)", value: "" },
      { label: "lo — 127.0.0.1", value: "127.0.0.1" }
    ]);
  });

  it("offers the all-interfaces choice alone on a machine with no IPv4 at all", () => {
    networkInterfaces.mockReturnValue({ eth0: [ipv6("fe80::1")] });
    expect(networkInterfaceBindOptions()).toEqual([{ label: "All interfaces (0.0.0.0)", value: "" }]);
  });

  it("dedupes an address that appears on more than one interface, keeping the first", () => {
    networkInterfaces.mockReturnValue({
      eth0: [ipv4("10.0.0.5")],
      "eth0:1": [ipv4("10.0.0.5")],
      eth1: [ipv4("10.0.0.6")]
    });
    expect(networkInterfaceBindOptions().map((o) => o.label)).toEqual([
      "All interfaces (0.0.0.0)",
      "eth0 — 10.0.0.5",
      "eth1 — 10.0.0.6"
    ]);
  });

  it("never emits a second all-interfaces row for a NIC reporting 0.0.0.0", () => {
    networkInterfaces.mockReturnValue({ any: [ipv4("0.0.0.0")], eth0: [ipv4("10.0.0.5")] });
    expect(networkInterfaceBindOptions().filter((o) => o.value === "")).toHaveLength(1);
    expect(networkInterfaceBindOptions().some((o) => o.value === "0.0.0.0")).toBe(false);
  });

  it("tolerates an interface entry reported as undefined", () => {
    networkInterfaces.mockReturnValue({ ghost: undefined, eth0: [ipv4("10.0.0.5")] });
    expect(networkInterfaceBindOptions().map((o) => o.value)).toEqual(["", "10.0.0.5"]);
  });
});

describe("bind-address field — configured value reconciled against the live list", () => {
  const live = [
    { label: "eth0 — 10.0.0.5", value: "10.0.0.5" },
    { label: "Wi-Fi — 192.168.1.20", value: "192.168.1.20" }
  ];

  it("appends a configured address this machine no longer has, flagged and selectable", () => {
    const field = interfaceField(
      networkServerFormDefinition("dhcp", { bindAddress: "172.16.9.9" }, { interfaceOptions: live })
    );
    expect(field.value).toBe("172.16.9.9");
    expect(field.options).toContainEqual({ label: "172.16.9.9 — not currently available", value: "172.16.9.9" });
    // Appended, never promoted: the live NICs keep their order and the
    // all-interfaces choice keeps the lead.
    expect(field.options.map((o) => o.value)).toEqual(["", "10.0.0.5", "192.168.1.20", "172.16.9.9"]);
  });

  it("does not duplicate a configured address the machine still has", () => {
    const field = interfaceField(
      networkServerFormDefinition("dhcp", { bindAddress: "10.0.0.5" }, { interfaceOptions: live })
    );
    expect(field.value).toBe("10.0.0.5");
    expect(field.options.filter((o) => o.value === "10.0.0.5")).toHaveLength(1);
    expect(field.options.some((o) => o.label.includes("not currently available"))).toBe(false);
  });

  it("folds a literal 0.0.0.0 onto the all-interfaces choice instead of flagging it", () => {
    const field = interfaceField(
      networkServerFormDefinition("dhcp", { bindAddress: "0.0.0.0" }, { interfaceOptions: live })
    );
    expect(field.value).toBe("");
    expect(field.options.some((o) => o.label.includes("not currently available"))).toBe(false);
  });

  it("treats a whitespace-only setting as unset", () => {
    const field = interfaceField(
      networkServerFormDefinition("dhcp", { bindAddress: "   " }, { interfaceOptions: live })
    );
    expect(field.value).toBe("");
    expect(field.options).toEqual([{ label: "All interfaces (0.0.0.0)", value: "" }, ...live]);
  });

  it("still offers the configured address when no live list was supplied", () => {
    const field = interfaceField(networkServerFormDefinition("dhcp", { bindAddress: "172.16.9.9" }));
    expect(field.options).toEqual([
      { label: "All interfaces (0.0.0.0)", value: "" },
      { label: "172.16.9.9 — not currently available", value: "172.16.9.9" }
    ]);
  });

  it("reconciles the TFTP form's `interface` setting the same way", () => {
    const field = interfaceField(
      networkServerFormDefinition("tftp", { interface: "172.16.9.9" }, { interfaceOptions: live })
    );
    expect(field.value).toBe("172.16.9.9");
    expect(field.options).toContainEqual({ label: "172.16.9.9 — not currently available", value: "172.16.9.9" });
  });
});
