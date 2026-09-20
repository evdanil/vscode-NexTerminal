/**
 * The http/https whitelist every browser handoff in the extension passes —
 * `runIn: "browser"` macros, the BMC web console, the inventory web console —
 * following `resolveBrowserUrl` (utils/tunnelProfile.ts) exactly: the scheme is
 * parsed off a real URL parse, never a prefix match. Returns the URL to open, or
 * `undefined` for anything that is not an http(s) URL: `javascript:`, `file:`,
 * `vscode:` and a bare `10.0.0.1` all land there.
 *
 * IT LIVES IN A LEAF MODULE, and that placement is load-bearing rather than
 * tidiness. It used to live in `commands/serverMacroCommands`, whose import
 * graph reaches the tree-item classes — so a command module that wanted only
 * this ten-line check dragged `vscode.TreeItem` and friends in with it, and
 * every unit test that mocks `vscode` with the narrow surface ITS module needs
 * failed to load. A shared guard has to be cheap to import, or callers write
 * their own second version of it.
 *
 * The name keeps its macro-era spelling: it is referenced by that name across
 * the docs and the profile-token error paths, and renaming it would buy nothing
 * the move did not already buy.
 */
export function resolveMacroBrowserUrl(text: string): string | undefined {
  const trimmed = text.trim();
  if (!trimmed) {
    return undefined;
  }
  try {
    const scheme = new URL(trimmed).protocol.replace(/:$/, "");
    if (scheme === "http" || scheme === "https") {
      return trimmed;
    }
  } catch {
    // malformed URL — not openable
  }
  return undefined;
}
