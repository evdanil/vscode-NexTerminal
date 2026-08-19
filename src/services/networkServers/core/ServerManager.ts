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
   * and discards it. Since creation is lazy and `dispose()` on a
   * `STOPPED` server is a no-op, this has no noticeable overhead.
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
   * - Idempotent: if already `RUNNING` or `STARTING`, returns immediately
   *   without doing anything (no warnings, no errors).
   *
   * @param id - Identifier of the server to start.
   * @returns Promise that resolves when the server is `RUNNING`.
   *
   * @throws {Error} Propagated from two sources:
   *   1. `ServerRegistry.create()` — if the `id` is not registered.
   *   2. `NexusServer.start()` — if the server startup fails.
   */
  public async start(id: string): Promise<void> {
    const server = this.ensureInstance(id);
    if (server.status === ServerStatus.RUNNING || server.status === ServerStatus.STARTING) return;
    await server.start();
  }

  /**
   * Stops (graceful shutdown) a server by its `id`.
   *
   * - If the server does not even have a created instance (never started),
   *   returns silently — nothing to do.
   * - Idempotent: if already `STOPPED` or `STOPPING`, returns immediately.
   *
   * @param id - Identifier of the server to stop.
   * @returns Promise that resolves when the server reaches `STOPPED`.
   *
   * @throws {Error} Propagates the error from `NexusServer.stop()` if stopping
   *   fails.
   */
  public async stop(id: string): Promise<void> {
    const server = this.instances.get(id);
    if (!server) return;
    if (server.status === ServerStatus.STOPPED || server.status === ServerStatus.STOPPING) return;
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
  public async restart(id: string): Promise<void> {
    await this.stop(id);
    await this.start(id);
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
   * Never throws — a failing `dispose()` still results in the instance being
   * forgotten, which is the outcome the caller actually needs.
   *
   * @param id - Server identifier to evict from the instance cache.
   * @returns `true` if an instance existed and was dropped; `false` otherwise.
   */
  public async dropInstance(id: string): Promise<boolean> {
    const instance = this.instances.get(id);
    if (!instance) return false;
    this.instances.delete(id);
    try {
      await instance.dispose();
    } catch {
      // swallow; the instance is already unreachable from the Manager
    }
    return true;
  }

  /**
   * **Global shutdown operation.** Dispose of **all** managed server
   * instances and clean up the Manager's internal state.
   *
   * Calling this on the application's `SIGTERM` / `beforeExit` guarantees that no
   * socket remains open and no listener hangs (memory leaks).
   *
   * ### Important guarantees:
   * 1. **Never throws.** Any individual `dispose()` error is swallowed —
   *    the goal is to clean everything up, even if something fails midway.
   * 2. **Removes all listeners** from the Manager itself. After
   *    `disposeAll()`, new `on('statusChange', ...)` calls on the Manager will
   *    not work — it is a terminal operation.
   * 3. Clears the instance `Map`, but does **not** touch the `ServerRegistry`
   *    (there may be other Managers using the same registry).
   *
   * **Side effects:**
   * - Calls `dispose()` on each live instance.
   * - Clears `this.instances`.
   * - `this.removeAllListeners()` — erases all Manager subs.
   *
   * @returns Promise that **always** resolves.
   */
  public async disposeAll(): Promise<void> {
    const ids = Array.from(this.instances.keys());
    for (const id of ids) {
      try {
        const instance = this.instances.get(id);
        if (instance) {
          await instance.dispose();
        }
      } catch {
        // swallow; we're shutting down
      }
    }
    this.instances.clear();
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
