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
  it("covers all contributed commands", () => {
    const contributed = packageJson.contributes.commands.map((item) => item.command).sort();
    const source = readFileSync(webExtensionPath, "utf8");
    const fallback = extractWebExtensionCommands(source).sort();

    expect(fallback).toEqual(contributed);
  });
});
