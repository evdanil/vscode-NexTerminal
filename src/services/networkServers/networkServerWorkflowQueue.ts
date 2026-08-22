/**
 * Serializes complete daemon workflows for one service, not merely their
 * individual lifecycle primitives. Configuration eviction and start/stop must
 * share this boundary so later JSON-line requests cannot overwrite a workflow
 * that is already waiting on asynchronous socket cleanup.
 */
export const MAX_SERVICE_WORKFLOW_OPERATIONS = 32;

function serverBusyError(): Error {
  const error = new Error("Service workflow admission is full.");
  error.name = "SERVER_BUSY";
  return error;
}

export class ServiceWorkflowQueue {
  private readonly queues = new Map<string, Promise<void>>();
  /** Every accepted operation, including no-key work, remains drain-owned. */
  private readonly accepted = new Set<Promise<void>>();
  private closingError: Error | undefined;

  /** Rejects later work while retaining all accepted tails for {@link drain}. */
  public close(): void {
    this.closingError ??= new Error("Service workflows are shutting down.");
  }

  public enqueue<T>(id: string, operation: () => Promise<T>): Promise<T> {
    return this.enqueueMany([id], operation);
  }

  /** A read takes the same ordered boundary as mutations for a coherent snapshot. */
  public read<T>(id: string, read: () => Promise<T>): Promise<T> {
    return this.enqueue(id, read);
  }

  /** A multi-service read takes every requested boundary as one snapshot. */
  public readMany<T>(ids: readonly string[], read: () => Promise<T>): Promise<T> {
    return this.enqueueMany(ids, read);
  }

  /**
   * Reserves every requested service tail before waiting for any of them.
   *
   * A two-service request must not independently enqueue TFTP and DHCP: that
   * would let another request slip between its two configuration writes. The
   * canonical `tftp`, then `dhcp` key order also makes every multi-service
   * reservation agree, so no pair of requests can wait on each other's tail.
   */
  public enqueueMany<T>(ids: readonly string[], operation: () => Promise<T>): Promise<T> {
    if (this.closingError) return Promise.reject(this.closingError);
    if (this.accepted.size >= MAX_SERVICE_WORKFLOW_OPERATIONS) return Promise.reject(serverBusyError());
    const keys = this.canonicalKeys(ids);
    const previous = keys.map((id) => this.queues.get(id) ?? Promise.resolve());
    const operationPromise = Promise.all(previous).then(operation);
    const settled = operationPromise.then(
      () => undefined,
      () => undefined,
    );
    this.accepted.add(settled);
    for (const id of keys) this.queues.set(id, settled);
    void settled.then(() => {
      this.accepted.delete(settled);
      for (const id of keys) {
        if (this.queues.get(id) === settled) this.queues.delete(id);
      }
    });
    return operationPromise;
  }

  /** Waits for every workflow accepted before this call. */
  public async drain(): Promise<void> {
    await Promise.all([...this.accepted]);
  }

  private canonicalKeys(ids: readonly string[]): readonly string[] {
    return [...new Set(ids)].sort((left, right) => this.compareKeys(left, right));
  }

  private compareKeys(left: string, right: string): number {
    const rank = (id: string): number => id === "tftp" ? 0 : id === "dhcp" ? 1 : 2;
    return rank(left) - rank(right) || left.localeCompare(right);
  }
}
