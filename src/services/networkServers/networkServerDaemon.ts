/** @author kanekitakitos */

/**
 *
 * # Nexus Daemon Process — UI Bridge (VS Code) ↔ Local Services
 *
 * This module implements an independent Node process (daemon) that manages
 * Nexus local services (TFTP, DHCP, etc.) and communicates with the VS Code
 * UI through **JSON lines** over `stdin` / `stdout`.
 *
 * ## Why JSON lines on stdin/stdout and not Named Pipes / sockets / IPC?
 *
 * **KISS (Keep It Simple, Stupid)** — the line-by-line approach on
 * `stdio` has decisive advantages for this use case:
 *
 * 1. **Full cross-platform portability**: `stdin/stdout` work
 *    identically on Windows, Linux and macOS without any conditional code.
 *    Windows Named Pipes expose complex ACLs, specific path names
 *    (`\\.\pipe\...`) and UAC permissions that make communication
 *    prone to permission failures, especially when the UI (VS Code)
 *    and the daemon run with different privilege levels
 *    (e.g.: TFTP running on port 69 which requires Admin).
 *
 * 2. **Each message = 1 line = 1 JSON-RPC style object**: the protocol
 *    is self-delimited by `\n`, so there is no need to implement
 *    manual framing (e.g.: length-prefix) nor handle partially
 *    received messages. Node's `readline` module handles all
 *    buffering and line parsing.
 *
 * 3. **Trivial debugging**: we can run the daemon manually in a
 *    terminal, paste JSON and see responses immediately. All
 *    traffic is human-readable; unlike binary sockets or
 *    Electron IPC.
 *
 * 4. **VS Code ↔ daemon Bridge**: the main extension process
 *    (`extension.ts`) does `spawn()` of this daemon as a child process and
 *    uses `stdout.on('data')` + `readline` to receive events and
 *    responses, while writing requests to `stdin`. The lifecycle
 *    becomes linked: when VS Code closes, `stdin` closes and the daemon
 *    shuts down gracefully.
 *
 * ## Protocol format
 *
 * **Request (stdin):** JSON object with `{id, method, params?}` —
 * JSON-RPC 2.0 style (but without `jsonrpc: "2.0"` to keep overhead minimal).
 *
 * **Response / Event (stdout):** one of three forms, also on a single
 * JSON line:
 *
 * - Result: `{id, result}`
 * - Error:  `{id, error: {code, message}}`
 * - Event:  `{event, data}` (no `id`; async push from the daemon)
 *
 * Emitted events: `ready`, `statusChange`, `log`.
 *
 * @see {@link JsonRpcRequest}   format of requests received by the daemon
 * @see {@link JsonLine}         format of lines written to stdout
 */

import { createInterface } from 'node:readline';
import { env, stdin, stdout } from 'node:process';
import { DhcpAdapter, type DhcpLeaseInfo } from './dhcp/DhcpAdapter';
import { TftpAdapter, type TftpTransferInfo } from './tftp/TftpAdapter';
import { createRuntimeUpdateThrottle } from './runtimeUpdateThrottle';
import {
  ServerManager,
  ServerStatus,
  createDefaultRegistry,
  type DhcpAdapterConfig,
  type NetworkServerConfigs,
  type ServerSnapshot,
  type ServerStatusChangeEvent,
  type TftpAdapterConfig,
} from './core/index';

/**
 * Name of the environment variable through which the host seeds the daemon's
 * initial configuration at spawn time.
 *
 * ## Why configuration arrives from outside at all
 *
 * This process has **no access to the `vscode` module** — it is a bare Node
 * script, deliberately so (see the module header: it may even run at a
 * different privilege level than the extension host). It therefore cannot read
 * `nexus.networkServers.*` settings itself. Every piece of configuration must
 * be pushed in from the host side, and this daemon is the passive recipient.
 *
 * ## Why both an env var *and* an RPC
 *
 * - **Env var (this constant)** covers the window between `spawn()` and the
 *   first RPC. Without it a `list` issued right after `ready` would report the
 *   *default* TFTP port 69 even when the user configured 6900 — a wrong port
 *   rendered in the UI before anything has been started.
 * - **`configure` RPC + per-`start` config** covers everything after that,
 *   including live settings changes, and is the authoritative path. It is not
 *   optional: env is a one-shot snapshot and cannot be updated in place.
 *
 * Both feed the exact same {@link configStore}, so there is a single code path
 * that applies configuration regardless of how it arrived.
 */
const CONFIG_ENV_VAR = 'NEXUS_NETWORK_SERVERS_CONFIG';

/**
 * Request received via stdin in simplified JSON-RPC format.
 *
 * @property id     — unique request identifier (integer number).
 *                    The response will have the same `id` for matching.
 * @property method — name of the RPC method to invoke on {@link ServerManager}.
 * @property params — optional parameters (key/value object).
 */
type JsonRpcRequest = {
  readonly id: number;
  readonly method: 'list' | 'start' | 'stop' | 'restart' | 'getStatus' | 'getServiceRuntime' | 'configure';
  readonly params?: Record<string, unknown>;
};

/**
 * Success response to a {@link JsonRpcRequest}.
 *
 * @property id     — same `id` as the corresponding request.
 * @property result — result payload (variable type depending on method).
 */
type JsonRpcResult = {
  readonly id: number;
  readonly result: unknown;
};

/**
 * Error response to a {@link JsonRpcRequest}.
 *
 * @property id    — same `id` as the corresponding request.
 * @property error — descriptive error object with code and message.
 */
type JsonRpcError = {
  readonly id: number;
  readonly error: { readonly code: string; readonly message: string };
};

/**
 * Asynchronous event sent by the daemon without matching a request.
 *
 * Variants:
 * - `statusChange` — a server changed state (running ↔ stopped ↔ error).
 * - `log`          — log line emitted by a server or by the daemon itself.
 * - `ready`        — daemon initialized and ready to receive requests.
 * - `runtimeUpdate`— mutable runtime changed (TFTP transfers / DHCP leases).
 *                    Coalesced per id before it reaches stdout — see
 *                    {@link createRuntimeUpdateThrottle}.
 */
type JsonRpcEvent =
  | { readonly event: 'statusChange'; readonly data: ServerStatusChangeEvent }
  | { readonly event: 'log'; readonly data: { readonly id: string; readonly level: string; readonly message: string } }
  | { readonly event: 'ready'; readonly data: null }
  | { readonly event: 'runtimeUpdate'; readonly data: { readonly id: string } };

/**
 * Union of all message types the daemon writes to stdout.
 * Each instance is serialized as **a single JSON line** followed by `\n`.
 */
type JsonLine = JsonRpcResult | JsonRpcError | JsonRpcEvent;

/**
 * Serializes a {@link JsonLine} object and writes it as **one line**
 * to the process `stdout`.
 *
 * Silently ignores write failures — if stdout is already closed
 * (VS Code end disconnected) there is no recovery action.
 *
 * @param obj — message to send to the parent process (VS Code UI).
 */
function writeLine(obj: JsonLine): void {
  try {
    stdout.write(JSON.stringify(obj) + '\n');
  } catch {
    // stdout unavailable; nothing we can do
  }
}

/**
 * Helper that emits a `log` event from the `daemon` source.
 *
 * Used for internal messages of the daemon process itself (e.g.: start
 * of shutdown, invalid JSON line, etc.).
 *
 * @param level   — log severity level (`info`, `warn`, `error`, …).
 * @param message — descriptive text of the event. Automatically prefixed
 *                  with `[daemon]` to facilitate filtering in the UI.
 */
function logDaemon(level: string, message: string): void {
  writeLine({
    event: 'log',
    data: { id: 'daemon', level, message: `[daemon] ${message}` },
  });
}

/**
 * Main entry point of the daemon process.
 *
 * Responsibilities:
 * 1. Instantiates {@link ServerManager} with the default registry (TFTP + DHCP).
 * 2. Binds Manager's `statusChange` and `log` events to stdout (bridge).
 * 3. Installs `SIGINT` / `SIGTERM` and `stdin close` handlers for
 *    graceful shutdown (releases all server ports).
 * 4. Creates a `readline` interface over `stdin` to receive JSON lines
 *    and dispatch them to {@link handleRequest}.
 * 5. Sends the `ready` event to signal to VS Code that it is operational.
 *
 * The function returns a Promise that only resolves on shutdown; however
 * the entry-point calls it with `void run()` because the lifecycle
 * is controlled by events and `process.exit()`.
 */
async function run(): Promise<void> {
  /**
   * The daemon's single source of truth for service configuration.
   *
   * Mutable on purpose: adapters bake their configuration in at construction
   * time, so applying a change means replacing the instance, not mutating it.
   * The registry factories read *this* object lazily (see the resolver passed
   * to `createDefaultRegistry` below), so a rebuilt adapter always picks up
   * whatever configuration is current at that moment.
   */
  const configStore: { tftp?: TftpAdapterConfig; dhcp?: DhcpAdapterConfig } = {};

  const manager = new ServerManager(
    createDefaultRegistry(() => ({ tftp: configStore.tftp, dhcp: configStore.dhcp })),
  );

  /**
   * Ids whose stored configuration changed while the service was still running,
   * so the cached adapter could not be evicted at that moment.
   *
   * `ServerManager.stop()` deliberately keeps the instance cached, and the
   * value-equality check in {@link applyConfigs} short-circuits on any later
   * re-send of the same values — so without remembering the miss here, that
   * adapter would keep being restarted from the configuration it was originally
   * built with, and the user's edit would never take effect.
   */
  const staleConfigIds = new Set<string>();

  /**
   * Drops the cached adapter for `id` when it is idle, so the next `start()`
   * rebuilds it from current configuration.
   *
   * A live service is left alone — silently rebuilding it would drop active
   * TFTP transfers and DHCP leases without the user asking — and is recorded as
   * stale so the eviction happens as soon as it stops.
   */
  const evictIfIdle = async (id: string): Promise<void> => {
    const instance = manager.getInstance(id);
    if (!instance) {
      staleConfigIds.delete(id);
      return;
    }
    if (instance.status === ServerStatus.RUNNING || instance.status === ServerStatus.STARTING) {
      staleConfigIds.add(id);
      return;
    }
    await manager.dropInstance(id);
    staleConfigIds.delete(id);
  };

  /**
   * Merges incoming configuration into {@link configStore} and evicts any
   * cached adapter instance whose configuration just changed, so the next
   * `start()` rebuilds it from the new values.
   *
   * A **running** service is deliberately left untouched: silently rebuilding
   * a live server would drop active TFTP transfers and DHCP leases without the
   * user asking for it. The new configuration is stored regardless and takes
   * effect on the next `restart`/`stop`+`start` — which is exactly what the
   * host does when the user edits settings and restarts the service.
   *
   * @param configs - Partial configuration; absent keys are left alone, so a
   *   `start` carrying only `tftp` config cannot clobber the DHCP settings.
   * @returns The ids whose stored configuration actually changed.
   */
  const applyConfigs = async (configs: NetworkServerConfigs): Promise<string[]> => {
    const changed: string[] = [];
    for (const id of ['tftp', 'dhcp'] as const) {
      const incoming = configs[id];
      if (incoming === undefined) continue;
      if (JSON.stringify(configStore[id] ?? null) === JSON.stringify(incoming)) continue;
      // Both branches assign the same union member the key was read from; TS
      // cannot follow that through the indexed access, hence the narrow cast.
      (configStore as Record<string, unknown>)[id] = incoming;
      changed.push(id);
      await evictIfIdle(id);
    }
    return changed;
  };

  /**
   * Reads the spawn-time configuration seed, if the host provided one.
   * A malformed or absent value is not fatal — the daemon simply starts on
   * adapter defaults and waits for the host's `configure` RPC.
   */
  const seedConfigFromEnv = async (): Promise<void> => {
    const raw = env[CONFIG_ENV_VAR];
    if (!raw) return;
    try {
      const parsed = JSON.parse(raw) as NetworkServerConfigs;
      if (parsed && typeof parsed === 'object') {
        await applyConfigs(parsed);
      }
    } catch (err) {
      logDaemon('warn', `Ignored malformed ${CONFIG_ENV_VAR}: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  manager.on('statusChange', (evt) => {
    writeLine({ event: 'statusChange', data: evt });
  });
  manager.on('log', (id, level, message) => {
    writeLine({ event: 'log', data: { id, level, message } });
  });
  const runtimeUpdates = createRuntimeUpdateThrottle((id) => {
    writeLine({ event: 'runtimeUpdate', data: { id } });
  });

  manager.on('runtimeUpdate', (id: string, final?: boolean) => {
    runtimeUpdates.push(id, final);
  });

  /**
   * Shuts down the daemon in an orderly manner:
   * 1. Logs the reason.
   * 2. Calls `disposeAll()` on the Manager to stop all servers
   *    and release resources (UDP/TCP sockets, ports, etc.).
   * 3. Terminates the process with exit-code 0.
   *
   * @param reason — text identifying the shutdown source
   *                 (`SIGINT`, `SIGTERM`, `stdin closed`).
   */
  const shutdown = async (reason: string): Promise<void> => {
    logDaemon('info', `Shutting down (${reason})...`);
    runtimeUpdates.flush();
    try {
      await manager.disposeAll();
    } catch {
      // ignore
    }
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT').catch((err) => process.stderr.write('shutdown error: ' + (err instanceof Error ? err.message : String(err)) + '\n')));
  process.on('SIGTERM', () => void shutdown('SIGTERM').catch((err) => process.stderr.write('shutdown error: ' + (err instanceof Error ? err.message : String(err)) + '\n')));

  /**
   * Dispatches a {@link JsonRpcRequest} to the corresponding operation
   * on {@link ServerManager} and returns the response (success or error).
   *
   * Supported methods:
   * - `list`      — returns `ServerSnapshot[]` with all registered servers.
   * - `getStatus` — returns `ServerSnapshot` of a specific server (`params.id`).
   * - `start`     — starts a server by ID.
   * - `stop`      — stops a server by ID.
   * - `restart`   — stops and restarts a server by ID.
   *
   * All errors (both "not found" and unexpected exceptions) are
   * converted to {@link JsonRpcError} with a string `code` and `message`.
   *
   * @param req — already validated JSON-RPC request (`id` and `method` fields exist).
   * @returns Promise with the response (formatted result or error).
   */
  /**
   * Applies the optional `config` payload that rides along with a `start` /
   * `restart` request, scoped to that request's service id.
   *
   * This is what makes "start reads the *current* settings" true: the host
   * resolves `nexus.networkServers.<kind>.*` immediately before issuing the
   * call, so the adapter that gets built is always in sync with what the user
   * sees in the settings UI — no daemon restart required, and no stale
   * configuration surviving from a previous run.
   *
   * @param id - Service id the request targets (`tftp` / `dhcp`).
   * @param params - Raw RPC params; `params.config` is used when present.
   */
  const applyRequestConfig = async (id: string, params?: Record<string, unknown>): Promise<void> => {
    const config = params?.['config'];
    if (!config || typeof config !== 'object') return;
    if (id !== 'tftp' && id !== 'dhcp') return;
    await applyConfigs({ [id]: config } as NetworkServerConfigs);
  };

  const handleRequest = async (req: JsonRpcRequest): Promise<JsonRpcResult | JsonRpcError> => {
    try {
      switch (req.method) {
        case 'list': {
          const list: readonly ServerSnapshot[] = manager.list();
          return { id: req.id, result: list };
        }
        case 'getStatus': {
          const id = String(req.params?.['id'] ?? '');
          const found = manager.list().find((s) => s.id === id);
          if (!found) {
            return {
              id: req.id,
              error: { code: 'NOT_FOUND', message: `Server '${id}' not found.` },
            };
          }
          return { id: req.id, result: found };
        }
        case 'configure': {
          const configs = (req.params?.['configs'] ?? {}) as NetworkServerConfigs;
          const changed = await applyConfigs(configs);
          return { id: req.id, result: { ok: true, changed } };
        }
        case 'start': {
          const id = String(req.params?.['id'] ?? '');
          await applyRequestConfig(id, req.params);
          if (staleConfigIds.has(id)) await evictIfIdle(id);
          await manager.start(id);
          return { id: req.id, result: { ok: true, id } };
        }
        case 'stop': {
          const id = String(req.params?.['id'] ?? '');
          await manager.stop(id);
          return { id: req.id, result: { ok: true, id } };
        }
        case 'restart': {
          const id = String(req.params?.['id'] ?? '');
          // Stop first, THEN apply: applyConfigs deliberately refuses to evict
          // a running instance, so configuring before stopping would leave the
          // old instance in place and restart it with stale settings.
          await manager.stop(id);
          await applyRequestConfig(id, req.params);
          // Picks up a `configure` that landed while the service was running:
          // the eviction it could not do back then happens now that it is idle.
          if (staleConfigIds.has(id)) await evictIfIdle(id);
          await manager.start(id);
          return { id: req.id, result: { ok: true, id } };
        }
        case 'getServiceRuntime': {
          const id = String(req.params?.['id'] ?? '');
          try {
            const instance = manager.ensureInstance(id);
            const snapshot = manager.getSnapshot(id);

            if (id === 'dhcp') {
              const dhcp = instance as DhcpAdapter;
              const leases: readonly DhcpLeaseInfo[] = dhcp.activeLeases();
              const packetCounters = dhcp.packetCounters;
              const poolInfo = dhcp.poolInfo;
              const boundPort = dhcp.boundPort;
              return { id: req.id, result: { snapshot, leases, packetCounters, poolInfo, boundPort } };
            }
            if (id === 'tftp') {
              const tftp = instance as TftpAdapter;
              const transfers: readonly TftpTransferInfo[] = tftp.activeTransfers();
              const root = tftp.root;
              const allowWrite = tftp.allowWrite;
              const boundPort = tftp.boundPort ?? tftp.port;
              return { id: req.id, result: { snapshot, transfers, root, allowWrite, boundPort } };
            }

            return {
              id: req.id,
              error: { code: 'NOT_FOUND', message: `Service '${id}' does not support runtime info.` },
            };
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            if (/Unknown server id|not registered/i.test(message)) {
              return {
                id: req.id,
                error: { code: 'NOT_FOUND', message: `Server '${id}' not found.` },
              };
            }
            throw err;
          }
        }
        default: {
          return {
            id: req.id,
            error: { code: 'METHOD_NOT_FOUND', message: `Unknown method: ${String(req.method)}` },
          };
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { id: req.id, error: { code: 'INTERNAL_ERROR', message } };
    }
  };

  const rl = createInterface({ input: stdin, output: undefined });

  rl.on('line', async (raw) => {
    try {
      const line = raw.trim();
      if (!line) return;
      let req: JsonRpcRequest;
      try {
        req = JSON.parse(line) as JsonRpcRequest;
      } catch {
        logDaemon('warn', `Ignored invalid JSON line: ${line.slice(0, 160)}`);
        return;
      }
      if (typeof req.id !== 'number' || typeof req.method !== 'string') {
        logDaemon('warn', `Ignored malformed request: missing id/method.`);
        return;
      }
      const response = await handleRequest(req);
      writeLine(response);
    } catch (err) {
      try {
        process.stderr.write('line handler error: ' + (err instanceof Error ? err.message : String(err)) + '\n');
      } catch {}
    }
  });

  rl.on('close', () => void shutdown('stdin closed').catch((err) => process.stderr.write('shutdown error: ' + (err instanceof Error ? err.message : String(err)) + '\n')));

  // Seed BEFORE announcing readiness: the host may fire `list` the instant it
  // sees `ready`, and that snapshot must already reflect configured ports.
  await seedConfigFromEnv();

  writeLine({ event: 'ready', data: null });
}

void run();
