import type { TunnelRegistryStore } from "../core/contracts";
import type { TunnelRegistryEntry } from "../models/config";

export class InMemoryTunnelRegistryStore implements TunnelRegistryStore {
  private entries: TunnelRegistryEntry[] = [];
  private readonly fences = new Map<string, TunnelRegistryEntry>();

  public async getEntries(): Promise<TunnelRegistryEntry[]> {
    return [...this.fences.values(), ...this.entries];
  }

  public async saveEntries(entries: TunnelRegistryEntry[]): Promise<void> {
    this.entries = entries.filter((entry) => !entry.retiredReverseBind);
  }

  public async publishFence(entry: TunnelRegistryEntry): Promise<void> {
    const fenceId = entry.retiredReverseBind?.fenceId;
    if (!fenceId) {
      throw new Error("A reverse-bind fence needs an id");
    }
    this.fences.set(fenceId, entry);
  }

  public async removeFence(fenceId: string): Promise<void> {
    this.fences.delete(fenceId);
  }
}
