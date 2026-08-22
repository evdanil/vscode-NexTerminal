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
import { Opcode, ErrorCode, MAX_IN_FLIGHT_BYTES } from "../../../src/services/networkServers/tftp/engine/types";
import {
  TransferSession,
  TransferPhase,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_MAX_RETRIES
} from "../../../src/services/networkServers/tftp/engine/TransferSession";
import { encodeACK, encodeDATA, getOpcode, parsePacket } from "../../../src/services/networkServers/tftp/engine/protocol";
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

  function makeOptionedRrqSession(): TransferSession {
    return new TransferSession({
      peer: mkPeer(),
      opcode: Opcode.RRQ,
      filename: "r.bin",
      absFilePath: path.join(root, "r.bin"),
      mode: "octet",
      rawOptions: { blksize: "1400" }
    });
  }

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

    it("WRQ compatibility: handleACK(0) after OACK moves to Receiving without producing data", () => {
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

    it("ACK(0) removes OACK before DATA retransmission tracking", () => {
      const t = makeOptionedRrqSession();
      const oack = t.initForRRQ(true, 1024);
      t.recordOutbound(oack);
      expect(t.handleACK(0).produceMore).toBe(true);
      expect(t.consumeRetransmission()).toBeNull();
      t.recordOutbound([encodeDATA(1, Buffer.alloc(512))]);
      t.handleACK(1);
      expect(t.consumeRetransmission()).toBeNull();
    });

    it("invalid ACK(1) leaves OACK retransmittable", () => {
      const t = makeOptionedRrqSession();
      const oack = t.initForRRQ(true, 1024);
      t.recordOutbound(oack);

      const result = t.handleACK(1);

      expect(t.phase).toBe(TransferPhase.SendOACK);
      expect(result.produceMore).toBe(false);
      const retransmission = t.consumeRetransmission();
      expect(retransmission).toHaveLength(1);
      expect(retransmission?.[0]?.equals(oack[0]!)).toBe(true);
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
    it("optioned WRQ accepts DATA(1) immediately after OACK", () => {
      const t = new TransferSession({
        peer: mkPeer(), opcode: Opcode.WRQ, filename: "w.bin",
        absFilePath: path.join(root, "w.bin"), mode: "octet",
        rawOptions: { blksize: "1400" }
      });
      const initial = t.initForWRQ(true);
      t.recordOutbound(initial);
      const result = t.handleDATA(1, Buffer.from("final"));
      expect(result.write?.equals(Buffer.from("final"))).toBe(true);
      expect(result.send[0]?.readUInt16BE(2)).toBe(1);
      expect(result.done).toBe(true);
      expect(t.phase).toBe(TransferPhase.Done);
      expect(t.consumeRetransmission()).toBeNull();
    });

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

  describe("Negotiated window is bounded (remote allocation DoS)", () => {
    it("OACK reports the CLAMPED windowsize, so client and server agree on the window", async () => {
      // A disagreement here is worse than the clamp itself: the client would
      // send/expect a 65535-block window while the server serves 16.
      const t = new TransferSession({
        peer: mkPeer(),
        opcode: Opcode.RRQ,
        filename: "big.bin",
        absFilePath: path.join(root, "big.bin"),
        mode: "octet",
        rawOptions: { blksize: "65464", windowsize: "65535" }
      });
      expect(t.phase, "an oversized window is clamped, not rejected (RFC 2347 §2)").not.toBe(TransferPhase.Error);
      const [oack] = t.initForRRQ(true, 1000);
      const parsed = parsePacket(oack!)!;
      expect(parsed.opcode).toBe(Opcode.OACK);
      if (parsed.opcode === Opcode.OACK) {
        expect(parsed.options.windowsize).toBe(String(t.opts.windowsize));
        expect(Number(parsed.options.windowsize) * Number(parsed.options.blksize)).toBeLessThanOrEqual(
          MAX_IN_FLIGHT_BYTES
        );
      }
    });

    it("produceNextSendPackets builds at most the clamped window, not the requested one", async () => {
      // The allocation this bounds is real: the loop below fills the whole
      // window into memory before a single datagram is sent.
      const blksize = 65464;
      const expectedWindow = Math.floor(MAX_IN_FLIGHT_BYTES / blksize);
      const p = path.join(root, "huge.bin");
      fs.writeFileSync(p, randomPayload(blksize * (expectedWindow + 4)));
      const t = new TransferSession({
        peer: mkPeer(),
        opcode: Opcode.RRQ,
        filename: "huge.bin",
        absFilePath: p,
        mode: "octet",
        rawOptions: { blksize: String(blksize), windowsize: "65535" }
      });
      t.initForRRQ(false, fs.statSync(p).size);
      const pkts = await t.produceNextSendPackets();
      expect(pkts.length).toBe(expectedWindow);
      expect(t.phase, "the file is longer than the window, so the transfer is not finished").toBe(
        TransferPhase.Sending
      );
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

    // The block counter wraps but `lastAcked` and the window arithmetic were
    // plain integers, so every comparison inverts the moment a transfer passes
    // 65535 blocks — 32 MB at the default blksize, i.e. any real firmware
    // image. The sessions below are placed AT the boundary rather than driven
    // 65535 blocks to reach it; the state is identical and the test runs in ms.
    it("RRQ: an ACK for a wrapped block still advances the window (does not stall)", async () => {
      const blksize = 512;
      const p = path.join(root, "wrap.bin");
      fs.writeFileSync(p, randomPayload(blksize * 6));
      const t = new TransferSession({
        peer: mkPeer(),
        opcode: Opcode.RRQ,
        filename: "wrap.bin",
        absFilePath: p,
        mode: "octet",
        rawOptions: {}
      });
      t.initForRRQ(false, blksize * 6);
      // One block short of the wrap, mid-transfer: last sent block is also the
      // last ACKed one, exactly as lock-step stop-and-wait leaves it.
      t.blockNum = 65534;
      t.lastAcked = 65534;

      const before = await t.produceNextSendPackets();
      expect(before[0]!.readUInt16BE(2)).toBe(65535);
      expect(t.handleACK(65535).produceMore).toBe(true);

      const wrapped = await t.produceNextSendPackets();
      expect(wrapped[0]!.readUInt16BE(2), "the block after 65535 goes out as 1").toBe(1);
      expect(
        (await t.produceNextSendPackets()).length,
        "block 1 is unacknowledged and windowsize is 1 — the wrap must not unbound the window"
      ).toBe(0);

      const r = t.handleACK(1);
      expect(t.lastAcked, "ACK(1) after the wrap is the newest ACK, not a stale one").toBe(1);
      expect(r.produceMore, "a stalled window here is a transfer that never finishes").toBe(true);

      const after = await t.produceNextSendPackets();
      expect(after.length, "the transfer must keep flowing past the wrap").toBe(1);
      expect(after[0]!.readUInt16BE(2)).toBe(2);
    });

    it("WRQ: a retransmitted pre-wrap block is re-ACKed, not treated as a protocol violation", () => {
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
      t.lastAcked = 65534;
      t.handleDATA(65535, randomPayload(512));
      expect(t.blockNum).toBe(1);

      // The client never saw our ACK(65535) and sends the block again — the
      // single most ordinary thing that happens on a lossy link.
      const dup = t.handleDATA(65535, randomPayload(512));
      expect(t.phase, "a duplicate block is not an illegal operation").not.toBe(TransferPhase.Error);
      expect(dup.done).toBe(false);
      expect(dup.write, "a duplicate must not be written to the file twice").toBeNull();
      expect(dup.send.length).toBe(1);
      expect(dup.send[0]!.readUInt16BE(2), "re-ACK the block the client repeated").toBe(65535);
    });

    it("the retransmission queue drains across the wrap instead of jamming", () => {
      const t = new TransferSession({
        peer: mkPeer(),
        opcode: Opcode.RRQ,
        filename: "q.bin",
        absFilePath: path.join(root, "q.bin"),
        mode: "octet",
        rawOptions: { windowsize: "4" }
      });
      t.initForRRQ(false, 4096);
      t.recordOutbound([65534, 65535, 1, 2].map((n) => encodeDATA(n, randomPayload(8))));
      t.clearOutboundUpToAck(2);
      // A numeric `p.blockNum <= ackBlockNum` stops at the first pre-wrap entry
      // and drains nothing, so the peer keeps being sent blocks it has already
      // acknowledged until the queue cap quietly discards them.
      expect(
        t.consumeRetransmission(),
        "everything up to the ACKed block is confirmed and must leave the queue"
      ).toBeNull();
    });

    it("WRQ: the windowed ACK still fires on the far side of the wrap", () => {
      const t = new TransferSession({
        peer: mkPeer(),
        opcode: Opcode.WRQ,
        filename: "w4.bin",
        absFilePath: path.join(root, "w4.bin"),
        mode: "octet",
        rawOptions: { windowsize: "4" }
      });
      t.initForWRQ(false);
      t.phase = TransferPhase.Receiving;
      t.lastAcked = 65532;
      t.blockNum = 65533;
      for (const expected of [65533, 65534, 65535]) {
        const mid = t.handleDATA(expected, randomPayload(512));
        expect(mid.send.length, `block ${expected} is inside the window, no ACK yet`).toBe(0);
      }
      expect(t.blockNum).toBe(1);
      const closing = t.handleDATA(1, randomPayload(512));
      expect(closing.send.length, "the window closed across the wrap and must be ACKed").toBe(1);
      expect(t.lastAcked).toBe(1);
    });
  });
});
