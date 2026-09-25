import type * as vscode from "vscode";
import type { SessionPtyHandle } from "../../models/config";
import type { PtyOutputObserver } from "../macroAutoTrigger";
import { ScriptOutputBuffer } from "./scriptOutputBuffer";

/** The observer that fills a script run's buffer with everything the session prints. */
export function outputBufferObserver(buffer: ScriptOutputBuffer): PtyOutputObserver {
  return {
    onOutput: (text) => buffer.append(text),
    pauseIntervalMacros: () => {},
    dispose: () => {}
  };
}

/**
 * A session's output kept from the moment it opened, for the run that
 * Connect and Run Script… starts on it.
 *
 * `runScript` reads the script file (and seeds the editor types) before it has
 * a run to attach an observer for, so a device that answers the moment the
 * session opens — a Telnet login prompt — would print into that gap and be
 * lost for good. The caller takes this in the same change event that
 * registered the session, before any await, and hands it to `runScript`, which
 * takes the buffer and the subscription over as the run's own. One observer
 * throughout: nothing is copied at the handover, so nothing can be missed or
 * seen twice. Only that path takes one; any other run starts with an empty
 * buffer, as the `lookback` docs promise.
 */
export interface SessionOutputCapture {
  readonly pty: SessionPtyHandle;
  readonly buffer: ScriptOutputBuffer;
  readonly subscription: vscode.Disposable;
}

export function captureSessionOutput(pty: SessionPtyHandle): SessionOutputCapture {
  const buffer = new ScriptOutputBuffer();
  return { pty, buffer, subscription: pty.addOutputObserver(outputBufferObserver(buffer)) };
}
