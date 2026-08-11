import { promises as fsp } from "node:fs";
import * as vscode from "vscode";

const UNC_HOSTS_SETTING = "security.allowedUNCHosts";

/**
 * Explains a blocked UNC host and — only with explicit, modal consent — adds it
 * to VS Code's own `security.allowedUNCHosts`.
 *
 * `security.allowedUNCHosts` is a SECURITY setting: allowing a host lets any VS
 * Code process read and write files served by it. It is therefore never written
 * silently. The flow is: an error toast that names the host, then a modal that
 * names both the host and the setting, and only a positive answer to that modal
 * writes anything. Declining at either step leaves the configuration untouched.
 *
 * `security.restrictUNCAccess` itself is never modified — the restriction stays
 * on; we only ever append one consented host.
 *
 * Call once per operation (not per file): a 200-file directory upload from a
 * blocked share must produce one actionable message, not 200.
 */
export async function offerUNCHostRemediation(
  host: string,
  probePath: string,
  diagnostics?: (line: string) => void
): Promise<void> {
  diagnostics?.(`[unc] blocked by VS Code UNC restriction: host "${host}" (path ${probePath})`);

  const choice = await vscode.window.showErrorMessage(
    `VS Code blocked access to network host "${host}" (Windows UNC protection).`,
    "Allow Host…",
    "Open Settings"
  );

  if (choice === "Open Settings") {
    diagnostics?.(`[unc] user chose to open settings for ${UNC_HOSTS_SETTING}`);
    await openUNCSettings();
    return;
  }
  if (choice !== "Allow Host…") {
    diagnostics?.("[unc] user dismissed the remediation prompt — nothing was changed");
    return;
  }

  const consent = await vscode.window.showWarningMessage(
    `Add "${host}" to the trusted network hosts list ('${UNC_HOSTS_SETTING}')? ` +
      "VS Code will be able to read and write files on this host. Only allow hosts you trust.",
    { modal: true },
    "Allow"
  );
  if (consent !== "Allow") {
    diagnostics?.(`[unc] consent declined for host "${host}" — ${UNC_HOSTS_SETTING} not modified`);
    return;
  }

  const configuration = vscode.workspace.getConfiguration();
  const existing = readAllowedHosts(configuration);
  const alreadyAllowed = existing.some((entry) => entry.toLowerCase() === host.toLowerCase());
  const merged = alreadyAllowed ? existing : [...existing, host];

  try {
    await configuration.update(UNC_HOSTS_SETTING, merged, vscode.ConfigurationTarget.Global);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    diagnostics?.(`[unc] failed to update ${UNC_HOSTS_SETTING}: ${message}`);
    const fallback = await vscode.window.showErrorMessage(
      `Could not update '${UNC_HOSTS_SETTING}' automatically (${message}). Add "${host}" manually.`,
      "Open Settings"
    );
    if (fallback === "Open Settings") {
      await openUNCSettings();
    }
    return;
  }
  diagnostics?.(`[unc] host "${host}" added to ${UNC_HOSTS_SETTING} (user settings)`);

  addToLiveAllowlist(host, diagnostics);

  // The extension host receives its allowlist once, at spawn time (via the
  // NODE_UNC_HOST_ALLOWLIST env var), and never refreshes it — so the settings
  // write alone usually does not unblock the current session. Probe the real
  // path rather than guessing: if the best-effort live add above took, the user
  // can simply retry; if it did not, a window reload is genuinely required.
  let probeSucceeded = false;
  try {
    await fsp.stat(probePath);
    probeSucceeded = true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    diagnostics?.(`[unc] re-probe of ${probePath} still failing: ${message}`);
  }

  if (probeSucceeded) {
    diagnostics?.(`[unc] re-probe of ${probePath} succeeded — no reload needed`);
    void vscode.window.showInformationMessage(`Host "${host}" allowed. Please repeat the upload/download.`);
    return;
  }

  const reload = await vscode.window.showWarningMessage(
    `Host "${host}" was added to '${UNC_HOSTS_SETTING}', but the change only takes effect after the window reloads.`,
    "Reload Window"
  );
  if (reload === "Reload Window") {
    await vscode.commands.executeCommand("workbench.action.reloadWindow");
  }
}

function readAllowedHosts(configuration: vscode.WorkspaceConfiguration): string[] {
  const raw: unknown = configuration.get(UNC_HOSTS_SETTING);
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw.filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
}

/**
 * Best-effort in-process allowlist update. `process.uncHostAllowlist` is an
 * undocumented VS Code internal (win32 only, populated at spawn from the env
 * var), so this is fully guarded and never the source of truth — the durable
 * path is the setting plus a reload. Behavior without it is merely "reload
 * needed", which the probe below detects.
 */
function addToLiveAllowlist(host: string, diagnostics?: (line: string) => void): void {
  if (process.platform !== "win32") {
    return;
  }
  try {
    const allowlist = (process as unknown as { uncHostAllowlist?: { add?: (value: string) => void } }).uncHostAllowlist;
    if (typeof allowlist?.add === "function") {
      allowlist.add(host.toLowerCase());
      diagnostics?.(`[unc] host "${host}" added to the live process allowlist`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    diagnostics?.(`[unc] live allowlist update skipped: ${message}`);
  }
}

async function openUNCSettings(): Promise<void> {
  await vscode.commands.executeCommand("workbench.action.openSettings", UNC_HOSTS_SETTING);
}
