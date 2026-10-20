import type * as vscode from "vscode";
import type { ContainerlabApprovalStore } from "../services/inventory/containerlabActivation";

/** Private machine-local state for Containerlab's session-scoped approval cache. */
export const CONTAINERLAB_APPROVAL_STATE_KEY = "nexus.containerlab.approvalState";

/**
 * Kept outside ConfigRepository so approval records never enter backup, sharing,
 * or Settings Sync. The activation controller always creates fresh in-memory
 * authority; reading this value only lets its store adapter preserve its write
 * contract across host restarts.
 */
export class VscodeContainerlabApprovalStore implements ContainerlabApprovalStore {
  public constructor(private readonly state: Pick<vscode.Memento, "get" | "update">) {}

  public async load(): Promise<unknown> {
    return this.state.get(CONTAINERLAB_APPROVAL_STATE_KEY);
  }

  public async save(value: unknown): Promise<void> {
    await this.state.update(CONTAINERLAB_APPROVAL_STATE_KEY, value);
  }
}
