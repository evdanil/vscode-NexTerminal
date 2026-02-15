import type { ConfigRepository } from "../core/contracts";
import type { SerialProfile, ServerConfig, TunnelProfile } from "../models/config";

export class InMemoryConfigRepository implements ConfigRepository {
  public constructor(
    private servers: ServerConfig[] = [],
    private tunnels: TunnelProfile[] = [],
    private serialProfiles: SerialProfile[] = []
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

  public async getSerialProfiles(): Promise<SerialProfile[]> {
    return [...this.serialProfiles];
  }

  public async saveSerialProfiles(profiles: SerialProfile[]): Promise<void> {
    this.serialProfiles = [...profiles];
  }
}
