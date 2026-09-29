/**
 * Release-notes gate, shared by EVERY workflow that publishes a version.
 *
 * Unreleased changes accumulate in one CHANGELOG entry headed with the version
 * a release tags (AGENTS.md), so that entry IS the release notes: the GitHub
 * Release body (release.yml) and the CHANGELOG.md the Marketplace and Open VSX
 * show from the packaged VSIX. A release whose entry is missing, empty or only
 * section headings must publish NOTHING, anywhere.
 *
 * WHY ONE SCRIPT, RUN BY EACH PUBLISHER. A v* tag starts release.yml
 * (GitHub Release + Marketplace) and publish-openvsx.yml independently, in
 * parallel. If only release.yml checked the entry, Open VSX could publish an
 * immutable version while release.yml failed — and the failure message telling
 * the maintainer "nothing has been published" would be false. Each publisher
 * therefore runs this before its build and publish steps, against the same
 * checked-out commit, so they fail or pass together.
 *
 * Usage: node scripts/extractReleaseNotes.mjs <version> <outFile> [changelog]
 *   version    x.y.z, with or without a leading "v"
 *   outFile    where the entry is written (the GitHub Release body)
 *   changelog  defaults to CHANGELOG.md in the working directory
 * Prints the entry on success; prints a GitHub `::error` and exits 1 otherwise.
 */
import { readFileSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

// Up to three leading spaces, then 1-6 '#' and a space or end of line: a
// Markdown ATX heading ("### Fixed"). Anything else nonblank counts as notes.
const HEADING_RE = /^ {0,3}#{1,6}(\s|$)/;

// Accurate for every publisher only because every publisher runs this gate
// before publishing (see above). The tag may or may not exist yet: a tag push
// or auto-release creates it before the workflows run.
const remedy = (version) =>
  `Nothing has been published yet — every publishing workflow runs this check first. Fix the entry on main, then release again (if the v${version} tag was already pushed, delete it and tag again).`;

/**
 * Pure extraction: the CHANGELOG entry for `version`, from its "## [x.y.z]"
 * heading up to (not including) the next "## [" heading.
 *
 * @param {string} changelog  full CHANGELOG.md text
 * @param {string} version    x.y.z, with or without a leading "v"
 * @returns {{ ok: true, body: string } | { ok: false, title: string, message: string }}
 */
export function extractReleaseNotes(changelog, version) {
  const v = String(version).trim().replace(/^v/, "");
  const lines = changelog.split(/\r?\n/);
  // The whole version inside the brackets, so 2.8.29 never matches 2.8.295.
  const start = lines.findIndex((l) => l.startsWith(`## [${v}]`));
  if (start < 0) {
    return {
      ok: false,
      title: "No CHANGELOG entry",
      message: `CHANGELOG.md has no "## [${v}]" heading, so this release has no notes. ${remedy(v)}`
    };
  }
  let end = lines.findIndex((l, i) => i > start && l.startsWith("## ["));
  if (end < 0) end = lines.length;

  const content = lines.slice(start + 1, end).filter((l) => l.trim());
  if (content.length === 0) {
    return {
      ok: false,
      title: "Empty CHANGELOG entry",
      message: `The "## [${v}]" entry in CHANGELOG.md has no content, so this release has no notes. ${remedy(v)}`
    };
  }
  // Section headings alone ("### Fixed" with nothing under it) are not notes.
  // Only a release enforces this — the PR check does not, because the first
  // PR after a release may legitimately open the entry before it has anything
  // to say.
  if (content.every((l) => HEADING_RE.test(l))) {
    return {
      ok: false,
      title: "CHANGELOG entry has no notes",
      message: `The "## [${v}]" entry in CHANGELOG.md has section headings but no bullet or text under them, so this release has no notes. ${remedy(v)}`
    };
  }
  return { ok: true, body: lines.slice(start, end).join("\n").trim() };
}

function main(argv) {
  const [version, outFile, changelogPath = "CHANGELOG.md"] = argv;
  if (!version || !outFile) {
    console.log("::error title=extractReleaseNotes usage::node scripts/extractReleaseNotes.mjs <version> <outFile> [changelog]");
    return 1;
  }
  const result = extractReleaseNotes(readFileSync(changelogPath, "utf8"), version);
  if (!result.ok) {
    console.log(`::error title=${result.title}::${result.message}`);
    return 1;
  }
  writeFileSync(outFile, result.body + "\n");
  console.log(result.body);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
