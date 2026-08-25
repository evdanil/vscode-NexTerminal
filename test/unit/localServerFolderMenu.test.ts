import { readFileSync } from "node:fs";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";

/**
 * "MOVE TO ROOT" ON A LOCAL SERVER ROW — THE MENU CLAUSE AND THE ROW IT GATES.
 *
 * The entry was gated on `viewItemFolder != null`, a context key nothing in
 * `src/` ever sets. An unset key is `undefined`, and `undefined != null` is
 * false in VS Code's when-clause language, so the entry could never appear —
 * "Move to Root" was unreachable for every local server in a folder.
 *
 * VS Code offers no per-item context key; per-item state travels on the item's
 * own `contextValue`, which is exactly how this view already distinguishes
 * `.ipmi` / `.eveRunning` / `.syncSource` rows. So the folder marker is a
 * `.inFolder` suffix, matched by regex in the `when` clause.
 *
 * That suffix is load-bearing in both directions: it has to make `moveToRoot`
 * appear for a foldered row, and it must not make the other nine entries
 * DISAPPEAR for that same row — which is what would happen to every clause
 * still written as an exact `viewItem == nexus.localServer…` equality. Both
 * directions are asserted here against the real package.json and a real tree
 * item, because neither half is meaningful without the other.
 */

vi.mock("vscode", () => ({
  TreeItem: class {
    public id?: string;
    public tooltip?: string;
    public description?: string;
    public contextValue?: string;
    public iconPath?: unknown;
    public command?: unknown;
    public constructor(
      public readonly label: string,
      public readonly collapsibleState?: number
    ) {}
  },
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
  ThemeIcon: class {
    public constructor(
      public readonly id: string,
      public readonly color?: unknown
    ) {}
  },
  ThemeColor: class {
    public constructor(public readonly id: string) {}
  },
  EventEmitter: class {
    public readonly event = (): void => {};
    public fire(): void {}
  },
  workspace: { getConfiguration: () => ({ get: () => undefined }) }
}));

import { LocalServerConfigTreeItem } from "../../src/ui/nexusTreeProvider";
import type { LocalServerConfig } from "../../src/models/localServer";

const packageJsonPath = path.resolve(__dirname, "..", "..", "package.json");
const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
  contributes: { menus: Record<string, Array<{ command: string; when?: string; group?: string }>> };
};

const VIEW_PREFIX = "view == nexusCommandCenter && ";

/**
 * Evaluates the `viewItem` half of a when-clause against one contextValue.
 *
 * Deliberately understands only the two shapes this view uses — a single
 * `viewItem` test, or a parenthesised `||` of them — and throws on anything
 * else, so a clause written in a new shape fails loudly here instead of
 * silently being reported as "matches".
 */
function whenMatches(when: string, contextValue: string): boolean {
  expect(when.startsWith(VIEW_PREFIX), `unexpected when-clause shape: ${when}`).toBe(true);
  let rest = when.slice(VIEW_PREFIX.length).trim();
  if (rest.startsWith("(") && rest.endsWith(")")) {
    rest = rest.slice(1, -1);
  }
  return rest.split("||").some((rawToken) => {
    const token = rawToken.trim();
    const regexToken = /^viewItem =~ \/(.+)\/$/.exec(token);
    if (regexToken) {
      return new RegExp(regexToken[1]).test(contextValue);
    }
    const equalityToken = /^viewItem == ([\w.]+)$/.exec(token);
    if (equalityToken) {
      return equalityToken[1] === contextValue;
    }
    throw new Error(`unsupported when-clause token: "${token}" in "${when}"`);
  });
}

function configItem(overrides: Partial<LocalServerConfig> = {}, running = false): LocalServerConfigTreeItem {
  const config: LocalServerConfig = {
    id: "cfg-1",
    name: "API",
    executable: "node",
    ...overrides
  };
  return new LocalServerConfigTreeItem(config, running ? "running" : "stopped", false);
}

const contextMenu = packageJson.contributes.menus["view/item/context"] ?? [];
const localServerEntries = contextMenu.filter((entry) => entry.command.startsWith("nexus.localServer."));

describe("LocalServerConfigTreeItem folder marker", () => {
  it("marks a row that lives in a folder and leaves a root-level row unmarked", () => {
    expect(configItem({ group: "Production/APIs" }).contextValue).toBe("nexus.localServer.inFolder");
    expect(configItem({}).contextValue).toBe("nexus.localServer");
  });

  it("carries the marker independently of running state", () => {
    expect(configItem({ group: "Production" }, true).contextValue).toBe("nexus.localServerRunning.inFolder");
    expect(configItem({}, true).contextValue).toBe("nexus.localServerRunning");
  });

  it("treats an empty-string group as root-level, not as a folder", () => {
    expect(configItem({ group: "" }).contextValue).toBe("nexus.localServer");
  });
});

describe("Local Servers view/item/context menu gating", () => {
  it("finds the moveToRoot entry to gate", () => {
    expect(localServerEntries.some((e) => e.command === "nexus.localServer.moveToRoot")).toBe(true);
  });

  it("shows Move to Root only for a row that is actually in a folder", () => {
    const entry = localServerEntries.find((e) => e.command === "nexus.localServer.moveToRoot")!;
    const when = entry.when!;
    // The bug: gated on a context key nothing sets, so it never showed at all.
    expect(when).not.toContain("viewItemFolder");
    expect(whenMatches(when, "nexus.localServer.inFolder")).toBe(true);
    expect(whenMatches(when, "nexus.localServerRunning.inFolder")).toBe(true);
    // And it stays hidden where it would be a no-op.
    expect(whenMatches(when, "nexus.localServer")).toBe(false);
    expect(whenMatches(when, "nexus.localServerRunning")).toBe(false);
  });

  it("keeps every other entry visible for a foldered row", () => {
    // Adding a contextValue suffix silently hides any entry still written as
    // an exact equality — the regression this suffix could most easily cause.
    const others = localServerEntries.filter((e) => e.command !== "nexus.localServer.moveToRoot");
    expect(others.length).toBeGreaterThan(0);
    for (const entry of others) {
      for (const base of ["nexus.localServer", "nexus.localServerRunning"]) {
        expect(
          whenMatches(entry.when!, `${base}.inFolder`),
          `${entry.command} (group ${entry.group}) hides for a foldered ${base} row`
        ).toBe(whenMatches(entry.when!, base));
      }
    }
  });

  it("gates the real tree items rather than hypothetical contextValues", () => {
    const foldered = configItem({ group: "Production" }).contextValue!;
    const rootLevel = configItem({}).contextValue!;
    const moveToRoot = localServerEntries.find((e) => e.command === "nexus.localServer.moveToRoot")!.when!;
    const moveToFolder = localServerEntries.find((e) => e.command === "nexus.localServer.moveToFolder")!.when!;
    expect(whenMatches(moveToRoot, foldered)).toBe(true);
    expect(whenMatches(moveToRoot, rootLevel)).toBe(false);
    // Its counterpart stays available from both places.
    expect(whenMatches(moveToFolder, foldered)).toBe(true);
    expect(whenMatches(moveToFolder, rootLevel)).toBe(true);
  });

  it("leaves no viewItemFolder reference anywhere in the manifest", () => {
    expect(readFileSync(packageJsonPath, "utf8")).not.toContain("viewItemFolder");
  });
});

/**
 * COPY ALL ON A LOCAL SERVER ROW.
 *
 * A local server terminal is a log view: reading it and taking the text
 * elsewhere is most of what it is for. Reset and Clear Scrollback were
 * contributed for these rows; Copy All — the one that hands the user the
 * output — was not, so it was reachable only from the terminal tab itself.
 */
describe("Copy All is available on Local Servers rows", () => {
  const localServerTerminalEntries = (command: string) =>
    contextMenu.filter(
      (entry) => entry.command === command && (entry.when ?? "").includes("localServer")
    );

  it.each(["nexus.terminal.reset", "nexus.terminal.clearScrollback", "nexus.terminal.copyAll"])(
    "contributes %s for local-server rows",
    (command) => {
      expect(localServerTerminalEntries(command)).toHaveLength(1);
    }
  );

  it("gates Copy All exactly as its two neighbours are gated", () => {
    const copyAll = localServerTerminalEntries("nexus.terminal.copyAll")[0].when;
    const reset = localServerTerminalEntries("nexus.terminal.reset")[0].when;
    const clear = localServerTerminalEntries("nexus.terminal.clearScrollback")[0].when;
    expect(copyAll).toBe(reset);
    expect(copyAll).toBe(clear);
  });

  it.each([
    "nexus.localServerRunning",
    "nexus.localServerRunning.inFolder",
    "nexus.localServerSessionNode"
  ])("shows Copy All on a %s row", (contextValue) => {
    const copyAll = localServerTerminalEntries("nexus.terminal.copyAll")[0].when!;
    expect(whenMatches(copyAll, contextValue)).toBe(true);
  });

  it("sits in the same menu group as Reset and Clear Scrollback", () => {
    const copyAll = localServerTerminalEntries("nexus.terminal.copyAll")[0];
    expect(copyAll.group).toMatch(/^1_terminal@/);
  });
});
