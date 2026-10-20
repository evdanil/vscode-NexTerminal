import { describe, expect, it, vi } from "vitest";
import { NexusCore } from "../../src/core/nexusCore";
import { deterministicServerId } from "../../src/services/inventory/deterministicId";
import { createContainerlabActivationController, type ContainerlabApprovalStore } from "../../src/services/inventory/containerlabActivation";
import { createContainerlabExecutor } from "../../src/services/inventory/containerlabRuntime";
import type {
  ContainerlabCommand,
  ContainerlabCommandResult,
  ContainerlabCommandRunner,
  ContainerlabLocalExecutableFileSystem
} from "../../src/services/inventory/containerlabRuntimeContracts";
import { createContainerlabProvider } from "../../src/services/inventory/providers/containerlabProvider";
import { planToApplication, computeSyncPlan } from "../../src/services/inventory/syncEngine";
import { InMemoryConfigRepository } from "../../src/storage/inMemoryConfigRepository";
import type { ServerConfig } from "../../src/models/config";
import type { InventorySourceConfig } from "../../src/models/inventory";

const sourceId = "containerlab-source";
const imageId = `sha256:${"a".repeat(64)}`;

function row(lab: string, node: string, address: string): Record<string, unknown> {
  return {
    ID: `${lab}-${node}-container`,
    Names: [`/clab-${lab}-${node}`],
    Image: "ghcr.io/example/router:1",
    State: "running",
    Status: "Up 2 minutes",
    Labels: {
      containerlab: lab,
      "clab-node-name": node,
      "clab-node-kind": "linux",
      "clab-node-type": "linux"
    },
    NetworkSettings: {
      IPv4addr: address,
      IPv4pLen: 24,
      IPv6addr: "",
      IPv6pLen: 0
    }
  };
}

function existingLabServer(lab: string, node: string, address: string): ServerConfig {
  const externalId = JSON.stringify([lab, `clab-${lab}-${node}`]);
  return {
    id: deterministicServerId(sourceId, externalId),
    name: node,
    host: address,
    port: 22,
    username: "admin",
    authType: "agent",
    isHidden: false,
    origin: { sourceId, externalId, syncedAt: 1 }
  };
}

function makeSource(): InventorySourceConfig {
  return {
    id: sourceId,
    providerId: "containerlab",
    name: "Two labs",
    targetFolder: "",
    prunePolicy: "delete",
    defaultUsername: "admin",
    config: {
      location: "local",
      runner: "disposable",
      containerlabExecutable: "containerlab",
      dockerExecutable: "/usr/bin/docker",
      runnerImage: "fixture/containerlab:0.80.0",
      dockerSocket: "/var/run/docker.sock",
      deviceConnection: "direct",
      statusPollSeconds: 0
    },
    secretFieldIds: []
  };
}

function makeRunner(): {
  runner: ContainerlabCommandRunner;
  calls: ContainerlabCommand[];
  seenInspections: ContainerlabCommand[];
} {
  const calls: ContainerlabCommand[] = [];
  const seenInspections: ContainerlabCommand[] = [];
  const runner: ContainerlabCommandRunner = {
    async run(command, context): Promise<ContainerlabCommandResult> {
      calls.push(command);
      if (!context.isCurrent() || context.signal.aborted) throw new Error("stale runtime context");

      if (command.args.includes("info")) {
        return {
          stdout: JSON.stringify({ OSType: "linux", SecurityOptions: ["name=seccomp,profile=builtin"] }),
          stderr: ""
        };
      }
      if (command.args.includes("image") && command.args.includes("inspect")) {
        return { stdout: `${imageId}\n`, stderr: "" };
      }
      if (command.args.includes("run")) {
        const imageIndex = command.args.indexOf(imageId);
        const innerArgs = imageIndex < 0 ? [] : command.args.slice(imageIndex + 1);
        const cliIndex = innerArgs.indexOf("containerlab");
        if (cliIndex >= 0) {
          const cliArgs = innerArgs.slice(cliIndex + 1);
          if (cliArgs.includes("version")) return { stdout: "    version: 0.80.0\n", stderr: "" };
          if (cliArgs.includes("inspect")) {
            seenInspections.push(command);
            const outerEnvironmentIsClean =
              command.cwd === "/" &&
              Object.keys(command.env).sort().join(",") === "DOCKER_HOST,LANG,LC_ALL,PATH" &&
              command.env.DOCKER_HOST === "unix:///var/run/docker.sock" &&
              command.env.PATH === "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" &&
              command.env.LANG === "C.UTF-8" &&
              command.env.LC_ALL === "C.UTF-8";
            const innerEnvironment = innerArgs.slice(1, cliIndex).map((entry) => entry.split("=", 1)[0]).sort();
            const innerEnvironmentIsClean =
              innerArgs[0] === "-i" &&
              innerEnvironment.join(",") === "DOCKER_HOST,LANG,LC_ALL,PATH" &&
              innerArgs.includes("DOCKER_HOST=unix:///var/run/docker.sock") &&
              innerArgs.includes("PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin") &&
              innerArgs.includes("LANG=C.UTF-8") &&
              innerArgs.includes("LC_ALL=C.UTF-8");
            const inspectsEveryLab = cliArgs.includes("--topo=") && cliArgs.includes("--name=");

            // Model the CLI's unsafe inherited-selector behavior: if the production
            // command ever omits either explicit all-labs selector or lets the
            // hostile environment through, this successful response contains only
            // lab-a and would prune the existing lab-b server.
            const result = outerEnvironmentIsClean && innerEnvironmentIsClean && inspectsEveryLab
              ? { "lab-a": [row("lab-a", "r1", "10.0.0.11")], "lab-b": [row("lab-b", "r1", "10.0.0.21")] }
              : { "lab-a": [row("lab-a", "r1", "10.0.0.11")] };
            return { stdout: JSON.stringify(result), stderr: "" };
          }
        }
        if (command.args.includes("rm")) return { stdout: "", stderr: "" };
      }
      throw new Error(`Unexpected Containerlab fixture command: ${command.executable} ${command.args.join(" ")}`);
    }
  };
  return { runner, calls, seenInspections };
}

describe("Containerlab source integration", () => {
  it("keeps every lab through the production disposable command, provider parser, planner, and apply", async () => {
    vi.stubEnv("CLAB_NAME", "lab-a");
    vi.stubEnv("CLAB_TOPO", "/tmp/only-lab-a.clab.yml");
    vi.stubEnv("DOCKER_CONTEXT", "single-lab-context");
    vi.stubEnv("RUNNER_ENV", "hostile-runner-value");

    const source = makeSource();
    const priorServers = [
      existingLabServer("lab-a", "r1", "10.0.0.11"),
      existingLabServer("lab-b", "r1", "10.0.0.21")
    ];
    const core = new NexusCore(new InMemoryConfigRepository(priorServers));
    await core.initialize();
    await core.addOrUpdateInventorySource(source);
    const savedSource = core.getInventorySource(sourceId)!;
    expect(savedSource.revision).toBeTruthy();

    const store: ContainerlabApprovalStore = { load: vi.fn(async () => undefined), save: vi.fn(async () => {}) };
    const confirmRun = vi.fn(async () => true);
    const runtimeRunner = makeRunner();
    const fileSystem: ContainerlabLocalExecutableFileSystem = {
      realpath: vi.fn(async (path) => path),
      stat: vi.fn(async () => ({ isFile: () => true })),
      access: vi.fn(async () => {})
    };
    const executor = createContainerlabExecutor({
      localRunner: runtimeRunner.runner,
      sshRunner: runtimeRunner.runner,
      localFileSystem: fileSystem,
      createInvocationId: () => "test-run"
    });
    const activation = createContainerlabActivationController({
      core,
      executor,
      store,
      isWorkspaceTrusted: () => true,
      confirmRun,
      createId: (() => {
        let id = 0;
        return () => `approval-${++id}`;
      })()
    });

    try {
      const provider = createContainerlabProvider(activation);
      const tree = await provider.fetchInventory!(savedSource.config, {}, {
        intent: "sync",
        subject: { kind: "source", sourceId, revision: savedSource.revision! }
      });
      expect(tree.devices.map((device) => device.externalId).sort()).toEqual([
        JSON.stringify(["lab-a", "clab-lab-a-r1"]),
        JSON.stringify(["lab-b", "clab-lab-b-r1"])
      ]);

      const plan = computeSyncPlan({
        source: savedSource,
        tree,
        currentServers: core.getSnapshot().servers,
        now: 2,
        sourceDefaultRoute: provider.sourceDefaultRoute?.(savedSource.config)
      });
      expect(plan.prunes).toEqual([]);
      expect(plan.adds).toEqual([]);
      expect(confirmRun).toHaveBeenCalledTimes(1);
      expect(store.save).toHaveBeenCalled();
      expect(runtimeRunner.seenInspections).toHaveLength(1);
      expect(runtimeRunner.calls.every((call) => call.cwd === "/")).toBe(true);

      await core.applyInventorySyncPlan(planToApplication(plan, savedSource));
      expect(core.getSnapshot().servers.map((server) => server.id).sort()).toEqual(priorServers.map((server) => server.id).sort());
      expect(core.getSnapshot().servers.map((server) => server.origin?.externalId).sort()).toEqual([
        JSON.stringify(["lab-a", "clab-lab-a-r1"]),
        JSON.stringify(["lab-b", "clab-lab-b-r1"])
      ]);
    } finally {
      activation.dispose();
      vi.unstubAllEnvs();
    }
  });
});
