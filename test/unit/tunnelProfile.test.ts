import { describe, expect, it } from "vitest";
import type { TunnelProfile } from "../../src/models/config";
import { isTunnelRouteChanged } from "../../src/utils/tunnelProfile";

const baseProfile: TunnelProfile = {
  id: "t1",
  name: "DB",
  localPort: 15432,
  remoteIP: "127.0.0.1",
  remotePort: 5432,
  autoStart: false,
  connectionMode: "isolated"
};

describe("isTunnelRouteChanged", () => {
  it("returns false when route fields are unchanged", () => {
    const next: TunnelProfile = {
      ...baseProfile,
      name: "DB renamed",
      autoStart: true,
      connectionMode: "shared"
    };
    expect(isTunnelRouteChanged(baseProfile, next)).toBe(false);
  });

  it("returns true when route fields changed", () => {
    expect(
      isTunnelRouteChanged(baseProfile, {
        ...baseProfile,
        localPort: 15433
      })
    ).toBe(true);
    expect(
      isTunnelRouteChanged(baseProfile, {
        ...baseProfile,
        remoteIP: "10.0.0.5"
      })
    ).toBe(true);
    expect(
      isTunnelRouteChanged(baseProfile, {
        ...baseProfile,
        remotePort: 6432
      })
    ).toBe(true);
  });
});
