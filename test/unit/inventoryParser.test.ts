import { describe, expect, it } from "vitest";
import { parseInventoryList } from "../../src/utils/inventoryParser";

describe("parseInventoryList", () => {
  it("parses a bare hostname list and derives names from the first DNS label", () => {
    const r = parseInventoryList("sw1.lab.example.com\nsw2.lab.example.com\n", { defaultUsername: "admin" });
    expect(r.sessions).toEqual([
      { name: "sw1", host: "sw1.lab.example.com", port: 22, username: "admin", folder: "" },
      { name: "sw2", host: "sw2.lab.example.com", port: 22, username: "admin", folder: "" },
    ]);
    expect(r.skippedCount).toBe(0);
  });

  it("honours a header row and maps columns by name in any order", () => {
    const text = "Site,Device Name,Mgmt IP,SSH Port,User\nDC1/RackA,core-sw,10.0.0.1,2222,netadmin\n";
    const r = parseInventoryList(text);
    expect(r.sessions[0]).toEqual({
      name: "core-sw", host: "10.0.0.1", port: 2222, username: "netadmin", folder: "DC1/RackA",
    });
    expect(r.folders).toEqual(["DC1/RackA"]);
  });

  it("parses positional csv rows", () => {
    const r = parseInventoryList("10.0.0.5,edge1,admin,22,Branch/NSW\n");
    expect(r.sessions[0]).toEqual({ name: "edge1", host: "10.0.0.5", port: 22, username: "admin", folder: "Branch/NSW" });
  });

  it("accepts host,port shorthand in positional mode", () => {
    const r = parseInventoryList("10.0.0.5,2200\n", { defaultUsername: "u" });
    expect(r.sessions[0]).toMatchObject({ host: "10.0.0.5", port: 2200, name: "10.0.0.5" });
  });

  it("parses user@host:port shorthand", () => {
    const r = parseInventoryList("netadmin@sw9.example.com:2022\n");
    expect(r.sessions[0]).toMatchObject({ host: "sw9.example.com", port: 2022, username: "netadmin" });
  });

  it("supports tab-separated and whitespace-separated input", () => {
    const tab = parseInventoryList("sw1\tSwitch One\tadmin\n");
    expect(tab.sessions[0]).toMatchObject({ host: "sw1", name: "Switch One", username: "admin" });
    const ws = parseInventoryList("sw2   Switch Two\n");
    expect(ws.sessions[0]).toMatchObject({ host: "sw2" });
  });

  it("handles quoted fields containing commas", () => {
    const r = parseInventoryList('10.0.0.9,"Core, Building B",admin\n');
    expect(r.sessions[0].name).toBe("Core, Building B");
  });

  it("does not mistake a bare hostname that merely contains a header trigger word for a header", () => {
    const r = parseInventoryList("host1\nipmi1.example.com\n");
    expect(r.sessions).toHaveLength(2);
    expect(r.sessions[0]).toMatchObject({ host: "host1" });
    expect(r.sessions[1]).toMatchObject({ host: "ipmi1.example.com" });
  });

  it("treats a mid-row integer in a 3+ field row as a name, not a port (model-numbered switches)", () => {
    const r = parseInventoryList("10.0.0.5,3750,admin\n");
    expect(r.sessions[0]).toEqual({ name: "3750", host: "10.0.0.5", port: 22, username: "admin", folder: "" });
  });

  it("dedups in-file hosts case-insensitively", () => {
    const r = parseInventoryList("SW1.example.com,a,admin\nsw1.example.com,b,admin\n");
    expect(r.sessions).toHaveLength(1);
    expect(r.issues[0].reason).toMatch(/duplicate of line 1/);
  });

  it("skips blank lines and # comments", () => {
    const r = parseInventoryList("# inventory\n\nsw1\n");
    expect(r.sessions).toHaveLength(1);
    expect(r.skippedCount).toBe(0);
  });

  it("reports invalid hosts and ports as issues without aborting the import", () => {
    const r = parseInventoryList("good.example.com\nbad host name\n10.0.0.1,x,y,99999\n");
    expect(r.sessions).toHaveLength(1);
    expect(r.skippedCount).toBe(2);
    expect(r.issues.map((i) => i.line)).toEqual([2, 3]);
    expect(r.issues[1].reason).toMatch(/port/i);
  });

  it("skips in-file duplicates and says which line they duplicate", () => {
    const r = parseInventoryList("sw1,a,admin\nsw1,b,admin\n");
    expect(r.sessions).toHaveLength(1);
    expect(r.issues[0].reason).toMatch(/duplicate of line 1/);
  });

  it("flags when rows have no username so the caller can prompt for one", () => {
    expect(parseInventoryList("sw1\n").needsDefaultUsername).toBe(true);
    expect(parseInventoryList("sw1,name,admin\n").needsDefaultUsername).toBe(false);
  });

  it("applies defaultFolder as a prefix", () => {
    const r = parseInventoryList("sw1,,admin,,RackA\n", { defaultFolder: "Site7" });
    expect(r.sessions[0].folder).toBe("Site7/RackA");
  });

  it("strips a BOM and tolerates CRLF", () => {
    const r = parseInventoryList("﻿sw1\r\nsw2\r\n");
    expect(r.sessions).toHaveLength(2);
  });

  it("truncates absurdly large inputs", () => {
    const text = Array.from({ length: 5100 }, (_, i) => `h${i}.example.com`).join("\n");
    const r = parseInventoryList(text);
    expect(r.sessions).toHaveLength(5000);
    expect(r.issues.some((i) => /truncated/.test(i.reason))).toBe(true);
  });
});
