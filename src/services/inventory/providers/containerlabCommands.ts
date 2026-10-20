import { InventoryProviderError } from "../../../models/inventory";
import type { ContainerlabCommand, ContainerlabExecutionIdentity } from "../containerlabRuntimeContracts";
import type { ContainerlabConfig } from "./containerlabConfig";

export const CONTAINERLAB_INSPECT_ARGS: readonly string[] = Object.freeze([
  "--runtime", "docker", "--topo=", "--name=", "--timeout", "20s",
  "inspect", "--all", "--details", "--format", "json"
]);

const SAFE_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
const CONTAINER_DOCKER_SOCKET = "/var/run/docker.sock";

function invalid(message: string): never {
  throw new InventoryProviderError("protocol", message);
}

function socketUri(socketPath: string): string {
  if (!socketPath.startsWith("/") || socketPath === "/" || socketPath.includes(",") || /[\u0000-\u001f\u007f-\u009f]/u.test(socketPath)) {
    return invalid("Containerlab command requires an absolute Unix Docker socket path.");
  }
  return `unix://${socketPath}`;
}

export function quotePosixToken(value: string): string {
  if (/[\u0000-\u001f\u007f-\u009f]/u.test(value)) {
    return invalid("Containerlab command token cannot contain control characters.");
  }
  return `'${value.replace(/'/gu, `'"'"'`)}'`;
}

export function containerlabCleanEnvironment(socketPath: string): Readonly<Record<string, string>> {
  return Object.freeze({
    PATH: SAFE_PATH,
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    DOCKER_HOST: socketUri(socketPath)
  });
}

function environmentArgs(environment: Readonly<Record<string, string>>): string[] {
  return ["-i", ...Object.entries(environment).map(([key, value]) => `${key}=${value}`)];
}

function validateIdentity(config: ContainerlabConfig, identity: ContainerlabExecutionIdentity): void {
  if (identity.location !== config.location || identity.dockerSocket !== config.dockerSocket) {
    return invalid("Containerlab execution identity does not match the selected location and Docker socket.");
  }
  if (!identity.executable.startsWith("/") || /[\u0000-\u0020\u007f-\u009f]/u.test(identity.executable)) {
    return invalid("Containerlab execution requires a resolved absolute CLI executable path.");
  }
  if (identity.sudo !== config.sudo) {
    return invalid("Containerlab execution identity does not match the configured sudo setting.");
  }
  if (identity.routeIdentity.length === 0 || /[\u0000-\u001f\u007f-\u009f]/u.test(identity.routeIdentity)) {
    return invalid("Containerlab execution identity requires a valid route identity.");
  }
}

function validateDocker(identity: ContainerlabExecutionIdentity): string {
  if (!identity.dockerExecutable?.startsWith("/") || /[\u0000-\u0020\u007f-\u009f]/u.test(identity.dockerExecutable)) {
    return invalid("Containerlab Docker runner requires a resolved absolute Docker executable path.");
  }
  return identity.dockerExecutable;
}

function addSudoReset(
  executable: string,
  args: readonly string[],
  environment: Readonly<Record<string, string>>,
  sudo: boolean
): { executable: string; args: string[] } {
  if (!sudo) {
    return { executable, args: [...args] };
  }
  return { executable: "sudo", args: ["-n", "--", "env", ...environmentArgs(environment), executable, ...args] };
}

function validateImmutableRunner(config: ContainerlabConfig, identity: ContainerlabExecutionIdentity, helper?: { readonly name: string; readonly ownershipLabel: string }): void {
  if (config.runner === "host") {
    if (helper !== undefined) return invalid("A helper descriptor is only valid for the disposable Containerlab runner.");
    return;
  }
  validateDocker(identity);
  if (config.runner === "existing") {
    if (!identity.containerId || !/^[a-f0-9]{64}$/iu.test(identity.containerId)) {
      return invalid("Existing Containerlab runners must be resolved to an immutable container ID.");
    }
    if (helper !== undefined) return invalid("An existing Containerlab runner must not receive a disposable helper descriptor.");
    return;
  }
  if (!identity.imageId || !/^sha256:[a-f0-9]{64}$/iu.test(identity.imageId)) {
    return invalid("Disposable Containerlab runners must be resolved to an immutable image ID.");
  }
  if (
    !helper ||
    !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u.test(helper.name) ||
    !/^nexus\.inventory-run=[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u.test(helper.ownershipLabel)
  ) {
    return invalid("Disposable Containerlab runner requires a safe unique helper name and ownership label.");
  }
}

export function buildContainerlabInspectionCommand(
  config: ContainerlabConfig,
  identity: ContainerlabExecutionIdentity,
  helper?: { readonly name: string; readonly ownershipLabel: string }
): ContainerlabCommand {
  validateIdentity(config, identity);
  validateImmutableRunner(config, identity, helper);
  const environment = containerlabCleanEnvironment(config.dockerSocket);

  if (config.runner === "host") {
    const command = addSudoReset(identity.executable, CONTAINERLAB_INSPECT_ARGS, environment, config.sudo);
    return { ...command, env: environment, cwd: "/" };
  }

  const docker = validateDocker(identity);
  const outerArgs = ["--host", socketUri(config.dockerSocket)];
  let innerArgs: string[];
  if (config.runner === "existing") {
    innerArgs = [
      "exec", "--workdir", "/", identity.containerId!, "env",
      ...environmentArgs(containerlabCleanEnvironment(CONTAINER_DOCKER_SOCKET)),
      identity.executable, ...CONTAINERLAB_INSPECT_ARGS
    ];
  } else {
    innerArgs = [
      "run", "--rm", "--pull=never", "--name", helper!.name,
      "--label", helper!.ownershipLabel,
      "--network", "none", "--cap-drop", "ALL",
      "--security-opt", "no-new-privileges",
      "--mount", `type=bind,src=${config.dockerSocket},dst=${CONTAINER_DOCKER_SOCKET}`,
      "--workdir", "/", "--entrypoint", "env", identity.imageId!,
      ...environmentArgs(containerlabCleanEnvironment(CONTAINER_DOCKER_SOCKET)),
      identity.executable, ...CONTAINERLAB_INSPECT_ARGS
    ];
  }
  const command = addSudoReset(docker, outerArgs.concat(innerArgs), environment, config.sudo);
  return { ...command, env: environment, cwd: "/" };
}
