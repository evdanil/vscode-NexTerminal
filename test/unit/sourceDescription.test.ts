import { describe, expect, it } from "vitest";
import {
  formatLastSync,
  formatLastSyncAbsolute,
  sourceDescription,
  sourceDescriptionAbsolute
} from "../../src/services/inventory/sourceDescription";

/**
 * P2-1 — two renderings of the same record's last-sync time. The Manage panel
 * keeps the RELATIVE form (it re-renders while visible), while the Settings
 * tree uses the ABSOLUTE form, which never drifts and so never freezes at a
 * stale relative age when no refresh fires.
 */
describe("formatLastSync (relative — Manage panel)", () => {
  const base = new Date("2026-08-17T12:00:00Z").getTime();
  it("renders a relative age that moves with `now`", () => {
    expect(formatLastSync({ lastSyncAt: base }, base)).toBe("synced just now");
    expect(formatLastSync({ lastSyncAt: base }, base + 3 * 60 * 60_000)).toBe("synced 3h ago");
  });
  it("says never synced when there is no timestamp", () => {
    expect(formatLastSync({})).toBe("never synced");
  });
});

describe("formatLastSyncAbsolute (Settings tree)", () => {
  it("renders a fixed YYYY-MM-DD HH:MM stamp derived only from the timestamp, taking no `now` (⊘ a relative age would drift as the clock advances and freeze on a suppressed refresh)", () => {
    const stamp = formatLastSyncAbsolute({ lastSyncAt: new Date("2026-08-17T04:30:00Z").getTime() });
    expect(stamp).toMatch(/^synced \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
    expect(stamp).not.toMatch(/ago|just now/);
  });

  it("is a pure function of the timestamp — the same input yields the same string no matter when it is called", () => {
    const at = new Date("2026-08-17T04:30:00Z").getTime();
    expect(formatLastSyncAbsolute({ lastSyncAt: at })).toBe(formatLastSyncAbsolute({ lastSyncAt: at }));
  });

  it("says never synced when there is no timestamp", () => {
    expect(formatLastSyncAbsolute({})).toBe("never synced");
  });
});

describe("sourceDescriptionAbsolute", () => {
  const registry = { get: (id: string) => (id === "eve-ng" ? { label: "EVE-NG" } : undefined) };
  it("pairs the provider label with the absolute stamp", () => {
    expect(sourceDescriptionAbsolute({ providerId: "eve-ng", lastSyncAt: new Date("2026-08-17T04:30:00Z").getTime() }, registry as never)).toMatch(
      /^EVE-NG — synced \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/
    );
  });
  it("falls back to the raw providerId and shows never synced", () => {
    expect(sourceDescriptionAbsolute({ providerId: "acme", lastSyncAt: undefined }, registry as never)).toBe("acme — never synced");
  });
  it("stays distinct from the relative sourceDescription used by the Manage panel", () => {
    const at = Date.now() - 3 * 60 * 60_000;
    expect(sourceDescription({ providerId: "eve-ng", lastSyncAt: at }, registry as never)).toContain("ago");
    expect(sourceDescriptionAbsolute({ providerId: "eve-ng", lastSyncAt: at }, registry as never)).not.toContain("ago");
  });
});
