/**
 * Escapes a string for safe use inside a POSIX single-quoted shell argument.
 * Rejects NUL, CR, and LF which could truncate or split the argument.
 *
 * Used for constructing commands sent via SSH channel exec (SshConnection.exec),
 * NOT for local child_process invocation.
 */
export function shellEscape(s: string): string {
  if (s.includes("\0") || s.includes("\r") || s.includes("\n")) {
    throw new Error("Path contains invalid characters (NUL, CR, or LF)");
  }
  return "'" + s.replace(/'/g, "'\\''") + "'";
}
