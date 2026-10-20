import { access, realpath, stat } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { randomUUID } from "node:crypto";
import { InventoryProviderError, flattenProviderText } from "../../models/inventory";
import type { ContainerlabConfig } from "./providers/containerlabConfig";
import { CONTAINERLAB_MIN_VERSION } from "./providers/containerlabConfig";
import {
  buildContainerlabInspectionCommand,
  buildContainerlabVersionCommand,
  containerlabCleanEnvironment
} from "./providers/containerlabCommands";
import type {
  ContainerlabCommand,
  ContainerlabCommandResult,
  ContainerlabCommandRunner,
  ContainerlabExecutionIdentity,
  ContainerlabExecutor,
  ContainerlabExecutorDependencies,
  ContainerlabLocalExecutableFileSystem,
  ContainerlabInspection,
  ContainerlabRunContext,
  PreparedContainerlabExecution,
  ResolvedContainerlabExecution
} from "./containerlabRuntimeContracts";

const SAFE_PATH = containerlabCleanEnvironment("/var/run/docker.sock").PATH;
const VERSION_LINE = /^    version: (v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)$/u;
const CONTAINER_ID = /^[a-f0-9]{64}$/iu;
const IMAGE_ID = /^sha256:[a-f0-9]{64}$/iu;
const CLEANUP_BUDGET_MS = 5_000;
const LOCAL_LOOKUP_POLL_MS = 25;
const MAX_ERROR_TEXT = 400;

type JsonRecord = Record<string, unknown>;
type Helper = { readonly name: string; readonly ownershipLabel: string };

function providerError(message: string, kind: "auth" | "network" | "protocol" = "protocol"): never {
  throw new InventoryProviderError(kind, message);
}

function safeError(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return flattenProviderText(text).slice(0, MAX_ERROR_TEXT) || "unknown command failure";
}

function asRecord(value: unknown): JsonRecord | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as JsonRecord
    : undefined;
}

function makeRunContextGuard(now: () => number, config: ContainerlabConfig, context: ContainerlabRunContext): void {
  if (!Number.isFinite(context.deadline)) {
    providerError("Containerlab execution requires a finite absolute deadline.");
  }
  if (context.signal.aborted || now() >= context.deadline || !context.isCurrent()) {
    providerError("Containerlab inspection was cancelled, timed out, or is no longer current.", "network");
  }
  if (config.location === "local") {
    return;
  }
  const routeIdentity = context.labHostRouteIdentity;
  if (!context.labHost || context.labHost.id !== config.labHostId || !routeIdentity || routeIdentity.trim() === "") {
    providerError("The configured Containerlab SSH host or captured route identity is missing or changed.", "auth");
  }
  if (/[\u0000-\u001f\u007f-\u009f]/u.test(routeIdentity)) {
    providerError("The captured Containerlab SSH route identity is invalid.", "auth");
  }
}

function checkContext(now: () => number, config: ContainerlabConfig, context: ContainerlabRunContext): void {
  makeRunContextGuard(now, config, context);
}

function expectedRouteMatches(expected: ContainerlabExecutionIdentity | undefined, routeIdentity: string): void {
  if (expected && expected.routeIdentity !== routeIdentity) {
    providerError("Containerlab execution identity no longer matches the approved SSH route.", "auth");
  }
}

function selectedRunner(config: ContainerlabConfig, deps: ContainerlabExecutorDependencies): ContainerlabCommandRunner {
  return config.location === "local" ? deps.localRunner : deps.sshRunner;
}

function helperFor(deps: ContainerlabExecutorDependencies): Helper {
  const id = (deps.createInvocationId ?? randomUUID)();
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,80}$/u.test(id)) {
    providerError("Containerlab could not create a safe disposable-runner invocation identity.");
  }
  return { name: `nexus-inventory-${id}`, ownershipLabel: `nexus.inventory-run=${id}` };
}

function metadataCommand(
  config: ContainerlabConfig,
  dockerExecutable: string,
  args: readonly string[]
): ContainerlabCommand {
  const env = containerlabCleanEnvironment(config.dockerSocket);
  if (!config.sudo) {
    return { executable: dockerExecutable, args: [...args], env, cwd: "/" };
  }
  const envArgs = ["-i", ...Object.entries(env).map(([key, value]) => `${key}=${value}`)];
  return {
    executable: "sudo",
    args: ["-n", "--", "env", ...envArgs, dockerExecutable, ...args],
    env,
    cwd: "/"
  };
}

function awaitLocalFileOperation<T>(
  operation: () => Promise<T>,
  config: ContainerlabConfig,
  context: ContainerlabRunContext,
  deps: ContainerlabExecutorDependencies
): Promise<T> {
  const now = deps.now ?? Date.now;
  checkContext(now, config, context);
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    let currentTimer: ReturnType<typeof setInterval> | undefined;
    const cleanup = (): void => {
      if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
      if (currentTimer !== undefined) clearInterval(currentTimer);
      context.signal.removeEventListener("abort", checkCurrent);
    };
    const fail = (error: unknown): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const finish = (value: T): void => {
      if (settled) return;
      try {
        checkContext(now, config, context);
      } catch (error) {
        fail(error);
        return;
      }
      settled = true;
      cleanup();
      resolve(value);
    };
    const checkCurrent = (): void => {
      try {
        checkContext(now, config, context);
      } catch (error) {
        fail(error);
      }
    };

    context.signal.addEventListener("abort", checkCurrent, { once: true });
    deadlineTimer = setTimeout(checkCurrent, Math.max(0, context.deadline - now()));
    currentTimer = setInterval(checkCurrent, LOCAL_LOOKUP_POLL_MS);
    checkCurrent();
    if (settled) return;

    const pending = Promise.resolve().then(operation);
    void pending.then(finish, (error: unknown) => fail(error));
  });
}

async function resolveLocalExecutable(
  value: string,
  label: "Containerlab" | "Docker",
  config: ContainerlabConfig,
  context: ContainerlabRunContext,
  deps: ContainerlabExecutorDependencies
): Promise<string> {
  const fileSystem: ContainerlabLocalExecutableFileSystem = deps.localFileSystem ?? { realpath, stat, access };
  const now = deps.now ?? Date.now;
  const candidates = value.startsWith("/")
    ? [value]
    : SAFE_PATH.split(":").map((directory) => `${directory}/${value}`);
  for (const candidate of candidates) {
    try {
      const [real, fileStat] = await awaitLocalFileOperation(
        () => Promise.all([fileSystem.realpath(candidate), fileSystem.stat(candidate)]), config, context, deps
      );
      if (!fileStat.isFile()) continue;
      await awaitLocalFileOperation(() => fileSystem.access(candidate, fsConstants.X_OK), config, context, deps);
      return real;
    } catch {
      // Context failures must escape the candidate loop; ordinary lookup misses advance through fixed PATH.
      try {
        checkContext(now, config, context);
      } catch (contextError) {
        throw contextError;
      }
      // Continue through the fixed allowlisted PATH; never consult process.env.PATH.
    }
  }
  providerError(`${label} executable could not be resolved on the selected host: ${flattenProviderText(value)}. ${label === "Docker" ? "Install Docker or set its executable path." : "Install Containerlab or set its executable path."}`, "network");
}

const REMOTE_RESOLVE_SCRIPT = [
  'case "$1" in',
  '  /*) candidate=$1 ;;',
  '  *) candidate=$(command -v "$1" 2>/dev/null) || exit 127 ;;',
  'esac',
  'case "$candidate" in /*) ;; *) exit 127 ;; esac',
  '[ -f "$candidate" ] && [ -x "$candidate" ] || exit 126',
  'printf "%s\\n" "$candidate"'
].join("\n");

async function resolveRemoteExecutable(
  value: string,
  config: ContainerlabConfig,
  context: ContainerlabRunContext,
  deps: ContainerlabExecutorDependencies,
  label: "Containerlab" | "Docker"
): Promise<string> {
  checkContext(deps.now ?? Date.now, config, context);
  const result = await selectedRunner(config, deps).run({
    executable: "/bin/sh",
    args: ["-c", REMOTE_RESOLVE_SCRIPT, "nexus-containerlab-resolve", value],
    env: containerlabCleanEnvironment(config.dockerSocket),
    cwd: "/"
  }, context);
  checkContext(deps.now ?? Date.now, config, context);
  return parseSingleAbsolutePath(result, value, label);
}

function parseSingleAbsolutePath(result: ContainerlabCommandResult, requested: string, label: "Containerlab" | "Docker"): string {
  if (result.stderr.trim() !== "") {
    providerError(`${label} executable resolution returned unexpected stderr: ${safeError(result.stderr)}`, "network");
  }
  const lines = result.stdout.replace(/\r\n?/gu, "\n").split("\n").filter((line) => line !== "");
  if (lines.length !== 1 || !lines[0].startsWith("/") || /[\u0000-\u0020\u007f-\u009f]/u.test(lines[0])) {
    providerError(`${label} executable resolution did not return one absolute path for ${flattenProviderText(requested)}.`, "protocol");
  }
  return lines[0];
}

async function resolveExecutable(
  value: string,
  config: ContainerlabConfig,
  context: ContainerlabRunContext,
  deps: ContainerlabExecutorDependencies,
  label: "Containerlab" | "Docker"
): Promise<string> {
  if (config.location === "local") {
    checkContext(deps.now ?? Date.now, config, context);
    const resolved = await resolveLocalExecutable(value, label, config, context, deps);
    checkContext(deps.now ?? Date.now, config, context);
    return resolved;
  }
  return resolveRemoteExecutable(value, config, context, deps, label);
}

function assertExpectedOuterIdentity(
  expected: ContainerlabExecutionIdentity | undefined,
  config: ContainerlabConfig,
  routeIdentity: string,
  executable: string,
  dockerExecutable: string
): void {
  if (!expected) return;
  if (
    expected.location !== config.location ||
    expected.routeIdentity !== routeIdentity ||
    expected.dockerSocket !== config.dockerSocket ||
    expected.sudo !== config.sudo ||
    expected.executable !== executable
  ) {
    providerError("Containerlab execution identity changed since approval.", "auth");
  }
  if (expected.dockerExecutable !== dockerExecutable) {
    providerError("The approved Docker executable path changed; approve the Containerlab source again.", "auth");
  }
}

async function runMetadata(
  config: ContainerlabConfig,
  identity: ContainerlabExecutionIdentity,
  context: ContainerlabRunContext,
  deps: ContainerlabExecutorDependencies,
  args: readonly string[]
): Promise<string> {
  checkContext(deps.now ?? Date.now, config, context);
  const command = metadataCommand(config, identity.dockerExecutable!, args);
  const result = await selectedRunner(config, deps).run(command, context);
  checkContext(deps.now ?? Date.now, config, context);
  if (result.stderr.trim() !== "") {
    providerError(`Docker metadata command returned unexpected stderr: ${safeError(result.stderr)}`, "network");
  }
  return result.stdout.trim();
}

function assertDockerTopology(stdout: string): void {
  let value: unknown;
  try {
    value = JSON.parse(stdout) as unknown;
  } catch {
    providerError("Docker did not return valid metadata for the selected socket.", "protocol");
  }
  const info = asRecord(value);
  const securityOptions = info?.SecurityOptions;
  if (!Array.isArray(securityOptions) || !securityOptions.every((option) => typeof option === "string")) {
    providerError("Docker metadata did not identify the selected daemon security mode. Containerlab requires a rootful Linux Docker daemon; check the selected Docker socket.", "protocol");
  }
  const isRootless = securityOptions.some((option) => typeof option === "string" && option.toLowerCase().includes("rootless"));
  if (info?.OSType !== "linux" || isRootless) {
    providerError("Containerlab inventory requires a rootful Linux Docker daemon on the selected Unix socket. Check the selected Docker socket and disable rootless Docker.", "protocol");
  }
}

function parseImageId(stdout: string): string {
  if (!IMAGE_ID.test(stdout)) {
    providerError("The configured Containerlab runner image is not installed or did not resolve to an immutable image ID. Install the image locally; inventory will not pull it.", "protocol");
  }
  return stdout;
}

function parseExistingContainer(stdout: string, configuredName: string, socketPath: string): string {
  let value: unknown;
  try {
    value = JSON.parse(stdout) as unknown;
  } catch {
    providerError("Docker did not return valid metadata for the configured Containerlab runner.", "protocol");
  }
  const container = asRecord(value);
  const state = asRecord(container?.State);
  const mounts = Array.isArray(container?.Mounts) ? container.Mounts : [];
  const matchingMounts = mounts.map(asRecord).filter((mount) =>
    mount?.Type === "bind" && mount.Source === socketPath && mount.Destination === "/var/run/docker.sock" && mount.RW === true
  );
  const configuredReferenceMatches = CONTAINER_ID.test(configuredName)
    ? typeof container?.Id === "string" && container.Id.toLowerCase() === configuredName.toLowerCase()
    : container?.Name === `/${configuredName}`;
  if (
    !container ||
    typeof container.Id !== "string" || !CONTAINER_ID.test(container.Id) ||
    !configuredReferenceMatches || state?.Running !== true ||
    matchingMounts.length !== 1
  ) {
    providerError("The configured Containerlab runner must be running and bind the selected Docker socket read-write at /var/run/docker.sock.", "protocol");
  }
  return container.Id;
}

function identityEqual(left: ContainerlabExecutionIdentity, right: ContainerlabExecutionIdentity): boolean {
  return left.executable === right.executable &&
    left.dockerExecutable === right.dockerExecutable &&
    left.imageId === right.imageId &&
    left.containerId === right.containerId &&
    left.dockerSocket === right.dockerSocket &&
    left.location === right.location &&
    left.sudo === right.sudo &&
    left.routeIdentity === right.routeIdentity;
}

function assertIdentityContext(
  config: ContainerlabConfig,
  identity: ContainerlabExecutionIdentity,
  context: ContainerlabRunContext,
  deps: ContainerlabExecutorDependencies
): void {
  checkContext(deps.now ?? Date.now, config, context);
  const currentRoute = config.location === "local" ? "local" : context.labHostRouteIdentity!;
  if (identity.routeIdentity !== currentRoute || identity.location !== config.location || identity.dockerSocket !== config.dockerSocket || identity.sudo !== config.sudo) {
    providerError("Containerlab execution identity no longer matches the captured SSH route or source dependencies.", "auth");
  }
  if (config.runner === "host") {
    if (!identity.executable.startsWith("/") || /[\u0000-\u0020\u007f-\u009f]/u.test(identity.executable)) {
      providerError("Containerlab host executable identity is invalid.");
    }
  } else if (identity.executable !== config.containerlabExecutable) {
    providerError("Containerlab runner identity no longer matches the configured runner.", "auth");
  }
  if (!identity.dockerExecutable.startsWith("/") || /[\u0000-\u0020\u007f-\u009f]/u.test(identity.dockerExecutable)) {
    providerError("Containerlab Docker identity is missing its resolved absolute executable path.", "auth");
  }
  if (config.runner === "disposable" && (!identity.imageId || !IMAGE_ID.test(identity.imageId))) {
    providerError("Containerlab disposable runner identity is missing its immutable image ID.", "auth");
  }
  if (config.runner === "existing" && (!identity.containerId || !CONTAINER_ID.test(identity.containerId))) {
    providerError("Containerlab existing runner identity is missing its immutable container ID.", "auth");
  }
}

function parseVersion(stdout: string, stderr: string): string {
  if (stderr.trim() !== "") {
    providerError(`Containerlab version preflight returned unexpected stderr: ${safeError(stderr)}`, "network");
  }
  const withoutAnsi = stdout.replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, "");
  const matches = withoutAnsi.replace(/\r\n?/gu, "\n").split("\n").map((line) => VERSION_LINE.exec(line)).filter((match) => match !== null);
  if (matches.length !== 1) {
    providerError("Containerlab version preflight must return exactly one anchored '    version: <semver>' line.", "protocol");
  }
  const version = matches[0][1];
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/u.exec(version);
  if (!match) providerError("Containerlab returned an invalid semantic version.", "protocol");
  const [major, minor, patch] = match.slice(1, 4).map(Number);
  if (![major, minor, patch].every(Number.isSafeInteger)) providerError("Containerlab returned an invalid semantic version.", "protocol");
  const prerelease = match[4] !== undefined;
  const belowMinimum = major === 0 && (minor < 68 || (minor === 68 && patch === 0 && prerelease));
  if (belowMinimum) {
    providerError(`Containerlab ${CONTAINERLAB_MIN_VERSION} or later is required for detailed inspection JSON. Upgrade Containerlab on the selected lab host.`, "protocol");
  }
  return version.startsWith("v") ? version.slice(1) : version;
}

function parseInspectionOutput(result: ContainerlabCommandResult): ContainerlabInspection {
  if (result.stderr.trim() !== "") {
    providerError(`Containerlab inspection returned unexpected stderr: ${safeError(result.stderr)}`, "network");
  }
  try {
    JSON.parse(result.stdout);
  } catch {
    providerError("Containerlab inspection stdout must contain one JSON document with no surrounding noise.", "protocol");
  }
  return { version: "", stdout: result.stdout };
}

function cleanupContext(context: ContainerlabRunContext, now: () => number): ContainerlabRunContext {
  return {
    interaction: "noninteractive",
    signal: new AbortController().signal,
    deadline: now() + CLEANUP_BUDGET_MS,
    ...(context.labHost ? { labHost: context.labHost } : {}),
    ...(context.labHostRouteIdentity ? { labHostRouteIdentity: context.labHostRouteIdentity } : {}),
    isCurrent: () => true
  };
}

async function cleanupHelper(
  config: ContainerlabConfig,
  identity: ContainerlabExecutionIdentity,
  helper: Helper,
  originalContext: ContainerlabRunContext,
  deps: ContainerlabExecutorDependencies
): Promise<void> {
  const now = deps.now ?? Date.now;
  const context = cleanupContext(originalContext, now);
  const run = async (args: readonly string[]): Promise<string> => {
    const result = await selectedRunner(config, deps).run(metadataCommand(config, identity.dockerExecutable!, args), context);
    if (result.stderr.trim() !== "") providerError(`Docker cleanup returned unexpected stderr: ${safeError(result.stderr)}`, "network");
    return result.stdout.trim();
  };
  const socket = `unix://${config.dockerSocket}`;
  const idsOutput = await run([
    "--host", socket, "container", "ls", "--all", "--quiet", "--no-trunc",
    "--filter", `name=^/${helper.name}$`, "--filter", `label=${helper.ownershipLabel}`
  ]);
  const ids = idsOutput.split(/\r?\n/u).filter((line) => line.length > 0);
  if (ids.length === 0) return;
  if (ids.length !== 1 || !CONTAINER_ID.test(ids[0])) {
    providerError("Containerlab cleanup found ambiguous helper containers and refused to remove them.", "protocol");
  }
  const inspectOutput = await run(["--host", socket, "container", "inspect", "--format", "{{json .}}", ids[0]]);
  let value: unknown;
  try {
    value = JSON.parse(inspectOutput) as unknown;
  } catch {
    providerError("Containerlab cleanup could not verify helper ownership.", "protocol");
  }
  const container = asRecord(value);
  const labels = asRecord(asRecord(container?.Config)?.Labels);
  if (container?.Id !== ids[0] || container.Name !== `/${helper.name}` || labels?.["nexus.inventory-run"] !== helper.ownershipLabel.split("=")[1]) {
    providerError("Containerlab cleanup refused to remove a container whose name or ownership label changed.", "auth");
  }
  await run(["--host", socket, "container", "rm", "--force", ids[0]]);
}

async function runWithDisposableCleanup<T>(
  config: ContainerlabConfig,
  identity: ContainerlabExecutionIdentity,
  context: ContainerlabRunContext,
  deps: ContainerlabExecutorDependencies,
  operation: (helper: Helper) => Promise<T>
): Promise<T> {
  const helper = helperFor(deps);
  try {
    return await operation(helper);
  } catch (primaryError) {
    try {
      await cleanupHelper(config, identity, helper, context, deps);
    } catch (cleanupError) {
      providerError(`Containerlab command failed: ${safeError(primaryError)}; helper cleanup also failed: ${safeError(cleanupError)}`, "network");
    }
    throw primaryError;
  }
}

export function createContainerlabExecutor(deps: ContainerlabExecutorDependencies): ContainerlabExecutor {
  return {
    async resolveDependencies(
      config: ContainerlabConfig,
      context: ContainerlabRunContext,
      expected?: ContainerlabExecutionIdentity
    ): Promise<ResolvedContainerlabExecution> {
      checkContext(deps.now ?? Date.now, config, context);
      const routeIdentity = config.location === "local" ? "local" : context.labHostRouteIdentity!;
      expectedRouteMatches(expected, routeIdentity);

      // Container modes bind the configured inner CLI token to fixed PATH; it is
      // intentionally not probed until the already-installed runner is invoked.
      const executable = config.runner === "host"
        ? await resolveExecutable(config.containerlabExecutable, config, context, deps, "Containerlab")
        : config.containerlabExecutable;
      checkContext(deps.now ?? Date.now, config, context);

      const dockerExecutable = await resolveExecutable(config.dockerExecutable, config, context, deps, "Docker");
      assertExpectedOuterIdentity(expected, config, routeIdentity, executable, dockerExecutable);
      const partialIdentity: ContainerlabExecutionIdentity = {
        executable,
        dockerExecutable,
        dockerSocket: config.dockerSocket,
        location: config.location,
        sudo: config.sudo,
        routeIdentity
      };

      assertDockerTopology(await runMetadata(config, partialIdentity, context, deps, [
        "--host", `unix://${config.dockerSocket}`, "info", "--format", "{{json .}}"
      ]));

      if (config.runner === "host") {
        if (expected && !identityEqual(expected, partialIdentity)) {
          providerError("The approved Containerlab host and Docker executable identity changed.", "auth");
        }
        return { identity: partialIdentity };
      }

      const identity: ContainerlabExecutionIdentity = config.runner === "disposable"
        ? {
            ...partialIdentity,
            imageId: parseImageId(await runMetadata(config, partialIdentity, context, deps, [
              "--host", `unix://${config.dockerSocket}`, "image", "inspect", "--format", "{{.Id}}", config.runnerImage!
            ]))
          }
        : {
            ...partialIdentity,
            containerId: parseExistingContainer(await runMetadata(config, partialIdentity, context, deps, [
              "--host", `unix://${config.dockerSocket}`, "container", "inspect", "--format", "{{json .}}", config.runnerContainer!
            ]), config.runnerContainer!, config.dockerSocket)
          };

      if (expected && !identityEqual(expected, identity)) {
        providerError("The immutable Containerlab runner identity changed since approval.", "auth");
      }
      return { identity };
    },

    async preflight(
      config: ContainerlabConfig,
      resolved: ResolvedContainerlabExecution,
      context: ContainerlabRunContext
    ): Promise<PreparedContainerlabExecution> {
      const identity = resolved.identity;
      assertIdentityContext(config, identity, context, deps);
      const run = async (helper?: Helper): Promise<string> => {
        checkContext(deps.now ?? Date.now, config, context);
        const result = await selectedRunner(config, deps).run(buildContainerlabVersionCommand(config, identity, helper), context);
        checkContext(deps.now ?? Date.now, config, context);
        return parseVersion(result.stdout, result.stderr);
      };
      const version = config.runner === "disposable"
        ? await runWithDisposableCleanup(config, identity, context, deps, run)
        : await run();
      return { identity, version };
    },

    async inspect(
      config: ContainerlabConfig,
      prepared: PreparedContainerlabExecution,
      context: ContainerlabRunContext
    ): Promise<ContainerlabInspection> {
      const identity = prepared.identity;
      assertIdentityContext(config, identity, context, deps);
      const run = async (helper?: Helper): Promise<ContainerlabInspection> => {
        checkContext(deps.now ?? Date.now, config, context);
        const result = await selectedRunner(config, deps).run(buildContainerlabInspectionCommand(config, identity, helper), context);
        checkContext(deps.now ?? Date.now, config, context);
        const inspection = parseInspectionOutput(result);
        return { ...inspection, version: prepared.version };
      };
      return config.runner === "disposable"
        ? runWithDisposableCleanup(config, identity, context, deps, run)
        : run();
    }
  };
}
