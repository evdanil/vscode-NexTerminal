import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseContainerlabConfig } from "../../src/services/inventory/providers/containerlabConfig";
import { parseContainerlabInspection } from "../../src/services/inventory/providers/containerlabParser";
import type { ContainerlabInspection } from "../../src/services/inventory/containerlabRuntimeContracts";

type Row = Record<string, unknown>;
type InspectOutput = Record<string, Row[]>;

function readFixture(name: string): InspectOutput {
  return JSON.parse(readFileSync(join(__dirname, "../fixtures/containerlab", name), "utf8")) as InspectOutput;
}

function clonedFixture(name = "inspect-0.80.0.json"): InspectOutput {
  return structuredClone(readFixture(name));
}

function onlyRow(output: InspectOutput, lab = "fixture-lab"): Row {
  return output[lab][0];
}

function inspection(output: unknown, version = "0.80.0"): ContainerlabInspection {
  return { version, stdout: JSON.stringify(output) };
}

const defaultConfig = () => parseContainerlabConfig({});

describe("parseContainerlabInspection", () => {
  it.each([
    ["inspect-0.68.0.json", "0.68.0"],
    ["inspect-0.80.0.json", "0.80.0"]
  ])("maps the pinned %s detailed output", (fixture, version) => {
    const tree = parseContainerlabInspection(
      { version, stdout: readFileSync(join(__dirname, "../fixtures/containerlab", fixture), "utf8") },
      defaultConfig()
    );

    expect(tree).toMatchObject({
      contractVersion: 1,
      devices: [
        {
          externalId: JSON.stringify(["fixture-lab", "clab-fixture-lab-node1"]),
          name: "node1",
          folderPath: "fixture-lab",
          endpoints: [],
          attributes: {
            lab: "fixture-lab",
            kind: "linux",
            image: "network-node:22.04",
            nodeName: "node1",
            name: "node1"
          }
        }
      ],
      status: {
        contractVersion: 1,
        statuses: {
          [JSON.stringify(["fixture-lab", "clab-fixture-lab-node1"])]: { state: "stopped" }
        }
      }
    });
  });

  it.each(["null", "[]", '{"fixture-lab":', '{"fixture-lab":[{}]}'])(
    "refuses invalid discovery without returning an empty tree: %s",
    (stdout) => {
      expect(() => parseContainerlabInspection({ version: "0.80.0", stdout }, defaultConfig())).toThrow();
    }
  );

  it("accepts the documented empty object and refuses versions below stable 0.68.0", () => {
    expect(parseContainerlabInspection({ version: "0.68.0", stdout: "{}" }, defaultConfig())).toMatchObject({
      contractVersion: 1,
      devices: [],
      status: { contractVersion: 1, statuses: {} }
    });
    expect(() => parseContainerlabInspection({ version: "0.67.9", stdout: "{}" }, defaultConfig())).toThrow(/0\.68\.0|upgrade/i);
    expect(() => parseContainerlabInspection({ version: "0.68.0-rc.1", stdout: "{}" }, defaultConfig())).toThrow(/0\.68\.0|upgrade/i);
    expect(() => parseContainerlabInspection({ version: "9007199254740992.0.0", stdout: "{}" }, defaultConfig())).toThrow(/version/i);
  });

  it("validates every lab before applying the exact lab filter", () => {
    const output = clonedFixture();
    output.other = [structuredClone(onlyRow(output))];
    (output.other[0].Labels as Record<string, string>).containerlab = "wrong-lab";
    expect(() => parseContainerlabInspection(inspection(output), parseContainerlabConfig({ labFilter: "fixture-lab" }))).toThrow(/label|lab/i);

    const good = clonedFixture();
    good.other = [structuredClone(onlyRow(good))];
    (good.other[0].Labels as Record<string, string>).containerlab = "other";
    expect(parseContainerlabInspection(inspection(good), parseContainerlabConfig({ labFilter: "fixture-lab" })).devices)
      .toHaveLength(1);

    const malformedAddress = clonedFixture();
    malformedAddress.other = [structuredClone(onlyRow(malformedAddress))];
    (malformedAddress.other[0].Labels as Record<string, string>).containerlab = "other";
    (malformedAddress.other[0].NetworkSettings as Record<string, unknown>).IPv4addr = "999.1.1.1";
    expect(() => parseContainerlabInspection(
      inspection(malformedAddress), parseContainerlabConfig({ labFilter: "fixture-lab" })
    )).toThrow(/address|invalid/i);
  });

  it("validates network addresses before the mapping cap", () => {
    const base = onlyRow(clonedFixture());
    const rows = Array.from({ length: 10_001 }, (_, index) => {
      const row = structuredClone(base);
      row.Names = [`node-${index}`];
      (row.Labels as Record<string, string>)["clab-node-name"] = `node-${index}`;
      return row;
    });
    (rows[10_000].NetworkSettings as Record<string, unknown>).IPv6addr = "not-an-ipv6-address";
    expect(() => parseContainerlabInspection(inspection({ "fixture-lab": rows }), defaultConfig())).toThrow(/address|invalid/i);
  });

  it("uses container names for stable identity across redeploys and uses the node label for display", () => {
    const first = clonedFixture();
    const second = clonedFixture();
    const firstRow = onlyRow(first);
    const secondRow = onlyRow(second);
    secondRow.ID = "different-container-id";
    secondRow.ShortID = "different-short-id";
    const settings = secondRow.NetworkSettings as Record<string, unknown>;
    settings.IPv4addr = "192.0.2.55";
    settings.IPv4pLen = 24;

    const firstDevice = parseContainerlabInspection(inspection(first), defaultConfig()).devices[0];
    const secondDevice = parseContainerlabInspection(inspection(second), defaultConfig()).devices[0];
    expect(secondDevice.externalId).toBe(firstDevice.externalId);
    expect(secondDevice.name).toBe("node1");
    expect(secondDevice.endpoints[0]?.host).toBe("192.0.2.55");

    (firstRow.Names as string[])[0] = "/clab-fixture-lab-node1";
    expect(parseContainerlabInspection(inspection(first), defaultConfig()).devices[0].externalId).toBe(firstDevice.externalId);
  });

  it("groups by escaped lab folder segments and preserves custom container names", () => {
    const output = clonedFixture();
    output["lab/with\\separators"] = [structuredClone(onlyRow(output))];
    const row = output["lab/with\\separators"][0];
    (row.Labels as Record<string, string>).containerlab = "lab/with\\separators";
    row.Names = ["custom-container-name"];
    (row.Labels as Record<string, string>)["clab-node-name"] = "router-custom";
    const device = parseContainerlabInspection(inspection(output), defaultConfig()).devices[1];
    expect(device.externalId).toBe(JSON.stringify(["lab/with\\separators", "custom-container-name"]));
    expect(device.name).toBe("router-custom");
    expect(device.folderPath).toBe("lab%2Fwith%5Cseparators");
  });

  it("prefers the configured IP family, falls back when needed, and allows a zero prefix length", () => {
    const output = clonedFixture();
    const settings = onlyRow(output).NetworkSettings as Record<string, unknown>;
    settings.IPv4addr = "192.0.2.10";
    settings.IPv4pLen = 0;
    settings.IPv6addr = "2001:db8::10";
    settings.IPv6pLen = 64;
    expect(parseContainerlabInspection(inspection(output), parseContainerlabConfig({ addressPreference: "ipv6" })).devices[0].endpoints)
      .toEqual([{ kind: "ssh", host: "2001:db8::10", port: 22 }]);

    settings.IPv6addr = "";
    settings.IPv6pLen = 0;
    expect(parseContainerlabInspection(inspection(output), parseContainerlabConfig({ addressPreference: "ipv6" })).devices[0].endpoints)
      .toEqual([{ kind: "ssh", host: "192.0.2.10", port: 22 }]);
  });

  it("strips valid CIDR suffixes and rejects malformed CIDR or host data", () => {
    const output = clonedFixture();
    const settings = onlyRow(output).NetworkSettings as Record<string, unknown>;
    settings.IPv4addr = "198.51.100.7/24";
    settings.IPv4pLen = 24;
    expect(parseContainerlabInspection(inspection(output), defaultConfig()).devices[0].endpoints[0].host).toBe("198.51.100.7");

    for (const bad of ["198.51.100.7/33", "198.51.100.7/nope", "bad host", "999.1.1.1", "2001:db8::1/129"]) {
      const invalid = clonedFixture();
      (onlyRow(invalid).NetworkSettings as Record<string, unknown>).IPv4addr = bad;
      expect(() => parseContainerlabInspection(inspection(invalid), defaultConfig())).toThrow();
    }
    const invalidIpv6 = clonedFixture();
    (onlyRow(invalidIpv6).NetworkSettings as Record<string, unknown>).IPv6addr = "192.0.2.1::";
    expect(() => parseContainerlabInspection(inspection(invalidIpv6), defaultConfig())).toThrow(/address|invalid/i);
  });

  it("rejects leading-zero IPv4 octets rather than accepting ambiguous endpoints", () => {
    const output = clonedFixture();
    (onlyRow(output).NetworkSettings as Record<string, unknown>).IPv4addr = "010.020.030.040";
    expect(() => parseContainerlabInspection(inspection(output), defaultConfig())).toThrow(/address|invalid/i);
  });

  it("rejects multiple dotted IPv4 groups inside IPv6 literals", () => {
    const output = clonedFixture();
    (onlyRow(output).NetworkSettings as Record<string, unknown>).IPv6addr = "::192.0.2.1:198.51.100.2";
    expect(() => parseContainerlabInspection(inspection(output), defaultConfig())).toThrow(/address|invalid/i);
  });

  it.each(["::ffff:192.0.2.1", "2001:db8::192.0.2.1", "2001:db8:0:0:0:0:192.0.2.1"])(
    "accepts an IPv4-embedded IPv6 address only as its terminal dotted-quad tail: %s",
    (address) => {
      const output = clonedFixture();
      const settings = onlyRow(output).NetworkSettings as Record<string, unknown>;
      settings.IPv6addr = address;
      settings.IPv6pLen = 128;
      const tree = parseContainerlabInspection(inspection(output), parseContainerlabConfig({ addressPreference: "ipv6" }));
      expect(tree.devices[0].endpoints).toEqual([{ kind: "ssh", host: address, port: 22 }]);
    }
  );

  it("maps created/exited/dead/paused to stopped and clears unfamiliar or transitional states", () => {
    for (const state of ["created", "exited", "dead", "paused"]) {
      const output = clonedFixture();
      onlyRow(output).State = state;
      expect(parseContainerlabInspection(inspection(output), defaultConfig()).status?.statuses[JSON.stringify(["fixture-lab", "clab-fixture-lab-node1"])])
        .toEqual({ state: "stopped" });
    }
    const output = clonedFixture();
    onlyRow(output).State = "running";
    const running = parseContainerlabInspection(inspection(output), defaultConfig());
    expect(running.status?.statuses[JSON.stringify(["fixture-lab", "clab-fixture-lab-node1"])])
      .toEqual({ state: "running" });
    for (const state of ["restarting", "removing", "unrecognized"]) {
      const unknown = clonedFixture();
      onlyRow(unknown).State = state;
      const tree = parseContainerlabInspection(inspection(unknown), defaultConfig());
      expect(tree.status?.statuses).not.toHaveProperty(JSON.stringify(["fixture-lab", "clab-fixture-lab-node1"]));
      expect(tree.status?.clearedExternalIds).toContain(JSON.stringify(["fixture-lab", "clab-fixture-lab-node1"]));
    }
  });

  it("excludes only explicitly labeled helpers after validating their labels", () => {
    const output = clonedFixture();
    (onlyRow(output).Labels as Record<string, string>)["clab-internal-node"] = "true";
    const helpersOnly = parseContainerlabInspection(inspection(output), defaultConfig());
    expect(helpersOnly.devices).toEqual([]);
    expect(helpersOnly.status).toEqual({ contractVersion: 1, statuses: {} });
    expect(helpersOnly).not.toHaveProperty("truncated");

    const malformed = clonedFixture();
    (onlyRow(malformed).Labels as Record<string, string>)["clab-internal-node"] = "TRUE";
    delete (onlyRow(malformed).Labels as Record<string, string>)["clab-node-name"];
    expect(() => parseContainerlabInspection(inspection(malformed), defaultConfig())).toThrow(/node/i);
  });

  it.each([
    ["missing label map", (row: Row) => { delete row.Labels; }],
    ["non-string label value", (row: Row) => { (row.Labels as Record<string, unknown>).kind = 2; }],
    ["wrong containerlab label", (row: Row) => { (row.Labels as Record<string, string>).containerlab = "other"; }],
    ["missing authoritative node label", (row: Row) => { delete (row.Labels as Record<string, string>)["clab-node-name"]; }],
    ["missing container name", (row: Row) => { row.Names = []; }],
    ["missing network details", (row: Row) => { delete row.NetworkSettings; }]
  ])("rejects a malformed row (%s)", (_label, mutate) => {
    const output = clonedFixture();
    mutate(onlyRow(output));
    expect(() => parseContainerlabInspection(inspection(output), defaultConfig())).toThrow();
  });

  it("rejects duplicate identity and validates malformed rows beyond the mapping cap", () => {
    const duplicate = clonedFixture();
    duplicate["fixture-lab"].push(structuredClone(onlyRow(duplicate)));
    expect(() => parseContainerlabInspection(inspection(duplicate), defaultConfig())).toThrow(/duplicate/i);

    const base = onlyRow(clonedFixture());
    const rows = Array.from({ length: 10_001 }, (_, index) => {
      const row = structuredClone(base);
      row.Names = [`clab-fixture-lab-node-${index}`];
      (row.Labels as Record<string, string>)["clab-node-name"] = `node-${index}`;
      return row;
    });
    rows[10_000].Labels = null;
    expect(() => parseContainerlabInspection(inspection({ "fixture-lab": rows }), defaultConfig())).toThrow(/label/i);
  });

  it("signals exact-cap and over-cap results as complete and partial respectively", () => {
    const row = onlyRow(clonedFixture());
    const exact = Array.from({ length: 10_000 }, (_, index) => {
      const copy = structuredClone(row);
      copy.Names = [`node-${index}`];
      (copy.Labels as Record<string, string>)["clab-node-name"] = `node-${index}`;
      return copy;
    });
    const exactTree = parseContainerlabInspection(inspection({ "fixture-lab": exact }), defaultConfig());
    expect(exactTree.devices).toHaveLength(10_000);
    expect(exactTree.truncated).toBeUndefined();

    const over = [...exact, structuredClone(exact[0])];
    over[10_000].Names = ["node-over-cap"];
    (over[10_000].Labels as Record<string, string>)["clab-node-name"] = "node-over-cap";
    const partialTree = parseContainerlabInspection(inspection({ "fixture-lab": over }), defaultConfig());
    expect(partialTree.devices).toHaveLength(10_000);
    expect(partialTree.truncated).toBe(true);
    expect(partialTree.status?.truncated).toBe(true);
  });

  it("preserves observed unknown-state clears in a partial status report", () => {
    const base = onlyRow(clonedFixture());
    const rows = Array.from({ length: 10_001 }, (_, index) => {
      const row = structuredClone(base);
      row.Names = [`node-${index}`];
      row.State = index === 0 ? "restarting" : "running";
      (row.Labels as Record<string, string>)["clab-node-name"] = `node-${index}`;
      return row;
    });
    const tree = parseContainerlabInspection(inspection({ "fixture-lab": rows }), defaultConfig());
    expect(tree.status?.truncated).toBe(true);
    expect(tree.status?.clearedExternalIds).toContain(JSON.stringify(["fixture-lab", "node-0"]));
  });
});
