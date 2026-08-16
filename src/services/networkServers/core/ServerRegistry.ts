/** @author kanekitakitos */

import type { NexusServer } from './NexusServer';

/**
 * Factory function that creates a **new** `NexusServer` instance when invoked.
 *
 * **Why factories instead of registering instances directly (KISS + DI):**
 *
 * - **Lazy instantiation:** The `ServerManager` only creates the server when someone
 *   actually starts it. If we registered already-built instances,
 *   we would occupy memory and perhaps open DB connections for servers that
 *   will never be used.
 * - **Multiple instances:** A factory can be called multiple times to
 *   produce independent instances (useful in tests, or for sharding scenarios).
 * - **Inversion of Control (IoC):** The `ServerRegistry` does not know *how* to build
 *   a specific HTTP server — whoever provides the factory is the root composition
 *   of the application. The Registry only knows *how to store* and *retrieve* factories.
 *
 * Registration example:
 * ```ts
 * registry.register('http-api', () =>
 *   new ExpressHttpServer('http-api', 'REST API', 3000, router)
 * );
 * ```
 */
export type NexusServerFactory = () => NexusServer;

/**
 * Centralized registry of server factories. Implements the
 * **Registry** pattern — a "directory" where a server name (`id`) maps to
 * the function that knows how to build it.
 *
 * ## Why this (Ports & Adapters + KISS)?
 *
 * In Hexagonal architecture, the Registry is a Port on the *composition* side. The core
 * application (e.g.: `ServerManager`) should not know how to import `ExpressHttpServer`
 * directly — that would create a dependency from the core to a concrete Adapter,
 * breaking the architecture.
 *
 * Instead:
 * 1. The **composition root** (the `main.ts` file or similar) imports all
 *    concrete Adapters and registers them here with `registry.register(...)`.
 * 2. The `ServerManager` receives this Registry via constructor and only calls
 *    `registry.create('http-api')` — never knowing that Express exists.
 *
 * Result: switching from Express to Fastify is one line in the composition root;
 * the Manager and the rest of the core don't even notice.
 *
 * **KISS:** The implementation uses a native `Map`. No complex dependency injection,
 * no decorators, no reflect-metadata. Just the minimum.
 */
export class ServerRegistry {
  private readonly factories: Map<string, NexusServerFactory> = new Map();

  /**
   * Registers a server factory associated with a unique `id`.
   *
   * @param id - Unique (case-sensitive) server identifier. Cannot already
   *   exist in the registry.
   * @param factory - Argument-less function that, when invoked, returns a
   *   **new** `NexusServer` instance.
   * @returns The Registry instance itself, for chaining:
   *   ```ts
   *   registry.register('a', factoryA).register('b', factoryB);
   *   ```
   *
   * @throws {Error} If `id` is already registered. Message:
   *   `Server '${id}' is already registered.`
   */
  public register(id: string, factory: NexusServerFactory): this {
    if (this.factories.has(id)) {
      throw new Error(`Server '${id}' is already registered.`);
    }
    this.factories.set(id, factory);
    return this;
  }

  /**
   * Removes a server from the registry. Does not affect instances already created by the
   * `ServerManager` — only prevents new creations.
   *
   * @param id - Identifier to remove.
   * @returns `true` if the `id` existed and was removed; `false` if it did not exist.
   */
  public unregister(id: string): boolean {
    return this.factories.delete(id);
  }

  /**
   * Checks whether a given `id` is registered.
   *
   * @param id - Identifier to search for.
   * @returns `true` if there is a factory registered for this `id`.
   */
  public has(id: string): boolean {
    return this.factories.has(id);
  }

  /**
   * Invokes the factory registered for `id` and returns a **new** instance of
   * `NexusServer`.
   *
   * Each call produces a fresh instance; the Registry does not cache
   * instances (that is the job of the `ServerManager`).
   *
   * @param id - Identifier of the server to create.
   * @returns New `NexusServer` instance built by the factory.
   *
   * @throws {Error} If `id` is not registered. Message:
   *   `Server '${id}' not found in registry.`
   */
  public create(id: string): NexusServer {
    const factory = this.factories.get(id);
    if (!factory) {
      throw new Error(`Server '${id}' not found in registry.`);
    }
    return factory();
  }

  /**
   * Returns a read-only copy of all currently registered `id`s.
   *
   * **Why a new array instead of `IterableIterator` (KISS):**
   * - A `string[]` is universally serializable, compatible with `for...of`,
   *   `.map()`, `.filter()` and any UI. The caller does not need to know
   *   that the implementation uses `Map`.
   * - Since we return a copy, the caller cannot accidentally mutate the
   *   internal state of the Registry.
   *
   * @returns List of registered `id`s, in a new array. Empty if there are no registrations.
   */
  public listIds(): readonly string[] {
    return Array.from(this.factories.keys());
  }
}
