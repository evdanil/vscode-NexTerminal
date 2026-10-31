import { describe, expect, it } from "vitest";
import { parseExternalArgumentsText, externalServerFormValues } from "../../src/ui/externalCredentialForm";
describe("external arguments textarea bytes", () => {
  it("preserves interior spaces, quotes and backslashes with empty meaning zero arguments", () => {
    expect(parseExternalArgumentsText("")).toEqual([]);
    expect(parseExternalArgumentsText('space inside\na "quote"\nC:\\path')).toEqual(["space inside", 'a "quote"', "C:\\path"]);
  });
  it.each([" leading", "trailing ", "a\n", "a\n\nb", "a\rb", "\t", "x".repeat(4097), Array(33).fill("a").join("\n")])("rejects invalid entries instead of trimming or dropping: %s", (text) => {
    expect(() => parseExternalArgumentsText(text)).toThrow();
  });
});


it("retains the submitted lookup username while protecting hidden external credential fields", () => {
  const external = { id: "e", name: "Program", authType: "external" as const, external: { version: 1 as const, method: "password" as const } };
  expect(externalServerFormValues({ username: "alice", authType: "key", keyPath: "/forged" }, external, { username: "old", authType: "password" })).toEqual({ username: "alice", authType: "password", keyPath: undefined });
  expect(externalServerFormValues({}, undefined)).toEqual({});
});
