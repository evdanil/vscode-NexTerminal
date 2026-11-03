import type { HighlightRule } from "../utils/highlightRuleValidation";

export interface HighlightProfile {
  id: string;
  name: string;
  rules: HighlightRule[];
}

/** Absent inherits the global default; null deliberately disables highlighting. */
export type HighlightProfileSelection = string | null | undefined;

export interface HighlightCatalog {
  profiles: readonly HighlightProfile[];
  defaultProfileId: string | null;
  enabled: boolean;
  legacy: boolean;
  /** Keep invalid settings recoverable: an editor must not save this as an empty catalog. */
  validationError?: string;
}

export type HighlightOwner =
  | { kind: "server"; id: string }
  | { kind: "serial"; id: string }
  | { kind: "localShell"; id: string }
  | { kind: "localServer"; id: string };

export type SessionHighlightOverride =
  | { mode: "saved" }
  | { mode: "override"; selection: HighlightProfileSelection };

export interface HighlightSelectionState {
  requested: HighlightProfileSelection;
  effectiveProfileId: string | null;
  missingProfileId?: string;
  origin: "global" | "saved" | "session";
  enabled: boolean;
}

export function resolveHighlightProfile(
  catalog: HighlightCatalog,
  selection: HighlightProfileSelection
): HighlightProfile | undefined {
  if (!catalog.enabled) return undefined;
  const selectedId = selection === undefined ? catalog.defaultProfileId : selection;
  if (selectedId === null) return undefined;
  // A missing explicit choice must never begin applying an unrelated default.
  return catalog.profiles.find((profile) => profile.id === selectedId);
}
