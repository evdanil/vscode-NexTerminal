import * as vscode from "vscode";
import type { ServerConfig, TunnelProfile } from "../models/config";
import type { ConfigRepository } from "../core/contracts";

const SERVERS_KEY = "nexus.servers";
const TUNNELS_KEY = "nexus.tunnels";

export class VscodeConfigRepository implements ConfigRepository {
  public constructor(private readonly context: vscode.ExtensionContext) {}

  public async getServers(): Promise<ServerConfig[]> {
    return this.context.globalState.get<ServerConfig[]>(SERVERS_KEY, []);
  }

  public async saveServers(servers: ServerConfig[]): Promise<void> {
    await this.context.globalState.update(SERVERS_KEY, servers);
  }

  public async getTunnels(): Promise<TunnelProfile[]> {
    return this.context.globalState.get<TunnelProfile[]>(TUNNELS_KEY, []);
  }

  public async saveTunnels(tunnels: TunnelProfile[]): Promise<void> {
    await this.context.globalState.update(TUNNELS_KEY, tunnels);
  }
}
