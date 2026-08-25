// Cursor-home then erase the visible screen. What EVERY pty's `resetTerminal()`
// fires — SSH, Telnet, both serial ptys, and the local one. Scrollback is left
// intact: on a remote session so the user can still scroll back through output
// the shell will not redraw, and everywhere so that Reset stays visibly
// distinct from Clear Scrollback, which is the only command that also empties
// the TerminalCaptureBuffer behind Copy All.
//
// A reset that wiped scrollback made those two adjacent menu entries produce
// identical-looking results while only one of them touched the buffer, so after
// a Reset the screen was blank and Copy All still returned the whole history.
export const CLEAR_VISIBLE_SCREEN = "\x1b[H\x1b[2J";
