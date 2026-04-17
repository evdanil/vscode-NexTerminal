import { readFileSync } from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

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
});
