import { describe, expect, it } from "vitest";
import { applyJsonKeyEdits, deriveUserSettingsPath, hasUtf8Bom, stripUtf8Bom } from "../../src/services/terminal/settingsFileBom";

describe("deriveUserSettingsPath", () => {
  it("derives settings.json from a default-profile globalStorage path", () => {
    const input = "/home/u/.config/Code/User/globalStorage/sentriflow.vscode-nexterminal";
    expect(deriveUserSettingsPath(input)).toBe("/home/u/.config/Code/User/settings.json");
  });

  it("derives settings.json from a named-profile globalStorage path", () => {
    const input = "/home/u/.config/Code/User/profiles/abc123/globalStorage/sentriflow.vscode-nexterminal";
    expect(deriveUserSettingsPath(input)).toBe("/home/u/.config/Code/User/profiles/abc123/settings.json");
  });
});

describe("hasUtf8Bom", () => {
  it("returns true for bytes starting with the 3-byte BOM followed by content", () => {
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, 0x7b]);
    expect(hasUtf8Bom(bytes)).toBe(true);
  });

  it("returns false for bytes with no BOM", () => {
    const bytes = new Uint8Array([0x7b, 0x7d]);
    expect(hasUtf8Bom(bytes)).toBe(false);
  });

  it("returns false for a truncated 2-byte sequence that looks like a partial BOM", () => {
    const bytes = new Uint8Array([0xef, 0xbb]);
    expect(hasUtf8Bom(bytes)).toBe(false);
  });
});

describe("stripUtf8Bom", () => {
  it("strips the leading 3 BOM bytes and preserves all remaining content exactly", () => {
    // BOM + {"a":1}\r\n in UTF-8 bytes
    const content = '{"a":1}\r\n';
    const contentBytes = Buffer.from(content, "utf8");
    const bomBytes = new Uint8Array([0xef, 0xbb, 0xbf]);
    const withBom = new Uint8Array([...bomBytes, ...contentBytes]);
    const result = stripUtf8Bom(withBom);
    expect(Buffer.from(result).toString("utf8")).toBe(content);
  });

  it("returns the input unchanged when no BOM is present", () => {
    const bytes = new Uint8Array([0x7b, 0x7d]);
    const result = stripUtf8Bom(bytes);
    // Same content
    expect(result).toEqual(bytes);
  });
});

describe("applyJsonKeyEdits", () => {
  it("sets a flat dotted key to a new array value, preserving other keys", () => {
    const input = JSON.stringify({
      "terminal.integrated.commandsToSkipShell": ["old"],
      "editor.fontSize": 14,
    }, null, 4);
    const result = applyJsonKeyEdits(input, [
      { key: "terminal.integrated.commandsToSkipShell", action: "set", value: ["new1", "new2"] },
    ]);
    const parsed = JSON.parse(result) as Record<string, unknown>;
    expect(parsed["terminal.integrated.commandsToSkipShell"]).toEqual(["new1", "new2"]);
    expect(parsed["editor.fontSize"]).toBe(14);
  });

  it("deletes a flat dotted key, preserving other keys", () => {
    const input = JSON.stringify({
      "nexus.terminal.passthroughKeys": ["b", "e"],
      "editor.fontSize": 14,
    }, null, 4);
    const result = applyJsonKeyEdits(input, [
      { key: "nexus.terminal.passthroughKeys", action: "delete" },
    ]);
    const parsed = JSON.parse(result) as Record<string, unknown>;
    expect(Object.prototype.hasOwnProperty.call(parsed, "nexus.terminal.passthroughKeys")).toBe(false);
    expect(parsed["editor.fontSize"]).toBe(14);
  });

  it("applies multiple edits in sequence (set + delete), preserving untouched keys", () => {
    const input = JSON.stringify({
      "terminal.integrated.commandsToSkipShell": ["old"],
      "nexus.terminal.passthroughKeys": ["b"],
      "editor.fontSize": 14,
    }, null, 4);
    const result = applyJsonKeyEdits(input, [
      { key: "terminal.integrated.commandsToSkipShell", action: "set", value: ["macro1", "macro2"] },
      { key: "nexus.terminal.passthroughKeys", action: "delete" },
    ]);
    const parsed = JSON.parse(result) as Record<string, unknown>;
    expect(parsed["terminal.integrated.commandsToSkipShell"]).toEqual(["macro1", "macro2"]);
    expect(Object.prototype.hasOwnProperty.call(parsed, "nexus.terminal.passthroughKeys")).toBe(false);
    expect(parsed["editor.fontSize"]).toBe(14);
  });
});
