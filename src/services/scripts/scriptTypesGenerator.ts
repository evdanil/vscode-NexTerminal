import * as vscode from "vscode";

/**
 * Version marker written at the top of the generated `.d.ts` so the generator can
 * detect an older bundled copy in a user's workspace and overwrite it on upgrade.
 * Bump this string whenever contracts/script-api.d.ts changes shape in a way users
 * should pick up immediately.
 */
export const BUNDLED_DTS_VERSION_HEADER = "// Nexus Scripts API types — v12";

export interface BundledAssets {
  dts: string;
  jsconfig: string;
}

export type BundledAssetLoader = () => Promise<BundledAssets>;

/**
 * Ensure the workspace has the .d.ts + jsconfig.json scaffolding that powers
 * IntelliSense for Nexus scripts.
 *
 * The two files are owned differently, so they are refreshed differently:
 *
 * - The `.d.ts` is Nexus's own: it is rewritten whenever its first line
 *   differs from BUNDLED_DTS_VERSION_HEADER, so a new API reaches every
 *   workspace on its next run.
 * - `jsconfig.json` is the user's once it exists, unless it is exactly a copy
 *   an earlier release wrote (SUPERSEDED_BUNDLED_JSCONFIGS), which is
 *   replaced. Users legitimately edit it (`paths`, an extra `lib`,
 *   `checkJs`), and `nexus.scripts.path` can point at a folder that already
 *   has its own; rewriting it whenever it differed silently reverted both on
 *   every run. A version marker would not fix that — it still clobbers a
 *   jsconfig.json Nexus never wrote, and relies on a JSONC comment the user
 *   must keep. Deleting the file brings the bundled copy back on the next run.
 */
export async function ensureWorkspaceScriptTypes(
  scriptsDir: vscode.Uri,
  loadAssets: BundledAssetLoader
): Promise<void> {
  const { dts, jsconfig } = await loadAssets();

  const typesDir = vscode.Uri.joinPath(scriptsDir, "types");
  const dtsUri = vscode.Uri.joinPath(typesDir, "nexus-scripts.d.ts");
  const jsconfigUri = vscode.Uri.joinPath(scriptsDir, "jsconfig.json");

  await vscode.workspace.fs.createDirectory(scriptsDir);
  await vscode.workspace.fs.createDirectory(typesDir);

  await writeIfChanged(dtsUri, dts, (existing) => {
    const firstLine = existing.split(/\r?\n/, 1)[0];
    return firstLine.trim() !== BUNDLED_DTS_VERSION_HEADER.trim();
  });

  await writeIfChanged(jsconfigUri, jsconfig, isSupersededBundledJsconfig);
}

/**
 * Every jsconfig.json an earlier release wrote, exactly as it shipped (git
 * history of assets/jsconfig.json): 2.8.0–2.8.1, then 2.8.2. A workspace still
 * holding one of these has Nexus's own copy, not a user's, and it is
 * replaced: 2.8.2 left the legacy "Node" module resolution, and 2.8.3 added
 * `moduleDetection: "force"`, without which every top-level `await` in a
 * script is TS1375. Any other content — including one of these with a single
 * edit — is the user's and is kept. When the bundled copy changes, add the
 * outgoing text here (scriptTypesGenerator.test.ts pins the current one).
 */
const SUPERSEDED_BUNDLED_JSCONFIGS = [
  `{
  "compilerOptions": {
    "checkJs": true,
    "target": "ES2022",
    "lib": ["ES2022"],
    "module": "ESNext",
    "moduleResolution": "Node",
    "types": ["./types/nexus-scripts"]
  },
  "include": ["**/*.js"],
  "exclude": ["node_modules"]
}`,
  `{
  "compilerOptions": {
    "checkJs": true,
    "target": "ES2022",
    "lib": ["ES2022"],
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "types": ["./types/nexus-scripts"]
  },
  "include": ["**/*.js"],
  "exclude": ["node_modules"]
}`
];

/** Line endings and surrounding whitespace aside — a checkout can turn LF into CRLF. */
function isSupersededBundledJsconfig(existing: string): boolean {
  const normalized = existing.replace(/\r\n/g, "\n").trim();
  return SUPERSEDED_BUNDLED_JSCONFIGS.some((shipped) => shipped === normalized);
}

async function writeIfChanged(
  uri: vscode.Uri,
  desired: string,
  shouldRewriteWhenPresent: (existing: string) => boolean
): Promise<void> {
  try {
    const existing = new TextDecoder("utf-8").decode(await vscode.workspace.fs.readFile(uri));
    if (!shouldRewriteWhenPresent(existing)) return;
  } catch {
    // File doesn't exist — write below.
  }
  await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(desired));
}
