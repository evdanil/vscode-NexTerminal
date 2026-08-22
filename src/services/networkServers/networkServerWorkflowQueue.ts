/**
 * Serializes complete daemon workflows for one service, not merely their
 * individual lifecycle primitives. Configuration eviction and start/stop must
 * share this boundary so later JSON-line requests cannot overwrite a workflow
 * that is already waiting on asynchronous socket cleanup.
 */
export class ServiceWorkflowQueue {
  private readonly queues = new Map<string, Promise<void>>();

  public enqueue<T>(id: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(id) ?? Promise.resolve();
    const operationPromise = previous.then(operation);
    const settled = operationPromise.then(
      () => undefined,
      () => undefined,
    );
    this.queues.set(id, settled);
    void settled.then(() => {
      if (this.queues.get(id) === settled) this.queues.delete(id);
    });
    return operationPromise;
  }

  /** Waits for every workflow accepted before this call. */
  public async drain(): Promise<void> {
    await Promise.all([...this.queues.values()]);
  }
}
