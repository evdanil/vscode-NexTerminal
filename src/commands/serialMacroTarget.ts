import * as vscode from "vscode";
import type { TerminalRegistry } from "../services/terminal/terminalRegistry";
import { isSerialUserInput } from "../services/serial/serialUserInput";
import type { FocusedSendBoxMacroTarget, SerialMacroTargetResolver } from "./macroVariablePrompt";
import type { SerialSendBinding } from "../ui/serialSendPanel";

/** The registry retains serial ownership after disconnect, until the native tab closes. */
export function createSerialMacroTargetResolver(registry: TerminalRegistry): SerialMacroTargetResolver {
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
          // Macro text already owns its byte/line-ending contract; composer conversion does not apply.
          await pty.sendUserInput(text, epoch);
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
    const pty: unknown = registry.get(binding?.terminal)?.pty;
    if (!binding || pty !== binding.input) return undefined;
    return resolve(binding.terminal);
  };
}
