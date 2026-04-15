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
 *   2. If `descriptor.targetProfile` names a server/profile whose session is currently active, auto-pick it.
 *   3. If exactly one candidate remains, auto-pick it.
 *   4. Otherwise present a QuickPick.
 *   5. Returns `undefined` if no candidates exist or the user cancels.
 */
export async function pickTarget(
  descriptor: ScriptTargetDescriptor,
  core: Pick<NexusCore, "getSnapshot">
): Promise<ActiveSession | ActiveSerialSession | undefined> {
  const snapshot = core.getSnapshot();
  const wantSsh = descriptor.targetType !== "serial";
  const wantSerial = descriptor.targetType !== "ssh";

  const sshCandidates: Array<{ session: ActiveSession; label: string; description: string }> = wantSsh
    ? snapshot.activeSessions.map((s) => {
        const serverName = snapshot.servers.find((srv) => srv.id === s.serverId)?.name ?? s.serverId;
        return {
          session: s,
          label: s.terminalName,
          description: `SSH • ${serverName}`
        };
      })
    : [];

  const serialCandidates: Array<{
    session: ActiveSerialSession;
    profileName: string;
    label: string;
    description: string;
  }> = wantSerial
    ? snapshot.activeSerialSessions.map((s) => {
        const profileName = snapshot.serialProfiles.find((p) => p.id === s.profileId)?.name ?? s.profileId;
        return {
          session: s,
          profileName,
          label: s.terminalName,
          description: `Serial • ${profileName}`
        };
      })
    : [];

  // Try profile pre-select before showing the picker.
  if (descriptor.targetProfile) {
    const sshMatch = sshCandidates.find((c) => {
      const srv = snapshot.servers.find((s) => s.id === c.session.serverId);
      return srv?.name === descriptor.targetProfile;
    });
    if (sshMatch) return sshMatch.session;
    const serialMatch = serialCandidates.find((c) => c.profileName === descriptor.targetProfile);
    if (serialMatch) return serialMatch.session;
    // Fall through: profile not active, user picks manually.
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

  if (combined.length === 0) return undefined;
  if (combined.length === 1) return combined[0].session;

  const picked = (await vscode.window.showQuickPick(combined, {
    placeHolder: `Run "${descriptor.displayName}" against which session?`,
    matchOnDescription: true
  })) as (SessionPickItem & { session: ActiveSession | ActiveSerialSession }) | undefined;
  return picked?.session;
}
