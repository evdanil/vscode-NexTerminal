import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

type Result = { ok: true; body: string } | { ok: false; title: string; message: string };

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const SCRIPT = path.join(REPO_ROOT, "scripts", "extractReleaseNotes.mjs");

let extractReleaseNotes: (changelog: string, version: string) => Result;

beforeAll(async () => {
  ({ extractReleaseNotes } = (await import(pathToFileURL(SCRIPT).href)) as {
    extractReleaseNotes: typeof extractReleaseNotes;
  });
});

const changelog = (top: string): string =>
  `# Changelog\n\n${top}## [2.0.0] — 2026-01-01\n\n### Fixed\n\n- An older, published fix.\n`;

function failure(result: Result): { title: string; message: string } {
  if (result.ok) throw new Error(`expected a failure, got body:\n${result.body}`);
  return result;
}

describe("extractReleaseNotes", () => {
  it("fails a missing entry", () => {
    const r = failure(extractReleaseNotes(changelog(""), "3.0.0"));
    expect(r.title).toBe("No CHANGELOG entry");
    expect(r.message).toContain('no "## [3.0.0]" heading');
  });

  it("does not take a longer version's entry for a prefix of it (2.0 vs 2.0.0)", () => {
    expect(failure(extractReleaseNotes(changelog(""), "2.0")).title).toBe("No CHANGELOG entry");
  });

  it("fails an empty entry", () => {
    const r = failure(extractReleaseNotes(changelog("## [3.0.0] — 2026-02-01\n\n\n"), "3.0.0"));
    expect(r.title).toBe("Empty CHANGELOG entry");
  });

  it("fails an entry that has section headings but no notes (kills 'any nonblank line counts')", () => {
    const r = failure(extractReleaseNotes(changelog("## [3.0.0] — 2026-02-01\n\n### Added\n\n### Fixed\n\n"), "3.0.0"));
    expect(r.title).toBe("CHANGELOG entry has no notes");
    expect(r.message).toContain("section headings but no bullet or text");
  });

  it("passes one bullet under a section, and stops at the next entry", () => {
    const r = extractReleaseNotes(changelog("## [3.0.0] — 2026-02-01\n\n### Fixed\n\n- A fix.\n\n"), "v3.0.0");
    expect(r).toEqual({ ok: true, body: "## [3.0.0] — 2026-02-01\n\n### Fixed\n\n- A fix." });
  });

  it("passes a prose line with no section heading", () => {
    const r = extractReleaseNotes(changelog("## [3.0.0]\n\nMaintenance release.\n\n"), "3.0.0");
    expect(r).toEqual({ ok: true, body: "## [3.0.0]\n\nMaintenance release." });
  });

  it("takes the last entry in the file up to the end", () => {
    const r = extractReleaseNotes(changelog(""), "2.0.0");
    expect(r).toEqual({ ok: true, body: "## [2.0.0] — 2026-01-01\n\n### Fixed\n\n- An older, published fix." });
  });

  it("extracts a real-shaped entry whole: several sections, CRLF, nothing from the next entry", () => {
    const top = [
      "## [3.0.0] — 2026-02-01",
      "",
      "### Added",
      "",
      "- **New thing.** It does a thing.",
      "",
      "### Fixed",
      "",
      "- **First fix.** Details with `code` and a [link](docs/x.md).",
      "",
      "- **Second fix.** More details.",
      "",
      ""
    ].join("\r\n");
    const r = extractReleaseNotes(changelog(top), "3.0.0");
    if (!r.ok) throw new Error(r.message);
    expect(r.body.startsWith("## [3.0.0] — 2026-02-01\n\n### Added")).toBe(true);
    expect(r.body.endsWith("- **Second fix.** More details.")).toBe(true);
    expect(r.body).not.toContain("2.0.0");
    expect(r.body).not.toContain("\r");
    expect(r.body.match(/^- /gm)).toHaveLength(3);
  });

  it("says nothing was published and how to recover, for every failure kind", () => {
    for (const top of ["", "## [3.0.0]\n\n", "## [3.0.0]\n\n### Fixed\n\n"]) {
      const r = failure(extractReleaseNotes(changelog(top), "3.0.0"));
      expect(r.message).toContain("Nothing has been published yet");
      expect(r.message).toContain("delete it and tag again");
    }
  });
});

describe("extractReleaseNotes CLI", () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  function run(text: string, version: string): { status: number | null; stdout: string; out: string; outPath: string } {
    dir = mkdtempSync(path.join(tmpdir(), "release-notes-"));
    const cl = path.join(dir, "CHANGELOG.md");
    const outPath = path.join(dir, "notes.md");
    writeFileSync(cl, text);
    const p = spawnSync(process.execPath, [SCRIPT, version, outPath, cl], { encoding: "utf8" });
    let out = "";
    try {
      out = readFileSync(outPath, "utf8");
    } catch {
      // not written on failure
    }
    return { status: p.status, stdout: p.stdout, out, outPath };
  }

  it("writes the entry and exits 0 on success", () => {
    const r = run(changelog("## [3.0.0]\n\n### Fixed\n\n- A fix.\n\n"), "v3.0.0");
    expect(r.status).toBe(0);
    expect(r.out).toBe("## [3.0.0]\n\n### Fixed\n\n- A fix.\n");
  });

  it("exits 1 with a GitHub ::error and writes nothing on a headings-only entry", () => {
    const r = run(changelog("## [3.0.0]\n\n### Fixed\n\n"), "3.0.0");
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/^::error title=CHANGELOG entry has no notes::/m);
    expect(r.out).toBe("");
  });

  it("exits 1 on a missing entry", () => {
    const r = run(changelog(""), "3.0.0");
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/^::error title=No CHANGELOG entry::/m);
  });
});
