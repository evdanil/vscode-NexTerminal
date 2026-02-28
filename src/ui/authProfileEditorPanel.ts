import { randomBytes, randomUUID } from "node:crypto";
import * as os from "node:os";
import * as vscode from "vscode";
import type { NexusCore } from "../core/nexusCore";
import type { AuthProfile, AuthType } from "../models/config";
import { authProfilePasswordSecretKey } from "../services/ssh/silentAuth";
import { renderAuthProfileEditorHtml } from "./authProfileEditorHtml";

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
  private readonly unsubscribe: () => void;
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
    const nonce = randomBytes(16).toString("base64");
    const profiles = this.core.getSnapshot().authProfiles;
    // Clamp selectedId if profile was deleted externally
    if (this.selectedId !== null && !profiles.some((p) => p.id === this.selectedId)) {
      this.selectedId = profiles.length > 0 ? profiles[0].id : null;
    }
    this.lastProfileSignature = profileSignature(profiles);
    this.panel.webview.html = renderAuthProfileEditorHtml(profiles, this.selectedId, nonce);
  }

  private async handleMessage(msg: Record<string, unknown>): Promise<void> {
    switch (msg.type) {
      case "selectProfile": {
        const value = msg.value as string;
        this.selectedId = value === "__new__" ? null : value;
        this.render();
        break;
      }
      case "confirmSwitch": {
        const target = msg.targetValue as string;
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
        const name = (msg.name as string).trim();
        const username = (msg.username as string).trim();
        if (!name || !username) {
          return;
        }
        const authType: AuthType = isAuthType(msg.authType) ? msg.authType : "password";
        const password = typeof msg.password === "string" ? msg.password : "";
        const keyPath = typeof msg.keyPath === "string" && msg.keyPath.trim() ? msg.keyPath.trim() : undefined;
        const existingId = typeof msg.id === "string" ? msg.id : null;

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
          const secretKey = authProfilePasswordSecretKey(profile.id);
          if (authType !== "password") {
            // Switching away from password auth — remove stored password
            await this.secretVault.delete(secretKey);
          } else if (password) {
            // New or updated password
            await this.secretVault.store(secretKey, password);
          } else if (existingId === null) {
            // New profile with no password — nothing to store
          } else {
            // Editing existing profile, password left blank — keep existing
            const existingProfile = this.core.getAuthProfile(existingId);
            if (existingProfile && existingProfile.authType !== "password") {
              // Was previously not password, now is — no stale secret to preserve
              await this.secretVault.delete(secretKey);
            }
            // Otherwise: existing was password, blank means keep — do nothing
          }
        }

        this.selectedId = profile.id;
        this.render();
        void this.panel.webview.postMessage({ type: "saved" });
        break;
      }
      case "delete": {
        const id = msg.id as string;
        const profile = this.core.getAuthProfile(id);
        if (!profile) break;

        const confirm = await vscode.window.showWarningMessage(
          `Delete auth profile "${profile.name}"?`,
          { modal: true },
          "Delete"
        );
        if (confirm !== "Delete") break;

        if (this.secretVault) {
          await this.secretVault.delete(authProfilePasswordSecretKey(id));
        }
        await this.core.removeAuthProfile(id);

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
  }
}
