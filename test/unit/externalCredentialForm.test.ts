import { describe, expect, it } from "vitest";
import { parseExternalArgumentsText, externalServerFormValues, externalSourceFormValues } from "../../src/ui/externalCredentialForm";
describe("external arguments textarea bytes", () => {
  it("preserves interior spaces, quotes and backslashes with empty meaning zero arguments", () => {
    expect(parseExternalArgumentsText("")).toEqual([]);
    expect(parseExternalArgumentsText('space inside\na "quote"\nC:\\path')).toEqual(["space inside", 'a "quote"', "C:\\path"]);
  });
  it.each([" leading", "trailing ", "a\n", "a\n\nb", "a\rb", "\t", "x".repeat(4097), Array(33).fill("a").join("\n")])("rejects invalid entries instead of trimming or dropping: %s", (text) => {
    expect(() => parseExternalArgumentsText(text)).toThrow();
  });
});


it("uses only host-owned dormant defaults for new external records; stored and missing links still need normal fields", () => {
  const external = { id: "e", name: "Program", authType: "external" as const, external: { version: 1 as const, method: "password" as const } };
  expect(externalServerFormValues({ username: "forged", authType: "key", keyPath: "/forged" }, external)).toEqual({ username: "root", authType: "password", keyPath: undefined });
  expect(externalSourceFormValues({ defaultUsername: "forged" }, external, "")).toEqual({ defaultUsername: "root" });
  expect(externalSourceFormValues({}, external, "seeded")).toEqual({ defaultUsername: "seeded" });
  expect(externalServerFormValues({}, undefined)).toEqual({});
  expect(externalSourceFormValues({}, { id: "p", name: "Stored", authType: "password", username: "admin" }, "")).toEqual({});
});
