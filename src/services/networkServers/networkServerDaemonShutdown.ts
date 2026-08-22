/**
 * Owns the daemon's terminal boundary independently of Node process globals,
 * so all shutdown sources share one synchronous latch and one cleanup run.
 */
export interface NetworkServerDaemonShutdownDependencies {
  readonly stopAccepting: () => void;
  readonly drain: () => Promise<void>;
  readonly flushRuntimeUpdates: () => void;
  readonly dispose: () => Promise<void>;
  readonly exit: () => void;
}

export interface NetworkServerDaemonShutdown {
  readonly begin: (reason: string) => Promise<void>;
  readonly isShuttingDown: () => boolean;
}

/** The small injectable surface needed to own a daemon stdin terminal error. */
export interface DaemonInputErrorStream {
  on(event: "error", listener: (error: Error) => void): unknown;
}

/**
 * Routes a terminal stdin error through the daemon's one shutdown authority.
 *
 * A child-process stdin error cannot be deterministically injected through an
 * OS pipe on every supported platform, so this boundary stays deliberately
 * narrow and is exercised with an EventEmitter harness.
 */
export function attachDaemonInputErrorShutdown(
  stream: DaemonInputErrorStream,
  shutdown: (reason: string) => Promise<void>,
  reportFailure: (error: unknown) => void,
): void {
  stream.on("error", (error) => {
    void shutdown(`stdin stream error: ${error.message}`).catch(reportFailure);
  });
}

export function createNetworkServerDaemonShutdown(
  dependencies: NetworkServerDaemonShutdownDependencies,
): NetworkServerDaemonShutdown {
  let shuttingDown = false;
  let shutdownPromise: Promise<void> | undefined;

  const begin = (_reason: string): Promise<void> => {
    if (shutdownPromise) return shutdownPromise;
    shuttingDown = true;
    dependencies.stopAccepting();
    shutdownPromise = (async () => {
      try {
        await dependencies.drain();
      } catch {
        // A terminal shutdown continues cleanup after an unexpected drain error.
      }
      try {
        dependencies.flushRuntimeUpdates();
      } catch {
        // Runtime updates are best-effort during terminal shutdown.
      }
      try {
        await dependencies.dispose();
      } catch {
        // Disposal is best-effort; every terminal path still exits exactly once.
      }
      try {
        dependencies.flushRuntimeUpdates();
      } catch {
        // A final coalesced update must never prevent process exit.
      } finally {
        dependencies.exit();
      }
    })();
    return shutdownPromise;
  };

  return { begin, isShuttingDown: () => shuttingDown };
}
