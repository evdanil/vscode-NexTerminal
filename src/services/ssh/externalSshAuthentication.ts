import { utils, type AnyAuthMethod, type ConnectConfig, type KeyboardInteractiveAuthMethod } from "ssh2";
import type { ResolvedExternalCredential } from "../credentials/contracts";
import { CredentialProviderError } from "../credentials/credentialProviderError";

export interface ExternalSshAuthentication {
  connectOptions: Pick<ConnectConfig, "username" | "authHandler" | "tryKeyboard">;
  dispose(): void;
}

interface ExternalSshAuthenticationOptions {
  /** Reports refusal without throwing through the protocol callback. */
  onInteractionRequired?(): void;
}

/**
 * ssh2 parses a publickey method's raw bytes synchronously into its own key,
 * before the server's PK_OK and signature. No signing callback borrows our raw
 * buffer, so disposal cannot interrupt signing. ssh2's parsed key/password
 * copies can survive until connection disposal; this is not memory erasure.
 */
class ExternalAuthentication implements ExternalSshAuthentication {
  public readonly connectOptions: ExternalSshAuthentication["connectOptions"];
  private username: string;
  private password: string | undefined;
  private privateKey: Buffer | undefined;
  private offered = false;
  private keyboardOffered = false;
  private prompted = false;
  private stopped = false;
  private onInteractionRequired: (() => void) | undefined;

  public constructor(credential: ResolvedExternalCredential, options: ExternalSshAuthenticationOptions) {
    this.onInteractionRequired = options.onInteractionRequired;
    this.username = credential.username;
    if (credential.method === "password") {
      this.password = credential.password;
    } else {
      // Resolver values are borrowed and can be zeroed before abort listeners.
      this.privateKey = Buffer.from(credential.privateKey);
      try {
        const parsed = utils.parseKey(this.privateKey);
        const keys = Array.isArray(parsed) ? parsed : [parsed];
        if (keys.length !== 1 || keys.some((key) => key instanceof Error || !key.isPrivateKey())) throw new Error();
      } catch {
        this.privateKey.fill(0);
        this.privateKey = undefined;
        this.username = "";
        throw new CredentialProviderError("invalid-response");
      }
    }
    this.connectOptions = {
      username: this.username,
      tryKeyboard: credential.method === "password",
      authHandler: (methods, partial): AnyAuthMethod | false => this.next(methods, partial)
    };
  }

  private next(methods: string[] | null, partial: boolean | null): AnyAuthMethod | false {
    if (this.stopped) return false;
    if (partial) { this.stopped = true; return false; }
    if (!this.offered) {
      this.offered = true;
      if (this.privateKey) return { type: "publickey", username: this.username, key: this.privateKey };
      if (this.password !== undefined) return { type: "password", username: this.username, password: this.password };
    } else if (this.password !== undefined && !this.keyboardOffered && methods?.includes("keyboard-interactive")) {
      this.keyboardOffered = true;
      return { type: "keyboard-interactive", username: this.username, prompt: this.prompt };
    }
    this.stopped = true;
    return false;
  }

  private readonly prompt: KeyboardInteractiveAuthMethod["prompt"] = (_name, _instructions, _lang, prompts, finish) => {
    const allowed = !this.stopped && !this.prompted && this.password !== undefined && prompts.length === 1 &&
      prompts[0].echo === false && /^(?:password|[^\s:]+(?:'s) password):?\s*$/iu.test(prompts[0].prompt.trim());
    this.prompted = true;
    finish(allowed ? [this.password!] : []);
    if (!allowed && !this.stopped) this.onInteractionRequired?.();
  };

  public dispose(): void {
    this.stopped = true;
    this.password = undefined;
    this.username = "";
    this.privateKey?.fill(0);
    this.privateKey = undefined;
    this.onInteractionRequired = undefined;
    this.connectOptions.username = undefined;
  }
}

export function createExternalSshAuthentication(
  credential: ResolvedExternalCredential,
  options: ExternalSshAuthenticationOptions = {}
): ExternalSshAuthentication {
  return new ExternalAuthentication(credential, options);
}
