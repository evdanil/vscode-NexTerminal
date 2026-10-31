import { isExternalAuthProfile, type AuthProfile } from "../models/authProfile";
import type { ServerConfig } from "../models/config";
import type { FormValues } from "./formTypes";

/** Also embedded verbatim in the webview, so browser validation preserves the same bytes. */
export function parseExternalArgumentsText(text: string): string[] {
  const args = text === "" ? [] : text.split("\n");
  if (args.length > 32 || args.some((arg) => arg.length === 0 || arg !== arg.trim() || /[\0\r\n]/u.test(arg) || new TextEncoder().encode(arg).byteLength > 4096)) {
    throw new Error("Use at most 32 nonempty lines, each at most 4096 UTF-8 bytes, with no leading/trailing whitespace or control line breaks.");
  }
  return args;
}

/** External profiles leave lookup usernames editable but own the hidden credential controls. */
export function externalServerFormValues(values: FormValues, profile: AuthProfile | undefined, existing?: Pick<ServerConfig, "username" | "authType" | "keyPath">): FormValues {
  if (!isExternalAuthProfile(profile)) return values;
  return { ...values, authType: existing?.authType ?? "password", keyPath: existing?.keyPath };
}

