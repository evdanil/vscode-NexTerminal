import { validateExternalArgumentTemplates } from "../models/externalCredentialArgumentSyntax";
import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import { isExternalAuthProfile } from "../models/authProfile";
import { validateAuthProfile } from "../utils/validation";
import type { ExternalCredentialResolver } from "../services/credentials/contracts";
import { revokeExternalApprovals } from "../services/credentials/externalCredentialSessionActions";
import * as os from "node:os";
import * as vscode from "vscode";
import type { NexusCore } from "../core/nexusCore";
import type { AuthProfile, ServerConfig } from "../models/config";
import type { InventorySourceConfig } from "../models/inventory";
import { configMutationLock } from "../services/configMutationLock";
import { authProfilePassphraseSecretKey, authProfilePasswordSecretKey } from "../services/ssh/silentAuth";
import { renderAuthProfileEditorHtml } from "./authProfileEditorHtml";
import { createWebviewNonce } from "./shared/webviewNonce";

interface SecretVault {
  get(key: string): Promise<string | undefined>;
  store(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

function profileSignature(profiles: AuthProfile[]): string {
  return JSON.stringify(profiles);
}

/**
 * The delete confirmation's text, in full — the profile's name and everything
 * losing its link to it.
 *
 * Inventory sources link a profile too, and this delete silently clears that
 * link (NexusCore.removeAuthProfile). Afterwards nothing else says so: the sync
 * engine sees a plain profile-less source, so its dangling-profile warning
 * never fires either, and the next device synced arrives on the default
 * username + SSH agent — broken on password/key infrastructure, with no signal
 * anywhere. This sentence is the only disclosure, so it has to be here.
 *
 * REVIEW FINDING (P2) — factored out of the handler so the SHOWN text can be
 * rendered again after the lock is acquired and compared, following the
 * captured-vs-fresh discipline `planDetailDrift` established in
 * inventoryCommands.ts: the rendered string IS the comparator, so every fact
 * the modal discloses is covered — the two counts and the profile's own name —
 * with no per-field list to keep in sync by hand.
 */
function describeDeleteDetail(
  profile: AuthProfile,
  servers: ServerConfig[],
  sources: InventorySourceConfig[]
): string {
  const linkedCount = servers.filter((s) => s.authProfileId === profile.id).length;
  const linkedNote = linkedCount > 0
    ? ` ${linkedCount} server(s) are linked and will revert to their own stored credentials.`
    : "";
  const linkedSourceCount = sources.filter((s) => s.authProfileId === profile.id).length;
  const sourceNote = linkedSourceCount > 0
    ? ` ${linkedSourceCount} inventory source${linkedSourceCount === 1 ? " is" : "s are"} linked; servers ${linkedSourceCount === 1 ? "it syncs" : "they sync"} will use the default username with SSH agent authentication.`
    : "";
  return `Delete auth profile "${profile.name}"?${linkedNote}${sourceNote}`;
}

export class AuthProfileEditorPanel {
  private static instance: AuthProfileEditorPanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private disposed = false;
  private selectedId: string | null = null;
  private readonly core: NexusCore;
  private readonly secretVault: SecretVault | undefined;
  private unsubscribe: () => void = () => {};
  private lastProfileSignature: string;

  private constructor(core: NexusCore, secretVault: SecretVault | undefined, initialId: string | null, private readonly externalCredentials?: Pick<ExternalCredentialResolver, "revoke">) {
    this.core = core;
    this.secretVault = secretVault;
    this.selectedId = initialId;
    this.lastProfileSignature = profileSignature(core.getSnapshot().authProfiles);
    this.panel = vscode.window.createWebviewPanel(
      "nexus.authProfileEditor",
      "Auth Profiles",
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true }
    );
    this.render();
    this.panel.webview.onDidReceiveMessage((msg) => this.handleMessage(msg));
    this.panel.onDidDispose(() => {
      this.disposed = true;
      this.unsubscribe();
      AuthProfileEditorPanel.instance = undefined;
    });
    this.unsubscribe = core.onDidChange(() => {
      const sig = profileSignature(core.getSnapshot().authProfiles);
      if (sig !== this.lastProfileSignature) {
        this.lastProfileSignature = sig;
        this.render();
      }
    });
  }

  public static open(core: NexusCore, secretVault?: SecretVault, profileId?: string, externalCredentials?: Pick<ExternalCredentialResolver, "revoke">): void {
    const missing = profileId !== undefined && !core.getAuthProfile(profileId);
    if (missing) void vscode.window.showWarningMessage("This auth profile no longer exists. Create a profile here, then explicitly select it in the referring Auth Profile field.");
    const id = profileId !== undefined && !missing ? profileId : null;
    if (AuthProfileEditorPanel.instance) {
      AuthProfileEditorPanel.instance.panel.reveal();
      if ((id !== null || missing) && AuthProfileEditorPanel.instance.selectedId !== id) {
        void AuthProfileEditorPanel.instance.panel.webview.postMessage({ type: "requestProfileSwitch", targetValue: id ?? "__new__" });
      }
      return;
    }
    AuthProfileEditorPanel.instance = new AuthProfileEditorPanel(core, secretVault, id, externalCredentials);
  }

  public static openNew(core: NexusCore, secretVault?: SecretVault, externalCredentials?: Pick<ExternalCredentialResolver, "revoke">): void {
    if (AuthProfileEditorPanel.instance) {
      AuthProfileEditorPanel.instance.panel.reveal();
      AuthProfileEditorPanel.instance.selectedId = null;
      AuthProfileEditorPanel.instance.render();
      return;
    }
    AuthProfileEditorPanel.instance = new AuthProfileEditorPanel(core, secretVault, null, externalCredentials);
  }

  public static notifyExternalApprovals(message: string): void {
    void AuthProfileEditorPanel.instance?.panel.webview.postMessage({ type: "externalApprovalsStatus", message });
  }

  private render(justSavedName?: string): void {
    if (this.disposed) return;
    const nonce = createWebviewNonce();
    const profiles = this.core.getSnapshot().authProfiles;
    // Clamp selectedId if profile was deleted externally
    if (this.selectedId !== null && !profiles.some((p) => p.id === this.selectedId)) {
      this.selectedId = profiles.length > 0 ? profiles[0].id : null;
    }
    this.lastProfileSignature = profileSignature(profiles);
    // `justSavedName` bakes the "✓ Saved" indicator into the fresh HTML. It is set
    // ONLY by the save handler — the reload from `render()` would otherwise outrun
    // a post-render `postMessage`, which is why the old `{type:"saved"}` signal was
    // invisible. External re-renders (onDidChange, profile switch) pass nothing.
    this.panel.webview.html = renderAuthProfileEditorHtml(profiles, this.selectedId, nonce, justSavedName);
  }

  private async handleMessage(msg: Record<string, unknown>): Promise<void> {
    try {
      switch (msg.type) {
        case "selectProfile": {
          if (typeof msg.value !== "string") {
            break;
          }
          this.selectedId = msg.value === "__new__" ? null : msg.value;
          this.render();
          break;
        }
        case "confirmSwitch": {
          if (typeof msg.targetValue !== "string") {
            break;
          }
          const target = msg.targetValue;
          const answer = await vscode.window.showWarningMessage(
            "You have unsaved changes. Discard them?",
            { modal: true },
            "Discard"
          );
          if (answer === "Discard") {
            this.selectedId = target === "__new__" ? null : target;
            this.render();
          }
          break;
        }
        case "revokeExternalApprovals": {
          AuthProfileEditorPanel.notifyExternalApprovals(revokeExternalApprovals(this.externalCredentials));
          break;
        }
        case "save": {
          const name = typeof msg.name === "string" ? msg.name.trim() : "";
          const requestedId = typeof msg.id === "string" ? msg.id : null;
          const password = typeof msg.password === "string" ? msg.password : "";
          const candidate: unknown = msg.authType === "external"
            ? { id: requestedId ?? randomUUID(), name, authType: "external", external: msg.external }
            : { id: requestedId ?? randomUUID(), name, username: typeof msg.username === "string" ? msg.username.trim() : "",
                authType: msg.authType, keyPath: msg.authType === "key" && typeof msg.keyPath === "string" && msg.keyPath.trim() ? msg.keyPath.trim() : undefined };
          if (!validateAuthProfile(candidate)) {
            void this.panel.webview.postMessage({ type: "actionError", message: "Check the authentication fields. External programs require a supported method, absolute path and valid arguments." });
            break;
          }
          const profile = candidate;
          if (isExternalAuthProfile(profile) && profile.external.invocation?.argumentExpansion === true && !validateExternalArgumentTemplates(profile.external.invocation.args)) {
            void this.panel.webview.postMessage({ type: "actionError", message: "Check Arguments: use supported placeholders and close every placeholder. Escape literal placeholders with $${...}." });
            break;
          }
          const previous = requestedId ? this.core.getAuthProfile(requestedId) : undefined;
          const previousSignature = JSON.stringify(previous);
          const affected = (): string[] => {
            const snapshot = this.core.getSnapshot();
            return [
              ...snapshot.servers.filter((server) => server.ipmiAuthProfileId === requestedId).map((server) => "server:" + server.id),
              ...snapshot.deviceTemplates.filter((template) => template.fields.ipmiAuthProfileId?.value === requestedId).map((template) => "template:" + template.id)
            ].sort();
          };
          const switchingToExternal = requestedId && previous && !isExternalAuthProfile(previous) && isExternalAuthProfile(profile);
          const affectedIds = switchingToExternal ? affected() : [];
          if (affectedIds.length && await vscode.window.showWarningMessage(
            `Switch this profile to External Program? ${affectedIds.length} linked IPMI use(s) will become unavailable. External programs support SSH only. Change those IPMI Auth Profile links to restore access.`,
            { modal: true }, "Switch"
          ) !== "Switch") break;
          let refusal: string | undefined;
          // Lock order is configuration, then the shared per-secret queue. No modal or process runs here.
          await configMutationLock.runExclusive(async () => {
            const live = requestedId ? this.core.getAuthProfile(requestedId) : undefined;
            if (requestedId && !live) { refusal = `Auth profile "${name}" was deleted while you were editing it — nothing was saved. Create it again if you still need it.`; return; }
            if (JSON.stringify(live) !== previousSignature || (switchingToExternal && JSON.stringify(affected()) !== JSON.stringify(affectedIds))) {
              refusal = "The auth profile or its linked IPMI uses changed while saving. Review the profile and save again."; return;
            }
            const externalBefore = isExternalAuthProfile(live);
            const externalAfter = isExternalAuthProfile(profile);
            const passwordKey = authProfilePasswordSecretKey(profile.id);
            const passphraseKey = authProfilePassphraseSecretKey(profile.id);
            // The synchronous core mutation hook owns revocation and pool invalidation.
            // Failed earlier cleanup must never resurrect a dormant secret when stored auth is enabled.
            if (externalBefore && !externalAfter) {
              if (!this.secretVault) throw new Error("Secret storage is unavailable; the profile remains external.");
              await this.secretVault.delete(passwordKey);
              await this.secretVault.delete(passphraseKey);
            }
            await this.core.addOrUpdateAuthProfile(profile);
            if (this.secretVault) {
              if (externalAfter) {
                try { await this.secretVault.delete(passwordKey); await this.secretVault.delete(passphraseKey); }
                catch { throw new Error("External configuration was saved, but old stored secrets could not be removed. They are not used by external authentication. Save again to retry cleanup."); }
              } else if (externalBefore) {
                if (profile.authType === "password" && password) await this.secretVault.store(passwordKey, password);
              } else {
                if (profile.authType !== "password") await this.secretVault.delete(passwordKey);
                else if (password) await this.secretVault.store(passwordKey, password);
                else if (live && live.authType !== "password") await this.secretVault.delete(passwordKey);
                if (profile.authType !== "key" || live?.authType === "key" && live.keyPath !== profile.keyPath) await this.secretVault.delete(passphraseKey);
              }
            } else if (externalAfter && live && !externalBefore) {
              throw new Error("External configuration was saved, but secret storage is unavailable for removing old stored secrets. They are not used by external authentication.");
            }
          });
          if (refusal) { void vscode.window.showErrorMessage(refusal); void this.panel.webview.postMessage({ type: "actionError", message: refusal }); break; }
          this.selectedId = profile.id;
          this.render(name);
          void vscode.window.showInformationMessage(`Auth profile "${name}" saved.`);
          break;
        }
        case "delete": {
          if (typeof msg.id !== "string") {
            break;
          }
          const id = msg.id;
          const profile = this.core.getAuthProfile(id);
          if (!profile) break;

          const snapshot = this.core.getSnapshot();
          if (isExternalAuthProfile(profile)) {
            const count = snapshot.servers.filter((server) => server.authProfileId === id || server.ipmiAuthProfileId === id).length
              + snapshot.inventorySources.filter((source) => source.authProfileId === id).length
              + snapshot.deviceTemplates.filter((template) => template.fields.authProfileId?.value === id || template.fields.ipmiAuthProfileId?.value === id).length;
            if (count) { void vscode.window.showErrorMessage(`This external auth profile has ${count} linked record(s). Change or unlink those Auth Profile fields before deleting it.`); break; }
          }
          const shownDetail = describeDeleteDetail(profile, snapshot.servers, snapshot.inventorySources);
          const confirm = await vscode.window.showWarningMessage(
            shownDetail,
            { modal: true },
            "Delete"
          );
          if (confirm !== "Delete") break;

          // CONFIG MUTATION LOCK (P2 — profile deletion vs. inventory writes).
          // removeAuthProfile clears the deleted profile off every referencing
          // server and inventory source and persists those clears. Every core
          // write persists a snapshot taken synchronously at call time
          // (`[...map.values()]`) and then awaits, so an inventory write that
          // started earlier — applyInventorySyncPlan / addOrUpdateInventorySource,
          // both of which hold this same lock in inventoryCommands.ts — can
          // still be awaiting its repository write with a PRE-clear snapshot in
          // hand. If that older write commits last, both operations "succeed"
          // while disk is left holding servers/sources that reference a profile
          // that no longer exists; memory looks correct, so nothing ever
          // surfaces it. Serializing the whole disposition (vault keys first,
          // then the record + its reference clearing) against those sections is
          // what closes that window.
          //
          // WHY HERE AND NOT IN NexusCore.removeAuthProfile: AsyncMutex is not
          // re-entrant (see services/configMutationLock.ts), and two of the
          // three call sites into removeAuthProfile ALREADY hold this lock —
          // configCommands' importMergeReplaceLocked (replace-mode wipe) and
          // completeReset both run their whole mutation phase inside
          // runExclusive. Acquiring it inside the core method would deadlock the
          // extension host permanently on a backup restore or a complete reset.
          // This panel is the only lock-free path, so it is the one that has to
          // take it.
          //
          // Safe to hold across this span: the confirmation modal above has
          // already resolved and nothing below shows UI (the re-render is a
          // webview post, not a prompt), matching the "acquire after the last
          // prompt" rule the lock documents.
          let refusal: string | undefined;
          await configMutationLock.runExclusive(async () => {
            // REVIEW FINDING (P2) — re-read the disclosure AFTER the wait, not
            // just before the modal. The snapshot above is taken while another
            // flow can already be inside this lock and merely awaiting vault
            // I/O — addOrUpdateInventorySource's store loop is exactly that —
            // so it can report zero linked sources, that save can then commit
            // the link, and the deletion (queued behind it on this lock) would
            // clear a source the warning never mentioned. Rendering the
            // disclosure again HERE is the narrowest window available: once
            // this lock is held, no other lock-holding write can commit.
            //
            // ABORT, NOT RECONFIRM. inventoryCommands has both precedents —
            // syncNow loops back to the modal on planDetailDrift, editSource
            // aborts with "reopen Edit Source." — and this is the second. A
            // reconfirmation would have to release the lock to show UI (the
            // lock forbids holding it across a modal), re-acquire, and re-check,
            // i.e. syncNow's bounded retry loop; syncNow earns that machinery
            // because it has a fetched tree and completed teardowns to protect,
            // while re-running this delete is one click and rebuilds every fact
            // from scratch. For a destructive single-object delete whose
            // consequences no longer match what was consented to, doing nothing
            // and saying so is the conservative answer.
            //
            // The message is deferred rather than shown here: nothing may
            // display UI while this lock is held.
            const currentProfile = this.core.getAuthProfile(id);
            if (!currentProfile) {
              refusal = `Auth profile "${profile.name}" was deleted while the confirmation was open — nothing more was removed.`;
              return;
            }
            const current = this.core.getSnapshot();
            const currentDetail = describeDeleteDetail(currentProfile, current.servers, current.inventorySources);
            if (currentDetail !== shownDetail) {
              // Quoted by the name the modal used, not the current one: that is
              // the profile the user acted on, and a rename is one of the
              // things this catches.
              refusal = `Auth profile "${profile.name}" changed while the confirmation was open — nothing was deleted. Delete it again to review what is linked now.`;
              return;
            }

            if (isExternalAuthProfile(currentProfile)) {
              if (current.servers.some((server) => server.authProfileId === id || server.ipmiAuthProfileId === id) ||
                current.inventorySources.some((source) => source.authProfileId === id) ||
                current.deviceTemplates.some((template) => template.fields.authProfileId?.value === id || template.fields.ipmiAuthProfileId?.value === id)) {
                refusal = "This external auth profile gained linked records. Change or unlink their Auth Profile fields before deleting it."; return;
              }

            }
            if (this.secretVault) {
              await this.secretVault.delete(authProfilePasswordSecretKey(id));
              await this.secretVault.delete(authProfilePassphraseSecretKey(id));
            }
            await this.core.removeAuthProfile(id);
          });
          if (refusal !== undefined) {
            void vscode.window.showErrorMessage(refusal);
            break;
          }

          const profiles = this.core.getSnapshot().authProfiles;
          this.selectedId = profiles.length > 0 ? profiles[0].id : null;
          this.render();
          break;
        }
        case "externalExecutable": {
          const remoteRoot = vscode.workspace?.workspaceFolders?.find((folder) => folder.uri.scheme === "vscode-remote")?.uri;
          const uris = await vscode.window.showOpenDialog({ canSelectFiles: true, canSelectMany: false,
            title: "Select External Credential Executable on the Extension Host", openLabel: "Select Executable",
            defaultUri: remoteRoot ? remoteRoot.with({ path: os.homedir() }) : vscode.Uri.file(os.homedir()), filters: { "All Files": ["*"] } });
          if (!uris?.length) break;
          const uri = uris[0];
          // Remote hosts must use their own chooser authority, never a desktop file URI.
          const remote = vscode.env?.remoteName;
          const expectedAuthority = remoteRoot?.authority;
          const supported = remote ? uri.scheme === "vscode-remote" && !!expectedAuthority && uri.authority === expectedAuthority : uri.scheme === "file";
          if (!supported || !isAbsolute(uri.fsPath)) {
            void vscode.window.showErrorMessage("Choose an absolute executable path on this extension host. For remote hosts without a matching file chooser, enter the remote path in Executable."); break;
          }
          void this.panel.webview.postMessage({ type: "externalExecutableResult", path: uri.fsPath });
          break;
        }
        case "browse": {
          const uris = await vscode.window.showOpenDialog({
            canSelectFiles: true,
            canSelectMany: false,
            title: "Select SSH Private Key",
            defaultUri: vscode.Uri.file(os.homedir() + "/.ssh/"),
            openLabel: "Select Key",
            filters: { "All Files": ["*"] }
          });
          if (uris?.[0]?.fsPath) {
            void this.panel.webview.postMessage({ type: "browseResult", path: uris[0].fsPath });
          }
          break;
        }
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      void vscode.window.showErrorMessage(`Auth profile action failed: ${detail}`);
      void this.panel.webview.postMessage({ type: "actionError", message: `Auth profile action failed: ${detail}` });
    }
  }
}
