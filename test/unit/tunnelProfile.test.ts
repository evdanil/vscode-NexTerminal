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

  it("returns true when tunnelType changes", () => {
    expect(
      isTunnelRouteChanged(baseProfile, {
        ...baseProfile,
        tunnelType: "reverse"
      })
    ).toBe(true);
  });

  it("returns true when remoteBindAddress changes", () => {
    const reverseProfile: TunnelProfile = {
      ...baseProfile,
      tunnelType: "reverse",
      remoteBindAddress: "127.0.0.1"
    };
    expect(
      isTunnelRouteChanged(reverseProfile, {
        ...reverseProfile,
        remoteBindAddress: "0.0.0.0"
      })
    ).toBe(true);
  });

  it("returns true when localTargetIP changes", () => {
    const reverseProfile: TunnelProfile = {
      ...baseProfile,
      tunnelType: "reverse",
      localTargetIP: "127.0.0.1"
    };
    expect(
      isTunnelRouteChanged(reverseProfile, {
        ...reverseProfile,
        localTargetIP: "192.168.1.100"
      })
    ).toBe(true);
  });

  it("returns false when non-route fields change on reverse profile", () => {
    const reverseProfile: TunnelProfile = {
      ...baseProfile,
      tunnelType: "reverse",
      remoteBindAddress: "127.0.0.1",
      localTargetIP: "127.0.0.1"
    };
    expect(
      isTunnelRouteChanged(reverseProfile, {
        ...reverseProfile,
        name: "Renamed",
        autoStart: true
      })
    ).toBe(false);
  });
});
