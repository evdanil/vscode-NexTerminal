import { describe, expect, it } from "vitest";
import { parseContainerlabConfig } from "../../src/services/inventory/providers/containerlabConfig";
import {
  CONTAINERLAB_INSPECT_ARGS,
  buildContainerlabInspectionCommand,
  containerlabCleanEnvironment,
  quotePosixToken
} from "../../src/services/inventory/providers/containerlabCommands";
import type { ContainerlabExecutionIdentity } from "../../src/services/inventory/containerlabRuntimeContracts";

function identity(location: "local" | "ssh", runner: "host" | "disposable" | "existing"): ContainerlabExecutionIdentity {
  return {
    executable: runner === "host" ? "/usr/bin/containerlab" : "/usr/local/bin/containerlab",
    dockerExecutable: runner === "host" ? undefined : "/usr/bin/docker",
    imageId: runner === "disposable" ? `sha256:${"a".repeat(64)}` : undefined,
    containerId: runner === "existing" ? "b".repeat(64) : undefined,
    dockerSocket: "/run/docker.sock",
    location,
    sudo: true,
    routeIdentity: location === "ssh" ? "ssh-profile+proxy-chain" : "local"
  };
}

describe("Containerlab command vectors", () => {
  it("pins all-lab detailed inspection arguments", () => {
    expect(CONTAINERLAB_INSPECT_ARGS).toEqual([
      "--runtime", "docker", "--topo=", "--name=", "--timeout", "20s",
      "inspect", "--all", "--details", "--format", "json"
    ]);
  });

  it("quotes one POSIX shell token without evaluating quotes or substitutions", () => {
    expect(quotePosixToken("name'$(touch /tmp/unwanted)")).toBe("'name'\"'\"'$(touch /tmp/unwanted)'");
    expect(quotePosixToken("plain token")).toBe("'plain token'");
  });

  it("uses only an allowlisted environment with the selected socket", () => {
    expect(containerlabCleanEnvironment("/run/docker.sock")).toEqual({
      PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
      LANG: "C.UTF-8",
      LC_ALL: "C.UTF-8",
      DOCKER_HOST: "unix:///run/docker.sock"
    });
    const env = containerlabCleanEnvironment("/run/docker.sock");
    for (const forbidden of ["CLAB_NAME", "CLAB_TOPO", "CLAB_INSPECT_ALL", "DOCKER_CONTEXT", "DOCKER_TLS_VERIFY", "DOCKER_CONFIG", "BASH_ENV", "LD_PRELOAD", "HOME"]) {
      expect(env).not.toHaveProperty(forbidden);
    }
  });

  it.each([
    ["local", "host"], ["ssh", "host"],
    ["local", "disposable"], ["ssh", "disposable"],
    ["local", "existing"], ["ssh", "existing"]
  ] as const)("builds the bounded %s %s vector with explicit sockets and immutable runner identity", (location, runner) => {
    const values: Record<string, string | boolean> = { location, runner, dockerSocket: "/run/docker.sock", sudo: true };
    if (location === "ssh") values.labHostId = "lab-host-profile";
    if (runner === "disposable") values.runnerImage = "ghcr.io/srl-labs/clab:0.80.0";
    if (runner === "existing") values.runnerContainer = "mutable-runner-name";
    const config = parseContainerlabConfig(values);
    const helper = runner === "disposable" ? { name: "nexus-helper-1", ownershipLabel: "nexus.inventory-run=run-1" } : undefined;
    const command = buildContainerlabInspectionCommand(config, identity(location, runner), helper);
    expect(command.cwd).toBe("/");
    expect(command.args.slice(0, 3)).toEqual(["-n", "--", "env"]);
    if (runner === "host") {
      expect(command.args).toContain("DOCKER_HOST=unix:///run/docker.sock");
    } else {
      expect(command.args).toContain("unix:///run/docker.sock");
    }
    expect(command.args).toContain("--runtime");
    expect(command.args).toContain("--topo=");
    expect(command.args).toContain("--name=");
    expect(command.args).toContain("--format");
    expect(command.args).toContain("json");
    expect(command.args).not.toContain("--privileged");
    expect(command.args).not.toContain("--network=host");
    expect(command.args).not.toContain("--pid=host");

    if (runner === "host") {
      expect(command.executable).toBe("sudo");
      expect(command.args).toContain("/usr/bin/containerlab");
      expect(command.args).not.toContain("--host");
    } else {
      expect(command.executable).toBe("sudo");
      expect(command.args).toContain("--host");
      expect(command.args).toContain("unix:///run/docker.sock");
      if (runner === "existing") {
        expect(command.args).toContain("exec");
        expect(command.args).toContain("b".repeat(64));
        expect(command.args).not.toContain("mutable-runner-name");
      } else {
        expect(command.args).toContain("run");
        expect(command.args).toContain("--pull=never");
        expect(command.args).toContain(`sha256:${"a".repeat(64)}`);
        expect(command.args).toContain("--name");
        expect(command.args).toContain("nexus-helper-1");
        expect(command.args).toContain("nexus.inventory-run=run-1");
        expect(command.args).toContain("--network");
        expect(command.args).toContain("none");
        expect(command.args).toContain("--cap-drop");
        expect(command.args).toContain("ALL");
        expect(command.args).toContain("--security-opt");
        expect(command.args).toContain("no-new-privileges");
        expect(command.args).toContain("--entrypoint");
        expect(command.args).toContain("env");
      }
    }
  });

  it("rejects missing immutable runner resolution and a malformed disposable helper", () => {
    const disposable = parseContainerlabConfig({ runner: "disposable", runnerImage: "clab:0.80.0", dockerSocket: "/run/docker.sock", sudo: true });
    const missingImage = { ...identity("local", "disposable"), imageId: undefined };
    expect(() => buildContainerlabInspectionCommand(disposable, missingImage)).toThrow(/image/i);
    expect(() => buildContainerlabInspectionCommand(disposable, identity("local", "disposable"))).toThrow(/helper/i);
    expect(() => buildContainerlabInspectionCommand(disposable, identity("local", "disposable"), {
      name: "--malicious", ownershipLabel: "nexus.run=x"
    })).toThrow(/helper/i);
  });
});
