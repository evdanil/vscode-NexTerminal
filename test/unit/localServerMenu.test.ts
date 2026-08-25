import { readFileSync } from "node:fs";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";

/**
 * THE LOCAL SERVERS CONTEXT MENU, AGAINST THE REAL package.json AND REAL ROWS.
 *
 * History, because it explains what is asserted and what deliberately is not.
 * "Move to Root" was a separate always-present entry gated on
 * `viewItemFolder != null` — a context key nothing in `src/` ever sets, so it
 * never appeared. VS Code has no per-item context key, so the first fix moved
 * the folder state onto the row's own `contextValue` as a `.inFolder` suffix,
 * which then had to be admitted by a regex in roughly eighteen other clauses
 * so the suffix would not hide every OTHER entry on a foldered row.
 *
 * That whole mechanism is gone. "Move to Folder…" now opens a picker whose
 * destinations include "(root)", the shape macros have always used, so nothing
 * in the manifest needs to know whether a row sits in a folder and every clause
 * is back to its simple pre-suffix form.
 *
 * What survives is the coverage that mechanism's tests were missing: the
 * generic terminal entries are walked alongside the `nexus.localServer.*` ones,
 * every entry has to be reachable from a real row rather than merely agreeing
 * with itself, and the `when`-clause helper models VS Code's actual operator
 * precedence instead of flattening it.
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
 * a filter on the `nexus.localServer.` command prefix skipped all three — so
 * their local-server clauses had no coverage here at all, and breaking one of
 * them left every test green.
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

describe("LocalServerConfigTreeItem contextValue", () => {
  it("says only whether the row is running — a folder is not part of its identity", () => {
    // The `.inFolder` marker existed solely to gate a "Move to Root" entry that
    // no longer exists. Re-introducing it would silently hide every clause
    // written as an exact equality, which is now all of them again.
    expect(configItem({ group: "Production/APIs" }).contextValue).toBe("nexus.localServer");
    expect(configItem({}).contextValue).toBe("nexus.localServer");
    expect(configItem({ group: "Production" }, true).contextValue).toBe("nexus.localServerRunning");
    expect(configItem({}, true).contextValue).toBe("nexus.localServerRunning");
  });

  it("is identical for a foldered and a root-level row, so one menu entry serves both", () => {
    expect(configItem({ group: "Production" }).contextValue).toBe(configItem({}).contextValue);
    expect(configItem({ group: "" }).contextValue).toBe(configItem({}).contextValue);
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
  it("contributes no Move to Root command or menu entry at all", () => {
    const manifest = readFileSync(packageJsonPath, "utf8");
    expect(manifest).not.toContain("moveToRoot");
    // And the mechanism that existed only to gate it is gone with it.
    expect(manifest).not.toContain("inFolder");
    expect(manifest).not.toContain("viewItemFolder");
  });

  it("offers Move to Folder… from every config row, foldered or not", () => {
    // One entry replaces the old pair: its picker offers "(root)" as a
    // destination, so a row already in a folder needs no separate command.
    const when = localServerEntries.find((e) => e.command === "nexus.localServer.moveToFolder")!.when!;
    expect(whenMatches(when, configItem({ group: "Production" }).contextValue!)).toBe(true);
    expect(whenMatches(when, configItem({}).contextValue!)).toBe(true);
    expect(whenMatches(when, configItem({ group: "Production" }, true).contextValue!)).toBe(true);
    expect(whenMatches(when, configItem({}, true).contextValue!)).toBe(true);
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

  it("leaves every entry reachable from a real row", () => {
    // PRESENCE. The predecessor of this test compared match(foldered) against
    // match(root), which `false === false` satisfies — a clause mutated to
    // match NOTHING still passed. Every entry must actually be reachable.
    expect(localServerEntries.length).toBeGreaterThan(0);
    const rows = [
      configItem({}).contextValue!,
      configItem({}, true).contextValue!,
      "nexus.localServerSessionNode"
    ];
    for (const entry of localServerEntries) {
      expect(
        rows.filter((row) => whenMatches(entry.when!, row)),
        `${entry.command} (group ${entry.group}) matches no local-server row at all`
      ).not.toHaveLength(0);
    }
  });

  it("shows Reset and Clear Scrollback on every running row", () => {
    for (const command of ["nexus.terminal.reset", "nexus.terminal.clearScrollback"]) {
      const when = localServerEntries.find((e) => e.command === command)!.when!;
      expect(whenMatches(when, configItem({}, true).contextValue!), `${command} on a running config row`).toBe(true);
      expect(
        whenMatches(when, configItem({ group: "Production" }, true).contextValue!),
        `${command} on a running config row inside a folder`
      ).toBe(true);
      expect(whenMatches(when, "nexus.localServerSessionNode"), `${command} on a session row`).toBe(true);
      // Still hidden where there is no terminal to act on.
      expect(whenMatches(when, configItem({}).contextValue!), `${command} on a stopped row`).toBe(false);
    }
  });

  it("gates the real tree items rather than hypothetical contextValues", () => {
    // Every walked clause is exercised against the contextValue the tree
    // provider actually produces, so a change on either side is caught.
    const rows = [
      configItem({ group: "Production" }).contextValue!,
      configItem({}).contextValue!,
      configItem({ group: "Production" }, true).contextValue!,
      configItem({}, true).contextValue!
    ];
    for (const entry of localServerEntries) {
      for (const row of rows) {
        expect(() => whenMatches(entry.when!, row), `${entry.command} vs ${row}`).not.toThrow();
      }
    }
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

  it.each(["nexus.localServerRunning", "nexus.localServerSessionNode"])(
    "shows Copy All on a %s row",
    (contextValue) => {
      const copyAll = localServerTerminalEntries("nexus.terminal.copyAll")[0].when!;
      expect(whenMatches(copyAll, contextValue)).toBe(true);
    }
  );

  it("sits in the same menu group as Reset and Clear Scrollback", () => {
    const copyAll = localServerTerminalEntries("nexus.terminal.copyAll")[0];
    expect(copyAll.group).toMatch(/^1_terminal@/);
  });
});
