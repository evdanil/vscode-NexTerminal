import type { ConfigRepository } from "../core/contracts";
import type { ServerConfig, TunnelProfile } from "../models/config";

export class InMemoryConfigRepository implements ConfigRepository {
  public constructor(
    private servers: ServerConfig[] = [],
    private tunnels: TunnelProfile[] = []
  ) {}

  public async getServers(): Promise<ServerConfig[]> {
    return [...this.servers];
  }

  public async saveServers(servers: ServerConfig[]): Promise<void> {
    this.servers = [...servers];
  }

  public async getTunnels(): Promise<TunnelProfile[]> {
    return [...this.tunnels];
  }

  public async saveTunnels(tunnels: TunnelProfile[]): Promise<void> {
    this.tunnels = [...tunnels];
  }
}
