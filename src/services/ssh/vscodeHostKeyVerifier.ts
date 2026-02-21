import { createHash } from "node:crypto";
import * as vscode from "vscode";
import type { ServerConfig } from "../../models/config";
import type { HostKeyVerifier } from "./contracts";

const KNOWN_HOSTS_STATE_KEY = "nexus.ssh.knownHostFingerprints.v1";
const TRUST_NEW_LABEL = "Trust and Continue";
const TRUST_REPLACE_LABEL = "Replace and Continue";

function hostIdentity(server: ServerConfig): string {
  return `${server.host.toLowerCase()}:${server.port}`;
}

function toFingerprint(hostKey: Buffer): string {
  const digest = createHash("sha256").update(hostKey).digest("base64").replace(/=+$/u, "");
  return `SHA256:${digest}`;
}

export class VscodeHostKeyVerifier implements HostKeyVerifier {
  private readonly pendingByHost = new Map<string, Promise<boolean>>();

  public constructor(private readonly state: vscode.Memento) {}

  public async verify(server: ServerConfig, hostKey: Buffer): Promise<boolean> {
    const identity = hostIdentity(server);
    const existing = this.pendingByHost.get(identity);
    if (existing) {
      return existing;
    }
    const task = this.verifyInternal(server, hostKey).finally(() => {
      this.pendingByHost.delete(identity);
    });
    this.pendingByHost.set(identity, task);
    return task;
  }

  private async verifyInternal(server: ServerConfig, hostKey: Buffer): Promise<boolean> {
    const identity = hostIdentity(server);
    const fingerprint = toFingerprint(hostKey);
    const knownHosts = this.readKnownHosts();
    const knownFingerprint = knownHosts[identity];

    if (!knownFingerprint) {
      const choice = await vscode.window.showWarningMessage(
        `First SSH connection to ${identity} (${server.name}). Host fingerprint: ${fingerprint}`,
        { modal: true },
        TRUST_NEW_LABEL
      );
      if (choice !== TRUST_NEW_LABEL) {
        return false;
      }
      knownHosts[identity] = fingerprint;
      await this.state.update(KNOWN_HOSTS_STATE_KEY, knownHosts);
      return true;
    }

    if (knownFingerprint === fingerprint) {
      return true;
    }

    const choice = await vscode.window.showWarningMessage(
      `SSH host key mismatch for ${identity}. Expected ${knownFingerprint} but got ${fingerprint}. This may indicate a MITM attack or host key rotation.`,
      { modal: true },
      TRUST_REPLACE_LABEL
    );
    if (choice !== TRUST_REPLACE_LABEL) {
      return false;
    }

    knownHosts[identity] = fingerprint;
    await this.state.update(KNOWN_HOSTS_STATE_KEY, knownHosts);
    return true;
  }

  private readKnownHosts(): Record<string, string> {
    const value = this.state.get<Record<string, string>>(KNOWN_HOSTS_STATE_KEY);
    if (!value || typeof value !== "object") {
      return {};
    }
    return { ...value };
  }
}
