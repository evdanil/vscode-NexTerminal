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
});
