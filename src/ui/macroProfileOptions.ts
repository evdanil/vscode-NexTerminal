export type MacroProfileKind = "server" | "serial" | "profile";

export interface MacroProfileOption {
  id: string;
  name: string;
  kind?: MacroProfileKind;
}

export interface MacroProfileSelectOption extends MacroProfileOption {
  label: string;
}

export type MacroProfileOptionInput = MacroProfileOption | string;

function normalizeProfileOption(input: MacroProfileOptionInput): MacroProfileOption | undefined {
  if (typeof input === "string") {
    const id = input.trim();
    return id ? { id, name: id, kind: "profile" } : undefined;
  }

  const id = typeof input.id === "string" ? input.id.trim() : "";
  if (!id) return undefined;

  const name = typeof input.name === "string" && input.name.trim() ? input.name.trim() : id;
  return { id, name, kind: input.kind ?? "profile" };
}

function kindLabel(kind: MacroProfileKind | undefined): string {
  switch (kind) {
    case "server": return "Server";
    case "serial": return "Serial";
    default: return "Profile";
  }
}

function shortId(id: string): string {
  return id.length > 8 ? id.slice(0, 8) : id;
}

function displayLabel(option: MacroProfileOption, duplicateName: boolean): string {
  const kind = kindLabel(option.kind);
  const isRawIdFallback = option.name === option.id && option.kind === "profile";
  if (isRawIdFallback) {
    return option.id;
  }
  if (duplicateName) {
    return `${option.name} (${kind}, ${shortId(option.id)})`;
  }
  return `${option.name} (${kind})`;
}

export function buildMacroProfileSelectOptions(
  inputs: MacroProfileOptionInput[],
  selectedId?: string
): MacroProfileSelectOption[] {
  const byId = new Map<string, MacroProfileOption>();
  for (const input of inputs) {
    const option = normalizeProfileOption(input);
    if (option && !byId.has(option.id)) {
      byId.set(option.id, option);
    }
  }

  const trimmedSelectedId = selectedId?.trim();
  if (trimmedSelectedId && !byId.has(trimmedSelectedId)) {
    byId.set(trimmedSelectedId, {
      id: trimmedSelectedId,
      name: "Unknown profile",
      kind: "profile"
    });
  }

  const options = [...byId.values()];
  const nameCounts = new Map<string, number>();
  for (const option of options) {
    const key = option.name.toLocaleLowerCase();
    nameCounts.set(key, (nameCounts.get(key) ?? 0) + 1);
  }

  return options
    .map((option) => ({
      ...option,
      label: displayLabel(option, (nameCounts.get(option.name.toLocaleLowerCase()) ?? 0) > 1)
    }))
    .sort((a, b) => a.label.localeCompare(b.label));
}
