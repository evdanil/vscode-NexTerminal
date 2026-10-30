import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

// Open VSX rejected these examples with hashicorp-tf-password. Pin the upstream
// detector (gitleaks v8.18.3 config/gitleaks.toml), not the script's implementation.
const detector = new RegExp("(?:administrator_login_password|password)(?:[0-9a-z\\-_\\t .]{0,20})(?:[\\s|']|[\\s|\"]){0,3}(?:=|>|:{1,3}=|\\|\\|:|<=|=>|:|\\?=)(?:'|\\\"|\\s|=|\\x60){0,5}(\"[a-z0-9=_\\-]{8,20}\")(?:['|\\\"|\\n|\\r|\\s|\\x60|;]|$)", "i");
describe("external credential examples packaging", () => {
  it("keeps the detector sensitive to a synthetic password assignment", () => {
    expect(detector.test('password = "exampleonlyvalue"')).toBe(true);
  });
  it.each(["1password.cjs", "vault-provider.cjs"])("does not resemble an embedded secret: %s", (name) => {
    expect(detector.test(readFileSync(`examples/external-credentials/${name}`, "utf8"))).toBe(false);
  });
});
