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

export interface ConfigRepository {
  getServers(): Promise<ServerConfig[]>;
  saveServers(servers: ServerConfig[]): Promise<void>;
  getTunnels(): Promise<TunnelProfile[]>;
  saveTunnels(tunnels: TunnelProfile[]): Promise<void>;
  getSerialProfiles(): Promise<SerialProfile[]>;
  saveSerialProfiles(profiles: SerialProfile[]): Promise<void>;
  getLocalShellProfiles(): Promise<LocalShellProfile[]>;
  saveLocalShellProfiles(profiles: LocalShellProfile[]): Promise<void>;
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
  activeSessions: ActiveSession[];
  activeSerialSessions: ActiveSerialSession[];
  activeLocalShellSessions: ActiveLocalShellSession[];
  activeTunnels: ActiveTunnel[];
  remoteTunnels: TunnelRegistryEntry[];
  explicitGroups: string[];
  authProfiles: AuthProfile[];
  activitySessionIds: ReadonlySet<string>;
  focusedSessionId: string | undefined;
  inventorySources: InventorySourceConfig[];
  deviceTemplates: DeviceTemplateProfile[];
  savedFilters: SavedFilterDefinition[];
}

export interface TunnelRegistryStore {
  getEntries(): Promise<TunnelRegistryEntry[]>;
  saveEntries(entries: TunnelRegistryEntry[]): Promise<void>;
}
