import { readFileSync } from "node:fs";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import { activate } from "../../src/webExtension";

const web = vi.hoisted(() => ({ commands: new Map<string, () => void>(), warning: vi.fn(), execute: vi.fn() }));
vi.mock("vscode", () => ({
  EventEmitter: class { event = vi.fn(); dispose = vi.fn(); },
  window: { createTreeView: vi.fn(() => ({ dispose: vi.fn() })), showWarningMessage: web.warning },
  commands: { registerCommand: vi.fn((id: string, run: () => void) => { web.commands.set(id, run); return { dispose: () => web.commands.delete(id) }; }), executeCommand: web.execute }
}));

const packageJsonPath = path.resolve(__dirname, "..", "..", "package.json");
const webExtensionPath = path.resolve(__dirname, "..", "..", "src", "webExtension.ts");

const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
  contributes: {
    commands: Array<{ command: string }>;
  };
};

function extractWebExtensionCommands(source: string): string[] {
  return [...new Set((source.match(/"nexus\.[^"]+"/g) ?? []).map((value) => value.slice(1, -1)))];
}

function extractUnsupportedCommands(source: string): string[] {
  const match = source.match(/const unsupportedCommands = \[([\s\S]*?)\];/);
  return match ? extractWebExtensionCommands(match[1]) : [];
}

describe("web extension fallback command coverage", () => {
  it("covers all Nexus-owned contributed commands", () => {
    // Only our own `nexus.*` commands need desktop-only fallback stubs; a
    // built-in VS Code command declared in `contributes.commands` purely to
    // give a menu item a label (e.g. `revealInExplorer`) is provided by the
    // host on both desktop and web and must not be stubbed.
    const contributed = packageJson.contributes.commands
      .map((item) => item.command)
      .filter((id) => id.startsWith("nexus."))
      .sort();
    const source = readFileSync(webExtensionPath, "utf8");
    const fallback = extractWebExtensionCommands(source).sort();

    expect(fallback).toEqual(contributed);
  });

  it("includes a graceful web fallback for the macro guide command", () => {
    const source = readFileSync(webExtensionPath, "utf8");
    expect(extractWebExtensionCommands(source)).toContain("nexus.macro.openDocs");
    expect(extractUnsupportedCommands(source)).not.toContain("nexus.macro.openDocs");
    expect(source).toContain('registerCommand("nexus.macro.openDocs"');
    expect(source).toContain("openExternal");
  });
});


it("external credential commands are explicit unavailable handlers in the browser host", () => {
  const subscriptions: Array<{ dispose(): void }> = [];
  activate({ subscriptions } as unknown as vscode.ExtensionContext);
  for (const command of ["revokeExternalApprovals", "continueExternalApproval", "cancelExternalApproval"]) {
    web.warning.mockClear();
    const handler = web.commands.get(`nexus.authProfile.${command}`);
    expect(handler).toBeDefined();
    handler!();
    expect(web.warning).toHaveBeenCalledWith("Nexus runtime features are unavailable in the web extension host. Use desktop VS Code.");
  }
  expect(web.execute).not.toHaveBeenCalled();
  subscriptions.forEach((subscription) => subscription.dispose());
  expect(web.commands.size).toBe(0);
});
