import { EventEmitter } from "node:events";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { RemoteDirectoryWatcher } from "../../src/services/sftp/remoteDirectoryWatcher";
import type { SshConnection } from "../../src/services/ssh/contracts";

type MockExecStream = EventEmitter & { destroy: ReturnType<typeof vi.fn> };

function createExecStream(): MockExecStream {
  const stream = new EventEmitter() as MockExecStream;
  stream.destroy = vi.fn();
  return stream;
}

describe("RemoteDirectoryWatcher", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("uses recursive inotify watching and emits nested directory changes", async () => {
    const watchStream = createExecStream();
    const exec = vi.fn(async (command: string) => {
      if (command === "command -v inotifywait") {
        const probeStream = createExecStream();
        setTimeout(() => probeStream.emit("close", 0), 0);
        return probeStream as unknown as Awaited<ReturnType<SshConnection["exec"]>>;
      }
      return watchStream as unknown as Awaited<ReturnType<SshConnection["exec"]>>;
    });

    const watcher = new RemoteDirectoryWatcher({ exec } as unknown as SshConnection, "srv-1");
    const listener = vi.fn();
    watcher.onDidChange(listener);

    const watchPromise = watcher.watch("/home/dev", 1_000);
    await vi.advanceTimersByTimeAsync(0);
    await watchPromise;

    expect(exec).toHaveBeenNthCalledWith(
      2,
      "inotifywait -m -r -q -e modify,create,delete,move --format '%w' '/home/dev'"
    );

    watchStream.emit("data", Buffer.from("/home/dev/subdir/\n"));
    await vi.advanceTimersByTimeAsync(500);

    expect(listener).toHaveBeenCalledWith({
      serverId: "srv-1",
      dirPath: "/home/dev/subdir",
    });
  });

  it("does not restart a stale watch after the target directory changes", async () => {
    const watchStreams = new Map<string, MockExecStream>();
    const exec = vi.fn(async (command: string) => {
      if (command === "command -v inotifywait") {
        const probeStream = createExecStream();
        setTimeout(() => probeStream.emit("close", 0), 0);
        return probeStream as unknown as Awaited<ReturnType<SshConnection["exec"]>>;
      }

      const stream = createExecStream();
      watchStreams.set(command, stream);
      return stream as unknown as Awaited<ReturnType<SshConnection["exec"]>>;
    });

    const watcher = new RemoteDirectoryWatcher({ exec } as unknown as SshConnection, "srv-1");

    const firstWatch = watcher.watch("/old/path", 1_000);
    await vi.advanceTimersByTimeAsync(0);
    await firstWatch;

    const secondWatch = watcher.watch("/new/path", 1_000);
    await vi.advanceTimersByTimeAsync(0);
    await secondWatch;

    const oldCommand = "inotifywait -m -r -q -e modify,create,delete,move --format '%w' '/old/path'";
    watchStreams.get(oldCommand)?.emit("close");

    await vi.advanceTimersByTimeAsync(5_000);

    expect(exec.mock.calls.filter(([command]) => command === oldCommand)).toHaveLength(1);
    expect(exec).toHaveBeenCalledWith(
      "inotifywait -m -r -q -e modify,create,delete,move --format '%w' '/new/path'"
    );
  });

  it("preserves unusual directory names in the watch stream", async () => {
    const watchStream = createExecStream();
    const exec = vi.fn(async (command: string) => {
      if (command === "command -v inotifywait") {
        const probeStream = createExecStream();
        setTimeout(() => probeStream.emit("close", 0), 0);
        return probeStream as unknown as Awaited<ReturnType<SshConnection["exec"]>>;
      }
      return watchStream as unknown as Awaited<ReturnType<SshConnection["exec"]>>;
    });

    const watcher = new RemoteDirectoryWatcher({ exec } as unknown as SshConnection, "srv-1");
    const listener = vi.fn();
    watcher.onDidChange(listener);

    const watchPromise = watcher.watch("/home/dev", 1_000);
    await vi.advanceTimersByTimeAsync(0);
    await watchPromise;

    // Pipe characters and other special chars are preserved in newline-delimited output
    watchStream.emit("data", Buffer.from("/home/dev/weird|name subdir/\n", "utf8"));
    await vi.advanceTimersByTimeAsync(500);

    expect(listener).toHaveBeenCalledWith({
      serverId: "srv-1",
      dirPath: "/home/dev/weird|name subdir",
    });
  });
});
