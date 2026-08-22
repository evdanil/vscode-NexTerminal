/** @author kanekitakitos */

import { EventEmitter } from 'node:events';
import { ServerRegistry, type NexusServerFactory } from './ServerRegistry';
import type { NexusServer, ServerConnectionEvent } from './NexusServer';
import type { ServerSnapshot, ServerStatusChangeEvent } from './ServerStatus';
import { ServerStatus } from './ServerStatus';

/**
 * Typed map of events emitted by the `ServerManager` to the outside world.
 *
 * **Why re-emitted events (KISS + Ports & Adapters):**
 *
 * Each individual server already emits `statusChange` and `log` — but if you have
 * 10 registered servers, subscribing to events one by one is tedious and error-prone
 * (you'd forget a server, not clean up listeners on dispose, etc.).
 *
 * The Manager acts as an **Aggregator**: it listens to all servers and re-emits their
 * events in a single place, with the server `id` always included.
 * Any external adapter (CLI, REST API, WebSocket dashboard) subscribes
 * **only** to the Manager and receives events from all servers.
 */
export interface ServerManagerEvents {
  /**
   * Emitted WHENEVER ANY managed server changes state.
   * The affected server's `id` comes inside the `ServerStatusChangeEvent`.
   */
  statusChange: [event: ServerStatusChangeEvent];
  /**
   * Emitted WHENEVER ANY server generates a log line.
   * The server `id` is the first argument, so you know who spoke.
   */
  log: [id: string, level: string, message: string];
  /**
   * Emitted WHENEVER ANY server has a change in its mutable runtime
   * (new TFTP transfers / progress / completion; DHCP leases bound / renewed / released).
   * Allows refreshing TreeView / dashboards in real-time WITHOUT polling.
   * `final` forwards the originating server's terminal-change marker.
   */
  runtimeUpdate: [id: string, final?: boolean];
  /**
   * Emitted WHENEVER ANY server reaches an edge of a client connection
   * lifecycle (TFTP transfer opened/finished/failed, DHCP lease granted or
   * declined). One emission is meant to become at most one user-visible
   * message, so this is emitted at lifecycle edges only — progress belongs to
   * `runtimeUpdate`.
   */
  connection: [id: string, event: ServerConnectionEvent];
}

type ManagedLifecycleOperation = 'start' | 'stop' | 'restart' | 'drop';

interface QueuedLifecycleOperation {
  readonly kind: ManagedLifecycleOperation;
  readonly promise: Promise<unknown>;
}

/**
 * Central **Facade** for orchestrating multiple `NexusServer` servers.
 *
 * It is the main entry point of the `servers/core` module — it is through it that the
 * application (or a REST API, or a CLI) starts, stops, restarts, lists and
 * monitors all registered servers.
 *
 * ## Why a Manager (KISS + Ports & Adapters)?
 *
 * Without this class, whoever wanted to manage 5 servers would have to:
 * 1. Create a `ServerRegistry`.
 * 2. Create a `Map` to store instances.
 * 3. Ensure idempotency in `start()` and `stop()`.
 * 4. Re-emit aggregated events from each server.
 * 5. Clean everything up on shutdown.
 *
 * …and each team using Nexus would do it their own way, with different bugs.
 * The `ServerManager` encapsulates **all** this repeated logic in a
 * single, well-tested implementation.
 *
 * **And Ports & Adapters?** The Manager talks **only** to the
 * `NexusServer` interface (the Port). It doesn't know whether it is managing an HTTP server, a
 * WebSocket, a BullMQ worker or a Minecraft server. They all fit here.
 * This is the definition of low coupling.
 */
export class ServerManager extends EventEmitter {
  private readonly registry: ServerRegistry;
  private readonly instances: Map<string, NexusServer> = new Map();
  /** Serializes lifecycle transitions independently for every server id. */
  private readonly lifecycleQueues: Map<string, Promise<void>> = new Map();
  /** Coalesces adjacent duplicate lifecycle requests for one server id. */
  private readonly lastLifecycleOperations: Map<string, QueuedLifecycleOperation> = new Map();
  /** In-flight evictions, coalesced so one instance is never disposed twice. */
  private readonly dropOperations: Map<string, Promise<boolean>> = new Map();

  /**
   * Creates a new `ServerManager`.
   *
   * @param registry - An optional pre-populated `ServerRegistry`. If not
   *   provided, the Manager creates an empty one automatically. Providing a
   *   pre-ready registry is useful in tests (we can pass a registry with
   *   mocks) or in complex compositions where multiple managers share the
   *   same registry.
   */
  public constructor(registry?: ServerRegistry) {
    super();
    this.registry = registry ?? new ServerRegistry();
  }

  /**
   * Returns the `ServerRegistry` associated with this Manager. Useful for those who
   * want to register servers directly in the Registry instead of using
   * `manager.register()`.
   *
   * @returns The internal `ServerRegistry` reference.
   */
  public getRegistry(): ServerRegistry {
    return this.registry;
  }

  /**
   * Returns a server instance by `id`, if it has already been created.
   *
   * @param id - Server identifier.
   * @returns The `NexusServer` instance or `undefined` if it does not yet exist.
   */
  public getInstance(id: string): NexusServer | undefined {
    return this.instances.get(id);
  }

  /**
   * Convenient shortcut for `this.getRegistry().register(id, factory)`.
   *
   * Allows chaining registrations directly on the Manager without calling
   * `manager.getRegistry().register(...)`:
   *
   * ```ts
   * manager
   *   .register('api', apiFactory)
   *   .register('ws', wsFactory);
   * ```
   *
   * @param id - Unique server identifier.
   * @param factory - Function that creates a new server instance.
   * @returns The Manager instance itself (fluent API).
   *
   * @throws {Error} If `id` is already registered — propagates the error
   *   directly from `ServerRegistry.register()`.
   *
   * @see ServerRegistry.register - For the exact registration semantics.
   */
  public register(id: string, factory: NexusServerFactory): this {
    this.registry.register(id, factory);
    return this;
  }

  /**
   * Returns snapshots (immutable photographs) of **all** servers
   * known to the Manager: both registered but not yet instantiated ones
   * and those already created.
   *
   * ### How does the snapshot work for servers not yet created?
   * The Manager uses a clean (but optimal for KISS) trick: it creates a temporary
   * instance to read `id`, `name`, `port`, immediately calls `dispose()`
   * and discards it. Since creation is lazy and a freshly-created server
   * owns no runtime resource, this has no noticeable overhead.
   *
   * @returns Readonly array of `ServerSnapshot`, sorted by the order of
   *   id discovery (union between registered and instantiated).
   *
   * **Side effect (for not yet instantiated servers):**
   *   Invokes the factory once to build metadata, then `dispose()` of the
   *   temporary instance.
   *
   * @throws {Error} If, for some reason, a snapshot is requested for an `id`
   *   that is neither registered nor instantiated (should not happen in normal use,
   *   since `list()` only iterates over valid ids).
   */
  public list(): readonly ServerSnapshot[] {
    const ids = Array.from(new Set([...this.registry.listIds(), ...this.instances.keys()]));
    return ids.map((id) => this.getSnapshot(id));
  }

  /**
   * Starts (boots) a server by its `id`.
   *
   * - If the server does not yet have an instance, `ensureInstance` creates one
   *   automatically from the registered factory.
   * - Per-id lifecycle requests are serialized. A concurrent `start()`
   *   shares the active start transition, including its eventual failure;
   *   a start after a queued stop waits for that stop first.
   * - Once its transition begins, an already `RUNNING` server is a no-op.
   *
   * @param id - Identifier of the server to start.
   * @returns Promise that resolves when the server is `RUNNING`.
   *
   * @throws {Error} Propagated from two sources:
   *   1. `ServerRegistry.create()` — if the `id` is not registered.
   *   2. `NexusServer.start()` — if the server startup fails.
   */
  public start(id: string): Promise<void> {
    // Publish an instance synchronously so a same-tick stop/drop has an owner
    // to queue behind rather than incorrectly treating the service as absent.
    this.ensureInstance(id);
    return this.enqueueLifecycle(id, 'start', () => this.startOwned(id));
  }

  /** Performs one serialized start transition. */
  private async startOwned(id: string): Promise<void> {
    const server = this.ensureInstance(id);
    if (server.status === ServerStatus.RUNNING) return;
    await server.start();
  }

  /**
   * Stops (graceful shutdown) a server by its `id`.
   *
   * - If the server does not even have a created instance (never started),
   *   resolves silently — nothing to do.
   * - Per-id lifecycle requests are serialized; the call is delegated to the
   *   server rather than trusting a status value that may lag queued work.
   *
   * @param id - Identifier of the server to stop.
   * @returns Promise that resolves when the server reaches `STOPPED`.
   *
   * @throws {Error} Propagates the error from `NexusServer.stop()` if stopping
   *   fails.
   */
  public stop(id: string): Promise<void> {
    return this.enqueueLifecycle(id, 'stop', () => this.stopOwned(id));
  }

  /** Performs one serialized stop transition without trusting a stale status. */
  private async stopOwned(id: string): Promise<void> {
    const server = this.instances.get(id);
    if (!server) return;
    await server.stop();
  }

  /**
   * Restarts a server: first `stop()`, then `start()`.
   *
   * Both steps are idempotent, so calling `restart` on a stopped server
   * works like a `start`.
   *
   * **Note:** `stop` errors are **not** swallowed. If stopping fails,
   * `start` is not even attempted. If you prefer to "force" startup even
   * if stop fails, use `try/catch` in the caller.
   *
   * @param id - Identifier of the server to restart.
   * @returns Promise that resolves when the server is back to `RUNNING`.
   *
   * @throws {Error} Errors propagated from `stop()` or `start()`.
   */
  public restart(id: string): Promise<void> {
    this.ensureInstance(id);
    return this.enqueueLifecycle(id, 'restart', async () => {
      await this.stopOwned(id);
      await this.startOwned(id);
    });
  }

  /**
   * Disposes the cached instance for `id` (if any) and forgets it, so the next
   * `start()` / `getSnapshot()` rebuilds it from the registry factory.
   *
   * **Why this exists (it is not in the upstream Manager):** adapters read
   * their whole configuration in the *constructor* — `TftpAdapter` fixes its
   * `port` there, `DhcpAdapter` copies range/gateway/DNS/static there. A
   * configuration change therefore cannot be applied to a live instance; the
   * instance has to be thrown away so the factory (which reads the current
   * configuration) runs again. Without this, the daemon would serve the first
   * configuration it ever saw for the rest of its lifetime.
   *
   * The instance remains mapped until disposal succeeds. A failed disposal is
   * propagated with the server id and leaves the instance reachable so callers
   * can retry instead of replacing a resource that may still be live.
   *
   * @param id - Server identifier to evict from the instance cache.
   * @returns `true` if an instance existed and was dropped; `false` otherwise.
   * @throws {Error} When disposal fails; the mapped instance is retained.
   */
  public dropInstance(id: string): Promise<boolean> {
    const pending = this.dropOperations.get(id);
    if (pending) return pending;

    // `enqueueLifecycle` defers the user-owned stop/dispose callbacks behind
    // a promise. Store the operation before that microtask runs so a callback
    // that re-enters `dropInstance` shares this exact operation.
    const operation = this.enqueueLifecycle(id, 'drop', () => this.stopDisposeAndDrop(id));
    this.dropOperations.set(id, operation);
    void operation.then(
      () => {
        if (this.dropOperations.get(id) === operation) this.dropOperations.delete(id);
      },
      () => {
        if (this.dropOperations.get(id) === operation) this.dropOperations.delete(id);
      },
    );
    return operation;
  }

  /**
   * Drives the rejecting lifecycle boundary before no-throw disposal, then
   * evicts only after both settled successfully.
   */
  private async stopDisposeAndDrop(id: string): Promise<boolean> {
    const instance = this.instances.get(id);
    if (!instance) return false;
    try {
      await instance.stop();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to stop server '${id}': ${message}`, { cause: err });
    }
    try {
      await instance.dispose();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to dispose server '${id}': ${message}`, { cause: err });
    }
    if (this.instances.get(id) === instance) this.instances.delete(id);
    return true;
  }

  /** Queues one per-server lifecycle transition and keeps that queue reusable after errors. */
  private enqueueLifecycle<T>(
    id: string,
    kind: ManagedLifecycleOperation,
    operation: () => Promise<T>,
  ): Promise<T> {
    const pending = this.lastLifecycleOperations.get(id);
    if (pending?.kind === kind) return pending.promise as Promise<T>;

    const previous = this.lifecycleQueues.get(id) ?? Promise.resolve();
    const promise = previous.then(operation);
    const settledQueue = promise.then(
      () => undefined,
      () => undefined,
    );
    this.lifecycleQueues.set(id, settledQueue);
    const request: QueuedLifecycleOperation = { kind, promise };
    this.lastLifecycleOperations.set(id, request);
    const clear = () => {
      if (this.lastLifecycleOperations.get(id) === request) {
        this.lastLifecycleOperations.delete(id);
        if (this.lifecycleQueues.get(id) === settledQueue) this.lifecycleQueues.delete(id);
      }
    };
    void promise.then(clear, clear);
    return promise;
  }

  /**
   * **Global shutdown operation.** Dispose of **all** managed server
   * instances and clean up the Manager's internal state.
   *
   * Calling this on the application's `SIGTERM` / `beforeExit` guarantees that no
   * socket remains open and no listener hangs (memory leaks).
   *
   * ### Important guarantees:
   * 1. **Never throws.** A failed rejecting cleanup is swallowed here, but
   *    its instance remains mapped for a later retry. Independent instances
   *    still receive their own cleanup attempt.
   * 2. **Removes all listeners** from the Manager itself. After
   *    `disposeAll()`, new `on('statusChange', ...)` calls on the Manager will
   *    not work — it is a terminal operation.
   * 3. Evicts only instances whose stop and disposal both succeed; it does
   *    not touch the `ServerRegistry` (there may be other Managers using the
   *    same registry).
   *
   * **Side effects:**
   * - Routes each instance through `dropInstance()`, including already
   *   pending drops.
   * - `this.removeAllListeners()` — erases all Manager subs.
   *
   * @returns Promise that **always** resolves.
   */
  public async disposeAll(): Promise<void> {
    const ids = Array.from(this.instances.keys());
    for (const id of ids) {
      try {
        await this.dropInstance(id);
      } catch {
        // Best effort continues with independent instances; failed ownership
        // remains mapped so a later explicit drop can retry it.
      }
    }
    this.removeAllListeners();
  }

  /**
   * Builds a `ServerSnapshot` (immutable DTO) for a specific `id`.
   *
   * Three possible scenarios:
   *
   * 1. **Instance already exists** → reads properties directly. For the
   *    `errorMessage` field it uses a safe cast because the `NexusServer` interface does not
   *    expose `lastError` (only `BaseNexusServer` exposes it), but in practice
   *    all concrete Adapters in the project extend the base — so,
   *    if status is ERROR, we try to read `lastError`.
   *
   * 2. **No instance but exists in registry** → creates a temporary
   *    instance, reads metadata, calls `dispose()` immediately. This avoids
   *    duplicating metadata (`name`, `port`) both in the factory and in the registry.
   *
   * 3. **Neither** → throws `Error` with "Unknown server id".
   *
   * @param id - Identifier of the server to snapshot.
   * @returns Immutable `ServerSnapshot` with the server's current state.
   *
   * @throws {Error} If `id` is not known (neither instantiated nor registered).
   *
   * **Side effects (only in case 2):**
   *   - Temporarily invokes `registry.create(id)`.
   *   - Invokes `temp.dispose()` on the temporary instance (fire-and-forget via `void`).
   */
  public getSnapshot(id: string): ServerSnapshot {
    const instance = this.instances.get(id);
    if (instance) {
      return {
        id: instance.id,
        name: instance.name,
        port: instance.port,
        status: instance.status,
        errorMessage: (instance.status === ServerStatus.ERROR)
          ? (instance as unknown as { lastError?: string }).lastError
          : undefined,
      };
    }
    if (this.registry.has(id)) {
      const temp = this.registry.create(id);
      const snap: ServerSnapshot = {
        id: temp.id,
        name: temp.name,
        port: temp.port,
        status: ServerStatus.STOPPED,
      };
      void temp.dispose();
      return snap;
    }
    throw new Error(`Unknown server id: ${id}`);
  }

  /**
   * Returns the existing server instance, or creates it (and binds
   * listeners) if it does not yet exist.
   *
   * This is the Manager's lazy-instantiation core: the first time someone
   * calls `start(id)` or `list()` touches a non-created server,
   * `ensureInstance` invokes the factory, stores the result and — **crucial step** —
   * re-routes that instance's events to the Manager.
   *
   * ### Event re-routing:
   * - Each `server.on('statusChange', ...)` from the server becomes a
   *   `manager.emit('statusChange', { id, status, error })` event — note that the
   *   Manager adds the `id` in the payload so the consumer knows which
   *   server changed.
   * - Each `server.on('log', ...)` becomes `manager.emit('log', id, level, msg)`.
   *
   * @param id - Server identifier.
   * @returns `NexusServer` instance (existing or newly created).
   *
   * @throws {Error} Propagates from `registry.create()` if the `id` is not
   *   registered.
   *
   * **Side effects (only on the first invocation per `id`):**
   *   - Creates instance via `registry.create(id)`.
   *   - Stores it in `this.instances`.
   *   - Registers two permanent listeners on the instance to re-emit events.
   */
  public ensureInstance(id: string): NexusServer {
    const existing = this.instances.get(id);
    if (existing) return existing;

    const server = this.registry.create(id);
    this.instances.set(id, server);

    server.on('statusChange', (status, errorMessage) => {
      const payload: ServerStatusChangeEvent = { id, status, error: errorMessage };
      this.emit('statusChange' as keyof ServerManagerEvents, payload);
    });
    server.on('log', (level, message) => {
      this.emit('log' as keyof ServerManagerEvents, id, String(level), String(message));
    });
    server.on('runtimeUpdate', (final) => {
      this.emit('runtimeUpdate' as keyof ServerManagerEvents, id, final);
    });
    server.on('connection', (event) => {
      this.emit('connection' as keyof ServerManagerEvents, id, event);
    });

    return server;
  }
}
