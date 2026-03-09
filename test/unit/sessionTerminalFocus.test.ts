import { describe, expect, it, vi } from "vitest";
import { clearTrackedSessionActivity, focusSessionTerminal } from "../../src/utils/sessionTerminalFocus";

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
});
