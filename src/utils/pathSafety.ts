import * as path from "node:path";

export function isSafeEntryName(name: string): boolean {
  return (
    name.length > 0 &&
    !name.includes("/") &&
    !name.includes("\\") &&
    !name.includes("\0") &&
    name !== "." &&
    name !== ".."
  );
}

export function joinRemoteEntryPath(parentPath: string, entryName: string): string | undefined {
  if (!isSafeEntryName(entryName)) {
    return undefined;
  }
  return path.posix.join(parentPath, entryName);
}
