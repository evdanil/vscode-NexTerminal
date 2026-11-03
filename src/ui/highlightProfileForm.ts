import type { HighlightCatalog, HighlightProfileSelection } from "../models/highlightProfile";
import { isHighlightProfileSelection } from "../utils/highlightProfileValidation";
import type { FormFieldDescriptor } from "./formTypes";

const NONE_VALUE = "__none__";
const PROFILE_PREFIX = "profile:";

export function encodeHighlightProfileSelection(selection: HighlightProfileSelection): string {
  if (selection === undefined) return "";
  if (selection === null) return NONE_VALUE;
  // Prefix every real ID so names resembling a form sentinel remain selectable.
  return `${PROFILE_PREFIX}${selection}`;
}

export function parseHighlightProfileFormValue(
  value: unknown,
  fallback?: HighlightProfileSelection
): HighlightProfileSelection {
  if (value === undefined) return fallback;
  if (value === "") return undefined;
  if (value === NONE_VALUE) return null;
  if (typeof value === "string" && value.startsWith(PROFILE_PREFIX)) {
    const id = value.slice(PROFILE_PREFIX.length);
    if (isHighlightProfileSelection(id)) return id;
  }
  throw new Error("Choose a highlight profile, None, or Use global default.");
}

export function highlightProfileSelectField(
  catalog?: HighlightCatalog,
  selectedId?: HighlightProfileSelection
): Extract<FormFieldDescriptor, { type: "select" }> {
  const profiles = catalog?.profiles ?? [];
  const defaultProfile = profiles.find((profile) => profile.id === catalog?.defaultProfileId);
  const defaultName = catalog?.defaultProfileId === null ? "None"
    : defaultProfile?.name ?? (catalog ? `Missing: ${catalog.defaultProfileId}` : undefined);
  const options = [
    { label: defaultName === undefined ? "Use global default" : `Use global default (${defaultName})`, value: "" },
    { label: "None", value: NONE_VALUE },
    ...profiles.map((profile) => ({ label: profile.name, value: encodeHighlightProfileSelection(profile.id) }))
  ];
  if (typeof selectedId === "string" && !profiles.some((profile) => profile.id === selectedId)) {
    options.push({ label: `Missing profile: ${selectedId} (no highlighting)`, value: encodeHighlightProfileSelection(selectedId) });
  }
  const stateHint = catalog?.validationError
    ? `${catalog.validationError} Repair the catalog with Nexus: Edit Highlighting Rules.`
    : catalog?.enabled === false ? "Highlighting is off globally. Enable terminal highlighting in Nexus Settings." : "";
  return {
    type: "select",
    key: "highlightProfileId",
    label: "Highlight Profile",
    filterable: true,
    options,
    value: encodeHighlightProfileSelection(selectedId),
    hint: `${stateHint ? `${stateHint} ` : ""}Applies to this saved connection. A terminal's own highlight override takes precedence. Manage profiles with Nexus: Edit Highlighting Rules.`
  };
}
