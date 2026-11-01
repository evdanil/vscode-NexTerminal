import { spawn } from "node:child_process";
import * as path from "node:path";

/** Start Explorer with one quoted item so commas and metacharacters stay in its path. */
export async function revealInWindowsExplorer(
  scriptPath: string,
  systemRoot = process.env.SystemRoot,
  start: typeof spawn = spawn
): Promise<void> {
  const isFullyQualified = (value: string): boolean => {
    const root = path.win32.parse(value).root;
    return path.win32.isAbsolute(value) && root !== "\\" && root !== "/";
  };
  if (!systemRoot || !isFullyQualified(systemRoot) || /["\0\r\n]/.test(systemRoot) ||
      !isFullyQualified(scriptPath) || /["\0\r\n]/.test(scriptPath) || /[\\/]$/.test(scriptPath)) {
    throw new Error("Invalid local Windows script path or system directory.");
  }
  const executable = path.win32.join(systemRoot, "explorer.exe");
  const child = start(executable, [`/select,"${scriptPath}"`], {
    argv0: `"${executable}"`, detached: true, stdio: "ignore", windowsVerbatimArguments: true
  });
  await new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("spawn", () => { child.unref(); resolve(); });
  });
}
