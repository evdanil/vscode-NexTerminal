import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const spawnMock = vi.fn();
vi.mock("node:child_process", () => ({ spawn: (...args: unknown[]) => spawnMock(...args) }));

import { SerialSidecarManager } from "../../src/services/serial/serialSidecarManager";

class FakeChild extends EventEmitter {
  public killed = false;
  public readonly stdin = new PassThrough();
  public readonly stdout = new PassThrough();
  public readonly stderr = new PassThrough();
  public readonly writes: Array<{ method: string; params: { sessionId?: string } }> = [];

  public constructor() {
    super();
    this.stdin.on("data", (chunk: Buffer) => {
      for (const line of chunk.toString("utf8").split("\n").filter(Boolean)) {
        this.writes.push(JSON.parse(line));
      }
    });
  }

  public kill(): boolean {
    this.killed = true;
    this.emit("exit");
    return true;
  }
}

async function tick(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("SerialSidecarManager open cancellation", () => {
  let children: FakeChild[];

  beforeEach(() => {
    vi.useFakeTimers();
    children = [];
    spawnMock.mockReset();
    spawnMock.mockImplementation(() => {
      const child = new FakeChild();
      children.push(child);
      return child;
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("sends closePort for the opening session id to the same child when openPort times out", async () => {
    const manager = new SerialSidecarManager("worker.js", undefined, 2000);
    const opening = manager.openPort({ path: "COM9", baudRate: 9600 }, "opening-1");
    const assertion = expect(opening).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(2000);
    await assertion;

    expect(spawnMock).toHaveBeenCalledTimes(1);
    const closes = children[0].writes.filter((w) => w.method === "closePort");
    expect(closes).toHaveLength(1);
    expect(closes[0].params.sessionId).toBe("opening-1");
    manager.dispose();
  });

  it("sends no closePort when the worker rejects the open itself, e.g. a duplicate session id", async () => {
    const manager = new SerialSidecarManager("worker.js");
    const opening = manager.openPort({ path: "COM9", baudRate: 9600 }, "dup-1");
    const assertion = expect(opening).rejects.toThrow("serial session ID is already in use");
    await tick();
    const request = children[0].writes[0] as unknown as { id: string };
    children[0].stdout.write(
      `${JSON.stringify({ id: request.id, error: { message: "serial session ID is already in use" } })}\n`
    );
    await assertion;
    await tick();

    expect(children[0].writes.filter((w) => w.method === "closePort")).toEqual([]);
    manager.dispose();
  });

  it("emits onPortReleaseFailed with the port path when the worker reports an unreleasable abandoned open", async () => {
    const manager = new SerialSidecarManager("worker.js");
    const events: Array<[string, string]> = [];
    manager.onPortReleaseFailed((portPath, message) => events.push([portPath, message]));
    const opening = manager.openPort({ path: "COM9", baudRate: 9600 }, "rel-1");
    opening.catch(() => {});
    await tick();
    children[0].stdout.write(
      `${JSON.stringify({ method: "portReleaseFailed", params: { sessionId: "rel-1", path: "COM9", message: "EBUSY" } })}\n`
    );
    await tick();

    expect(events).toEqual([["COM9", "EBUSY"]]);
    manager.dispose();
  });

  it("does not spawn a replacement sidecar to cancel an open interrupted by dispose", async () => {
    const manager = new SerialSidecarManager("worker.js");
    const opening = manager.openPort({ path: "COM9", baudRate: 9600 }, "opening-2");
    const assertion = expect(opening).rejects.toThrow("Serial sidecar disposed");
    await tick();
    manager.dispose();
    await assertion;
    await tick();

    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect((manager as unknown as { processRef?: unknown }).processRef).toBeUndefined();
  });

  it("does not respawn after the sidecar exited unexpectedly mid-open", async () => {
    const manager = new SerialSidecarManager("worker.js");
    const opening = manager.openPort({ path: "COM9", baudRate: 9600 }, "opening-3");
    const assertion = expect(opening).rejects.toThrow("exited unexpectedly");
    await tick();
    children[0].emit("exit");
    await assertion;
    await tick();

    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect((manager as unknown as { processRef?: unknown }).processRef).toBeUndefined();
    manager.dispose();
  });
});
