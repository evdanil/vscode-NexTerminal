import { randomUUID } from "node:crypto";
import * as os from "node:os";
import * as vscode from "vscode";
import type { NexusCore } from "../core/nexusCore";
import type { AuthProfile, AuthType } from "../models/config";
import { configMutationLock } from "../services/configMutationLock";
import { authProfilePassphraseSecretKey, authProfilePasswordSecretKey } from "../services/ssh/silentAuth";
import { renderAuthProfileEditorHtml } from "./authProfileEditorHtml";
import { createWebviewNonce } from "./shared/webviewNonce";

interface SecretVault {
  get(key: string): Promise<string | undefined>;
  store(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

const VALID_AUTH_TYPES = new Set<string>(["password", "key", "agent"]);
function isAuthType(value: unknown): value is AuthType {
  return typeof value === "string" && VALID_AUTH_TYPES.has(value);
}

function profileSignature(profiles: AuthProfile[]): string {
  return profiles.map((p) => `${p.id}:${p.name}:${p.username}:${p.authType}:${p.keyPath ?? ""}`).join("|");
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

  private constructor(core: NexusCore, secretVault: SecretVault | undefined, initialId: string | null) {
    this.core = core;
    this.secretVault = secretVault;
    this.selectedId = initialId;
    this.lastProfileSignature = profileSignature(core.getSnapshot().authProfiles);
    this.panel = vscode.window.createWebviewPanel(
      "nexus.authProfileEditor",
      "Auth Profile Editor",
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

  public static open(core: NexusCore, secretVault?: SecretVault, profileId?: string): void {
    const id = profileId !== undefined ? profileId : null;
    if (AuthProfileEditorPanel.instance) {
      AuthProfileEditorPanel.instance.panel.reveal();
      if (id !== null) {
        AuthProfileEditorPanel.instance.selectedId = id;
        AuthProfileEditorPanel.instance.render();
      }
      return;
    }
    AuthProfileEditorPanel.instance = new AuthProfileEditorPanel(core, secretVault, id);
  }

  public static openNew(core: NexusCore, secretVault?: SecretVault): void {
    if (AuthProfileEditorPanel.instance) {
      AuthProfileEditorPanel.instance.panel.reveal();
      AuthProfileEditorPanel.instance.selectedId = null;
      AuthProfileEditorPanel.instance.render();
      return;
    }
    AuthProfileEditorPanel.instance = new AuthProfileEditorPanel(core, secretVault, null);
  }

  private render(): void {
    if (this.disposed) return;
    const nonce = createWebviewNonce();
    const profiles = this.core.getSnapshot().authProfiles;
    // Clamp selectedId if profile was deleted externally
    if (this.selectedId !== null && !profiles.some((p) => p.id === this.selectedId)) {
      this.selectedId = profiles.length > 0 ? profiles[0].id : null;
    }
    this.lastProfileSignature = profileSignature(profiles);
    this.panel.webview.html = renderAuthProfileEditorHtml(profiles, this.selectedId, nonce);
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
        case "save": {
          const name = typeof msg.name === "string" ? msg.name.trim() : "";
          const username = typeof msg.username === "string" ? msg.username.trim() : "";
          if (!name || !username) {
            break;
          }
          const authType: AuthType = isAuthType(msg.authType) ? msg.authType : "password";
          const password = typeof msg.password === "string" ? msg.password : "";
          const keyPath = typeof msg.keyPath === "string" && msg.keyPath.trim() ? msg.keyPath.trim() : undefined;
          const requestedId = typeof msg.id === "string" ? msg.id : null;
          const previousProfile = requestedId ? this.core.getAuthProfile(requestedId) : undefined;
          const existingId = previousProfile ? requestedId : null;

          const profile: AuthProfile = {
            id: existingId ?? randomUUID(),
            name,
            username,
            authType,
            keyPath: authType === "key" ? keyPath : undefined
          };

          await this.core.addOrUpdateAuthProfile(profile);

          // Handle password in SecretVault
          if (this.secretVault) {
            const passwordKey = authProfilePasswordSecretKey(profile.id);
            const passphraseKey = authProfilePassphraseSecretKey(profile.id);
            if (authType !== "password") {
              // Switching away from password auth — remove stored password
              await this.secretVault.delete(passwordKey);
            } else if (password) {
              // New or updated password
              await this.secretVault.store(passwordKey, password);
            } else if (existingId !== null && previousProfile && previousProfile.authType !== "password") {
              // Switching to password auth with no password should not retain stale secret.
              await this.secretVault.delete(passwordKey);
            }

            if (authType !== "key") {
              await this.secretVault.delete(passphraseKey);
            }
          }

          this.selectedId = profile.id;
          this.render();
          void this.panel.webview.postMessage({ type: "saved" });
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
          const linkedCount = snapshot.servers.filter(
            (s) => s.authProfileId === id
          ).length;
          const linkedNote = linkedCount > 0
            ? ` ${linkedCount} server(s) are linked and will revert to their own stored credentials.`
            : "";
          // Inventory sources link a profile too, and this delete silently
          // clears that link (NexusCore.removeAuthProfile). Afterwards nothing
          // else says so: the sync engine sees a plain profile-less source, so
          // its dangling-profile warning never fires either, and the next
          // device synced arrives on the default username + SSH agent — broken
          // on password/key infrastructure, with no signal anywhere. This
          // sentence is the only disclosure, so it has to be here.
          const linkedSourceCount = snapshot.inventorySources.filter(
            (s) => s.authProfileId === id
          ).length;
          const sourceNote = linkedSourceCount > 0
            ? ` ${linkedSourceCount} inventory source${linkedSourceCount === 1 ? " is" : "s are"} linked; servers ${linkedSourceCount === 1 ? "it syncs" : "they sync"} will use the default username with SSH agent authentication.`
            : "";
          const confirm = await vscode.window.showWarningMessage(
            `Delete auth profile "${profile.name}"?${linkedNote}${sourceNote}`,
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
          await configMutationLock.runExclusive(async () => {
            if (this.secretVault) {
              await this.secretVault.delete(authProfilePasswordSecretKey(id));
              await this.secretVault.delete(authProfilePassphraseSecretKey(id));
            }
            await this.core.removeAuthProfile(id);
          });

          const profiles = this.core.getSnapshot().authProfiles;
          this.selectedId = profiles.length > 0 ? profiles[0].id : null;
          this.render();
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
    }
  }
}
