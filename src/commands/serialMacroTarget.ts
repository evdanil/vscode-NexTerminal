import * as vscode from "vscode";
import type { SerialMacroNewline, SerialProfile } from "../models/config";
import type { TerminalRegistry } from "../services/terminal/terminalRegistry";
import {
  applySerialMacroNewline,
  isSerialUserInput,
  resolveSessionMacroNewline,
  type SerialMacroSession,
  type SerialUserInput
} from "../services/serial/serialUserInput";
import type { FocusedSendBoxMacroTarget, SerialMacroTargetResolver } from "./macroVariablePrompt";
import type { SerialSendBinding } from "../ui/serialSendPanel";

/**
 * The Macro Newline for a send to a live serial PTY. Asked at each send, not
 * when the macro starts, so a profile edited while a variable prompt is open,
 * or since the session connected, applies to that very send.
 */
export type SerialMacroNewlineLookup = (pty: SerialUserInput) => SerialMacroNewline;

/**
 * Finds the session whose `serialTerminals` entry owns this exact PTY (identity,
 * not terminal or profile, so a replaced session never lends its setting) and
 * resolves its Macro Newline with the policy the auto-trigger observers use. A
 * few live entries are walked in place: no snapshot of the whole configuration
 * is copied per send. A PTY no session owns gets CR.
 */
export function createSerialMacroNewlineLookup(
  serialTerminals: ReadonlyMap<string, SerialMacroSession & { readonly input?: SerialUserInput }>,
  profiles: { getSerialProfile(id: string): Pick<SerialProfile, "macroNewline"> | undefined }
): SerialMacroNewlineLookup {
  return (pty) => {
    for (const entry of serialTerminals.values()) {
      if (entry.input === pty) return resolveSessionMacroNewline(profiles, entry);
    }
    return resolveSessionMacroNewline(profiles, undefined);
  };
}

/** The registry retains serial ownership after disconnect, until the native tab closes. */
export function createSerialMacroTargetResolver(registry: TerminalRegistry, macroNewlineFor: SerialMacroNewlineLookup): SerialMacroTargetResolver {
  return (terminal) => {
    const pty = registry.get(terminal)?.pty;
    if (!isSerialUserInput(pty)) return undefined;
    const epoch = pty.getInputState().connectionEpoch;
    const isStillValid = (): boolean => registry.get(terminal)?.pty === pty &&
      vscode.window.terminals.includes(terminal) && terminal.exitStatus === undefined;
    const refuse = (reason: string): false => {
      vscode.window.setStatusBarMessage(`${reason} Nothing was sent.`, 4000);
      return false;
    };
    return {
      description: terminal.name,
      isStillValid,
      async send(text) {
        if (!isStillValid()) return refuse("Target serial terminal closed or changed.");
        const state = pty.getInputState();
        if (!state.connected) return refuse(`Serial session is ${state.status}.`);
        if (state.connectionEpoch !== epoch) return refuse("Serial connection changed. Run the macro again.");
        if (state.inputLocked) return refuse("Serial input is locked by a script.");
        try {
          // The send box's own line-ending selector does not apply to macros; the profile's Macro
          // Newline does, on the final text so newlines inside variable values convert too.
          await pty.sendUserInput(applySerialMacroNewline(text, macroNewlineFor(pty)), epoch);
          return true;
        } catch {
          // Driver errors may contain device text or macro values. Never echo them into status UI.
          vscode.window.setStatusBarMessage("Serial macro send failed. Check the connection and script lock, then run it again.", 4000);
          return false;
        }
      }
    };
  };
}

/**
 * Resolves a macro shortcut pressed inside a Serial Send Box to THAT box's
 * session, never to `activeTerminal`. The box must still own its terminal's
 * registered PTY: a closed or replaced session refuses rather than letting the
 * registry hand back whatever now occupies the terminal.
 */
export function createFocusedSendBoxMacroTarget(
  panel: { getFocusedBinding(): SerialSendBinding | undefined },
  registry: Pick<TerminalRegistry, "get">,
  resolve: SerialMacroTargetResolver
): FocusedSendBoxMacroTarget {
  return () => {
    const binding = panel.getFocusedBinding();
    if (!binding) return { kind: "noFocusedBox" };
    const pty: unknown = registry.get(binding.terminal)?.pty;
    const target = pty === binding.input ? resolve(binding.terminal) : undefined;
    return target ? { kind: "target", target } : { kind: "sessionGone" };
  };
}
