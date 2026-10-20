import type { InventoryOperationContext } from "../../models/inventory";
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

/** Dependencies resolved by the runtime preflight, never mutable names or tags. */
export interface ContainerlabExecutionIdentity {
  readonly executable: string;
  readonly dockerExecutable?: string;
  readonly imageId?: string;
  readonly containerId?: string;
  readonly dockerSocket: string;
  readonly location: "local" | "ssh";
  readonly sudo: boolean;
  readonly routeIdentity: string;
}
