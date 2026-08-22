import { Writable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { MAX_RPC_LINE_BYTES } from "../../../src/services/networkServers/boundedLineReader";
import { rpcResultParsers } from "../../../src/services/networkServers/networkServerRpcProtocol";
import {
  BoundedDaemonDiagnosticWriter,
  BoundedJsonLineWriter,
  MAX_DAEMON_DIAGNOSTIC_BYTES,
} from "../../../src/services/networkServers/boundedJsonLineWriter";

class ControlledWritable extends Writable {
  public readonly chunks: Buffer[] = [];
  private readonly callbacks: Array<(error?: Error | null) => void> = [];

  public release(error?: Error): void {
    this.callbacks.shift()?.(error);
  }

  protected override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.chunks.push(Buffer.from(chunk));
    this.callbacks.push(callback);
  }
}

async function turn(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

function dhcpRuntimeResponse(id: number, leaseCount: number, finalClientId: string): { readonly id: number; readonly result: object } {
  return {
    id,
    result: {
      snapshot: { id: "dhcp", name: "DHCP Server", port: 67, status: "running" },
      leases: Array.from({ length: leaseCount }, (_unused, index) => ({
        mac: "aa:bb:cc:dd:ee:ff",
        ip: "192.168.2.10",
        boundAt: 1_700_000_000_000,
        leaseSec: 3_600,
        expiresAt: 1_700_000_003_600,
        remainingSec: 3_599,
        hostname: null,
        leaseType: "dynamic",
        clientId: index === leaseCount - 1 ? finalClientId : "",
      })),
      packetCounters: {
        packetsReceived: 0,
        packetsSentEstimate: 0,
        discoverCount: 0,
        offerCount: 0,
        requestCount: 0,
        declineCount: 0,
        ackCount: 0,
        nakCount: 0,
        releaseCount: 0,
        informCount: 0,
      },
      poolInfo: {
        rangeStart: "192.168.2.10",
        rangeEnd: "192.168.2.199",
        poolSize: 190,
        activeCount: leaseCount,
        utilizationPct: 0,
        staticEntryCount: 0,
      },
      boundPort: null,
    },
  };
}

function dhcpRuntimeResponseAtWireBytes(id: number, payloadBytes: number): { readonly id: number; readonly result: object } {
  let low = 1;
  let high = 10_000;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    const bytes = Buffer.byteLength(JSON.stringify(dhcpRuntimeResponse(id, middle, "")), "utf8");
    if (bytes <= payloadBytes) low = middle;
    else high = middle - 1;
  }
  const baseline = dhcpRuntimeResponse(id, low, "");
  const padding = payloadBytes - Buffer.byteLength(JSON.stringify(baseline), "utf8");
  return dhcpRuntimeResponse(id, low, "x".repeat(padding));
}

describe("bounded daemon JSON-line writer", () => {
  it("keeps an exact maximum parser-accepted DHCP runtime response and converts its first-over peer to RESPONSE_TOO_LARGE", async () => {
    const stream = new ControlledWritable({ highWaterMark: 1 });
    const writer = new BoundedJsonLineWriter(stream, { onTerminal: () => undefined });
    const atLimit = dhcpRuntimeResponseAtWireBytes(4, MAX_RPC_LINE_BYTES);
    const firstOver = dhcpRuntimeResponseAtWireBytes(5, MAX_RPC_LINE_BYTES + 1);
    expect(rpcResultParsers.getServiceRuntime(atLimit.result).ok).toBe(true);
    expect(rpcResultParsers.getServiceRuntime(firstOver.result).ok).toBe(true);

    writer.write(atLimit);
    writer.write(firstOver);
    stream.release();
    await turn();
    stream.release();
    await turn();

    const first = stream.chunks[0]!.toString("utf8");
    expect(Buffer.byteLength(first.slice(0, -1), "utf8")).toBe(MAX_RPC_LINE_BYTES);
    expect(JSON.parse(first)).toEqual(atLimit);
    expect(JSON.parse(stream.chunks[1]!.toString("utf8"))).toEqual({
      id: 5,
      error: { code: "RESPONSE_TOO_LARGE", message: "Daemon response exceeds the RPC line limit." },
    });
  });

  it("converts an oversized correlated result into a bounded closed error without counting its newline", async () => {
    const stream = new ControlledWritable({ highWaterMark: 1 });
    const terminal: Error[] = [];
    const writer = new BoundedJsonLineWriter(stream, { onTerminal: (error) => terminal.push(error) });

    writer.write({ id: 7, result: "\\\"".repeat(Math.ceil(MAX_RPC_LINE_BYTES / 2)) });
    expect(stream.chunks).toHaveLength(1);
    stream.release();
    await turn();

    const line = stream.chunks[0]!.toString("utf8");
    expect(line.endsWith("\n")).toBe(true);
    expect(Buffer.byteLength(line.slice(0, -1), "utf8")).toBeLessThanOrEqual(MAX_RPC_LINE_BYTES);
    expect(JSON.parse(line)).toEqual({
      id: 7,
      error: { code: "RESPONSE_TOO_LARGE", message: "Daemon response exceeds the RPC line limit." },
    });
    expect(terminal).toEqual([]);
  });

  it("serializes output across backpressure and owns callback terminal failures", async () => {
    const stream = new ControlledWritable({ highWaterMark: 1 });
    const terminal: Error[] = [];
    const writer = new BoundedJsonLineWriter(stream, { onTerminal: (error) => terminal.push(error) });

    writer.write({ id: 1, result: null });
    writer.write({ id: 2, result: null });
    expect(stream.chunks.map((chunk) => chunk.toString("utf8"))).toEqual(["{\"id\":1,\"result\":null}\n"]);

    stream.release();
    await turn();
    expect(stream.chunks.map((chunk) => chunk.toString("utf8"))).toEqual([
      "{\"id\":1,\"result\":null}\n",
      "{\"id\":2,\"result\":null}\n",
    ]);

    stream.release(new Error("broken stdout"));
    await turn();
    expect(terminal).toHaveLength(1);
    expect(terminal[0]?.message).toMatch(/broken stdout/i);
  });

  it("drops oversized notifications through its bounded diagnostic policy", () => {
    const stream = new ControlledWritable({ highWaterMark: 1 });
    const drops: string[] = [];
    const writer = new BoundedJsonLineWriter(stream, {
      onTerminal: () => undefined,
      onNotificationDropped: (reason) => drops.push(reason),
    });

    writer.write({ event: "log", data: { id: "daemon", level: "warn", message: "\\\"".repeat(Math.ceil(MAX_RPC_LINE_BYTES / 2)) } });

    expect(stream.chunks).toEqual([]);
    expect(drops).toEqual(["outbound notification exceeds the RPC line limit"]);
  });

  it("bounds queued notifications while a backpressured response is still in flight", () => {
    const stream = new ControlledWritable({ highWaterMark: 1 });
    const drops: string[] = [];
    const writer = new BoundedJsonLineWriter(stream, {
      onTerminal: () => undefined,
      onNotificationDropped: (reason) => drops.push(reason),
    });

    writer.write({ id: 1, result: null });
    for (let index = 0; index < 17; index += 1) {
      writer.write({ event: "runtimeUpdate", data: { id: index % 2 === 0 ? "tftp" : "dhcp" } });
    }

    expect(drops).toEqual(["outbound notification dropped while stdout is backpressured"]);
  });

  it("retains at most one bounded stderr diagnostic under backpressure and consumes terminal failures", () => {
    const stream = new ControlledWritable({ highWaterMark: 1 });
    const diagnostics = new BoundedDaemonDiagnosticWriter(stream);
    const write = vi.spyOn(stream, "write");

    for (let index = 0; index < 1_000; index += 1) {
      diagnostics.write(`dropped notification ${index}: ${"x".repeat(MAX_DAEMON_DIAGNOSTIC_BYTES)}`);
    }

    expect(stream.chunks).toHaveLength(1);
    expect(write).toHaveBeenCalledTimes(1);
    expect(Buffer.byteLength(stream.chunks[0]!, "utf8")).toBeLessThanOrEqual(MAX_DAEMON_DIAGNOSTIC_BYTES);
    expect(() => {
      stream.emit("error", new Error("stderr EPIPE"));
      stream.emit("close");
      diagnostics.write("late diagnostic after stderr failure");
      stream.release(new Error("late callback error"));
    }).not.toThrow();
    expect(stream.chunks).toHaveLength(1);
    write.mockRestore();
  });
});
