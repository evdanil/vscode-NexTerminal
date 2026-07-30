export const TUNNEL_DRAG_MIME = "application/vnd.nexus.tunnelprofile";
export const ITEM_DRAG_MIME = "application/vnd.nexus.item";
/**
 * §4.9 — a distinct MIME for macro drags. Reusing `ITEM_DRAG_MIME` would make
 * the Macros view advertise acceptance of Hub server/serial/folder drags
 * (valid-drop cursor, then silent no-op) and vice versa.
 */
export const MACRO_DRAG_MIME = "application/vnd.nexus.macro";
