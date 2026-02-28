import { describe, expect, it, vi } from "vitest";
import { tryRegisterResourceLabelFormatter } from "../../src/services/sftp/resourceLabelFormatter";

describe("tryRegisterResourceLabelFormatter", () => {
  it("registers formatter when API exists", () => {
    const registerResourceLabelFormatter = vi.fn();
    const workspace = { registerResourceLabelFormatter };

    tryRegisterResourceLabelFormatter(workspace, "nexterm");

    expect(registerResourceLabelFormatter).toHaveBeenCalledTimes(1);
    expect(registerResourceLabelFormatter).toHaveBeenCalledWith({
      scheme: "nexterm",
      formatting: {
        label: "${authority}${path}",
        separator: "/",
        tildify: false,
        workspaceSuffix: "",
      },
    });
  });

  it("does nothing when API is unavailable", () => {
    expect(() => tryRegisterResourceLabelFormatter({}, "nexterm")).not.toThrow();
  });

  it("swallows formatter registration errors", () => {
    const workspace = {
      registerResourceLabelFormatter: vi.fn(() => {
        throw new Error("boom");
      }),
    };

    expect(() => tryRegisterResourceLabelFormatter(workspace, "nexterm")).not.toThrow();
  });
});
