export const TUNNEL_DRAG_MIME = "application/vnd.nexus.tunnelprofile";
export const ITEM_DRAG_MIME = "application/vnd.nexus.item";
/**
 * §4.9 — a distinct MIME for macro drags. Reusing `ITEM_DRAG_MIME` would make
 * the Macros view advertise acceptance of Hub server/serial/folder drags
 * (valid-drop cursor, then silent no-op) and vice versa.
 */
export const MACRO_DRAG_MIME = "application/vnd.nexus.macro";
/**
 * §5.9 — a distinct MIME for script drags, for the same reason the macro one
 * exists: without it the Scripts view would advertise acceptance of Hub and
 * Macros drags, showing a valid-drop cursor for a gesture that can only be a
 * no-op. It also keeps the Scripts payload out of every other view's reach —
 * which matters more here than for macros, because a script drop performs a
 * filesystem rename rather than a state edit.
 */
export const SCRIPT_DRAG_MIME = "application/vnd.nexus.script";
