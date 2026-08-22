import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { MAX_RPC_LINE_BYTES, attachBoundedLineReader } from "../../../src/services/networkServers/boundedLineReader";

type FramingCase = {
  readonly name: string;
  readonly chunks: readonly Buffer[];
  readonly lines: readonly string[];
};

const FRAMING_CASES: readonly FramingCase[] = [
  {
    name: "multiple complete lines and a residual line across chunks",
    chunks: [Buffer.from("first\nsecond\nres"), Buffer.from("idual\nthird\n")],
    lines: ["first", "second", "residual", "third"],
  },
  {
    name: "a UTF-8 code point split across chunks",
    chunks: [Buffer.from([0x65, 0x75, 0x72, 0x6f, 0x3a, 0xe2]), Buffer.from([0x82, 0xac, 0x0a])],
    lines: ["euro:€"],
  },
  {
    name: "empty lines",
    chunks: [Buffer.from("\n\n")],
    lines: ["", ""],
  },
  {
    name: "a CRLF line",
    chunks: [Buffer.from("windows\r\none\r\r\n")],
    lines: ["windows", "one\r"],
  },
];

function listenerCounts(stream: PassThrough): { readonly data: number; readonly end: number } {
  return { data: stream.listenerCount("data"), end: stream.listenerCount("end") };
}

function ended(stream: PassThrough): Promise<void> {
  return new Promise((resolve) => stream.once("end", resolve));
}

describe("bounded RPC line reader", () => {
  it.each(FRAMING_CASES)("delivers $name", ({ chunks, lines: expectedLines }) => {
    const stream = new PassThrough();
    const lines: string[] = [];
    const errors: Error[] = [];
    const dispose = attachBoundedLineReader(stream, {
      onLine: (line) => lines.push(line),
      onError: (error) => errors.push(error),
    });

    for (const chunk of chunks) stream.write(chunk);

    expect(lines).toEqual(expectedLines);
    expect(errors).toEqual([]);
    dispose();
  });

  it("accepts exactly the byte limit before a newline without counting the delimiter", () => {
    const stream = new PassThrough();
    const lines: string[] = [];
    const errors: Error[] = [];
    const dispose = attachBoundedLineReader(stream, {
      onLine: (line) => lines.push(line),
      onError: (error) => errors.push(error),
    });

    stream.write(Buffer.alloc(MAX_RPC_LINE_BYTES, 0x61));
    expect(lines).toEqual([]);
    expect(errors).toEqual([]);
    stream.write(Buffer.from("\n"));

    expect(lines).toHaveLength(1);
    expect(Buffer.byteLength(lines[0]!, "utf8")).toBe(MAX_RPC_LINE_BYTES);
    expect(errors).toEqual([]);
    dispose();
  });

  it("honors custom byte limits exactly and rejects the first byte over", () => {
    const stream = new PassThrough();
    const lines: string[] = [];
    const errors: Error[] = [];
    const dispose = attachBoundedLineReader(stream, {
      maxBytes: 3,
      onLine: (line) => lines.push(line),
      onError: (error) => errors.push(error),
    });

    stream.write(Buffer.from("abc\n"));
    stream.write(Buffer.from("abcd\n"));

    expect(lines).toEqual(["abc"]);
    expect(errors).toHaveLength(1);
    dispose();
  });

  it.each([-1, 1.5, NaN, Infinity, -Infinity])("rejects invalid maxBytes %s", (maxBytes) => {
    const stream = new PassThrough();
    expect(() => attachBoundedLineReader(stream, {
      maxBytes,
      onLine: () => undefined,
      onError: () => undefined,
    })).toThrow(RangeError);
  });

  it("owns a tiny residual instead of retaining its large mutable backing buffer", () => {
    const stream = new PassThrough();
    const lines: string[] = [];
    const errors: Error[] = [];
    const dispose = attachBoundedLineReader(stream, {
      onLine: (line) => lines.push(line),
      onError: (error) => errors.push(error),
    });
    const backing = Buffer.alloc(8 * 1024 * 1024, 0x78);
    const residualOffset = backing.length - 1;
    backing[residualOffset] = 0x61;

    stream.write(backing.subarray(residualOffset));
    backing[residualOffset] = 0x7a;
    stream.write(Buffer.from("\n"));

    expect(lines).toEqual(["a"]);
    expect(errors).toEqual([]);
    dispose();
  });

  it("finishes an original chunk before a reentrant stream write", () => {
    const stream = new PassThrough();
    const lines: string[] = [];
    const errors: Error[] = [];
    const dispose = attachBoundedLineReader(stream, {
      onLine: (line) => {
        lines.push(line);
        if (line === "a") stream.emit("data", Buffer.from("X"));
      },
      onError: (error) => errors.push(error),
    });

    stream.write(Buffer.from("a\nb\n"));
    stream.write(Buffer.from("\n"));

    expect(lines).toEqual(["a", "b", "X"]);
    expect(errors).toEqual([]);
    dispose();
  });

  it("owns a queued one-byte view before its callback mutates the large source buffer", () => {
    const stream = new PassThrough();
    const lines: string[] = [];
    const errors: Error[] = [];
    const backing = Buffer.alloc(8 * 1024 * 1024, 0x78);
    const residualOffset = backing.length - 1;
    backing[residualOffset] = 0x61;
    const dispose = attachBoundedLineReader(stream, {
      onLine: (line) => {
        lines.push(line);
        if (line !== "start") return;
        stream.emit("data", backing.subarray(residualOffset));
        backing[residualOffset] = 0x7a;
        stream.emit("data", Buffer.from("\n"));
      },
      onError: (error) => errors.push(error),
    });

    stream.write(Buffer.from("start\n"));

    expect(lines).toEqual(["start", "a"]);
    expect(errors).toEqual([]);
    dispose();
  });

  it("uses a bounded number of owned allocations for one-byte ordinary input", () => {
    const stream = new PassThrough();
    const lines: string[] = [];
    const errors: Error[] = [];
    const allocation = vi.spyOn(Buffer, "allocUnsafeSlow");
    const dispose = attachBoundedLineReader(stream, {
      maxBytes: 1_024,
      onLine: (line) => lines.push(line),
      onError: (error) => errors.push(error),
    });

    for (let index = 0; index < 1_024; index += 1) stream.write(Buffer.from("a"));
    stream.write(Buffer.from("\n"));

    expect(lines).toEqual(["a".repeat(1_024)]);
    expect(errors).toEqual([]);
    expect(allocation.mock.calls.length).toBeLessThanOrEqual(16);
    allocation.mockRestore();
    dispose();
  });

  it("uses bounded queue storage across rolling reentrant one-byte input", () => {
    const stream = new PassThrough();
    const lines: string[] = [];
    const errors: Error[] = [];
    const allocation = vi.spyOn(Buffer, "allocUnsafeSlow");
    let remaining = 1_024;
    const dispose = attachBoundedLineReader(stream, {
      maxBytes: 1_024,
      onLine: (line) => {
        lines.push(line);
        if (remaining-- > 0) stream.emit("data", Buffer.from("x\n"));
      },
      onError: (error) => errors.push(error),
    });

    stream.write(Buffer.from("start\n"));

    expect(lines).toHaveLength(1_025);
    expect(errors).toEqual([]);
    expect(allocation.mock.calls.length).toBeLessThanOrEqual(32);
    allocation.mockRestore();
    dispose();
  });

  it("does not scan stale queued-buffer capacity beyond the current reentrant payload", () => {
    const stream = new PassThrough();
    const lines: string[] = [];
    const dispose = attachBoundedLineReader(stream, {
      onLine: (line) => {
        lines.push(line);
        if (line === "start") stream.emit("data", Buffer.from("retained\n"));
        if (line === "retained") stream.emit("data", Buffer.from("x\n"));
        if (line === "x") stream.emit("data", Buffer.from("y"));
      },
      onError: (error) => { throw error; },
    });

    stream.write(Buffer.from("start\n"));
    stream.emit("data", Buffer.from("\n"));

    expect(lines).toEqual(["start", "retained", "x", "y"]);
    dispose();
  });

  it("detaches before rethrowing a terminal line callback exception", () => {
    const stream = new PassThrough();
    const errors: Error[] = [];
    const dispose = attachBoundedLineReader(stream, {
      onLine: () => { throw new Error("listener exploded"); },
      onError: (error) => errors.push(error),
    });

    expect(() => stream.write(Buffer.from("first\nremainder\n"))).toThrow("listener exploded");
    expect(listenerCounts(stream)).toEqual({ data: 0, end: 0 });
    stream.write(Buffer.from("late\n"));

    expect(errors).toEqual([]);
    dispose();
  });

  it("terminates once and drops queued data when reentrant input exceeds its byte budget", () => {
    const stream = new PassThrough();
    const lines: string[] = [];
    const errors: Error[] = [];
    const dispose = attachBoundedLineReader(stream, {
      maxBytes: 6,
      onLine: (line) => {
        lines.push(line);
        if (line !== "t") return;
        for (const chunk of ["a\n", "b\n", "c\n", "d\n"]) stream.emit("data", Buffer.from(chunk));
      },
      onError: (error) => errors.push(error),
    });

    stream.write(Buffer.from("t\n"));
    stream.emit("data", Buffer.from("late\n"));
    stream.emit("end");

    expect(lines).toEqual(["t"]);
    expect(errors).toHaveLength(1);
    expect(listenerCounts(stream)).toEqual({ data: 0, end: 0 });
    dispose();
  });

  it("detaches before an oversize onError callback can reenter its source", () => {
    const stream = new PassThrough();
    const lines: string[] = [];
    const dispose = attachBoundedLineReader(stream, {
      maxBytes: 1,
      onLine: (line) => lines.push(line),
      onError: () => stream.emit("data", Buffer.from("late\n")),
    });

    stream.write(Buffer.from("xx"));

    expect(lines).toEqual([]);
    expect(listenerCounts(stream)).toEqual({ data: 0, end: 0 });
    dispose();
  });

  it("releases historical queued snapshots during rolling reentrancy", () => {
    const fixture = resolve(process.cwd(), "test/unit/networkServers/fixtures/boundedLineReaderRollingRetention.fixture.mjs");
    const child = spawnSync(process.execPath, ["--expose-gc", fixture], {
      cwd: process.cwd(),
      encoding: "utf8",
      timeout: 15_000,
    });

    expect(child.error, child.stderr).toBeUndefined();
    expect(child.status, child.stderr).toBe(0);
    expect((JSON.parse(child.stdout) as { readonly liveSnapshots: number }).liveSnapshots).toBeLessThanOrEqual(2);
  });

  it("reports once and detaches after byte 1,048,577 before a newline", () => {
    const stream = new PassThrough();
    const lines: string[] = [];
    const errors: Error[] = [];
    const dispose = attachBoundedLineReader(stream, {
      onLine: (line) => lines.push(line),
      onError: (error) => errors.push(error),
    });

    stream.write(Buffer.alloc(MAX_RPC_LINE_BYTES + 1, 0x61));
    stream.write(Buffer.alloc(MAX_RPC_LINE_BYTES + 1, 0x62));
    stream.write(Buffer.from("late\n"));
    stream.emit("end");

    expect(lines).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(Error);
    expect(listenerCounts(stream)).toEqual({ data: 0, end: 0 });
    dispose();
    expect(listenerCounts(stream)).toEqual({ data: 0, end: 0 });
  });

  it("delivers a bounded unterminated final line at EOF and preserves a bare CR", async () => {
    const stream = new PassThrough();
    const lines: string[] = [];
    const errors: Error[] = [];
    const dispose = attachBoundedLineReader(stream, {
      onLine: (line) => lines.push(line),
      onError: (error) => errors.push(error),
    });

    const streamEnded = ended(stream);
    stream.end(Buffer.from("bare\r"));
    await streamEnded;

    expect(lines).toEqual(["bare\r"]);
    expect(errors).toEqual([]);
    expect(listenerCounts(stream)).toEqual({ data: 0, end: 0 });
    dispose();
  });

  it("does not deliver a line when EOF has no buffered bytes", async () => {
    const stream = new PassThrough();
    const lines: string[] = [];
    const errors: Error[] = [];
    const dispose = attachBoundedLineReader(stream, {
      onLine: (line) => lines.push(line),
      onError: (error) => errors.push(error),
    });

    const streamEnded = ended(stream);
    stream.end();
    await streamEnded;

    expect(lines).toEqual([]);
    expect(errors).toEqual([]);
    expect(listenerCounts(stream)).toEqual({ data: 0, end: 0 });
    dispose();
  });

  it("removes its listeners idempotently without delivering buffered data", () => {
    const stream = new PassThrough();
    const lines: string[] = [];
    const errors: Error[] = [];
    const dispose = attachBoundedLineReader(stream, {
      onLine: (line) => lines.push(line),
      onError: (error) => errors.push(error),
    });

    expect(listenerCounts(stream)).toEqual({ data: 1, end: 1 });
    stream.write(Buffer.from("buffered"));
    dispose();
    dispose();
    stream.write(Buffer.from("-ignored\n"));
    stream.emit("end");

    expect(lines).toEqual([]);
    expect(errors).toEqual([]);
    expect(listenerCounts(stream)).toEqual({ data: 0, end: 0 });
  });
});
