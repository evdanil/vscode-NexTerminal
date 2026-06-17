import { describe, expect, it } from "vitest";
import { deriveUserSettingsPath, hasUtf8Bom, stripUtf8Bom } from "../../src/services/terminal/settingsFileBom";

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
