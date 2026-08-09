import type { ConfigRepository } from "../core/contracts";
import type { AuthProfile, LocalShellProfile, SerialProfile, ServerConfig, TunnelProfile } from "../models/config";
import { ensureInventorySourceRevision, type InventorySourceConfig } from "../models/inventory";
import { ensureDeviceTemplateRevision, type DeviceTemplateProfile } from "../models/deviceTemplate";

export class InMemoryConfigRepository implements ConfigRepository {
  public constructor(
    private servers: ServerConfig[] = [],
    private tunnels: TunnelProfile[] = [],
    private serialProfiles: SerialProfile[] = [],
    private groups: string[] = [],
    private authProfiles: AuthProfile[] = [],
    private localShellProfiles: LocalShellProfile[] = [],
    private inventorySources: InventorySourceConfig[] = [],
    private deviceTemplates: DeviceTemplateProfile[] = []
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

  public async getLocalShellProfiles(): Promise<LocalShellProfile[]> {
    return [...this.localShellProfiles];
  }

  public async saveLocalShellProfiles(profiles: LocalShellProfile[]): Promise<void> {
    this.localShellProfiles = [...profiles];
  }

  public async getGroups(): Promise<string[]> {
    return [...this.groups];
  }

  public async saveGroups(groups: string[]): Promise<void> {
    this.groups = [...groups];
  }

  public async getAuthProfiles(): Promise<AuthProfile[]> {
    return [...this.authProfiles];
  }

  public async saveAuthProfiles(profiles: AuthProfile[]): Promise<void> {
    this.authProfiles = [...profiles];
  }

  public async getInventorySources(): Promise<InventorySourceConfig[]> {
    // FINDING 1 (removal-identity review) — mirrors VscodeConfigRepository's
    // load-time backfill for legacy (pre-revision) records; see its comment.
    return this.inventorySources.map(ensureInventorySourceRevision);
  }

  public async saveInventorySources(sources: InventorySourceConfig[]): Promise<void> {
    this.inventorySources = [...sources];
  }

  public async getDeviceTemplates(): Promise<DeviceTemplateProfile[]> {
    // DEVICE TEMPLATES (PR-T1) — mirrors VscodeConfigRepository's load-time
    // backfill for legacy (pre-revision) records.
    return this.deviceTemplates.map(ensureDeviceTemplateRevision);
  }

  public async saveDeviceTemplates(templates: DeviceTemplateProfile[]): Promise<void> {
    this.deviceTemplates = [...templates];
  }
}
