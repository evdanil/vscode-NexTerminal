import { describe, expect, it } from "vitest";
import { renderAuthProfileEditorHtml } from "../../src/ui/authProfileEditorHtml";
import { StubElement } from "../helpers/formScriptHarness";

function editor(profiles: Parameters<typeof renderAuthProfileEditorHtml>[0] = [], selectedId: string | null = null) {
  const html = renderAuthProfileEditorHtml(profiles, selectedId, "nonce");
  const elements = new Map<string, StubElement>();
  for (const match of html.matchAll(/<([a-z]+)[^>]*\bid="([^"]+)"[^>]*>/g)) {
    const el = new StubElement(match[1].toUpperCase(), /class="([^"]*)"/.exec(match[0])?.[1].split(" ") ?? []);
    el.value = /\bvalue="([^"]*)"/.exec(match[0])?.[1] ?? "";
    el.checked = /\schecked(?:\s|\/?>)/.test(match[0]); elements.set(match[2], el);
  }
  const field = (id: string) => { const el = elements.get(id); if (!el) throw new Error(id); return el; };
  const groups: Record<string, string[]> = {
    "username-field": ["profile-username"], "password-field": ["profile-password"], "keypath-field": ["profile-keypath", "browse-btn"],
    "external-field": ["external-method", "external-executable", "external-arguments", "external-argument-expansion", "external-browse-btn"]
  };
  for (const [group, ids] of Object.entries(groups)) for (const id of ids) field(group).append(field(id));
  const posted: Record<string, unknown>[] = []; let message!: (event: { data: unknown }) => void;
  let choose!: (wrapper: { id: string; classList: StubElement["classList"] }, opt: { dataset: { value: string } }) => void;
  const doc = { getElementById: (id: string) => field(id) };
  const start = html.indexOf("(function() {"); const end = html.indexOf("</script>", start);
  new Function("document", "window", "acquireVsCodeApi", "initCustomSelects", "selectCustomOption", "setTimeout", html.slice(start, end))(
    doc, { addEventListener: (_event: string, callback: typeof message) => { message = callback; } },
    () => ({ postMessage: (msg: Record<string, unknown>) => posted.push(msg) }),
    (callback: typeof choose) => { choose = callback; },
    (wrapper: { id: string }, value: string) => { field(wrapper.id === "authtype-selector" ? "authtype-select-value" : "external-method").value = value; },
    () => 0
  );
  return { field, posted, deliver: (data: unknown) => message({ data }), choose: (id: string, value: string) => { choose({ id, classList: field(id).classList }, { dataset: { value } }); field(id).dispatch("click"); } };
}

describe("external auth editor actual script", () => {
  it("routes repair navigation through the existing dirty-switch decision", () => {
    const h = editor();
    h.deliver({ type: "requestProfileSwitch", targetValue: "ap2" });
    expect(h.posted.pop()).toEqual({ type: "selectProfile", value: "ap2" });
    h.field("profile-name").value = "Unsaved"; h.field("profile-name").dispatch("input");
    h.deliver({ type: "requestProfileSwitch", targetValue: "ap3" });
    expect(h.posted.pop()).toEqual({ type: "confirmSwitch", targetValue: "ap3" });
    expect(h.field("profile-name").value).toBe("Unsaved");
  });
  it("submits only active external fields and preserves exact argument bytes", () => {
    const h = editor(); h.field("profile-name").value = "Program"; h.field("profile-username").value = "dormant"; h.field("profile-password").value = "secret";
    h.choose("authtype-selector", "external"); h.field("external-executable").value = "/provider"; h.field("external-arguments").value = 'a "quote"\nC:\\path';
    h.field("save-btn").dispatch("click");
    expect(h.posted.at(-1)).toEqual({ type: "save", id: null, name: "Program", authType: "external", external: { version: 1, method: "password", invocation: { executable: "/provider", args: ['a "quote"', "C:\\path"] } } });
    expect(h.field("profile-username").disabled).toBe(true); expect(h.field("profile-password").disabled).toBe(true);
    h.choose("authtype-selector", "password"); expect(h.field("profile-username").value).toBe("dormant"); expect(h.field("profile-password").value).toBe("secret");
  });
  it("saves enabled argument expansion and marks changing it dirty", () => {
    const h = editor();
    h.field("profile-name").value = "Program"; h.choose("authtype-selector", "external");
    h.field("external-executable").value = "/provider"; h.field("external-arguments").value = "${host}";
    h.field("external-argument-expansion").checked = true; h.field("external-argument-expansion").dispatch("change");
    expect(h.field("dirty-flag").classList.contains("visible")).toBe(true);
    h.field("save-btn").dispatch("click");
    expect(h.posted.at(-1)).toMatchObject({ external: { invocation: { args: ["${host}"], argumentExpansion: true } } });
  });
  it("reopens enabled expansion and saves literal mode when disabled", () => {
    const profile = { id: "e", name: "Program", authType: "external" as const, external: { version: 1 as const, method: "password" as const, invocation: { executable: "/provider", args: [], argumentExpansion: true } } };
    const h = editor([profile], "e");
    expect(h.field("external-argument-expansion").checked).toBe(true);
    h.field("external-argument-expansion").checked = false;
    h.field("external-argument-expansion").dispatch("change");
    h.field("save-btn").dispatch("click");
    expect((h.posted.at(-1)?.external as { invocation: Record<string, unknown> }).invocation.argumentExpansion).toBeUndefined();
  });
  it("rejects invalid lines inline with aria-invalid and keeps the draft across revoke feedback", () => {
    const h = editor(); h.field("profile-name").value = "Unsaved"; h.choose("authtype-selector", "external"); h.field("external-executable").value = "/provider"; h.field("external-arguments").value = "a\n";
    h.field("save-btn").dispatch("click"); expect(h.posted).toEqual([]); expect(h.field("external-arguments").getAttribute("aria-invalid")).toBe("true");
    expect(h.field("error-external-arguments").textContent).toContain("nonempty");
    h.field("revoke-external-btn").dispatch("click"); h.deliver({ type: "externalApprovalsStatus", message: "Revoked" });
    expect(h.posted).toEqual([{ type: "revokeExternalApprovals" }]); expect(h.field("profile-name").value).toBe("Unsaved");
    expect(h.field("external-arguments").value).toBe("a\n"); expect(h.field("dirty-flag").classList.contains("visible")).toBe(true); expect(h.field("save-flag").classList.contains("visible")).toBe(false);
  });
});
