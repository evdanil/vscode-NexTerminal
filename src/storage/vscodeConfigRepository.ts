import * as vscode from "vscode";
import type { AuthProfile, LocalShellProfile, SerialProfile, ServerConfig, TunnelProfile } from "../models/config";
import { ensureInventorySourceRevision, type InventorySourceConfig } from "../models/inventory";
import type { ConfigRepository } from "../core/contracts";
import {
  validateServerConfig,
  validateTunnelProfile,
  validateSerialProfile,
  validateAuthProfile,
  validateLocalShellProfile,
  validateInventorySource,
  isValidServerOrigin
} from "../utils/validation";

const SERVERS_KEY = "nexus.servers";
const TUNNELS_KEY = "nexus.tunnels";
const SERIAL_PROFILES_KEY = "nexus.serialProfiles";
const LOCAL_SHELL_PROFILES_KEY = "nexus.localShellProfiles";
const GROUPS_KEY = "nexus.groups";
const AUTH_PROFILES_KEY = "nexus.authProfiles";
const INVENTORY_SOURCES_KEY = "nexus.inventorySources";

/**
 * `globalState.get(key, [])` only substitutes the default when the key is ABSENT.
 * A corrupt non-array value (object/string/null from a Settings Sync conflict or
 * storage corruption) would otherwise reach `.filter(...)` and throw during
 * activation. Degrade any non-array shape to an empty list.
 */
function asArray<T>(raw: unknown): T[] {
  return Array.isArray(raw) ? (raw as T[]) : [];
}

export class VscodeConfigRepository implements ConfigRepository {
  public constructor(private readonly context: vscode.ExtensionContext) {}

  public async getServers(): Promise<ServerConfig[]> {
    const raw = asArray<ServerConfig>(this.context.globalState.get(SERVERS_KEY, []));
    const result: ServerConfig[] = [];
    for (const item of raw) {
      if (!validateServerConfig(item)) {
        console.warn("[Nexus] Skipping invalid server config entry:", JSON.stringify(item));
        continue;
      }
      // F13/FIX 5 — a malformed `origin` does not reject the whole row
      // (validateServerConfig deliberately doesn't touch `origin`'s shape),
      // but the corrupt marker still must not reach NexusCore: copy the
      // server without it here, at the storage boundary, instead of mutating
      // the value the type guard was asked to check.
      if (item.origin !== undefined && !isValidServerOrigin(item.origin)) {
        console.warn("[Nexus] Server config has a malformed origin; stripping it:", JSON.stringify(item.origin));
        const { origin: _origin, ...rest } = item;
        result.push(rest as ServerConfig);
        continue;
      }
      result.push(item);
    }
    return result;
  }

  public async saveServers(servers: ServerConfig[]): Promise<void> {
    await this.context.globalState.update(SERVERS_KEY, servers);
  }

  public async getTunnels(): Promise<TunnelProfile[]> {
    const raw = asArray<TunnelProfile>(this.context.globalState.get(TUNNELS_KEY, []));
    return raw.filter((item) => {
      if (validateTunnelProfile(item)) {
        return true;
      }
      console.warn("[Nexus] Skipping invalid tunnel profile entry:", JSON.stringify(item));
      return false;
    });
  }

  public async saveTunnels(tunnels: TunnelProfile[]): Promise<void> {
    await this.context.globalState.update(TUNNELS_KEY, tunnels);
  }

  public async getSerialProfiles(): Promise<SerialProfile[]> {
    const raw = asArray<SerialProfile>(this.context.globalState.get(SERIAL_PROFILES_KEY, []));
    return raw.filter((item) => {
      if (validateSerialProfile(item)) {
        return true;
      }
      console.warn("[Nexus] Skipping invalid serial profile entry:", JSON.stringify(item));
      return false;
    });
  }

  public async saveSerialProfiles(profiles: SerialProfile[]): Promise<void> {
    await this.context.globalState.update(SERIAL_PROFILES_KEY, profiles);
  }

  public async getLocalShellProfiles(): Promise<LocalShellProfile[]> {
    const raw = asArray<LocalShellProfile>(this.context.globalState.get(LOCAL_SHELL_PROFILES_KEY, []));
    return raw.filter((item) => {
      if (validateLocalShellProfile(item)) {
        return true;
      }
      console.warn("[Nexus] Skipping invalid local shell profile entry:", JSON.stringify(item));
      return false;
    });
  }

  public async saveLocalShellProfiles(profiles: LocalShellProfile[]): Promise<void> {
    await this.context.globalState.update(LOCAL_SHELL_PROFILES_KEY, profiles);
  }

  public async getGroups(): Promise<string[]> {
    return asArray<string>(this.context.globalState.get(GROUPS_KEY, [])).filter(
      (item): item is string => typeof item === "string"
    );
  }

  public async saveGroups(groups: string[]): Promise<void> {
    await this.context.globalState.update(GROUPS_KEY, groups);
  }

  public async getAuthProfiles(): Promise<AuthProfile[]> {
    const raw = asArray<AuthProfile>(this.context.globalState.get(AUTH_PROFILES_KEY, []));
    return raw.filter((item) => {
      if (validateAuthProfile(item)) {
        return true;
      }
      console.warn("[Nexus] Skipping invalid auth profile entry:", JSON.stringify(item));
      return false;
    });
  }

  public async saveAuthProfiles(profiles: AuthProfile[]): Promise<void> {
    await this.context.globalState.update(AUTH_PROFILES_KEY, profiles);
  }

  public async getInventorySources(): Promise<InventorySourceConfig[]> {
    const raw = asArray<InventorySourceConfig>(this.context.globalState.get(INVENTORY_SOURCES_KEY, []));
    // FINDING 1 (removal-identity review) — a record persisted before the
    // `revision` field existed (a "legacy" record) is backfilled with one
    // here, at LOAD time, so every in-memory InventorySourceConfig this
    // process ever hands out has one. This does NOT rewrite disk (the next
    // successful saveInventorySources call will, incidentally, since it
    // always persists the in-memory objects) — a legacy record loaded twice
    // (e.g. by two separate extension activations) gets two DIFFERENT
    // backfilled revisions, which is fine: revision only ever needs to be
    // stable WITHIN one running core's lifetime, never across processes.
    return raw
      .filter((item) => {
        if (validateInventorySource(item)) {
          return true;
        }
        console.warn("[Nexus] Skipping invalid inventory source entry:", JSON.stringify(item));
        return false;
      })
      .map(ensureInventorySourceRevision);
  }

  public async saveInventorySources(sources: InventorySourceConfig[]): Promise<void> {
    await this.context.globalState.update(INVENTORY_SOURCES_KEY, sources);
  }
}
