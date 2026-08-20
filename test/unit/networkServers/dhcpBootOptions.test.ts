/**
 * @author kanekitakitos
 *
 * Unit tests for the ZTP boot-option encoders (`dhcp/engine/dhcpBootOptions.ts`).
 *
 * These are pure functions — no `dhcp` library, no socket, no `vscode` — and
 * the option 43 encoder is asserted byte-for-byte on purpose. A wrong length
 * byte or a hex literal encoded as text does not throw and does not show up in
 * any log: the device simply ignores the option and ZTP quietly does nothing,
 * which is exactly the class of bug worth pinning down with exact bytes.
 */

import { describe, expect, it } from "vitest";
import {
  encodeVendorSpecificInfo,
  isValidSubOptionCode,
  matchesVendorClass,
  parseVendorOptionValue
} from "../../../src/services/networkServers/dhcp/engine/dhcpBootOptions";

describe("encodeVendorSpecificInfo (DHCP option 43 TLV)", () => {
  it("encodes a single text sub-option as [code][length][value]", () => {
    const encoded = encodeVendorSpecificInfo([{ subOption: 1, value: "ztp" }]);
    expect([...encoded]).toEqual([0x01, 0x03, 0x7a, 0x74, 0x70]);
  });

  it("concatenates entries in order, each with its own header", () => {
    const encoded = encodeVendorSpecificInfo([
      { subOption: 1, value: "a" },
      { subOption: 242, value: "0x0A0B" }
    ]);
    // A header written one byte early or late would shift everything after it.
    expect([...encoded]).toEqual([0x01, 0x01, 0x61, 0xf2, 0x02, 0x0a, 0x0b]);
  });

  it("writes a 0x literal as raw bytes, not as its text", () => {
    const encoded = encodeVendorSpecificInfo([{ subOption: 43, value: "0xC0A80201" }]);
    // Text encoding would produce 10 bytes of ASCII digits instead of 4.
    expect([...encoded]).toEqual([0x2b, 0x04, 0xc0, 0xa8, 0x02, 0x01]);
  });

  it("lengths count bytes, not characters", () => {
    const encoded = encodeVendorSpecificInfo([{ subOption: 5, value: "é" }]);
    expect([...encoded]).toEqual([0x05, 0x02, 0xc3, 0xa9]);
  });

  it("emits a zero-length entry rather than dropping it", () => {
    const encoded = encodeVendorSpecificInfo([{ subOption: 7, value: "" }]);
    expect([...encoded]).toEqual([0x07, 0x00]);
  });

  it("returns an empty payload for no entries", () => {
    expect(encodeVendorSpecificInfo([]).length).toBe(0);
  });

  it("encodes the boundary sub-option codes 1 and 254", () => {
    expect([...encodeVendorSpecificInfo([{ subOption: 1, value: "x" }])]).toEqual([0x01, 0x01, 0x78]);
    expect([...encodeVendorSpecificInfo([{ subOption: 254, value: "x" }])]).toEqual([0xfe, 0x01, 0x78]);
  });

  it.each([0, 255, 256, -1, 1.5, Number.NaN])("rejects the reserved/invalid sub-option code %s", (code) => {
    expect(() => encodeVendorSpecificInfo([{ subOption: code, value: "x" }])).toThrow(/sub-option code/);
  });

  it("rejects a payload that cannot fit in one DHCP option", () => {
    // 2 header bytes + 200 value bytes, twice = 404 > 255.
    const entries = [
      { subOption: 1, value: "a".repeat(200) },
      { subOption: 2, value: "b".repeat(200) }
    ];
    expect(() => encodeVendorSpecificInfo(entries)).toThrow(/at most 255/);
  });

  it("rejects a single value longer than its length byte can describe", () => {
    expect(() => encodeVendorSpecificInfo([{ subOption: 1, value: "a".repeat(256) }])).toThrow(/256 bytes/);
  });

  it("accepts exactly 255 bytes of payload", () => {
    const encoded = encodeVendorSpecificInfo([{ subOption: 1, value: "a".repeat(253) }]);
    expect(encoded.length).toBe(255);
    expect(encoded[1]).toBe(253);
  });
});

describe("parseVendorOptionValue", () => {
  it("treats an unprefixed value as text", () => {
    expect([...parseVendorOptionValue("0A")]).toEqual([0x30, 0x41]);
  });

  it("ignores : - _ and whitespace inside a hex literal", () => {
    expect([...parseVendorOptionValue("0xAA:BB-CC_DD EE")]).toEqual([0xaa, 0xbb, 0xcc, 0xdd, 0xee]);
  });

  it("rejects an odd number of hex digits", () => {
    expect(() => parseVendorOptionValue("0xABC")).toThrow(/whole number of bytes/);
  });

  it("rejects non-hex characters after the prefix", () => {
    expect(() => parseVendorOptionValue("0xZZ")).toThrow(/only 0-9 and a-f/);
  });
});

describe("isValidSubOptionCode", () => {
  it("accepts 1-254 and rejects the reserved PAD/END codes", () => {
    expect(isValidSubOptionCode(1)).toBe(true);
    expect(isValidSubOptionCode(254)).toBe(true);
    expect(isValidSubOptionCode(0)).toBe(false);
    expect(isValidSubOptionCode(255)).toBe(false);
  });
});

describe("matchesVendorClass (DHCP option 60 gate)", () => {
  it("serves every client when no vendor class is configured", () => {
    expect(matchesVendorClass(undefined, "Cisco Systems, Inc.")).toBe(true);
    expect(matchesVendorClass("   ", undefined)).toBe(true);
  });

  it("matches ignoring case and surrounding whitespace", () => {
    expect(matchesVendorClass("ArubaInstantAP", " arubainstantap ")).toBe(true);
  });

  it("does not match a different identifier, including a prefix of it", () => {
    expect(matchesVendorClass("Cisco", "Cisco Systems, Inc.")).toBe(false);
    expect(matchesVendorClass("Cisco", "Aruba")).toBe(false);
  });

  it("refuses a client that sent no option 60 when a class is configured", () => {
    expect(matchesVendorClass("Cisco", undefined)).toBe(false);
    expect(matchesVendorClass("Cisco", 60)).toBe(false);
  });
});
