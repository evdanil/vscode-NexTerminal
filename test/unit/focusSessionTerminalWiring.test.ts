import { readFileSync } from "node:fs";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";

/**
 * LOCAL SERVER SESSION ROWS MUST BE CLICKABLE — THE JOIN, not the halves.
 *
 * `focusSessionTerminal` has always had a correct `"localServer"` branch, and
 * `LocalServerSessionTreeItem` has always emitted
 * `["<sessionId>", "localServer"]` as its command arguments. The click did
 * nothing anyway, because the ONE place that joins them —
 * `extension.ts`'s `nexus.focusSessionTerminal` registration — built its
 * options object without `localServerTerminals`, so the branch looked its
 * session up in a map that was never handed over and returned `false`.
 *
 * Both halves being individually correct is precisely why a test of either
 * half alone passes against the bug. `activate()` cannot be loaded without
 * mocking the whole extension host, so the registration is asserted from
 * source — the same technique `webExtensionCommands.test.ts` uses to hold
 * `extension.ts`/`webExtension.ts` wiring to `package.json`.
 */

const extensionPath = path.resolve(__dirname, "..", "..", "src", "extension.ts");

function focusCommandRegistration(source: string): string {
  const marker = 'registerCommand("nexus.focusSessionTerminal"';
  const start = source.indexOf(marker);
  expect(start, "nexus.focusSessionTerminal registration not found").toBeGreaterThan(-1);
  // The registration ends at the `);` closing focusSessionTerminal(...). A
  // generous fixed window covers it without depending on brace matching.
  return source.slice(start, start + 900);
}

describe("nexus.focusSessionTerminal wiring", () => {
  it("hands focusSessionTerminal every session-terminal map, local servers included", () => {
    const block = focusCommandRegistration(readFileSync(extensionPath, "utf8"));
    // Reverting the fix removes this line and the click goes dead again.
    expect(block).toContain("localServerTerminals");
    // The three that already worked, so a regression in either direction shows.
    expect(block).toContain("sessionTerminals");
    expect(block).toContain("serialTerminals");
    expect(block).toContain("localShellTerminals");
  });

  it("types the handler's session type from SessionTerminalType rather than a hand-copied union", () => {
    const source = readFileSync(extensionPath, "utf8");
    const block = focusCommandRegistration(source);
    expect(block).toMatch(/type:\s*SessionTerminalType/);
    // The stale inline union could not express "localServer" at all.
    expect(block).not.toMatch(/type:\s*"ssh"\s*\|/);
    expect(source).toMatch(/type SessionTerminalType[\s\S]*?from "\.\/utils\/sessionTerminalFocus"/);
  });
});

describe("local server session row → focusSessionTerminal", () => {
  it("focuses the local server terminal when the row's own command arguments are replayed", async () => {
    vi.resetModules();
    vi.doMock("vscode", () => ({
      TreeItem: class {
        public id?: string;
        public description?: string;
        public iconPath?: unknown;
        public contextValue?: string;
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

    const { LocalServerSessionTreeItem } = await import("../../src/ui/nexusTreeProvider");
    const { focusSessionTerminal } = await import("../../src/utils/sessionTerminalFocus");

    const item = new LocalServerSessionTreeItem({
      id: "ls-session-1",
      configId: "cfg-1",
      terminalName: "Nexus Local Server: API",
      status: "running",
      startedAt: 0,
      restartAttempts: 0
    });

    const [sessionId, type] = (item.command as { arguments: [string, never] }).arguments;
    expect(sessionId).toBe("ls-session-1");
    expect(type).toBe("localServer");

    const terminal = { show: vi.fn() };
    const clearSessionActivity = vi.fn();
    const options = {
      core: { clearSessionActivity },
      sessionTerminals: new Map(),
      serialTerminals: new Map(),
      localShellTerminals: new Map(),
      localServerTerminals: new Map([["ls-session-1", { terminal: terminal as never }]]),
      activityIndicators: new Map()
    };

    expect(focusSessionTerminal(options, sessionId, type)).toBe(true);
    expect(terminal.show).toHaveBeenCalledTimes(1);

    // The shape extension.ts actually passed before the fix: same session, same
    // type, no map — nothing to focus. This is the behaviour the wiring
    // assertion above exists to keep out of extension.ts.
    const { localServerTerminals: _omitted, ...withoutTheMap } = options;
    expect(focusSessionTerminal(withoutTheMap, sessionId, type)).toBe(false);
    expect(terminal.show).toHaveBeenCalledTimes(1);

    vi.doUnmock("vscode");
    vi.resetModules();
  });
});
