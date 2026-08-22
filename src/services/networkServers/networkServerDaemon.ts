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
 *    received messages. The shared bounded reader owns buffering and line
 *    framing before the closed request parser sees a value.
 *
 * 3. **Trivial debugging**: we can run the daemon manually in a
 *    terminal, paste JSON and see responses immediately. All
 *    traffic is human-readable; unlike binary sockets or
 *    Electron IPC. A bounded line reader enforces the wire-size limit
 *    before JSON parsing, so a malformed peer cannot make stdin buffering
 *    unbounded.
 *
 * 4. **VS Code ↔ daemon Bridge**: the main extension process
 *    (`extension.ts`) does `spawn()` of this daemon as a child process and
 *    uses the shared bounded byte-oriented reader to receive events and
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
 * Emitted events: `ready`, `statusChange`, `log`, `runtimeUpdate`, `connection`.
 *
 * @see {@link RpcRequest}       format of requests received by the daemon
 * @see {@link RpcEnvelope}      format of response lines written to stdout
 */

import { env, stdin, stdout } from 'node:process';
import { attachBoundedLineReader } from './boundedLineReader';
import { BoundedJsonLineWriter } from './boundedJsonLineWriter';
import { DhcpAdapter, type DhcpLeaseInfo } from './dhcp/DhcpAdapter';
import { TftpAdapter, type TftpTransferView } from './tftp/TftpAdapter';
import { createRuntimeUpdateThrottle } from './runtimeUpdateThrottle';
import { parseNetworkServerConfigs } from './networkServerConfigValidation';
import { NetworkServerConfigController, type NetworkServerConfigStore } from './networkServerConfigController';
import { createNetworkServerDaemonShutdown } from './networkServerDaemonShutdown';
import {
  parseRpcEnvelope,
  parseRpcEvent,
  parseRpcRequest,
  rpcResultParsers,
  MAX_RPC_TEXT_BYTES,
  type RpcEnvelope,
  type RpcEvent,
  type RpcLogLevel,
  type RpcMethod,
  type RpcRequest,
} from './networkServerRpcProtocol';
import { ServiceWorkflowQueue } from './networkServerWorkflowQueue';
import {
  ServerManager,
  createDefaultRegistry,
  type DhcpAdapterConfig,
  type NetworkServerConfigs,
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
 * Serializes a closed protocol envelope/event and writes it as **one line**
 * to the process `stdout` through the owned bounded writer.
 *
 * Serialized payload bytes exclude the trailing newline delimiter. Oversized
 * responses are converted to closed errors; terminal transport loss enters
 * the daemon shutdown authority.
 *
 * @param obj — message to send to the parent process (VS Code UI).
 */
let daemonWriter: BoundedJsonLineWriter | undefined;

function writeLine(obj: RpcEnvelope | RpcEvent): void {
  const parsed = 'id' in obj ? parseRpcEnvelope(obj) : parseRpcEvent(obj);
  if (!parsed.ok) return;
  daemonWriter?.write(parsed.value);
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
function logDaemon(level: RpcLogLevel, message: string): void {
  writeLine({
    event: 'log',
    data: { id: 'daemon', level, message: `[daemon] ${message}` },
  });
}

/** The fallback response id is never assigned by the host. */
function responseIdFor(value: unknown): number {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return 0;
  if (!Object.prototype.hasOwnProperty.call(value, 'id')) return 0;
  const id = (value as { readonly id?: unknown }).id;
  return typeof id === 'number' && Number.isSafeInteger(id) && id >= 0 ? id : 0;
}

function invalidRequest(id: number, message: string): RpcEnvelope {
  return { id, error: { code: 'INVALID_REQUEST', message } };
}

function internalError(id: number, error: unknown): RpcEnvelope {
  const message = error instanceof Error ? error.message : String(error);
  let bounded = '';
  let bytes = 0;
  for (const character of message) {
    const characterBytes = Buffer.byteLength(character, 'utf8');
    if (bytes + characterBytes > MAX_RPC_TEXT_BYTES) break;
    bounded += character;
    bytes += characterBytes;
  }
  return { id, error: { code: 'INTERNAL_ERROR', message: bounded || 'Daemon operation failed.' } };
}

function resultEnvelope(id: number, method: RpcMethod, result: unknown): RpcEnvelope {
  let wireResult: unknown;
  try {
    wireResult = JSON.parse(JSON.stringify(result));
  } catch {
    return { id, error: { code: 'INTERNAL_ERROR', message: 'Daemon produced an invalid RPC result.' } };
  }
  const parsed = (rpcResultParsers[method] as (value: unknown) => { readonly ok: boolean; readonly value?: unknown })(wireResult);
  return parsed.ok
    ? { id, result: parsed.value as never }
    : { id, error: { code: 'INTERNAL_ERROR', message: 'Daemon produced an invalid RPC result.' } };
}

/**
 * Main entry point of the daemon process.
 *
 * Responsibilities:
 * 1. Instantiates {@link ServerManager} with the default registry (TFTP + DHCP).
 * 2. Binds Manager's `statusChange` and `log` events to stdout (bridge).
 * 3. Installs `SIGINT` / `SIGTERM` and `stdin close` handlers for
 *    graceful shutdown (releases all server ports).
 * 4. Attaches a bounded line reader over `stdin`, validates each JSON value
 *    through the closed RPC parser, and dispatches only accepted requests.
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
  const configStore: NetworkServerConfigStore = {};

  const manager = new ServerManager(
    createDefaultRegistry(() => ({ tftp: configStore.tftp, dhcp: configStore.dhcp })),
  );
  const configController = new NetworkServerConfigController(manager, configStore);
  const serviceWorkflows = new ServiceWorkflowQueue();

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
  const applyConfig = async (
    id: 'tftp' | 'dhcp',
    config: TftpAdapterConfig | DhcpAdapterConfig,
  ): Promise<boolean> => configController.apply(id, config);

  const applyConfigs = async (configs: NetworkServerConfigs): Promise<string[]> => {
    const changed: string[] = [];
    if (configs.tftp !== undefined && await applyConfig('tftp', configs.tftp)) changed.push('tftp');
    if (configs.dhcp !== undefined && await applyConfig('dhcp', configs.dhcp)) changed.push('dhcp');
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
      const parsed = parseNetworkServerConfigs(JSON.parse(raw));
      if (!parsed.ok) {
        logDaemon('warn', `Rejected malformed ${CONFIG_ENV_VAR}: ${parsed.errors.join('; ')}`);
        return;
      }
      await serviceWorkflows.enqueueMany(['tftp', 'dhcp'], () => applyConfigs(parsed.value));
    } catch (err) {
      logDaemon('warn', `Rejected malformed ${CONFIG_ENV_VAR}: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  manager.on('statusChange', (evt) => {
    if (evt.id !== 'tftp' && evt.id !== 'dhcp') return;
    writeLine(evt.error === undefined
      ? { event: 'statusChange', data: { id: evt.id, status: evt.status } }
      : { event: 'statusChange', data: { id: evt.id, status: evt.status, error: evt.error } });
  });
  manager.on('log', (id, level, message) => {
    if ((id !== 'tftp' && id !== 'dhcp') || !['trace', 'debug', 'info', 'warn', 'error'].includes(level)) return;
    writeLine({ event: 'log', data: { id, level: level as RpcLogLevel, message } });
  });
  const runtimeUpdates = createRuntimeUpdateThrottle((id) => {
    if (id === 'tftp' || id === 'dhcp') writeLine({ event: 'runtimeUpdate', data: { id } });
  });

  manager.on('runtimeUpdate', (id: string, final?: boolean) => {
    runtimeUpdates.push(id, final);
  });

  manager.on('connection', (id: string, connection) => {
    if (id === 'tftp' || id === 'dhcp') writeLine({ event: 'connection', data: { id, connection } });
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
  let detachInput: (() => void) | undefined;
  let onStdinEnd: () => void = () => undefined;
  const writeShutdownError = (err: unknown): void => {
    try {
      process.stderr.write('shutdown error: ' + (err instanceof Error ? err.message : String(err)) + '\n');
    } catch {
      // stderr is unavailable during process teardown.
    }
  };
  const daemonShutdown = createNetworkServerDaemonShutdown({
    stopAccepting: () => {
      detachInput?.();
      stdin.removeListener('end', onStdinEnd);
      serviceWorkflows.close();
    },
    drain: () => serviceWorkflows.drain(),
    flushRuntimeUpdates: () => runtimeUpdates.flush(),
    dispose: () => manager.disposeAll(),
    exit: () => process.exit(0),
  });
  const shutdown = (reason: string): Promise<void> => {
    const alreadyShuttingDown = daemonShutdown.isShuttingDown();
    const promise = daemonShutdown.begin(reason);
    if (!alreadyShuttingDown) logDaemon('info', `Shutting down (${reason})...`);
    return promise;
  };
  daemonWriter = new BoundedJsonLineWriter(stdout, {
    onTerminal: (error) => {
      void shutdown(`stdout terminal error: ${error.message}`).catch(writeShutdownError);
    },
    onNotificationDropped: (reason) => writeShutdownError(`daemon ${reason}`),
  });
  onStdinEnd = (): void => { void shutdown('stdin closed').catch(writeShutdownError); };
  stdin.on('error', (error) => {
    void shutdown(`stdin stream error: ${error.message}`).catch(writeShutdownError);
  });

  process.on('SIGINT', () => void shutdown('SIGINT').catch(writeShutdownError));
  process.on('SIGTERM', () => void shutdown('SIGTERM').catch(writeShutdownError));

  const handleRequest = async (req: RpcRequest): Promise<RpcEnvelope> => {
    try {
      if (daemonShutdown.isShuttingDown()) {
        return { id: req.id, error: { code: 'SHUTTING_DOWN', message: 'Network servers daemon is shutting down.' } };
      }
      switch (req.method) {
        case 'list': {
          const list = await serviceWorkflows.readMany(['tftp', 'dhcp'], async () => manager.list());
          return resultEnvelope(req.id, req.method, list);
        }
        case 'getStatus': {
          const snapshot = await serviceWorkflows.read(req.params.id, async () => manager.getSnapshot(req.params.id));
          return resultEnvelope(req.id, req.method, snapshot);
        }
        case 'configure': {
          const configIds = [
            ...(req.params.configs.tftp === undefined ? [] : ['tftp']),
            ...(req.params.configs.dhcp === undefined ? [] : ['dhcp']),
          ];
          const changed = await serviceWorkflows.enqueueMany(configIds, async () => applyConfigs(req.params.configs));
          return resultEnvelope(req.id, req.method, { ok: true, changed });
        }
        case 'start': {
          const { id, config } = req.params;
          await serviceWorkflows.enqueue(id, async () => {
            if (config !== undefined) await applyConfig(id, config);
            if (configController.requiresEviction(id)) await configController.evictIfIdle(id);
            await manager.start(id);
          });
          return resultEnvelope(req.id, req.method, { ok: true, id });
        }
        case 'stop': {
          const { id } = req.params;
          await serviceWorkflows.enqueue(id, () => manager.stop(id));
          return resultEnvelope(req.id, req.method, { ok: true, id });
        }
        case 'restart': {
          const { id, config } = req.params;
          // Stop first, THEN apply: applyConfigs deliberately refuses to evict
          // a running instance, so configuring before stopping would leave the
          // old instance in place and restart it with stale settings.
          await serviceWorkflows.enqueue(id, async () => {
            await manager.stop(id);
            if (config !== undefined) await applyConfig(id, config);
            // Picks up a configure that landed while the service was running:
            // the eviction it could not do back then happens now that it is idle.
            if (configController.requiresEviction(id)) await configController.evictIfIdle(id);
            await manager.start(id);
          });
          return resultEnvelope(req.id, req.method, { ok: true, id });
        }
        case 'cancelTransfer': {
          const { id, transferId } = req.params;
          const cancelled = await serviceWorkflows.enqueue(id, async () => {
            // Deliberately `getInstance`, not `ensureInstance`: cancelling on a
            // service that was never started must not bring one into existence.
            const instance = manager.getInstance(id);
            return instance instanceof TftpAdapter ? instance.cancelTransfer(transferId) : false;
          });
          return resultEnvelope(req.id, req.method, { ok: cancelled, id, transferId });
        }
        case 'getServiceRuntime': {
          const { id } = req.params;
          const runtime = await serviceWorkflows.read(id, async () => {
            const instance = manager.ensureInstance(id);
            const snapshot = manager.getSnapshot(id);

            if (id === 'dhcp') {
              const dhcp = instance as DhcpAdapter;
              const leases: readonly DhcpLeaseInfo[] = dhcp.activeLeases();
              const packetCounters = dhcp.packetCounters;
              const poolInfo = dhcp.poolInfo;
              const boundPort = dhcp.boundPort;
              return { snapshot, leases, packetCounters, poolInfo, boundPort };
            }
            const tftp = instance as TftpAdapter;
            const transfers: readonly TftpTransferView[] = tftp.activeTransfers();
            const root = tftp.root;
            const allowWrite = tftp.allowWrite;
            const boundPort = tftp.boundPort ?? tftp.port;
            return { snapshot, transfers, root, allowWrite, boundPort };
          });
          return resultEnvelope(req.id, req.method, runtime);
        }
      }
    } catch (err) {
      return internalError(req.id, err);
    }
  };

  const handleLine = (line: string): void => {
    let payload: unknown;
    try {
      payload = JSON.parse(line);
    } catch {
      writeLine(invalidRequest(0, 'Malformed RPC request.'));
      return;
    }
    const parsed = parseRpcRequest(payload);
    if (!parsed.ok) {
      writeLine(invalidRequest(responseIdFor(payload), parsed.error));
      return;
    }
    void handleRequest(parsed.value).then(writeLine, (err) => {
      writeLine(internalError(parsed.value.id, err));
    });
  };

  detachInput = attachBoundedLineReader(stdin, {
    onLine: handleLine,
    onError: () => {
      writeLine(invalidRequest(0, 'RPC input exceeded the maximum line length.'));
      void shutdown('stdin framing error').catch(writeShutdownError);
    },
  });
  stdin.once('end', onStdinEnd);

  // Seed BEFORE announcing readiness: the host may fire `list` the instant it
  // sees `ready`, and that snapshot must already reflect configured ports.
  await seedConfigFromEnv();

  writeLine({ event: 'ready', data: null });
}

void run();
