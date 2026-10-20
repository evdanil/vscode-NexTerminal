import type { InventoryOperationContext } from "../../models/inventory";
import type { ServerConfig } from "../../models/config";
import type { ContainerlabConfig } from "./providers/containerlabConfig";

/** A validated result of one bounded Containerlab inspection invocation. */
export interface ContainerlabInspection {
  readonly version: string;
  readonly stdout: string;
}

/** Node-only execution is injected so the provider, parser and config stay browser-safe. */
export interface ContainerlabRuntime {
  inspect(config: ContainerlabConfig, context?: InventoryOperationContext): Promise<ContainerlabInspection>;
}

/** A process argument vector and its complete, allowlisted process environment. */
export interface ContainerlabCommand {
  readonly executable: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly cwd: "/";
}

/** One absolute invocation deadline and the host snapshot authorized by its caller. */
export interface ContainerlabRunContext {
  readonly interaction: "interactive" | "noninteractive";
  readonly signal: AbortSignal;
  readonly deadline: number;
  readonly labHost?: ServerConfig;
  /** Captured dependency-snapshot identity for the full SSH route and its auth profiles. */
  readonly labHostRouteIdentity?: string;
  readonly isCurrent: () => boolean;
}

export interface ResolvedContainerlabExecution {
  readonly identity: ContainerlabExecutionIdentity;
}

export interface PreparedContainerlabExecution {
  readonly identity: ContainerlabExecutionIdentity;
  readonly version: string;
}

export interface ContainerlabCommandResult {
  readonly stdout: string;
  readonly stderr: string;
}

export interface ContainerlabCommandRunner {
  run(command: ContainerlabCommand, context: ContainerlabRunContext): Promise<ContainerlabCommandResult>;
}

export interface ContainerlabExecutor {
  resolveDependencies(
    config: ContainerlabConfig,
    context: ContainerlabRunContext,
    expected?: ContainerlabExecutionIdentity
  ): Promise<ResolvedContainerlabExecution>;
  preflight(
    config: ContainerlabConfig,
    resolved: ResolvedContainerlabExecution,
    context: ContainerlabRunContext
  ): Promise<PreparedContainerlabExecution>;
  inspect(
    config: ContainerlabConfig,
    prepared: PreparedContainerlabExecution,
    context: ContainerlabRunContext
  ): Promise<ContainerlabInspection>;
}

export interface ContainerlabExecutorDependencies {
  readonly localRunner: ContainerlabCommandRunner;
  readonly sshRunner: ContainerlabCommandRunner;
  readonly now?: () => number;
  readonly createInvocationId?: () => string;
}

/**
 * Captures the checked host Containerlab and Docker executable paths or the
 * container CLI token plus outer Docker path, immutable runner IDs, selected
 * socket and SSH route. Host paths identify lookup results; they do not pin
 * executable contents.
 */
export interface ContainerlabExecutionIdentity {
  readonly executable: string;
  readonly dockerExecutable: string;
  readonly imageId?: string;
  readonly containerId?: string;
  readonly dockerSocket: string;
  readonly location: "local" | "ssh";
  readonly sudo: boolean;
  readonly routeIdentity: string;
}
