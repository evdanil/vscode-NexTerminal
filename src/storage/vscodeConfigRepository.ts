import * as vscode from "vscode";
import type { AuthProfile, LocalShellProfile, SerialProfile, ServerConfig, TunnelProfile } from "../models/config";
import type { ConfigRepository } from "../core/contracts";
import { validateServerConfig, validateTunnelProfile, validateSerialProfile, validateAuthProfile, validateLocalShellProfile } from "../utils/validation";

const SERVERS_KEY = "nexus.servers";
const TUNNELS_KEY = "nexus.tunnels";
const SERIAL_PROFILES_KEY = "nexus.serialProfiles";
const LOCAL_SHELL_PROFILES_KEY = "nexus.localShellProfiles";
const GROUPS_KEY = "nexus.groups";
const AUTH_PROFILES_KEY = "nexus.authProfiles";

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
    return raw.filter((item) => {
      if (validateServerConfig(item)) {
        return true;
      }
      console.warn("[Nexus] Skipping invalid server config entry:", JSON.stringify(item));
      return false;
    });
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
}
