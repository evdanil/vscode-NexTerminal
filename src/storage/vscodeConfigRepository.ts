import * as vscode from "vscode";
import type { SerialProfile, ServerConfig, TunnelProfile } from "../models/config";
import type { ConfigRepository } from "../core/contracts";
import { validateServerConfig, validateTunnelProfile, validateSerialProfile } from "../utils/validation";

const SERVERS_KEY = "nexus.servers";
const TUNNELS_KEY = "nexus.tunnels";
const SERIAL_PROFILES_KEY = "nexus.serialProfiles";
const GROUPS_KEY = "nexus.groups";

export class VscodeConfigRepository implements ConfigRepository {
  public constructor(private readonly context: vscode.ExtensionContext) {}

  public async getServers(): Promise<ServerConfig[]> {
    const raw = this.context.globalState.get<ServerConfig[]>(SERVERS_KEY, []);
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
    const raw = this.context.globalState.get<TunnelProfile[]>(TUNNELS_KEY, []);
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
    const raw = this.context.globalState.get<SerialProfile[]>(SERIAL_PROFILES_KEY, []);
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

  public async getGroups(): Promise<string[]> {
    return this.context.globalState.get<string[]>(GROUPS_KEY, []);
  }

  public async saveGroups(groups: string[]): Promise<void> {
    await this.context.globalState.update(GROUPS_KEY, groups);
  }
}
