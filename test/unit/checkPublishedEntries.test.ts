import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

type Result = { ok: true; skipped?: true } | { ok: false; title: string; message: string };
type Check = (tagChangelog: string, headChangelog: string, version: string) => Result;

const SCRIPT = path.resolve(__dirname, "..", "..", "scripts", "checkPublishedEntries.mjs");
let checkPublishedEntry: Check;

beforeAll(async () => {
  ({ checkPublishedEntry } = (await import(pathToFileURL(SCRIPT).href)) as { checkPublishedEntry: Check });
});

const RELEASED = "## [2.8.296] — 2026-09-29\n\n### Fixed\n\n- **A fix.** Details.\n\n- **Another fix.** More.\n";
const OLDER = "## [2.8.295] — 2026-09-28\n\n### Fixed\n\n- **Older.** Text.\n";
const NEXT = "## [2.8.297] — 2026-10-01\n\n### Added\n\n- **New thing.** It does a thing.\n";
const cl = (...entries: string[]): string => `# Changelog\n\n${entries.join("\n")}`;

/** The CHANGELOG exactly as it read at the v2.8.296 tag. */
const AT_TAG = cl(RELEASED, OLDER);

function failure(r: Result): { title: string; message: string } {
  if (r.ok) throw new Error("expected a failure");
  return r;
}

describe("checkPublishedEntry", () => {
  it("passes when a new entry sits above the unchanged released one", () => {
    expect(checkPublishedEntry(AT_TAG, cl(NEXT, RELEASED, OLDER), "v2.8.296")).toEqual({ ok: true });
  });

  it("ignores line endings and trailing whitespace", () => {
    const crlf = cl(NEXT, RELEASED.replace(/\n/g, "  \r\n"), OLDER);
    expect(checkPublishedEntry(AT_TAG, crlf, "2.8.296")).toEqual({ ok: true });
  });

  it("fails a renamed released heading, and names the rename (the Codex P2 case)", () => {
    const renamed = cl(RELEASED.replace("## [2.8.296]", "## [2.8.297]"), OLDER);
    const r = failure(checkPublishedEntry(AT_TAG, renamed, "2.8.296"));
    expect(r.title).toBe("Published CHANGELOG entry renamed");
    expect(r.message).toContain("renames it to [2.8.297]");
    expect(r.message).toContain("ABOVE it");
  });

  it("fails a changed bullet in the released entry", () => {
    const edited = cl(NEXT, RELEASED.replace("Details.", "Different details."), OLDER);
    const r = failure(checkPublishedEntry(AT_TAG, edited, "2.8.296"));
    expect(r.title).toBe("Published CHANGELOG entry changed");
  });

  it("fails a bullet added to the released entry", () => {
    const added = cl(NEXT, RELEASED + "\n- **Late addition.** Sneaked in.\n", OLDER);
    expect(failure(checkPublishedEntry(AT_TAG, added, "2.8.296")).title).toBe("Published CHANGELOG entry changed");
  });

  it("fails a missing released entry", () => {
    const r = failure(checkPublishedEntry(AT_TAG, cl(NEXT, OLDER), "2.8.296"));
    expect(r.title).toBe("Published CHANGELOG entry missing");
    expect(r.message).toContain("Restore it exactly as it reads at the v2.8.296 tag");
  });

  it("fails when the released entry is still the top entry", () => {
    const r = failure(checkPublishedEntry(AT_TAG, AT_TAG, "2.8.296"));
    expect(r.title).toBe("Published CHANGELOG entry on top");
  });

  it("skips a tag whose own CHANGELOG has no entry for it (nothing was published)", () => {
    expect(checkPublishedEntry(cl(OLDER), cl(NEXT, OLDER), "2.8.296")).toEqual({ ok: true, skipped: true });
  });
});
