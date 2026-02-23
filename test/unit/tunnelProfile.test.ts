import { describe, expect, it } from "vitest";
import type { TunnelProfile } from "../../src/models/config";
import { isTunnelRouteChanged, resolveBrowserUrl } from "../../src/utils/tunnelProfile";

const baseProfile: TunnelProfile = {
  id: "t1",
  name: "DB",
  localPort: 15432,
  remoteIP: "127.0.0.1",
  remotePort: 5432,
  autoStart: false,
  connectionMode: "isolated"
};

describe("resolveBrowserUrl", () => {
  it("returns https default when browserUrl is undefined", () => {
    expect(resolveBrowserUrl(baseProfile)).toBe("https://localhost:15432");
  });

  it("returns https default when browserUrl is empty string", () => {
    expect(resolveBrowserUrl({ ...baseProfile, browserUrl: "" })).toBe("https://localhost:15432");
  });

  it("substitutes {localPort} in custom URL", () => {
    expect(resolveBrowserUrl({ ...baseProfile, browserUrl: "http://localhost:{localPort}/admin" })).toBe("http://localhost:15432/admin");
  });

  it("substitutes multiple {localPort} occurrences", () => {
    expect(resolveBrowserUrl({ ...baseProfile, browserUrl: "https://localhost:{localPort}/api?port={localPort}" }))
      .toBe("https://localhost:15432/api?port=15432");
  });

  it("returns custom URL unchanged when no {localPort} placeholder", () => {
    expect(resolveBrowserUrl({ ...baseProfile, browserUrl: "https://myapp.local:8080/dashboard" }))
      .toBe("https://myapp.local:8080/dashboard");
  });

  it("rejects file:// scheme and falls back to default", () => {
    expect(resolveBrowserUrl({ ...baseProfile, browserUrl: "file:///etc/passwd" })).toBe("https://localhost:15432");
  });

  it("rejects javascript: scheme and falls back to default", () => {
    expect(resolveBrowserUrl({ ...baseProfile, browserUrl: "javascript:alert(1)" })).toBe("https://localhost:15432");
  });

  it("rejects vscode: scheme and falls back to default", () => {
    expect(resolveBrowserUrl({ ...baseProfile, browserUrl: "vscode://vscode.git/clone?url=evil" })).toBe("https://localhost:15432");
  });

  it("rejects data: scheme and falls back to default", () => {
    expect(resolveBrowserUrl({ ...baseProfile, browserUrl: "data:text/html,<script>alert(1)</script>" })).toBe("https://localhost:15432");
  });

  it("falls back to default for malformed URL", () => {
    expect(resolveBrowserUrl({ ...baseProfile, browserUrl: "not a url at all" })).toBe("https://localhost:15432");
  });
});

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

  it("returns false when autoStop changes", () => {
    expect(isTunnelRouteChanged(baseProfile, { ...baseProfile, autoStop: true })).toBe(false);
  });

  it("returns false when browserUrl changes", () => {
    expect(isTunnelRouteChanged(baseProfile, { ...baseProfile, browserUrl: "https://localhost:{localPort}/app" })).toBe(false);
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
