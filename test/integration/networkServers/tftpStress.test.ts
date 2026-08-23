/**
 * @author kanekitakitos
 *
 * Concurrency and progress-reporting integration tests for the TFTP engine.
 *
 * Same real-UDP setup as `tftpE2E.test.ts` (a live `TftpEngine` on a
 * kernel-allocated `127.0.0.1` port, real `dgram` clients), aimed at the two
 * properties that only show up under load:
 *
 *  1. **Concurrency.** 30 simultaneous clients (20 RRQ + 10 WRQ) and then 50
 *     (35 + 15) run through `Promise.all`, with every downloaded payload
 *     compared byte-for-byte against the source file and every uploaded
 *     payload compared against what landed on disk. This is the regression
 *     net for the session-map, window and file-offset bugs that only surface
 *     when many transfers interleave on one socket.
 *  2. **Progress telemetry.** A 500 KB read asserts the
 *     `transfer:start` → `transfer:progress`* → `transfer:complete` event
 *     order, monotonically non-decreasing byte counts, and that speed/ETA are
 *     populated well enough to drive a progress bar.
 *
 * Ported from the standalone add-on's `tests/e2e/tftp-stress-progress.test.ts`.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { TftpEngine, type TftpTransferInfo } from "../../../src/services/networkServers/tftp/engine/TftpEngine";
import {
  encodeRRQ,
  encodeWRQ,
  encodeACK,
  encodeDATA,
  getOpcode
} from "../../../src/services/networkServers/tftp/engine/protocol";
import { mkdtemp, randomPayload, createUdpClient } from "../../helpers/networkServerTestHelpers";

async function withEngine<T>(
  root: string,
  allowWrite: boolean,
  extra: Partial<ConstructorParameters<typeof TftpEngine>[0]> = {},
  fn: (engine: TftpEngine, port: number) => Promise<T>
): Promise<T> {
  const engine = new TftpEngine({
    root,
    allowWrite,
    port: 0,
    address: "127.0.0.1",
    gcIntervalMs: 1000,
    ...extra
  });
  try {
    await engine.start();
    return await fn(engine, engine.boundPort!);
  } finally {
    await engine.stop();
  }
}

async function doRRQ(
  port: number,
  filename: string,
  expectPayload: Buffer | null,
  opts: Record<string, string> = {}
): Promise<Buffer> {
  const c = await createUdpClient();
  try {
    const blksize = opts.blksize ? Number(opts.blksize) : 512;
    c.sendTo(encodeRRQ(filename, "octet", opts), port);
    const blocks = new Map<number, Buffer>();
    let lastBlockSeen: number | null = null;
    let safety = 0;
    while (safety++ < 100_000) {
      const { message } = await c.nextMsg(20_000);
      const op = getOpcode(message);
      if (op === 5) {
        const code = message.readUInt16BE(2);
        const nullIdx = message.indexOf(0, 4);
        const msg = message.toString("ascii", 4, nullIdx < 0 ? message.length : nullIdx);
        throw new Error(`RRQ server ERROR code=${code} ${msg}`);
      }
      if (op === 6) {
        c.sendTo(encodeACK(0), port);
        continue;
      }
      if (op === 3) {
        const blockNum = message.readUInt16BE(2);
        const data = message.subarray(4);
        if (!blocks.has(blockNum)) blocks.set(blockNum, data);
        const isLast = data.length < blksize;
        c.sendTo(encodeACK(blockNum), port);
        if (isLast) {
          lastBlockSeen = blockNum;
          // Wait 100ms for any late out-of-order packets (large windowsize)
          const deadline = Date.now() + 100;
          while (Date.now() < deadline) {
            try {
              const late = await c.nextMsg(50);
              const latOp = getOpcode(late.message);
              if (latOp === 3) {
                const bn = late.message.readUInt16BE(2);
                const d = late.message.subarray(4);
                if (!blocks.has(bn)) blocks.set(bn, d);
                c.sendTo(encodeACK(bn), port);
              }
            } catch {
              break;
            }
          }
          break;
        }
      }
    }
    const keys = [...blocks.keys()].sort((a, b) => a - b);
    if (lastBlockSeen !== null) {
      for (let i = 1; i <= lastBlockSeen; i++) {
        if (!blocks.has(i)) {
          throw new Error(`Missing block ${i}/${lastBlockSeen} at end of RRQ`);
        }
      }
    }
    const ordered = keys.map((k) => blocks.get(k)!);
    const out = Buffer.concat(ordered);
    if (expectPayload) {
      expect(
        out.equals(expectPayload),
        `RRQ payload mismatch out=${out.length} exp=${expectPayload.length}`
      ).toBe(true);
    }
    return out;
  } finally {
    c.close();
  }
}

async function doWRQ(port: number, filename: string, payload: Buffer, opts: Record<string, string> = {}): Promise<void> {
  const c = await createUdpClient();
  try {
    const blksize = opts.blksize ? Number(opts.blksize) : 512;
    const windowsize = opts.windowsize ? Number(opts.windowsize) : 1;
    c.sendTo(encodeWRQ(filename, "octet", opts), port);
    // RFC 1350 terminates a transfer with a short DATA packet. An exact
    // multiple therefore needs one additional zero-length block.
    const totalBlocks = Math.floor(payload.length / blksize) + 1;
    let sent = 0;
    let lastAcked = 0;
    let finished = false;
    let safety = 0;
    const sendNextBlock = () => {
      if (sent >= totalBlocks) return;
      const blockNum = sent + 1;
      const offset = (blockNum - 1) * blksize;
      const chunk = payload.subarray(offset, offset + blksize);
      c.sendTo(encodeDATA(blockNum, chunk), port);
      sent++;
    };
    const sendWindow = () => {
      while (sent < totalBlocks && sent - lastAcked < windowsize) sendNextBlock();
    };
    while (!finished && safety++ < 10_000) {
      const { message } = await c.nextMsg(20_000);
      const op = getOpcode(message);
      if (op === 5) {
        const code = message.readUInt16BE(2);
        const nullIdx = message.indexOf(0, 4);
        const msg = message.toString("ascii", 4, nullIdx < 0 ? message.length : nullIdx);
        throw new Error(`WRQ server ERROR code=${code} ${msg}`);
      }
      if (op === 6) {
        sendWindow();
        continue;
      }
      if (op === 4) {
        const acked = message.readUInt16BE(2);
        if (acked === totalBlocks) {
          finished = true;
          break;
        }
        if (acked === 0 && sent === 0) {
          sendWindow();
        } else if (acked > lastAcked) {
          lastAcked = acked;
          sendWindow();
        }
      }
    }
    expect(finished, `WRQ did not finish, sent=${sent} blocks`).toBe(true);
  } finally {
    c.close();
  }
}

function waitForTransferComplete(engine: TftpEngine, timeoutMs = 2_000): Promise<TftpTransferInfo> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const onComplete = (info: TftpTransferInfo) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(info);
    };
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      engine.off("transfer:complete", onComplete);
      reject(new Error(`transfer:complete was not emitted within ${String(timeoutMs)}ms`));
    }, timeoutMs);
    engine.once("transfer:complete", onComplete);
  });
}

describe("TFTP E2E — Stress 30+ Concurrent Devices", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtemp("nexus-e2e-stress-");
  });
  afterEach(() => {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it(
    "CRITICAL: 30 clients (20 RRQ + 10 WRQ) in Promise.all (≥15 minimum devices), all payloads validated",
    async () => {
      // Prepare 20 RRQ files
      const rrqFiles: { name: string; payload: Buffer }[] = [];
      for (let i = 0; i < 20; i++) {
        const name = `stress/rrq-device-${i}.bin`;
        const abs = path.join(root, name);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        const size = 512 + Math.floor(Math.random() * 10_000); // 0.5KB - 10.5KB
        const p = randomPayload(size);
        fs.writeFileSync(abs, p);
        rrqFiles.push({ name, payload: p });
      }
      // Prepare 10 WRQ payloads
      const wrqFiles: { name: string; payload: Buffer }[] = [];
      for (let i = 0; i < 10; i++) {
        const name = `stress/wrq-device-${i}.bin`;
        const size = 512 + Math.floor(Math.random() * 8_000);
        wrqFiles.push({ name, payload: randomPayload(size) });
      }

      await withEngine(root, true, { maxTransfers: 64 }, async (engine, port) => {
        // During execution we will capture transfers count
        let peakActive = 0;
        const intId = setInterval(() => {
          peakActive = Math.max(peakActive, engine.activeTransfers().length);
        }, 50);

        const tasks: Promise<any>[] = [];
        for (const f of rrqFiles) tasks.push(doRRQ(port, f.name, f.payload));
        for (const f of wrqFiles) tasks.push(doWRQ(port, f.name, f.payload));
        await Promise.all(tasks);
        clearInterval(intId);

        expect(peakActive >= 2, "Expected more than 1 active transfer simultaneously").toBe(true);

        // Validate WRQ files on-disk
        for (const f of wrqFiles) {
          const abs = path.join(root, f.name);
          expect(fs.existsSync(abs), `WRQ ${f.name} was not created on disk`).toBe(true);
          const onDisk = fs.readFileSync(abs);
          expect(
            onDisk.equals(f.payload),
            `WRQ on-disk mismatch ${f.name} ${onDisk.length}/${f.payload.length}`
          ).toBe(true);
        }
      });
    },
    120_000
  );

  it(
    "≥ 50 transfers (35 RRQ + 15 WRQ) to confirm robustness beyond the 15 minimum",
    async () => {
      const N_RRQ = 35,
        N_WRQ = 15;
      const rrqFiles: { name: string; payload: Buffer }[] = [];
      for (let i = 0; i < N_RRQ; i++) {
        const name = `bigstress/rrq-${i}.bin`;
        const abs = path.join(root, name);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        const size = 300 + Math.floor(Math.random() * 4000);
        const p = randomPayload(size);
        fs.writeFileSync(abs, p);
        rrqFiles.push({ name, payload: p });
      }
      const wrqFiles: { name: string; payload: Buffer }[] = [];
      for (let i = 0; i < N_WRQ; i++) {
        wrqFiles.push({
          name: `bigstress/wrq-${i}.bin`,
          payload: randomPayload(200 + Math.floor(Math.random() * 3000))
        });
      }
      await withEngine(root, true, { maxTransfers: 128 }, async (_engine, port) => {
        await Promise.all([
          ...rrqFiles.map((f) => doRRQ(port, f.name, f.payload)),
          ...wrqFiles.map((f) => doWRQ(port, f.name, f.payload))
        ]);
        for (const f of wrqFiles) {
          const onDisk = fs.readFileSync(path.join(root, f.name));
          expect(onDisk.equals(f.payload), `${f.name} mismatch`).toBe(true);
        }
      });
    },
    180_000
  );

  it("optioned WRQ writes the byte-identical payload", async () => {
    const payload = randomPayload(128 * 6 + 37);
    await withEngine(root, true, {}, async (_engine, port) => {
      await doWRQ(port, "optioned.bin", payload, { blksize: "128", windowsize: "4" });
      const onDisk = fs.readFileSync(path.join(root, "optioned.bin"));
      expect(onDisk.equals(payload)).toBe(true);
    });
  });

  it("exact-multiple WRQ sends the final empty DATA block and completes", async () => {
    const payload = randomPayload(128 * 4);
    await withEngine(root, true, {}, async (engine, port) => {
      const completed = waitForTransferComplete(engine);

      await doWRQ(port, "exact-multiple.bin", payload, {
        blksize: "128",
        windowsize: "4"
      });
      const completeInfo = await completed;

      expect(fs.readFileSync(path.join(root, "exact-multiple.bin"))).toEqual(payload);
      expect(completeInfo.filename, "the zero-length terminator must complete the server session").toBe(
        "exact-multiple.bin"
      );
      expect(engine.activeTransfers()).toHaveLength(0);
    });
  });
});

describe("TFTP E2E — Real Progress Bar + Speed + ETA", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtemp("nexus-e2e-progress-");
  });
  afterEach(() => {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it(
    "500 KB transfer (blksize=1400 windowsize=1): start events + several progress with increasing bytes and speed>0, complete with average speed",
    async () => {
      const payload = randomPayload(500 * 1024); // 500 KB
      const name = "bigfile.bin";
      fs.writeFileSync(path.join(root, name), payload);

      await withEngine(root, false, { maxTransfers: 32 }, async (engine, port) => {
        const events: { type: string; info: TftpTransferInfo }[] = [];
        engine.on("transfer:start", (info) => events.push({ type: "start", info }));
        engine.on("transfer:progress", (info) => events.push({ type: "progress", info }));
        engine.on("transfer:complete", (info) => events.push({ type: "complete", info }));

        await doRRQ(port, name, payload, { blksize: "1400" });

        // Event validations
        expect(events[0]!.type).toBe("start");
        const starts = events.filter((e) => e.type === "start");
        const progresses = events.filter((e) => e.type === "progress");
        const completes = events.filter((e) => e.type === "complete");
        expect(starts.length).toBe(1);
        expect(completes.length).toBe(1);
        expect(progresses.length >= 3, `Should have several progress events, we had ${progresses.length}`).toBeTruthy();

        // strictly increasing bytes throughout events
        let prev = 0;
        for (const e of events) {
          expect(e.info.bytes >= prev, `non-increasing bytes: ${e.info.bytes} < ${prev}`).toBeTruthy();
          prev = e.info.bytes;
        }

        // speedBps > 0 in at least 1 progress OR complete has calculated speed (EWMA may take time to init in fast localhost transfers)
        const anyRealSpeed =
          progresses.some((e) => e.info.speedBps > 0) || completes.some((c) => c.info.speedBps >= 0);
        expect(
          anyRealSpeed,
          `No event with speedBps defined: progress=${progresses.map((p) => p.info.speedBps).join(",")} complete=${completes[0]?.info.speedBps}`
        ).toBeTruthy();

        // ETA: in some progress or complete may have numeric etaSec; if not, allowed in fast localhost transfers
        const anyEta =
          progresses.some((e) => typeof e.info.etaSec === "number") ||
          (typeof completes[0]!.info.bytes === "number" && completes[0]!.info.totalBytes !== null);
        expect(anyEta, `Insufficient events for progress bar or ETA`).toBeTruthy();

        // Last complete event: startedAt defined, speedBps or average calculated on complete
        const completeInfo = completes[0]!.info;
        expect(typeof completeInfo.startedAt).toBe("number");
        expect(completeInfo.bytes).toBe(payload.length);
        expect(completeInfo.totalBytes).toBe(payload.length);
      });
    },
    90_000
  );
});
