import { hasConfiguredSettingValue, type InspectableConfiguration } from "../../utils/configurationInspection";

export interface ScriptRuntimeConfigLike extends InspectableConfiguration {
  get<T>(key: string, fallback?: T): T | undefined;
}

export function hasConfiguredValue(config: ScriptRuntimeConfigLike, key: string): boolean {
  return hasConfiguredSettingValue(config, key);
}
