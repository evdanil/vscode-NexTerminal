import * as vscode from "vscode";
import type { AuthProfile, LocalShellProfile, SerialProfile, ServerConfig, TunnelProfile } from "../models/config";
import { ensureInventorySourceRevision, type InventorySourceConfig } from "../models/inventory";
import { ensureDeviceTemplateRevision, type DeviceTemplateProfile } from "../models/deviceTemplate";
import type { SavedFilterDefinition } from "../models/savedFilter";
import type { ConfigRepository } from "../core/contracts";
import {
  validateServerConfig,
  validateTunnelProfile,
  validateSerialProfile,
  validateAuthProfile,
  validateLocalShellProfile,
  validateInventorySource,
  validateDeviceTemplate,
  validateSavedFilter,
  isValidServerOrigin,
  isValidDetachedServerOrigin
} from "../utils/validation";
import { asArray } from "../utils/helpers";

const SERVERS_KEY = "nexus.servers";
const TUNNELS_KEY = "nexus.tunnels";
const SERIAL_PROFILES_KEY = "nexus.serialProfiles";
const LOCAL_SHELL_PROFILES_KEY = "nexus.localShellProfiles";
const GROUPS_KEY = "nexus.groups";
const AUTH_PROFILES_KEY = "nexus.authProfiles";
const INVENTORY_SOURCES_KEY = "nexus.inventorySources";
const DEVICE_TEMPLATES_KEY = "nexus.deviceTemplates";
const SAVED_FILTERS_KEY = "nexus.savedFilters";

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
      //
      // ADOPT 1 — `formerlySynced` gets the same treatment at the same
      // boundary, for the same reason: validateServerConfig deliberately
      // accepts a row whose marker is malformed, and the sync engine's
      // adoption rule reads `providerId`/`externalId` off it to decide whether
      // a source may claim an existing record. The two checks are sequential
      // rather than exclusive so a row carrying both malformed loses both —
      // a strip costs a field its trust, never the user their server.
      //
      // ADOPT 1 (mutual exclusion) — with the one coupling `addServerSanitizingOrigin`
      // carries at the import boundary, in the same single direction and for the
      // same reason: a marker is dropped when the origin beside it was stripped,
      // however well-formed the marker itself is. The two fields are mutually
      // exclusive by construction, and the engine's first eligibility clause
      // (`origin === undefined`) is the only thing making a row that holds both
      // inert. Stripping the origin removes exactly that protection, so a corrupt
      // row would come out of this read ADOPTABLE — claimable whole by a source
      // that never kept it — having arrived unadoptable. A sanitizer may cost an
      // untrusted field its trust; it must never let corruption GAIN authority.
      // Repair is not on offer: the origin is malformed precisely because its own
      // `externalId` cannot be trusted, so there is nothing to build a truthful
      // marker from. See that function's doc comment for why the coupling is
      // deliberately NOT widened to a well-formed origin.
      let sanitized: ServerConfig = item;
      let originWasStripped = false;
      if (sanitized.origin !== undefined && !isValidServerOrigin(sanitized.origin)) {
        console.warn("[Nexus] Server config has a malformed origin; stripping it:", JSON.stringify(sanitized.origin));
        const { origin: _origin, ...rest } = sanitized;
        sanitized = rest as ServerConfig;
        originWasStripped = true;
      }
      if (sanitized.formerlySynced !== undefined) {
        const markerIsMalformed = !isValidDetachedServerOrigin(sanitized.formerlySynced);
        if (markerIsMalformed || originWasStripped) {
          console.warn(
            markerIsMalformed
              ? "[Nexus] Server config has a malformed formerlySynced marker; stripping it:"
              : "[Nexus] Server config carried a formerlySynced marker beside a malformed origin; stripping the marker too:",
            JSON.stringify(sanitized.formerlySynced)
          );
          const { formerlySynced: _formerlySynced, ...rest } = sanitized;
          sanitized = rest as ServerConfig;
        }
      }
      result.push(sanitized);
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

  public async getDeviceTemplates(): Promise<DeviceTemplateProfile[]> {
    // DEVICE TEMPLATES (PR-T1) — same load-time backfill as inventory sources:
    // a template persisted before the `revision` field existed is given one
    // here, so every in-memory record this process hands out has one. Does not
    // rewrite disk (the next saveDeviceTemplates does, incidentally).
    const raw = asArray<DeviceTemplateProfile>(this.context.globalState.get(DEVICE_TEMPLATES_KEY, []));
    return raw
      .filter((item) => {
        if (validateDeviceTemplate(item)) {
          return true;
        }
        console.warn("[Nexus] Skipping invalid device template entry:", JSON.stringify(item));
        return false;
      })
      .map(ensureDeviceTemplateRevision);
  }

  public async saveDeviceTemplates(templates: DeviceTemplateProfile[]): Promise<void> {
    await this.context.globalState.update(DEVICE_TEMPLATES_KEY, templates);
  }

  public async getSavedFilters(): Promise<SavedFilterDefinition[]> {
    // SAVED FILTER DEFINITIONS (PR-E) — same corrupt-shape-tolerant load as every
    // other store: a whole entry is skipped if its shape guard fails, never a
    // partial one. No `revision` machinery (a saved filter is a copy-from template
    // with no in-flight-sync semantics), so no load-time backfill.
    const raw = asArray<SavedFilterDefinition>(this.context.globalState.get(SAVED_FILTERS_KEY, []));
    return raw.filter((item) => {
      if (validateSavedFilter(item)) {
        return true;
      }
      console.warn("[Nexus] Skipping invalid saved filter entry:", JSON.stringify(item));
      return false;
    });
  }

  public async saveSavedFilters(filters: SavedFilterDefinition[]): Promise<void> {
    await this.context.globalState.update(SAVED_FILTERS_KEY, filters);
  }
}
