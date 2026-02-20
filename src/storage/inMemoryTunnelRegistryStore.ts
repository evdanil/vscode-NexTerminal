import type { TunnelRegistryStore } from "../core/contracts";
import type { TunnelRegistryEntry } from "../models/config";

export class InMemoryTunnelRegistryStore implements TunnelRegistryStore {
  private entries: TunnelRegistryEntry[] = [];

  public async getEntries(): Promise<TunnelRegistryEntry[]> {
    return [...this.entries];
  }

  public async saveEntries(entries: TunnelRegistryEntry[]): Promise<void> {
    this.entries = [...entries];
  }
}
