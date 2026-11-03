export interface TranscriptPathContext {
  sessionName: string;
  host?: string;
  port?: string | number;
  group?: string;
}

type Part = { literal: string } | { token: string; environment?: true };
const SHORT_TOKENS = new Set(["H", "S", "G", "P", "Y", "M", "D", "h", "m", "s", "t"]);
const INVALID_COMPONENT = /[<>:"/\\|?*\p{Cc}\u2028\u2029\u202a-\u202e\u2066-\u2069]/gu;
const RESERVED_DEVICE = /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i;
const encoder = new TextEncoder();

function parse(template: string): Part[] {
  if (template.length > 4096) throw new Error("Keep the path template under 4096 characters.");
  const parts: Part[] = [];
  for (let i = 0; i < template.length;) {
    if (template[i] !== "%") {
      const end = template.indexOf("%", i);
      const next = end === -1 ? template.length : end;
      parts.push({ literal: template.slice(i, next) });
      i = next;
    } else if (template[i + 1] === "%") {
      parts.push({ literal: "%" });
      i += 2;
    } else {
      const environment = /^%([A-Za-z_][A-Za-z0-9_]*)%/.exec(template.slice(i));
      if (environment && (environment[1].length > 1 || !SHORT_TOKENS.has(environment[1]))) {
        parts.push({ token: environment[1], environment: true });
        i += environment[0].length;
      } else if (SHORT_TOKENS.has(template[i + 1])) {
        parts.push({ token: template[i + 1] });
        i += 2;
      } else {
        throw new Error("Unknown or unfinished percent token. Use a supported token or %% for a literal percent.");
      }
    }
  }
  return parts;
}

/** Substitutions are data, never path syntax; group segments call this separately. */
function component(value: string): string {
  const cleaned = value.replace(INVALID_COMPONENT, "_").replace(/[. ]+$/g, "");
  let bounded = "";
  let bytes = 0;
  for (const character of cleaned) {
    const size = encoder.encode(character).length;
    if (bytes + size > 120) break;
    bounded += character;
    bytes += size;
  }
  if (!bounded || bounded === "." || bounded === "..") return "_";
  return RESERVED_DEVICE.test(bounded) ? `_${bounded}` : bounded;
}

/** Shared by grammar validation and the host allocator; has no Node imports. */
export function normalizeTranscriptRelativePath(value: string, allowEmptyGroupPrefix = false): string {
  if ((!allowEmptyGroupPrefix && /^[\\/]/.test(value)) || /^[A-Za-z]:/.test(value)) {
    throw new Error("Use a relative path; set the root in Session Log Directory.");
  }
  if (!value || /[\\/]$/.test(value)) throw new Error("Include a filename ending in .log.");
  const segments = value.split(/[\\/]/).filter(Boolean);
  for (const segment of segments) {
    if (segment === "." || segment === "..") throw new Error("Remove . and .. path segments.");
    if (segment.replace(INVALID_COMPONENT, "_") !== segment || /[. ]$/.test(segment) || RESERVED_DEVICE.test(segment)) {
      throw new Error("Use portable filename characters; avoid reserved Windows device names and trailing dots/spaces.");
    }
    if (encoder.encode(segment).length > 240) throw new Error("Keep each filename or folder component under 241 UTF-8 bytes.");
  }
  if (!segments.length || !/\.log$/i.test(segments[segments.length - 1])) {
    throw new Error("End the filename in .log, for example %S.log.");
  }
  return segments.join("/");
}

export function validateTranscriptPathTemplate(template: string): string | undefined {
  if (!template) return undefined;
  try {
    const parts = parse(template);
    normalizeTranscriptRelativePath(parts.map((part) => "literal" in part ? part.literal : "_").join(""));
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

export function renderTranscriptPathTemplate(
  template: string,
  context: TranscriptPathContext,
  now: Date,
  environment: Readonly<Record<string, string | undefined>>
): string {
  const error = validateTranscriptPathTemplate(template);
  if (error) throw new Error(error);
  const pad = (value: number, length = 2): string => String(value).padStart(length, "0");
  const values: Record<string, string> = {
    H: component(context.host || "unknown-host"), S: component(context.sessionName),
    P: component(String(context.port || "auto")),
    G: (context.group ?? "").split(/[\\/]/).filter(Boolean).map(component).join("/"),
    Y: pad(now.getFullYear(), 4), M: pad(now.getMonth() + 1), D: pad(now.getDate()),
    h: pad(now.getHours()), m: pad(now.getMinutes()), s: pad(now.getSeconds()), t: pad(now.getMilliseconds(), 3)
  };
  const result = parse(template).map((part) => {
    if ("literal" in part) return part.literal;
    if (!part.environment) return values[part.token];
    const value = environment[part.token];
    if (!value) throw new Error(`Environment variable ${part.token} is missing or empty.`);
    return component(value);
  }).join("");
  // Syntax was checked before substitution; only an empty group can add leading separators.
  return normalizeTranscriptRelativePath(result, true);
}

/** Directory roots have no session context; preserve existing unmatched percent literals. */
export function expandLogDirectoryEnvironment(value: string, environment: Readonly<Record<string, string | undefined>>): string {
  return value.replace(/%%|%([A-Za-z_][A-Za-z0-9_]*)%/g, (match, name: string | undefined) => {
    if (match === "%%") return "%";
    const replacement = name === undefined ? undefined : environment[name];
    if (!replacement) throw new Error(`Environment variable ${name} is missing or empty.`);
    return replacement;
  });
}
