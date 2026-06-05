// Cursor-home then erase the visible screen. Used by remote/serial PTY
// `resetTerminal()` where the remote shell can redraw — scrollback is left
// intact so the user can scroll back through prior output.
export const CLEAR_VISIBLE_SCREEN = "\x1b[H\x1b[2J";

// Erase the visible screen, erase the scrollback buffer (\x1b[3J), then home the
// cursor. Used by LocalShellPty `resetTerminal()`: there is no remote redraw, so
// clearing scrollback gives a genuinely clean slate. Prefer CLEAR_VISIBLE_SCREEN
// for remote sessions where scrollback should survive a reset.
export const CLEAR_SCREEN_AND_SCROLLBACK = "\x1b[2J\x1b[3J\x1b[H";
