/**
 * @author kanekitakitos
 *
 * Integration tests for the network-servers daemon **bridge** — the
 * newline-delimited JSON-RPC protocol spoken over stdin/stdout between the
 * extension host and `networkServerDaemon.ts`.
 *
 * This is the one layer no other suite reaches: the unit suites mock the host
 * away, and the TFTP suites drive `TftpEngine` in-process. Here the real
 * daemon bundle is spawned as an actual child process (mirroring how
 * `SerialSidecarManager`'s integration coverage spawns a real sidecar and
 * talks real JSON-RPC over stdio), fed real request lines, and its replies,
 * unsolicited events, bound UDP sockets and exit behaviour are all observed
 * from the outside.
 *
 * The bundle is rebuilt from source into a temp directory in `beforeAll` with
 * the same esbuild options `esbuild.mjs` uses. That keeps the suite honest —
 * it can never pass against a stale `dist/` — and means a source edit alone is
 * enough to flip the stale-config regression test below.
 *
 * Coverage:
 *  1. `list` / `getStatus` round-trips, plus the NOT_FOUND and
 *     METHOD_NOT_FOUND error shapes.
 *  2. `start` genuinely binds a UDP socket: a real `dgram` RRQ served end to
 *     end *through the daemon*, not through an in-process engine.
 *  3. **Stale-config eviction (regression).** `configure` issued while the
 *     service is running cannot evict the cached adapter at that moment, so
 *     the daemon records the id in `staleConfigIds` and evicts on the next
 *     `restart`. Without that bookkeeping the restart silently reuses the
 *     adapter built from the *previous* configuration and the user's edit is
 *     lost. The test asserts the newly bound port matches the NEW config.
 *  4. Shutdown: stdin EOF exits 0 and releases the UDP port; SIGTERM
 *     terminates the child and releases it too.
 *
 * Note on shutdown: EOF-on-stdin is asserted for the clean exit code because
 * Windows does not deliver SIGTERM to the process's own handler (libuv
 * terminates the process outright), so `exitCode === 0` would be a
 * platform-specific assertion. SIGTERM is covered separately for termination
 * and port release only.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import dgram from "node:dgram";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createInterface, type Interface } from "node:readline";
import { encodeRRQ, encodeACK, getOpcode } from "../../../src/services/networkServers/tftp/engine/protocol";
import { RUNTIME_UPDATE_THROTTLE_MS } from "../../../src/services/networkServers/runtimeUpdateThrottle";
import { createUdpClient, mkdtemp, sleep } from "../../helpers/networkServerTestHelpers";
import { MAX_RPC_LINE_BYTES } from "../../../src/services/networkServers/boundedLineReader";

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const MAX_DAEMON_RPC_IN_FLIGHT = 16;

let daemonScript: string;
let daemonBundleDir: string | undefined;

/** Builds the daemon entry point exactly as `esbuild.mjs` does, into a temp dir. */
async function buildDaemonBundle(): Promise<string> {
  const esbuild = await import("esbuild");
  const outdir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-daemon-build-"));
  const outfile = path.join(outdir, "networkServerDaemon.js");
  try {
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
    daemonBundleDir = outdir;
    return outfile;
  } catch (error) {
    fs.rmSync(outdir, { recursive: true, force: true });
    throw error;
  }
}

/** Reserves a free UDP port by binding and immediately releasing it. */
function allocateFreeUdpPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket("udp4");
    socket.once("error", reject);
    socket.bind(0, "127.0.0.1", () => {
      const { port } = socket.address() as { port: number };
      socket.close(() => resolve(port));
    });
  });
}

/** True when nothing holds `port`, i.e. the daemon really let go of it. */
function isUdpPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = dgram.createSocket({ type: "udp4", reuseAddr: false });
    socket.once("error", () => resolve(false));
    socket.bind(port, "0.0.0.0", () => socket.close(() => resolve(true)));
  });
}

type RpcReply = { id: number; result?: unknown; error?: { code: string; message: string } };
/** `at` is stamped on arrival so a test can order pushes against its own actions. */
type DaemonEvent = { event: string; data: unknown; at: number };

/** Minimal host-side client: one line out, one line back, events fanned to a log. */
class DaemonClient {
  private nextId = 1;
  private readonly pending = new Map<number, (reply: RpcReply) => void>();
  public readonly events: DaemonEvent[] = [];
  public readonly stderr: string[] = [];
  public readonly unsolicitedReplyCounts = new Map<string, number>();
  private rl?: Interface;
  private rlErr?: Interface;
  public exited?: { code: number | null; signal: NodeJS.Signals | null };

  private constructor(public readonly child: ChildProcess) {}

  public static async launch(script: string, environment?: NodeJS.ProcessEnv): Promise<DaemonClient> {
    const child = spawn(process.execPath, [script], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      env: environment,
    });
    const client = new DaemonClient(child);
    client.rl = createInterface({ input: child.stdout! });
    client.rl.on("line", (line) => client.handleLine(line));
    client.rlErr = createInterface({ input: child.stderr! });
    client.rlErr.on("line", (line) => client.stderr.push(line));
    child.on("exit", (code, signal) => {
      client.exited = { code, signal };
    });
    await client.waitForEvent("ready", 15_000);
    return client;
  }

  private handleLine(raw: string): void {
    const line = raw.trim();
    if (!line) return;
    let payload: any;
    try {
      payload = JSON.parse(line);
    } catch {
      return;
    }
    if (typeof payload?.id === "number") {
      const resolve = this.pending.get(payload.id);
      if (resolve) {
        this.pending.delete(payload.id);
        resolve(payload as RpcReply);
      } else {
        const kind = payload?.error?.code === "SERVER_BUSY" ? "SERVER_BUSY" : "RESULT";
        this.unsolicitedReplyCounts.set(kind, (this.unsolicitedReplyCounts.get(kind) ?? 0) + 1);
      }
      return;
    }
    if (typeof payload?.event === "string") {
      this.events.push({ ...(payload as { event: string; data: unknown }), at: Date.now() });
    }
  }

  public send(method: string, params?: Record<string, unknown>, timeoutMs = 15_000): Promise<RpcReply> {
    const id = this.nextId++;
    return this.sendLine(`${JSON.stringify({ id, method, params })}\n`, id, timeoutMs, method);
  }

  /** Sends an untrusted JSON value and waits for its safe id or the daemon's reserved fallback id 0. */
  public sendRaw(payload: unknown, timeoutMs = 15_000): Promise<RpcReply> {
    const id = payload !== null
      && typeof payload === "object"
      && Object.prototype.hasOwnProperty.call(payload, "id")
      && Number.isSafeInteger((payload as { id?: unknown }).id)
      && (payload as { id: number }).id >= 0
      ? (payload as { id: number }).id
      : 0;
    return this.sendLine(`${JSON.stringify(payload)}\n`, id, timeoutMs, "raw JSON");
  }

  /** Sends raw JSON-line text, for parser failures which cannot be represented by JSON.stringify. */
  public sendRawLine(line: string, responseId = 0, timeoutMs = 15_000): Promise<RpcReply> {
    return this.sendLine(`${line}\n`, responseId, timeoutMs, "raw line");
  }

  private sendLine(line: string, id: number, timeoutMs: number, description: string): Promise<RpcReply> {
    return new Promise<RpcReply>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`daemon RPC '${description}' timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, (reply) => {
        clearTimeout(timer);
        resolve(reply);
      });
      this.child.stdin!.write(line);
    });
  }

  /** Sends and unwraps `result`, failing loudly on a JSON-RPC error reply. */
  public async call<T = any>(method: string, params?: Record<string, unknown>): Promise<T> {
    const reply = await this.send(method, params);
    if (reply.error) {
      throw new Error(`daemon RPC '${method}' failed: ${reply.error.code} ${reply.error.message}`);
    }
    return reply.result as T;
  }

  public async waitForEvent(name: string, timeoutMs = 10_000, match?: (data: any) => boolean): Promise<DaemonEvent> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const found = this.events.find((e) => e.event === name && (!match || match(e.data)));
      if (found) return found;
      await sleep(25);
    }
    throw new Error(`timed out waiting for daemon event '${name}'`);
  }

  public async waitForExit(timeoutMs = 10_000): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.exited) return this.exited;
      await sleep(25);
    }
    throw new Error("timed out waiting for daemon exit");
  }

  public closeStdin(): void {
    this.child.stdin!.end();
  }

  /** Simulates the host disappearing from the daemon's real stdout pipe. */
  public closeStdout(): void {
    this.rl?.close();
    this.child.stdout?.destroy();
  }

  public kill(signal: NodeJS.Signals = "SIGKILL"): void {
    try {
      this.child.kill(signal);
    } catch {
      /* already gone */
    }
  }

  public teardown(): void {
    this.rl?.close();
    this.rlErr?.close();
    if (!this.exited) this.kill("SIGKILL");
  }
}

/**
 * Pulls a whole file from the daemon-hosted engine, one lock-step block at a
 * time, so the engine fires exactly one `transfer:progress` per block.
 *
 * @returns The number of DATA blocks received and the moment the last one was
 *   ACKed — the instant after which the daemon learns the transfer completed.
 */
async function drainRRQ(
  port: number,
  filename: string,
  blksize: number
): Promise<{ blocks: number; lastAckAt: number }> {
  const udp = await createUdpClient();
  try {
    udp.sendTo(encodeRRQ(filename, "octet", { blksize: String(blksize) }), port);
    let blocks = 0;
    for (let safety = 0; safety < 100_000; safety++) {
      const { message } = await udp.nextMsg(20_000);
      const op = getOpcode(message);
      if (op === 6) {
        udp.sendTo(encodeACK(0), port);
        continue;
      }
      if (op === 5) {
        throw new Error(`RRQ failed with TFTP error code ${message.readUInt16BE(2)}`);
      }
      if (op !== 3) continue;
      const blockNum = message.readUInt16BE(2);
      const payloadLen = message.length - 4;
      blocks++;
      udp.sendTo(encodeACK(blockNum), port);
      if (payloadLen < blksize) {
        const lastAckAt = Date.now();
        // Closing the socket in `finally` would discard the datagram still
        // queued in it, and the engine would never see the transfer finish.
        await sleep(100);
        return { blocks, lastAckAt };
      }
    }
    throw new Error("RRQ never reached its final block");
  } finally {
    udp.close();
  }
}

interface TftpRuntimeReply {
  snapshot: { id: string; status: string; errorMessage?: string };
  transfers: unknown[];
  root: string;
  allowWrite: boolean;
  boundPort: number | null;
}

describe("Network servers daemon — stdio JSON-RPC bridge", () => {
  let root: string;
  let client: DaemonClient;

  beforeAll(async () => {
    daemonScript = await buildDaemonBundle();
  }, 60_000);

  afterAll(() => {
    if (!daemonBundleDir) return;
    fs.rmSync(daemonBundleDir, { recursive: true, force: true });
    daemonBundleDir = undefined;
  });

  beforeEach(async () => {
    root = mkdtemp("nexus-daemon-root-");
    fs.writeFileSync(path.join(root, "boot.bin"), Buffer.from("PXE-PAYLOAD-0123456789", "ascii"));
    client = await DaemonClient.launch(daemonScript);
  });

  afterEach(async () => {
    client.teardown();
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it("announces readiness and answers `list` with both fixed services stopped", async () => {
    const list = await client.call<Array<{ id: string; name: string; port: number; status: string }>>("list");
    expect(list.map((s) => s.id).sort()).toEqual(["dhcp", "tftp"]);
    expect(list.every((s) => s.status === "stopped")).toBe(true);
  });

  it("answers `getStatus` for a known id and rejects an unknown service through the closed request boundary", async () => {
    const snapshot = await client.call<{ id: string; status: string }>("getStatus", { id: "dhcp" });
    expect(snapshot.id).toBe("dhcp");
    expect(snapshot.status).toBe("stopped");

    const missing = await client.send("getStatus", { id: "ftp" });
    expect(missing.error?.code).toBe("INVALID_REQUEST");
  });

  it("returns closed INVALID_REQUEST envelopes for invalid ids, methods, params, configs, and JSON without reaching a manager operation", async () => {
    const cases: readonly [string, unknown, number][] = [
      ["unsafe id", { id: -1, method: "list" }, 0],
      ["unknown method", { id: 41, method: "selfDestruct" }, 41],
      ["extra request key", { id: 42, method: "list", extra: true }, 42],
      ["unexpected list params", { id: 43, method: "list", params: {} }, 43],
      ["wrong service params", { id: 44, method: "stop", params: { id: "ftp" } }, 44],
      ["extra service params", { id: 45, method: "stop", params: { id: "tftp", force: true } }, 45],
      ["wrong service config", { id: 46, method: "start", params: { id: "tftp", config: { rangeStart: "10.0.0.2" } } }, 46],
      ["extra config field", { id: 47, method: "configure", params: { configs: { tftp: { unknown: true } } } }, 47],
    ];

    for (const [name, payload, id] of cases) {
      const reply = await client.sendRaw(payload);
      expect(reply.id, name).toBe(id);
      expect(reply.error?.code, name).toBe("INVALID_REQUEST");
      expect(reply.result, name).toBeUndefined();
    }

    const invalidJson = await client.sendRawLine("this is not json");
    expect(invalidJson.id).toBe(0);
    expect(invalidJson.error?.code).toBe("INVALID_REQUEST");

    // No rejected mutation may have started a TFTP adapter or changed its status.
    const status = await client.call<{ status: string }>("getStatus", { id: "tftp" });
    expect(status.status).toBe("stopped");
    expect(client.exited).toBeUndefined();
  });

  it("rejects an unknown method with INVALID_REQUEST rather than dying", async () => {
    const reply = await client.send("selfDestruct");
    expect(reply.error?.code).toBe("INVALID_REQUEST");
    // Still alive and serving afterwards.
    await expect(client.call("list")).resolves.toBeDefined();
  });

  it("rejects malformed configure, start, and restart DTOs as INVALID_REQUEST before applying or creating an adapter", async () => {
    const malformedDhcp = await client.send("configure", { configs: { dhcp: { dns: ["not-an-ip"] } } });
    expect(malformedDhcp.error?.code).toBe("INVALID_REQUEST");

    const emptyDns = await client.send("configure", { configs: { dhcp: { dns: [] } } });
    expect(emptyDns.error?.code).toBe("INVALID_REQUEST");

    const duplicateReservationAddress = await client.send("configure", {
      configs: {
        dhcp: {
          static: {
            "AA-BB-CC-DD-EE-01": "172.28.1.50",
            "aa:bb:cc:dd:ee:02": "172.28.1.50",
          },
        },
      },
    });
    expect(duplicateReservationAddress.error?.code).toBe("INVALID_REQUEST");

    const blankVendorFilter = await client.send("configure", { configs: { dhcp: { vendorClassId: "  \t " } } });
    expect(blankVendorFilter.error?.code).toBe("INVALID_REQUEST");

    const malformedStart = await client.send("start", { id: "tftp", config: { port: -1 } });
    expect(malformedStart.error?.code).toBe("INVALID_REQUEST");
    expect((await client.call<{ status: string }>("getStatus", { id: "tftp" })).status).toBe("stopped");

    const malformedRestart = await client.send("restart", { id: "tftp", config: { interface: "not-an-ip" } });
    expect(malformedRestart.error?.code).toBe("INVALID_REQUEST");
    expect((await client.call<{ status: string }>("getStatus", { id: "tftp" })).status).toBe("stopped");
  });

  it("bounds an oversized stdin frame, reports the reserved fallback id, and terminates deterministically", async () => {
    const reply = await client.sendRawLine("x".repeat(MAX_RPC_LINE_BYTES + 1));
    expect(reply.id).toBe(0);
    expect(reply.error?.code).toBe("INVALID_REQUEST");
    await expect(client.waitForExit(15_000)).resolves.toEqual({ code: 0, signal: null });
  });

  it("admits only the fixed number of same-chunk daemon requests and returns correlated SERVER_BUSY overloads", async () => {
    const firstId = 80_000;
    const frames = Array.from({ length: MAX_DAEMON_RPC_IN_FLIGHT + 1 }, (_unused, index) => JSON.stringify({
      id: firstId + index,
      method: "list",
    })).join("\n");
    client.child.stdin!.write(`${frames}\n`);

    const expectedReplies = MAX_DAEMON_RPC_IN_FLIGHT + 1;
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const observed = [...client.unsolicitedReplyCounts.values()].reduce((total, count) => total + count, 0);
      if (observed === expectedReplies) break;
      await sleep(25);
    }

    expect(client.unsolicitedReplyCounts.get("SERVER_BUSY")).toBe(1);
    expect(client.unsolicitedReplyCounts.get("RESULT")).toBe(MAX_DAEMON_RPC_IN_FLIGHT);
    await expect(client.call("list")).resolves.toHaveLength(2);
  }, 30_000);

  it("shuts down when the real bundled daemon loses its stdout reader", async () => {
    client.closeStdout();
    client.child.stdin!.write(`${JSON.stringify({ id: 90_000, method: "list" })}\n`);

    const exit = await client.waitForExit(15_000);
    if (process.platform !== "win32") expect(exit.code).toBe(0);
  });

  it("rejects an invalid environment seed before the daemon announces readiness", async () => {
    const seeded = await DaemonClient.launch(daemonScript, {
      ...process.env,
      NEXUS_NETWORK_SERVERS_CONFIG: JSON.stringify({ dhcp: { static: { "bad-mac": "10.0.0.50" } } }),
    });
    try {
      const warning = seeded.events.find((event) => event.event === "log" && JSON.stringify(event.data).includes("NEXUS_NETWORK_SERVERS_CONFIG"));
      expect(warning).toBeDefined();
      await expect(seeded.call("list")).resolves.toBeDefined();
    } finally {
      seeded.teardown();
    }
  });

  it("rejects a whitespace-only vendor filter in the environment seed before readiness", async () => {
    const seeded = await DaemonClient.launch(daemonScript, {
      ...process.env,
      NEXUS_NETWORK_SERVERS_CONFIG: JSON.stringify({ dhcp: { vendorClassId: "  \t " } }),
    });
    try {
      const warning = seeded.events.find((event) => event.event === "log" && JSON.stringify(event.data).includes("dhcp.vendorClassId"));
      expect(warning).toBeDefined();
      await expect(seeded.call("list")).resolves.toBeDefined();
    } finally {
      seeded.teardown();
    }
  });

  it("`start` binds a real UDP socket that serves a file end to end through the daemon", async () => {
    await client.call("start", { id: "tftp", config: { root, port: 0, allowWrite: false } });
    await client.waitForEvent("statusChange", 10_000, (d) => d?.id === "tftp" && d?.status === "running");

    const runtime = await client.call<TftpRuntimeReply>("getServiceRuntime", { id: "tftp" });
    expect(runtime.snapshot.status).toBe("running");
    expect(runtime.root).toBe(root);
    expect(runtime.allowWrite).toBe(false);
    expect(runtime.boundPort).toBeTypeOf("number");

    const udp = await createUdpClient();
    try {
      udp.sendTo(encodeRRQ("boot.bin", "octet"), runtime.boundPort!);
      const { message } = await udp.nextMsg(8000);
      expect(getOpcode(message), "expected a DATA packet from the daemon-hosted engine").toBe(3);
      expect(message.readUInt16BE(2)).toBe(1);
      expect(message.subarray(4).toString("ascii")).toBe("PXE-PAYLOAD-0123456789");
      udp.sendTo(encodeACK(1), runtime.boundPort!);
    } finally {
      udp.close();
    }

    await client.call("stop", { id: "tftp" });
    const stopped = await client.call<{ status: string }>("getStatus", { id: "tftp" });
    expect(stopped.status).toBe("stopped");
  });

  it("`start` on a port that is already taken answers an RPC error, not ok:true", async () => {
    // The failure has to travel: the adapter records ERROR *and* rejects, the
    // daemon turns the rejection into a JSON-RPC error, and only then can
    // NetworkServerManager throw and the command layer tell the user. When the
    // adapter swallowed its own failure this reply was `{ok: true}` and every
    // layer above it stayed silent.
    const squatter = dgram.createSocket({ type: "udp4", reuseAddr: false });
    const port = await new Promise<number>((resolve, reject) => {
      squatter.once("error", reject);
      squatter.bind(0, "0.0.0.0", () => resolve((squatter.address() as { port: number }).port));
    });
    try {
      const reply = await client.send("start", { id: "tftp", config: { root, port, allowWrite: false } });
      expect(reply.result, "a service that could not bind must not report success").toBeUndefined();
      expect(reply.error?.message).toMatch(/already in use/i);

      // And the daemon itself is still healthy afterwards.
      const status = await client.call<{ id: string; status: string }>("getStatus", { id: "tftp" });
      expect(status.status).toBe("error");
    } finally {
      await new Promise<void>((done) => squatter.close(() => done()));
    }
  });

  it("`restart` picks up a `configure` that landed while the service was running (stale-config eviction)", async () => {
    await client.call("start", { id: "tftp", config: { root, port: 0, allowWrite: false } });
    await client.waitForEvent("statusChange", 10_000, (d) => d?.id === "tftp" && d?.status === "running");
    const before = await client.call<TftpRuntimeReply>("getServiceRuntime", { id: "tftp" });
    expect(before.boundPort).toBeTypeOf("number");

    // Reconfigure while RUNNING: the daemon must NOT rebuild a live service
    // (that would drop in-flight transfers), so the new port cannot take effect
    // yet — it has to be remembered as stale.
    const newPort = await allocateFreeUdpPort();
    const changed = await client.call<{ ok: boolean; changed: string[] }>("configure", {
      configs: { tftp: { root, port: newPort, allowWrite: false } }
    });
    expect(changed.changed).toContain("tftp");

    const stillRunning = await client.call<TftpRuntimeReply>("getServiceRuntime", { id: "tftp" });
    expect(stillRunning.snapshot.status).toBe("running");
    expect(stillRunning.boundPort, "a live service must keep its original port until restarted").toBe(before.boundPort);

    // Restart carries NO config of its own — the only way it can land on
    // `newPort` is by evicting the adapter the earlier `configure` marked stale.
    await client.call("restart", { id: "tftp" });
    const after = await client.call<TftpRuntimeReply>("getServiceRuntime", { id: "tftp" });
    expect(after.snapshot.status).toBe("running");
    expect(after.boundPort, "restart must rebuild the adapter from the configuration pushed while it was running").toBe(
      newPort
    );
    expect(after.boundPort).not.toBe(before.boundPort);

    // And the new port is genuinely bound, not merely reported.
    const udp = await createUdpClient();
    try {
      udp.sendTo(encodeRRQ("boot.bin", "octet"), newPort);
      const { message } = await udp.nextMsg(8000);
      expect(getOpcode(message)).toBe(3);
      udp.sendTo(encodeACK(1), newPort);
    } finally {
      udp.close();
    }
  });

  it("serializes same-service restart, configure, and start workflows in input order", async () => {
    await client.call("start", { id: "tftp", config: { root, port: 0, allowWrite: false } });
    const restartPort = await allocateFreeUdpPort();
    const configuredPort = await allocateFreeUdpPort();

    const restarted = client.send("restart", { id: "tftp", config: { root, port: restartPort, allowWrite: false } });
    const configured = client.send("configure", { configs: { tftp: { root, port: configuredPort, allowWrite: false } } });
    const started = client.send("start", { id: "tftp" });

    for (const reply of await Promise.all([restarted, configured, started])) {
      expect(reply.error, "each accepted workflow must receive its own success reply").toBeUndefined();
    }

    // The later configure is deliberately deferred while the restarted socket
    // runs. A later restart must therefore use its port, not let the earlier
    // restart overwrite the saved config after the fact.
    await client.call("restart", { id: "tftp" });
    const runtime = await client.call<TftpRuntimeReply>("getServiceRuntime", { id: "tftp" });
    expect(runtime.boundPort).toBe(configuredPort);
    expect(await isUdpPortFree(restartPort), "the superseded socket must be released before the final start").toBe(true);
    expect(await isUdpPortFree(configuredPort), "the final configured socket must be owned exactly once").toBe(false);
  });

  it(
    "coalesces per-block runtime pushes instead of writing one stdout line per TFTP block",
    async () => {
      // 700 lock-step blocks ⇒ the engine fires ~700 `runtimeUpdate`s upstream.
      // Bridged one-to-one (the behaviour before the daemon-side throttle) that
      // is ~700 JSON lines on stdout for a single small transfer.
      const blksize = 512;
      const expectedBlocks = 700;
      fs.writeFileSync(path.join(root, "firmware.bin"), Buffer.alloc(blksize * expectedBlocks - 1, 0x5a));

      await client.call("start", { id: "tftp", config: { root, port: 0, allowWrite: false } });
      await client.waitForEvent("statusChange", 10_000, (d) => d?.id === "tftp" && d?.status === "running");
      const runtime = await client.call<TftpRuntimeReply>("getServiceRuntime", { id: "tftp" });

      const tftpUpdates = (): DaemonEvent[] =>
        client.events.filter((e) => e.event === "runtimeUpdate" && (e.data as { id?: string })?.id === "tftp");

      const before = tftpUpdates().length;
      const { blocks, lastAckAt } = await drainRRQ(runtime.boundPort!, "firmware.bin", blksize);
      expect(blocks).toBe(expectedBlocks);

      // Let the completion push and any in-flight window land.
      await sleep(RUNTIME_UPDATE_THROTTLE_MS * 3);
      const updates = tftpUpdates();
      const written = updates.length - before;

      expect(written, "the throttle must not silence the service entirely").toBeGreaterThan(0);
      expect(
        written,
        `expected far fewer runtimeUpdate lines than the ${blocks} blocks that produced them, got ${written}`
      ).toBeLessThan(blocks / 4);

      // The last state must still reach the host: `transfer:complete` bypasses
      // the window, so an update lands after the final block was ACKed and the
      // runtime the host then reads shows the transfer gone.
      const last = updates[updates.length - 1]!;
      expect(last.at, "the completed transfer must be announced, not swallowed by a window").toBeGreaterThanOrEqual(
        lastAckAt
      );

      const settled = await client.call<TftpRuntimeReply>("getServiceRuntime", { id: "tftp" });
      expect(settled.transfers).toEqual([]);
    },
    120_000
  );

  it("closing stdin and delivering SIGTERM together run one clean shutdown and release the UDP port", async () => {
    const port = await allocateFreeUdpPort();
    await client.call("start", { id: "tftp", config: { root, port, allowWrite: false } });
    await client.waitForEvent("statusChange", 10_000, (d) => d?.id === "tftp" && d?.status === "running");
    expect(await isUdpPortFree(port), "port should be held while the service runs").toBe(false);

    client.closeStdin();
    client.kill("SIGTERM");
    const exit = await client.waitForExit(15_000);
    if (process.platform !== "win32") expect(exit.code).toBe(0);
    expect(await isUdpPortFree(port), "daemon exit must release the UDP port").toBe(true);
  });

  it("SIGTERM terminates the daemon and releases the UDP port", async () => {
    const port = await allocateFreeUdpPort();
    await client.call("start", { id: "tftp", config: { root, port, allowWrite: false } });
    await client.waitForEvent("statusChange", 10_000, (d) => d?.id === "tftp" && d?.status === "running");

    client.kill("SIGTERM");
    await client.waitForExit(15_000);
    expect(client.child.killed || client.exited !== undefined).toBe(true);
    expect(await isUdpPortFree(port), "SIGTERM must not leave an orphan holding the UDP port").toBe(true);
  });
});
