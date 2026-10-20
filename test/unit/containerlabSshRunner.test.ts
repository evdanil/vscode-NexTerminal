import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { createContainerlabSshRunner } from "../../src/services/inventory/containerlabSshRunner";
import type { ContainerlabCommand, ContainerlabRunContext } from "../../src/services/inventory/containerlabRuntimeContracts";
import type { ServerConfig } from "../../src/models/config";
import type { ContextAwareSshFactory, SshCommandChannel, SshConnection } from "../../src/services/ssh/contracts";

const host = {
  id: "lab-host",
  name: "Lab host",
  host: "lab.example",
  port: 22,
  username: "operator"
} as ServerConfig;

function context(overrides: Partial<ContainerlabRunContext> = {}): ContainerlabRunContext {
  return {
    interaction: "noninteractive",
    signal: new AbortController().signal,
    deadline: Date.now() + 5_000,
    labHost: host,
    labHostRouteIdentity: "captured-ssh-route-identity",
    isCurrent: () => true,
    ...overrides
  };
}

function command(overrides: Partial<ContainerlabCommand> = {}): ContainerlabCommand {
  return {
    executable: "/usr/bin/docker",
    args: ["--host", "unix:///run/docker.sock", "inspect", "container;touch /tmp/no"],
    env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8", DOCKER_HOST: "unix:///run/docker.sock" },
    cwd: "/",
    ...overrides
  };
}

interface ChannelControl {
  readonly channel: SshCommandChannel;
  readonly stdout: PassThrough;
  readonly stderr: PassThrough;
  finish(code?: number | null, signal?: string): void;
}

function makeChannel(): ChannelControl {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let resolveCompletion!: (result: { code: number | null; signal?: string }) => void;
  const completion = new Promise<{ code: number | null; signal?: string }>((resolve) => {
    resolveCompletion = resolve;
  });
  const channel: SshCommandChannel = {
    stdout,
    stderr,
    completion,
    close: vi.fn(() => {
      stdout.destroy();
      stderr.destroy();
      resolveCompletion({ code: null, signal: "SIGTERM" });
    })
  };
  return {
    channel,
    stdout,
    stderr,
    finish: (code = 0, signal) => {
      stdout.end();
      stderr.end();
      resolveCompletion({ code, ...(signal ? { signal } : {}) });
    }
  };
}

function makeConnection(execCommand?: SshConnection["execCommand"]): SshConnection & { dispose: ReturnType<typeof vi.fn>; exec: ReturnType<typeof vi.fn> } {
  return {
    execCommand,
    exec: vi.fn(async () => { throw new Error("legacy SSH exec must not be used"); }),
    dispose: vi.fn(),
    openShell: vi.fn(),
    openDirectTcp: vi.fn(),
    openSftp: vi.fn(),
    requestForwardIn: vi.fn(),
    cancelForwardIn: vi.fn(),
    onTcpConnection: vi.fn(() => () => {}),
    onClose: vi.fn(() => () => {}),
    getBanner: vi.fn()
  } as unknown as SshConnection & { dispose: ReturnType<typeof vi.fn>; exec: ReturnType<typeof vi.fn> };
}

function makeFactory(connectionPromise: Promise<SshConnection>, contexts: unknown[] = []): ContextAwareSshFactory {
  return {
    connect: vi.fn(async () => { throw new Error("unsafe context-free SSH connect must not be used"); }),
    connectWithContext: vi.fn((_server, connectContext) => {
      contexts.push(connectContext);
      return connectionPromise;
    })
  };
}

describe("Containerlab SSH command runner", () => {
  it("uses typed command channels, preserves the interaction policy, and quotes every argument", async () => {
    const channel = makeChannel();
    const line: string[] = [];
    const connection = makeConnection(vi.fn(async (remoteCommand) => {
      line.push(remoteCommand);
      setImmediate(() => {
        channel.stdout.end("ok");
        channel.stderr.end();
        channel.finish();
      });
      return channel.channel;
    }));
    const contexts: unknown[] = [];
    const factory = makeFactory(Promise.resolve(connection), contexts);
    const result = await createContainerlabSshRunner({ sshFactory: factory }).run(command(), context());

    expect(result).toEqual({ stdout: "ok", stderr: "" });
    expect(factory.connectWithContext).toHaveBeenCalledTimes(1);
    expect(factory.connect).not.toHaveBeenCalled();
    expect(contexts[0]).toMatchObject({ interaction: "noninteractive", signal: expect.any(AbortSignal) });
    expect(connection.execCommand).toHaveBeenCalledTimes(1);
    expect(line[0]).toContain("'/usr/bin/env' '-i'");
    expect(line[0]).toContain("'PATH=/usr/bin:/bin'");
    expect(line[0]).toContain("'container;touch /tmp/no'");
    expect(line[0]).not.toContain("container;touch /tmp/no' &&");
    expect(connection.exec).not.toHaveBeenCalled();
    expect(connection.dispose).toHaveBeenCalledTimes(1);
  });

  it("rejects an expired context before opening an SSH connection", async () => {
    const factory = makeFactory(Promise.resolve(makeConnection()));
    await expect(createContainerlabSshRunner({ sshFactory: factory }).run(command(), context({ deadline: Date.now() - 1 })))
      .rejects.toThrow(/timed out|deadline/i);
    expect(factory.connectWithContext).not.toHaveBeenCalled();
  });

  it("does not fall back to the untyped interactive SSH exec API", async () => {
    const connection = makeConnection(undefined);
    const factory = makeFactory(Promise.resolve(connection));
    await expect(createContainerlabSshRunner({ sshFactory: factory }).run(command(), context()))
      .rejects.toThrow(/typed command channel/i);
    expect(connection.exec).not.toHaveBeenCalled();
    expect(connection.dispose).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["nonzero exit", 4, undefined, /exit.*4/i],
    ["signal", null, "SIGKILL", /signal|terminated/i]
  ] as const)("rejects a command channel with %s", async (_label, code, signal, error) => {
    const control = makeChannel();
    const connection = makeConnection(vi.fn(async () => {
      setImmediate(() => control.finish(code, signal));
      return control.channel;
    }));
    await expect(createContainerlabSshRunner({ sshFactory: makeFactory(Promise.resolve(connection)) })
      .run(command(), context())).rejects.toThrow(error);
    expect(control.channel.close).toHaveBeenCalledTimes(1);
    expect(connection.dispose).toHaveBeenCalledTimes(1);
  });

  it("counts stdout and stderr together and rejects oversized output", async () => {
    const control = makeChannel();
    const connection = makeConnection(vi.fn(async () => {
      setImmediate(() => {
        control.stdout.end(Buffer.alloc(4 * 1024 * 1024, 0x61));
        control.stderr.end(Buffer.alloc(4 * 1024 * 1024 + 1, 0x62));
        control.finish();
      });
      return control.channel;
    }));
    await expect(createContainerlabSshRunner({ sshFactory: makeFactory(Promise.resolve(connection)) })
      .run(command(), context())).rejects.toThrow(/output.*limit/i);
    expect(control.channel.close).toHaveBeenCalledTimes(1);
  });

  it("closes a channel and disposes its lease when the deadline expires after acquisition", async () => {
    const control = makeChannel();
    const connection = makeConnection(vi.fn(async () => control.channel));
    await expect(createContainerlabSshRunner({ sshFactory: makeFactory(Promise.resolve(connection)) })
      .run(command(), context({ deadline: Date.now() + 40 }))).rejects.toThrow(/timed out|deadline/i);
    expect(control.channel.close).toHaveBeenCalledTimes(1);
    expect(connection.dispose).toHaveBeenCalledTimes(1);
  });

  it("disposes a connection that resolves after its caller cancels", async () => {
    let resolveConnection!: (connection: SshConnection) => void;
    const pendingConnection = new Promise<SshConnection>((resolve) => { resolveConnection = resolve; });
    const controller = new AbortController();
    const factory = makeFactory(pendingConnection);
    const run = createContainerlabSshRunner({ sshFactory: factory }).run(command(), context({ signal: controller.signal }));
    const rejected = expect(run).rejects.toThrow(/cancel/i);
    controller.abort(new Error("test cancelled"));
    await rejected;

    const lateConnection = makeConnection();
    resolveConnection(lateConnection);
    await new Promise((resolve) => setImmediate(resolve));
    expect(lateConnection.dispose).toHaveBeenCalledTimes(1);
  });

  it("closes a channel that resolves after cancellation during channel acquisition", async () => {
    let resolveChannel!: (channel: SshCommandChannel) => void;
    const connection = makeConnection(vi.fn(() => new Promise<SshCommandChannel>((resolve) => { resolveChannel = resolve; })));
    const controller = new AbortController();
    const run = createContainerlabSshRunner({ sshFactory: makeFactory(Promise.resolve(connection)) })
      .run(command(), context({ signal: controller.signal }));
    const rejected = expect(run).rejects.toThrow(/cancel/i);
    await new Promise((resolve) => setImmediate(resolve));
    controller.abort(new Error("test cancelled"));
    await rejected;

    const lateChannel = makeChannel();
    resolveChannel(lateChannel.channel);
    await new Promise((resolve) => setImmediate(resolve));
    expect(lateChannel.channel.close).toHaveBeenCalledTimes(1);
    expect(connection.dispose).toHaveBeenCalledTimes(1);
  });
});
