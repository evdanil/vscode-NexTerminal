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

// Returns a reused terminal to plain input modes when its transport goes away.
// Covers every mode that changes what the terminal SENDS to the host, plus
// cursor visibility, so replies and key encodings from a dead session cannot
// leak into the next one (same-tab reconnect, Smart Follow reattach):
//   ?9/1000/1002/1003            mouse tracking
//   ?1005/1006/1015/1016         mouse encodings (cheap to clear even where unimplemented)
//   ?1007                        alternate scroll: wheel -> arrow keys on the alternate
//                                screen, which survives because that screen is kept
//   ?1004                        focus reports (ESC[I / ESC[O)
//   ?2031                        color-scheme notifications
//   ?2004                        bracketed paste
//   ?1, ?66, ESC >               application cursor keys, application keypad
//   ?25h                         cursor visible (htop/less hide it)
// Kitty keeps a bounded keyboard-mode stack per screen: drain the active stack
// (CSI < 9999 u) before zeroing its flags (CSI = 0;1 u) so a later pop cannot
// restore stale key modes.
// ?1036/?1039 (meta/alt send-escape) are left alone: xterm defaults them ON, so
// resetting them would move a fresh terminal away from its default.
//
// Deliberately NOT included: leaving the alternate screen (?1049l / ?47l) and
// RIS (ESC c). Both would discard the dead app's last frame, which the docs
// promise stays readable after a disconnect.
export const RESET_INTERACTIVE_MODES =
  "\x1b[?9;1000;1002;1003;1004;1005;1006;1007;1015;1016;2031;2004;1;66l\x1b>\x1b[?25h\x1b[<9999u\x1b[=0;1u";

// Reports the terminal generates by itself (not key presses): focus in/out,
// SGR mouse (ESC[<..M/m), legacy X10 mouse (ESC[M + 3 bytes), and color-scheme
// (ESC[?997;..n), plus up/down arrows: xterm.js turns wheel scrolling in the
// alternate buffer into repeated ESC[A/ESC[B (ESC O A/B in application cursor
// mode), which a mode reset cannot stop and which is a poor close gesture.
// xterm.js delivers all of these through handleInput, so a "press any key to
// close" rule must not treat them as a key press. Whole-string match so a real
// key never hides behind a prefix.
const TERMINAL_REPORT_RE = /^(?:\x1b[[O][AB]|\x1b\[[IO]|\x1b\[<\d+;\d+;\d+[Mm]|\x1b\[M[\s\S]{3}|\x1b\[\?997;[\d;]*n)+$/;

export function isTerminalGeneratedReport(data: string): boolean {
  return TERMINAL_REPORT_RE.test(data);
}
