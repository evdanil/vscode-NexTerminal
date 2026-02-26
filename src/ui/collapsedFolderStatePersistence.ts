export interface CollapsedFolderStatePersistence {
  schedule(paths: string[]): void;
  flush(): Promise<void>;
  dispose(): void;
}

interface CollapsedFolderStatePersistenceOptions {
  debounceMs?: number;
  onError?: (error: unknown) => void;
}

export function createCollapsedFolderStatePersistence(
  persist: (paths: string[]) => Promise<void> | PromiseLike<void>,
  options: CollapsedFolderStatePersistenceOptions = {}
): CollapsedFolderStatePersistence {
  const debounceMs = Math.max(0, options.debounceMs ?? 100);
  const onError = options.onError ?? (() => {});
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pendingPaths: string[] | undefined;
  let writeChain = Promise.resolve();

  const enqueueWrite = (paths: string[]): Promise<void> => {
    writeChain = writeChain
      .catch(() => {})
      .then(async () => {
        await persist(paths);
      })
      .catch((error) => {
        onError(error);
      });
    return writeChain;
  };

  const flush = async (): Promise<void> => {
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
    if (!pendingPaths) {
      await writeChain;
      return;
    }

    const next = pendingPaths;
    pendingPaths = undefined;
    await enqueueWrite(next);

    if (pendingPaths) {
      await flush();
    }
  };

  const schedule = (paths: string[]): void => {
    pendingPaths = [...paths];
    if (timer) {
      clearTimeout(timer);
    }
    timer = setTimeout(() => {
      timer = undefined;
      void flush();
    }, debounceMs);
  };

  const dispose = (): void => {
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
  };

  return { schedule, flush, dispose };
}
