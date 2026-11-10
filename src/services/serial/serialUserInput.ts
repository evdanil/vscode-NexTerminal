import type * as vscode from "vscode";

export type SerialLineEnding = "none" | "cr" | "lf" | "crlf";

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

/** Convert outbound composer text only; macros and scripts preserve their own bytes. */
export function prepareSerialText(text: string, ending: SerialLineEnding): string {
  if (ending !== "none" && ending !== "cr" && ending !== "lf" && ending !== "crlf") {
    throw new Error("Invalid serial line ending.");
  }
  const eol = ending === "cr" ? "\r" : ending === "lf" ? "\n" : ending === "crlf" ? "\r\n" : "";
  const payload = ending === "none" ? text : text.replace(/\r\n|\r|\n/g, eol) + eol;
  if (!payload) throw new Error("Enter text or choose a line ending to send.");
  if (Buffer.byteLength(payload, "utf8") > 65536) throw new Error("Serial send exceeds 65,536 UTF-8 bytes.");
  return payload;
}
