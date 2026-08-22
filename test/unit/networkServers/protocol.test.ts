/**
 * @author kanekitakitos
 *
 * Unit tests for the TFTP wire format (`tftp/engine/protocol.ts`).
 *
 * Scope is deliberately the serialization layer only — pure functions, no I/O,
 * no sockets, no `vscode` mocking:
 *  1. encode* → parsePacket round-trip for every opcode (RRQ/WRQ/DATA/ACK/
 *     ERROR/OACK).
 *  2. Malformed datagrams raise ProtocolError, and unknown opcodes are
 *     silently ignored rather than throwing.
 *  3. validateOptions honours the RFC 2348/2349/7440 limits and defaults.
 *  4. validatedToRaw compresses default-valued options out of the OACK.
 *
 * Ported from the standalone add-on's `tests/unit/protocol.test.ts`
 * (node:test + node:assert/strict) with the assertions rewritten for Vitest.
 */

import { describe, expect, it } from "vitest";
import {
  encodeRRQ,
  encodeWRQ,
  encodeACK,
  encodeDATA,
  encodeERROR,
  encodeOACK,
  parsePacket,
  getOpcode,
  validateOptions,
  validatedToRaw,
  ProtocolError
} from "../../../src/services/networkServers/tftp/engine/protocol";
import {
  Opcode,
  ErrorCode,
  DEFAULT_BLOCK_SIZE,
  DEFAULT_WINDOW_SIZE,
  MAX_IN_FLIGHT_BYTES,
  MAX_RETRANSMISSION_PACKETS
} from "../../../src/services/networkServers/tftp/engine/types";

describe("TFTP Protocol (protocol.ts)", () => {
  describe("encode/parse round-trip", () => {
    it("RRQ (no options) must round-trip identical", () => {
      const pkt = encodeRRQ("firmware.bin", "octet");
      expect(getOpcode(pkt)).toBe(Opcode.RRQ);
      const parsed = parsePacket(pkt)!;
      expect(parsed.opcode).toBe(Opcode.RRQ);
      if (parsed.opcode === Opcode.RRQ) {
        expect(parsed.filename).toBe("firmware.bin");
        expect(parsed.mode).toBe("octet");
        expect(parsed.options).toEqual({});
      }
    });

    // Was a netascii round-trip until netascii became a rejected mode (the
    // engine never implemented its CR/LF conversion, so accepting it corrupted
    // text transfers silently). The option round-trip this test exists for is
    // unchanged; only the mode it carries is. Netascii's own behaviour is
    // asserted in "malformed packets must throw ProtocolError" below.
    it("WRQ with options (blksize=1400 windowsize=8 tsize=3000) round-trip", () => {
      const pkt = encodeWRQ("upload.bin", "octet", { blksize: "1400", windowsize: "8", tsize: "3000" });
      const parsed = parsePacket(pkt)!;
      expect(parsed.opcode).toBe(Opcode.WRQ);
      if (parsed.opcode === Opcode.WRQ) {
        expect(parsed.filename).toBe("upload.bin");
        expect(parsed.mode).toBe("octet");
        expect(parsed.options.blksize).toBe("1400");
        expect(parsed.options.windowsize).toBe("8");
        expect(parsed.options.tsize).toBe("3000");
      }
    });

    it("ACK blockNum 0/1/65535 round-trip", () => {
      for (const n of [0, 1, 1234, 65535]) {
        const parsed = parsePacket(encodeACK(n))!;
        expect(parsed.opcode).toBe(Opcode.ACK);
        if (parsed.opcode === Opcode.ACK) expect(parsed.blockNum).toBe(n);
      }
    });

    it("DATA block=1 with 512 B + DATA last block=4 42 B round-trip", () => {
      const data = Buffer.alloc(512, 0xab);
      const pk = parsePacket(encodeDATA(1, data))!;
      expect(pk.opcode).toBe(Opcode.DATA);
      if (pk.opcode === Opcode.DATA) {
        expect(pk.blockNum).toBe(1);
        expect(pk.data.length).toBe(512);
        expect(pk.data[0]).toBe(0xab);
      }
      const small = Buffer.alloc(42, 0xcd);
      const pks = parsePacket(encodeDATA(4, small))!;
      if (pks.opcode === Opcode.DATA) {
        expect(pks.blockNum).toBe(4);
        expect(pks.data.length).toBe(42);
        expect(pks.data[41]).toBe(0xcd);
      }
    });

    it("ERROR DiskFull with custom message round-trip", () => {
      const pkt = encodeERROR(ErrorCode.DiskFull, "Custom disk full message");
      const parsed = parsePacket(pkt)!;
      expect(parsed.opcode).toBe(Opcode.ERROR);
      if (parsed.opcode === Opcode.ERROR) {
        expect(parsed.errorCode).toBe(ErrorCode.DiskFull);
        expect(parsed.message).toBe("Custom disk full message");
      }
    });

    it("ERROR AccessViolation without custom message uses ERROR_MESSAGES default", () => {
      const pkt = encodeERROR(ErrorCode.AccessViolation);
      const parsed = parsePacket(pkt)!;
      if (parsed.opcode === Opcode.ERROR) {
        expect(parsed.errorCode).toBe(ErrorCode.AccessViolation);
        expect(parsed.message).toMatch(/Access violation/i);
      }
    });

    it("OACK options round-trip (blksize + timeout + tsize + windowsize)", () => {
      const opts = { blksize: "1428", timeout: "3", tsize: "123456", windowsize: "16" };
      const parsed = parsePacket(encodeOACK(opts))!;
      expect(parsed.opcode).toBe(Opcode.OACK);
      if (parsed.opcode === Opcode.OACK) {
        expect(parsed.options.blksize).toBe("1428");
        expect(parsed.options.timeout).toBe("3");
        expect(parsed.options.tsize).toBe("123456");
        expect(parsed.options.windowsize).toBe("16");
      }
    });

    it("empty OACK (0 options) is valid: opcode OACK, options {}", () => {
      const parsed = parsePacket(encodeOACK({}))!;
      expect(parsed.opcode).toBe(Opcode.OACK);
      if (parsed.opcode === Opcode.OACK) expect(parsed.options).toEqual({});
    });

    it("getOpcode Buffer < 2 bytes = undefined", () => {
      expect(getOpcode(Buffer.alloc(0))).toBeUndefined();
      expect(getOpcode(Buffer.alloc(1))).toBeUndefined();
    });
  });

  describe("malformed packets must throw ProtocolError", () => {
    it("Packet only 1 byte (less than opcode header)", () => {
      expect(() => parsePacket(Buffer.alloc(1))).toThrow(ProtocolError);
    });

    it("RRQ without filename nor mode (insufficient length)", () => {
      const buf = Buffer.from([0, 1, 0, 0]);
      expect(() => parsePacket(buf)).toThrow(ProtocolError);
    });

    it('RRQ invalid mode "badmode"', () => {
      const buf = Buffer.concat([Buffer.from([0, 1]), Buffer.from("file.bin\x00badmode\x00", "ascii")]);
      expect(() => parsePacket(buf)).toThrow(ProtocolError);
    });

    // RRQ/WRQ are raw byte operations here — no CR/LF conversion anywhere in
    // the read or write path. Accepting `netascii` and then not performing it
    // corrupts text transferred between hosts with different line conventions,
    // and does so silently: both ends believe the transfer succeeded. Refusing
    // is the honest answer, and the error names the mode that does work.
    it("RRQ netascii → ProtocolError naming octet, not a silently raw transfer", () => {
      expect(() => parsePacket(encodeRRQ("cfg.txt", "netascii"))).toThrow(ProtocolError);
      expect(() => parsePacket(encodeRRQ("cfg.txt", "netascii"))).toThrow(/octet/i);
    });

    it("WRQ netascii → ProtocolError as well (upload corrupts the same way)", () => {
      expect(() => parsePacket(encodeWRQ("cfg.txt", "NETASCII"))).toThrow(ProtocolError);
    });

    it("RRQ with option list odd token count → malformed", () => {
      const buf = Buffer.concat([
        Buffer.from([0, 1]),
        Buffer.from("f.bin\x00octet\x00blksize\x00", "ascii") // key without value
      ]);
      expect(() => parsePacket(buf)).toThrow(ProtocolError);
    });

    it("DATA < 4 bytes (missing blockNum)", () => {
      // 0x00 0x03 + 1 byte of payload (not enough for blockNum)
      const buf = Buffer.from([0, 3, 0xaa]);
      expect(() => parsePacket(buf)).toThrow(ProtocolError);
    });

    it("ACK < 4 bytes", () => {
      expect(() => parsePacket(Buffer.from([0, 4, 0]))).toThrow(ProtocolError);
    });

    it("ERROR < 4 bytes", () => {
      expect(() => parsePacket(Buffer.from([0, 5, 0]))).toThrow(ProtocolError);
    });

    it("Unknown opcode 99 → parsePacket returns undefined", () => {
      const buf = Buffer.alloc(6);
      buf.writeUInt16BE(99, 0);
      expect(parsePacket(buf)).toBeUndefined();
    });
  });

  describe("validateOptions", () => {
    it("default values: blksize=512, windowsize=1, timeout/tsize undefined", () => {
      const v = validateOptions({});
      expect(v.blksize).toBe(DEFAULT_BLOCK_SIZE);
      expect(v.windowsize).toBe(DEFAULT_WINDOW_SIZE);
      expect(v.timeout).toBeUndefined();
      expect(v.tsize).toBeUndefined();
    });

    it("blksize 1400 + timeout 5 + windowsize 64 + tsize 1_000_000", () => {
      const v = validateOptions({ blksize: "1400", timeout: "5", windowsize: "64", tsize: "1000000" });
      expect(v.blksize).toBe(1400);
      expect(v.timeout).toBe(5);
      expect(v.windowsize).toBe(64);
      expect(v.tsize).toBe(1_000_000);
    });

    it("blksize < 8 → ProtocolError", () => {
      expect(() => validateOptions({ blksize: "5" })).toThrow(ProtocolError);
    });

    it("blksize > 65464 → ProtocolError", () => {
      expect(() => validateOptions({ blksize: "99999" })).toThrow(ProtocolError);
    });

    it("blksize NaN (string) → ProtocolError", () => {
      expect(() => validateOptions({ blksize: "abc" })).toThrow(ProtocolError);
    });

    it("timeout < 1 or > 255 → ProtocolError", () => {
      expect(() => validateOptions({ timeout: "0" })).toThrow(ProtocolError);
      expect(() => validateOptions({ timeout: "256" })).toThrow(ProtocolError);
    });

    it("windowsize < 1 → ProtocolError", () => {
      expect(() => validateOptions({ windowsize: "0" })).toThrow(ProtocolError);
    });

    it("clamps a tiny-block window to retransmission capacity", () => {
      const v = validateOptions({ blksize: "8", windowsize: "65535" });
      expect(v.windowsize).toBe(MAX_RETRANSMISSION_PACKETS);
    });

    it("does not clamp the retransmission boundary itself", () => {
      expect(validateOptions({ blksize: "8", windowsize: "256" }).windowsize).toBe(256);
      expect(validateOptions({ blksize: "8", windowsize: "257" }).windowsize).toBe(256);
    });

    it("negative tsize → ProtocolError", () => {
      expect(() => validateOptions({ tsize: "-1" })).toThrow(ProtocolError);
    });

    // The two options are each bounded by their own RFC, but the PRODUCT is
    // what `TransferSession.produceNextSendPackets` allocates in one go. At the
    // RFC maxima that is 65464 * 65535 ≈ 4.3 GB per session, negotiated by a
    // single unauthenticated datagram — so the bound has to be on the product.
    describe("in-flight byte budget (blksize * windowsize)", () => {
      it("clamps windowsize so the window never exceeds MAX_IN_FLIGHT_BYTES", () => {
        const v = validateOptions({ blksize: "65464", windowsize: "65535" });
        expect(v.blksize, "blksize is the client's MTU choice and must survive intact").toBe(65464);
        expect(v.windowsize).toBe(Math.floor(MAX_IN_FLIGHT_BYTES / 65464));
        expect(v.blksize * v.windowsize).toBeLessThanOrEqual(MAX_IN_FLIGHT_BYTES);
      });

      it("clamps at any blksize, not just the maximum", () => {
        const v = validateOptions({ blksize: "8192", windowsize: "4096" });
        expect(v.windowsize).toBe(MAX_IN_FLIGHT_BYTES / 8192);
        expect(v.blksize * v.windowsize).toBeLessThanOrEqual(MAX_IN_FLIGHT_BYTES);
      });

      it("leaves a window that already fits the budget untouched", () => {
        // 1468 * 64 ≈ 94 KB — a realistic PXE/ZTP negotiation. The clamp must
        // not slow down transfers it has no reason to touch.
        const v = validateOptions({ blksize: "1468", windowsize: "64" });
        expect(v.windowsize).toBe(64);
      });
    });

    it("validatedToRaw omits defaults (blksize=512 not included, windowsize=1 also not)", () => {
      const raw = validatedToRaw({ blksize: DEFAULT_BLOCK_SIZE, windowsize: DEFAULT_WINDOW_SIZE });
      expect(raw).toEqual({});
    });

    it("validatedToRaw only includes non-default options + timeout and tsize if defined", () => {
      const raw = validatedToRaw({ blksize: 1400, windowsize: 8, timeout: 3, tsize: 1234 });
      expect(raw.blksize).toBe("1400");
      expect(raw.windowsize).toBe("8");
      expect(raw.timeout).toBe("3");
      expect(raw.tsize).toBe("1234");
    });
  });
});
