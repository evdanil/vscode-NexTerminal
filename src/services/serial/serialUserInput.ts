import type * as vscode from "vscode";
import { resolveSerialMacroNewline, type SerialLineEnding, type SerialMacroNewline, type SerialProfile } from "../../models/config";

export type { SerialLineEnding } from "../../models/config";

export interface SerialInputState {
  readonly connectionEpoch: number;
  readonly connected: boolean;
  readonly status: "opening" | "connected" | "waiting" | "stopped" | "disconnected" | "closed";
  readonly inputLocked: boolean;
  readonly dedicatedInputEnabled: boolean;
  readonly path?: string;
}

export interface SerialUserInput {
  getInputState(): SerialInputState;
  readonly onDidChangeInputState: vscode.Event<SerialInputState>;
  setDedicatedInputEnabled(enabled: boolean): void;
  sendUserInput(data: string, expectedConnectionEpoch: number): Promise<void>;
}

export function isSerialUserInput(value: unknown): value is SerialUserInput {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<SerialUserInput>;
  return typeof candidate.getInputState === "function" && typeof candidate.onDidChangeInputState === "function" &&
    typeof candidate.setDedicatedInputEnabled === "function" && typeof candidate.sendUserInput === "function";
}

/** The characters one CR, LF or CRLF ending stands for: the one mapping the send box and macros share. */
export function lineEndingCharacters(ending: SerialMacroNewline): string {
  return ending === "lf" ? "\n" : ending === "crlf" ? "\r\n" : "\r";
}

/**
 * Convert outbound composer text only. Macros convert their newlines with
 * `applySerialMacroNewline` instead, and scripts preserve their own bytes.
 */
export function prepareSerialText(text: string, ending: SerialLineEnding): string {
  if (ending !== "none" && ending !== "cr" && ending !== "lf" && ending !== "crlf") {
    throw new Error("Invalid serial line ending.");
  }
  const eol = ending === "none" ? "" : lineEndingCharacters(ending);
  const payload = ending === "none" ? text : text.replace(/\r\n|\r|\n/g, eol) + eol;
  if (!payload) throw new Error("Enter text or choose a line ending to send.");
  if (Buffer.byteLength(payload, "utf8") > 65536) throw new Error("Serial send exceeds 65,536 UTF-8 bytes.");
  return payload;
}

/**
 * Turns each newline in macro text into the serial profile's Macro Newline
 * (`SerialProfile.macroNewline`; absent or unknown means CR).
 *
 * WHY THIS EXISTS: manual macros used to reach every terminal through VS
 * Code's `TerminalInstance.sendText`, which normalizes line endings to an Enter
 * press with `text.replace(/\r?\n/g, '\r')`. Manual serial macros now write to
 * the PTY directly (the guarded route that pins the session and honours script
 * locks), which skips that normalization, so a saved newline reached the device
 * as a bare LF (issue #339). Auto-trigger macros always wrote to the PTY, and
 * so always sent LF; they share this conversion so one profile setting decides
 * what the device receives. The pattern here is VS Code's own: with CR (the
 * default) the bytes are exactly what VS Code sent. A CRLF pair is one newline,
 * not two; a standalone CR is already Enter and stays as it is; nothing is
 * appended.
 *
 * Applied to the final text, after variable substitution, so a newline inside
 * a variable value is converted too, as VS Code converted it.
 */
export function applySerialMacroNewline(text: string, newline: unknown): string {
  return text.replace(/\r?\n/g, lineEndingCharacters(resolveSerialMacroNewline(newline)));
}

/** The serial session a macro is sent to: its profile id, and the profile as it was when the session opened. */
export interface SerialMacroSession {
  readonly profileId: string;
  readonly openedWith?: Pick<SerialProfile, "macroNewline">;
}

/**
 * The Macro Newline for a send to a live serial session — THE ONE POLICY both
 * delivery routes use (manual macros through `createSerialMacroNewlineLookup`,
 * auto-trigger macros through the connect paths' observers), so they cannot
 * disagree about a session's bytes: the saved profile as it is now, so an edit
 * applies to the next macro without a reconnect; else, if it was deleted while
 * the session ran, the profile the session opened with; else CR.
 */
export function resolveSessionMacroNewline(
  profiles: { getSerialProfile(id: string): Pick<SerialProfile, "macroNewline"> | undefined },
  session: SerialMacroSession | undefined
): SerialMacroNewline {
  if (!session) return "cr";
  return resolveSerialMacroNewline((profiles.getSerialProfile(session.profileId) ?? session.openedWith)?.macroNewline);
}
