import type { NexusCore } from "../../core/nexusCore";
import { createVscodeExternalCredentialApproval } from "../credentials/vscodeExternalCredentialApproval";
import { createExternalCredentialResolver } from "../credentials/externalCredentialResolver";
import { createExternalCredentialProcessRunner } from "../credentials/externalCredentialProcess";
import { parseExternalCredentialResponse } from "../credentials/externalCredentialProtocol";
import type { PasswordPrompt, SecretVault, SshConnector } from "./contracts";
import { SilentAuthSshFactory, type InputPromptFn } from "./silentAuth";
import { watchPoolInvalidationOnConfigMutation } from "./poolConfigInvalidation";
import { createSshTransportStack, type SshTransportStackOptions } from "./sshTransportStack";

/** Native host composition. No consumer can connect before its mutation fence exists. */
export function createSshCredentialRuntime(options: {
  core: NexusCore;
  vault: SecretVault;
  connector: SshConnector;
  passwordPrompt: PasswordPrompt;
  inputPrompt: InputPromptFn;
  transport: Omit<SshTransportStackOptions, "serverLookup" | "vault">;
  proxySecrets: Parameters<typeof watchPoolInvalidationOnConfigMutation>[2];
}) {
  const { core, vault } = options;
  const externalCredentialResolver = createExternalCredentialResolver({
    approvals: createVscodeExternalCredentialApproval(),
    run: createExternalCredentialProcessRunner(),
    parse: parseExternalCredentialResponse
  });
  const authFactory = new SilentAuthSshFactory(
    options.connector, vault, options.passwordPrompt, options.inputPrompt,
    (id) => core.getAuthProfile(id), (id) => core.getServer(id), externalCredentialResolver
  );
  const transport = createSshTransportStack(authFactory, {
    ...options.transport, serverLookup: (id) => core.getServer(id), vault
  });
  // This is the only ordinary mutation subscriber: it cancels stale attempts
  // synchronously before persistence and retires pools on edits or explicit revoke.
  const stopWatching = watchPoolInvalidationOnConfigMutation(core, transport.pool, options.proxySecrets, externalCredentialResolver);
  return {
    ...transport,
    externalCredentialResolver,
    revokeExternalCredentialApprovals: (ids?: readonly string[]): void => externalCredentialResolver.revoke(ids),
    dispose(): void {
      stopWatching();
      // Resolver disposal also retires the native disclosure and its command handlers.
      externalCredentialResolver.dispose();
      // Transport shutdown remains owned by activation: tunnels must release their
      // cross-window reservations before the pool is disposed.
    }
  };
}
