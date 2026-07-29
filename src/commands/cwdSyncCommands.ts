import * as vscode from "vscode";
import { extractLatestPromptPath } from "../services/terminal/promptPathHeuristic";
import { promptGoToPath } from "./fileCommands";
import type { CommandContext } from "./types";

/**
 * `globalState` key for the sticky Follow-Terminal-Directory toggle (§9 — Phase 1
 * ships zero settings; this lives in `globalState`, not `settings.json`). Restored
 * on activate and persisted by the `followTerminal` / `unfollowTerminal` commands.
 */
export const FOLLOW_TERMINAL_STATE_KEY = "nexus.ui.followTerminalDirectory";

/**
 * `globalState` key gating the one-time §8.4 discovery nudge shown after the
 * very first successful `nexus.files.syncFromTerminal` in this installation's
 * lifetime — never shown again either way (Follow / No Thanks).
 */
export const FIRST_SYNC_NUDGE_SHOWN_KEY = "nexus.files.followTerminalNudgeShown";

const FOLLOW_NUDGE_FOLLOW_ACTION = "Follow This Terminal";
const FOLLOW_NUDGE_DISMISS_ACTION = "No Thanks";

/**
 * §8.5(a) genuine-incapability toast: fires at most once *per session*, tracked
 * in memory only (never a memento — a new session should get its own chance to
 * report a directory, e.g. after the user adds an OSC 7 prompt hook and
 * reconnects). Session ids are never reused across reconnects to a different
 * host in a way that would make this stale in a harmful direction: the worst
 * case is one fewer toast on a session that will show state 3 permanently
 * anyway (§8.5a).
 */
const noSourceToastShownSessions = new Set<string>();

interface FocusedSshSession {
  id: string;
  serverId: string;
  terminalName: string;
}

function log(ctx: CommandContext, message: string): void {
  ctx.cwdSyncOutputChannel?.appendLine(`[cwdSync] ${message}`);
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function resolveFocusedSshSession(ctx: CommandContext): FocusedSshSession | undefined {
  const snapshot = ctx.core.getSnapshot();
  const focusedSessionId = snapshot.focusedSessionId;
  if (!focusedSessionId) {
    return undefined;
  }
  return snapshot.activeSessions.find((session) => session.id === focusedSessionId);
}

/** Resolution ladder step 1 — a non-stale tracker record for the focused session. */
function getTrackedCandidate(ctx: CommandContext, session: FocusedSshSession): string | undefined {
  if (!ctx.cwdTracker) {
    return undefined;
  }
  const record = ctx.cwdTracker.getRecord(session.id);
  if (!record || record.serverId !== session.serverId) {
    return undefined;
  }
  const now = Date.now();
  const lastOutputAt = ctx.cwdLastOutputAt?.get(session.id);
  if (ctx.cwdTracker.isStale(session.id, now, lastOutputAt)) {
    return undefined;
  }
  return record.cwd;
}

/** Resolution ladder step 2 — the prompt-text heuristic against scrollback. */
function getHeuristicCandidate(ctx: CommandContext, session: FocusedSshSession): string | undefined {
  const terminal = ctx.sessionTerminals.get(session.id);
  const entry = terminal ? ctx.terminalRegistry?.get(terminal) : undefined;
  if (!entry) {
    return undefined;
  }
  return extractLatestPromptPath(entry.buffer.getText(), ctx.fileExplorerProvider.getHomeDir());
}

/**
 * Resolution ladder step 3 — validate `candidate` with `realpath` then a
 * directory `tryStat`. On success, clears any existing pin (`syncFromTerminal`
 * moves the explorer *toward* the terminal rather than pinning — §8.3) and
 * re-roots immediately (explicit navigation, so the watcher restarts right
 * away — never pass `{ restartWatcher: false }` here). Returns the resolved
 * path on success, `undefined` on any validation failure (logged, never thrown).
 *
 * Both SFTP calls are awaited, which gives the user (or a focus-driven
 * re-render) time to switch the focused session or the explorer's active
 * server before this resolves. Re-reading both immediately before the final
 * `setRootPath` call and discarding on any mismatch against what was
 * captured at entry closes that cross-server race — otherwise a slower
 * validation for session/server A can land on an explorer that has since
 * moved on to server B.
 */
async function validateAndApply(
  ctx: CommandContext,
  session: FocusedSshSession,
  candidate: string
): Promise<string | undefined> {
  const expectedSessionId = session.id;
  const expectedServerId = session.serverId;

  let resolved: string;
  try {
    resolved = await ctx.sftpService.realpath(session.serverId, candidate);
  } catch (err) {
    log(ctx, `syncFromTerminal: realpath(${session.serverId}, ${candidate}) failed: ${describeError(err)}`);
    return undefined;
  }

  let stat: { isDirectory: boolean } | undefined;
  try {
    stat = await ctx.sftpService.tryStat(session.serverId, resolved);
  } catch (err) {
    log(ctx, `syncFromTerminal: tryStat(${session.serverId}, ${resolved}) failed: ${describeError(err)}`);
    return undefined;
  }

  if (!stat || !stat.isDirectory) {
    log(ctx, `syncFromTerminal: resolved path is not a directory: ${resolved}`);
    return undefined;
  }

  // Re-check immediately before committing: both the focused session and the
  // explorer's active server must still match what was captured at entry.
  // A slower validation for a since-abandoned session/server pairing must
  // never land on an explorer that has since switched to a different server.
  const currentFocused = resolveFocusedSshSession(ctx);
  const currentActiveServerId = ctx.fileExplorerProvider.getActiveServerId();
  if (currentFocused?.id !== expectedSessionId || currentActiveServerId !== expectedServerId) {
    log(
      ctx,
      `syncFromTerminal: discarding stale validation for session ${expectedSessionId} — focused session or explorer server changed`
    );
    return undefined;
  }

  ctx.cwdSyncCoordinator?.clearPin();
  ctx.fileExplorerProvider.setRootPath(resolved);
  return resolved;
}

/**
 * §8.4 discovery nudge — fires once, ever, after the first successful sync
 * (automatic validation or the manual fallback box both count: from the
 * user's point of view, "Go to Terminal Directory" worked either way). Sets
 * the memento *before* awaiting the user's choice, mirroring the
 * `maybeWarnMacroKeybindingsBlocked` pattern in `extension.ts` — the toast
 * click IS the consent, no second modal.
 */
async function maybeShowFirstSyncNudge(ctx: CommandContext, resolvedPath: string): Promise<void> {
  if (ctx.globalState.get<boolean>(FIRST_SYNC_NUDGE_SHOWN_KEY, false)) {
    return;
  }
  void ctx.globalState.update(FIRST_SYNC_NUDGE_SHOWN_KEY, true);

  const choice = await vscode.window.showInformationMessage(
    `Synced the File Explorer to ${resolvedPath}. Keep it on this terminal's directory from now on?`,
    FOLLOW_NUDGE_FOLLOW_ACTION,
    FOLLOW_NUDGE_DISMISS_ACTION
  );
  if (choice === FOLLOW_NUDGE_FOLLOW_ACTION) {
    ctx.cwdSyncCoordinator?.setFollowing(true);
    ctx.cwdSyncCoordinator?.clearPin();
    void ctx.globalState.update(FOLLOW_TERMINAL_STATE_KEY, true);
  }
}

async function showNoSourceToastOnce(ctx: CommandContext, session: FocusedSshSession): Promise<void> {
  if (noSourceToastShownSessions.has(session.id)) {
    return;
  }
  noSourceToastShownSessions.add(session.id);
  const serverName = ctx.core.getServer(session.serverId)?.name ?? session.serverId;
  void vscode.window.showInformationMessage(
    `"${serverName}" didn't report a directory, so Nexus can't follow it. Directory sync is off for this session.`
  );
}

/**
 * `nexus.files.syncFromTerminal` — the resolution ladder (§8.5(a) inline
 * commentary walks the full flow):
 *  1. A non-stale tracker record for the focused SSH session, if its
 *     `serverId` matches the explorer's active server.
 *  2. Else the prompt-text heuristic against the focused terminal's scrollback.
 *  3. Validate whichever candidate step 1/2 produced; on success, re-root.
 *  4. On no candidate or failed validation, open the `goToPath` prompt
 *     prefilled with the best candidate we have (or the current root, matching
 *     `goToPath`'s own bare-invocation default) rather than dead-ending.
 *  5. If that also yields nothing, show the once-per-session incapability
 *     toast (§8.5a).
 */
async function syncFromTerminal(ctx: CommandContext): Promise<void> {
  const activeServerId = ctx.fileExplorerProvider.getActiveServerId();
  if (!activeServerId) {
    log(ctx, "syncFromTerminal: no active File Explorer server");
    return;
  }

  const session = resolveFocusedSshSession(ctx);
  if (!session || session.serverId !== activeServerId) {
    log(ctx, "syncFromTerminal: no focused SSH session for the active explorer server");
    return;
  }

  const candidate = getTrackedCandidate(ctx, session) ?? getHeuristicCandidate(ctx, session);

  if (candidate) {
    const resolved = await validateAndApply(ctx, session, candidate);
    if (resolved) {
      await maybeShowFirstSyncNudge(ctx, resolved);
      return;
    }
  }

  const prefill = candidate ?? ctx.fileExplorerProvider.getRootPath() ?? "/";
  const resolvedViaPrompt = await promptGoToPath(ctx, prefill);
  if (resolvedViaPrompt) {
    await maybeShowFirstSyncNudge(ctx, resolvedViaPrompt);
    return;
  }

  await showNoSourceToastOnce(ctx, session);
}

/**
 * Registers the four Phase 1 directory-sync commands (§8.1). Follows the
 * `CommandContext`-based `registerXCommands(ctx): vscode.Disposable[]` shape
 * used across the command modules (`serverCommands.ts`, `fileCommands.ts`,
 * `terminalTabCommands.ts`'s resolver-helper style).
 */
export function registerCwdSyncCommands(ctx: CommandContext): vscode.Disposable[] {
  const followTerminal = vscode.commands.registerCommand("nexus.files.followTerminal", () => {
    if (!ctx.cwdSyncCoordinator) {
      log(ctx, "followTerminal: no-op — directory sync is not available in this context");
      return;
    }
    ctx.cwdSyncCoordinator.setFollowing(true);
    ctx.cwdSyncCoordinator.clearPin();
    void ctx.globalState.update(FOLLOW_TERMINAL_STATE_KEY, true);
  });

  const unfollowTerminal = vscode.commands.registerCommand("nexus.files.unfollowTerminal", () => {
    if (!ctx.cwdSyncCoordinator) {
      log(ctx, "unfollowTerminal: no-op — directory sync is not available in this context");
      return;
    }
    ctx.cwdSyncCoordinator.setFollowing(false);
    void ctx.globalState.update(FOLLOW_TERMINAL_STATE_KEY, false);
  });

  const resumeFollowTerminal = vscode.commands.registerCommand("nexus.files.resumeFollowTerminal", () => {
    if (!ctx.cwdSyncCoordinator) {
      log(ctx, "resumeFollowTerminal: no-op — directory sync is not available in this context");
      return;
    }
    ctx.cwdSyncCoordinator.resume();
  });

  const syncFromTerminalCmd = vscode.commands.registerCommand("nexus.files.syncFromTerminal", async () => {
    await syncFromTerminal(ctx);
  });

  return [followTerminal, unfollowTerminal, resumeFollowTerminal, syncFromTerminalCmd];
}
