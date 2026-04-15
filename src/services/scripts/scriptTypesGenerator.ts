import * as vscode from "vscode";

/**
 * Version marker written at the top of the generated `.d.ts` so the generator can
 * detect an older bundled copy in a user's workspace and overwrite it on upgrade.
 * Bump this string whenever contracts/script-api.d.ts changes shape in a way users
 * should pick up immediately.
 */
export const BUNDLED_DTS_VERSION_HEADER = "// Nexus Scripts API types — v1";

export interface BundledAssets {
  dts: string;
  jsconfig: string;
}

export type BundledAssetLoader = () => Promise<BundledAssets>;

/**
 * Ensure the workspace has the .d.ts + jsconfig.json scaffolding that powers
 * IntelliSense for Nexus scripts.
 *
 * Writes are idempotent — subsequent invocations compare existing content against
 * the bundled asset and only rewrite when the version-header line differs (for
 * the .d.ts) or the file is missing entirely.
 */
export async function ensureWorkspaceScriptTypes(
  workspaceRoot: vscode.Uri | undefined,
  scriptsPath: string,
  loadAssets: BundledAssetLoader
): Promise<void> {
  if (!workspaceRoot) return;
  const { dts, jsconfig } = await loadAssets();

  const scriptsDir = vscode.Uri.joinPath(workspaceRoot, scriptsPath);
  const typesDir = vscode.Uri.joinPath(scriptsDir, "types");
  const dtsUri = vscode.Uri.joinPath(typesDir, "nexus-scripts.d.ts");
  const jsconfigUri = vscode.Uri.joinPath(scriptsDir, "jsconfig.json");

  await vscode.workspace.fs.createDirectory(scriptsDir);
  await vscode.workspace.fs.createDirectory(typesDir);

  await writeIfChanged(dtsUri, dts, (existing) => {
    const firstLine = existing.split(/\r?\n/, 1)[0];
    return firstLine.trim() !== BUNDLED_DTS_VERSION_HEADER.trim();
  });

  await writeIfChanged(jsconfigUri, jsconfig, (existing) => existing.trim() !== jsconfig.trim());
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
