import { beforeEach, describe, expect, it, vi } from "vitest";
import { NexusCore } from "../../src/core/nexusCore";
import { InMemoryConfigRepository } from "../../src/storage/inMemoryConfigRepository";
import type { InventoryOperationContext, InventorySourceConfig, InventorySourceValues } from "../../src/models/inventory";
import type { ServerConfig } from "../../src/models/config";
import type {
  ContainerlabExecutionIdentity,
  ContainerlabExecutor,
  ContainerlabRunContext
} from "../../src/services/inventory/containerlabRuntimeContracts";
import { parseContainerlabConfig } from "../../src/services/inventory/providers/containerlabConfig";
import { CONTAINERLAB_INSPECT_ARGS, CONTAINERLAB_VERSION_ARGS } from "../../src/services/inventory/providers/containerlabCommands";
import { createContainerlabActivationController } from "../../src/services/inventory/containerlabActivation";

const LOCAL_VALUES: InventorySourceValues = {
  location: "local",
  runner: "host",
  containerlabExecutable: "containerlab",
  dockerExecutable: "docker",
  dockerSocket: "/var/run/docker.sock",
  sudo: false,
  deviceConnection: "automatic",
  labFilter: "",
  addressPreference: "ipv4"
};

const REMOTE_VALUES: InventorySourceValues = { ...LOCAL_VALUES, location: "ssh", labHostId: "lab-host" };

function makeSource(config: InventorySourceValues = LOCAL_VALUES, overrides: Partial<InventorySourceConfig> = {}): InventorySourceConfig {
  return {
    id: "source-1",
    providerId: "containerlab",
    name: "Containerlab",
    targetFolder: "Labs",
    prunePolicy: "orphan",
    defaultUsername: "netops",
    config,
    secretFieldIds: [],
    ...overrides
  };
}

function identity(overrides: Partial<ContainerlabExecutionIdentity> = {}): ContainerlabExecutionIdentity {
  return {
    executable: "/usr/bin/containerlab",
    dockerExecutable: "/usr/bin/docker",
    dockerSocket: "/var/run/docker.sock",
    location: "local",
    sudo: false,
    routeIdentity: "local",
    ...overrides
  };
}

function memoryStore(initial?: unknown) {
  let value = initial;
  return {
    load: vi.fn(async () => value),
    save: vi.fn(async (next: unknown) => {
      value = next;
    }),
    value: () => value
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function makeHarness(options: {
  trusted?: boolean;
  confirmRun?: (description: string) => Promise<boolean>;
  preflight?: ContainerlabExecutor["preflight"];
  resolvedIdentity?: ContainerlabExecutionIdentity;
  store?: ReturnType<typeof memoryStore>;
  beforeController?: (core: NexusCore) => Promise<void>;
} = {}) {
  const core = new NexusCore(new InMemoryConfigRepository());
  await core.initialize();
  await core.addOrUpdateInventorySource(makeSource());
  await options.beforeController?.(core);
  const source = core.getInventorySource("source-1")!;
  const store = options.store ?? memoryStore();
  const preparedIdentity = options.resolvedIdentity ?? identity();
  const executor: ContainerlabExecutor = {
    resolveDependencies: vi.fn(async (_config, _context, _expected) => ({ identity: preparedIdentity })),
    preflight: options.preflight ?? vi.fn(async (_config, resolved) => ({ identity: resolved.identity, version: "0.80.0" })),
    inspect: vi.fn(async (_config, prepared) => ({ version: prepared.version, stdout: "{}" }))
  };
  const controller = createContainerlabActivationController({
    core,
    executor,
    store,
    isWorkspaceTrusted: () => options.trusted ?? true,
    confirmRun: options.confirmRun ?? (async () => true),
    createId: (() => {
      let next = 0;
      return () => `local-generation-${++next}`;
    })(),
    now: () => 10_000
  });
  return { core, source, config: parseContainerlabConfig(source.config), executor, controller, store };
}

function context(source: InventorySourceConfig, intent: InventoryOperationContext["intent"]): InventoryOperationContext {
  return { intent, subject: { kind: "source", sourceId: source.id, revision: source.revision! } };
}

function sshServer(id: string, host: string, proxy?: ServerConfig["proxy"]): ServerConfig {
  return {
    id,
    name: id,
    host,
    port: 22,
    username: "netops",
    authType: "agent",
    isHidden: false,
    ...(proxy ? { proxy } : {})
  };
}

describe("Containerlab activation", () => {
  beforeEach(() => vi.clearAllMocks());

  it("requires Run before resolving metadata or running version preflight", async () => {
    const run = deferred<boolean>();
    const harness = await makeHarness({ confirmRun: () => run.promise });

    const operation = harness.controller.inspect(harness.config, context(harness.source, "sync"));
    await Promise.resolve();

    expect(harness.executor.resolveDependencies).not.toHaveBeenCalled();
    expect(harness.executor.preflight).not.toHaveBeenCalled();
    run.resolve(true);
    await operation;
    expect(harness.executor.resolveDependencies).toHaveBeenCalledOnce();
    expect(harness.executor.preflight).toHaveBeenCalledOnce();
  });

  it("does not execute or approve when Run is canceled", async () => {
    const harness = await makeHarness({ confirmRun: async () => false });

    await expect(harness.controller.inspect(harness.config, context(harness.source, "test"))).rejects.toThrow(/cancel/i);

    expect(harness.executor.resolveDependencies).not.toHaveBeenCalled();
    expect(harness.executor.preflight).not.toHaveBeenCalled();
    expect(harness.executor.inspect).not.toHaveBeenCalled();
    expect(harness.store.save).not.toHaveBeenCalled();
  });

  it("does not create reusable background approval when version preflight fails", async () => {
    const harness = await makeHarness({
      preflight: vi.fn(async () => {
        throw new Error("unsupported Containerlab version");
      }) as ContainerlabExecutor["preflight"]
    });

    await expect(harness.controller.inspect(harness.config, context(harness.source, "sync"))).rejects.toThrow(/unsupported/);
    vi.mocked(harness.executor.resolveDependencies).mockClear();
    vi.mocked(harness.executor.preflight).mockClear();
    vi.mocked(harness.executor.inspect).mockClear();

    await expect(harness.controller.inspect(harness.config, context(harness.source, "background-status"))).rejects.toThrow(/Test|Sync|authoriz/i);
    expect(harness.executor.resolveDependencies).not.toHaveBeenCalled();
    expect(harness.executor.preflight).not.toHaveBeenCalled();
    expect(harness.executor.inspect).not.toHaveBeenCalled();
  });

  it("uses a successful explicit approval for an unchanged background inspection", async () => {
    const harness = await makeHarness();
    await harness.controller.inspect(harness.config, context(harness.source, "sync"));
    vi.mocked(harness.executor.resolveDependencies).mockClear();
    vi.mocked(harness.executor.preflight).mockClear();
    vi.mocked(harness.executor.inspect).mockClear();

    await harness.controller.inspect(harness.config, context(harness.source, "background-status"));

    expect(harness.executor.resolveDependencies).toHaveBeenCalledOnce();
    expect(harness.executor.preflight).toHaveBeenCalledOnce();
    expect(harness.executor.inspect).toHaveBeenCalledOnce();
    expect(harness.executor.resolveDependencies).toHaveBeenCalledWith(
      harness.config,
      expect.objectContaining({ interaction: "noninteractive" }),
      identity()
    );
  });

  it("does not trust a saved approval after controller restart or in a foreign controller", async () => {
    const harness = await makeHarness();
    await harness.controller.inspect(harness.config, context(harness.source, "sync"));
    const foreignController = createContainerlabActivationController({
      core: harness.core,
      executor: harness.executor,
      store: harness.store,
      isWorkspaceTrusted: () => true,
      confirmRun: async () => true,
      createId: () => "foreign-generation",
      now: () => 10_000
    });
    vi.mocked(harness.executor.resolveDependencies).mockClear();
    vi.mocked(harness.executor.preflight).mockClear();

    await expect(foreignController.inspect(harness.config, context(harness.source, "background-status"))).rejects.toThrow(/Test|Sync|authoriz/i);

    expect(harness.executor.resolveDependencies).not.toHaveBeenCalled();
    expect(harness.executor.preflight).not.toHaveBeenCalled();
    foreignController.dispose();
  });

  it("preserves approval across a trusted metadata-only source revision", async () => {
    const harness = await makeHarness();
    await harness.controller.inspect(harness.config, context(harness.source, "sync"));
    await harness.core.addOrUpdateInventorySource({ ...harness.source, name: "Renamed Containerlab" });
    const renamed = harness.core.getInventorySource(harness.source.id)!;
    expect(renamed.revision).not.toBe(harness.source.revision);

    await harness.controller.inspect(harness.config, context(renamed, "background-status"));

    expect(harness.executor.inspect).toHaveBeenCalledTimes(2);
  });

  it("rejects an operation context with an obsolete source revision before resolution", async () => {
    const harness = await makeHarness();
    await harness.controller.inspect(harness.config, context(harness.source, "sync"));
    await harness.core.addOrUpdateInventorySource({ ...harness.source, name: "New revision" });
    vi.mocked(harness.executor.resolveDependencies).mockClear();
    vi.mocked(harness.executor.preflight).mockClear();

    await expect(harness.controller.inspect(harness.config, context(harness.source, "background-status"))).rejects.toThrow(/revision|context/i);
    expect(harness.executor.resolveDependencies).not.toHaveBeenCalled();
    expect(harness.executor.preflight).not.toHaveBeenCalled();
  });

  it("removes source authority on deletion and does not restore it for a same-byte re-add", async () => {
    const harness = await makeHarness();
    await harness.controller.inspect(harness.config, context(harness.source, "sync"));
    await harness.core.removeInventorySource(harness.source.id, harness.source);
    await harness.core.addOrUpdateInventorySource(harness.source);
    const current = harness.core.getInventorySource(harness.source.id)!;
    vi.mocked(harness.executor.resolveDependencies).mockClear();
    vi.mocked(harness.executor.preflight).mockClear();

    await expect(harness.controller.inspect(harness.config, context(current, "background-status"))).rejects.toThrow(/Test|Sync|authoriz/i);
    expect(harness.executor.resolveDependencies).not.toHaveBeenCalled();
    expect(harness.executor.preflight).not.toHaveBeenCalled();
  });

  it("fences source revisions written directly by auth-profile deletion", async () => {
    const harness = await makeHarness({
      beforeController: async (core) => {
        await core.addOrUpdateAuthProfile({ id: "profile-1", name: "Profile", username: "netops", authType: "password" });
        const current = core.getInventorySource("source-1")!;
        await core.addOrUpdateInventorySource({ ...current, authProfileId: "profile-1" });
      }
    });
    await harness.controller.inspect(harness.config, context(harness.source, "sync"));
    await harness.core.removeAuthProfile("profile-1");
    const current = harness.core.getInventorySource(harness.source.id)!;

    await harness.controller.inspect(harness.config, context(current, "background-status"));
    expect(harness.executor.inspect).toHaveBeenCalledTimes(2);
  });

  it("fences source revisions written directly by device-template deletion", async () => {
    const harness = await makeHarness({
      beforeController: async (core) => {
        await core.addOrUpdateDeviceTemplate({ id: "template-1", name: "Template", fields: {} });
        const current = core.getInventorySource("source-1")!;
        await core.addOrUpdateInventorySource({
          ...current,
          templateRules: [{ id: "rule-1", templateId: "template-1" }]
        });
      }
    });
    await harness.controller.inspect(harness.config, context(harness.source, "sync"));
    await harness.core.removeDeviceTemplate("template-1");
    const current = harness.core.getInventorySource(harness.source.id)!;

    await harness.controller.inspect(harness.config, context(current, "background-status"));
    expect(harness.executor.inspect).toHaveBeenCalledTimes(2);
  });

  it("revokes approval before a byte-identical source replacement becomes visible", async () => {
    const harness = await makeHarness();
    await harness.controller.inspect(harness.config, context(harness.source, "sync"));
    const newRevisionVisible = deferred<void>();
    const releaseReplacement = deferred<void>();
    harness.core.onPrepareInventorySourceMutation(async (change) => {
      if (change.kind === "replace") {
        expect(harness.core.getInventorySource(harness.source.id)?.revision).toBe(harness.source.revision);
        newRevisionVisible.resolve();
        await releaseReplacement.promise;
      }
      return { commit: () => undefined, abort: () => undefined };
    });
    const replacement = harness.core.addOrUpdateInventorySource(harness.source, { forceNewActivationGeneration: true });
    await newRevisionVisible.promise;

    expect(harness.core.getInventorySource(harness.source.id)?.revision).toBe(harness.source.revision);
    releaseReplacement.resolve();
    await replacement;
    const current = harness.core.getInventorySource(harness.source.id)!;
    vi.mocked(harness.executor.resolveDependencies).mockClear();
    vi.mocked(harness.executor.preflight).mockClear();

    await expect(harness.controller.inspect(harness.config, context(current, "background-status"))).rejects.toThrow(/Test|Sync|authoriz/i);

    expect(harness.executor.resolveDependencies).not.toHaveBeenCalled();
    expect(harness.executor.preflight).not.toHaveBeenCalled();
  });

  it("does not return an inspection that finishes across a source replacement fence", async () => {
    const harness = await makeHarness();
    const inspectStarted = deferred<ContainerlabRunContext>();
    const finishInspection = deferred<void>();
    vi.mocked(harness.executor.inspect).mockImplementationOnce(async (_config, _prepared, runContext) => {
      inspectStarted.resolve(runContext);
      await finishInspection.promise;
      return { version: "0.80.0", stdout: "{}" };
    });
    const operation = harness.controller.inspect(harness.config, context(harness.source, "sync"));
    const runContext = await inspectStarted.promise;
    await harness.core.addOrUpdateInventorySource(harness.source, { forceNewActivationGeneration: true });
    expect(runContext.isCurrent()).toBe(false);
    finishInspection.resolve();

    await expect(operation).rejects.toThrow(/changed|current|source/i);
  });

  it("rejects a delayed source preparation that was superseded before publication", async () => {
    const harness = await makeHarness();
    const firstStarted = deferred<void>();
    const releaseFirst = deferred<void>();
    const secondStarted = deferred<void>();
    const releaseSecond = deferred<void>();
    let replacementCount = 0;
    harness.core.onPrepareInventorySourceMutation(async (change) => {
      if (change.kind !== "replace") return { commit: () => undefined, abort: () => undefined };
      replacementCount++;
      if (replacementCount === 1) {
        firstStarted.resolve();
        await releaseFirst.promise;
      } else {
        secondStarted.resolve();
        await releaseSecond.promise;
      }
      return { commit: () => undefined, abort: () => undefined };
    });
    const first = harness.core.addOrUpdateInventorySource(harness.source, { forceNewActivationGeneration: true });
    await firstStarted.promise;
    const second = harness.core.addOrUpdateInventorySource({ ...harness.source, name: "Second replacement" }, { forceNewActivationGeneration: true });
    await secondStarted.promise;
    releaseSecond.resolve();
    await second;
    releaseFirst.resolve();

    await expect(first).rejects.toThrow(/changed|prepared/i);
    expect(harness.core.getInventorySource(harness.source.id)?.name).toBe("Second replacement");
  });

  it("compares the complete resolved identity before background version preflight", async () => {
    const harness = await makeHarness();
    await harness.controller.inspect(harness.config, context(harness.source, "sync"));
    vi.mocked(harness.executor.preflight).mockClear();
    vi.mocked(harness.executor.inspect).mockClear();
    vi.mocked(harness.executor.resolveDependencies).mockResolvedValueOnce({
      identity: identity({ imageId: "sha256:changed" })
    });

    await expect(harness.controller.inspect(harness.config, context(harness.source, "background-status"))).rejects.toThrow(/identity|approval|changed/i);

    expect(harness.executor.preflight).not.toHaveBeenCalled();
    expect(harness.executor.inspect).not.toHaveBeenCalled();
  });

  it("does not resolve or prompt in an untrusted workspace", async () => {
    const confirmRun = vi.fn(async () => true);
    const harness = await makeHarness({ trusted: false, confirmRun });

    await expect(harness.controller.inspect(harness.config, context(harness.source, "sync"))).rejects.toThrow(/trusted/i);

    expect(confirmRun).not.toHaveBeenCalled();
    expect(harness.executor.resolveDependencies).not.toHaveBeenCalled();
    expect(harness.executor.preflight).not.toHaveBeenCalled();
  });

  it.each([
    ["missing", undefined],
    ["forged subject", { intent: "background-status", subject: { kind: "source", sourceId: "other", revision: "forged" } }],
    ["wrong subject kind", { intent: "background-status", subject: { kind: "form", sessionId: "unknown" } }]
  ] as const)("rejects %s operation context before any executor call", async (_name, operationContext) => {
    const harness = await makeHarness();

    await expect(harness.controller.inspect(harness.config, operationContext as InventoryOperationContext | undefined)).rejects.toThrow();

    expect(harness.executor.resolveDependencies).not.toHaveBeenCalled();
    expect(harness.executor.preflight).not.toHaveBeenCalled();
  });

  it("rejects a changed source intent before background preflight", async () => {
    const harness = await makeHarness();
    await harness.controller.inspect(harness.config, context(harness.source, "sync"));
    const changedValues = { ...harness.source.config, dockerSocket: "/run/docker-alt.sock" };
    await harness.core.addOrUpdateInventorySource({ ...harness.source, config: changedValues });
    const current = harness.core.getInventorySource(harness.source.id)!;
    vi.mocked(harness.executor.resolveDependencies).mockClear();
    vi.mocked(harness.executor.preflight).mockClear();

    await expect(
      harness.controller.inspect(parseContainerlabConfig(current.config), context(current, "background-status"))
    ).rejects.toThrow(/Test|Sync|changed|authoriz/i);

    expect(harness.executor.resolveDependencies).not.toHaveBeenCalled();
    expect(harness.executor.preflight).not.toHaveBeenCalled();
  });

  it("captures one remote host and dependency identity before asynchronous resolution", async () => {
    const harness = await makeHarness();
    await harness.core.addOrUpdateServer(sshServer("lab-host", "lab.example.test", { type: "ssh", jumpHostId: "jump-host" }));
    await harness.core.addOrUpdateServer(sshServer("jump-host", "jump.example.test"));
    await harness.core.addOrUpdateInventorySource(makeSource(REMOTE_VALUES, { id: "remote-source" }));
    const source = harness.core.getInventorySource("remote-source")!;
    const config = parseContainerlabConfig(source.config);
    const enteredResolution = deferred<ContainerlabRunContext>();
    const continueResolution = deferred<void>();
    vi.mocked(harness.executor.resolveDependencies).mockImplementationOnce(async (_config, runContext) => {
      enteredResolution.resolve(runContext);
      await continueResolution.promise;
      return { identity: identity({ location: "ssh", routeIdentity: JSON.stringify([["lab-host"]]) }) };
    });
    const operation = harness.controller.inspect(config, context(source, "sync"));
    const runContext = await enteredResolution.promise;

    expect(runContext.labHost).toMatchObject({ id: "lab-host", host: "lab.example.test" });
    expect(runContext.labHostRouteIdentity).toBeTypeOf("string");
    await harness.core.addOrUpdateServer(sshServer("jump-host", "new-jump.example.test"));
    expect(runContext.isCurrent()).toBe(false);
    continueResolution.resolve();

    await expect(operation).rejects.toThrow(/changed|current|route/i);
    expect(harness.executor.preflight).not.toHaveBeenCalled();
    expect(harness.executor.inspect).not.toHaveBeenCalled();
  });

  it("rejects a changed deep jump hop captured before approval-store loading", async () => {
    const state = deferred<unknown>();
    const store = memoryStore();
    store.load.mockReturnValueOnce(state.promise);
    const confirmRun = vi.fn(async () => true);
    const harness = await makeHarness({
      store,
      confirmRun,
      beforeController: async (core) => {
        await core.addOrUpdateServer(sshServer("lab-host", "lab.example.test", { type: "ssh", jumpHostId: "jump-host" }));
        await core.addOrUpdateServer(sshServer("jump-host", "jump.example.test"));
        await core.addOrUpdateInventorySource(makeSource(REMOTE_VALUES, { id: "remote-source" }));
      }
    });
    const source = harness.core.getInventorySource("remote-source")!;
    const operation = harness.controller.inspect(parseContainerlabConfig(source.config), context(source, "sync"));
    await harness.core.addOrUpdateServer(sshServer("jump-host", "changed-jump.example.test"));
    state.resolve(undefined);

    await expect(operation).rejects.toThrow(/changed|current|route/i);
    expect(confirmRun).not.toHaveBeenCalled();
    expect(harness.executor.resolveDependencies).not.toHaveBeenCalled();
    expect(harness.executor.preflight).not.toHaveBeenCalled();
  });

  it("rejects a source replaced while approval state is still loading", async () => {
    const state = deferred<unknown>();
    const store = memoryStore();
    store.load.mockReturnValueOnce(state.promise);
    const confirmRun = vi.fn(async () => true);
    const harness = await makeHarness({ store, confirmRun });
    const operation = harness.controller.inspect(harness.config, context(harness.source, "sync"));
    const replacement = harness.core.addOrUpdateInventorySource(harness.source, { forceNewActivationGeneration: true });
    state.resolve(undefined);
    await replacement;

    await expect(operation).rejects.toThrow(/changed|current|source/i);
    expect(confirmRun).not.toHaveBeenCalled();
    expect(harness.executor.resolveDependencies).not.toHaveBeenCalled();
    expect(harness.executor.preflight).not.toHaveBeenCalled();
  });

  it("does not grant approval from a save that completes after source revocation", async () => {
    const store = memoryStore();
    const staleSave = deferred<void>();
    store.save.mockImplementationOnce(async () => staleSave.promise);
    const harness = await makeHarness({ store });
    const operation = harness.controller.inspect(harness.config, context(harness.source, "sync"));
    while (vi.mocked(harness.executor.preflight).mock.calls.length === 0) await Promise.resolve();
    await Promise.resolve();
    const replacement = harness.core.addOrUpdateInventorySource(harness.source, { forceNewActivationGeneration: true });
    staleSave.resolve();

    await expect(operation).rejects.toThrow(/changed|current|source|approval/i);
    await replacement;
    vi.mocked(harness.executor.resolveDependencies).mockClear();
    vi.mocked(harness.executor.preflight).mockClear();
    await expect(
      harness.controller.inspect(harness.config, context(harness.core.getInventorySource(harness.source.id)!, "background-status"))
    ).rejects.toThrow(/Test|Sync|authoriz/i);
    expect(harness.executor.resolveDependencies).not.toHaveBeenCalled();
    expect(harness.executor.preflight).not.toHaveBeenCalled();
  });

  it("passes the deep-route current guard through asynchronous SSH acquisition", async () => {
    const harness = await makeHarness();
    await harness.core.addOrUpdateServer(sshServer("lab-host", "lab.example.test", { type: "ssh", jumpHostId: "jump-host" }));
    await harness.core.addOrUpdateServer(sshServer("jump-host", "jump.example.test"));
    await harness.core.addOrUpdateInventorySource(makeSource(REMOTE_VALUES, { id: "remote-source" }));
    const source = harness.core.getInventorySource("remote-source")!;
    const acquisition = deferred<void>();
    const enteredAcquisition = deferred<ContainerlabRunContext>();
    const channelExecutions = vi.fn();
    vi.mocked(harness.executor.resolveDependencies).mockImplementationOnce(async (_config, runContext) => {
      enteredAcquisition.resolve(runContext);
      await acquisition.promise;
      if (!runContext.isCurrent()) throw new Error("Containerlab route changed during SSH acquisition.");
      channelExecutions();
      return { identity: identity({ location: "ssh", routeIdentity: runContext.labHostRouteIdentity }) };
    });
    const operation = harness.controller.inspect(parseContainerlabConfig(source.config), context(source, "sync"));
    const runContext = await enteredAcquisition.promise;
    await harness.core.addOrUpdateServer(sshServer("jump-host", "changed-jump.example.test"));

    expect(runContext.isCurrent()).toBe(false);
    acquisition.resolve();
    await expect(operation).rejects.toThrow(/changed|current|route/i);
    expect(channelExecutions).not.toHaveBeenCalled();
    expect(harness.executor.preflight).not.toHaveBeenCalled();
    expect(harness.executor.inspect).not.toHaveBeenCalled();
  });

  it.each([
    { runner: "host", reference: "", runnerMetadata: "Host mode uses no image/container metadata command.", mount: "Host mode creates no helper or container socket mount." },
    {
      runner: "disposable",
      reference: "example.test/clab:fixed",
      runnerMetadata: ["/opt/custom/docker", "--host", "unix:///run/custom.sock", "image", "inspect", "--format", "{{.Id}}", "example.test/clab:fixed"],
      mount: 'Creates a temporary helper with a new read/write bind from "/run/custom.sock" to "/var/run/docker.sock".'
    },
    {
      runner: "existing",
      reference: "clab-existing",
      runnerMetadata: ["/opt/custom/docker", "--host", "unix:///run/custom.sock", "container", "inspect", "--format", "{{json .}}", "clab-existing"],
      mount: 'Requires the existing container to have a read/write bind from "/run/custom.sock" to "/var/run/docker.sock"; discovery does not create this mount.'
    }
  ] as const)("discloses the exact $runner execution scope before Run", async ({ runner, reference, runnerMetadata, mount }) => {
    const values: InventorySourceValues = {
      ...REMOTE_VALUES,
      runner,
      containerlabExecutable: "/opt/custom/clab",
      dockerExecutable: "/opt/custom/docker",
      dockerSocket: "/run/custom.sock",
      sudo: true,
      ...(runner === "disposable" ? { runnerImage: reference } : {}),
      ...(runner === "existing" ? { runnerContainer: reference } : {})
    };
    const descriptions: string[] = [];
    const harness = await makeHarness({
      confirmRun: async (description) => { descriptions.push(description); return false; },
      beforeController: async (core) => {
        await core.addOrUpdateServer({ ...sshServer("lab-host", "lab.example.test"), name: "Lab\nhost" });
        await core.addOrUpdateInventorySource(makeSource(values, { id: "source-1" }));
      }
    });

    await expect(harness.controller.inspect(harness.config, context(harness.source, "test"))).rejects.toThrow(/canceled/i);

    expect(descriptions).toHaveLength(1);
    const description = descriptions[0];
    const shownArgv = (args: readonly string[]) => `[${args.map((arg) => JSON.stringify(arg)).join(", ")}]`;
    expect(description).toContain('SSH host "Lab host"');
    expect(description).toContain('Configured Docker executable: "/opt/custom/docker".');
    expect(description).toContain("/opt/custom/clab");
    expect(description).toContain("/run/custom.sock");
    expect(description).toContain(`Selected Docker daemon info argv: ${shownArgv([
      "/opt/custom/docker", "--host", "unix:///run/custom.sock", "info", "--format", "{{json .}}"
    ])}`);
    expect(description).toContain(`Selected runner metadata: ${typeof runnerMetadata === "string" ? runnerMetadata : shownArgv(runnerMetadata)}`);
    expect(description).toContain(`Containerlab version preflight argv: ${shownArgv(["/opt/custom/clab", ...CONTAINERLAB_VERSION_ARGS])}`);
    expect(description).toContain(`Detailed inspection argv: ${shownArgv(["/opt/custom/clab", ...CONTAINERLAB_INSPECT_ARGS])}`);
    if (reference) expect(description).toContain(reference);
    const runnerDisclosure = runner === "host"
      ? 'host mode runs configured Containerlab executable "/opt/custom/clab" directly'
      : `${runner === "disposable" ? 'disposable Docker image "example.test/clab:fixed"' : 'existing Docker container "clab-existing"'} runs configured Containerlab executable "/opt/custom/clab"`;
    expect(description).toContain(`Runner: ${runnerDisclosure}.`);
    expect(description).toContain(mount);
    expect(description).toMatch(/noninteractive sudo/i);
    expect(description).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/u);
    if (runner === "host") expect(description).not.toMatch(/Creates a temporary helper|Requires the existing container/i);
    expect(harness.executor.resolveDependencies).not.toHaveBeenCalled();
    expect(harness.executor.preflight).not.toHaveBeenCalled();
    expect(harness.executor.inspect).not.toHaveBeenCalled();
  });

  it("fails closed when approval state cannot be read or written", async () => {
    const unreadable = memoryStore();
    unreadable.load.mockRejectedValueOnce(new Error("approval state unavailable"));
    const first = await makeHarness({ store: unreadable });

    await expect(first.controller.inspect(first.config, context(first.source, "sync"))).rejects.toThrow(/approval|state|available/i);
    expect(first.executor.resolveDependencies).not.toHaveBeenCalled();
    expect(first.executor.preflight).not.toHaveBeenCalled();
    expect(first.executor.inspect).not.toHaveBeenCalled();

    const unwritable = memoryStore();
    unwritable.save.mockRejectedValueOnce(new Error("approval state read only"));
    const second = await makeHarness({ store: unwritable });

    await expect(second.controller.inspect(second.config, context(second.source, "sync"))).rejects.toThrow(/approval|state|read only/i);
    expect(second.executor.preflight).toHaveBeenCalledOnce();
    expect(second.executor.inspect).not.toHaveBeenCalled();
  });

  it("keeps unrelated provider writes and reference clearing independent of a failed approval store", async () => {
    const store = memoryStore();
    store.load.mockRejectedValueOnce(new Error("approval state unavailable"));
    const templatedSource = makeSource({ baseUrl: "https://netbox.example.test" }, {
      id: "netbox-template-source",
      providerId: "netbox",
      templateRules: [{ id: "rule-1", templateId: "template-1", filter: "role=core" }]
    });
    const harness = await makeHarness({
      store,
      beforeController: async (core) => {
        await core.addOrUpdateDeviceTemplate({ id: "template-1", name: "Template", fields: {} });
        await core.addOrUpdateInventorySource(templatedSource);
      }
    });

    await expect(harness.controller.inspect(harness.config, context(harness.source, "sync")))
      .rejects.toThrow(/approval state unavailable/i);
    expect(store.load).toHaveBeenCalledOnce();

    await harness.core.addOrUpdateInventorySource(makeSource({ baseUrl: "https://netbox.example.test" }, {
      id: "netbox-unrelated",
      providerId: "netbox"
    }));
    const created = harness.core.getInventorySource("netbox-unrelated")!;
    await harness.core.addOrUpdateInventorySource({
      ...created,
      config: { baseUrl: "https://renamed.example.test" }
    });
    await harness.core.addOrUpdateInventorySource({
      ...harness.core.getInventorySource(created.id)!,
      name: "Renamed NetBox"
    });
    await harness.core.removeInventorySource(created.id);
    await harness.core.removeDeviceTemplate("template-1");

    expect(harness.core.getInventorySource(templatedSource.id)?.templateRules).toEqual([]);
    expect(store.load).toHaveBeenCalledOnce();
    expect(store.save).not.toHaveBeenCalled();
  });

  it("does not let a rejecting Containerlab approval save block an unrelated source creation", async () => {
    const store = memoryStore();
    store.save.mockRejectedValueOnce(new Error("approval disk unavailable"));
    const harness = await makeHarness({ store });

    await harness.core.addOrUpdateInventorySource(makeSource({ baseUrl: "https://netbox.example.test" }, {
      id: "netbox-after-save-failure",
      providerId: "netbox"
    }));

    expect(harness.core.getInventorySource("netbox-after-save-failure")).toMatchObject({ providerId: "netbox" });
    expect(store.load).not.toHaveBeenCalled();
    expect(store.save).not.toHaveBeenCalled();
  });

  it("does not let an unrelated create or delete preserve a pending Containerlab Add association", async () => {
    const harness = await makeHarness();
    const sessionId = harness.controller.beginFormSession();
    harness.controller.updateFormSession(sessionId, harness.source.config);
    await harness.controller.inspect(harness.config, { intent: "test", subject: { kind: "form", sessionId } });
    vi.mocked(harness.executor.resolveDependencies).mockClear();
    vi.mocked(harness.executor.preflight).mockClear();
    vi.mocked(harness.executor.inspect).mockClear();
    const cleanup = harness.controller.prepareFormSourceSave(sessionId, "reused-source-id");
    try {
      await harness.core.addOrUpdateInventorySource(makeSource({ baseUrl: "https://netbox.example.test" }, {
        id: "reused-source-id",
        providerId: "netbox"
      }));
      await harness.core.removeInventorySource("reused-source-id");
      await harness.core.addOrUpdateInventorySource(makeSource(LOCAL_VALUES, { id: "reused-source-id" }));
      const replacement = harness.core.getInventorySource("reused-source-id")!;

      await expect(harness.controller.transferFormApproval(sessionId, replacement)).rejects.toThrow(/save|approval|transfer/i);
      await expect(harness.controller.inspect(harness.config, context(replacement, "background-status")))
        .rejects.toThrow(/Test|Sync|approv/i);
      expect(harness.executor.resolveDependencies).not.toHaveBeenCalled();
      expect(harness.executor.preflight).not.toHaveBeenCalled();
      expect(harness.executor.inspect).not.toHaveBeenCalled();
    } finally {
      cleanup();
    }
  });

  it("does not restore an approval across transitions away from and back to Containerlab", async () => {
    const harness = await makeHarness();
    await harness.controller.inspect(harness.config, context(harness.source, "sync"));
    const opened = harness.core.getInventorySource(harness.source.id)!;

    await harness.core.addOrUpdateInventorySource({
      ...opened,
      providerId: "netbox",
      config: { baseUrl: "https://netbox.example.test" }
    });
    await harness.core.addOrUpdateInventorySource({
      ...harness.core.getInventorySource(opened.id)!,
      providerId: "containerlab",
      config: opened.config
    });
    const returned = harness.core.getInventorySource(opened.id)!;

    vi.mocked(harness.executor.resolveDependencies).mockClear();
    vi.mocked(harness.executor.preflight).mockClear();
    vi.mocked(harness.executor.inspect).mockClear();
    await expect(harness.controller.inspect(harness.config, context(returned, "background-status")))
      .rejects.toThrow(/Test|Sync|approv/i);
    expect(harness.executor.resolveDependencies).not.toHaveBeenCalled();
    expect(harness.executor.preflight).not.toHaveBeenCalled();
    expect(harness.executor.inspect).not.toHaveBeenCalled();
  });

  it("transfers only the current tested form approval to an exact saved source", async () => {
    const harness = await makeHarness();
    const sessionId = harness.controller.beginFormSession();
    harness.controller.updateFormSession(sessionId, harness.source.config);
    const formContext: InventoryOperationContext = {
      intent: "test",
      subject: { kind: "form", sessionId }
    };
    await harness.controller.inspect(harness.config, formContext);
    const finishCreation = harness.controller.prepareFormSourceSave(sessionId, "form-created-source");
    try {
      await harness.core.addOrUpdateInventorySource(makeSource(harness.source.config, { id: "form-created-source" }));
    } finally {
      finishCreation();
    }
    const saved = harness.core.getInventorySource("form-created-source")!;

    await harness.controller.transferFormApproval(sessionId, saved);
    await harness.controller.inspect(harness.config, context(saved, "background-status"));
    expect(harness.executor.inspect).toHaveBeenCalledTimes(2);
    await expect(harness.controller.transferFormApproval(sessionId, saved)).rejects.toThrow(/transfer|consum|save/i);
  });

  it("does not transfer a form approval to a forced import that reuses the prepared Add ID", async () => {
    const harness = await makeHarness();
    const sessionId = harness.controller.beginFormSession();
    harness.controller.updateFormSession(sessionId, harness.source.config);
    await harness.controller.inspect(harness.config, { intent: "test", subject: { kind: "form", sessionId } });
    const cleanup = harness.controller.prepareFormSourceSave(sessionId, "imported-source");
    try {
      await harness.core.addOrUpdateInventorySource(makeSource(harness.source.config, { id: "imported-source" }), {
        forceNewActivationGeneration: true
      });
    } finally {
      cleanup();
    }

    const imported = harness.core.getInventorySource("imported-source")!;
    await expect(harness.controller.transferFormApproval(sessionId, imported)).rejects.toThrow(/transfer|save|approval/i);
    vi.mocked(harness.executor.resolveDependencies).mockClear();
    vi.mocked(harness.executor.preflight).mockClear();
    vi.mocked(harness.executor.inspect).mockClear();
    await expect(harness.controller.inspect(harness.config, context(imported, "background-status"))).rejects.toThrow(/approv/i);
    expect(harness.executor.resolveDependencies).not.toHaveBeenCalled();
    expect(harness.executor.preflight).not.toHaveBeenCalled();
    expect(harness.executor.inspect).not.toHaveBeenCalled();
  });

  it("cannot prepare Add transfer to an existing source or transfer unrelated values", async () => {
    const harness = await makeHarness();
    const sessionId = harness.controller.beginFormSession();
    harness.controller.updateFormSession(sessionId, harness.source.config);
    await harness.controller.inspect(harness.config, { intent: "test", subject: { kind: "form", sessionId } });

    expect(() => harness.controller.prepareFormSourceSave(sessionId, harness.source.id)).toThrow(/exist|Add|Edit/i);
    const cleanup = harness.controller.prepareFormSourceSave(sessionId, "unrelated-source");
    try {
      await harness.core.addOrUpdateInventorySource(makeSource({ ...harness.source.config, sudo: true }, { id: "unrelated-source" }));
    } finally {
      cleanup();
    }

    await expect(
      harness.controller.transferFormApproval(sessionId, harness.core.getInventorySource("unrelated-source")!)
    ).rejects.toThrow(/intent|tested|config|approval/i);
  });

  it("transfers an Edit test only to the exact unchanged source opened by that form", async () => {
    const harness = await makeHarness();
    const opened = harness.core.getInventorySource(harness.source.id)!;
    await harness.controller.inspect(harness.config, context(opened, "sync"));
    const sessionId = harness.controller.beginFormSession({ sourceId: opened.id, revision: opened.revision! });
    harness.controller.updateFormSession(sessionId, opened.config);
    await harness.controller.inspect(harness.config, { intent: "test", subject: { kind: "form", sessionId } });
    const cleanup = harness.controller.prepareFormSourceSave(sessionId, opened.id);
    try {
      await harness.core.addOrUpdateInventorySource({ ...opened, name: "Edited Containerlab" });
    } finally {
      cleanup();
    }
    const saved = harness.core.getInventorySource(opened.id)!;

    await harness.controller.transferFormApproval(sessionId, saved);
    await harness.controller.inspect(harness.config, context(saved, "background-status"));
    expect(harness.executor.inspect).toHaveBeenCalledTimes(3);
  });

  it("rejects Edit transfer after a same-byte replacement since the form opened", async () => {
    const harness = await makeHarness();
    const opened = harness.core.getInventorySource(harness.source.id)!;
    const sessionId = harness.controller.beginFormSession({ sourceId: opened.id, revision: opened.revision! });
    harness.controller.updateFormSession(sessionId, opened.config);
    await harness.controller.inspect(harness.config, { intent: "test", subject: { kind: "form", sessionId } });
    await harness.core.addOrUpdateInventorySource(opened, { forceNewActivationGeneration: true });

    expect(() => harness.controller.prepareFormSourceSave(sessionId, opened.id)).toThrow(/changed|current|revision/i);
    await expect(
      harness.controller.transferFormApproval(sessionId, harness.core.getInventorySource(opened.id)!)
    ).rejects.toThrow(/transfer|save|creation/i);
  });

  it("does not transfer an Edit association consumed by a replacement hook", async () => {
    const harness = await makeHarness();
    const opened = harness.core.getInventorySource(harness.source.id)!;
    const sessionId = harness.controller.beginFormSession({ sourceId: opened.id, revision: opened.revision! });
    harness.controller.updateFormSession(sessionId, opened.config);
    await harness.controller.inspect(harness.config, { intent: "test", subject: { kind: "form", sessionId } });
    const cleanup = harness.controller.prepareFormSourceSave(sessionId, opened.id);
    try {
      await harness.core.addOrUpdateInventorySource(opened, { forceNewActivationGeneration: true });
    } finally {
      cleanup();
    }

    await expect(
      harness.controller.transferFormApproval(sessionId, harness.core.getInventorySource(opened.id)!)
    ).rejects.toThrow(/transfer|save|creation/i);
  });

  it("does not transfer a form approval after its one-shot target is replaced or closed", async () => {
    const harness = await makeHarness();
    const sessionId = harness.controller.beginFormSession();
    harness.controller.updateFormSession(sessionId, harness.source.config);
    await harness.controller.inspect(harness.config, { intent: "test", subject: { kind: "form", sessionId } });
    const cleanup = harness.controller.prepareFormSourceSave(sessionId, "replaced-source");
    await harness.core.addOrUpdateInventorySource(makeSource(harness.source.config, { id: "replaced-source" }));
    cleanup();
    await harness.core.addOrUpdateInventorySource(makeSource(harness.source.config, { id: "replaced-source" }), { forceNewActivationGeneration: true });

    await expect(
      harness.controller.transferFormApproval(sessionId, harness.core.getInventorySource("replaced-source")!)
    ).rejects.toThrow(/replace|generation|save|current/i);

    const secondSession = harness.controller.beginFormSession();
    harness.controller.updateFormSession(secondSession, harness.source.config);
    await harness.controller.inspect(harness.config, { intent: "test", subject: { kind: "form", sessionId: secondSession } });
    const secondCleanup = harness.controller.prepareFormSourceSave(secondSession, "closed-source");
    await harness.core.addOrUpdateInventorySource(makeSource(harness.source.config, { id: "closed-source" }));
    secondCleanup();
    harness.controller.endFormSession(secondSession);
    await expect(
      harness.controller.transferFormApproval(secondSession, harness.core.getInventorySource("closed-source")!)
    ).rejects.toThrow(/form|session|closed|save/i);
  });

  it("does not transfer a staged Add approval after its tested form values change", async () => {
    const harness = await makeHarness();
    const sessionId = harness.controller.beginFormSession();
    harness.controller.updateFormSession(sessionId, harness.source.config);
    await harness.controller.inspect(harness.config, {
      intent: "test",
      subject: { kind: "form", sessionId }
    });
    const cleanup = harness.controller.prepareFormSourceSave(sessionId, "changed-form-source");
    try {
      await harness.core.addOrUpdateInventorySource(makeSource(harness.source.config, { id: "changed-form-source" }));
    } finally {
      cleanup();
    }
    const saved = harness.core.getInventorySource("changed-form-source")!;

    vi.mocked(harness.executor.resolveDependencies).mockClear();
    vi.mocked(harness.executor.preflight).mockClear();
    vi.mocked(harness.executor.inspect).mockClear();
    harness.controller.updateFormSession(sessionId, { ...harness.source.config, sudo: true });

    await expect(harness.controller.transferFormApproval(sessionId, saved)).rejects.toThrow(/changed|tested|approval|save/i);
    await expect(
      harness.controller.inspect(harness.config, context(saved, "background-status"))
    ).rejects.toThrow(/Test|Sync|approv/i);
    expect(harness.executor.resolveDependencies).not.toHaveBeenCalled();
    expect(harness.executor.preflight).not.toHaveBeenCalled();
    expect(harness.executor.inspect).not.toHaveBeenCalled();
  });

  it("does not transfer a staged Add approval after its SSH dependency chain changes", async () => {
    const harness = await makeHarness({
      beforeController: async (core) => {
        await core.addOrUpdateServer(sshServer("lab-host", "lab.example.test", { type: "ssh", jumpHostId: "jump-host" }));
        await core.addOrUpdateServer(sshServer("jump-host", "jump.example.test"));
        await core.addOrUpdateInventorySource(makeSource(REMOTE_VALUES, { id: "source-1" }));
      }
    });
    vi.mocked(harness.executor.resolveDependencies).mockImplementation(async (_config, runContext) => ({
      identity: identity({ location: "ssh", routeIdentity: runContext.labHostRouteIdentity! })
    }));
    const sessionId = harness.controller.beginFormSession();
    harness.controller.updateFormSession(sessionId, harness.source.config);
    await harness.controller.inspect(parseContainerlabConfig(harness.source.config), {
      intent: "test",
      subject: { kind: "form", sessionId }
    });
    const cleanup = harness.controller.prepareFormSourceSave(sessionId, "remote-form-source");
    try {
      await harness.core.addOrUpdateInventorySource(makeSource(harness.source.config, { id: "remote-form-source" }));
    } finally {
      cleanup();
    }
    const saved = harness.core.getInventorySource("remote-form-source")!;

    vi.mocked(harness.executor.resolveDependencies).mockClear();
    vi.mocked(harness.executor.preflight).mockClear();
    vi.mocked(harness.executor.inspect).mockClear();
    await harness.core.addOrUpdateServer(sshServer("jump-host", "changed-jump.example.test"));

    await expect(harness.controller.transferFormApproval(sessionId, saved)).rejects.toThrow(/SSH dependencies|changed/i);
    await expect(harness.controller.inspect(parseContainerlabConfig(saved.config), context(saved, "background-status")))
      .rejects.toThrow(/Test|Sync|approv/i);
    expect(harness.executor.resolveDependencies).not.toHaveBeenCalled();
    expect(harness.executor.preflight).not.toHaveBeenCalled();
    expect(harness.executor.inspect).not.toHaveBeenCalled();
  });

  it("checks form authority again after a staged transfer save completes", async () => {
    const harness = await makeHarness();
    const sessionId = harness.controller.beginFormSession();
    harness.controller.updateFormSession(sessionId, harness.source.config);
    await harness.controller.inspect(harness.config, { intent: "test", subject: { kind: "form", sessionId } });
    const cleanup = harness.controller.prepareFormSourceSave(sessionId, "held-transfer-source");
    try {
      await harness.core.addOrUpdateInventorySource(makeSource(harness.source.config, { id: "held-transfer-source" }));
    } finally {
      cleanup();
    }
    const saved = harness.core.getInventorySource("held-transfer-source")!;
    const saveEntered = deferred<void>();
    const releaseSave = deferred<void>();
    const saveNormally = harness.store.save.getMockImplementation()!;
    harness.store.save.mockClear();
    harness.store.save.mockImplementationOnce(async (document: unknown) => {
      saveEntered.resolve();
      await releaseSave.promise;
      await saveNormally(document);
    });
    vi.mocked(harness.executor.resolveDependencies).mockClear();
    vi.mocked(harness.executor.preflight).mockClear();
    vi.mocked(harness.executor.inspect).mockClear();

    const transfer = harness.controller.transferFormApproval(sessionId, saved);
    await saveEntered.promise;
    harness.controller.updateFormSession(sessionId, { ...harness.source.config, sudo: true });
    releaseSave.resolve();

    await expect(transfer).rejects.toThrow(/changed|form|source/i);
    await expect(harness.controller.inspect(harness.config, context(saved, "background-status"))).rejects.toThrow(/Test|Sync|approv/i);
    expect(harness.executor.resolveDependencies).not.toHaveBeenCalled();
    expect(harness.executor.preflight).not.toHaveBeenCalled();
    expect(harness.executor.inspect).not.toHaveBeenCalled();
  });
});
