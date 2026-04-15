import * as vscode from "vscode";
import type { NexusCore } from "../../core/nexusCore";
import type { ActiveSession, ActiveSerialSession } from "../../models/config";

export interface ScriptTargetDescriptor {
  displayName: string;
  targetType?: "ssh" | "serial";
  targetProfile?: string;
}

interface SessionPickItem extends vscode.QuickPickItem {
  sessionId: string;
  targetKind: "ssh" | "serial";
}

/**
 * Resolve which active session a script should bind to.
 *
 * Order of resolution:
 *   1. Filter candidates by `descriptor.targetType` (ssh | serial | undefined = both).
 *   2. If **no candidates match** after filtering, show an informative error message
 *      (prior behaviour was a silent `undefined` return, which made "Run" appear to
 *      do nothing at all).
 *   3. If `descriptor.targetProfile` is set:
 *        a. Match by profile/server **id** first (exact match → auto-pick).
 *        b. Then match by profile/server **name**.
 *           - If exactly one session matches the name → auto-pick it.
 *           - If multiple sessions match the same name (servers / profiles can share names) →
 *             show the QuickPick narrowed to those ambiguous matches rather than silently
 *             picking the first. This avoids the "wrong router" surprise.
 *           - If no sessions match the name → fall through to the full candidate picker.
 *   4. Otherwise present a QuickPick — always, even with a single candidate. Showing
 *      the picker confirms to the user WHICH terminal the script will drive, which is
 *      the overwhelming UX complaint when multiple are open. When exactly one session
 *      is available, the picker renders a single pre-selected row and one Enter
 *      confirms the choice.
 *   5. Returns `undefined` if no candidates exist or the user cancels.
 */
export async function pickTarget(
  descriptor: ScriptTargetDescriptor,
  core: Pick<NexusCore, "getSnapshot">
): Promise<ActiveSession | ActiveSerialSession | undefined> {
  const snapshot = core.getSnapshot();
  const wantSsh = descriptor.targetType !== "serial";
  const wantSerial = descriptor.targetType !== "ssh";

  const sshCandidates: Array<{ session: ActiveSession; serverId: string; serverName: string; label: string; description: string }> = wantSsh
    ? snapshot.activeSessions.map((s) => {
        const serverName = snapshot.servers.find((srv) => srv.id === s.serverId)?.name ?? s.serverId;
        return {
          session: s,
          serverId: s.serverId,
          serverName,
          label: s.terminalName,
          description: `SSH • ${serverName}`
        };
      })
    : [];

  const serialCandidates: Array<{
    session: ActiveSerialSession;
    profileId: string;
    profileName: string;
    label: string;
    description: string;
  }> = wantSerial
    ? snapshot.activeSerialSessions.map((s) => {
        const profileName = snapshot.serialProfiles.find((p) => p.id === s.profileId)?.name ?? s.profileId;
        return {
          session: s,
          profileId: s.profileId,
          profileName,
          label: s.terminalName,
          description: `Serial • ${profileName}`
        };
      })
    : [];

  // Try profile pre-select before showing the picker.
  if (descriptor.targetProfile) {
    // Match by id first (unambiguous — servers / profiles can share names but ids are unique).
    const sshById = sshCandidates.find((c) => c.serverId === descriptor.targetProfile);
    if (sshById) return sshById.session;
    const serialById = serialCandidates.find((c) => c.profileId === descriptor.targetProfile);
    if (serialById) return serialById.session;

    // Fall back to name — collect *all* matches. If exactly one, auto-pick; otherwise show
    // a narrowed QuickPick so the user can disambiguate.
    const sshByName = sshCandidates.filter((c) => c.serverName === descriptor.targetProfile);
    const serialByName = serialCandidates.filter((c) => c.profileName === descriptor.targetProfile);
    const nameMatches = sshByName.length + serialByName.length;
    if (nameMatches === 1) {
      return (sshByName[0]?.session ?? serialByName[0]?.session) as ActiveSession | ActiveSerialSession;
    }
    if (nameMatches > 1) {
      const narrowed: Array<SessionPickItem & { session: ActiveSession | ActiveSerialSession }> = [
        ...sshByName.map((c) => ({
          label: c.label,
          description: c.description,
          sessionId: c.session.id,
          targetKind: "ssh" as const,
          session: c.session
        })),
        ...serialByName.map((c) => ({
          label: c.label,
          description: c.description,
          sessionId: c.session.id,
          targetKind: "serial" as const,
          session: c.session
        }))
      ];
      const picked = (await vscode.window.showQuickPick(narrowed, {
        placeHolder: `Multiple sessions match "${descriptor.targetProfile}" — choose one`,
        matchOnDescription: true
      })) as (SessionPickItem & { session: ActiveSession | ActiveSerialSession }) | undefined;
      return picked?.session;
    }
    // No matches — fall through to the full candidate picker.
  }

  const combined: Array<SessionPickItem & { session: ActiveSession | ActiveSerialSession }> = [
    ...sshCandidates.map((c) => ({
      label: c.label,
      description: c.description,
      sessionId: c.session.id,
      targetKind: "ssh" as const,
      session: c.session
    })),
    ...serialCandidates.map((c) => ({
      label: c.label,
      description: c.description,
      sessionId: c.session.id,
      targetKind: "serial" as const,
      session: c.session
    }))
  ];

  if (combined.length === 0) {
    const kind = descriptor.targetType ?? "SSH or Serial";
    const friendly = descriptor.targetType === "ssh" ? "SSH" : descriptor.targetType === "serial" ? "Serial" : kind;
    void vscode.window.showErrorMessage(
      `No active ${friendly} sessions. Connect to one from the Connectivity Hub, then run the script again.`
    );
    return undefined;
  }

  const picked = (await vscode.window.showQuickPick(combined, {
    placeHolder: `Run "${descriptor.displayName}" against which session?`,
    matchOnDescription: true
  })) as (SessionPickItem & { session: ActiveSession | ActiveSerialSession }) | undefined;
  return picked?.session;
}
