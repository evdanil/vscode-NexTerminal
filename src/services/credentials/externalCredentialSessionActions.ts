import type { ExternalCredentialResolver } from "./contracts";

export const EXTERNAL_APPROVALS_REVOKED = "External credential approvals revoked for this session. Existing connections remain open; new authentication requires approval.";
export function revokeExternalApprovals(resolver: Pick<ExternalCredentialResolver, "revoke"> | undefined): string {
  if (!resolver) return "External credential approvals are unavailable in this extension host.";
  resolver.revoke();
  return EXTERNAL_APPROVALS_REVOKED;
}
