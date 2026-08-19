/**
 * @author kanekitakitos
 *
 * Unit tests for the per-session TFTP state machine
 * (`tftp/engine/TransferSession.ts`).
 *
 * The FSM is deliberately decoupled from UDP I/O, so this suite drives it
 * directly with no sockets and no engine:
 *  1. Constructor invariants + option-negotiation failure path.
 *  2. RRQ/WRQ initialisation, including the OACK-vs-no-options branch and the
 *     two divergent post-OACK ACK(0) transitions (RRQ → Sending / produce data,
 *     WRQ → Receiving / do NOT produce data).
 *  3. A full RRQ read from a real temp file through produceNextSendPackets, and
 *     the WRQ receive path through handleDATA (including out-of-order and
 *     over-blksize rejections).
 *  4. The outbound retransmission queue: window clearing, backoff timing, and
 *     the maxRetries cut-off.
 *  5. EWMA speed / ETA reporting and the 65535 → 1 block wrap.
 *
 * Ported from the standalone add-on's `tests/unit/transfersession.test.ts`.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { Opcode, ErrorCode } from "../../../src/services/networkServers/tftp/engine/types";
import {
  TransferSession,
  TransferPhase,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_MAX_RETRIES
} from "../../../src/services/networkServers/tftp/engine/TransferSession";
import { encodeACK, getOpcode } from "../../../src/services/networkServers/tftp/engine/protocol";
import { mkdtemp, randomPayload, sleep } from "../../helpers/networkServerTestHelpers";

function mkPeer(port = 50000) {
  return { address: "127.0.0.1", port };
}

describe("TFTP TransferSession (no network)", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtemp("nexus-ts-");
  });
  afterEach(() => {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  describe("constructor + invariants", () => {
    it("creates basic RRQ TransferSession: Idle, blksize=512, window=1", () => {
      const t = new TransferSession({
        peer: mkPeer(),
        opcode: Opcode.RRQ,
        filename: "a.bin",
        absFilePath: path.join(root, "a.bin"),
        mode: "octet",
        rawOptions: {}
      });
      expect(t.phase).toBe(TransferPhase.Idle);
      expect(t.opts.blksize).toBe(512);
      expect(t.opts.windowsize).toBe(1);
      expect(t.timeoutMs).toBe(DEFAULT_TIMEOUT_MS);
      expect(t.maxRetries).toBe(DEFAULT_MAX_RETRIES);
      expect(typeof t.startedAt).toBe("number");
      expect(t.startedAt > Date.now() - 10_000).toBe(true);
    });

    it("invalid rawOptions → phase Error + OptionNegotiation", () => {
      const t = new TransferSession({
        peer: mkPeer(),
        opcode: Opcode.RRQ,
        filename: "a.bin",
        absFilePath: path.join(root, "a.bin"),
        mode: "octet",
        rawOptions: { blksize: "5" } // < 8 (min)
      });
      expect(t.phase).toBe(TransferPhase.Error);
      expect(t.errorCode).toBe(ErrorCode.OptionNegotiation);
    });

    it("RFC options blksize=1400 timeout=3 windowsize=8 tsize=0 parsed", () => {
      const t = new TransferSession({
        peer: mkPeer(),
        opcode: Opcode.RRQ,
        filename: "b.bin",
        absFilePath: path.join(root, "b.bin"),
        mode: "octet",
        rawOptions: { blksize: "1400", timeout: "3", windowsize: "8", tsize: "0" }
      });
      expect(t.opts.blksize).toBe(1400);
      expect(t.opts.windowsize).toBe(8);
      expect(t.opts.timeout).toBe(3);
      expect(t.opts.tsize).toBe(0);
      expect(t.timeoutMs).toBe(3000); // timeout * 1000
    });
  });

  describe("RRQ initForRRQ transitions OACK vs no-options", () => {
    it("WITHOUT options → phase Sending, returns [] (does not send OACK)", () => {
      const t = new TransferSession({
        peer: mkPeer(),
        opcode: Opcode.RRQ,
        filename: "r.bin",
        absFilePath: path.join(root, "r.bin"),
        mode: "octet",
        rawOptions: {}
      });
      const pkts = t.initForRRQ(false, 2000);
      expect(pkts.length).toBe(0);
      expect(t.phase).toBe(TransferPhase.Sending);
      expect(t.fileSize).toBe(2000);
    });

    it("WITH options → phase SendOACK, returns 1 OACK packet", () => {
      const t = new TransferSession({
        peer: mkPeer(),
        opcode: Opcode.RRQ,
        filename: "r2.bin",
        absFilePath: path.join(root, "r2.bin"),
        mode: "octet",
        rawOptions: { blksize: "1400", windowsize: "4", tsize: "0" }
      });
      const pkts = t.initForRRQ(true, 3000);
      expect(pkts.length).toBe(1);
      expect(getOpcode(pkts[0]!)).toBe(6); // OACK
      expect(t.phase).toBe(TransferPhase.SendOACK);
      expect(t.opts.tsize).toBe(3000); // fills tsize=0 → fileSize
    });
  });

  describe("WRQ initForWRQ transitions", () => {
    it("WITHOUT options → phase RecvInitialACK + returns ACK(0)", () => {
      const t = new TransferSession({
        peer: mkPeer(),
        opcode: Opcode.WRQ,
        filename: "w.bin",
        absFilePath: path.join(root, "w.bin"),
        mode: "octet",
        rawOptions: {}
      });
      const pkts = t.initForWRQ(false);
      expect(pkts.length).toBe(1);
      const op = getOpcode(pkts[0]!);
      expect(op).toBe(4); // ACK
      const bn = pkts[0]!.readUInt16BE(2);
      expect(bn).toBe(0);
      expect(t.phase).toBe(TransferPhase.RecvInitialACK);
    });

    it("WITH options → phase SendOACK + returns OACK", () => {
      const t = new TransferSession({
        peer: mkPeer(),
        opcode: Opcode.WRQ,
        filename: "w2.bin",
        absFilePath: path.join(root, "w2.bin"),
        mode: "octet",
        rawOptions: { blksize: "1400", windowsize: "4" }
      });
      const pkts = t.initForWRQ(true);
      expect(pkts.length).toBe(1);
      expect(getOpcode(pkts[0]!)).toBe(6); // OACK
      expect(t.phase).toBe(TransferPhase.SendOACK);
    });
  });

  describe("CRITICAL handleACK: OACK transitions RRQ vs WRQ", () => {
    it("RRQ with options: after OACK sent handleACK(0) → phase Sending + produceMore=true (sends data next)", () => {
      const t = new TransferSession({
        peer: mkPeer(),
        opcode: Opcode.RRQ,
        filename: "r.bin",
        absFilePath: path.join(root, "r.bin"),
        mode: "octet",
        rawOptions: { blksize: "1400" }
      });
      t.initForRRQ(true, 1000);
      expect(t.phase).toBe(TransferPhase.SendOACK);
      const r = t.handleACK(0);
      expect(t.phase, "RRQ SendOACK→ACK(0) must go to Sending (to produce data)").toBe(TransferPhase.Sending);
      expect(r.produceMore).toBe(true);
      expect(r.done).toBe(false);
      expect(r.send.length).toBe(0);
    });

    it("WRQ with options: after OACK sent handleACK(0) → phase Receiving + produceMore=false (does NOT produce data!)", () => {
      const t = new TransferSession({
        peer: mkPeer(),
        opcode: Opcode.WRQ,
        filename: "w.bin",
        absFilePath: path.join(root, "w.bin"),
        mode: "octet",
        rawOptions: { blksize: "1400" }
      });
      t.initForWRQ(true);
      expect(t.phase).toBe(TransferPhase.SendOACK);
      const r = t.handleACK(0);
      expect(t.phase, "WRQ SendOACK→ACK(0) must go to Receiving (awaits DATA(1))").toBe(TransferPhase.Receiving);
      expect(r.produceMore).toBe(false);
      expect(r.done).toBe(false);
    });
  });

  describe("RRQ end-to-end (with produceNextSendPackets I/O reading a file)", () => {
    it("RRQ 1578 bytes (3*512 + 42) blksize=512 window=1: DATA(1) ACK(1) DATA(2) ACK(2) DATA(3) ACK(3) DATA(4) ACK(4) → Done", async () => {
      const p = path.join(root, "fw.bin");
      const payload = randomPayload(1578);
      fs.writeFileSync(p, payload);
      const t = new TransferSession({
        peer: mkPeer(),
        opcode: Opcode.RRQ,
        filename: "fw.bin",
        absFilePath: p,
        mode: "octet",
        rawOptions: {}
      });
      t.initForRRQ(false, payload.length);
      expect(t.phase).toBe(TransferPhase.Sending);

      const collected: Buffer[] = [];
      // 3 full blocks + 1 last
      for (let i = 1; i <= 4; i++) {
        const pkts = await t.produceNextSendPackets();
        expect(pkts.length, `Expected 1 DATA packet on iteration ${i}`).toBe(1);
        const op = getOpcode(pkts[0]!);
        expect(op).toBe(3); // DATA
        const blockNum = pkts[0]!.readUInt16BE(2);
        expect(blockNum).toBe(i);
        const data = pkts[0]!.subarray(4);
        collected.push(data);
        const r = t.handleACK(i);
        if (i < 4) {
          expect(r.done).toBe(false);
          expect(r.produceMore).toBe(true);
        } else {
          // ACK(4) for last DATA(4) of 42 B
          expect(r.done, "Expected done=true after ACK(4)").toBe(true);
          expect(t.phase).toBe(TransferPhase.Done);
        }
      }
      const out = Buffer.concat(collected);
      expect(out.equals(payload), "Final assembled RRQ payload must be identical").toBe(true);
      await t.closeFile();
    });
  });

  describe("handleDATA WRQ flow", () => {
    it("WRQ blksize=512, 2*512+100 B: progressive handleDATA(1..3), last returns done=true + ACK + write", () => {
      const t = new TransferSession({
        peer: mkPeer(),
        opcode: Opcode.WRQ,
        filename: "wr.bin",
        absFilePath: path.join(root, "wr.bin"),
        mode: "octet",
        rawOptions: {}
      });
      t.initForWRQ(false); // ACK(0)
      // Data: 1124 bytes → 2 blocks 512 + 1 block 100
      const chunks = [randomPayload(512), randomPayload(512), randomPayload(100)];
      const writes: Buffer[] = [];
      for (let i = 1; i <= 3; i++) {
        const r = t.handleDATA(i, chunks[i - 1]!);
        if (r.write) writes.push(r.write);
        expect(r.send.length >= 1).toBe(true);
        const last = i === 3;
        expect(r.done).toBe(last);
      }
      const assembled = Buffer.concat(writes);
      const expected = Buffer.concat(chunks);
      expect(assembled.equals(expected)).toBe(true);
      expect(t.bytesTransferred).toBe(1124);
      expect(t.phase).toBe(TransferPhase.Done);
    });

    it("handleDATA out-of-order block 2 before block 1 → ERROR IllegalOperation + done=true", () => {
      const t = new TransferSession({
        peer: mkPeer(),
        opcode: Opcode.WRQ,
        filename: "wr.bin",
        absFilePath: path.join(root, "wr.bin"),
        mode: "octet",
        rawOptions: {}
      });
      t.initForWRQ(false);
      const r = t.handleDATA(2, randomPayload(512));
      expect(t.phase).toBe(TransferPhase.Error);
      expect(t.errorCode).toBe(ErrorCode.IllegalOperation);
      expect(r.done).toBe(true);
      expect(r.write).toBeNull();
    });

    it("handleDATA DATA length > blksize → IllegalOperation", () => {
      const t = new TransferSession({
        peer: mkPeer(),
        opcode: Opcode.WRQ,
        filename: "wr.bin",
        absFilePath: path.join(root, "wr.bin"),
        mode: "octet",
        rawOptions: { blksize: "128" }
      });
      t.initForWRQ(false);
      void t.handleDATA(1, randomPayload(256)); // > 128
      expect(t.phase).toBe(TransferPhase.Error);
      expect(t.errorCode).toBe(ErrorCode.IllegalOperation);
      expect(t.errorMessage ?? "").toMatch(/exceeds blksize/i);
    });
  });

  describe("Outbound Retransmission Queue", () => {
    it("recordOutbound + clearOutboundUpToAck removes old packets", () => {
      const t = new TransferSession({
        peer: mkPeer(),
        opcode: Opcode.RRQ,
        filename: "a.bin",
        absFilePath: path.join(root, "a.bin"),
        mode: "octet",
        rawOptions: {}
      });
      for (let i = 1; i <= 5; i++) t.recordOutbound([encodeACK(i)]);
      // 5 ACK packets recorded
      t.clearOutboundUpToAck(3); // removes 1..3
      // After cleanup, retx would only return ACK(4) and ACK(5)
      const remaining = t.consumeRetransmission()!;
      expect(remaining.length).toBe(2);
    });

    it("timeForRetransmission initially false without packets; after record + sleep timeout, true", async () => {
      const t = new TransferSession({
        peer: mkPeer(),
        opcode: Opcode.RRQ,
        filename: "a.bin",
        absFilePath: path.join(root, "a.bin"),
        mode: "octet",
        rawOptions: { timeout: "1" } // 1 sec
      });
      expect(t.timeForRetransmission()).toBe(false);
      t.recordOutbound([encodeACK(1)]);
      expect(t.timeForRetransmission()).toBe(false); // still early
      await sleep(1100);
      expect(t.timeForRetransmission()).toBe(true);
    });

    it("consumeRetransmission 6 times: maxRetries=5 → 6th time returns null + phase Error", () => {
      const t = new TransferSession({
        peer: mkPeer(),
        opcode: Opcode.RRQ,
        filename: "a.bin",
        absFilePath: path.join(root, "a.bin"),
        mode: "octet",
        rawOptions: {}
      });
      t.recordOutbound([encodeACK(1)]);
      let nullFoundAt = -1;
      for (let i = 1; i <= 10; i++) {
        const r = t.consumeRetransmission();
        if (r === null && nullFoundAt === -1) {
          nullFoundAt = i;
          break;
        }
      }
      expect(
        nullFoundAt,
        `Max retries ${DEFAULT_MAX_RETRIES}: consume must return null on attempt ${DEFAULT_MAX_RETRIES + 1}`
      ).toBe(DEFAULT_MAX_RETRIES + 1);
      expect(t.phase).toBe(TransferPhase.Error);
      expect(t.errorMessage ?? "").toMatch(/Max retries exceeded/i);
    });
  });

  describe("Speed EWMA metrics", () => {
    it("just 1 sample of 500000 B/s → speedBps ≈ 500_000; ETA calculated", () => {
      const t = new TransferSession({
        peer: mkPeer(),
        opcode: Opcode.RRQ,
        filename: "a.bin",
        absFilePath: path.join(root, "a.bin"),
        mode: "octet",
        rawOptions: {}
      });
      t.initForRRQ(false, 1_000_000);
      t.bytesTransferred = 500_000;
      (t as any).speedBps = 500_000;
      const m = t.getMetrics();
      expect(m.speedBps > 0).toBe(true);
      expect(m.etaSec !== null, "RRQ with known fileSize and speed > 0 must have ETA").toBe(true);
      expect(typeof m.etaSec, "RRQ ETA must be number (not null)").toBe("number");
      expect((m.etaSec as number) > 0, "ETA must be > 0").toBeTruthy();
      expect(m.startedAt).toBe(t.startedAt);
    });

    it("WRQ without known tsize → ETA null (cannot predict)", () => {
      const t = new TransferSession({
        peer: mkPeer(),
        opcode: Opcode.WRQ,
        filename: "a.bin",
        absFilePath: path.join(root, "a.bin"),
        mode: "octet",
        rawOptions: {}
      });
      t.initForWRQ(false);
      // inject artificial speed
      (t as any).speedBps = 1_000_000;
      t.bytesTransferred = 500_000;
      const m = t.getMetrics();
      expect(m.etaSec, "WRQ without initial tsize does not calculate ETA").toBeNull();
    });

    it("WRQ WITH known tsize option → ETA populated", () => {
      const t = new TransferSession({
        peer: mkPeer(),
        opcode: Opcode.WRQ,
        filename: "a.bin",
        absFilePath: path.join(root, "a.bin"),
        mode: "octet",
        rawOptions: { tsize: "1000000" }
      });
      t.initForWRQ(false);
      (t as any).speedBps = 500_000;
      t.bytesTransferred = 250_000;
      const m = t.getMetrics();
      expect(typeof m.etaSec).toBe("number");
      expect((m.etaSec as number) > 0).toBe(true);
    });
  });

  describe("Block wrap 65535 → 1", () => {
    it("handleDATA WRQ after block 65535, next is 1 not 65536", () => {
      const t = new TransferSession({
        peer: mkPeer(),
        opcode: Opcode.WRQ,
        filename: "w.bin",
        absFilePath: path.join(root, "w.bin"),
        mode: "octet",
        rawOptions: {}
      });
      t.initForWRQ(false);
      t.blockNum = 65535;
      const r = t.handleDATA(65535, randomPayload(512)); // not last
      expect(r.done).toBe(false);
      expect(t.blockNum, "After 65535, next block should be 1 (TFTP wrap)").toBe(1);
    });
  });
});
