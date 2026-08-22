/** @author kanekitakitos */

/**
 * Represents the lifecycle of a server instance in the Nexus ecosystem.
 *
 * **Why a closed enum (KISS - Keep It Simple, Stupid):**
 * - The lifecycle of a server is finite and well-defined: stopped → starting →
 *   running → stopping → stopped, with a terminal error state when something fails.
 * - Using a string `enum` (instead of loose unions or numbers) guarantees
 *   strong typing, safe comparisons and readable logs without the need for
 *   extra mappings. Fewer bugs, less code, more clarity.
 */
export enum ServerStatus {
  /** Server was created or terminated completely, with no active resources. */
  STOPPED = 'stopped',
  /** Initial transition: the startup process is underway. */
  STARTING = 'starting',
  /** Server operational, ready to accept requests/connections. */
  RUNNING = 'running',
  /** Final transition: the graceful shutdown process is underway. */
  STOPPING = 'stopping',
  /** Terminal failure state: something prevented startup or caused a crash during execution. */
  ERROR = 'error',
}

/**
 * Event emitted whenever a server changes state.
 *
 * **Why an interface instead of loose tuples (Ports & Adapters):**
 * - This payload is the "contract" (Port) through which external adapters
 *   (UI, loggers, CLI, REST APIs, etc.) receive state updates.
 * - Centralizing the fields (id, status, error?) ensures that any consumer
 *   — be it a file logger, a WebSocket client or a React component
 *   — interprets the message the same way, without depending on concrete
 *   server implementations.
 */
export interface ServerStatusChangeEvent {
  /** Unique identifier of the server that changed state. */
  readonly id: string;
  /** New state the server is in. */
  readonly status: ServerStatus;
  /** Detailed error message, in case the new state is `ERROR`. */
  readonly error?: string;
}

/**
 * Immutable snapshot of a server's state at a given moment.
 *
 * **Why snapshots (KISS + Ports & Adapters):**
 * - A `ServerSnapshot` is a pure data value (DTO), with no references to
 *   live server objects. This means it can be serialized to
 *   JSON, sent over the network, archived in logs or rendered in the UI without risk
 *   of side effects.
 * - Prevents external consumers from having direct access to the server
 *   instance (which has `start()`, `stop()`), promoting separation of
 *   responsibilities: the `ServerManager` is the only one that manipulates instances;
 *   the outside world only receives snapshots.
 */
export interface ServerSnapshot {
  /** Unique identifier of the server. */
  readonly id: string;
  /** Human-friendly server name (for UI and logs). */
  readonly name: string;
  /** TCP/UDP port the server listens on (or will listen on). */
  readonly port: number;
  /** Current state of the lifecycle. */
  readonly status: ServerStatus;
  /** Last recorded error message, if the state is `ERROR`. */
  readonly errorMessage?: string;
}
