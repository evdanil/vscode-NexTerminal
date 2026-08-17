/**
 * Command handlers for individual TFTP transfers.
 * Surface area:
 *   nexus.networkServer.tftp.cancelTransfer — abort one in-flight transfer
 *   nexus.networkServer.tftp.clearHistory   — empty the completed-transfer list
 *
 * Split out of `networkServerCommands.ts` for the same reason
 * `networkServerQuickAdjust.ts` and `networkServerProfileCommands.ts` are:
 * that file owns the *service* lifecycle (start / stop / restart / settings),
 * while this one acts on a single client session inside a running service.
 *
 * Two invocation paths, as everywhere else in this subsystem: a right-click on
 * an active-transfer row passes the tree item, and a Command Palette
 * invocation passes nothing and gets a quick pick over the transfers currently
 * in the snapshot.
 */

import * as vscode from "vscode";
import { NetworkServerError, type NetworkServerTransferSummary } from "../models/networkServer";
import type { NetworkServerManager } from "../services/networkServers/networkServerManager";
import type { CommandContext } from "./types";

/** `transferId`, not `id` — `QuickPickItem` has no `id`, but clarity wins. */
interface TransferPick extends vscode.QuickPickItem {
  transferId: string;
}

/**
 * Extracts a transfer id from whatever the invocation handed us.
 *
 * Accepts the tree item (which carries `transferId`), a bare id string from a
 * keybinding or another extension, and the summary object itself.
 *
 * @param arg First command argument, if any.
 * @returns The transfer id, or `undefined` when the argument carries none.
 */
function toTransferId(arg: unknown): string | undefined {
  if (typeof arg === "string" && arg.length > 0) return arg;
  if (typeof arg === "object" && arg) {
    const candidate = arg as { transferId?: unknown; id?: unknown };
    if (typeof candidate.transferId === "string" && candidate.transferId.length > 0) {
      return candidate.transferId;
    }
    // A `NetworkServerTransferSummary` keys its identity as `id`; tree item ids
    // are prefixed (`networkServer:tftp:transfer:…`) and are not valid here.
    if (typeof candidate.id === "string" && candidate.id.includes(":") && !candidate.id.startsWith("networkServer:")) {
      return candidate.id;
    }
  }
  return undefined;
}

/** Human-readable one-liner for a transfer, shared by the pick and the toasts. */
function describeTransfer(transfer: NetworkServerTransferSummary): string {
  const verb = transfer.direction === "wrq" ? "Upload" : "Download";
  return `${verb} · ${transfer.filename} · ${transfer.peer}`;
}

/**
 * Quick pick over the transfers the sidebar currently knows about.
 *
 * Sourced from the NexusCore snapshot rather than a fresh daemon round trip:
 * it is the same data the user is looking at, and a transfer that ended in
 * between is handled by the `false` result from the cancel itself.
 *
 * @param transfers Snapshot of active transfers.
 * @returns Chosen transfer id, or `undefined` if the user dismissed the pick.
 */
async function pickTransfer(transfers: readonly NetworkServerTransferSummary[]): Promise<string | undefined> {
  const picks: TransferPick[] = transfers.map((transfer) => ({
    label: transfer.filename,
    description: transfer.peer,
    detail: describeTransfer(transfer),
    transferId: transfer.id
  }));
  const pick = await vscode.window.showQuickPick<TransferPick>(picks, {
    title: "Cancel TFTP Transfer",
    placeHolder: "Select the transfer to abort"
  });
  return pick?.transferId;
}

function errorMessageFor(error: unknown, prefix: string): string {
  if (error instanceof NetworkServerError) return `${prefix}: ${error.message}`;
  return `${prefix}: ${error instanceof Error ? error.message : String(error)}`;
}

/**
 * Registers the per-transfer commands.
 *
 * @param ctx Command context; `networkServerManager` is required.
 * @returns Disposables for `context.subscriptions`.
 */
export function registerNetworkServerTransferCommands(
  ctx: CommandContext & { networkServerManager: NetworkServerManager }
): vscode.Disposable[] {
  const manager = ctx.networkServerManager;

  const activeTransfers = (): readonly NetworkServerTransferSummary[] =>
    ctx.core.getNetworkServerSession("tftp")?.detail?.transfers ?? [];

  return [
    vscode.commands.registerCommand("nexus.networkServer.tftp.cancelTransfer", async (arg?: unknown) => {
      let transferId = toTransferId(arg);
      const transfers = activeTransfers();
      if (!transferId) {
        if (transfers.length === 0) {
          void vscode.window.showInformationMessage("No TFTP transfers are currently active.");
          return;
        }
        transferId = transfers.length === 1 ? transfers[0]?.id : await pickTransfer(transfers);
        if (!transferId) return;
      }
      const known = transfers.find((transfer) => transfer.id === transferId);
      const label = known ? describeTransfer(known) : transferId;

      try {
        const cancelled = await manager.cancelTftpTransfer(transferId);
        // Both outcomes are the direct answer to a button the user pressed, so
        // neither is gated behind Verbose Mode — unlike the background
        // connection events, which are.
        if (cancelled) {
          void vscode.window.showInformationMessage(`Cancelled TFTP transfer — ${label}.`);
        } else {
          void vscode.window.showInformationMessage(`TFTP transfer already finished — ${label}.`);
        }
      } catch (error) {
        void vscode.window.showErrorMessage(errorMessageFor(error, "Failed to cancel TFTP transfer"));
      }
    }),

    vscode.commands.registerCommand("nexus.networkServer.tftp.clearHistory", () => {
      const cleared = ctx.core.getNetworkServerSession("tftp")?.transferHistory?.length ?? 0;
      manager.clearTransferHistory("tftp");
      // Answering a button press, so not gated behind Verbose Mode — same rule
      // as the cancel outcomes above. The no-op case is reported too: silence
      // after a click reads as a broken command.
      if (cleared === 0) {
        void vscode.window.showInformationMessage("TFTP transfer history is already empty.");
        return;
      }
      void vscode.window.showInformationMessage(
        `Cleared ${String(cleared)} completed TFTP transfer${cleared === 1 ? "" : "s"} from history.`
      );
    })
  ];
}
