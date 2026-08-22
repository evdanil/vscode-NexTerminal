import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { MAX_RPC_LINE_BYTES } from "../../../src/services/networkServers/boundedLineReader";
import { BoundedJsonLineWriter } from "../../../src/services/networkServers/boundedJsonLineWriter";

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

describe("bounded daemon JSON-line writer", () => {
  it("keeps an exact maximum producer result and converts its first-over peer to RESPONSE_TOO_LARGE", async () => {
    const stream = new ControlledWritable({ highWaterMark: 1 });
    const writer = new BoundedJsonLineWriter(stream, { onTerminal: () => undefined });
    const overhead = Buffer.byteLength(JSON.stringify({ id: 4, result: "" }), "utf8");
    const atLimit = "x".repeat(MAX_RPC_LINE_BYTES - overhead);

    writer.write({ id: 4, result: atLimit });
    writer.write({ id: 5, result: `${atLimit}x` });
    stream.release();
    await turn();
    stream.release();
    await turn();

    const first = stream.chunks[0]!.toString("utf8");
    expect(Buffer.byteLength(first.slice(0, -1), "utf8")).toBe(MAX_RPC_LINE_BYTES);
    expect(JSON.parse(first)).toEqual({ id: 4, result: atLimit });
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
});
