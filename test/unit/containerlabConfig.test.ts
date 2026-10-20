import { describe, expect, it } from "vitest";
import { containerlabDefaultRoute, parseContainerlabConfig } from "../../src/services/inventory/providers/containerlabConfig";

describe("Containerlab configuration", () => {
  it("applies safe defaults for a local host runner", () => {
    expect(parseContainerlabConfig({})).toEqual({
      location: "local",
      runner: "host",
      containerlabExecutable: "containerlab",
      dockerExecutable: "docker",
      dockerSocket: "/var/run/docker.sock",
      sudo: false,
      deviceConnection: "automatic",
      labFilter: "",
      addressPreference: "ipv4"
    });
  });

  it.each([
    ["location", "local"],
    ["runner", "host"],
    ["deviceConnection", "automatic"],
    ["addressPreference", "ipv4"]
  ])("rejects an invalid %s enum", (key, value) => {
    expect(() => parseContainerlabConfig({ [key]: `invalid-${value}` })).toThrow(/invalid/i);
  });

  it("requires a live SSH profile reference for remote execution", () => {
    expect(() => parseContainerlabConfig({ location: "ssh" })).toThrow(/labHostId.*required/i);
    expect(parseContainerlabConfig({ location: "ssh", labHostId: "profile-1" })).toMatchObject({
      location: "ssh",
      labHostId: "profile-1"
    });
    expect(() => parseContainerlabConfig({ location: "ssh", labHostId: " --help" })).toThrow(/labHostId/i);
  });

  it("requires the active runner reference and rejects option-shaped identifiers", () => {
    expect(() => parseContainerlabConfig({ runner: "disposable" })).toThrow(/runnerImage.*required/i);
    expect(() => parseContainerlabConfig({ runner: "existing" })).toThrow(/runnerContainer.*required/i);
    expect(() => parseContainerlabConfig({ runner: "existing", runnerContainer: "--help" })).toThrow(/runnerContainer/i);
    expect(parseContainerlabConfig({ runner: "disposable", runnerImage: "ghcr.io/srl-labs/clab:0.80.0" })).toMatchObject({
      runner: "disposable",
      runnerImage: "ghcr.io/srl-labs/clab:0.80.0"
    });
  });

  it("accepts executable names or absolute paths and rejects relative path fragments, options, and controls", () => {
    expect(parseContainerlabConfig({ containerlabExecutable: "/opt/clab/containerlab", dockerExecutable: "docker" })).toMatchObject({
      containerlabExecutable: "/opt/clab/containerlab",
      dockerExecutable: "docker"
    });
    for (const value of ["../containerlab", "tools/containerlab", "--help", "docker\n--context"] as const) {
      expect(() => parseContainerlabConfig({ containerlabExecutable: value })).toThrow();
    }
  });

  it("requires an absolute Unix Docker socket path and a boolean sudo choice", () => {
    expect(() => parseContainerlabConfig({ dockerSocket: "relative/docker.sock" })).toThrow(/absolute/i);
    expect(() => parseContainerlabConfig({ dockerSocket: "/run/../docker.sock" })).toThrow(/socket/i);
    expect(() => parseContainerlabConfig({ dockerSocket: "/run/docker.sock\n--host=x" })).toThrow(/socket/i);
    expect(() => parseContainerlabConfig({ sudo: "true" as never })).toThrow(/sudo/i);
    expect(parseContainerlabConfig({ dockerSocket: "/run/docker.sock", sudo: true })).toMatchObject({
      dockerSocket: "/run/docker.sock",
      sudo: true
    });
  });

  it("defaults remote automatic connections to the lab host and direct connections to Direct", () => {
    const remote = parseContainerlabConfig({ location: "ssh", labHostId: "profile-1" });
    expect(containerlabDefaultRoute(remote)).toEqual({ kind: "ssh", jumpHostId: "profile-1" });
    expect(containerlabDefaultRoute(parseContainerlabConfig({}))).toEqual({ kind: "direct" });
    expect(containerlabDefaultRoute(parseContainerlabConfig({ location: "ssh", labHostId: "profile-1", deviceConnection: "direct" })))
      .toEqual({ kind: "direct" });
  });

  it("does not turn a missing SSH discovery host into Direct", () => {
    const missingHost = { ...parseContainerlabConfig({}), location: "ssh" as const };
    expect(() => containerlabDefaultRoute(missingHost)).toThrow(/configured lab host SSH profile/i);
  });
});
