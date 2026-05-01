type InspectLike = Record<string, unknown> | undefined;

export interface InspectableConfiguration {
  inspect?<T>(key: string): InspectLike;
}

const CONFIGURED_VALUE_KEYS = [
  "workspaceFolderLanguageValue",
  "workspaceLanguageValue",
  "globalLanguageValue",
  "workspaceFolderValue",
  "workspaceValue",
  "globalValue"
] as const;

export function getConfiguredSettingValue<T = unknown>(
  config: InspectableConfiguration,
  key: string
): T | undefined {
  const inspected = config.inspect?.<T>(key);
  if (!inspected) return undefined;

  for (const configuredKey of CONFIGURED_VALUE_KEYS) {
    const value = inspected[configuredKey];
    if (value !== undefined) {
      return value as T;
    }
  }

  return undefined;
}

export function hasConfiguredSettingValue(config: InspectableConfiguration, key: string): boolean {
  return getConfiguredSettingValue(config, key) !== undefined;
}
