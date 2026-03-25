import { describe, expect, it } from "vitest";
import { serverFormDefinition, unifiedProfileFormDefinition } from "../../src/ui/formDefinitions";

function keyPathVisibleWhen(definition: ReturnType<typeof serverFormDefinition>) {
  const keyPathField = definition.fields.find(
    (field): field is Extract<(typeof definition.fields)[number], { key: string }> =>
      "key" in field && field.key === "keyPath"
  );
  expect(keyPathField).toBeDefined();
  return keyPathField!.visibleWhen;
}

describe("formDefinitions keyPath visibility", () => {
  it("shows server keyPath field only for authType=key", () => {
    const visibleWhen = keyPathVisibleWhen(serverFormDefinition());
    expect(visibleWhen).toEqual({ field: "authType", value: "key" });
  });

  it("compounds unified form keyPath visibility with profileType=ssh", () => {
    const definition = unifiedProfileFormDefinition();
    const keyPathField = definition.fields.find(
      (field): field is Extract<(typeof definition.fields)[number], { key: string }> =>
        "key" in field && field.key === "keyPath"
    );
    expect(keyPathField).toBeDefined();
    expect(Array.isArray(keyPathField!.visibleWhen)).toBe(true);
    expect(keyPathField!.visibleWhen).toEqual([
      { field: "profileType", value: "ssh" },
      { field: "authType", value: "key" }
    ]);
  });

  it("always includes auth profile selector with inline-create option in server form", () => {
    const definition = serverFormDefinition();
    const authProfileField = definition.fields.find(
      (field): field is Extract<(typeof definition.fields)[number], { key: string }> =>
        "key" in field && field.key === "authProfileId"
    );
    expect(authProfileField).toBeDefined();
    expect(authProfileField!.type).toBe("select");
    if (authProfileField && authProfileField.type === "select") {
      expect(authProfileField.options.some((option) => option.value === "__create__authProfile")).toBe(true);
    }
  });

  it("formats key auth profile options with the private key file name", () => {
    const definition = serverFormDefinition(
      undefined,
      [],
      true,
      [],
      [{ id: "ap-1", name: "Shared Key", username: "deploy", authType: "key", keyPath: "/keys/id_ed25519" }]
    );
    const authProfileField = definition.fields.find(
      (field): field is Extract<(typeof definition.fields)[number], { key: string; options: Array<{ label: string; value: string }> }> =>
        "key" in field && field.key === "authProfileId" && "options" in field
    );
    expect(authProfileField).toBeDefined();
    expect(authProfileField!.options.some((option) => option.label === "Shared Key — key — deploy — id_ed25519")).toBe(true);
  });

  it("preserves stored server credentials in edit form when auth profile is linked", () => {
    const definition = serverFormDefinition(
      {
        id: "srv-1",
        username: "stored-user",
        authType: "password",
        keyPath: "/stored/key",
        authProfileId: "ap-1"
      },
      [],
      true,
      [],
      [{ id: "ap-1", name: "Production", username: "live-user", authType: "key", keyPath: "/live/key" }]
    );
    const usernameField = definition.fields.find(
      (field): field is Extract<(typeof definition.fields)[number], { key: string; value?: unknown }> =>
        "key" in field && field.key === "username"
    );
    expect(usernameField).toBeDefined();
    expect(usernameField!.value).toBe("stored-user");
  });
});
