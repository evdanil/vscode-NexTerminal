import { describe, expect, it, vi } from "vitest";
import type { SessionSnapshot } from "../../src/core/contracts";
import type { ServerConfig } from "../../src/models/config";

vi.mock("vscode", () => ({
  EventEmitter: class {
    private listeners: Array<(value: unknown) => void> = [];
    public readonly event = (listener: (value: unknown) => void) => {
      this.listeners.push(listener);
      return { dispose: () => {} };
    };
    public fire(value: unknown): void {
      for (const l of this.listeners) l(value);
    }
    public dispose(): void {
      this.listeners = [];
    }
  },
  ThemeColor: class {
    public constructor(public readonly id: string) {}
  },
  FileDecoration: class {
    public constructor(
      public readonly badge?: string,
      public readonly tooltip?: string,
      public readonly color?: unknown
    ) {}
  },
  Uri: {
    from: (components: { scheme: string; authority?: string; path?: string }) => ({
      scheme: components.scheme,
      authority: components.authority ?? "",
      path: components.path ?? "",
      toString: () => `${components.scheme}://${components.authority ?? ""}${components.path ?? ""}`
    })
  }
}));

import {
  InventoryStatusDecorationProvider,
  computeRunningStatus,
  folderStatusUri,
  serverStatusUri,
  STATUS_URI_SCHEME
} from "../../src/ui/inventoryStatusDecorationProvider";

function server(id: string, group: string | undefined, status?: "running" | "stopped", isHidden = false): { server: ServerConfig; status?: "running" | "stopped" } {
  return {
    server: { id, name: id, host: "h", port: 23, username: "u", authType: "agent", isHidden, group },
    status
  };
}

function snapshotOf(entries: Array<{ server: ServerConfig; status?: "running" | "stopped" }>): SessionSnapshot {
  const serverStatus = new Map<string, "running" | "stopped">();
  for (const e of entries) if (e.status) serverStatus.set(e.server.id, e.status);
  return {
    servers: entries.map((e) => e.server),
    serverStatus
  } as unknown as SessionSnapshot;
}

describe("computeRunningStatus", () => {
  it("collects running server ids and the folders that DIRECTLY contain a running server (⊘ keying by stopped state would highlight dead labs; ignoring the group loses the folder highlight)", () => {
    const snap = snapshotOf([
      server("s1", "EVE/LabA", "running"),
      server("s2", "EVE/LabA", "stopped"),
      server("s3", "EVE/LabB", "stopped"),
      server("s4", undefined, "running") // running but at root — no folder to highlight
    ]);
    const { runningServerIds, runningFolders } = computeRunningStatus(snap);
    expect([...runningServerIds].sort()).toEqual(["s1", "s4"]);
    // LabA has a running node → highlighted; LabB has only a stopped node → not.
    expect([...runningFolders]).toEqual(["EVE/LabA"]);
  });

  it("highlights a mixed folder as long as ≥1 node runs (⊘ requiring ALL nodes running would leave a partially-up lab dark)", () => {
    const snap = snapshotOf([server("a", "Lab", "stopped"), server("b", "Lab", "running")]);
    expect([...computeRunningStatus(snap).runningFolders]).toEqual(["Lab"]);
  });

  it("P3-5: ignores a HIDDEN running server, so its folder (whose visible contents are all stopped) does NOT highlight (⊘ iterating isHidden servers diverges from the tree's membership rule and lights an apparently-dead lab)", () => {
    const snap = snapshotOf([
      server("hidden", "EVE/LabH", "running", true), // hidden + running
      server("shown", "EVE/LabH", "stopped") // the only visible node is stopped
    ]);
    const { runningServerIds, runningFolders } = computeRunningStatus(snap);
    expect(runningServerIds.has("hidden")).toBe(false);
    expect(runningFolders.has("EVE/LabH")).toBe(false);
  });

  it("produces empty sets when no server has status (a non-EVE tree)", () => {
    const snap = snapshotOf([server("a", "Grp"), server("b", undefined)]);
    const r = computeRunningStatus(snap);
    expect(r.runningServerIds.size).toBe(0);
    expect(r.runningFolders.size).toBe(0);
  });
});

describe("InventoryStatusDecorationProvider", () => {
  it("returns a green ▶ decoration for a running server and its lab folder, and nothing for stopped/non-status/unknown-scheme uris", () => {
    const provider = new InventoryStatusDecorationProvider();
    provider.update(snapshotOf([server("run", "EVE/LabA", "running"), server("stop", "EVE/LabB", "stopped")]));

    const runDec = provider.provideFileDecoration(serverStatusUri("run"));
    expect(runDec).toBeDefined();
    expect(runDec?.badge).toBe("▶");
    expect((runDec?.color as { id: string }).id).toBe("charts.green");

    const folderDec = provider.provideFileDecoration(folderStatusUri("EVE/LabA"));
    expect(folderDec?.badge).toBe("▶");

    expect(provider.provideFileDecoration(serverStatusUri("stop"))).toBeUndefined();
    expect(provider.provideFileDecoration(folderStatusUri("EVE/LabB"))).toBeUndefined();
    expect(provider.provideFileDecoration(serverStatusUri("ghost"))).toBeUndefined();
  });

  it("round-trips server ids and folder paths with special characters through the uri (⊘ a whole-string encode or a bare parse would mangle a lab name with spaces/slashes)", () => {
    const provider = new InventoryStatusDecorationProvider();
    provider.update(snapshotOf([server("s#1", "EVE/ACME Corp/Lab 1", "running")]));
    expect(provider.provideFileDecoration(serverStatusUri("s#1"))?.badge).toBe("▶");
    expect(provider.provideFileDecoration(folderStatusUri("EVE/ACME Corp/Lab 1"))?.badge).toBe("▶");
  });

  it("fires onDidChangeFileDecorations when the running set changes, and stays quiet when it does not (⊘ never firing leaves stale badges; firing on every snapshot churns the whole tree)", () => {
    const provider = new InventoryStatusDecorationProvider();
    const fired = vi.fn();
    provider.onDidChangeFileDecorations(fired);

    provider.update(snapshotOf([server("s1", "Lab", "running")]));
    expect(fired).toHaveBeenCalledTimes(1);

    // Same running set → no emit.
    provider.update(snapshotOf([server("s1", "Lab", "running")]));
    expect(fired).toHaveBeenCalledTimes(1);

    // s1 stops → running set changed → emit.
    provider.update(snapshotOf([server("s1", "Lab", "stopped")]));
    expect(fired).toHaveBeenCalledTimes(2);
    expect(provider.provideFileDecoration(serverStatusUri("s1"))).toBeUndefined();
  });

  it("ignores a uri whose scheme is not the status scheme", () => {
    const provider = new InventoryStatusDecorationProvider();
    provider.update(snapshotOf([server("s1", "Lab", "running")]));
    const foreign = { scheme: "file", authority: "server", path: "/s1" } as unknown as import("vscode").Uri;
    expect(provider.provideFileDecoration(foreign)).toBeUndefined();
    expect(STATUS_URI_SCHEME).toBe("nexus-status");
  });
});
