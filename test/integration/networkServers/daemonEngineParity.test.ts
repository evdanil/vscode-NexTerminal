/**
 * Engine parity: the real `NetworkServerDaemonHost` against a real daemon.
 *
 * ## Why this file exists
 *
 * The Rust daemon's own 351 tests prove it is internally consistent. They prove
 * nothing about whether `daemonHost.ts` — the actual extension-side RPC client,
 * with its ready handshake, request/response correlation, per-request timeouts
 * and event fan-out — can talk to it. That gap is what this suite closes.
 *
 * Every test below drives the **production** `NetworkServerDaemonHost` class.
 * Nothing is mocked: a real child process is spawned, real newline-delimited
 * JSON-RPC crosses real pipes, and real UDP datagrams are exchanged with the
 * bound sockets. Which implementation is on the other end is chosen entirely by
 * environment, so the identical assertions run against both engines:
 *
 * ```
 * # Node (default)
 * npx vitest run test/integration/networkServers/daemonEngineParity.test.ts
 *
 * # Rust
 * npm run test:network-server-daemon:rust
 * ```
 *
 * ## Why it is a new file rather than a reuse of the existing suites
 *
 * Of the four suites nominated for this, only `daemonBridge.test.ts` actually
 * spawns a daemon, but it always uses the Node bundle and a private client of
 * its own rather than the production `daemonHost.ts`. `tftpE2E`, `tftpStress`
 * and `dhcpLeaseRestart`
 * construct `TftpEngine` / `DhcpEngine` in-process and call their methods
 * directly: there is no daemon, no RPC and no child process anywhere in their
 * path, so they cannot be aimed at a binary of any kind without being rewritten
 * from nothing. Their *scenarios* are what carry over, and they are reproduced
 * here at the layer that can actually reach a second implementation:
 *
 *  - option negotiation (`blksize` / `tsize` → OACK)      ← tftpE2E
 *  - a full multi-block transfer over real UDP            ← tftpE2E / tftpStress
 *  - error codes on the wire (FileNotFound, AccessViolation)  ← tftpE2E
 *  - `cancelTransfer` aborting a live transfer            ← tftpStress
 *  - lease-store round-tripping across a restart          ← dhcpLeaseRestart
 *
 * ## The anti-vacuity guard
 *
 * `engine: "rust"` deliberately degrades to the Node daemon when no binary is
 * present. That is right for users and lethal for a parity test: a fallback
 * would make this suite pass while proving nothing. So `beforeEach` asserts the
 * spawned child's `spawnfile` really is the native binary whenever the run asks
 * for Rust. A silent fallback fails the suite instead of passing it.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { ChildProcess } from "node:child_process";
import dgram from "node:dgram";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  NetworkServerDaemonHost,
  resolveNativeDaemonBinaryPath,
  type DhcpRuntimeSnapshot,
  type NetworkServerEngine,
  type TftpRuntimeSnapshot
} from "../../../src/services/networkServers/daemonHost";
import { encodeRRQ, encodeWRQ, encodeACK, getOpcode } from "../../../src/services/networkServers/tftp/engine/protocol";
import { createUdpClient, mkdtemp, sleep } from "../../helpers/networkServerTestHelpers";

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");

const ENGINE: NetworkServerEngine =
  (process.env.NEXUS_NETWORK_SERVERS_ENGINE ?? "node").trim().toLowerCase() === "rust" ? "rust" : "node";
/**
 * The binary a Rust run exercises.
 *
 * With the environment variable unset this falls through to the *production*
 * resolver, so the default Rust run proves the whole installed path end to end:
 * `npm run build` copied an artifact into `dist/native/network-server-daemon/`,
 * and `resolveNativeDaemonBinaryPath` finds it for this platform. Setting the
 * variable points at a freshly-built binary instead, bypassing `dist/`.
 */
const NATIVE_BIN =
  process.env.NEXUS_NETWORK_SERVER_DAEMON_BIN?.trim() || resolveNativeDaemonBinaryPath(REPO_ROOT);

/** The Node bundle, built once — also the fallback target a Rust run must NOT hit. */
let daemonScript: string;

/** Builds the daemon entry point exactly as `esbuild.mjs` does, into a temp dir. */
async function buildDaemonBundle(): Promise<string> {
  const esbuild = await import("esbuild");
  const outdir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-parity-build-"));
  const outfile = path.join(outdir, "networkServerDaemon.js");
  await esbuild.build({
    bundle: true,
    platform: "node",
    target: "es2022",
    format: "cjs",
    sourcemap: false,
    loader: { ".node": "empty" },
    absWorkingDir: REPO_ROOT,
    entryPoints: ["src/services/networkServers/networkServerDaemon.ts"],
    outfile,
    external: ["vscode"]
  });
  return outfile;
}

/** The child the host spawned. Private state, read the way `daemonHostLifecycle` does. */
function hostChild(host: NetworkServerDaemonHost): ChildProcess | undefined {
  return (host as unknown as { child?: ChildProcess }).child;
}

function isUdpPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = dgram.createSocket({ type: "udp4", reuseAddr: false });
    socket.once("error", () => resolve(false));
    socket.bind(port, "0.0.0.0", () => socket.close(() => resolve(true)));
  });
}

describe(`Network servers daemon — engine parity (engine=${ENGINE})`, () => {
  let root: string;
  let host: NetworkServerDaemonHost;
  let logs: Array<{ level: string; message: string }>;

  beforeAll(async () => {
    daemonScript = await buildDaemonBundle();
    if (ENGINE === "rust" && !NATIVE_BIN) {
      throw new Error(`No native daemon artifact is defined for ${process.platform}-${process.arch}`);
    }
    if (ENGINE === "rust" && !fs.existsSync(NATIVE_BIN!)) {
      throw new Error(
        `Native daemon binary not found: ${NATIVE_BIN}\n` +
          "Run `npm run build` to install the artifact, or set NEXUS_NETWORK_SERVER_DAEMON_BIN."
      );
    }
  }, 120_000);

  beforeEach(async () => {
    root = mkdtemp("nexus-parity-root-");
    fs.writeFileSync(path.join(root, "boot.bin"), Buffer.from("PXE-PAYLOAD-0123456789", "ascii"));

    logs = [];
    host = new NetworkServerDaemonHost(daemonScript, {
      extensionRoot: REPO_ROOT,
      engine: ENGINE,
      nativeBinaryPath: NATIVE_BIN,
      readyTimeoutMs: 20_000,
      rpcTimeoutMs: 20_000
    });
    host.onDidLog((_id, level, message) => logs.push({ level, message }));

    await host.ensureStarted();
    expect(host.isReady, "the host must complete its ready handshake with the daemon").toBe(true);

    // Anti-vacuity: prove which binary is actually on the other end of the pipe.
    const spawnfile = hostChild(host)?.spawnfile;
    if (ENGINE === "rust") {
      expect(
        spawnfile,
        `engine=rust must spawn the native binary, not fall back to Node. Host logs: ${JSON.stringify(logs)}`
      ).toBe(NATIVE_BIN);
      expect(
        logs.some((l) => /using the bundled Node daemon instead/i.test(l.message)),
        "a fallback warning means this run proved nothing about the native daemon"
      ).toBe(false);
    } else {
      expect(spawnfile, "engine=node must spawn the Node executable").toBe(process.execPath);
    }
  }, 60_000);

  afterEach(() => {
    host.dispose();
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  // ---------------------------------------------------------------------------
  // RPC surface through the real client
  // ---------------------------------------------------------------------------

  it("answers `listServers` with both fixed services stopped", async () => {
    const list = await host.listServers();
    expect(list.map((s) => s.id).sort()).toEqual(["dhcp", "tftp"]);
    expect(list.every((s) => s.status === "stopped")).toBe(true);
  });

  it("answers `getStatus` for a known id, and keeps serving after the host rejects an unknown id", async () => {
    const snapshot = await host.getStatus("tftp");
    expect(snapshot.id).toBe("tftp");
    expect(snapshot.status).toBe("stopped");

    // Current main validates the closed service-id set host-side, before an
    // invalid request can cross the child-process boundary.
    await expect(host.getStatus("ftp")).rejects.toMatchObject({ name: "INVALID_REQUEST" });
    await expect(host.listServers()).resolves.toBeDefined();
  });

  it("keeps serving after the host rejects an unknown method", async () => {
    await expect(
      (host as unknown as { request(m: string): Promise<unknown> }).request("selfDestruct")
    ).rejects.toMatchObject({ name: "INVALID_REQUEST" });
    await expect(host.listServers()).resolves.toBeDefined();
  });

  // ---------------------------------------------------------------------------
  // TFTP over real UDP, through the daemon
  // ---------------------------------------------------------------------------

  it("starts TFTP, emits a running statusChange, and serves a file end to end", async () => {
    const statuses: string[] = [];
    host.onDidChangeStatus((e) => statuses.push(`${e.id}:${e.status}`));

    await host.startServer("tftp", { root, port: 0, allowWrite: false });
    const runtime = (await host.getServiceRuntime("tftp")) as TftpRuntimeSnapshot;
    expect(runtime.snapshot.status).toBe("running");
    expect(runtime.root).toBe(root);
    expect(runtime.allowWrite).toBe(false);
    expect(runtime.boundPort).toBeTypeOf("number");

    const udp = await createUdpClient();
    try {
      udp.sendTo(encodeRRQ("boot.bin", "octet"), runtime.boundPort!);
      const { message } = await udp.nextMsg(10_000);
      expect(getOpcode(message), "expected DATA from the daemon-hosted engine").toBe(3);
      expect(message.readUInt16BE(2)).toBe(1);
      expect(message.subarray(4).toString("ascii")).toBe("PXE-PAYLOAD-0123456789");
      udp.sendTo(encodeACK(1), runtime.boundPort!);
    } finally {
      udp.close();
    }

    await sleep(200);
    expect(statuses, "a running transition must reach the host").toContain("tftp:running");
  }, 60_000);

  it("negotiates blksize and tsize with an OACK carrying the real file size", async () => {
    const payload = Buffer.alloc(4096, 0x41);
    fs.writeFileSync(path.join(root, "big.bin"), payload);
    await host.startServer("tftp", { root, port: 0, allowWrite: false });
    const runtime = (await host.getServiceRuntime("tftp")) as TftpRuntimeSnapshot;

    const udp = await createUdpClient();
    try {
      udp.sendTo(
        encodeRRQ("big.bin", "octet", { blksize: "1024", tsize: "0" }),
        runtime.boundPort!
      );
      const { message } = await udp.nextMsg(10_000);
      expect(getOpcode(message), "an options request must be answered with OACK").toBe(6);

      // OACK body is NUL-separated key/value pairs after the 2-byte opcode.
      const fields = message.subarray(2).toString("ascii").split("\0").filter(Boolean);
      const opts = new Map<string, string>();
      for (let i = 0; i + 1 < fields.length; i += 2) {
        opts.set(fields[i]!.toLowerCase(), fields[i + 1]!);
      }
      expect(opts.get("blksize")).toBe("1024");
      expect(opts.get("tsize"), "tsize must be answered with the true file size").toBe(String(payload.length));
    } finally {
      udp.close();
    }
  }, 60_000);

  it("transfers a multi-block file byte-for-byte over real UDP", async () => {
    const blksize = 512;
    const blocks = 40;
    const payload = Buffer.alloc(blksize * blocks - 17);
    for (let i = 0; i < payload.length; i++) payload[i] = i % 251;
    fs.writeFileSync(path.join(root, "firmware.bin"), payload);

    await host.startServer("tftp", { root, port: 0, allowWrite: false });
    const runtime = (await host.getServiceRuntime("tftp")) as TftpRuntimeSnapshot;

    const udp = await createUdpClient();
    const chunks: Buffer[] = [];
    try {
      udp.sendTo(encodeRRQ("firmware.bin", "octet", { blksize: String(blksize) }), runtime.boundPort!);
      for (let safety = 0; safety < 10_000; safety++) {
        const { message } = await udp.nextMsg(20_000);
        const op = getOpcode(message);
        if (op === 6) {
          udp.sendTo(encodeACK(0), runtime.boundPort!);
          continue;
        }
        if (op === 5) throw new Error(`RRQ failed with TFTP error ${message.readUInt16BE(2)}`);
        if (op !== 3) continue;
        const block = message.subarray(4);
        chunks.push(Buffer.from(block));
        udp.sendTo(encodeACK(message.readUInt16BE(2)), runtime.boundPort!);
        if (block.length < blksize) break;
      }
    } finally {
      udp.close();
    }

    expect(Buffer.concat(chunks).equals(payload), "the served bytes must match the file exactly").toBe(true);
  }, 90_000);

  it("answers FileNotFound (code 1) for a missing file", async () => {
    await host.startServer("tftp", { root, port: 0, allowWrite: false });
    const runtime = (await host.getServiceRuntime("tftp")) as TftpRuntimeSnapshot;

    const udp = await createUdpClient();
    try {
      udp.sendTo(encodeRRQ("nope.bin", "octet"), runtime.boundPort!);
      const { message } = await udp.nextMsg(10_000);
      expect(getOpcode(message)).toBe(5);
      expect(message.readUInt16BE(2)).toBe(1);
    } finally {
      udp.close();
    }
  }, 60_000);

  it("refuses a WRQ with AccessViolation (code 2) while uploads are disabled", async () => {
    await host.startServer("tftp", { root, port: 0, allowWrite: false });
    const runtime = (await host.getServiceRuntime("tftp")) as TftpRuntimeSnapshot;

    const udp = await createUdpClient();
    try {
      udp.sendTo(encodeWRQ("intruder.bin", "octet"), runtime.boundPort!);
      const { message } = await udp.nextMsg(10_000);
      expect(getOpcode(message)).toBe(5);
      expect(message.readUInt16BE(2), "a read-only server must answer AccessViolation").toBe(2);
    } finally {
      udp.close();
    }
    expect(fs.existsSync(path.join(root, "intruder.bin"))).toBe(false);
  }, 60_000);

  it("rejects a path-traversal RRQ rather than serving outside the root", async () => {
    await host.startServer("tftp", { root, port: 0, allowWrite: false });
    const runtime = (await host.getServiceRuntime("tftp")) as TftpRuntimeSnapshot;

    const udp = await createUdpClient();
    try {
      udp.sendTo(encodeRRQ("../../../../../../etc/passwd", "octet"), runtime.boundPort!);
      const { message } = await udp.nextMsg(10_000);
      expect(getOpcode(message), "traversal must be an ERROR, never DATA").toBe(5);
      expect([1, 2]).toContain(message.readUInt16BE(2));
    } finally {
      udp.close();
    }
  }, 60_000);

  // ---------------------------------------------------------------------------
  // cancelTransfer — the host API tftpStress exercises on the engine
  // ---------------------------------------------------------------------------

  it("lists a live transfer and aborts it through `cancelTransfer`", async () => {
    const blksize = 512;
    fs.writeFileSync(path.join(root, "slow.bin"), Buffer.alloc(blksize * 400, 0x5a));
    await host.startServer("tftp", { root, port: 0, allowWrite: false });
    const runtime = (await host.getServiceRuntime("tftp")) as TftpRuntimeSnapshot;

    const udp = await createUdpClient();
    try {
      // Start the transfer and ACK only the first block, so it stays in flight.
      udp.sendTo(encodeRRQ("slow.bin", "octet", { blksize: String(blksize) }), runtime.boundPort!);
      const first = await udp.nextMsg(10_000);
      if (getOpcode(first.message) === 6) {
        udp.sendTo(encodeACK(0), runtime.boundPort!);
        await udp.nextMsg(10_000);
      }

      // The daemon should now be reporting exactly this transfer.
      let live = (await host.getServiceRuntime("tftp")) as TftpRuntimeSnapshot;
      for (let i = 0; i < 40 && live.transfers.length === 0; i++) {
        await sleep(50);
        live = (await host.getServiceRuntime("tftp")) as TftpRuntimeSnapshot;
      }
      expect(live.transfers.length, "an in-flight transfer must be visible to the host").toBeGreaterThan(0);

      const transferId = (live.transfers[0] as { id: string }).id;
      expect(transferId, "a transfer must carry an addressable id").toBeTruthy();
      expect(await host.cancelTransfer("tftp", transferId)).toBe(true);

      // And it is gone from the runtime afterwards.
      let after = (await host.getServiceRuntime("tftp")) as TftpRuntimeSnapshot;
      for (let i = 0; i < 40 && after.transfers.length > 0; i++) {
        await sleep(50);
        after = (await host.getServiceRuntime("tftp")) as TftpRuntimeSnapshot;
      }
      expect(after.transfers, "a cancelled transfer must leave the runtime").toEqual([]);

      // Cancelling a transfer that is already gone is a `false`, not a throw.
      expect(await host.cancelTransfer("tftp", transferId)).toBe(false);
    } finally {
      udp.close();
    }
  }, 90_000);

  // ---------------------------------------------------------------------------
  // Configuration lifecycle
  // ---------------------------------------------------------------------------

  it("applies a `configure` issued while running on the next `restart` (stale-config eviction)", async () => {
    await host.startServer("tftp", { root, port: 0, allowWrite: false });
    const before = (await host.getServiceRuntime("tftp")) as TftpRuntimeSnapshot;
    expect(before.boundPort).toBeTypeOf("number");

    const changed = await host.configure({ tftp: { root, port: 0, allowWrite: true } });
    expect(changed).toContain("tftp");

    const stillRunning = (await host.getServiceRuntime("tftp")) as TftpRuntimeSnapshot;
    expect(stillRunning.snapshot.status).toBe("running");
    expect(stillRunning.allowWrite, "a live service must not be rebuilt underneath its transfers").toBe(false);

    await host.restartServer("tftp");
    const after = (await host.getServiceRuntime("tftp")) as TftpRuntimeSnapshot;
    expect(after.snapshot.status).toBe("running");
    expect(after.allowWrite, "restart must rebuild from the config pushed while it was running").toBe(true);
  }, 90_000);

  it("releases the UDP port on `stopServer`", async () => {
    await host.startServer("tftp", { root, port: 0, allowWrite: false });
    const runtime = (await host.getServiceRuntime("tftp")) as TftpRuntimeSnapshot;
    const port = runtime.boundPort!;
    expect(await isUdpPortFree(port), "the port is held while the service runs").toBe(false);

    await host.stopServer("tftp");
    expect((await host.getStatus("tftp")).status).toBe("stopped");
    await sleep(200);
    expect(await isUdpPortFree(port), "stop must release the UDP port").toBe(true);
  }, 60_000);

  it("reports a bind failure as a rejected RPC and an error status, not as success", async () => {
    const squatter = dgram.createSocket({ type: "udp4", reuseAddr: false });
    const port = await new Promise<number>((resolve, reject) => {
      squatter.once("error", reject);
      squatter.bind(0, "0.0.0.0", () => resolve((squatter.address() as { port: number }).port));
    });
    try {
      await expect(host.startServer("tftp", { root, port, allowWrite: false })).rejects.toThrow(/already in use/i);
      expect((await host.getStatus("tftp")).status).toBe("error");
      // The daemon survived the failure and still answers.
      await expect(host.listServers()).resolves.toBeDefined();
    } finally {
      await new Promise<void>((done) => squatter.close(() => done()));
    }
  }, 60_000);

  // ---------------------------------------------------------------------------
  // DHCP lease store — the persistence format both engines must agree on
  // ---------------------------------------------------------------------------

  it("restores an unexpired persisted lease and drops an expired one", async () => {
    // Seeded rather than earned over the wire: DHCP binds the fixed port 67
    // (falling back to 1067), so a second daemon driving real DISCOVER traffic
    // would fight whatever else on the machine holds it. The lease *file* is
    // the actual cross-engine contract — a user flipping the setting keeps
    // their lease table only if both implementations read the same bytes.
    const storeDir = mkdtemp("nexus-parity-leases-");
    const storePath = path.join(storeDir, "dhcp-leases.json");
    const now = Date.now();
    const leaseSec = 3600;
    fs.writeFileSync(
      storePath,
      JSON.stringify(
        {
          version: 1,
          savedAt: now,
          leases: [
            {
              // Dash-uppercase deliberately: this is the `_state` key format
              // the Node engine itself writes, and `reconcilePersistedLeases`
              // documents it as the format a persisted lease carries. Seeding
              // colons instead would test the engines' punctuation habits
              // rather than the contract — Node echoes a persisted MAC through
              // verbatim, while the Rust daemon canonicalises it.
              mac: "AA-BB-CC-DD-EE-01",
              ip: "192.168.50.10",
              boundAt: now - 60_000,
              leaseSec,
              expiresAt: now + leaseSec * 1000,
              remainingSec: leaseSec,
              hostname: "bench-switch",
              leaseType: "dynamic"
            },
            {
              mac: "AA-BB-CC-DD-EE-02",
              ip: "192.168.50.11",
              boundAt: now - 7_200_000,
              leaseSec,
              expiresAt: now - 3_600_000,
              remainingSec: 0,
              hostname: null,
              leaseType: "dynamic"
            }
          ]
        },
        null,
        2
      ),
      "utf8"
    );

    try {
      await host.startServer("dhcp", {
        rangeStart: "192.168.50.10",
        rangeEnd: "192.168.50.100",
        subnet: "255.255.255.0",
        gateway: "192.168.50.1",
        serverId: "192.168.50.1",
        leaseTimeSec: leaseSec,
        bindAddress: "127.0.0.1",
        leaseStorePath: storePath
      });

      const runtime = (await host.getServiceRuntime("dhcp")) as DhcpRuntimeSnapshot;
      expect(runtime.snapshot.status).toBe("running");

      const ips = runtime.leases.map((l) => l.ip).sort();
      expect(ips, "the unexpired lease must be restored").toContain("192.168.50.10");
      expect(ips, "the expired lease must NOT be restored").not.toContain("192.168.50.11");

      const restored = runtime.leases.find((l) => l.ip === "192.168.50.10")!;
      // Compared as an identity, not as a string: what must match across
      // engines is *which device* holds the lease. Separator and case are
      // presentation, and pinning them here would make this test fail over a
      // cosmetic difference while missing a genuinely wrong address.
      const macDigits = (mac: string): string => mac.replace(/[^0-9a-f]/gi, "").toUpperCase();
      expect(macDigits(restored.mac)).toBe("AABBCCDDEE01");
      expect(restored.hostname).toBe("bench-switch");
      expect(restored.remainingSec, "a restored lease keeps its remaining time").toBeGreaterThan(0);

      // Pool arithmetic is a second thing both engines must agree on.
      expect(runtime.poolInfo.rangeStart).toBe("192.168.50.10");
      expect(runtime.poolInfo.rangeEnd).toBe("192.168.50.100");
      expect(runtime.poolInfo.poolSize, "10..100 inclusive is 91 addresses").toBe(91);
      expect(runtime.poolInfo.activeCount, "the one restored lease occupies the pool").toBe(1);
    } finally {
      await host.stopServer("dhcp").catch(() => undefined);
      fs.rmSync(storeDir, { recursive: true, force: true });
    }
  }, 90_000);

  // ---------------------------------------------------------------------------
  // Teardown
  // ---------------------------------------------------------------------------

  it("dispose() terminates the child and releases its port", async () => {
    await host.startServer("tftp", { root, port: 0, allowWrite: false });
    const runtime = (await host.getServiceRuntime("tftp")) as TftpRuntimeSnapshot;
    const port = runtime.boundPort!;
    const child = hostChild(host)!;

    host.dispose();
    for (let i = 0; i < 100 && child.exitCode === null && child.signalCode === null; i++) {
      await sleep(50);
    }
    expect(child.exitCode !== null || child.signalCode !== null, "dispose must not leave an orphan").toBe(true);
    expect(await isUdpPortFree(port), "dispose must release the UDP port").toBe(true);
  }, 60_000);
});
