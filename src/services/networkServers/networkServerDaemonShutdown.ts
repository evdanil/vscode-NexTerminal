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
      dependencies.flushRuntimeUpdates();
      try {
        await dependencies.dispose();
      } catch {
        // Disposal is best-effort; every terminal path still exits exactly once.
      }
      dependencies.flushRuntimeUpdates();
      dependencies.exit();
    })();
    return shutdownPromise;
  };

  return { begin, isShuttingDown: () => shuttingDown };
}
