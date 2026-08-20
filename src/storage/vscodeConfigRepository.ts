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

/**
 * CROSS-WINDOW OVERWRITE DETECTION (defect: "a second window's edit is lost").
 *
 * Every save*() below persists the ENTIRE in-memory list for its collection,
 * and `globalState` is shared across VS Code windows with last-writer-wins
 * semantics and no compare-and-swap: window A's next save of a collection
 * silently reverts anything window B persisted to it since A last loaded.
 * NexusCore loads once at activation and never re-reads, so the window in
 * which this bites is unbounded. This is general to all nine collections, not
 * inventory-specific.
 *
 * What the storage layer actually allows (verified against VS Code's
 * extHostMemento implementation):
 *   - `Memento.get` reads only this extension host's in-memory cache;
 *   - `Memento.update` writes the extension's WHOLE key/value state object
 *     from that cache — there is no per-key write, no CAS, and no way to
 *     "persist only the changed record" beneath this API;
 *   - another window's write DOES propagate back into this host's cache
 *     (the cached state object is replaced wholesale), asynchronously and
 *     with no event exposed to extensions.
 *
 * So prevention is not available at this layer, but detection is: remember
 * the JSON of the raw stored value this window last read or wrote per key
 * (`lastSeenJson`), and on each save compare it against what the cache holds
 * NOW. A mismatch means another window wrote this collection in between; the
 * save still proceeds exactly as before (never blocked, never slower in any
 * measurable way, never able to fail because of the guard — detection errors
 * are swallowed), but the overwrite is no longer silent: it is logged and
 * surfaced through `onConcurrentOverwrite` so the user can redo the
 * superseded edit.
 *
 * KNOWN RESIDUAL (deliberate — a full optimistic-concurrency merge is out of
 * proportion here and would have to be fed back through NexusCore, whose sync
 * engine, rollback captures and revision semantics all assume it is the sole
 * authority):
 *   - the foreign edit is still overwritten; the user is told, not saved;
 *   - a foreign write that has not yet propagated into this host's cache when
 *     this window saves is undetectable (bounded by propagation latency,
 *     typically well under a second — not by window lifetime as before);
 *   - because Memento.update writes the whole extension blob from the local
 *     cache, a not-yet-propagated foreign write to collection X can also be
 *     clobbered by this window saving unrelated collection Y — same latency
 *     bound, equally undetectable at this layer.
 */
interface VscodeConfigRepositoryOptions {
  /**
   * Called when a save is about to overwrite a change some other VS Code
   * window persisted to the same collection. `collection` is a human-readable
   * plural label ("servers", "inventory sources", ...). Must not throw the
   * save off course — invoked inside the guard's own try/catch regardless.
   */
  onConcurrentOverwrite?: (collection: string) => void;
}

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
  /**
   * Per-key JSON of the raw stored value this window last read or wrote. See
   * the cross-window overwrite detection comment above. A key with no entry
   * (never read nor written by this repository instance) is never warned
   * about — there is no baseline to have diverged from.
   */
  private readonly lastSeenJson = new Map<string, string>();

  public constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly options: VscodeConfigRepositoryOptions = {}
  ) {}

  /** Read the raw stored value and record it as this window's baseline. */
  private readRaw<T>(key: string): T {
    const raw = this.context.globalState.get<T>(key, [] as T);
    try {
      this.lastSeenJson.set(key, JSON.stringify(raw));
    } catch {
      // A baseline that cannot be serialized is dropped rather than left
      // stale: no baseline -> no warning, never a broken read.
      this.lastSeenJson.delete(key);
    }
    return raw;
  }

  /**
   * Write through to globalState, first flagging (never blocking) a write
   * that would overwrite another window's change to the same key. The guard
   * must never make a save fail or change what gets written — detection
   * errors are swallowed and the update below runs unconditionally.
   */
  private async guardedUpdate(key: string, collection: string, value: unknown): Promise<void> {
    let newJson: string | undefined;
    try {
      newJson = JSON.stringify(value);
      const baseline = this.lastSeenJson.get(key);
      if (baseline !== undefined) {
        const stored = JSON.stringify(this.context.globalState.get(key, []));
        if (stored !== baseline) {
          console.warn(
            `[Nexus] The ${collection} list was changed by another VS Code window since this window last loaded it; this window's save is overwriting that change.`
          );
          this.options.onConcurrentOverwrite?.(collection);
        }
      }
    } catch (error) {
      console.warn("[Nexus] Concurrent-write detection failed; saving anyway:", error);
    }
    await this.context.globalState.update(key, value);
    if (newJson !== undefined) {
      this.lastSeenJson.set(key, newJson);
    } else {
      this.lastSeenJson.delete(key);
    }
  }

  public async getServers(): Promise<ServerConfig[]> {
    const raw = asArray<ServerConfig>(this.readRaw(SERVERS_KEY));
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
    await this.guardedUpdate(SERVERS_KEY, "servers", servers);
  }

  public async getTunnels(): Promise<TunnelProfile[]> {
    const raw = asArray<TunnelProfile>(this.readRaw(TUNNELS_KEY));
    return raw.filter((item) => {
      if (validateTunnelProfile(item)) {
        return true;
      }
      console.warn("[Nexus] Skipping invalid tunnel profile entry:", JSON.stringify(item));
      return false;
    });
  }

  public async saveTunnels(tunnels: TunnelProfile[]): Promise<void> {
    await this.guardedUpdate(TUNNELS_KEY, "tunnel profiles", tunnels);
  }

  public async getSerialProfiles(): Promise<SerialProfile[]> {
    const raw = asArray<SerialProfile>(this.readRaw(SERIAL_PROFILES_KEY));
    return raw.filter((item) => {
      if (validateSerialProfile(item)) {
        return true;
      }
      console.warn("[Nexus] Skipping invalid serial profile entry:", JSON.stringify(item));
      return false;
    });
  }

  public async saveSerialProfiles(profiles: SerialProfile[]): Promise<void> {
    await this.guardedUpdate(SERIAL_PROFILES_KEY, "serial profiles", profiles);
  }

  public async getLocalShellProfiles(): Promise<LocalShellProfile[]> {
    const raw = asArray<LocalShellProfile>(this.readRaw(LOCAL_SHELL_PROFILES_KEY));
    return raw.filter((item) => {
      if (validateLocalShellProfile(item)) {
        return true;
      }
      console.warn("[Nexus] Skipping invalid local shell profile entry:", JSON.stringify(item));
      return false;
    });
  }

  public async saveLocalShellProfiles(profiles: LocalShellProfile[]): Promise<void> {
    await this.guardedUpdate(LOCAL_SHELL_PROFILES_KEY, "local shell profiles", profiles);
  }

  public async getGroups(): Promise<string[]> {
    return asArray<string>(this.readRaw(GROUPS_KEY)).filter(
      (item): item is string => typeof item === "string"
    );
  }

  public async saveGroups(groups: string[]): Promise<void> {
    await this.guardedUpdate(GROUPS_KEY, "folders", groups);
  }

  public async getAuthProfiles(): Promise<AuthProfile[]> {
    const raw = asArray<AuthProfile>(this.readRaw(AUTH_PROFILES_KEY));
    return raw.filter((item) => {
      if (validateAuthProfile(item)) {
        return true;
      }
      console.warn("[Nexus] Skipping invalid auth profile entry:", JSON.stringify(item));
      return false;
    });
  }

  public async saveAuthProfiles(profiles: AuthProfile[]): Promise<void> {
    await this.guardedUpdate(AUTH_PROFILES_KEY, "auth profiles", profiles);
  }

  public async getInventorySources(): Promise<InventorySourceConfig[]> {
    const raw = asArray<InventorySourceConfig>(this.readRaw(INVENTORY_SOURCES_KEY));
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
    await this.guardedUpdate(INVENTORY_SOURCES_KEY, "inventory sources", sources);
  }

  public async getDeviceTemplates(): Promise<DeviceTemplateProfile[]> {
    // DEVICE TEMPLATES (PR-T1) — same load-time backfill as inventory sources:
    // a template persisted before the `revision` field existed is given one
    // here, so every in-memory record this process hands out has one. Does not
    // rewrite disk (the next saveDeviceTemplates does, incidentally).
    const raw = asArray<DeviceTemplateProfile>(this.readRaw(DEVICE_TEMPLATES_KEY));
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
    await this.guardedUpdate(DEVICE_TEMPLATES_KEY, "device templates", templates);
  }

  public async getSavedFilters(): Promise<SavedFilterDefinition[]> {
    // SAVED FILTER DEFINITIONS (PR-E) — same corrupt-shape-tolerant load as every
    // other store: a whole entry is skipped if its shape guard fails, never a
    // partial one. No `revision` machinery (a saved filter is a copy-from template
    // with no in-flight-sync semantics), so no load-time backfill.
    const raw = asArray<SavedFilterDefinition>(this.readRaw(SAVED_FILTERS_KEY));
    return raw.filter((item) => {
      if (validateSavedFilter(item)) {
        return true;
      }
      console.warn("[Nexus] Skipping invalid saved filter entry:", JSON.stringify(item));
      return false;
    });
  }

  public async saveSavedFilters(filters: SavedFilterDefinition[]): Promise<void> {
    await this.guardedUpdate(SAVED_FILTERS_KEY, "saved filters", filters);
  }
}
