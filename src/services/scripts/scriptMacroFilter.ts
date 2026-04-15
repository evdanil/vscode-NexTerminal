/**
 * Per-session policy that decides whether a macro is allowed to fire.
 *
 * - `defaultAllow`: policy when the macro is in neither list. Controlled by the
 *   `nexus.scripts.macroPolicy` setting ("suspend-all" → false, "keep-enabled" → true)
 *   and any explicit `macros.disableAll()` call from the script.
 * - `allowList`: macro names that fire even when `defaultAllow=false`.
 * - `denyList`: macro names that never fire, overriding `allowList`.
 *
 * Lookup is by macro name (lowercased, trimmed). Filters stack LIFO per session;
 * the top-of-stack filter wins.
 */
export interface ScriptMacroFilterInit {
  defaultAllow: boolean;
  allowList: readonly string[];
  denyList: readonly string[];
}

export class ScriptMacroFilter {
  public defaultAllow: boolean;
  public readonly allowList: Set<string>;
  public readonly denyList: Set<string>;

  public constructor(init: ScriptMacroFilterInit) {
    this.defaultAllow = init.defaultAllow;
    this.allowList = new Set(init.allowList.map(normalize));
    this.denyList = new Set(init.denyList.map(normalize));
  }

  public isAllowed(macroName: string): boolean {
    const key = normalize(macroName);
    if (this.denyList.has(key)) return false;
    if (this.allowList.has(key)) return true;
    return this.defaultAllow;
  }

  public allow(name: string | string[]): void {
    for (const n of asArray(name)) this.allowList.add(normalize(n));
  }

  public deny(name: string | string[]): void {
    for (const n of asArray(name)) this.denyList.add(normalize(n));
  }

  public clear(): void {
    this.allowList.clear();
    this.denyList.clear();
  }
}

function normalize(s: string): string {
  return s.trim().toLowerCase();
}

function asArray(v: string | string[]): string[] {
  return Array.isArray(v) ? v : [v];
}
