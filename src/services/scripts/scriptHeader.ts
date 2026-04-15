export interface ScriptHeader {
  marker: boolean;
  name?: string;
  description?: string;
  targetType?: "ssh" | "serial";
  targetProfile?: string;
  defaultTimeoutMs?: number;
  lockInput: boolean;
  allowMacros: string[];
  parseErrors: string[];
  warnings: string[];
}

const KNOWN_TAGS = new Set([
  "@nexus-script",
  "@name",
  "@description",
  "@target-type",
  "@target-profile",
  "@default-timeout",
  "@lock-input",
  "@allow-macros"
]);

const DURATION_RE = /^(\d+)\s*(ms|s|m)$/i;

function parseDuration(value: string): number | undefined {
  const m = value.trim().match(DURATION_RE);
  if (!m) return undefined;
  const n = Number(m[1]);
  const unit = m[2].toLowerCase();
  if (unit === "ms") return n;
  if (unit === "s") return n * 1_000;
  return n * 60_000;
}

function findLeadingJsDoc(source: string): string | null {
  let i = 0;
  if (source.startsWith("#!")) {
    const eol = source.indexOf("\n", 2);
    if (eol < 0) return null;
    i = eol + 1;
  }
  while (i < source.length && /\s/.test(source[i])) i++;
  if (source.slice(i, i + 3) !== "/**") return null;
  const end = source.indexOf("*/", i + 3);
  if (end < 0) return null;
  return source.slice(i + 3, end);
}

export function parseScriptHeader(source: string): ScriptHeader {
  const header: ScriptHeader = {
    marker: false,
    lockInput: false,
    allowMacros: [],
    parseErrors: [],
    warnings: []
  };

  const body = findLeadingJsDoc(source);
  if (!body) return header;

  const seen = new Set<string>();
  const lines = body
    .split("\n")
    .map((l) => l.replace(/^\s*\*\s?/, "").trimEnd());

  for (const raw of lines) {
    if (!raw.startsWith("@")) continue;

    const spaceIdx = raw.indexOf(" ");
    const tag = (spaceIdx === -1 ? raw : raw.slice(0, spaceIdx)).trim();
    const value = (spaceIdx === -1 ? "" : raw.slice(spaceIdx + 1)).trim();

    if (seen.has(tag) && tag !== "@allow-macros") {
      header.warnings.push(`duplicate field ${tag}; keeping first occurrence`);
      continue;
    }
    seen.add(tag);

    if (!KNOWN_TAGS.has(tag)) {
      header.warnings.push(`unknown tag ${tag}`);
      continue;
    }

    switch (tag) {
      case "@nexus-script":
        header.marker = true;
        break;
      case "@name":
        header.name = value;
        break;
      case "@description":
        header.description = value;
        break;
      case "@target-type": {
        const normalized = value.toLowerCase();
        if (normalized !== "ssh" && normalized !== "serial") {
          header.parseErrors.push(`@target-type must be "ssh" or "serial", got "${value}"`);
          break;
        }
        header.targetType = normalized;
        break;
      }
      case "@target-profile":
        header.targetProfile = value;
        break;
      case "@default-timeout": {
        const ms = parseDuration(value);
        if (ms === undefined) {
          header.parseErrors.push(`@default-timeout must be a duration like 30s, 5m, 1500ms; got "${value}"`);
          break;
        }
        header.defaultTimeoutMs = ms;
        break;
      }
      case "@lock-input":
        header.lockInput = true;
        break;
      case "@allow-macros":
        header.allowMacros = value
          .split(",")
          .map((s) => s.trim())
          .filter((s) => s.length > 0);
        break;
    }
  }

  return header;
}
