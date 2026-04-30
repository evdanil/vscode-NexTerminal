import { hasConfiguredValue, type ScriptRuntimeConfigLike } from "./configHelpers";
import { MAX_SAFE_TIMER_MS, MAX_SAFE_TIMER_SECONDS } from "./timerLimits";

const DEFAULT_MAX_RUNTIME_SECONDS = 1800;
const DEFAULT_MAX_RUNTIME_MS = DEFAULT_MAX_RUNTIME_SECONDS * 1000;
export const MAX_SCRIPT_RUNTIME_MS = MAX_SAFE_TIMER_MS;
export const MAX_SCRIPT_RUNTIME_SECONDS = MAX_SAFE_TIMER_SECONDS;

function clampRuntimeMs(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return undefined;
  }
  return Math.min(MAX_SCRIPT_RUNTIME_MS, Math.floor(value));
}

function secondsToMs(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return undefined;
  }
  return clampRuntimeMs(value * 1000);
}

export function resolveScriptMaxRuntimeMs(config: ScriptRuntimeConfigLike): number {
  if (hasConfiguredValue(config, "maxRuntimeSeconds")) {
    return secondsToMs(config.get<number>("maxRuntimeSeconds", DEFAULT_MAX_RUNTIME_SECONDS)) ?? DEFAULT_MAX_RUNTIME_MS;
  }

  if (hasConfiguredValue(config, "maxRuntimeMs")) {
    return clampRuntimeMs(config.get<number>("maxRuntimeMs", DEFAULT_MAX_RUNTIME_MS)) ?? DEFAULT_MAX_RUNTIME_MS;
  }

  const defaultSeconds = config.get<number>("maxRuntimeSeconds", DEFAULT_MAX_RUNTIME_SECONDS);
  return secondsToMs(defaultSeconds) ?? DEFAULT_MAX_RUNTIME_MS;
}
