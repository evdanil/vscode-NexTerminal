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
 * Splits on top-level `||`, stepping over parenthesised groups and over the
 * `|` and `(` that appear inside a `/…/` regex literal — `(Connected|Waiting)`
 * is one alternation inside one token, not two tokens.
 */
function splitTopLevelOr(clause: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let inRegex = false;
  let start = 0;
  for (let i = 0; i < clause.length; i++) {
    const ch = clause[i];
    if (inRegex) {
      if (ch === "\\") i++;
      else if (ch === "/") inRegex = false;
      continue;
    }
    if (ch === "/") inRegex = true;
    else if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (depth === 0 && ch === "|" && clause[i + 1] === "|") {
      parts.push(clause.slice(start, i));
      i++;
      start = i + 1;
    }
  }
  parts.push(clause.slice(start));
  return parts.map((part) => part.trim());
}

/** True when the whole clause is one parenthesised group, `(A || B)` and not `(A) && (B)`. */
function isOneParenthesisedGroup(clause: string): boolean {
  if (!clause.startsWith("(") || !clause.endsWith(")")) return false;
  let depth = 0;
  let inRegex = false;
  for (let i = 0; i < clause.length; i++) {
    const ch = clause[i];
    if (inRegex) {
      if (ch === "\\") i++;
      else if (ch === "/") inRegex = false;
      continue;
    }
    if (ch === "/") inRegex = true;
    else if (ch === "(") depth++;
    else if (ch === ")" && --depth === 0) return i === clause.length - 1;
  }
  return false;
}

/**
 * Evaluates the `viewItem` half of a when-clause against one contextValue.
 *
 * Deliberately understands only the two shapes this view uses — a single
 * `viewItem` test, or a parenthesised `||` of them — and throws on anything
 * else, so a clause written in a new shape fails loudly here instead of
 * silently being reported as "matches".
 *
 * PRECEDENCE. VS Code's when-clause language binds `&&` tighter than `||`,
 * exactly as JavaScript does: `A && B || C` parses as `(A && B) || C`, NOT as
 * `A && (B || C)`. This helper strips the fixed `view == … && ` prefix and
 * evaluates only what follows, which erased that distinction completely —
 * dropping the parentheses from the `stop` entry (turning "in this view, on
 * one of these rows" into "in this view on this row, OR on that row in ANY
 * view") left the file at 8/8 green.
 *
 * The fix is to refuse the ambiguous shape rather than to grow a real parser:
 * refusing unrecognised input is already how this helper handles every other
 * case, and a clause that mixes the two operators without grouping is exactly
 * the kind of thing that should be rewritten rather than interpreted.
 */
function whenMatches(when: string, contextValue: string): boolean {
  expect(when.startsWith(VIEW_PREFIX), `unexpected when-clause shape: ${when}`).toBe(true);
  const rest = when.slice(VIEW_PREFIX.length).trim();
  const grouped = isOneParenthesisedGroup(rest);
  const tokens = splitTopLevelOr(grouped ? rest.slice(1, -1) : rest);

  if (!grouped && tokens.length > 1) {
    throw new Error(
      `ambiguous when-clause: "${when}" mixes && and || without parentheses. ` +
        "VS Code binds && tighter, so this reads as (view == … && A) || B — the || branch " +
        "escapes the view check. Parenthesise the alternation."
    );
  }

  return tokens.some((token) => {
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

/**
 * The generic terminal commands are contributed for local-server rows too, and
 * their clauses were rewritten by the same change that introduced the
 * `.inFolder` suffix. A filter on the `nexus.localServer.` command prefix
 * skipped all three, so reverting either of them to an exact `viewItem ==`
 * equality — the precise regression this file exists to catch, Reset and Clear
 * staying disabled on a foldered running row — left every test green.
 */
const TERMINAL_COMMANDS = [
  "nexus.terminal.reset",
  "nexus.terminal.clearScrollback",
  "nexus.terminal.copyAll"
];

const localServerEntries = contextMenu.filter(
  (entry) =>
    entry.command.startsWith("nexus.localServer.") ||
    (TERMINAL_COMMANDS.includes(entry.command) && (entry.when ?? "").includes("localServer"))
);

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

/**
 * THE HELPER ITSELF.
 *
 * Everything below trusts `whenMatches` to say what VS Code would say. It
 * stripped the fixed `view == … && ` prefix and evaluated only the remainder,
 * which made `view == X && (A || B)` and `view == X && A || B` indistinguishable
 * — even though VS Code binds `&&` tighter, so the second means
 * `(view == X && A) || B` and the `|| B` branch escapes the view check
 * entirely. Removing the parentheses from the `stop` entry was invisible here.
 */
describe("whenMatches models VS Code's when-clause precedence", () => {
  const GROUPED = `${VIEW_PREFIX}(viewItem =~ /^nexus\\.localServerRunning$/ || viewItem == nexus.localServerSessionNode)`;
  const UNGROUPED = `${VIEW_PREFIX}viewItem =~ /^nexus\\.localServerRunning$/ || viewItem == nexus.localServerSessionNode`;

  it("accepts the grouped alternation this view actually uses", () => {
    expect(whenMatches(GROUPED, "nexus.localServerRunning")).toBe(true);
    expect(whenMatches(GROUPED, "nexus.localServerSessionNode")).toBe(true);
    expect(whenMatches(GROUPED, "nexus.localServer")).toBe(false);
  });

  it("refuses the same clause with the parentheses dropped, instead of quietly agreeing with itself", () => {
    // Before: identical to GROUPED, so the whole file stayed green.
    expect(() => whenMatches(UNGROUPED, "nexus.localServerSessionNode")).toThrow(/ambiguous/i);
  });

  it("still refuses a token it does not understand", () => {
    expect(() => whenMatches(`${VIEW_PREFIX}config.nexus.somethingElse`, "x")).toThrow(/unsupported/i);
  });

  it("does not mistake a regex alternation for a top-level ||", () => {
    const when = `${VIEW_PREFIX}viewItem =~ /^nexus\\.serialProfile(Connected|Waiting)$/`;
    expect(whenMatches(when, "nexus.serialProfileWaiting")).toBe(true);
    expect(whenMatches(when, "nexus.serialProfileOther")).toBe(false);
  });

  it("every walked entry is in a shape the helper vouches for", () => {
    for (const entry of localServerEntries) {
      expect(() => whenMatches(entry.when!, "nexus.localServer"), entry.command).not.toThrow();
    }
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

  it("covers the generic terminal entries, not only the nexus.localServer.* ones", () => {
    // 8a: these three were outside the old command-prefix filter, so their
    // local-server clauses had no coverage here at all.
    for (const command of TERMINAL_COMMANDS) {
      expect(
        localServerEntries.some((e) => e.command === command),
        `${command} has no local-server entry in the walked set`
      ).toBe(true);
    }
  });

  it("keeps every other entry visible for a foldered row", () => {
    // Adding a contextValue suffix silently hides any entry still written as
    // an exact equality — the regression this suffix could most easily cause.
    const others = localServerEntries.filter((e) => e.command !== "nexus.localServer.moveToRoot");
    expect(others.length).toBeGreaterThan(0);
    const bases = ["nexus.localServer", "nexus.localServerRunning"];
    // Session rows carry no folder marker, but an entry contributed only for
    // them (the inline session actions) is still reachable, so it counts
    // towards the presence check below.
    const reachableFrom = [...bases, "nexus.localServerSessionNode"];
    for (const entry of others) {
      // PRESENCE. Asserting only match(foldered) === match(root) is satisfied
      // by false === false, so a clause mutated to match NOTHING passed. Every
      // entry has to be reachable from at least one real row before the
      // equality below means anything.
      expect(
        reachableFrom.filter((base) => whenMatches(entry.when!, base)),
        `${entry.command} (group ${entry.group}) matches no local-server row at all`
      ).not.toHaveLength(0);
      for (const base of bases) {
        expect(
          whenMatches(entry.when!, `${base}.inFolder`),
          `${entry.command} (group ${entry.group}) hides for a foldered ${base} row`
        ).toBe(whenMatches(entry.when!, base));
      }
    }
  });

  it("shows Reset and Clear Scrollback on a running row whether or not it sits in a folder", () => {
    // The original regression, now actually asserted: an exact
    // `viewItem == nexus.localServerRunning` equality leaves both disabled for
    // a foldered running row.
    for (const command of ["nexus.terminal.reset", "nexus.terminal.clearScrollback"]) {
      const when = localServerEntries.find((e) => e.command === command)!.when!;
      expect(whenMatches(when, "nexus.localServerRunning"), `${command} on a root running row`).toBe(true);
      expect(whenMatches(when, "nexus.localServerRunning.inFolder"), `${command} on a foldered running row`).toBe(true);
      expect(whenMatches(when, "nexus.localServerSessionNode"), `${command} on a session row`).toBe(true);
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
