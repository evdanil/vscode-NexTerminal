import * as vscode from "vscode";
import type { TunnelRegistryStore } from "../core/contracts";
import type { TunnelRegistryEntry } from "../models/config";

const STORAGE_KEY = "nexus.activeTunnelRegistry";
const FENCE_DIRECTORY = "reverse-bind-fences";

export class VscodeTunnelRegistryStore implements TunnelRegistryStore {
  private readonly observedFenceFiles = new WeakMap<TunnelRegistryEntry, vscode.Uri>();
  private fenceSequence = 0;

  public constructor(private readonly context: vscode.ExtensionContext) {}

  private get fenceDirectory(): vscode.Uri {
    return vscode.Uri.joinPath(this.context.globalStorageUri, FENCE_DIRECTORY);
  }

  private fencePrefix(fenceId: string): string {
    const encoded = encodeURIComponent(fenceId);
    return `${encoded.length}-${encoded}--`;
  }

  private isFenceFile(name: string, fenceId: string): boolean {
    return name === `${encodeURIComponent(fenceId)}.json` ||
      (name.startsWith(this.fencePrefix(fenceId)) && name.endsWith(".json"));
  }

  private async deleteFileIfPresent(uri: vscode.Uri): Promise<void> {
    try {
      await vscode.workspace.fs.delete(uri);
    } catch (error) {
      if (!(error instanceof vscode.FileSystemError && error.code === "FileNotFound")) {
        throw error;
      }
    }
  }

  public async getEntries(): Promise<TunnelRegistryEntry[]> {
    const entries = this.context.globalState.get<TunnelRegistryEntry[]>(STORAGE_KEY, [])
      .filter((entry) => !entry.retiredReverseBind);
    await vscode.workspace.fs.createDirectory(this.fenceDirectory);
    for (let attempt = 0; attempt < 3; attempt++) {
      const files = await vscode.workspace.fs.readDirectory(this.fenceDirectory);
      const fences = await Promise.all(files
        .filter(([name, type]) => type === vscode.FileType.File && name.endsWith(".json"))
        .map(async ([name]) => {
          try {
            const uri = vscode.Uri.joinPath(this.fenceDirectory, name);
            const contents = await vscode.workspace.fs.readFile(uri);
            const entry = JSON.parse(new TextDecoder().decode(contents)) as TunnelRegistryEntry;
            this.observedFenceFiles.set(entry, uri);
            return { entry, name };
          } catch (error) {
            if (error instanceof vscode.FileSystemError && error.code === "FileNotFound") {
              // A replacement may have been published after the listing.
              return undefined;
            }
            throw error;
          }
        }));
      if (fences.some((fence) => fence === undefined)) {
        continue;
      }
      const latest = new Map<string, { entry: TunnelRegistryEntry; name: string }>();
      for (const fence of fences) {
        const fenceId = fence?.entry.retiredReverseBind?.fenceId;
        if (!fence || !fenceId) continue;
        const previous = latest.get(fenceId);
        const seen = fence.entry.lastSeen ?? fence.entry.startedAt;
        const previousSeen = previous?.entry.lastSeen ?? previous?.entry.startedAt ?? -Infinity;
        // A file published after a same-millisecond route/port update wins too.
        const version = fence.name.startsWith(this.fencePrefix(fenceId)) ? fence.name : "";
        const previousVersion = previous?.name.startsWith(this.fencePrefix(fenceId)) ? previous.name : "";
        if (!previous || seen > previousSeen || (seen === previousSeen && version > previousVersion)) {
          latest.set(fenceId, fence);
        }
      }
      return [...[...latest.values()].map(({ entry }) => entry), ...entries];
    }
    // A continuously changing directory must not look like an empty registry.
    throw new Error("Reverse-bind fence files changed during registry read");
  }

  public async saveEntries(entries: TunnelRegistryEntry[]): Promise<void> {
    // VS Code writes the whole Memento object, so fences must live outside it.
    await this.context.globalState.update(STORAGE_KEY, entries.filter((entry) => !entry.retiredReverseBind));
  }

  public async publishFence(entry: TunnelRegistryEntry): Promise<void> {
    const fenceId = entry.retiredReverseBind?.fenceId;
    if (!fenceId) {
      throw new Error("A reverse-bind fence needs an id");
    }
    await vscode.workspace.fs.createDirectory(this.fenceDirectory);
    const temporary = vscode.Uri.joinPath(
      this.fenceDirectory,
      `.${encodeURIComponent(fenceId)}.${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`
    );
    // Each publication has its own immutable pathname. A stale reader may
    // delete an old generation, but can never erase a refreshed generation.
    const version = `${Date.now().toString().padStart(13, "0")}-${(++this.fenceSequence).toString().padStart(6, "0")}-${Math.random().toString(36).slice(2)}`;
    const targetName = `${this.fencePrefix(fenceId)}${version}.json`;
    const target = vscode.Uri.joinPath(this.fenceDirectory, targetName);
    try {
      await vscode.workspace.fs.writeFile(temporary, new TextEncoder().encode(JSON.stringify(entry)));
      await vscode.workspace.fs.rename(temporary, target);
    } catch (error) {
      try {
        await vscode.workspace.fs.delete(temporary);
      } catch {
        // Keep the original write/rename failure as the cause of refusal.
      }
      throw error;
    }
    // Publish first, then prune prior versions. A failed prune is harmless to
    // ownership and the slow sweep will eventually retry the orphan.
    try {
      const files = await vscode.workspace.fs.readDirectory(this.fenceDirectory);
      for (const [name, type] of files) {
        if (type !== vscode.FileType.File || !this.isFenceFile(name, fenceId) || name === targetName) {
          continue;
        }
        try {
          await this.deleteFileIfPresent(vscode.Uri.joinPath(this.fenceDirectory, name));
        } catch (error) {
          console.error("[Nexus] old reverse-bind fence cleanup failed", error);
        }
      }
    } catch (error) {
      console.error("[Nexus] reverse-bind fence pruning failed", error);
    }
  }

  public async removeFence(fenceId: string): Promise<void> {
    await vscode.workspace.fs.createDirectory(this.fenceDirectory);
    const files = await vscode.workspace.fs.readDirectory(this.fenceDirectory);
    for (const [name, type] of files) {
      if (type === vscode.FileType.File && this.isFenceFile(name, fenceId)) {
        await this.deleteFileIfPresent(vscode.Uri.joinPath(this.fenceDirectory, name));
      }
    }
  }

  public async removeObservedFence(entry: TunnelRegistryEntry): Promise<void> {
    const observed = this.observedFenceFiles.get(entry);
    if (observed) {
      await this.deleteFileIfPresent(observed);
    }
  }
}
