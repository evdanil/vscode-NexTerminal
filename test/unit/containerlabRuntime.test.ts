import { describe, expect, it, vi } from "vitest";
import type { ServerConfig } from "../../src/models/config";
import { parseContainerlabConfig } from "../../src/services/inventory/providers/containerlabConfig";
import type {
  ContainerlabCommand,
  ContainerlabCommandResult,
  ContainerlabCommandRunner,
  ContainerlabExecutionIdentity,
  ContainerlabLocalExecutableFileSystem,
  ContainerlabRunContext
} from "../../src/services/inventory/containerlabRuntimeContracts";
import { createContainerlabExecutor } from "../../src/services/inventory/containerlabRuntime";

const labHost = { id: "lab-host-profile", name: "lab", host: "lab.example", port: 22, username: "u", authType: "password", isHidden: false } as unknown as ServerConfig;

function context(location: "local" | "ssh" = "local", overrides: Partial<ContainerlabRunContext> = {}): ContainerlabRunContext {
  return {
    interaction: "noninteractive",
    signal: new AbortController().signal,
    deadline: Date.now() + 30_000,
    ...(location === "ssh" ? { labHost, labHostRouteIdentity: "captured-route-a" } : {}),
    isCurrent: () => true,
    ...overrides
  };
}

function config(values: Record<string, string | boolean> = {}) {
  return parseContainerlabConfig({
    runner: "host",
    containerlabExecutable: "/bin/true",
    dockerExecutable: "/bin/true",
    ...values
  });
}

function remoteConfig(values: Record<string, string | boolean> = {}) {
  return config({
    location: "ssh",
    labHostId: labHost.id,
    containerlabExecutable: "/remote/containerlab",
    dockerExecutable: "/remote/docker",
    ...values
  });
}

function commandRunner(respond: (command: ContainerlabCommand) => ContainerlabCommandResult | Promise<ContainerlabCommandResult>) {
  const calls: ContainerlabCommand[] = [];
  const runner: ContainerlabCommandRunner = {
    async run(command) {
      calls.push(command);
      return respond(command);
    }
  };
  return { runner, calls };
}

function executionIdentity(overrides: Partial<ContainerlabExecutionIdentity> = {}): ContainerlabExecutionIdentity {
  return {
    executable: "/usr/bin/containerlab",
    dockerExecutable: "/usr/bin/docker",
    dockerSocket: "/var/run/docker.sock",
    location: "ssh",
    sudo: false,
    routeIdentity: "captured-route-a",
    ...overrides
  };
}

const imageId = `sha256:${"a".repeat(64)}`;
const containerId = "b".repeat(64);

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 10; index += 1) await Promise.resolve();
}

function metadataResponse(command: ContainerlabCommand): ContainerlabCommandResult {
  if (command.executable === "/bin/sh") {
    if (command.args[0] !== "-c" || command.args[2] !== "nexus-containerlab-resolve") {
      throw new Error(`Unexpected remote command: ${command.args.join(" ")}`);
    }
    const requested = command.args[3];
    if (requested === "/remote/containerlab") return { stdout: "/remote/containerlab\n", stderr: "" };
    if (requested === "/remote/docker") return { stdout: "/remote/docker\n", stderr: "" };
    throw new Error(`Unexpected remote executable request: ${String(requested)}`);
  }
  if (command.args.includes("info")) {
    return { stdout: JSON.stringify({ OSType: "linux", SecurityOptions: ["name=seccomp,profile=builtin"] }), stderr: "" };
  }
  if (command.args.includes("image")) return { stdout: imageId, stderr: "" };
  if (command.args.includes("container") && command.args.includes("inspect")) {
    return {
      stdout: JSON.stringify({
        Id: containerId,
        Name: "/runner",
        State: { Running: true },
        Mounts: [{ Type: "bind", Source: "/run/docker.sock", Destination: "/var/run/docker.sock", RW: true }]
      }),
      stderr: ""
    };
  }
  if (command.args.includes("version")) return { stdout: "    version: 0.80.0\n", stderr: "" };
  if (command.args.includes("--format") && command.args.includes("json")) return { stdout: "{\"nodes\":[]}", stderr: "" };
  throw new Error(`Unexpected runtime command: ${command.executable} ${command.args.join(" ")}`);
}

describe("Containerlab runtime execution", () => {
  it("rejects a missing SSH route identity before acquiring a runner", async () => {
    const remote = commandRunner(() => ({ stdout: "/usr/bin/containerlab\n", stderr: "" }));
    const executor = createContainerlabExecutor({ localRunner: remote.runner, sshRunner: remote.runner });

    await expect(executor.resolveDependencies(remoteConfig(), context("ssh", {
      labHostRouteIdentity: undefined
    }))).rejects.toThrow(/route identity/i);
    expect(remote.calls).toHaveLength(0);
  });

  it.each([
    ["blank route", { labHostRouteIdentity: "   " }],
    ["wrong lab host", { labHost: { ...labHost, id: "other-host" } }]
  ] as const)("rejects an SSH context with %s before acquiring a runner", async (_label, overrides) => {
    const remote = commandRunner(() => ({ stdout: "/usr/bin/containerlab\n", stderr: "" }));
    const executor = createContainerlabExecutor({ localRunner: remote.runner, sshRunner: remote.runner });

    await expect(executor.resolveDependencies(
      remoteConfig(), context("ssh", overrides)
    )).rejects.toThrow(/host|route/i);
    expect(remote.calls).toHaveLength(0);
  });

  it("bounds a stalled local realpath by the absolute deadline and ignores late completion", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const realpath = deferred<string>();
    const fileSystem: ContainerlabLocalExecutableFileSystem = {
      realpath: vi.fn(() => realpath.promise),
      stat: vi.fn(async () => ({ isFile: () => true })),
      access: vi.fn(async () => {})
    };
    const local = commandRunner(metadataResponse);
    const executor = createContainerlabExecutor({ localRunner: local.runner, sshRunner: local.runner, localFileSystem: fileSystem });
    const pending = executor.resolveDependencies(config(), context("local", { deadline: 50 }));
    let outcome: { status: "resolved" } | { status: "rejected"; error: unknown } | undefined;
    void pending.then(
      () => { outcome = { status: "resolved" }; },
      (error: unknown) => { outcome = { status: "rejected", error }; }
    );
    try {
      await flushMicrotasks();
      expect(fileSystem.realpath).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(50);
      await flushMicrotasks();
      expect(outcome?.status).toBe("rejected");
      if (outcome?.status === "rejected") {
        expect(outcome.error).toMatchObject({ message: expect.stringMatching(/cancelled, timed out, or is no longer current/i) });
      }
      realpath.resolve("/bin/true");
      await flushMicrotasks();
      expect(fileSystem.access).not.toHaveBeenCalled();
      expect(local.calls).toHaveLength(0);
    } finally {
      realpath.resolve("/bin/true");
      await flushMicrotasks();
      vi.useRealTimers();
    }
  });

  it("stops a stalled local stat immediately on abort and consumes late rejection", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const stat = deferred<{ isFile(): boolean }>();
    const fileSystem: ContainerlabLocalExecutableFileSystem = {
      realpath: vi.fn(async () => "/bin/true"),
      stat: vi.fn(() => stat.promise),
      access: vi.fn(async () => {})
    };
    const local = commandRunner(metadataResponse);
    const executor = createContainerlabExecutor({ localRunner: local.runner, sshRunner: local.runner, localFileSystem: fileSystem });
    const controller = new AbortController();
    const pending = executor.resolveDependencies(config(), context("local", {
      signal: controller.signal,
      deadline: 1_000
    }));
    let outcome: { status: "resolved" } | { status: "rejected"; error: unknown } | undefined;
    void pending.then(
      () => { outcome = { status: "resolved" }; },
      (error: unknown) => { outcome = { status: "rejected", error }; }
    );
    try {
      await flushMicrotasks();
      expect(fileSystem.stat).toHaveBeenCalledTimes(1);
      controller.abort(new Error("test cancellation"));
      await flushMicrotasks();
      expect(outcome?.status).toBe("rejected");
      if (outcome?.status === "rejected") {
        expect(outcome.error).toMatchObject({ message: expect.stringMatching(/cancelled, timed out, or is no longer current/i) });
      }
      stat.reject(new Error("late stat rejection"));
      await flushMicrotasks();
      expect(fileSystem.access).not.toHaveBeenCalled();
      expect(local.calls).toHaveLength(0);
    } finally {
      stat.reject(new Error("late stat rejection"));
      await flushMicrotasks();
      vi.useRealTimers();
    }
  });

  it("stops a stalled local access when the source is no longer current", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const access = deferred<void>();
    const fileSystem: ContainerlabLocalExecutableFileSystem = {
      realpath: vi.fn(async () => "/bin/true"),
      stat: vi.fn(async () => ({ isFile: () => true })),
      access: vi.fn(() => access.promise)
    };
    const local = commandRunner(metadataResponse);
    const executor = createContainerlabExecutor({ localRunner: local.runner, sshRunner: local.runner, localFileSystem: fileSystem });
    let current = true;
    const pending = executor.resolveDependencies(config(), context("local", {
      deadline: 1_000,
      isCurrent: () => current
    }));
    let outcome: { status: "resolved" } | { status: "rejected"; error: unknown } | undefined;
    void pending.then(
      () => { outcome = { status: "resolved" }; },
      (error: unknown) => { outcome = { status: "rejected", error }; }
    );
    try {
      await flushMicrotasks();
      expect(fileSystem.access).toHaveBeenCalledTimes(1);
      current = false;
      await vi.advanceTimersByTimeAsync(25);
      await flushMicrotasks();
      expect(outcome?.status).toBe("rejected");
      if (outcome?.status === "rejected") {
        expect(outcome.error).toMatchObject({ message: expect.stringMatching(/cancelled, timed out, or is no longer current/i) });
      }
      access.resolve();
      await flushMicrotasks();
      expect(fileSystem.realpath).toHaveBeenCalledTimes(1);
      expect(fileSystem.stat).toHaveBeenCalledTimes(1);
      expect(fileSystem.access).toHaveBeenCalledTimes(1);
      expect(local.calls).toHaveLength(0);
    } finally {
      access.resolve();
      await flushMicrotasks();
      vi.useRealTimers();
    }
  });

  it("rejects a changed deep SSH route before remote executable resolution", async () => {
    const remote = commandRunner(metadataResponse);
    const executor = createContainerlabExecutor({ localRunner: remote.runner, sshRunner: remote.runner });
    const expected = executionIdentity({ routeIdentity: "approved-route-a" });

    await expect(executor.resolveDependencies(
      remoteConfig(),
      context("ssh", { labHostRouteIdentity: "changed-deep-route-b" }),
      expected
    )).rejects.toThrow();
    expect(remote.calls).toHaveLength(0);
  });

  it("captures a local host executable without executing it during resolution", async () => {
    const local = commandRunner(metadataResponse);
    const executor = createContainerlabExecutor({ localRunner: local.runner, sshRunner: local.runner });

    const resolved = await executor.resolveDependencies(config(), context());

    expect(resolved.identity.location).toBe("local");
    expect(resolved.identity.routeIdentity).toBe("local");
    expect(resolved.identity.executable).toMatch(/^\//u);
    expect(resolved.identity.dockerExecutable).toMatch(/^\//u);
    expect(local.calls).toHaveLength(1);
    expect(local.calls[0].args).toContain("info");
    expect(local.calls.some((call) => call.args.includes("version"))).toBe(false);
  });

  it("checks Docker topology before direct host version and inspection commands", async () => {
    const local = commandRunner((command) => {
      if (command.args.includes("info")) return { stdout: JSON.stringify({ OSType: "linux", SecurityOptions: [] }), stderr: "" };
      if (command.args.includes("version")) return { stdout: "    version: 0.80.0\n", stderr: "" };
      if (command.args.includes("--runtime")) return { stdout: "{\"nodes\":[]}", stderr: "" };
      throw new Error(`Unexpected host runner command: ${command.args.join(" ")}`);
    });
    const executor = createContainerlabExecutor({ localRunner: local.runner, sshRunner: local.runner });
    const settings = config();
    const runContext = context();

    const resolved = await executor.resolveDependencies(settings, runContext);

    expect(resolved.identity.dockerExecutable).toMatch(/^\//u);
    expect(local.calls).toHaveLength(1);
    expect(local.calls[0].args).toContain("info");
    const prepared = await executor.preflight(settings, resolved, runContext);
    expect(prepared.version).toBe("0.80.0");
    expect(local.calls[1].args).toEqual(["version"]);
    expect(local.calls[1].executable).toBe(resolved.identity.executable);
    await expect(executor.inspect(settings, prepared, runContext)).resolves.toMatchObject({ version: "0.80.0" });
    expect(local.calls[2].executable).toBe(resolved.identity.executable);
    expect(local.calls[2].args).toContain("--runtime");
    expect(local.calls[2].args).not.toContain("--host");
    expect(local.calls[2].args).not.toContain("run");
    expect(local.calls[2].args).not.toContain("exec");
  });

  it("refuses a missing host Docker prerequisite before Containerlab execution", async () => {
    const local = commandRunner(() => ({ stdout: "", stderr: "" }));
    const executor = createContainerlabExecutor({ localRunner: local.runner, sshRunner: local.runner });

    await expect(executor.resolveDependencies(config({ dockerExecutable: "/definitely/missing/docker" }), context()))
      .rejects.toThrow(/Docker executable could not be resolved/i);
    expect(local.calls).toHaveLength(0);
  });

  it("rejects changed host CLI or Docker paths before Docker metadata", async () => {
    const local = commandRunner(metadataResponse);
    const executor = createContainerlabExecutor({ localRunner: local.runner, sshRunner: local.runner });
    const settings = config({ runner: "host" });
    const approved = await executor.resolveDependencies(settings, context());
    const expected = approved.identity;
    local.calls.length = 0;

    const cliFailure = await executor.resolveDependencies(settings, context(), {
      ...expected,
      executable: `${expected.executable}.changed`
    }).then(() => undefined, (error: unknown) => error);
    expect(local.calls.some((call) => call.args.includes("info"))).toBe(false);
    expect(cliFailure).toBeInstanceOf(Error);

    local.calls.length = 0;
    const dockerFailure = await executor.resolveDependencies(settings, context(), {
      ...expected,
      dockerExecutable: `${expected.dockerExecutable}.changed`
    }).then(() => undefined, (error: unknown) => error);
    expect(local.calls.some((call) => call.args.includes("info"))).toBe(false);
    expect(dockerFailure).toBeInstanceOf(Error);
    expect((dockerFailure as Error).message).toMatch(/Docker executable path changed/i);
  });

  it("resolves an executable name only through the fixed non-workspace path", async () => {
    const local = commandRunner(metadataResponse);
    const executor = createContainerlabExecutor({ localRunner: local.runner, sshRunner: local.runner });

    const resolved = await executor.resolveDependencies(config({ containerlabExecutable: "sh" }), context());

    expect(resolved.identity.executable).toMatch(/^\/(?:usr\/)?bin\//u);
    expect(resolved.identity.executable).not.toContain("/worktrees/");
    expect(local.calls).toHaveLength(1);
    expect(local.calls[0].args).toContain("info");
  });

  it("uses plain version preflight after resolution and extracts the anchored version line", async () => {
    const local = commandRunner((command) => {
      if (command.args.includes("info")) return metadataResponse(command);
      expect(command.args).toEqual(["version"]);
      return { stdout: "\u001b[32mContainerlab\u001b[0m\ncommit: 2024-08-01\n    version: 0.80.0\n", stderr: "" };
    });
    const executor = createContainerlabExecutor({ localRunner: local.runner, sshRunner: local.runner });
    const runContext = context();
    const resolved = await executor.resolveDependencies(config(), runContext);

    const prepared = await executor.preflight(config(), resolved, runContext);

    expect(prepared.version).toBe("0.80.0");
    expect(local.calls).toHaveLength(2);
  });

  it("rejects preflight after the captured SSH route changes without running a command", async () => {
    const remote = commandRunner(metadataResponse);
    const executor = createContainerlabExecutor({ localRunner: remote.runner, sshRunner: remote.runner });
    const original = context("ssh");
    const resolved = await executor.resolveDependencies(remoteConfig(), original);
    const callCount = remote.calls.length;

    await expect(executor.preflight(
      remoteConfig(), resolved,
      context("ssh", { labHostRouteIdentity: "new-deep-route" })
    )).rejects.toThrow(/route/i);
    expect(remote.calls).toHaveLength(callCount);
  });

  it("rejects inspect after the route changes between approved preflight and inspection", async () => {
    const remote = commandRunner((command) => command.args.includes("version")
      ? { stdout: "    version: 0.80.0\n", stderr: "" }
      : metadataResponse(command));
    const executor = createContainerlabExecutor({ localRunner: remote.runner, sshRunner: remote.runner });
    const settings = remoteConfig();
    const original = context("ssh");
    const resolved = await executor.resolveDependencies(settings, original);
    const prepared = await executor.preflight(settings, resolved, original);
    const callCount = remote.calls.length;

    await expect(executor.inspect(settings, prepared, context("ssh", {
      labHostRouteIdentity: "changed-between-stages"
    }))).rejects.toThrow(/route/i);
    expect(remote.calls).toHaveLength(callCount);
  });

  it("rejects a stale invocation before preflight starts", async () => {
    const local = commandRunner((command) => command.args.includes("version")
      ? { stdout: "    version: 0.80.0\n", stderr: "" }
      : metadataResponse(command));
    const executor = createContainerlabExecutor({ localRunner: local.runner, sshRunner: local.runner });
    const settings = config();
    const resolved = await executor.resolveDependencies(settings, context());

    await expect(executor.preflight(settings, resolved, context("local", { isCurrent: () => false })))
      .rejects.toThrow(/cancelled|current/i);
    expect(local.calls).toHaveLength(1);
    expect(local.calls.some((call) => call.args.includes("version"))).toBe(false);
  });

  it("rejects remote path resolver noise instead of accepting a guessed executable", async () => {
    const remote = commandRunner(() => ({ stdout: "/usr/bin/containerlab\nwarning: shell startup\n", stderr: "" }));
    const executor = createContainerlabExecutor({ localRunner: remote.runner, sshRunner: remote.runner });

    await expect(executor.resolveDependencies(config({
      location: "ssh", labHostId: labHost.id, containerlabExecutable: "containerlab"
    }), context("ssh"))).rejects.toThrow(/one absolute path/i);
  });

  it.each([
    ["host", "local"], ["host", "ssh"],
    ["disposable", "local"], ["disposable", "ssh"],
    ["existing", "local"], ["existing", "ssh"]
  ] as const)("resolves the %s runner in %s mode without executing Containerlab", async (runner, location) => {
    const values: Record<string, string | boolean> = {
      location, runner, dockerSocket: "/run/docker.sock", sudo: true,
      ...(location === "ssh" ? { labHostId: labHost.id } : {}),
      ...(location === "ssh" ? {
        containerlabExecutable: runner === "host" ? "/remote/containerlab" : "/bin/true",
        dockerExecutable: "/remote/docker"
      } : {}),
      ...(runner === "disposable" ? { runnerImage: "ghcr.io/srl-labs/clab:0.80.0" } : {}),
      ...(runner === "existing" ? { runnerContainer: "runner" } : {})
    };
    const fake = commandRunner(metadataResponse);
    const executor = createContainerlabExecutor({ localRunner: fake.runner, sshRunner: fake.runner });

    const resolved = await executor.resolveDependencies(config(values), context(location));

    expect(resolved.identity.location).toBe(location);
    expect(resolved.identity.routeIdentity).toBe(location === "local" ? "local" : "captured-route-a");
    expect(resolved.identity.dockerSocket).toBe("/run/docker.sock");
    if (runner === "host") {
      expect(resolved.identity.executable).toMatch(/^\//u);
      expect(resolved.identity.dockerExecutable).toMatch(/^\//u);
      expect(fake.calls.filter((call) => call.args.includes("info"))).toHaveLength(1);
      expect(fake.calls.some((call) => call.args.includes("image") || call.args.includes("container"))).toBe(false);
      expect(fake.calls.some((call) => call.args.includes("-c"))).toBe(location === "ssh");
    } else {
      expect(resolved.identity.executable).toBe("/bin/true");
      expect(resolved.identity.dockerExecutable).toMatch(/^\//u);
      expect(resolved.identity.imageId).toBe(runner === "disposable" ? imageId : undefined);
      expect(resolved.identity.containerId).toBe(runner === "existing" ? containerId : undefined);
      expect(fake.calls.some((call) => call.args.includes("--format") && call.args.includes("version"))).toBe(false);
      expect(fake.calls.some((call) => call.args.includes("run") || call.args.includes("exec"))).toBe(false);
      const metadataCalls = fake.calls.filter((call) => call.args.includes("info") || call.args.includes("image") || call.args.includes("container"));
      for (const call of metadataCalls) {
        expect(call.executable).toBe("sudo");
        expect(call.args.slice(0, 5)).toEqual(["-n", "--", "env", "-i", "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"]);
        expect(call.env).toEqual({
          PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
          LANG: "C.UTF-8",
          LC_ALL: "C.UTF-8",
          DOCKER_HOST: "unix:///run/docker.sock"
        });
        expect(call.args).toContain("unix:///run/docker.sock");
      }
    }
  });

  it("compares the expected outer Docker path before any Docker metadata command", async () => {
    const fake = commandRunner(metadataResponse);
    const executor = createContainerlabExecutor({ localRunner: fake.runner, sshRunner: fake.runner });
    const expected = executionIdentity({
      executable: "/bin/true",
      dockerExecutable: "/different/docker",
      location: "local",
      routeIdentity: "local",
      dockerSocket: "/run/docker.sock",
      imageId
    });

    await expect(executor.resolveDependencies(config({
      runner: "disposable", runnerImage: "ghcr.io/srl-labs/clab:0.80.0", dockerSocket: "/run/docker.sock"
    }), context(), expected)).rejects.toThrow(/Docker executable path changed/i);
    expect(fake.calls).toHaveLength(0);
  });

  it("rejects rootless and non-Linux Docker metadata before resolving a runner image", async () => {
    for (const info of [
      { OSType: "linux", SecurityOptions: ["name=rootless"] },
      { OSType: "windows", SecurityOptions: [] },
      { OSType: "linux" }
    ]) {
      const fake = commandRunner((command) => command.args.includes("info")
        ? { stdout: JSON.stringify(info), stderr: "" }
        : metadataResponse(command));
      const executor = createContainerlabExecutor({ localRunner: fake.runner, sshRunner: fake.runner });

      await expect(executor.resolveDependencies(config({
        runner: "disposable", runnerImage: "ghcr.io/srl-labs/clab:0.80.0"
      }), context())).rejects.toThrow(/rootful Linux Docker/i);
      expect(fake.calls.some((call) => call.args.includes("image"))).toBe(false);
    }
  });

  it("refuses an existing runner without the exact selected socket bind", async () => {
    const fake = commandRunner((command) => command.args.includes("container")
      ? { stdout: JSON.stringify({
          Id: containerId, Name: "/runner", State: { Running: true },
          Mounts: [{ Type: "bind", Source: "/other/docker.sock", Destination: "/var/run/docker.sock", RW: true }]
        }), stderr: "" }
      : metadataResponse(command));
    const executor = createContainerlabExecutor({ localRunner: fake.runner, sshRunner: fake.runner });

    await expect(executor.resolveDependencies(config({ runner: "existing", runnerContainer: "runner" }), context()))
      .rejects.toThrow(/selected Docker socket/i);
  });

  it.each([
    ["0.68 banner", "\u001b[32mContainerlab\u001b[0m\ncommit: 2024-01-01\n    version: 0.68.0\n", "0.68.0"],
    ["0.80 banner", "Containerlab\ncommit: 2024-08-01\n    version: v0.80.0+build.1\n", "0.80.0+build.1"]
  ])("accepts the supported version from the %s", async (_label, stdout, version) => {
    const fake = commandRunner((command) => command.args.includes("version")
      ? { stdout, stderr: "" }
      : metadataResponse(command));
    const executor = createContainerlabExecutor({ localRunner: fake.runner, sshRunner: fake.runner });
    const runContext = context();
    const resolved = await executor.resolveDependencies(config(), runContext);

    await expect(executor.preflight(config(), resolved, runContext)).resolves.toMatchObject({ version });
    const versionCall = fake.calls.find((call) => call.args.includes("version"))!;
    expect(versionCall.args).toEqual(["version"]);
    expect(versionCall.args).not.toContain("--short");
  });

  it.each([
    ["duplicate line", "    version: 0.80.0\n    version: 0.80.0\n"],
    ["missing line", "Containerlab 2024-01-01\n"],
    ["wrong indentation", "version: 0.80.0\n"],
    ["unsupported version", "    version: 0.67.9\n"],
    ["pre-release minimum", "    version: 0.68.0-rc.1\n"]
  ])("rejects version output with %s", async (_label, stdout) => {
    const fake = commandRunner((command) => command.args.includes("version")
      ? { stdout, stderr: "" }
      : metadataResponse(command));
    const executor = createContainerlabExecutor({ localRunner: fake.runner, sshRunner: fake.runner });
    const runContext = context();
    const resolved = await executor.resolveDependencies(config(), runContext);

    await expect(executor.preflight(config(), resolved, runContext)).rejects.toThrow(/version|0\.68\.0/i);
  });

  it("does not execute version or inspection when the resolved immutable image changed", async () => {
    const fake = commandRunner(metadataResponse);
    const executor = createContainerlabExecutor({ localRunner: fake.runner, sshRunner: fake.runner });
    const settings = config({ runner: "disposable", runnerImage: "ghcr.io/srl-labs/clab:0.80.0" });
    const runContext = context();
    const baseline = await executor.resolveDependencies(settings, runContext);
    fake.calls.length = 0;
    const expected = { ...baseline.identity, imageId: `sha256:${"c".repeat(64)}` };

    await expect(executor.resolveDependencies(settings, runContext, expected))
      .rejects.toThrow(/immutable Containerlab runner identity changed/i);
    expect(fake.calls.some((call) => call.args.includes("info"))).toBe(true);
    expect(fake.calls.some((call) => call.args.includes("image"))).toBe(true);
    expect(fake.calls.some((call) => call.args.includes("version"))).toBe(false);
    expect(fake.calls.some((call) => call.args.includes("--runtime"))).toBe(false);
  });

  it("pins the resolved image ID for version and rejects inspection stdout noise", async () => {
    const fake = commandRunner((command) => {
      if (command.args.includes("image")) return { stdout: imageId, stderr: "" };
      if (command.args.includes("ls")) return { stdout: "", stderr: "" };
      if (command.args.includes("version")) {
        expect(command.args).toContain(imageId);
        return { stdout: "    version: 0.80.0\n", stderr: "" };
      }
      if (command.args.includes("--runtime")) {
        expect(command.args).toContain(imageId);
        return { stdout: "noise {\"nodes\":[]}", stderr: "" };
      }
      return metadataResponse(command);
    });
    const executor = createContainerlabExecutor({ localRunner: fake.runner, sshRunner: fake.runner });
    const runContext = context();
    const settings = config({ runner: "disposable", runnerImage: "mutable-tag" });
    const resolved = await executor.resolveDependencies(settings, runContext);
    const prepared = await executor.preflight(settings, resolved, runContext);

    await expect(executor.inspect(settings, prepared, runContext)).rejects.toThrow(/one JSON document/i);
    expect(fake.calls.filter((call) => call.args.includes("image"))).toHaveLength(1);
  });

  it("uses the immutable existing-container ID for preflight and inspection", async () => {
    const fake = commandRunner((command) => {
      if (command.args.includes("version")) {
        expect(command.args).toContain(containerId);
        expect(command.args).not.toContain("runner");
        return { stdout: "    version: 0.80.0\n", stderr: "" };
      }
      if (command.args.includes("--runtime")) {
        expect(command.args).toContain(containerId);
        expect(command.args).not.toContain("runner");
        return { stdout: "{\"nodes\":[]}", stderr: "" };
      }
      return metadataResponse(command);
    });
    const executor = createContainerlabExecutor({ localRunner: fake.runner, sshRunner: fake.runner });
    const runContext = context();
    const settings = config({ runner: "existing", runnerContainer: "runner", dockerSocket: "/run/docker.sock" });
    const resolved = await executor.resolveDependencies(settings, runContext);
    const prepared = await executor.preflight(settings, resolved, runContext);

    await expect(executor.inspect(settings, prepared, runContext)).resolves.toMatchObject({ version: "0.80.0" });
    expect(fake.calls.filter((call) => call.args.includes("version") || call.args.includes("--runtime"))).toHaveLength(2);
  });

  it("preserves the primary failure and only removes a helper after name and label verification", async () => {
    const helperId = "d".repeat(64);
    const fake = commandRunner((command) => {
      if (command.args.includes("image")) return { stdout: imageId, stderr: "" };
      if (command.args.includes("version")) throw new Error("version process timed out");
      if (command.args.includes("--quiet")) {
        return { stdout: `${command.args.includes("--no-trunc") ? helperId : helperId.slice(0, 12)}\n`, stderr: "" };
      }
      if (command.args.includes("inspect") && command.args.includes("--format")) {
        return { stdout: JSON.stringify({
          Id: helperId, Name: "/nexus-inventory-run-123",
          Config: { Labels: { "nexus.inventory-run": "run-123" } }
        }), stderr: "" };
      }
      if (command.args.includes("rm")) return { stdout: "", stderr: "" };
      return metadataResponse(command);
    });
    const executor = createContainerlabExecutor({
      localRunner: fake.runner, sshRunner: fake.runner, createInvocationId: () => "run-123"
    });
    const runContext = context();
    const settings = config({ runner: "disposable", runnerImage: "ghcr.io/srl-labs/clab:0.80.0" });
    const resolved = await executor.resolveDependencies(settings, runContext);

    await expect(executor.preflight(settings, resolved, runContext)).rejects.toThrow(/timed out/);
    const removal = fake.calls.find((call) => call.args.includes("rm"));
    const listing = fake.calls.find((call) => call.args.includes("--quiet"));
    expect(listing?.args).toContain("--no-trunc");
    expect(fake.calls.find((call) => call.args.includes("container") && call.args.includes("inspect") && call.args.includes("--format"))?.args).toContain(helperId);
    expect(removal?.args).toContain(helperId);
    expect(fake.calls.some((call) => call.args.includes(`label=nexus.inventory-run=run-123`))).toBe(true);
  });
});
