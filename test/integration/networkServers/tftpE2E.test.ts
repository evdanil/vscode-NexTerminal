/**
 * @author kanekitakitos
 *
 * End-to-end integration tests for the TFTP engine over real UDP.
 *
 * A real `TftpEngine` is bound to `127.0.0.1` on a kernel-allocated port
 * (`port: 0`, then read back from `engine.boundPort`) and driven by real
 * `dgram` clients — no mocks anywhere in the path, so the wire bytes, the
 * session map, the retransmission timer and the filesystem sandbox are all
 * exercised together.
 *
 * Covered failure and edge paths (RFC 1350 §5.1 codes on the wire):
 *  - UnknownTransferID for a stray ACK with no session behind it;
 *  - AccessViolation for WRQ while read-only, and for path traversal;
 *  - FileAlreadyExists / FileNotFound;
 *  - the `maxTransfers` admission cap answering "Server busy";
 *  - 100% packet loss: the session must retransmit and then be garbage
 *    collected rather than leaking forever;
 *  - ENOSPC on the write handle mapping to DiskFull (code 3), not
 *    AccessViolation — deploy scripts branch on that code;
 *  - `activeTransfers()` introspection while a transfer is in flight.
 *
 * Ported from the standalone add-on's `tests/e2e/tftp-critical.test.ts`.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import dgram from "node:dgram";
import fs from "node:fs";
import path from "node:path";
import { TftpEngine } from "../../../src/services/networkServers/tftp/engine/TftpEngine";
import { ErrorCode } from "../../../src/services/networkServers/tftp/engine/types";
import {
  encodeRRQ,
  encodeWRQ,
  encodeACK,
  getOpcode
} from "../../../src/services/networkServers/tftp/engine/protocol";
import { mkdtemp, randomPayload, createUdpClient, sleep } from "../../helpers/networkServerTestHelpers";

async function withEngine<T>(
  root: string,
  allowWrite: boolean,
  extra: Partial<ConstructorParameters<typeof TftpEngine>[0]> = {},
  fn: (engine: TftpEngine, port: number) => Promise<T>
): Promise<T> {
  const engine = new TftpEngine({
    root,
    allowWrite,
    // 0 lets the kernel pick a free port, so parallel/repeated runs can never
    // collide the way a hand-incremented counter eventually does.
    port: 0,
    address: "127.0.0.1",
    gcIntervalMs: 500,
    timeoutMs: 800,
    ...extra
  });
  try {
    await engine.start();
    return await fn(engine, engine.boundPort!);
  } finally {
    await engine.stop();
  }
}

function assertErrorMessage(m: Buffer, expectCode: ErrorCode, msgRegexp?: RegExp) {
  const op = getOpcode(m);
  expect(op, `Expected ERROR op=5, got ${op}`).toBe(5);
  const code = m.readUInt16BE(2);
  expect(code, `Expected ERROR code=${ErrorCode[expectCode]}(${expectCode}), got code=${code}`).toBe(expectCode);
  if (msgRegexp) {
    const nullIdx = m.indexOf(0, 4);
    const msg = m.toString("ascii", 4, nullIdx < 0 ? m.length : nullIdx);
    expect(msg).toMatch(msgRegexp);
  }
}

describe("TFTP E2E — Critical Paths", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtemp("nexus-e2e-crit-");
  });
  afterEach(() => {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  // `maxTransfers` used to be a check-then-act: read `transfers.size`, then
  // `await` the filesystem, then register. Requests that interleave inside that
  // gap all see a below-limit size and all get in.
  //
  // The interleaving is driven through the engine's own message entry point
  // rather than through the socket, because a real burst cannot be made to
  // land deterministically — the point is precisely that every request runs its
  // synchronous prefix before any of them resumes past its first `await`, and
  // calling the handler N times without awaiting between the calls is the only
  // way to guarantee exactly that. Everything else in the path is real: real
  // engine, real bound socket, real sandbox, real file reads.
  describe("maxTransfers admission is a reservation, not a check-then-act", () => {
    /** The engine's UDP entry point, reached without the scheduling noise of a real socket. */
    type MessageEntryPoint = { handleMessage(msg: Buffer, rinfo: dgram.RemoteInfo): Promise<void> };
    const rinfoFor = (port: number, size: number): dgram.RemoteInfo => ({
      address: "127.0.0.1",
      family: "IPv4",
      port,
      size
    });

    it("a simultaneous burst cannot exceed the cap", async () => {
      fs.writeFileSync(path.join(root, "boot.bin"), randomPayload(200_000));
      await withEngine(root, false, { maxTransfers: 2 }, async (engine, _port) => {
        const rrq = encodeRRQ("boot.bin", "octet");
        const entry = engine as unknown as MessageEntryPoint;
        await Promise.all(
          Array.from({ length: 8 }, (_, i) => entry.handleMessage(rrq, rinfoFor(41000 + i, rrq.length)))
        );
        expect(
          engine.activeTransfers().length,
          "eight requests raced the admission check; the cap must still hold"
        ).toBe(2);
      });
    });

    it("a failed request releases its slot instead of leaking it", async () => {
      fs.writeFileSync(path.join(root, "real.bin"), randomPayload(4096));
      await withEngine(root, false, { maxTransfers: 1 }, async (engine, _port) => {
        const entry = engine as unknown as MessageEntryPoint;
        // Three requests for a file that does not exist: each is admitted,
        // fails in statFile, and answers FileNotFound. A reservation released
        // only on the success path would consume the single slot three times
        // over and wedge the service permanently.
        for (let i = 0; i < 3; i++) {
          const miss = encodeRRQ("absent.bin", "octet");
          await entry.handleMessage(miss, rinfoFor(42000 + i, miss.length));
        }
        expect(engine.activeTransfers().length).toBe(0);

        const rrq = encodeRRQ("real.bin", "octet");
        await entry.handleMessage(rrq, rinfoFor(42100, rrq.length));
        expect(
          engine.activeTransfers().length,
          "the slot the failed requests borrowed must have come back"
        ).toBe(1);
      });
    });
  });

  // The sandbox is what validates the root, and it used to be built on the
  // first request — outside that request's own try block. A misconfigured root
  // therefore bound the socket, reported "running", answered nothing, and left
  // every client to time out with no diagnosis anywhere.
  describe("root validation happens at startup, not on the first datagram", () => {
    it("a root that does not exist fails start() and binds no port", async () => {
      const engine = new TftpEngine({
        root: path.join(root, "no-such-directory"),
        port: 0,
        address: "127.0.0.1"
      });
      try {
        await expect(engine.start()).rejects.toThrow(/root does not exist/i);
        expect(engine.boundPort, "a service that can serve nothing must not hold a port").toBeNull();
      } finally {
        await engine.stop();
      }
    });

    it("a root that is a file, not a directory, fails start() too", async () => {
      const notADir = path.join(root, "root-is-a-file");
      fs.writeFileSync(notADir, "x");
      const engine = new TftpEngine({ root: notADir, port: 0, address: "127.0.0.1" });
      try {
        await expect(engine.start()).rejects.toThrow(/not a directory/i);
        expect(engine.boundPort).toBeNull();
      } finally {
        await engine.stop();
      }
    });
  });

  it("UnknownTransferID: stray ACK(1) without active transfer → ERROR code=5 RFC1350", async () => {
    await withEngine(root, false, {}, async (_engine, port) => {
      const c = await createUdpClient();
      try {
        c.sendTo(encodeACK(1), port);
        const { message } = await c.nextMsg(4000);
        assertErrorMessage(message, ErrorCode.UnknownTransferID);
      } finally {
        c.close();
      }
    });
  });

  it('WRQ allowWrite=false → ERROR code=2 AccessViolation "Write not allowed"', async () => {
    await withEngine(root, false, {}, async (_engine, port) => {
      const c = await createUdpClient();
      try {
        c.sendTo(encodeWRQ("forbid.bin", "octet"), port);
        const { message } = await c.nextMsg(4000);
        assertErrorMessage(message, ErrorCode.AccessViolation, /Write not allowed/i);
      } finally {
        c.close();
      }
    });
  });

  it("WRQ FileAlreadyExists → ERROR code=6", async () => {
    fs.writeFileSync(path.join(root, "exists.bin"), "x");
    await withEngine(root, true, {}, async (_engine, port) => {
      const c = await createUdpClient();
      try {
        c.sendTo(encodeWRQ("exists.bin", "octet"), port);
        const { message } = await c.nextMsg(4000);
        assertErrorMessage(message, ErrorCode.FileAlreadyExists);
      } finally {
        c.close();
      }
    });
  });

  // Forward slash is a separator everywhere, so this traversal is a traversal on
  // every platform and the assertion is unconditional.
  it("RRQ PathTraversal ../escape.bin → ERROR code=2 AccessViolation", async () => {
    await withEngine(root, false, {}, async (_engine, port) => {
      const c = await createUdpClient();
      try {
        c.sendTo(encodeRRQ("../escape.bin", "octet"), port);
        const { message } = await c.nextMsg(4000);
        assertErrorMessage(message, ErrorCode.AccessViolation);
      } finally {
        c.close();
      }
    });
  });

  // Platform split: a BACKSLASH is a path separator on Windows and an ordinary
  // filename character on POSIX, so the same wire bytes are a traversal on one
  // host and a single legal filename on the other. Both outcomes are correct —
  // nothing outside root is served either way. See the class-level doc on
  // `PathGuard` for the related decision about leading separators being
  // stripped rather than rejected (RFC 1350 defines no absolute-path semantics).
  it.skipIf(process.platform !== "win32")(
    "Windows: RRQ PathTraversal ..\\escape.bin → ERROR code=2 AccessViolation",
    async () => {
      await withEngine(root, false, {}, async (_engine, port) => {
        const c = await createUdpClient();
        try {
          c.sendTo(encodeRRQ("..\\escape.bin", "octet"), port);
          const { message } = await c.nextMsg(4000);
          assertErrorMessage(message, ErrorCode.AccessViolation);
        } finally {
          c.close();
        }
      });
    }
  );

  it.skipIf(process.platform === "win32")(
    "POSIX: RRQ ..\\escape.bin is one legal filename, not a traversal → ERROR code=1 FileNotFound",
    async () => {
      await withEngine(root, false, {}, async (_engine, port) => {
        const c = await createUdpClient();
        try {
          c.sendTo(encodeRRQ("..\\escape.bin", "octet"), port);
          const { message } = await c.nextMsg(4000);
          assertErrorMessage(message, ErrorCode.FileNotFound);
        } finally {
          c.close();
        }
      });
    }
  );

  it("RRQ netascii → ERROR code=4 on the wire, no session, no raw transfer", async () => {
    fs.writeFileSync(path.join(root, "config.txt"), "line one\nline two\n");
    await withEngine(root, false, {}, async (engine, port) => {
      const c = await createUdpClient();
      try {
        c.sendTo(encodeRRQ("config.txt", "netascii"), port);
        const { message } = await c.nextMsg(4000);
        // The alternative is what used to happen: the file goes out byte for
        // byte under a mode that promises CR/LF conversion, and a client on a
        // different line convention writes silently corrupted text.
        assertErrorMessage(message, ErrorCode.IllegalOperation, /netascii/i);
        expect(engine.activeTransfers().length).toBe(0);
      } finally {
        c.close();
      }
    });
  });

  it("RRQ file does not exist → ERROR code=1 FileNotFound", async () => {
    await withEngine(root, false, {}, async (_engine, port) => {
      const c = await createUdpClient();
      try {
        c.sendTo(encodeRRQ("nope.bin", "octet"), port);
        const { message } = await c.nextMsg(4000);
        assertErrorMessage(message, ErrorCode.FileNotFound);
      } finally {
        c.close();
      }
    });
  });

  it(
    'MaxTransfers=2 + 3 concurrent requests → 3rd ERROR IllegalOperation "Server busy"',
    async () => {
      // Create 3 LARGE files to ensure transfers remain active while we send the 3rd request
      const files: { name: string; payload: Buffer }[] = [];
      for (let i = 0; i < 3; i++) {
        const name = `slow-${i}.bin`;
        const payload = randomPayload(200_000); // 200KB, will take some time
        fs.writeFileSync(path.join(root, name), payload);
        files.push({ name, payload });
      }
      await withEngine(root, false, { maxTransfers: 2, gcIntervalMs: 500 }, async (_engine, port) => {
        // Clients 1 and 2 start transfers — we will NOT progressively ACK them to keep them active.
        const [c1, c2, c3] = await Promise.all([createUdpClient(), createUdpClient(), createUdpClient()]);
        try {
          // Clients 1 and 2 send RRQ and receive first DATA
          c1.sendTo(encodeRRQ(files[0]!.name, "octet"), port);
          c2.sendTo(encodeRRQ(files[1]!.name, "octet"), port);
          const [m1, m2] = await Promise.all([c1.nextMsg(5000), c2.nextMsg(5000)]);
          expect(getOpcode(m1.message)).toBe(3); // DATA
          expect(getOpcode(m2.message)).toBe(3); // DATA

          // Now client 3 tries → Server busy (max 2)
          c3.sendTo(encodeRRQ(files[2]!.name, "octet"), port);
          const { message } = await c3.nextMsg(4000);
          assertErrorMessage(message, ErrorCode.IllegalOperation, /Server busy/i);

          // Cleanup c1 and c2 (just close sockets, transfers will be cleaned up by timeout)
        } finally {
          c1.close();
          c2.close();
          c3.close();
        }
      });
    },
    30_000
  );

  it(
    "Retransmission + MaxRetries: 100% packet loss (we never send ACKs) → transfer cleanup after timeout (not hung)",
    async () => {
      const name = "lose.bin";
      fs.writeFileSync(path.join(root, name), randomPayload(3000));
      // Use defaults to ensure transfer is created and eventually cleaned up by gc+timeout
      await withEngine(root, false, { timeoutMs: 500, gcIntervalMs: 1000 }, async (engine, port) => {
        const c = await createUdpClient();
        try {
          await sleep(150); // ensure engine socket is listening
          c.sendTo(encodeRRQ(name, "octet"), port);
          // Wait for some packets (we don't send ACKs, so server retx)
          let countPackets = 0;
          let deadline = Date.now() + 15_000;
          while (Date.now() < deadline && countPackets < 8) {
            try {
              await c.nextMsg(500);
              countPackets++;
            } catch {
              // small timeout, continue
            }
          }
          // Now wait until engine cleans up (max retries + GC interval)
          deadline = Date.now() + 20_000;
          while (Date.now() < deadline && engine.activeTransfers().length > 0) {
            try {
              await c.nextMsg(200);
              countPackets++;
            } catch {
              await sleep(100);
            }
          }
          expect(
            engine.activeTransfers().length,
            "Transfer must be cleaned up after timeout/maxRetries (not hung)"
          ).toBe(0);
        } finally {
          c.close();
        }
      });
    },
    60_000
  );

  it(
    "WRQ DiskFull detection simulated with fs quota: if write throws ENOSPC → ERROR code=3 DiskFull",
    async () => {
      // Deterministic ENOSPC injection: patch fs.promises.open (the same object
      // the engine reaches through node:fs/promises) so only the WRQ target
      // fails, then restore it in the finally block.
      const origOpen = fs.promises.open;
      let triggeredENOSPC = false;
      try {
        (fs.promises as any).open = async (filePath: string, flag: string) => {
          // Trigger ENOSPC only on WRQ file "diskfull.bin" flag 'wx' (initial
          // create, O_EXCL — see PathGuard's symlink-write fix) or 'a'
          // (appendWrite's lazy-reopen fallback)
          if (String(filePath).endsWith(path.join("diskfull.bin")) && (flag === "wx" || flag === "a")) {
            const err: NodeJS.ErrnoException = new Error(`ENOSPC: no space left on device, open '${filePath}'`);
            err.code = "ENOSPC";
            err.errno = -28;
            triggeredENOSPC = true;
            throw err;
          }
          return origOpen.call(fs.promises, filePath as any, flag as any);
        };
        await withEngine(root, true, {}, async (_engine, port) => {
          const c = await createUdpClient();
          try {
            c.sendTo(encodeWRQ("diskfull.bin", "octet"), port);
            const { message } = await c.nextMsg(5000);
            assertErrorMessage(message, ErrorCode.DiskFull, /Disk full/i);
            expect(triggeredENOSPC, "ENOSPC monkeypatch was not triggered").toBe(true);
          } finally {
            c.close();
          }
        });
      } finally {
        (fs.promises as any).open = origOpen;
      }
    },
    15_000
  );

  it("activeTransfers(): during active RRQ, contains 1 transfer with filename, totalBytes, speedBps, startedAt", async () => {
    const name = "active.bin";
    const payload = randomPayload(500_000);
    fs.writeFileSync(path.join(root, name), payload);
    await withEngine(root, false, {}, async (engine, port) => {
      const c = await createUdpClient();
      try {
        c.sendTo(encodeRRQ(name, "octet", { blksize: "1400", windowsize: "4" }), port);
        // Wait for 1 DATA or OACK (if options) to ensure transfer created
        const first = await c.nextMsg(5_000);
        const opFirst = getOpcode(first.message);
        // If it's OACK (options), we respond ACK(0) to trigger DATA(1) sending
        if (opFirst === 6) {
          c.sendTo(encodeACK(0), port);
          await c.nextMsg(4000); // DATA(1) should arrive
        } else {
          expect(opFirst === 3, `Expected DATA or OACK, was ${opFirst}`).toBe(true);
        }
        await sleep(100); // give engine time for activeTransfers to update
        const list = engine.activeTransfers();
        expect(list.length, `activeTransfers should have 1, had ${list.length}`).toBe(1);
        const t = list[0]!;
        expect(t.filename).toBe(name);
        expect(t.totalBytes).toBe(payload.length);
        expect(t.blockSize).toBe(1400);
        expect(t.windowSize >= 1, `windowSize ${t.windowSize} must be >=1`).toBeTruthy();
        expect(typeof t.startedAt).toBe("number");
        expect(
          Number.isFinite(t.speedBps) || t.speedBps === 0,
          `speedBps must be finite or 0, was ${t.speedBps}`
        ).toBeTruthy();
        // Consume to clean up
        const blksize = 1400;
        while (true) {
          try {
            const { message } = await c.nextMsg(4000);
            const op = getOpcode(message);
            if (op === 5) break;
            if (op === 3) {
              const bn = message.readUInt16BE(2);
              const data = message.subarray(4);
              c.sendTo(encodeACK(bn), port);
              if (data.length < blksize) break;
            } else if (op === 6) {
              c.sendTo(encodeACK(0), port);
            } else {
              break;
            }
          } catch {
            break;
          }
        }
      } finally {
        c.close();
      }
    });
  });
});
