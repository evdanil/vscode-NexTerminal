import type { HighlightCatalog, HighlightOwner, HighlightProfileSelection, HighlightSelectionState, SessionHighlightOverride } from "../../models/highlightProfile";
import { TerminalHighlighter, TerminalHighlighterStream, type TerminalOutputHighlighter } from "../terminalHighlighter";

interface SavedRecord { id: string; highlightProfileId?: string | null }
interface SavedSelections {
  servers: readonly SavedRecord[];
  serialProfiles: readonly SavedRecord[];
  localShellProfiles: readonly SavedRecord[];
  localServers: readonly SavedRecord[];
}
interface CacheEntry { revision: string; engine: TerminalHighlighter }

/** Owns the catalog and compiled engines; each terminal owns its selection. */
export class HighlightProfileService {
  private catalog: HighlightCatalog;
  private profiles = new Map<string, HighlightCatalog["profiles"][number]>();
  private readonly engines = new Map<string, CacheEntry>();
  private readonly sessions = new Set<SessionHighlightHandle>();
  private savedReferenceCounts = new Map<string, number>();
  private inheritedSavedCount = 0;

  public constructor(private readonly readCatalog: () => HighlightCatalog) {
    this.catalog = readCatalog();
    this.setCatalog(this.catalog);
  }

  public reload(): void { this.setCatalog(this.readCatalog()); }

  private setCatalog(catalog: HighlightCatalog): void {
    this.catalog = catalog;
    this.profiles = new Map(catalog.profiles.map(profile => [profile.id, profile]));
    for (const [id, entry] of this.engines) {
      const profile = this.profiles.get(id);
      if (!profile || JSON.stringify(profile.rules) !== entry.revision) this.engines.delete(id);
    }
  }

  public createSession(owner?: HighlightOwner, initialSelection?: HighlightProfileSelection): SessionHighlightHandle {
    const handle = new SessionHighlightHandle(this, owner, initialSelection);
    this.sessions.add(handle);
    return handle;
  }

  /** IDs may remain referenced after their profiles or saved owners are removed. */
  public getReferencedProfileIds(): ReadonlySet<string> {
    const ids = new Set(this.savedReferenceCounts.keys());
    if (this.catalog.defaultProfileId !== null) ids.add(this.catalog.defaultProfileId);
    for (const session of this.sessions) session.collectReferencedProfileIds(ids);
    return ids;
  }

  public countProfileReferences(id: string): { saved: number; live: number } {
    let live = 0;
    for (const session of this.sessions) {
      if (session.getSelection().effectiveProfileId === id) live++;
    }
    const inherited = this.catalog.defaultProfileId === id ? this.inheritedSavedCount : 0;
    return { saved: (this.savedReferenceCounts.get(id) ?? 0) + inherited, live };
  }

  public updateSavedSelections(snapshot: SavedSelections): void {
    const counts = new Map<string, number>();
    let inherited = 0;
    for (const record of [...snapshot.servers, ...snapshot.serialProfiles, ...snapshot.localShellProfiles, ...snapshot.localServers]) {
      if (record.highlightProfileId === undefined) inherited++;
      else if (typeof record.highlightProfileId === "string") counts.set(record.highlightProfileId, (counts.get(record.highlightProfileId) ?? 0) + 1);
    }
    this.savedReferenceCounts = counts;
    this.inheritedSavedCount = inherited;
    const collections = {
      server: new Map(snapshot.servers.map(record => [record.id, record])),
      serial: new Map(snapshot.serialProfiles.map(record => [record.id, record])),
      localShell: new Map(snapshot.localShellProfiles.map(record => [record.id, record])),
      localServer: new Map(snapshot.localServers.map(record => [record.id, record]))
    };
    for (const session of this.sessions) {
      if (!session.owner) continue;
      const record = collections[session.owner.kind].get(session.owner.id);
      if (record) session.updateSavedSelection(record.highlightProfileId);
    }
  }

  public resolve(selection: HighlightProfileSelection, origin: HighlightSelectionState["origin"]): HighlightSelectionState {
    const id = selection === undefined ? this.catalog.defaultProfileId : selection;
    const profile = id === null ? undefined : this.profiles.get(id);
    return {
      requested: selection, effectiveProfileId: profile ? profile.id : null,
      ...(id !== null && !profile ? { missingProfileId: id } : {}), origin,
      enabled: this.catalog.enabled
    };
  }

  public engine(id: string | null): TerminalHighlighter | undefined {
    if (id === null) return undefined;
    const profile = this.profiles.get(id);
    if (!profile) return undefined;
    let cached = this.engines.get(id);
    if (!cached) {
      cached = { revision: JSON.stringify(profile.rules), engine: new TerminalHighlighter({ enabled: true, rules: profile.rules }) };
      this.engines.set(id, cached);
    }
    return cached.engine;
  }

  public forget(handle: SessionHighlightHandle): void { this.sessions.delete(handle); }
}

export class SessionHighlightHandle implements TerminalOutputHighlighter {
  private override: SessionHighlightOverride = { mode: "saved" };
  public constructor(private readonly service: HighlightProfileService, public readonly owner?: HighlightOwner, private savedSelection?: HighlightProfileSelection) {}

  public collectReferencedProfileIds(ids: Set<string>): void {
    if (typeof this.savedSelection === "string") ids.add(this.savedSelection);
    if (this.override.mode === "override" && typeof this.override.selection === "string") ids.add(this.override.selection);
  }
  public setOverride(override: SessionHighlightOverride): void { this.override = override; }
  public updateSavedSelection(selection: HighlightProfileSelection): void { this.savedSelection = selection; }
  public getSelection(): HighlightSelectionState {
    if (this.override.mode === "override") return this.service.resolve(this.override.selection, "session");
    return this.service.resolve(this.savedSelection, this.savedSelection === undefined ? "global" : "saved");
  }
  private currentEngine(): TerminalHighlighter | undefined {
    const state = this.getSelection();
    return state.enabled ? this.service.engine(state.effectiveProfileId) : undefined;
  }
  public isEnabled(): boolean { return this.currentEngine()?.isEnabled() ?? false; }
  public apply(text: string): string { return this.currentEngine()?.apply(text) ?? text; }
  public createStream(emit: (text: string) => void, flushDelayMs = 15): TerminalHighlighterStream {
    return new TerminalHighlighterStream(this, emit, flushDelayMs);
  }
  public dispose(): void { this.service.forget(this); }
}
