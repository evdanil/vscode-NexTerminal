import { ACTIVE_SCHEME_KEY, FONT_KEY, SCHEMES_KEY } from "./vscodeColorSchemeStorage";
import { LOCAL_SHELL_AUTOTRIGGER_WARNING_KEY } from "./noticeKeys";

/**
 * Every Nexus-owned `globalState` key, sorted by what Delete All Data does with
 * it. `test/unit/globalStateKeys.test.ts` scans `src/` for key literals and
 * fails when one is in none of these lists, so a new key cannot silently
 * outlive "Delete All Data".
 */

/** Cleared by `completeReset` itself: user data and one-time notices that live outside the profile stores. */
export const RESET_CLEARED_GLOBAL_STATE_KEYS: readonly string[] = [
  "nexus.macros.migrationNoticeShown",
  LOCAL_SHELL_AUTOTRIGGER_WARNING_KEY,
  SCHEMES_KEY,
  ACTIVE_SCHEME_KEY,
  FONT_KEY,
  "nexus.ui.collapsedFolders",
  "nexus.macros.ui.collapsedFolders",
  "nexus.ui.followTerminalDirectory",
  "nexus.files.followTerminalNudgeShown",
  "nexus.macros.keybindingBlockerHintDismissed"
];

/** Cleared by the reset through the store that owns them (`NexusCore` collections, the macro store). */
export const RESET_CLEARED_BY_STORE_GLOBAL_STATE_KEYS: readonly string[] = [
  "nexus.servers",
  "nexus.tunnels",
  "nexus.serialProfiles",
  "nexus.localShellProfiles",
  "nexus.localServers",
  "nexus.groups",
  "nexus.authProfiles",
  "nexus.inventorySources",
  "nexus.deviceTemplates",
  "nexus.savedFilters",
  "nexus.networkServers.tftpProfiles",
  "nexus.networkServers.dhcpProfiles",
  "nexus.macros",
  "nexus.macros.folders",
  "nexus.macros.secretIds"
];

/** Deliberately kept, and named as kept in the confirmation and the docs. */
export const RESET_KEPT_GLOBAL_STATE_KEYS: readonly string[] = [
  // Trust decisions: the reset must not make every host look new (and a changed key look ordinary).
  "nexus.ssh.knownHostFingerprints.v1",
  // "Never comes back" is that offer's documented contract.
  "nexus.import.sshConfigOffer.v1",
  // Machine state, not user data: last-known-good shadows and the event log.
  "nexus.settingsGuard.lastKnownGood",
  "nexus.settingsGuard.lastKnownGoodValues",
  "nexus.settingsGuard.eventLog",
  // A "this already ran" record; clearing it would rerun a one-time migration.
  "nexus.inventory.statusPollSettingMigrated",
  // Runtime registry of tunnels running in open windows, not saved data.
  "nexus.activeTunnelRegistry"
];
