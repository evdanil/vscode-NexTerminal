import type * as vscode from "vscode";
import type { TunnelRegistryStore } from "../core/contracts";
import type { TunnelRegistryEntry } from "../models/config";

const STORAGE_KEY = "nexus.activeTunnelRegistry";

export class VscodeTunnelRegistryStore implements TunnelRegistryStore {
  public constructor(private readonly context: vscode.ExtensionContext) {}

  public async getEntries(): Promise<TunnelRegistryEntry[]> {
    return this.context.globalState.get<TunnelRegistryEntry[]>(STORAGE_KEY, []);
  }

  public async saveEntries(entries: TunnelRegistryEntry[]): Promise<void> {
    await this.context.globalState.update(STORAGE_KEY, entries);
  }
}
