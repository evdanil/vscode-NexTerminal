import type {
  ActiveLocalShellSession,
  ActiveSerialSession,
  ActiveSession,
  ActiveTunnel,
  AuthProfile,
  LocalShellProfile,
  SerialProfile,
  ServerConfig,
  TunnelProfile,
  TunnelRegistryEntry
} from "../models/config";
import type { InventorySourceConfig } from "../models/inventory";
import type { DeviceTemplateProfile } from "../models/deviceTemplate";
import type { SavedFilterDefinition } from "../models/savedFilter";
import type { ActiveNetworkServerSession } from "../models/networkServer";
import type { DhcpConfigProfile, TftpConfigProfile } from "../models/networkServerProfile";
import type { ActiveLocalServerSession, LocalServerConfig } from "../models/localServer";

export interface ConfigRepository {
  getServers(): Promise<ServerConfig[]>;
  saveServers(servers: ServerConfig[]): Promise<void>;
  getTunnels(): Promise<TunnelProfile[]>;
  saveTunnels(tunnels: TunnelProfile[]): Promise<void>;
  getSerialProfiles(): Promise<SerialProfile[]>;
  saveSerialProfiles(profiles: SerialProfile[]): Promise<void>;
  getLocalShellProfiles(): Promise<LocalShellProfile[]>;
  saveLocalShellProfiles(profiles: LocalShellProfile[]): Promise<void>;
  getTftpProfiles(): Promise<TftpConfigProfile[]>;
  saveTftpProfiles(profiles: TftpConfigProfile[]): Promise<void>;
  getDhcpProfiles(): Promise<DhcpConfigProfile[]>;
  saveDhcpProfiles(profiles: DhcpConfigProfile[]): Promise<void>;
  getLocalServers(): Promise<LocalServerConfig[]>;
  saveLocalServers(servers: LocalServerConfig[]): Promise<void>;
  getGroups(): Promise<string[]>;
  saveGroups(groups: string[]): Promise<void>;
  getAuthProfiles(): Promise<AuthProfile[]>;
  saveAuthProfiles(profiles: AuthProfile[]): Promise<void>;
  getInventorySources(): Promise<InventorySourceConfig[]>;
  saveInventorySources(sources: InventorySourceConfig[]): Promise<void>;
  getDeviceTemplates(): Promise<DeviceTemplateProfile[]>;
  saveDeviceTemplates(templates: DeviceTemplateProfile[]): Promise<void>;
  getSavedFilters(): Promise<SavedFilterDefinition[]>;
  saveSavedFilters(filters: SavedFilterDefinition[]): Promise<void>;
}

export interface SessionSnapshot {
  servers: ServerConfig[];
  tunnels: TunnelProfile[];
  serialProfiles: SerialProfile[];
  localShellProfiles: LocalShellProfile[];
  localServers: LocalServerConfig[];
  activeSessions: ActiveSession[];
  activeSerialSessions: ActiveSerialSession[];
  activeLocalShellSessions: ActiveLocalShellSession[];
  /**
   * Runtime state of the two fixed embedded network services (TFTP / DHCP).
   *
   * Runtime-only by design: there is no matching `networkServers` config array
   * because these services are configured entirely through native VS Code
   * settings (`nexus.networkServers.*`), which VS Code persists itself. Empty
   * until a service is first started.
   */
  activeNetworkServerSessions: ActiveNetworkServerSession[];
  /**
   * Saved presets for the two network services. Unlike the sessions above these
   * *are* persisted config: a profile is a named snapshot that gets written
   * back into `nexus.networkServers.*` on demand, never a second runtime model.
   * The two lists are independent — a TFTP preset never carries DHCP fields.
   */
  tftpProfiles: TftpConfigProfile[];
  dhcpProfiles: DhcpConfigProfile[];
  activeLocalServerSessions: ActiveLocalServerSession[];
  activeTunnels: ActiveTunnel[];
  remoteTunnels: TunnelRegistryEntry[];
  explicitGroups: string[];
  authProfiles: AuthProfile[];
  activitySessionIds: ReadonlySet<string>;
  // LIVE STATUS (Phase 2) — runtime-only running/stopped state per serverId,
  // driven by applyInventoryStatus. Empty unless a fetchStatus report has been
  // applied; never persisted.
  serverStatus: Map<string, "running" | "stopped">;
  focusedSessionId: string | undefined;
  inventorySources: InventorySourceConfig[];
  deviceTemplates: DeviceTemplateProfile[];
  savedFilters: SavedFilterDefinition[];
}

export interface TunnelRegistryStore {
  getEntries(): Promise<TunnelRegistryEntry[]>;
  saveEntries(entries: TunnelRegistryEntry[]): Promise<void>;
}
