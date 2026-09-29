import { describe, expect, it } from "vitest";
import { buildPortReleaseFailedMessage } from "../../src/services/serial/portReleaseNotice";

describe("buildPortReleaseFailedMessage", () => {
  it("names the port and the Reload Window remedy", () => {
    const message = buildPortReleaseFailedMessage("COM9");
    expect(message).toContain("COM9");
    expect(message).toContain("Reload Window");
  });

  it("flattens control and bidi characters in the path", () => {
    const message = buildPortReleaseFailedMessage("COM9\n\u202Eevil\u0007");
    expect(message).not.toMatch(/[\n\u202E\u0007]/);
    expect(message).toContain("COM9 evil");
  });
});
