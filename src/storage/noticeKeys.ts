/**
 * globalState key recording that the Local Shell auto-trigger warning was
 * answered. Kept in its own module so Delete All Data can clear it (it belongs to
 * the `nexus.terminal.macros.autoTrigger` setting that reset also restores)
 * without importing the command layer's UI.
 */
export const LOCAL_SHELL_AUTOTRIGGER_WARNING_KEY = "nexus.localShell.autoTriggerWarningShown";
