export interface CoalescedInvoker {
  schedule(): void;
  flush(): void;
  dispose(): void;
}

/**
 * Coalesces rapid schedule calls into a single delayed invocation.
 * Useful for batching high-frequency UI refresh events.
 */
export function createCoalescedInvoker(run: () => void, delayMs: number): CoalescedInvoker {
  let timer: ReturnType<typeof setTimeout> | undefined;

  const clearScheduled = (): void => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  };

  return {
    schedule(): void {
      if (timer !== undefined) {
        return;
      }
      timer = setTimeout(() => {
        timer = undefined;
        run();
      }, delayMs);
    },

    flush(): void {
      clearScheduled();
      run();
    },

    dispose(): void {
      clearScheduled();
    }
  };
}
