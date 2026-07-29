import * as vscode from "vscode";
import { extractLatestPromptPath } from "../services/terminal/promptPathHeuristic";
import { promptGoToPath } from "./fileCommands";
import { isTerminalArg } from "./terminalTabCommands";
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

/**
 * Bug-2 fix — "turning Follow on with no OSC 7 source says nothing useful".
 * Distinct from the §8.5(a) toast above: that one fires from
 * `syncFromTerminal`'s failure path after the *whole* resolution ladder
 * (tracker + heuristic + manual prompt) comes up empty; this one fires
 * directly off the Follow-on toggle, the moment the newly-following state
 * resolves to `noSource`, and offers two concrete next actions instead of
 * just naming the dead end.
 */
const NO_SOURCE_FOLLOW_SHOW_ME_HOW_ACTION = "Show Me How";
const NO_SOURCE_FOLLOW_GO_TO_TERMINAL_ACTION = "Go to Terminal Directory";

/**
 * In-memory only, keyed by server id, reset on every extension activation —
 * deliberately not a `globalState` memento. A user who adds the rc hook and
 * reconnects wants a fresh shot at seeing it work in the *same* window; a
 * fresh window/reload should offer the tip again rather than going
 * permanently silent for a server it happened to see once, long ago.
 */
const noSourceFollowNudgeShownServers = new Set<string>();

/**
 * Byte-for-byte identical to the rc snippets documented in `README.md`'s
 * "Directory Sync (Follow Terminal Directory)" section and
 * `docs/functional-documentation.md`'s §4.4.2 — kept in sync deliberately so
 * "Show Me How" and the docs can never drift apart.
 *
 * P2 fix — the old single constant here shipped only the bash form plus a
 * comment *naming* the zsh mechanism ("the equivalent goes in ~/.zshrc via
 * precmd_functions") without ever supplying it: a zsh user who clicked
 * "Show Me How" got a `PROMPT_COMMAND=` assignment zsh never executes,
 * followed by a dead end. Both shells now get a real, copy-pasteable hook.
 */
const BASH_OSC7_HOOK_SNIPPET =
  "# ~/.bashrc — let Nexus follow this shell's directory\nPROMPT_COMMAND='printf \"\\033]7;file://%s%s\\033\\\\\" \"$HOSTNAME\" \"$PWD\"'\"${PROMPT_COMMAND:+; $PROMPT_COMMAND}\"";

/**
 * zsh sets `$HOST` automatically; `$HOSTNAME` is frequently unset there
 * (unlike bash, which always has it), so the zsh hook must use `${HOST}` —
 * verified against a real zsh 5.9 interactively via a pty: `precmd_functions`
 * fires the hook before every prompt, and the single-quoted `printf` format
 * (`'\033]7;file://%s%s\033\\'`) emits the byte-exact `ESC ] 7 ; file://<host><path> ESC \`
 * OSC 7 + ST sequence, the same as the bash form below.
 */
const ZSH_OSC7_HOOK_SNIPPET =
  "# ~/.zshrc — let Nexus follow this shell's directory\n__nexus_osc7() { printf '\\033]7;file://%s%s\\033\\\\' \"${HOST}\" \"$PWD\"; }\nprecmd_functions+=(__nexus_osc7)";

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

/**
 * Resolves which SSH session `nexus.files.syncFromTerminal` should act on.
 *
 * When the command is invoked from a terminal tab's own context menu
 * (`terminal/title/context` / `editor/title/context` in `package.json`), VS Code
 * passes the clicked `vscode.Terminal` as the first argument — the same shape
 * `terminalTabCommands.ts`'s `resolveTerminal()` sniffs. `isTerminalArg()` is
 * that module's exported duck-type check, reused here rather than re-derived,
 * so the two command modules agree on exactly one definition of "this arg is
 * the clicked terminal." Without honouring it, right-clicking a *non-focused*
 * Nexus SSH terminal and choosing "Go to Terminal Directory" silently syncs
 * whichever terminal happens to be focused instead.
 *
 * A `vscode.Terminal` that maps to no live Nexus SSH session (a plain shell tab,
 * a serial tab, a session that has since ended) resolves to `undefined` and the
 * command no-ops. Falling back to the focused session there would be worse than
 * doing nothing: the user pointed at a specific tab.
 *
 * Every other invocation path (command palette, the File Explorer `.` row, the
 * bug-2 "Go to Terminal Directory" nudge button) passes no `vscode.Terminal`, so
 * this collapses to `resolveFocusedSshSession` — today's behaviour, unchanged.
 */
function resolveTargetSshSession(ctx: CommandContext, arg?: unknown): FocusedSshSession | undefined {
  if (isTerminalArg(arg)) {
    for (const [sessionId, tracked] of ctx.sessionTerminals) {
      if (tracked === arg) {
        return ctx.core.getSnapshot().activeSessions.find((session) => session.id === sessionId);
      }
    }
    return undefined;
  }
  return resolveFocusedSshSession(ctx);
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
 *
 * The re-check re-resolves the target *the same way it was originally
 * resolved* (`resolveTargetSshSession(ctx, arg)`), so a terminal-tab
 * invocation is re-validated against the clicked terminal rather than against
 * whatever is focused now. With no `arg` this is byte-for-byte the old
 * focused-session re-check.
 */
async function validateAndApply(
  ctx: CommandContext,
  session: FocusedSshSession,
  candidate: string,
  arg?: unknown
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

  // Re-check immediately before committing: both the target session and the
  // explorer's active server must still match what was captured at entry.
  // A slower validation for a since-abandoned session/server pairing must
  // never land on an explorer that has since switched to a different server.
  const currentTarget = resolveTargetSshSession(ctx, arg);
  const currentActiveServerId = ctx.fileExplorerProvider.getActiveServerId();
  if (currentTarget?.id !== expectedSessionId || currentActiveServerId !== expectedServerId) {
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
 * Bug-2 fix — the actionable half of "turning Follow on with no OSC 7 source
 * says nothing useful". Fires at most once per explorer server (in-memory
 * only — see `noSourceFollowNudgeShownServers`). Act-on-click, no second
 * modal, mirroring the pattern at `extension.ts`'s
 * `maybeWarnMacroKeybindingsBlocked` (`extension.ts:204-217`):
 *  - `Show Me How` writes the rc one-liner to the Nexus Directory Sync
 *    output channel and shows it — the channel already exists as this
 *    feature's diagnostics sink (§7.6), is plain text a user can select and
 *    copy, and needs no new UI surface (a webview would be overkill for one
 *    paragraph of text).
 *  - `Go to Terminal Directory` runs the existing on-demand sync command,
 *    the immediate escape hatch for hosts that will never announce a
 *    directory automatically.
 */
function showNoSourceFollowNudge(ctx: CommandContext, session: FocusedSshSession): void {
  if (noSourceFollowNudgeShownServers.has(session.serverId)) {
    return;
  }
  noSourceFollowNudgeShownServers.add(session.serverId);

  const serverName = ctx.core.getServer(session.serverId)?.name ?? session.serverId;
  void vscode.window
    .showInformationMessage(
      `"${serverName}" hasn't reported its directory yet. Nexus never types into a session, so the shell has to announce where it is. fish and starship already do; bash and zsh need one line in your rc file.`,
      NO_SOURCE_FOLLOW_SHOW_ME_HOW_ACTION,
      NO_SOURCE_FOLLOW_GO_TO_TERMINAL_ACTION
    )
    .then((choice) => {
      if (choice === NO_SOURCE_FOLLOW_SHOW_ME_HOW_ACTION) {
        // P2 fix: both shells' hooks, not just bash's — a zsh user gets a
        // real snippet to paste instead of a `PROMPT_COMMAND=` line their
        // shell never runs plus a comment naming a mechanism it never supplies.
        ctx.cwdSyncOutputChannel?.appendLine(BASH_OSC7_HOOK_SNIPPET);
        ctx.cwdSyncOutputChannel?.appendLine("");
        ctx.cwdSyncOutputChannel?.appendLine(ZSH_OSC7_HOOK_SNIPPET);
        ctx.cwdSyncOutputChannel?.show();
      } else if (choice === NO_SOURCE_FOLLOW_GO_TO_TERMINAL_ACTION) {
        void vscode.commands.executeCommand("nexus.files.syncFromTerminal");
      }
    });
}

/**
 * Called from the `nexus.files.followTerminal` handler only — never from a
 * timer, never from general state recomputation. Fires the nudge only when
 * the state freshly resolved *after* turning following on is exactly
 * `noSource` (a focused SSH session, on the explorer's active server, that
 * has never reported a directory). Every other state — `off`, `following`,
 * `stale`, `pinned`, `otherServer`, `rateLimited` — has its own header
 * string (§8.2) and must stay silent here.
 */
function maybeShowNoSourceFollowNudge(ctx: CommandContext): void {
  if (!ctx.cwdSyncCoordinator || ctx.cwdSyncCoordinator.getState().kind !== "noSource") {
    return;
  }
  const session = resolveFocusedSshSession(ctx);
  if (!session) {
    return;
  }
  showNoSourceFollowNudge(ctx, session);
}

/**
 * `nexus.files.syncFromTerminal` — the resolution ladder (§8.5(a) inline
 * commentary walks the full flow). `arg` is VS Code's command argument: the
 * clicked `vscode.Terminal` for a terminal-tab context-menu invocation,
 * otherwise absent (see `resolveTargetSshSession`).
 *  1. A non-stale tracker record for the target SSH session, if its
 *     `serverId` matches the explorer's active server.
 *  2. Else the prompt-text heuristic against the target terminal's scrollback.
 *  3. Validate whichever candidate step 1/2 produced; on success, re-root.
 *  4. On no candidate or failed validation, open the `goToPath` prompt
 *     prefilled with the best candidate we have (or the current root, matching
 *     `goToPath`'s own bare-invocation default) rather than dead-ending.
 *  5. If that also yields nothing, show the once-per-session incapability
 *     toast (§8.5a).
 */
async function syncFromTerminal(ctx: CommandContext, arg?: unknown): Promise<void> {
  const activeServerId = ctx.fileExplorerProvider.getActiveServerId();
  if (!activeServerId) {
    log(ctx, "syncFromTerminal: no active File Explorer server");
    return;
  }

  const session = resolveTargetSshSession(ctx, arg);
  if (!session || session.serverId !== activeServerId) {
    log(ctx, "syncFromTerminal: no target SSH session for the active explorer server");
    return;
  }

  const candidate = getTrackedCandidate(ctx, session) ?? getHeuristicCandidate(ctx, session);

  if (candidate) {
    const resolved = await validateAndApply(ctx, session, candidate, arg);
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
    maybeShowNoSourceFollowNudge(ctx);
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

  const syncFromTerminalCmd = vscode.commands.registerCommand(
    "nexus.files.syncFromTerminal",
    async (arg?: unknown) => {
      await syncFromTerminal(ctx, arg);
    }
  );

  return [followTerminal, unfollowTerminal, resumeFollowTerminal, syncFromTerminalCmd];
}
