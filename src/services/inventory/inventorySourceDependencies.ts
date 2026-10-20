import { authProfileOwnedCredentials, type AuthProfile, type ServerConfig } from "../../models/config";
import { flattenProviderText } from "../../models/inventory";
import { validateProxyConfig } from "../../utils/validation";

export interface InventorySourceDependencySnapshot {
  readonly serverIds: readonly string[];
  readonly identity: string;
}

export class InventorySourceDependencyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InventorySourceDependencyError";
  }
}

function dependencyError(
  detail: string,
  remedy = "Select or restore a valid SSH profile. If a planned route introduced the problem, edit that hop to Keep Direct, set Device Connection to Direct, or choose a different valid lab host."
): never {
  throw new InventorySourceDependencyError(
    `Containerlab discovery requires a valid SSH lab host and jump chain: ${flattenProviderText(detail)} ${remedy}`
  );
}

function serverMapFor(servers: readonly ServerConfig[]): Map<string, ServerConfig> {
  const byId = new Map<string, ServerConfig>();
  for (const server of servers) {
    if (typeof server.id !== "string" || server.id.trim() === "") {
      dependencyError("a required profile has no valid identifier.");
    }
    if (byId.has(server.id)) {
      dependencyError("a required profile identifier is ambiguous.");
    }
    byId.set(server.id, server);
  }
  return byId;
}

function profileMapFor(authProfiles: readonly AuthProfile[]): Map<string, AuthProfile> {
  const byId = new Map<string, AuthProfile>();
  for (const profile of authProfiles) {
    if (typeof profile.id !== "string" || profile.id.trim() === "") {
      dependencyError("an authentication profile has no valid identifier.");
    }
    if (byId.has(profile.id)) {
      dependencyError("an authentication profile identifier is ambiguous.");
    }
    byId.set(profile.id, profile);
  }
  return byId;
}

function connectionIdentity(server: ServerConfig, authProfilesById: ReadonlyMap<string, AuthProfile>): readonly unknown[] {
  const profile = server.authProfileId ? authProfilesById.get(server.authProfileId) : undefined;
  const owned = authProfileOwnedCredentials(profile);
  const authType = owned.authType ?? server.authType;
  const username = owned.username ?? server.username;
  if (typeof username !== "string" || username.trim() === "") {
    dependencyError(`SSH profile "${server.name}" has no usable authentication username.`);
  }

  let proxy: readonly unknown[] | null = null;
  if (server.proxy !== undefined) {
    if (!validateProxyConfig(server.proxy)) {
      dependencyError(`SSH profile "${server.name}" has an invalid proxy route.`);
    }
    if (server.proxy.type === "ssh") {
      proxy = ["ssh", server.proxy.jumpHostId];
    } else {
      // Proxy passwords live in SecretVault and deliberately never enter this
      // approval identity. Username and endpoint are the configured route.
      proxy = [server.proxy.type, server.proxy.host, server.proxy.port, server.proxy.username ?? null];
    }
  }

  return [
    server.id,
    server.host,
    server.port,
    server.protocol ?? "ssh",
    server.altHost ?? null,
    [server.authProfileId ?? null, profile !== undefined, username, authType, authType === "key" ? owned.keyPath ?? server.keyPath ?? null : null],
    proxy
  ];
}

export function snapshotInventorySourceDependencies(
  labHostId: string,
  servers: readonly ServerConfig[],
  authProfiles: readonly AuthProfile[]
): InventorySourceDependencySnapshot {
  if (typeof labHostId !== "string" || labHostId.trim() === "") {
    dependencyError("no lab host SSH profile is configured.");
  }
  const serversById = serverMapFor(servers);
  const profilesById = profileMapFor(authProfiles);
  const serverIds: string[] = [];
  const connectionEntries: Array<readonly unknown[]> = [];
  const seen = new Set<string>();
  let nextId: string | undefined = labHostId;

  while (nextId !== undefined) {
    const server = serversById.get(nextId);
    if (!server) {
      dependencyError(serverIds.length === 0 ? "the configured lab host no longer exists." : "an SSH jump host no longer exists.");
    }
    if (seen.has(server.id)) {
      dependencyError("the SSH jump route contains a cycle.");
    }
    seen.add(server.id);
    if (server.protocol !== undefined && server.protocol !== "ssh") {
      dependencyError(`profile "${server.name}" does not use SSH.`);
    }
    if (server.addressless === true || typeof server.host !== "string" || server.host.trim() === "") {
      dependencyError(`profile "${server.name}" has no SSH address.`);
    }
    if (!Number.isInteger(server.port) || server.port < 1 || server.port > 65535) {
      dependencyError(`profile "${server.name}" has an invalid SSH port.`);
    }

    serverIds.push(server.id);
    connectionEntries.push(connectionIdentity(server, profilesById));
    const proxy = server.proxy;
    if (proxy?.type === "ssh") {
      nextId = proxy.jumpHostId;
    } else {
      nextId = undefined;
    }
  }

  const snapshot: InventorySourceDependencySnapshot = {
    serverIds: Object.freeze([...serverIds]),
    // The ordered, whitelisted tuple records every effective endpoint, auth
    // profile and configured proxy detail without reading SecretVault values.
    identity: JSON.stringify(connectionEntries)
  };
  return Object.freeze(snapshot);
}

function assertSnapshotShape(snapshot: InventorySourceDependencySnapshot): void {
  if (
    !snapshot ||
    !Array.isArray(snapshot.serverIds) ||
    snapshot.serverIds.length === 0 ||
    snapshot.serverIds.some((id) => typeof id !== "string" || id.trim() === "") ||
    new Set(snapshot.serverIds).size !== snapshot.serverIds.length ||
    typeof snapshot.identity !== "string" ||
    snapshot.identity.length === 0
  ) {
    dependencyError("the captured dependency identity is invalid.");
  }
}

export function assertInventorySourceDependenciesCurrent(
  snapshot: InventorySourceDependencySnapshot,
  servers: readonly ServerConfig[],
  authProfiles: readonly AuthProfile[]
): void {
  assertSnapshotShape(snapshot);
  const current = snapshotInventorySourceDependencies(snapshot.serverIds[0], servers, authProfiles);
  if (current.identity !== snapshot.identity) {
    throw new InventorySourceDependencyError(
      "Containerlab discovery's SSH route or authentication profile changed while the sync was running. Run the sync again after selecting the intended lab host and jump profiles."
    );
  }
}

export function assertInventorySourceDependenciesSurvive(
  snapshot: InventorySourceDependencySnapshot,
  survivingServerIds: ReadonlySet<string>
): void {
  assertSnapshotShape(snapshot);
  if (snapshot.serverIds.some((id) => !survivingServerIds.has(id))) {
    dependencyError(
      "the current sync would remove the lab host or one of its SSH jump profiles.",
      "Select or restore a valid SSH profile, or revise pruning so every required profile survives."
    );
  }
}

export function assertInventorySourceDependenciesRemainValid(
  snapshot: InventorySourceDependencySnapshot,
  currentServers: readonly ServerConfig[],
  removedServerIds: readonly string[],
  upsertServers: readonly ServerConfig[],
  authProfiles: readonly AuthProfile[]
): void {
  assertSnapshotShape(snapshot);
  const effectiveServers = new Map(currentServers.map((server) => [server.id, server]));
  for (const id of removedServerIds) {
    effectiveServers.delete(id);
  }
  for (const server of upsertServers) {
    effectiveServers.set(server.id, server);
  }
  snapshotInventorySourceDependencies(snapshot.serverIds[0], [...effectiveServers.values()], authProfiles);
}
