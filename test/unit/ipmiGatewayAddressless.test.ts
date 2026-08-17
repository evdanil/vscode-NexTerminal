import { describe, expect, it, vi } from "vitest";

// serverMacroCommands imports `vscode` at module scope; the pure resolver under
// test needs none of it.
vi.mock("vscode", () => ({
  commands: { registerCommand: vi.fn(() => ({ dispose: vi.fn() })), executeCommand: vi.fn() },
  window: { showWarningMessage: vi.fn(), showInformationMessage: vi.fn(), showErrorMessage: vi.fn(), createTerminal: vi.fn(), setStatusBarMessage: vi.fn() },
  workspace: { getConfiguration: vi.fn(() => ({ get: vi.fn() })) },
  Uri: { file: (p: string) => ({ fsPath: p }) },
  env: { openExternal: vi.fn() },
  ProgressLocation: { Notification: 15 },
  ThemeIcon: class {},
  ThemeColor: class {},
  TreeItem: class {},
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
  MarkdownString: class { public appendMarkdown = vi.fn(); },
  EventEmitter: class { public event = vi.fn(); public fire = vi.fn(); public dispose = vi.fn(); }
}));

import { resolveIpmiGatewayServer } from "../../src/commands/serverMacroCommands";
import type { ServerConfig } from "../../src/models/config";
import type { CommandContext } from "../../src/commands/types";

function server(overrides: Partial<ServerConfig> = {}): ServerConfig {
  return { id: "s", name: "n", host: "10.0.0.1", port: 22, username: "u", authType: "agent", isHidden: false, ...overrides };
}

function ctxWith(servers: ServerConfig[]): CommandContext {
  return { core: { getSnapshot: () => ({ servers }) } } as unknown as CommandContext;
}

/**
 * ADDRESSLESS (Codex P1 review MINOR-2) — `resolveIpmiGatewayServer` is the ONE
 * read site for `ipmiGatewayServerId` on the run path. An addressless gateway
 * has no console to route ipmitool through, so it must resolve to "no reachable
 * gateway" (the same disposition a dangling id gets) — otherwise the run path
 * tries to connect to it, the addressless connect guard blocks the transport,
 * no session ever appears, and the flow hangs out the ~90s CONNECT_SESSION
 * timeout with a misleading "no session appeared".
 */
describe("resolveIpmiGatewayServer — addressless gateway", () => {
  it("resolves an addressless gateway to undefined (run locally), never returning it for a connect attempt (⊘ returning the addressless server hangs the routed flow ~90s)", () => {
    const target = server({ id: "t", ipmiGatewayServerId: "gw" });
    const gateway = server({ id: "gw", name: "stopped-gw", host: "", addressless: true });
    expect(resolveIpmiGatewayServer(ctxWith([target, gateway]), target)).toBeUndefined();
  });

  it("still resolves an addressed gateway normally (control — not a blanket refusal)", () => {
    const target = server({ id: "t", ipmiGatewayServerId: "gw" });
    const gateway = server({ id: "gw", name: "bastion", host: "10.0.0.9" });
    expect(resolveIpmiGatewayServer(ctxWith([target, gateway]), target)?.id).toBe("gw");
  });
});
