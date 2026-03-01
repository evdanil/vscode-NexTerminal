import { describe, expect, it } from "vitest";
import { renderAuthProfileEditorHtml } from "../../src/ui/authProfileEditorHtml";
import type { AuthProfile } from "../../src/models/config";

const nonce = "test-nonce-auth";

function render(profiles: AuthProfile[] = [], selectedId: string | null = null): string {
  return renderAuthProfileEditorHtml(profiles, selectedId, nonce);
}

describe("renderAuthProfileEditorHtml", () => {
  it("includes CSP meta tag with nonce", () => {
    const html = render();
    expect(html).toContain(`nonce-${nonce}`);
  });

  it("renders auth type options", () => {
    const html = render();
    expect(html).toContain('data-value="password"');
    expect(html).toContain('data-value="key"');
    expect(html).toContain('data-value="agent"');
  });

  it("calls selectCustomOption for authtype-selector in onOptionClick callback", () => {
    const html = render();
    // Assert the exact authtype branch body so this fails if the call is removed.
    expect(html).toMatch(
      /if\s*\(\s*wrapper\.id\s*===\s*"authtype-selector"\s*\)\s*\{\s*selectCustomOption\s*\(\s*wrapper\s*,\s*value\s*\)\s*;\s*markDirty\s*\(\s*\)\s*;\s*updateConditionalFields\s*\(\s*\)\s*;\s*\}/
    );
  });

  it("populates form fields for selected profile", () => {
    const profile: AuthProfile = {
      id: "p1",
      name: "Test Profile",
      username: "admin",
      authType: "key",
      keyPath: "/home/user/.ssh/id_ed25519",
    };
    const html = render([profile], "p1");
    expect(html).toContain('value="Test Profile"');
    expect(html).toContain('value="admin"');
    expect(html).toContain('value="key"');
    expect(html).toContain('value="/home/user/.ssh/id_ed25519"');
  });

  it("shows password field visible by default for new profile", () => {
    const html = render();
    expect(html).toContain('id="password-field"');
    expect(html).toMatch(/password-field[^>]*visible/);
  });

  it("shows keypath field visible when authType is key", () => {
    const profile: AuthProfile = {
      id: "p1",
      name: "Key Profile",
      username: "root",
      authType: "key",
      keyPath: "~/.ssh/id_ed25519",
    };
    const html = render([profile], "p1");
    expect(html).toMatch(/keypath-field[^>]*visible/);
  });
});
