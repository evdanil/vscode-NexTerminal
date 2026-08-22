import { describe, expect, it } from "vitest";
import { BaseNexusServer } from "../../../src/services/networkServers/core/BaseNexusServer";
import { ServerManager } from "../../../src/services/networkServers/core/ServerManager";
import { ServerStatus } from "../../../src/services/networkServers/core/ServerStatus";
import { NetworkServerConfigController, type NetworkServerConfigStore } from "../../../src/services/networkServers/networkServerConfigController";
import { ServiceWorkflowQueue } from "../../../src/services/networkServers/networkServerWorkflowQueue";

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

class ConfiguredDhcpOwner extends BaseNexusServer {
  public disposeAttempts = 0;
  public disposed = false;

  public constructor(
    public readonly config: { readonly rangeStart: string },
    private failFirstDisposal: boolean,
  ) {
    super("dhcp", "Configured DHCP owner", 67);
  }

  public override async start(): Promise<void> {
    this.setStatus(ServerStatus.RUNNING);
  }

  public override async stop(): Promise<void> {
    this.setStatus(ServerStatus.STOPPED);
  }

  public override async dispose(): Promise<void> {
    this.disposeAttempts += 1;
    if (this.failFirstDisposal) {
      this.failFirstDisposal = false;
      throw new Error("synthetic failed DHCP eviction");
    }
    this.disposed = true;
  }
}

describe("NetworkServerConfigController", () => {
  it("keeps a failed idle DHCP eviction stale until the queued start retries cleanup and creates an owner with the published configuration (catches clearing staleness before dropInstance succeeds)", async () => {
    const configStore: NetworkServerConfigStore = {};
    const manager = new ServerManager();
    const controller = new NetworkServerConfigController(manager, configStore);
    const owners: ConfiguredDhcpOwner[] = [];
    const workflows = new ServiceWorkflowQueue();
    const replies: string[] = [];
    const retryEntered = deferred();
    const releaseRetry = deferred();
    manager.register("dhcp", () => {
      const owner = new ConfiguredDhcpOwner(
        { rangeStart: configStore.dhcp?.rangeStart ?? "missing" },
        owners.length === 0,
      );
      owners.push(owner);
      return owner;
    });

    await controller.apply("dhcp", { rangeStart: "172.28.1.10" });
    await manager.start("dhcp");
    const staleOwner = manager.getInstance("dhcp") as ConfiguredDhcpOwner;
    await manager.stop("dhcp");

    const failedConfigure = workflows.enqueue("dhcp", async () => {
      try {
        return await controller.apply("dhcp", { rangeStart: "172.28.1.20" });
      } catch (error) {
        replies.push("configure:error");
        throw error;
      }
    });
    const retriedStart = workflows.enqueue("dhcp", async () => {
      retryEntered.resolve();
      await releaseRetry.promise;
      expect(controller.requiresEviction("dhcp")).toBe(true);
      await controller.evictIfIdle("dhcp");
      await manager.start("dhcp");
      replies.push("start:ok");
    });

    await expect(failedConfigure).rejects.toThrow(/synthetic failed DHCP eviction/);
    await retryEntered.promise;
    expect(manager.getInstance("dhcp")).toBe(staleOwner);
    expect(staleOwner.disposeAttempts).toBe(1);
    expect(staleOwner.disposed).toBe(false);
    expect(configStore.dhcp).toEqual({ rangeStart: "172.28.1.20" });

    releaseRetry.resolve();
    await expect(retriedStart).resolves.toBeUndefined();
    const replacement = manager.getInstance("dhcp") as ConfiguredDhcpOwner;
    expect(replies).toEqual(["configure:error", "start:ok"]);
    expect(replacement).not.toBe(staleOwner);
    expect(replacement.config).toEqual({ rangeStart: "172.28.1.20" });
    expect(staleOwner.disposeAttempts).toBe(2);
    expect(staleOwner.disposed).toBe(true);
    expect(controller.requiresEviction("dhcp")).toBe(false);
  });
});
