type InspectLike = Record<string, unknown> | undefined;

export interface ScriptRuntimeConfigLike {
  get<T>(key: string, fallback?: T): T | undefined;
  inspect?<T>(key: string): InspectLike;
}

export function hasConfiguredValue(config: ScriptRuntimeConfigLike, key: string): boolean {
  const inspected = config.inspect?.<number>(key);
  const configuredKeys = [
    "globalValue",
    "workspaceValue",
    "workspaceFolderValue",
    "globalLanguageValue",
    "workspaceLanguageValue",
    "workspaceFolderLanguageValue"
  ];

  if (inspected) {
    for (const configuredKey of configuredKeys) {
      const value = inspected[configuredKey];
      if (value !== undefined) {
        return true;
      }
    }
  }

  return false;
}
