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
 * `resolveIpmiGatewayServer` is the ONE read site for `ipmiGatewayServerId` on the
 * run path, and it keeps THREE dispositions distinct (Codex P1, safety):
 *
 *  - `none` — no gateway configured (id unset/self) → local IS the route.
 *  - `unavailable` — a gateway IS configured but cannot be reached (MISSING, i.e.
 *    the id dangles; or ADDRESSLESS, i.e. `host: ""` after inventory sync). The run
 *    path must ABORT, never fall back to local.
 *  - `server` — a reachable, addressed gateway to route through.
 *
 * Collapsing `unavailable` into `none`/undefined (the old behavior) is exactly the
 * bug: the dispatch reads undefined as "run locally", so a gateway-routed IPMI
 * command silently runs on THIS machine.
 *
 * The ADDRESSLESS case must also resolve FAST — as `unavailable`, never by handing
 * back a host-less server that the run path would try to CONNECT to (the addressless
 * guard blocks the transport, so the flow would hang out the ~90s CONNECT_SESSION
 * timeout).
 */
describe("resolveIpmiGatewayServer — three dispositions", () => {
  it("resolves an ADDRESSLESS gateway to { kind: 'unavailable', reason: 'addressless' }, never a connectable server (⊘ returning it as { kind:'server' } both hangs ~90s and lets the dispatch run locally)", () => {
    const target = server({ id: "t", ipmiGatewayServerId: "gw" });
    const gateway = server({ id: "gw", name: "stopped-gw", host: "", addressless: true });
    expect(resolveIpmiGatewayServer(ctxWith([target, gateway]), target)).toEqual({
      kind: "unavailable",
      reason: "addressless"
    });
  });

  it("resolves a MISSING (dangling id, no such server) gateway to { kind: 'unavailable', reason: 'missing' } (⊘ collapsing to { kind:'none' } lets the dispatch run locally)", () => {
    const target = server({ id: "t", ipmiGatewayServerId: "ghost" });
    expect(resolveIpmiGatewayServer(ctxWith([target]), target)).toEqual({
      kind: "unavailable",
      reason: "missing"
    });
  });

  it("resolves NO configured gateway (id unset) to { kind: 'none' } — local is the route (⊘ returning 'unavailable' here would wrongly abort a legitimate local run)", () => {
    const target = server({ id: "t" });
    expect(resolveIpmiGatewayServer(ctxWith([target]), target)).toEqual({ kind: "none" });
  });

  it("resolves a SELF-reference (id === own id) to { kind: 'none' } — treated as no gateway, local", () => {
    const target = server({ id: "t", ipmiGatewayServerId: "t" });
    expect(resolveIpmiGatewayServer(ctxWith([target]), target)).toEqual({ kind: "none" });
  });

  it("still resolves an addressed gateway to { kind: 'server' } normally (control — not a blanket refusal)", () => {
    const target = server({ id: "t", ipmiGatewayServerId: "gw" });
    const gateway = server({ id: "gw", name: "bastion", host: "10.0.0.9" });
    const resolution = resolveIpmiGatewayServer(ctxWith([target, gateway]), target);
    expect(resolution).toEqual({ kind: "server", server: gateway });
  });
});
