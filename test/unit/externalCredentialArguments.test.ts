import { describe, expect, it } from "vitest";
import { CredentialProviderError } from "../../src/services/credentials/credentialProviderError";
import { expandExternalCredentialArguments } from "../../src/services/credentials/externalCredentialArguments";

const context = {
  host: "node.example", port: 2222, SessionName: "lab router", username: "alice",
  profile: "Production", protocol: "ssh"
};

describe("external credential argument expansion", () => {
  it("expands supported values inside individual arguments without shell processing", () => {
    expect(expandExternalCredentialArguments([
      "--host=${host}", "${port}", "${SessionName}", "${username}", "${profile}", "${protocol}",
      "${host}:${port}/${host}", "$(touch nope); *"
    ], context)).toEqual([
      "--host=node.example", "2222", "lab router", "alice", "Production", "ssh",
      "node.example:2222/node.example", "$(touch nope); *"
    ]);
  });

  it("keeps escaped placeholders literal and does not expand replacement text recursively", () => {
    expect(expandExternalCredentialArguments(["$${host}", "$${unknown}", "${host}"],
      { ...context, host: "${username}" })).toEqual(["${host}", "${unknown}", "${username}"]);
  });

  it("escapes arbitrary text between braces without interpreting its contents", () => {
    expect(expandExternalCredentialArguments(["$${AWS_SECRET_KEY}", "$${foo-bar}", "$${}", "$${${host}}"], context))
      .toEqual(["${AWS_SECRET_KEY}", "${foo-bar}", "${}", "${${host}}"]);
  });

  it("reports a safe, actionable template error without revealing arguments or context", () => {
    const canary = "private-value-do-not-display";
    try {
      expandExternalCredentialArguments([canary + "=${unknown}"], { ...context, username: canary });
      throw new Error("Expected rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(CredentialProviderError);
      expect(error).toMatchObject({ code: "invalid-template" });
      expect(String(error)).toMatch(/Auth Profile/i);
      expect(String(error)).toMatch(/placeholder/i);
      expect(String(error)).toMatch(/username/i);
      expect(String(error)).not.toContain(canary);
    }
  });

  it.each(["${unknown}", "${}", "${host", "$${host", "${host${username}}"])(
    "rejects unsupported or malformed placeholder %s with a safe error", (value) => {
      try {
        expandExternalCredentialArguments([value], context);
        throw new Error("Expected rejection");
      } catch (error) {
        expect(error).toBeInstanceOf(CredentialProviderError);
        expect(String(error)).not.toContain(value);
      }
    }
  );

  it("requires values only when their placeholder is referenced", () => {
    const missing = { ...context, username: "" };
    expect(expandExternalCredentialArguments(["literal"], missing)).toEqual(["literal"]);
    expect(() => expandExternalCredentialArguments(["${username}"], missing)).toThrow(CredentialProviderError);
    expect(() => expandExternalCredentialArguments(["${host}"], { ...context, host: undefined } as unknown as typeof context)).toThrow(CredentialProviderError);
  });

  it.each([0, -1, 65536, 2.5, NaN, Infinity])("rejects invalid referenced port %s", (port) => {
    expect(() => expandExternalCredentialArguments(["${port}"], { ...context, port })).toThrow(CredentialProviderError);
  });

  it.each(["", " leading", "trailing ", "contains\0nul", "line\nbreak", "line\rreturn"])(
    "rejects invalid expanded argument", (host) => {
      expect(() => expandExternalCredentialArguments(["${host}"], { ...context, host })).toThrow(CredentialProviderError);
    }
  );

  it("checks the expanded UTF-8 byte length and argument count", () => {
    expect(expandExternalCredentialArguments(["${host}"], { ...context, host: "é".repeat(2048) })[0]).toHaveLength(2048);
    expect(() => expandExternalCredentialArguments(["${host}"], { ...context, host: "é".repeat(2049) })).toThrow(CredentialProviderError);
    expect(() => expandExternalCredentialArguments(Array(33).fill("x"), context)).toThrow(CredentialProviderError);
  });
});
