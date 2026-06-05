import { SETTINGS_META, type SettingMeta } from "./settingsMetadata";

export interface SettingValidationOk {
  ok: true;
  meta: SettingMeta;
  value: unknown;
}

export interface SettingValidationError {
  ok: false;
  message: string;
}

export type SettingValidationResult = SettingValidationOk | SettingValidationError;

export const SETTING_INDEX = new Map(
  SETTINGS_META.map((meta) => [`${meta.section}.${meta.key}`, meta] as const)
);

export function validateSettingUpdate(section: unknown, key: unknown, value: unknown): SettingValidationResult {
  if (typeof section !== "string" || typeof key !== "string") {
    return { ok: false, message: "Invalid setting identifier." };
  }

  const meta = SETTING_INDEX.get(`${section}.${key}`);
  if (!meta) {
    return { ok: false, message: "Unknown Nexus setting." };
  }

  switch (meta.type) {
    case "boolean":
      return typeof value === "boolean"
        ? { ok: true, meta, value }
        : { ok: false, message: "Expected a boolean value." };
    case "number": {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        return { ok: false, message: "Expected a finite number." };
      }
      if (meta.min !== undefined && value < meta.min) {
        return { ok: false, message: `Minimum value is ${meta.min}.` };
      }
      if (meta.max !== undefined && value > meta.max) {
        return { ok: false, message: `Maximum value is ${meta.max}.` };
      }
      return { ok: true, meta, value };
    }
    case "string":
    case "directory":
      return typeof value === "string"
        ? { ok: true, meta, value }
        : { ok: false, message: "Expected a string value." };
    case "enum": {
      const allowed = new Set((meta.enumOptions ?? []).map((option) => option.value));
      return typeof value === "string" && allowed.has(value)
        ? { ok: true, meta, value }
        : { ok: false, message: "Expected one of the configured options." };
    }
    case "multi-checkbox": {
      const allowed = new Set((meta.checkboxOptions ?? []).map((option) => option.value));
      if (!Array.isArray(value) || !value.every((item) => typeof item === "string" && allowed.has(item))) {
        return { ok: false, message: "Expected a list of supported checkbox values." };
      }
      const deduped = [...new Set(value)];
      // An empty selection is never valid — the master toggle (boolean setting) is the
      // right way to disable a feature entirely.  This also prevents backup import from
      // re-propagating a corrupted [] value into the user's settings.json.
      if (deduped.length === 0) {
        return {
          ok: false,
          message: "Select at least one option. To disable keyboard passthrough entirely, turn off Keyboard Passthrough instead."
        };
      }
      return { ok: true, meta, value: deduped };
    }
  }
}
