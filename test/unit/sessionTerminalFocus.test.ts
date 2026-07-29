import { describe, expect, it, vi } from "vitest";
import {
  applyActiveEditorChange,
  applyActiveTerminalChange,
  clearTrackedSessionActivity,
  focusSessionTerminal,
  type TerminalFocusChangeOptions
} from "../../src/utils/sessionTerminalFocus";

describe("sessionTerminalFocus", () => {
  it("focuses an SSH terminal and clears unread activity immediately", () => {
    const terminal = { show: vi.fn() };
    const clearSessionActivity = vi.fn();
    const setActivityIndicator = vi.fn();
    const onTerminalFocused = vi.fn();

    const focused = focusSessionTerminal(
      {
        core: { clearSessionActivity },
        sessionTerminals: new Map([["ssh-1", terminal as any]]),
        serialTerminals: new Map(),
        activityIndicators: new Map([["ssh-1", { setActivityIndicator }]]),
        onTerminalFocused
      },
      "ssh-1",
      "ssh"
    );

    expect(focused).toBe(true);
    expect(onTerminalFocused).toHaveBeenCalledWith(terminal);
    expect(clearSessionActivity).toHaveBeenCalledWith("ssh-1");
    expect(setActivityIndicator).toHaveBeenCalledWith(false);
    expect(terminal.show).toHaveBeenCalledTimes(1);
  });

  it("focuses a serial terminal and clears unread activity immediately", () => {
    const terminal = { show: vi.fn() };
    const clearSessionActivity = vi.fn();
    const setActivityIndicator = vi.fn();

    const focused = focusSessionTerminal(
      {
        core: { clearSessionActivity },
        sessionTerminals: new Map(),
        serialTerminals: new Map([["serial-1", { terminal: terminal as any }]]),
        activityIndicators: new Map([["serial-1", { setActivityIndicator }]])
      },
      "serial-1",
      "serial"
    );

    expect(focused).toBe(true);
    expect(clearSessionActivity).toHaveBeenCalledWith("serial-1");
    expect(setActivityIndicator).toHaveBeenCalledWith(false);
    expect(terminal.show).toHaveBeenCalledTimes(1);
  });

  it("focuses a local shell terminal without requiring activity tracking", () => {
    const terminal = { show: vi.fn() };
    const clearSessionActivity = vi.fn();

    const focused = focusSessionTerminal(
      {
        core: { clearSessionActivity },
        sessionTerminals: new Map(),
        serialTerminals: new Map(),
        localShellTerminals: new Map([["local-1", { terminal: terminal as any }]]),
        activityIndicators: new Map()
      },
      "local-1",
      "localShell"
    );

    expect(focused).toBe(true);
    expect(clearSessionActivity).toHaveBeenCalledWith("local-1");
    expect(terminal.show).toHaveBeenCalledTimes(1);
  });

  it("does nothing when the session terminal is missing", () => {
    const clearSessionActivity = vi.fn();
    const setActivityIndicator = vi.fn();

    const focused = focusSessionTerminal(
      {
        core: { clearSessionActivity },
        sessionTerminals: new Map(),
        serialTerminals: new Map(),
        activityIndicators: new Map([["missing", { setActivityIndicator }]])
      },
      "missing",
      "ssh"
    );

    expect(focused).toBe(false);
    expect(clearSessionActivity).not.toHaveBeenCalled();
    expect(setActivityIndicator).not.toHaveBeenCalled();
  });

  it("clears tracked activity without needing terminal lookup", () => {
    const clearSessionActivity = vi.fn();
    const setActivityIndicator = vi.fn();

    clearTrackedSessionActivity(
      {
        core: { clearSessionActivity },
        activityIndicators: new Map([["ssh-1", { setActivityIndicator }]])
      },
      "ssh-1"
    );

    expect(clearSessionActivity).toHaveBeenCalledWith("ssh-1");
    expect(setActivityIndicator).toHaveBeenCalledWith(false);
  });

  // ─── Focus-change handlers (directory sync, design doc §5.3 rule 7) ──────

  describe("focus-change handlers", () => {
    function makeOptions(overrides?: {
      resolvedSessionId?: string | undefined;
      focusedTerminal?: unknown;
    }): {
      options: TerminalFocusChangeOptions;
      setFocusedSession: ReturnType<typeof vi.fn>;
      clearSessionActivity: ReturnType<typeof vi.fn>;
      setActivityIndicator: ReturnType<typeof vi.fn>;
    } {
      const setFocusedSession = vi.fn();
      const clearSessionActivity = vi.fn();
      const setActivityIndicator = vi.fn();
      const options: TerminalFocusChangeOptions = {
        core: { setFocusedSession, clearSessionActivity },
        activityIndicators: new Map([["ssh-1", { setActivityIndicator }]]),
        target: { focusedTerminal: overrides?.focusedTerminal as any },
        resolveSessionId: vi.fn(() => overrides?.resolvedSessionId)
      };
      return { options, setFocusedSession, clearSessionActivity, setActivityIndicator };
    }

    it("a terminal focus change records the terminal, sets the focused session, and clears its activity", () => {
      const terminal = { name: "Nexus SSH: host" };
      const { options, setFocusedSession, clearSessionActivity, setActivityIndicator } = makeOptions({
        resolvedSessionId: "ssh-1"
      });

      applyActiveTerminalChange(options, terminal as any);

      expect(options.target.focusedTerminal).toBe(terminal);
      expect(setFocusedSession).toHaveBeenCalledWith("ssh-1");
      expect(clearSessionActivity).toHaveBeenCalledWith("ssh-1");
      expect(setActivityIndicator).toHaveBeenCalledWith(false);
    });

    it("a terminal focus change to a non-Nexus terminal clears the focused session without touching activity state", () => {
      const { options, setFocusedSession, clearSessionActivity } = makeOptions({ resolvedSessionId: undefined });

      applyActiveTerminalChange(options, { name: "bash" } as any);

      expect(setFocusedSession).toHaveBeenCalledWith(undefined);
      expect(clearSessionActivity).not.toHaveBeenCalled();
    });

    /**
     * INVARIANT (directory-sync design doc §5.3 rule 7). VS Code does not fire
     * `onDidChangeActiveTerminal` when focus moves to an editor, so
     * `focusedSessionId` must survive an editor focus change — otherwise the
     * File Explorer stops following the terminal the moment the user opens a
     * remote file. Nobody may "fix" the editor handler into clearing it.
     */
    it("an editor focus change clears only the focused terminal — never the focused session", () => {
      const terminal = { name: "Nexus SSH: host" };
      const { options, setFocusedSession, clearSessionActivity } = makeOptions({
        resolvedSessionId: "ssh-1",
        focusedTerminal: terminal
      });

      applyActiveEditorChange(options);

      expect(options.target.focusedTerminal).toBeUndefined();
      expect(setFocusedSession).not.toHaveBeenCalled();
      expect(clearSessionActivity).not.toHaveBeenCalled();
      expect(options.resolveSessionId).not.toHaveBeenCalled();
    });
  });
});
