import { validateExternalCredentialInvocation } from "../../models/authProfile";
import { CredentialProviderError } from "./credentialProviderError";

export interface ExternalCredentialArgumentContext {
  host: string;
  port: number;
  SessionName: string;
  username: string;
  profile: string;
  protocol: string;
}

/** Expands only the configured argument template, never the executable or a shell. */
export function expandExternalCredentialArguments(
  args: readonly string[], context: ExternalCredentialArgumentContext
): string[] {
  const invalid = (): never => { throw new CredentialProviderError("invalid-template"); };
  const valueFor = (name: string): string => {
    if (name === "port") {
      return Number.isInteger(context?.port) && context.port >= 1 && context.port <= 65535
        ? String(context.port) : invalid();
    }
    if (name !== "host" && name !== "SessionName" && name !== "username" && name !== "profile" && name !== "protocol") {
      return invalid();
    }
    const value: unknown = context?.[name];
    return typeof value === "string" && value.trim() !== "" ? value : invalid();
  };
  if (!Array.isArray(args) || args.length > 32) return invalid();
  const expanded = Array.from(args, (arg) => {
    if (typeof arg !== "string") return invalid();
    let output = "";
    for (let i = 0; i < arg.length;) {
      const escaped = arg.startsWith("$${", i);
      if (escaped || arg.startsWith("${", i)) {
        const start = i + (escaped ? 3 : 2);
        const end = arg.indexOf("}", start);
        if (end < 0) return invalid();
        const name = arg.slice(start, end);
        if (!escaped && !/^[A-Za-z][A-Za-z0-9]*$/u.test(name)) return invalid();
        output += escaped ? "${" + name + "}" : valueFor(name);
        i = end + 1;
      } else {
        output += arg[i++];
      }
    }
    return output;
  });
  // Apply the same byte/count/whitespace limits that the process runner uses.
  if (!validateExternalCredentialInvocation({ executable: "/credential-provider", args: expanded })) return invalid();
  return expanded;
}
