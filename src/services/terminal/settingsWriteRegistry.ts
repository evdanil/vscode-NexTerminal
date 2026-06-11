/**
 * Registry of configuration writes Nexus itself is about to perform.
 *
 * Every Nexus write site (settings panel, reset-all, backup import, highlight
 * rule editor, keybinding repair) records its intended write here BEFORE
 * calling config.update(). The Settings Guard consults the registry when a
 * watched key changes: a match means "Nexus did this" and the event is logged
 * as own-write instead of external — keeping the forensic report (the artifact
 * handed to corporate IT) free of false externals.
 *
 * Matching:
 *  - A recorded value matches when it is structurally equal to the observed
 *    effective value (jsonEqual).
 *  - A recorded `undefined` (key removal) is a wildcard: removals surface as
 *    the underlying default at the effective layer, which the writer cannot
 *    know — so the next change for that key within the TTL matches.
 *  - On a match, the matched entry and all OLDER entries for the key are
 *    consumed (events arrive in write order).
 *
 * Entries expire after TTL_MS (a failed/blocked write must not mask a later
 * genuine external change) and each key holds at most MAX_PENDING entries.
 *
 * Module-level singleton state: write sites and the guard are wired in
 * different layers; a shared instance avoids threading a handle through every
 * UI constructor. clearWriteRegistry() exists for test isolation.
 */
import { jsonEqual } from "./settingsGuard";

export const WRITE_REGISTRY_TTL_MS = 30_000;
export const MAX_PENDING_WRITES_PER_KEY = 20;

interface PendingWrite {
  value: unknown;
  recordedAtMs: number;
}

const pending = new Map<string, PendingWrite[]>();

/** Record an imminent Nexus-originated config write. Call BEFORE config.update(). */
export function recordNexusConfigWrite(fullKey: string, value: unknown, nowMs: number): void {
  const queue = pending.get(fullKey) ?? [];
  queue.push({ value, recordedAtMs: nowMs });
  if (queue.length > MAX_PENDING_WRITES_PER_KEY) {
    queue.splice(0, queue.length - MAX_PENDING_WRITES_PER_KEY);
  }
  pending.set(fullKey, queue);
}

/**
 * Try to match an observed change against recorded Nexus writes.
 * Returns true (and consumes the match plus older entries) when the change
 * is Nexus's own.
 */
export function consumeNexusConfigWrite(fullKey: string, observed: unknown, nowMs: number): boolean {
  const queue = pending.get(fullKey);
  if (!queue || queue.length === 0) return false;
  const fresh = queue.filter((w) => nowMs - w.recordedAtMs <= WRITE_REGISTRY_TTL_MS);
  const idx = fresh.findIndex((w) => w.value === undefined || jsonEqual(w.value, observed));
  if (idx === -1) {
    if (fresh.length === 0) pending.delete(fullKey);
    else pending.set(fullKey, fresh);
    return false;
  }
  const remaining = fresh.slice(idx + 1);
  if (remaining.length === 0) pending.delete(fullKey);
  else pending.set(fullKey, remaining);
  return true;
}

/** Test isolation. */
export function clearWriteRegistry(): void {
  pending.clear();
}
