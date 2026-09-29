import * as vscode from "vscode";
import type { TunnelRegistryStore } from "../core/contracts";
import type { TunnelRegistryEntry } from "../models/config";

const STORAGE_KEY = "nexus.activeTunnelRegistry";
const FENCE_DIRECTORY = "reverse-bind-fences";
/**
 * A live fence is republished every few seconds and a temporary file exists
 * only between writeFile and rename, so a file older than this is never a live
 * reservation or an in-flight write. Matches the registry's staleness window.
 */
const ORPHAN_FILE_AGE_MS = 30_000;

/** Writer-clock timestamp embedded in a versioned fence name, if it has one. */
function versionedFenceTimestamp(name: string): number | undefined {
  const embedded = /--(\d{13})-\d{6}-[^.]*\.json$/.exec(name);
  return embedded ? Number(embedded[1]) : undefined;
}

function isFenceEntry(value: unknown): value is TunnelRegistryEntry {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const retired = (value as { retiredReverseBind?: unknown }).retiredReverseBind;
  if (typeof retired !== "object" || retired === null) {
    return false;
  }
  const fenceId = (retired as { fenceId?: unknown }).fenceId;
  return typeof fenceId === "string" && fenceId.length > 0;
}

export class VscodeTunnelRegistryStore implements TunnelRegistryStore {
  private readonly observedFenceFiles = new WeakMap<TunnelRegistryEntry, vscode.Uri>();
  private fenceSequence = 0;
  private readonly reportedUnusableFiles = new Set<string>();
  private readonly reportedCleanupFailures = new Set<string>();

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

  /**
   * Remove a file only once it is old enough that it cannot be another window's
   * in-flight write or live fence. Failure to stat or delete leaves it for the
   * next sweep; it must never turn into a registry read failure.
   */
  private async deleteIfOrphaned(uri: vscode.Uri, embeddedTimestamp?: number): Promise<void> {
    try {
      const { mtime } = await vscode.workspace.fs.stat(uri);
      // A network filesystem's clock can lag ours; the writer's own timestamp
      // in the name keeps a foreign sweep from deleting an in-flight write.
      const written = Math.max(mtime, embeddedTimestamp ?? -Infinity);
      if (Date.now() - written >= ORPHAN_FILE_AGE_MS) {
        await this.deleteFileIfPresent(uri);
      }
    } catch (error) {
      // Runs on every 3 s poll, so report each file once.
      if (!this.reportedCleanupFailures.has(uri.path)) {
        this.reportedCleanupFailures.add(uri.path);
        console.error("[Nexus] orphan reverse-bind fence file cleanup failed", error);
      }
    }
  }

  private async isFresh(uri: vscode.Uri, embeddedTimestamp?: number): Promise<boolean> {
    try {
      // Same basis as deleteIfOrphaned: a lagging network-filesystem mtime must
      // not make a just-published fence look stale and hide its reservation.
      const written = Math.max((await vscode.workspace.fs.stat(uri)).mtime, embeddedTimestamp ?? -Infinity);
      return Date.now() - written < ORPHAN_FILE_AGE_MS;
    } catch {
      // Cannot tell its age: treat as possibly live rather than hide a reservation.
      return true;
    }
  }

  private async skipUnusableFence(name: string, uri: vscode.Uri, reason: unknown): Promise<undefined> {
    // One file nobody can interpret as a reservation must not fail every
    // registry read. It is not churn, so it is skipped rather than retried.
    if (!this.reportedUnusableFiles.has(name)) {
      this.reportedUnusableFiles.add(name);
      console.error(`[Nexus] ignoring unusable reverse-bind fence file ${name}`, reason);
    }
    await this.deleteIfOrphaned(uri, versionedFenceTimestamp(name));
    return undefined;
  }

  private async sweepOrphanTemporaries(files: [string, vscode.FileType][]): Promise<void> {
    for (const [name, type] of files) {
      if (type === vscode.FileType.File && name.startsWith(".") && name.endsWith(".tmp")) {
        // Temporary names are `.<id>.<Date.now()>-<random>.tmp`.
        const embedded = /\.(\d{10,})-[^.]*\.tmp$/.exec(name);
        await this.deleteIfOrphaned(
          vscode.Uri.joinPath(this.fenceDirectory, name),
          embedded ? Number(embedded[1]) : undefined
        );
      }
    }
  }

  public async getEntries(): Promise<TunnelRegistryEntry[]> {
    const entries = this.context.globalState.get<TunnelRegistryEntry[]>(STORAGE_KEY, [])
      .filter((entry) => !entry.retiredReverseBind);
    await vscode.workspace.fs.createDirectory(this.fenceDirectory);
    let lastReadError: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      const files = await vscode.workspace.fs.readDirectory(this.fenceDirectory);
      await this.sweepOrphanTemporaries(files);
      const fences = await Promise.all(files
        .filter(([name, type]) => type === vscode.FileType.File && name.endsWith(".json"))
        .map(async ([name]) => {
          const uri = vscode.Uri.joinPath(this.fenceDirectory, name);
          let entry: unknown;
          try {
            const contents = await vscode.workspace.fs.readFile(uri);
            entry = JSON.parse(new TextDecoder().decode(contents));
          } catch (error) {
            if (error instanceof vscode.FileSystemError && error.code === "FileNotFound") {
              // A replacement may have been published after the listing.
              return { missing: true as const };
            }
            if (!(error instanceof SyntaxError) && await this.isFresh(uri, versionedFenceTimestamp(name))) {
              // A fence that is being refreshed right now (for example a
              // delete-pending file under a rename) may fail to read
              // transiently. Skipping it would hide a live reservation, so
              // re-list; persistent failure makes the read fail closed.
              lastReadError = error;
              return { missing: true as const };
            }
            return { missing: false as const, fence: await this.skipUnusableFence(name, uri, error) };
          }
          if (!isFenceEntry(entry)) {
            return { missing: false as const, fence: await this.skipUnusableFence(name, uri, "not a fence entry") };
          }
          this.observedFenceFiles.set(entry, uri);
          return { missing: false as const, fence: { entry, name } };
        }));
      if (fences.some((fence) => fence.missing)) {
        continue;
      }
      const latest = new Map<string, { entry: TunnelRegistryEntry; name: string }>();
      for (const item of fences) {
        const fence = item.missing ? undefined : item.fence;
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
    throw new Error("Reverse-bind fence files changed or could not be read during registry read", {
      cause: lastReadError
    });
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
