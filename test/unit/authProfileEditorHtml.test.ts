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

  it("shows the '✓ Saved' indicator ONLY when a just-saved name is passed", () => {
    const profiles: AuthProfile[] = [{ id: "ap1", name: "Prod", username: "root", authType: "password" }];
    // No justSavedName → indicator present in markup but NOT visible.
    const idle = renderAuthProfileEditorHtml(profiles, "ap1", nonce);
    expect(idle).toContain('id="save-flag"');
    expect(idle).not.toMatch(/class="save-indicator visible"/);
    // justSavedName set → indicator rendered visible (baked in, not a post-render
    // message that would race the webview reload), plus the auto-hide timer.
    const saved = renderAuthProfileEditorHtml(profiles, "ap1", nonce, "Prod");
    expect(saved).toMatch(/class="save-indicator visible"[^>]*id="save-flag"/);
    expect(saved).toContain("setTimeout(hideSaveFlag");
  });

  describe("SSH Agent note", () => {
    const AGENT_NOTE = /<div class="form-group conditional-field( visible)?" id="agent-note">/;

    function noteVisibleAfterSelecting(authType: string): boolean {
      const html = render();
      const start = html.indexOf("function updateConditionalFields()");
      expect(start).toBeGreaterThan(-1);
      let depth = 0;
      let end = -1;
      for (let i = html.indexOf("{", start); i < html.length; i++) {
        if (html[i] === "{") depth++;
        if (html[i] === "}" && --depth === 0) {
          end = i;
          break;
        }
      }
      const classes = (): { add: (c: string) => void; remove: (c: string) => void; has: (c: string) => boolean } => {
        const set = new Set<string>();
        return { add: (c) => set.add(c), remove: (c) => set.delete(c), has: (c) => set.has(c) };
      };
      const elements: Record<string, { value?: string; classList: ReturnType<typeof classes> }> = {
        "authtype-select-value": { value: authType, classList: classes() },
        "password-field": { classList: classes() },
        "keypath-field": { classList: classes() },
        "agent-note": { classList: classes() }
      };
      const document = { getElementById: (id: string) => elements[id] };
      (new Function("document", `${html.slice(start, end + 1)}\nupdateConditionalFields();`) as (doc: unknown) => void)(document);
      return elements["agent-note"].classList.has("visible");
    }

    it("is rendered visible only for an SSH Agent profile", () => {
      const agent = render([{ id: "a", name: "Fleet", username: "admin", authType: "agent" }], "a");
      expect(agent.match(AGENT_NOTE)?.[1]).toBe(" visible");
      const password = render([{ id: "p", name: "Pw", username: "admin", authType: "password" }], "p");
      expect(password).toMatch(AGENT_NOTE);
      expect(password.match(AGENT_NOTE)?.[1]).toBeUndefined();
    });

    it("follows the Authentication select (⊘ a note that stays as rendered when the type changes)", () => {
      expect(noteVisibleAfterSelecting("agent")).toBe(true);
      expect(noteVisibleAfterSelecting("key")).toBe(false);
      expect(noteVisibleAfterSelecting("password")).toBe(false);
    });

    it("says the same as the server form's note", () => {
      expect(render()).toContain("Uses the agent chosen in Settings → SSH → SSH Agent");
      expect(render()).toContain("One choice for every server on this machine.");
    });
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
