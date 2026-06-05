import * as vscode from "vscode";
import type { PtyOutputObserver } from "../macroAutoTrigger";
import type { TerminalHighlighter, TerminalHighlighterStream } from "../terminalHighlighter";

/**
 * One-shot banner echoed through the owning PTY's writeEmitter the first time a
 * keystroke is dropped while input is locked (e.g. during a script run). Shared
 * verbatim by SshPty / SerialPty / SmartSerialPty / LocalShellPty so the locked
 * experience is identical across transports. See CLAUDE.md "PTY integration".
 */
export const INPUT_LOCKED_NOTICE =
  "\r\n[Nexus] Terminal is locked while a script is running. Stop the script to send input.\r\n";

/**
 * Shared owner of the per-PTY output-observer Set plus the input-locked flag and
 * its one-shot notice. Each of the four `SessionPtyHandle` PTYs delegates its
 * `addOutputObserver` / `setInputBlocked` boilerplate, observer fan-out on
 * output, and observer teardown here so the behaviour stays byte-identical.
 *
 * The hub never touches a transport. Output is fanned out to observers and then
 * either pushed into the highlighter stream or handed to the supplied `emit`
 * callback — which every PTY wires to its local `writeEmitter.fire` — exactly as
 * the inline copies did. `resetTerminal` / `writeProgrammatic` stay in the PTYs
 * because they are transport-specific.
 */
export class PtyObserverHub {
  private readonly observers = new Set<PtyOutputObserver>();
  private inputBlocked = false;
  private noticeArmed: boolean;

  /**
   * @param noticeArmedInitially - initial arming of the one-shot locked notice.
   *   SSH/Serial/SmartSerial start armed; LocalShell starts disarmed and arms on
   *   the first `setInputBlocked(true)` — preserving each PTY's prior default.
   */
  public constructor(initialObserver?: PtyOutputObserver, noticeArmedInitially = true) {
    this.noticeArmed = noticeArmedInitially;
    if (initialObserver) this.observers.add(initialObserver);
  }

  public addOutputObserver(observer: PtyOutputObserver): vscode.Disposable {
    this.observers.add(observer);
    return new vscode.Disposable(() => {
      this.observers.delete(observer);
    });
  }

  public setInputBlocked(blocked: boolean): void {
    this.inputBlocked = blocked;
    if (blocked) this.noticeArmed = true;
  }

  public get isInputBlocked(): boolean {
    return this.inputBlocked;
  }

  /**
   * Returns the one-shot locked notice the first time it is called while still
   * armed, then `undefined`. The PTY fires the returned string through its own
   * `writeEmitter` so the notice renders locally without touching the transport.
   */
  public consumeLockedNotice(): string | undefined {
    if (!this.noticeArmed) return undefined;
    this.noticeArmed = false;
    return INPUT_LOCKED_NOTICE;
  }

  /**
   * Fan output out to every observer, then render it: push to the highlighter
   * stream when present, otherwise hand the (optionally highlighted) text to
   * `emit`. Mirrors the inline data-handler block in each PTY exactly.
   */
  public notifyOutput(
    text: string,
    highlighterStream: TerminalHighlighterStream | undefined,
    highlighter: TerminalHighlighter | undefined,
    emit: (rendered: string) => void
  ): void {
    this.observers.forEach((o) => o.onOutput(text));
    if (highlighterStream) {
      highlighterStream.push(text);
    } else {
      emit(highlighter ? highlighter.apply(text) : text);
    }
  }

  /** Pause interval macros on every observer (disconnect / shutdown paths). */
  public pauseIntervalMacros(): void {
    this.observers.forEach((o) => o.pauseIntervalMacros());
  }

  /** Dispose every observer (tolerating throws) and clear the Set. */
  public disposeAll(): void {
    this.observers.forEach((o) => {
      try {
        o.dispose();
      } catch {
        /* tolerate misbehaving observer */
      }
    });
    this.observers.clear();
  }
}
