/**
 * Published-entry guard for the "Version / changelog" CI check (ci.yml).
 *
 * A CHANGELOG entry whose v{version} tag exists has shipped inside a VSIX and
 * must never be edited (AGENTS.md). The version gate alone does not prevent it:
 * after v2.8.296 is tagged, renaming the published "## [2.8.296]" heading to
 * 2.8.297 satisfies "version > latest tag" and "top heading == version" while
 * deleting the published entry. So for each covered tag, the entry as it reads
 * in THE TAG'S OWN CHANGELOG.md must appear unchanged in the pull request's
 * CHANGELOG.md, below the top (unreleased) entry.
 *
 * COVERAGE: every v* tag at or above PUBLISHED_ENTRY_FLOOR whose own CHANGELOG
 * carries its entry. Measured against main when this guard was added
 * (207 tags): 103 predate CHANGELOG.md, 19 have a CHANGELOG without their own
 * entry (nothing published to protect), and of the rest every entry matches
 * main exactly EXCEPT v2.8.45 and v2.8.57, whose entries were removed from
 * main's CHANGELOG long before this rule. The floor sits just above that
 * drift, so the guard covers everything it can without failing every pull
 * request over history nobody can now repair. Do not lower it past 2.8.57.
 *
 * Usage (CI): node scripts/checkPublishedEntries.mjs <head-commit>
 *   Reads tags and CHANGELOG.md contents from git; prints GitHub ::error
 *   lines and exits 1 on any violation.
 */
import { execFileSync } from "node:child_process";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { extractReleaseNotes } from "./extractReleaseNotes.mjs";

export const PUBLISHED_ENTRY_FLOOR = "2.8.58";

const parse = (v) => {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(String(v).trim());
  return m ? m.slice(1, 4).map(Number) : null;
};
const cmp = (a, b) => {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
};

/** Line endings and trailing whitespace are not content. */
const normalize = (s) =>
  s.split(/\r?\n/).map((l) => l.replace(/\s+$/, "")).join("\n").trim();

/** The entry without its "## [x.y.z] — date" line, for spotting a rename. */
const bodyOf = (entry) => normalize(entry.split(/\r?\n/).slice(1).join("\n"));

const headings = (changelog) =>
  changelog.split(/\r?\n/).map((l, i) => ({ l, i })).filter(({ l }) => l.startsWith("## ["));

/**
 * Pure check of one published entry.
 *
 * @param {string} tagChangelog   CHANGELOG.md as it reads at the v{version} tag
 * @param {string} headChangelog  CHANGELOG.md at the pull request head
 * @param {string} version        x.y.z (or vx.y.z) of the tag
 * @returns {{ ok: true, skipped?: true } | { ok: false, title: string, message: string }}
 *   skipped: the tag's own CHANGELOG has no usable entry, so nothing was published.
 */
export function checkPublishedEntry(tagChangelog, headChangelog, version) {
  const v = String(version).trim().replace(/^v/, "");
  const published = extractReleaseNotes(tagChangelog, v);
  if (!published.ok) return { ok: true, skipped: true };

  const addAbove = `Add a new top entry for the next version ABOVE it instead; a published entry is never edited, renamed or removed.`;
  const current = extractReleaseNotes(headChangelog, v);
  if (!current.ok) {
    // Name a rename when the same body now sits under another heading.
    const want = bodyOf(published.body);
    const renamedTo = headings(headChangelog)
      .map(({ l }) => /^## \[([^\]]+)\]/.exec(l)?.[1])
      .find((other) => {
        if (!other || other === v) return false;
        const r = extractReleaseNotes(headChangelog, other);
        return r.ok && bodyOf(r.body) === want;
      });
    return {
      ok: false,
      title: renamedTo ? "Published CHANGELOG entry renamed" : "Published CHANGELOG entry missing",
      message: renamedTo
        ? `The "## [${v}]" entry was released as v${v}, but this pull request renames it to [${renamedTo}]. ${addAbove}`
        : `The "## [${v}]" entry was released as v${v}, but it is missing from CHANGELOG.md in this pull request. Restore it exactly as it reads at the v${v} tag. ${addAbove}`
    };
  }
  if (normalize(current.body) !== normalize(published.body)) {
    return {
      ok: false,
      title: "Published CHANGELOG entry changed",
      message: `The "## [${v}]" entry differs from the text released in v${v} (compare with: git show v${v}:CHANGELOG.md). Restore it exactly; put a correction in the unreleased top entry, naming the claim it replaces. ${addAbove}`
    };
  }
  // A published entry is never the top entry: the top one is unreleased.
  const first = headings(headChangelog)[0];
  if (first && first.l.startsWith(`## [${v}]`)) {
    return {
      ok: false,
      title: "Published CHANGELOG entry on top",
      message: `The top CHANGELOG.md entry is "## [${v}]", which was released as v${v}. Unreleased changes need their own entry above it. ${addAbove}`
    };
  }
  return { ok: true };
}

function git(args) {
  return execFileSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
}

function main([headRef]) {
  if (!headRef) {
    console.log("::error title=checkPublishedEntries usage::node scripts/checkPublishedEntries.mjs <head-commit>");
    return 1;
  }
  const floor = parse(PUBLISHED_ENTRY_FLOOR);
  const tags = git(["tag", "-l", "v*"]).split("\n").map((t) => t.trim())
    .filter((t) => parse(t) && cmp(parse(t), floor) >= 0);
  const head = git(["show", `${headRef}:CHANGELOG.md`]);

  let checked = 0;
  let failed = 0;
  for (const tag of tags) {
    let tagChangelog;
    try {
      tagChangelog = git(["show", `${tag}:CHANGELOG.md`]);
    } catch {
      continue; // no CHANGELOG.md at that tag: nothing published to protect
    }
    const r = checkPublishedEntry(tagChangelog, head, tag);
    if (r.ok && r.skipped) continue;
    checked++;
    if (!r.ok) {
      failed++;
      console.log(`::error title=${r.title}::${r.message}`);
    }
  }
  console.log(`Published CHANGELOG entries checked against their tags: ${checked} (tags >= v${PUBLISHED_ENTRY_FLOOR}); violations: ${failed}.`);
  return failed ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
