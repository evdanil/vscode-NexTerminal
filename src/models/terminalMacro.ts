export interface TerminalMacro {
  name: string;
  text: string;
  keybinding?: string;
  /** @deprecated Use keybinding instead. Auto-migrated on first load. */
  slot?: number;
  secret?: boolean;
  triggerPattern?: string;
  triggerCooldown?: number;
  triggerInitiallyDisabled?: boolean;
}
