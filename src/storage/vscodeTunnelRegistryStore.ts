import * as vscode from "vscode";
import type { TunnelRegistryStore } from "../core/contracts";
import type { TunnelRegistryEntry } from "../models/config";

const STORAGE_KEY = "nexus.activeTunnelRegistry";
const FENCE_DIRECTORY = "reverse-bind-fences";

export class VscodeTunnelRegistryStore implements TunnelRegistryStore {
  public constructor(private readonly context: vscode.ExtensionContext) {}

  private get fenceDirectory(): vscode.Uri {
    return vscode.Uri.joinPath(this.context.globalStorageUri, FENCE_DIRECTORY);
  }

  private fencePath(fenceId: string): vscode.Uri {
    return vscode.Uri.joinPath(this.fenceDirectory, `${encodeURIComponent(fenceId)}.json`);
  }

  public async getEntries(): Promise<TunnelRegistryEntry[]> {
    const entries = this.context.globalState.get<TunnelRegistryEntry[]>(STORAGE_KEY, [])
      .filter((entry) => !entry.retiredReverseBind);
    await vscode.workspace.fs.createDirectory(this.fenceDirectory);
    const files = await vscode.workspace.fs.readDirectory(this.fenceDirectory);
    const fences = await Promise.all(files
      .filter(([name, type]) => type === vscode.FileType.File && name.endsWith(".json"))
      .map(async ([name]) => {
        try {
          const contents = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(this.fenceDirectory, name));
          return JSON.parse(new TextDecoder().decode(contents)) as TunnelRegistryEntry;
        } catch (error) {
          if (error instanceof vscode.FileSystemError && error.code === "FileNotFound") {
            // The owner may settle its fence between listing and reading files.
            return undefined;
          }
          throw error;
        }
      }));
    return [...fences.filter((entry): entry is TunnelRegistryEntry => entry !== undefined), ...entries];
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
    try {
      await vscode.workspace.fs.writeFile(temporary, new TextEncoder().encode(JSON.stringify(entry)));
      await vscode.workspace.fs.rename(temporary, this.fencePath(fenceId), { overwrite: true });
    } catch (error) {
      try {
        await vscode.workspace.fs.delete(temporary);
      } catch {
        // Keep the original write/rename failure as the cause of refusal.
      }
      throw error;
    }
  }

  public async removeFence(fenceId: string): Promise<void> {
    try {
      await vscode.workspace.fs.delete(this.fencePath(fenceId));
    } catch (error) {
      if (!(error instanceof vscode.FileSystemError && error.code === "FileNotFound")) {
        throw error;
      }
    }
  }
}
