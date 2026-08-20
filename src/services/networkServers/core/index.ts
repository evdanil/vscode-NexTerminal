/** @author kanekitakitos */

/**
 *
 * # Barrel Export of the `servers` Module + Default Registry Factory
 *
 * This file fulfills two complementary roles:
 *
 * ## 1. Barrel Export (Centralized Re-exportation)
 *
 * It works as the **public entry point** of the `src/servers/` module.
 * Instead of consumers (e.g.: `daemon.ts`, the VS Code UI, tests)
 * importing directly from deep paths like
 * `./core/ServerManager` or `./core/ServerStatus`, all public symbols
 * are re-exported here via `export * from ...`.
 *
 * Advantages of the **barrel** pattern:
 * - **Short and stable paths**: `import { ServerManager } from './servers'`
 *   instead of `'./servers/core/ServerManager'`. Internal files
 *   can be reorganized (e.g.: move `NexusServer` to `/contracts/`)
 *   without breaking consumer imports, just update this barrel.
 * - **Explicit API surface**: everything exported from here is
 *   public contract; what is not here is considered implementation
 *   detail and may be changed without prior notice.
 * - **Circular imports prevented**: the daemon and consumers depend
 *   exclusively on this index, avoiding cross-references between
 *   internal sub-modules.
 *
 * ## 2. `createDefaultRegistry()` — Factory with canonical configuration
 *
 * The `createDefaultRegistry()` function returns a {@link ServerRegistry}
 * already populated with the server adapters that Nexus supports
 * "out of the box": TFTP and DHCP.
 *
 * ### Why a factory and not a `singleton` with module-level const?
 *
 * It is not a **strict singleton** (each call returns a new
 * instance), but rather a **canonical factory**. The distinction is intentional:
 *
 * - **Testability**: unit tests can call
 *   `createDefaultRegistry()` as many times as needed to obtain
 *   "clean" registries, with no shared state between tests.
 * - **Isolation**: if tomorrow there are two `ServerManager`s running
 *   in the same process (e.g.: one in "safe" mode with alternative ports),
 *   each gets its own independent registry.
 * - **Single source of truth**: although not a singleton in terms of
 *   memory, it is **the only place** that knows what the default list of
 *   servers is. Adding a new adapter (e.g.: `FtpAdapter`) requires
 *   changing **only this function** — automatically the daemon, the UI and
 *   the tests will see it.
 *
 * @see {@link ServerManager}   orchestrator of server instances
 * @see {@link ServerRegistry}  container of registered server factories
 */

export * from './ServerStatus';
export * from './NexusServer';
export * from './ServerRegistry';
export * from './ServerManager';
export * from './BaseNexusServer';

import { ServerRegistry } from './ServerRegistry';
import { TftpAdapter, type TftpAdapterConfig } from '../tftp/TftpAdapter';
import { DhcpAdapter, type DhcpAdapterConfig } from '../dhcp/DhcpAdapter';

export type { TftpAdapterConfig } from '../tftp/TftpAdapter';
export type { DhcpAdapterConfig, DhcpVendorSpecificEntry } from '../dhcp/DhcpAdapter';

/**
 * Resolved configuration for the two fixed network services, as the host side
 * (extension host, which alone can read VS Code settings) hands it to the
 * daemon.
 *
 * Both keys are optional: a missing key means "use adapter defaults", which is
 * exactly the behaviour of a bare/headless daemon boot with no configuration
 * pushed yet.
 */
export interface NetworkServerConfigs {
  readonly tftp?: TftpAdapterConfig;
  readonly dhcp?: DhcpAdapterConfig;
}

/**
 * Late-bound configuration accessor.
 *
 * **Why a resolver callback and not a plain `NetworkServerConfigs` value:**
 * adapters read their configuration ONLY in the constructor (port, root, DHCP
 * range, …), and `ServerManager` instantiates lazily through the registry
 * factory. Passing a snapshot object at `createDefaultRegistry()` time would
 * freeze the very first configuration for the lifetime of the process — which
 * is the original bug this port fixes, one layer up. A resolver is invoked at
 * *factory* time instead, so the daemon's mutable configuration store is read
 * whenever an adapter instance is (re)built.
 */
export type NetworkServerConfigResolver = () => NetworkServerConfigs;

/**
 * Creates a {@link ServerRegistry} pre-configured with all
 * server adapters supported by Nexus.
 *
 * Currently registered services:
 * - `'tftp'` — TFTP server (UDP), implemented by {@link TftpAdapter}.
 * - `'dhcp'` — DHCP server, implemented by {@link DhcpAdapter}.
 *
 * Each invocation returns a **new and independent** instance (it is
 * not a global singleton), ensuring isolation between tests and scenarios
 * with multiple managers.
 *
 * @param resolve - Optional late-bound accessor for the resolved TFTP/DHCP
 *   configuration. Invoked once per adapter construction, so a mutable store
 *   behind it is always read fresh. Omitted (or returning `{}`) means the
 *   adapters fall back to their built-in defaults — this is what keeps the
 *   daemon spawnable as a bare Node script with no configuration at all.
 * @returns New `ServerRegistry` instance with the default factories registered.
 *
 * @example
 * // Typical usage in the daemon
 * const manager = new ServerManager(createDefaultRegistry());
 *
 * @example
 * // Adding a custom server at runtime
 * const reg = createDefaultRegistry();
 * reg.register('my-svc', () => new MyCustomServer());
 * const mgr = new ServerManager(reg);
 */
export function createDefaultRegistry(resolve?: NetworkServerConfigResolver): ServerRegistry {
  const registry = new ServerRegistry();
  registry.register('tftp', () => new TftpAdapter(resolve?.().tftp ?? {}));
  registry.register('dhcp', () => new DhcpAdapter(resolve?.().dhcp ?? {}));
  return registry;
}
