import type * as vscode from "vscode";
import type { TunnelRegistryStore } from "../core/contracts";
import type { TunnelRegistryEntry } from "../models/config";

const STORAGE_KEY = "nexus.activeTunnelRegistry";
const FENCE_KEY_PREFIX = `${STORAGE_KEY}.fence.`;

export class VscodeTunnelRegistryStore implements TunnelRegistryStore {
  public constructor(private readonly context: vscode.ExtensionContext) {}

  public async getEntries(): Promise<TunnelRegistryEntry[]> {
    const entries = this.context.globalState.get<TunnelRegistryEntry[]>(STORAGE_KEY, [])
      .filter((entry) => !entry.retiredReverseBind);
    const fences = this.context.globalState.keys()
      .filter((key) => key.startsWith(FENCE_KEY_PREFIX))
      .map((key) => this.context.globalState.get<TunnelRegistryEntry>(key))
      .filter((entry): entry is TunnelRegistryEntry => entry?.retiredReverseBind !== undefined);
    return [...fences, ...entries];
  }

  public async saveEntries(entries: TunnelRegistryEntry[]): Promise<void> {
    // Fences live under independent keys so another window's stale array write
    // cannot erase one or restore it after the owner confirms settlement.
    await this.context.globalState.update(STORAGE_KEY, entries.filter((entry) => !entry.retiredReverseBind));
  }

  public async publishFence(entry: TunnelRegistryEntry): Promise<void> {
    const fenceId = entry.retiredReverseBind?.fenceId;
    if (!fenceId) {
      throw new Error("A reverse-bind fence needs an id");
    }
    await this.context.globalState.update(`${FENCE_KEY_PREFIX}${fenceId}`, entry);
  }

  public async removeFence(fenceId: string): Promise<void> {
    await this.context.globalState.update(`${FENCE_KEY_PREFIX}${fenceId}`, undefined);
  }
}
