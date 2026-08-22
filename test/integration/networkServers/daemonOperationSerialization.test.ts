import { describe, expect, it } from "vitest";
import { createNetworkServerDaemonShutdown } from "../../../src/services/networkServers/networkServerDaemonShutdown";
import { ServiceWorkflowQueue } from "../../../src/services/networkServers/networkServerWorkflowQueue";

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("network-server daemon operation serialization", () => {
  it("latches synchronously, drains the accepted workflow, and disposes/exits exactly once across EOF and signals", async () => {
    const workflows = new ServiceWorkflowQueue();
    const operationEntered = deferred();
    const releaseOperation = deferred();
    const timeline: string[] = [];
    const accepted = workflows.enqueue("tftp", async () => {
      timeline.push("operation:start");
      operationEntered.resolve();
      await releaseOperation.promise;
      timeline.push("operation:end");
    });
    await operationEntered.promise;

    const shutdown = createNetworkServerDaemonShutdown({
      stopAccepting: () => workflows.close(),
      drain: () => workflows.drain(),
      flushRuntimeUpdates: () => timeline.push("flush"),
      dispose: async () => { timeline.push("dispose"); },
      exit: () => timeline.push("exit"),
    });

    const eof = shutdown.begin("stdin closed");
    const sigint = shutdown.begin("SIGINT");
    const sigterm = shutdown.begin("SIGTERM");
    expect(eof).toBe(sigint);
    expect(sigint).toBe(sigterm);
    expect(shutdown.isShuttingDown()).toBe(true);
    const late = workflows.enqueue("tftp", async () => undefined);
    expect(timeline).toEqual(["operation:start"]);

    releaseOperation.resolve();
    await expect(late).rejects.toThrow(/shutting down/i);
    await Promise.all([accepted, eof, sigint, sigterm]);
    expect(timeline).toEqual(["operation:start", "operation:end", "flush", "dispose", "flush", "exit"]);
  });

  it("continues disposal and exit when runtime-update flushing throws", async () => {
    const timeline: string[] = [];
    const shutdown = createNetworkServerDaemonShutdown({
      stopAccepting: () => timeline.push("stop"),
      drain: async () => timeline.push("drain"),
      flushRuntimeUpdates: () => {
        timeline.push("flush");
        throw new Error("flush exploded");
      },
      dispose: async () => timeline.push("dispose"),
      exit: () => timeline.push("exit"),
    });

    await expect(shutdown.begin("stdin closed")).resolves.toBeUndefined();
    expect(timeline).toEqual(["stop", "drain", "flush", "dispose", "flush", "exit"]);
  });
});
