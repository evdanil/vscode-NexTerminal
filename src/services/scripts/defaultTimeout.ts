import { hasConfiguredValue, type ScriptRuntimeConfigLike } from "./configHelpers";
import { MAX_SAFE_TIMER_MS, MAX_SAFE_TIMER_SECONDS } from "./timerLimits";

export type { ScriptRuntimeConfigLike } from "./configHelpers";

const DEFAULT_SCRIPT_WAIT_TIMEOUT_SECONDS = 30;
export const DEFAULT_SCRIPT_WAIT_TIMEOUT_MS = DEFAULT_SCRIPT_WAIT_TIMEOUT_SECONDS * 1000;
export const MAX_SCRIPT_WAIT_TIMEOUT_MS = MAX_SAFE_TIMER_MS;
export const MAX_SCRIPT_WAIT_TIMEOUT_SECONDS = MAX_SAFE_TIMER_SECONDS;
const MIN_LEGACY_WAIT_TIMEOUT_MS = 100;

function clampLegacyTimeoutMs(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < MIN_LEGACY_WAIT_TIMEOUT_MS) {
    return undefined;
  }
  return Math.min(MAX_SCRIPT_WAIT_TIMEOUT_MS, Math.floor(value));
}

function secondsToMs(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 1) {
    return undefined;
  }
  return Math.min(MAX_SCRIPT_WAIT_TIMEOUT_MS, Math.floor(value * 1000));
}

export function resolveScriptDefaultTimeoutMs(config: ScriptRuntimeConfigLike): number {
  if (hasConfiguredValue(config, "defaultTimeoutSeconds")) {
    return secondsToMs(config.get<number>("defaultTimeoutSeconds", DEFAULT_SCRIPT_WAIT_TIMEOUT_SECONDS))
      ?? DEFAULT_SCRIPT_WAIT_TIMEOUT_MS;
  }

  if (hasConfiguredValue(config, "defaultTimeout")) {
    return clampLegacyTimeoutMs(config.get<number>("defaultTimeout", DEFAULT_SCRIPT_WAIT_TIMEOUT_MS))
      ?? DEFAULT_SCRIPT_WAIT_TIMEOUT_MS;
  }

  const defaultSeconds = config.get<number>("defaultTimeoutSeconds", DEFAULT_SCRIPT_WAIT_TIMEOUT_SECONDS);
  return secondsToMs(defaultSeconds) ?? DEFAULT_SCRIPT_WAIT_TIMEOUT_MS;
}
