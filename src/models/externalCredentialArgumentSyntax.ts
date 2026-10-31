/** Syntax only: values are checked separately against the connection at invocation.
 * Kept self-contained so the exact validator can run in the editor webview. */
export function validateExternalArgumentTemplates(args: readonly string[]): boolean {
  if (!Array.isArray(args)) return false;
  for (const arg of args) {
    if (typeof arg !== "string") return false;
    for (let i = 0; i < arg.length;) {
      const escaped = arg.startsWith("$${", i);
      if (escaped || arg.startsWith("${", i)) {
        const start = i + (escaped ? 3 : 2);
        const end = arg.indexOf("}", start);
        if (end < 0) return false;
        const name = arg.slice(start, end);
        if (!escaped && !["host", "port", "SessionName", "username", "profile", "protocol"].includes(name)) return false;
        i = end + 1;
      } else i++;
    }
  }
  return true;
}
