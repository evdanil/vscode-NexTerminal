import { randomUUID } from "node:crypto";
import type { ExternalAuthProfile, ExternalCredentialInvocation } from "../../models/authProfile";
import { EXTERNAL_CREDENTIAL_MAX_QUEUED } from "./contracts";
import { CredentialProviderError } from "./credentialProviderError";

export const EXTERNAL_CREDENTIAL_DISCLOSURE_SCHEME = "nexus-credential-invocation";
export const CONTINUE_EXTERNAL_APPROVAL = "nexus.authProfile.continueExternalApproval";
export const CANCEL_EXTERNAL_APPROVAL = "nexus.authProfile.cancelExternalApproval";
const EXPIRED = "External credential invocation review completed or expired.";
type Disposable = { dispose(): void };

/** Host adapter: public command arguments never enter this interface's authority path. */
export interface ExternalCredentialDisclosureHost {
  registerProvider(scheme: string, read: (uri: string) => string): Disposable;
  registerCommand(id: string, callback: () => unknown): Disposable;
  showDocument(uri: string): Promise<void>;
  activeDocument(): string | undefined;
  changed(uri: string): void;
  confirm(message: string, detail: string): Promise<string | undefined>;
  status(message: string): void;
  executionHost(): string;
}

/** Reversible literals prevent control/bidi characters from disguising argv boundaries. */
export function quoteExternalInvocation(value: string): string {
  return '"' + Array.from(value, (character) =>
    /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/u.test(character)
      ? `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`
      : JSON.stringify(character).slice(1, -1)).join("") + '"';
}

interface Pending {
  readonly text: string;
  readonly message: string;
  readonly detail: string;
  finish(allowed: boolean): void;
}

export function createExternalCredentialDisclosure(host: ExternalCredentialDisclosureHost): {
  confirm(profile: ExternalAuthProfile, signal: AbortSignal, example?: ExternalCredentialInvocation): Promise<boolean>;
  dispose(): void;
} {
  const pending = new Map<string, Pending>();
  let disposed = false;
  let modalOpen = false;
  const active = (): [string, Pending] | undefined => {
    const uri = host.activeDocument();
    const review = uri ? pending.get(uri) : undefined;
    if (!uri || !review) { host.status("Open an active External Credential Invocation to continue or cancel its review."); return; }
    return [uri, review];
  };
  const registrations = [
    host.registerProvider(EXTERNAL_CREDENTIAL_DISCLOSURE_SCHEME, (uri) => pending.get(uri)?.text ?? EXPIRED),
    host.registerCommand(CONTINUE_EXTERNAL_APPROVAL, async () => {
      const selected = active();
      if (!selected || modalOpen) return;
      const [uri, review] = selected;
      modalOpen = true;
      try {
        const answer = await host.confirm(review.message, review.detail);
        // Revocation/cancellation removes authority while a native modal cannot be dismissed.
        if (pending.get(uri) !== review) return;
        if (answer === "Back to Invocation") await host.showDocument(uri);
        else review.finish(answer === "Allow for This Session");
      } catch { review.finish(false); }
      finally { modalOpen = false; }
    }),
    host.registerCommand(CANCEL_EXTERNAL_APPROVAL, () => { active()?.[1].finish(false); })
  ];
  return {
    async confirm(profile, signal, example) {
      if (disposed || signal.aborted || !profile.external.invocation) return false;
      const dynamic = profile.external.invocation.argumentExpansion === true;
      if (dynamic && !example) return false;
      // Admission for review is separate from process admission: no unbounded history or eviction.
      if (pending.size >= EXTERNAL_CREDENTIAL_MAX_QUEUED) throw new CredentialProviderError("queue-full");
      const reference = randomUUID();
      const uri = `${EXTERNAL_CREDENTIAL_DISCLOSURE_SCHEME}:/${reference}/External%20Credential%20Invocation`;
      const { executable, args } = profile.external.invocation;
      const argv = [...args, profile.external.method === "password" ? "--pass" : "--pkey"];
      const hostLabel = host.executionHost();
      const name = quoteExternalInvocation(profile.name);
      const consequences = [
        "This program runs with the extension-host user's privileges. It inherits the environment and can access files and the network on that machine.",
        "Approval covers this mutable program path and its dependencies; their contents are not cryptographically pinned.",
        ...(dynamic ? ["Approval covers this argument template for the session. Values can differ for future connections, including other servers."] : []),
        "Do not put secrets in arguments: they are saved in configuration. Approval lasts only for this extension-host session."
      ].join("\n");
      const text = [
        "Review the complete invocation below. This does not run the program or grant permission.",
        "When ready, run Nexus: Continue External Credential Approval from the Command Palette.",
        "To stop, run Nexus: Cancel External Credential Approval. Closing this tab does not grant permission.",
        "", `Profile: ${name}`, `Review reference: ${reference}`, `Execution machine: ${hostLabel}`,
        `Executable: ${quoteExternalInvocation(executable)}`, `Argument count: ${argv.length} (including the Nexus authentication flag)`,
        ...argv.map((arg, index) => `argv[${index}]: ${quoteExternalInvocation(arg)}`),
        ...(dynamic && example ? ["", "Example resolved invocation for this connection:",
          ...[...example.args, profile.external.method === "password" ? "--pass" : "--pkey"].map((arg, index) => `example argv[${index}]: ${quoteExternalInvocation(arg)}`)] : []),
        "", consequences
      ].join("\n");
      return new Promise<boolean>((resolve) => {
        const abort = (): void => review.finish(false);
        const review: Pending = {
          text,
          message: `Allow external credential program for ${name}?`,
          detail: `Review reference: ${reference}\nExecution machine: ${hostLabel}\nArgument count: ${argv.length}\n${dynamic ? "The template and one resolved example are in the read-only document just reviewed." : "The exact invocation is in the read-only document just reviewed."}\n\n${consequences}`,
          finish(allowed) {
            if (pending.get(uri) !== review) return;
            pending.delete(uri);
            signal.removeEventListener("abort", abort);
            host.changed(uri);
            resolve(!signal.aborted && !disposed && allowed);
          }
        };
        pending.set(uri, review);
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) { abort(); return; }
        void host.showDocument(uri).catch(() => review.finish(false));
      });
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const review of [...pending.values()]) review.finish(false);
      for (const registration of registrations) registration.dispose();
    }
  };
}
