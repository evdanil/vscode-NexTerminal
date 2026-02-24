import * as vscode from "vscode";

export type ConflictMode = "ask" | "overwrite" | "skip" | "cancel";
export type ConflictDecision = "overwrite" | "skip" | "cancel";

export const CONFLICT_OPTIONS = {
  overwrite: "Overwrite",
  skip: "Skip",
  overwriteAll: "Overwrite All",
  skipAll: "Skip All",
  cancel: "Cancel"
} as const;

export async function resolveConflict(
  message: string,
  conflictState: { mode: ConflictMode }
): Promise<ConflictDecision> {
  if (conflictState.mode === "overwrite") {
    return "overwrite";
  }
  if (conflictState.mode === "skip") {
    return "skip";
  }
  if (conflictState.mode === "cancel") {
    return "cancel";
  }

  const choice = await vscode.window.showWarningMessage(
    message,
    CONFLICT_OPTIONS.overwrite,
    CONFLICT_OPTIONS.skip,
    CONFLICT_OPTIONS.overwriteAll,
    CONFLICT_OPTIONS.skipAll,
    CONFLICT_OPTIONS.cancel
  );

  switch (choice) {
    case CONFLICT_OPTIONS.overwrite:
      return "overwrite";
    case CONFLICT_OPTIONS.skip:
      return "skip";
    case CONFLICT_OPTIONS.overwriteAll:
      conflictState.mode = "overwrite";
      return "overwrite";
    case CONFLICT_OPTIONS.skipAll:
      conflictState.mode = "skip";
      return "skip";
    default:
      conflictState.mode = "cancel";
      return "cancel";
  }
}
