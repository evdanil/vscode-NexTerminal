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

  it("reports the real dropped-row count when truncated, not just one issue entry", () => {
    const text = Array.from({ length: 5100 }, (_, i) => `h${i}.example.com`).join("\n");
    const r = parseInventoryList(text);
    expect(r.truncatedCount).toBe(100);
  });

  it("does not truncate a header row plus exactly 5000 data rows", () => {
    const text = "host\n" + Array.from({ length: 5000 }, (_, i) => `h${i}.example.com`).join("\n");
    const r = parseInventoryList(text);
    expect(r.sessions).toHaveLength(5000);
    expect(r.truncatedCount).toBe(0);
    expect(r.issues.some((i) => /truncated/.test(i.reason))).toBe(false);
  });

  it("reports how many rows omit a username", () => {
    const r = parseInventoryList("sw1\nsw2,,admin\nsw3\n");
    expect(r.missingUsernameCount).toBe(2);
  });

  it("does not mistake a header column with punctuation in its own name for a data value", () => {
    // "mgmt.ip" and "ip:port" would previously veto header detection because they
    // contain a "." / ":" — even though they're header labels, not data. Two alias
    // matches (host + user) is decisive evidence this is a header row.
    const r1 = parseInventoryList("host,mgmt.ip,user\nr1,10.0.0.1,admin\n");
    expect(r1.sessions).toEqual([{ name: "r1", host: "r1", port: 22, username: "admin", folder: "" }]);

    const r2 = parseInventoryList("host,ip:port,user\nr2,10.0.0.2,admin\n");
    expect(r2.sessions).toEqual([{ name: "r2", host: "r2", port: 22, username: "admin", folder: "" }]);
  });

  it("reports an issue instead of silently dropping an ambiguous single-column header", () => {
    // "hostname" as the sole field on row 1 could be a header OR a device literally
    // named "hostname" — there's no second column to disambiguate. Default to
    // treating it as a header (existing/expected behaviour for genuine exports),
    // but tell the user rather than silently discarding the row.
    const r = parseInventoryList("hostname\nrouter1\n");
    expect(r.sessions).toEqual([{ name: "router1", host: "router1", port: 22, username: "", folder: "" }]);
    expect(r.issues.some((i) => i.line === 1 && /ambiguous header/.test(i.reason))).toBe(true);
  });

  it("rejects hosts over 253 characters instead of writing them straight through", () => {
    const hugeHost = "x".repeat(254);
    const r = parseInventoryList(hugeHost);
    expect(r.sessions).toHaveLength(0);
    expect(r.skippedCount).toBe(1);
    expect(r.issues[0].reason).toMatch(/exceeds 253 characters/);
  });

  it("accepts a host at exactly the 253 character limit", () => {
    const maxHost = "x".repeat(253);
    const r = parseInventoryList(`${maxHost},short-name,admin\n`);
    expect(r.sessions).toHaveLength(1);
  });

  it("rejects names over 128 characters", () => {
    const hugeName = "n".repeat(129);
    const r = parseInventoryList(`sw1,${hugeName},admin\n`);
    expect(r.sessions).toHaveLength(0);
    expect(r.issues[0].reason).toMatch(/exceeds 128 characters/);
  });

  it("allows underscores in hostnames", () => {
    const r = parseInventoryList("core_sw1,,admin\n");
    expect(r.sessions[0]).toMatchObject({ host: "core_sw1" });
  });

  it("collapses runs of tabs but keeps empty CSV fields meaningful", () => {
    const tabs = parseInventoryList("r1\t\tcore sw\tadmin\n");
    expect(tabs.sessions[0]).toMatchObject({ host: "r1", name: "core sw", username: "admin" });

    // A doubled comma delimiter must still be read as an explicit empty field.
    const csv = parseInventoryList("10.0.0.1,,admin,22\n");
    expect(csv.sessions[0]).toMatchObject({ host: "10.0.0.1", username: "admin", port: 22 });
  });

  it("reports an issue instead of silently discarding an invalid row-level folder", () => {
    const r = parseInventoryList("h1,n,u,22,../../etc\n");
    expect(r.sessions).toHaveLength(0);
    expect(r.skippedCount).toBe(1);
    expect(r.issues[0].reason).toMatch(/invalid folder/);
  });

  it("reports an issue when the combined default-folder prefix and row folder exceed the max depth", () => {
    const deepPrefix = Array.from({ length: 10 }, (_, i) => `L${i}`).join("/");
    const r = parseInventoryList("sw1,,admin,,Extra\n", { defaultFolder: deepPrefix });
    expect(r.sessions).toHaveLength(0);
    expect(r.issues[0].reason).toMatch(/invalid folder/);
  });

  describe("host:port shorthand edge cases (Codex finding 3)", () => {
    it("parses a plain hostname with no colon at all", () => {
      const r = parseInventoryList("router.example.com\n", { defaultUsername: "admin" });
      expect(r.sessions[0]).toMatchObject({ host: "router.example.com", port: 22 });
    });

    it("parses host:port shorthand", () => {
      const r = parseInventoryList("router.example.com:2022\n", { defaultUsername: "admin" });
      expect(r.sessions[0]).toMatchObject({ host: "router.example.com", port: 2022 });
      expect(r.issues).toHaveLength(0);
    });

    it("parses a bracketed IPv6 literal with a port, storing the bare literal without brackets (Codex round 2 finding A)", () => {
      const r = parseInventoryList("[2001:db8::1]:2022\n", { defaultUsername: "admin" });
      expect(r.sessions[0]).toMatchObject({ host: "2001:db8::1", port: 2022 });
      expect(r.issues).toHaveLength(0);
    });

    it("parses a bracketed IPv6 literal with no port, storing the bare literal and defaulting the port (Codex round 2 finding A)", () => {
      const r = parseInventoryList("[2001:db8::1]\n", { defaultUsername: "admin" });
      expect(r.sessions[0]).toMatchObject({ host: "2001:db8::1", port: 22 });
      expect(r.issues).toHaveLength(0);
    });

    it("parses a bare unbracketed IPv6 literal as a host with the default port", () => {
      const r = parseInventoryList("2001:db8::1\n", { defaultUsername: "admin" });
      expect(r.sessions[0]).toMatchObject({ host: "2001:db8::1", port: 22 });
      expect(r.issues).toHaveLength(0);
    });

    it("rejects a host:port shorthand with an out-of-range port instead of folding it into the hostname", () => {
      const r = parseInventoryList("router.example.com:70000\n", { defaultUsername: "admin" });
      expect(r.sessions).toHaveLength(0);
      expect(r.skippedCount).toBe(1);
      expect(r.issues[0].reason).toMatch(/invalid port "70000"/);
    });

    it("rejects a host:port shorthand with a non-numeric port instead of folding it into the hostname", () => {
      const r = parseInventoryList("router.example.com:notaport\n", { defaultUsername: "admin" });
      expect(r.sessions).toHaveLength(0);
      expect(r.skippedCount).toBe(1);
      expect(r.issues[0].reason).toMatch(/invalid port "notaport"/);
    });
  });
});
