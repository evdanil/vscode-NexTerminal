import { createHash } from "node:crypto";
import * as vscode from "vscode";
import type { ServerConfig } from "../../models/config";
import type { HostKeyVerifier } from "./contracts";

/**
 * The trusted-host store: `hostIdentity` → `toFingerprint`, one flat object in
 * `globalState`. Written by this verifier on every trust decision and — since
 * the Encrypted Backup carries it — by a backup restore, which is why every
 * write below re-reads the store instead of writing back an earlier copy.
 */
export const KNOWN_HOSTS_STATE_KEY = "nexus.ssh.knownHostFingerprints.v1";

/** `SHA256:` plus the unpadded base64 of a 32-byte digest — exactly what `toFingerprint` writes. */
const FINGERPRINT_RE = /^SHA256:[A-Za-z0-9+/]{43}$/u;
/** Generous for any hostname or IPv6 literal; only here so an untrusted key cannot be arbitrarily large. */
const MAX_HOST_IDENTITY_LENGTH = 1024;
const TRUST_NEW_LABEL = "Trust and Continue";
const TRUST_REPLACE_LABEL = "Accept New Key";

function hostIdentity(server: ServerConfig): string {
  return `${server.host.toLowerCase()}:${server.port}`;
}

function toFingerprint(hostKey: Buffer): string {
  const digest = createHash("sha256").update(hostKey).digest("base64").replace(/=+$/u, "");
  return `SHA256:${digest}`;
}

/**
 * Whether `identity` has the shape `hostIdentity` produces: a lower-cased host,
 * a colon, and a TCP port. The port is split off at the LAST colon so an IPv6
 * host keeps its own colons. Anything else could never be looked up by
 * `verify` — an upper-cased host, say, is a key no connection would ever read.
 */
function isHostIdentity(identity: string): boolean {
  if (identity.length > MAX_HOST_IDENTITY_LENGTH) return false;
  const separator = identity.lastIndexOf(":");
  if (separator <= 0) return false;
  const host = identity.slice(0, separator);
  const port = identity.slice(separator + 1);
  if (!/^\d{1,5}$/u.test(port)) return false;
  const portNumber = Number(port);
  if (portNumber < 1 || portNumber > 65535) return false;
  return host === host.toLowerCase() && !/[\s\u0000-\u001f\u007f]/u.test(host);
}

/**
 * The entries of an UNTRUSTED trusted-host set (a backup's) that have exactly
 * the shape this verifier writes, or `undefined` when there is no usable set.
 * An entry of any other shape is dropped rather than repaired: a host key is a
 * trust anchor, and a guessed one is worse than none — the next connection
 * simply asks (or, under `nexus.ssh.trustNewHosts`, learns) it again.
 *
 * "No usable set" covers two cases, and a Replace restore leaves this machine's
 * keys alone for both: a value that is not a set at all, and a set that HAD
 * entries of which none survived. Answering `{}` for the second would let a
 * corrupt or hostile file wipe the whole trust store. An empty set, `{}`, is a
 * real answer — the backup of a machine that trusts nothing yet — and stays one.
 */
export function sanitizeKnownHostFingerprints(raw: unknown): Record<string, string> | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return undefined;
  }
  const entries = Object.entries(raw as Record<string, unknown>);
  // Prototype-free, like every id-keyed map a backup restores into. A valid
  // identity always ends in `:port`, so `__proto__` itself can never be one;
  // this keeps it that way should the identity rule ever loosen.
  const valid: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const [identity, fingerprint] of entries) {
    if (isHostIdentity(identity) && typeof fingerprint === "string" && FINGERPRINT_RE.test(fingerprint)) {
      valid[identity] = fingerprint;
    }
  }
  if (entries.length > 0 && Object.keys(valid).length === 0) {
    return undefined;
  }
  return valid;
}

/** This machine's trusted hosts, as a backup carries them. */
export function readKnownHostFingerprints(state: vscode.Memento): Record<string, string> {
  return sanitizeKnownHostFingerprints(state.get(KNOWN_HOSTS_STATE_KEY)) ?? {};
}

/**
 * Restores a backup's trusted hosts. `incoming` must already have been through
 * {@link sanitizeKnownHostFingerprints}.
 *
 * Merge is a union in which THIS machine's key wins wherever the two disagree,
 * and every disagreement is counted so the import can say so. Letting the
 * backup win would be silently overwriting a trust anchor: if the host really
 * rotated its key, the next connection raises the changed-key warning and the
 * user decides — which is the decision an overwrite would have taken from them.
 * Replace makes the backup's set the trusted set, as Replace does for profiles.
 *
 * The read and the write are in one synchronous stretch (no await between), so
 * a concurrent trust decision in this window cannot interleave with them.
 */
export async function restoreKnownHostFingerprints(
  state: vscode.Memento,
  incoming: Record<string, string>,
  mode: "merge" | "replace"
): Promise<{ conflicts: number }> {
  if (mode === "replace") {
    await state.update(KNOWN_HOSTS_STATE_KEY, { ...incoming });
    return { conflicts: 0 };
  }
  const stored = state.get<unknown>(KNOWN_HOSTS_STATE_KEY);
  const merged: Record<string, unknown> =
    typeof stored === "object" && stored !== null && !Array.isArray(stored) ? { ...(stored as Record<string, unknown>) } : {};
  let added = 0;
  let conflicts = 0;
  for (const [identity, fingerprint] of Object.entries(incoming)) {
    if (!Object.prototype.hasOwnProperty.call(merged, identity)) {
      merged[identity] = fingerprint;
      added++;
    } else if (merged[identity] !== fingerprint) {
      conflicts++;
    }
  }
  if (added > 0) {
    await state.update(KNOWN_HOSTS_STATE_KEY, merged);
  }
  return { conflicts };
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
      const trustNewHosts = vscode.workspace.getConfiguration("nexus.ssh").get<boolean>("trustNewHosts", true);
      if (trustNewHosts) {
        await this.trust(identity, fingerprint);
        return true;
      }
      const choice = await vscode.window.showWarningMessage(
        `First SSH connection to ${identity} (${server.name}). Host fingerprint: ${fingerprint}`,
        { modal: true },
        TRUST_NEW_LABEL
      );
      if (choice !== TRUST_NEW_LABEL) {
        return false;
      }
      await this.trust(identity, fingerprint);
      return true;
    }

    if (knownFingerprint === fingerprint) {
      return true;
    }

    const choice = await vscode.window.showWarningMessage(
      `SSH host key for "${server.name}" (${identity}) has CHANGED since the last connection.\n\n` +
      `Previously stored: ${knownFingerprint}\n` +
      `Received now: ${fingerprint}\n\n` +
      `This could mean the server was reinstalled or its keys were rotated — ` +
      `or it could indicate a man-in-the-middle (MITM) attack. ` +
      `Only continue if you trust this change.`,
      { modal: true },
      TRUST_REPLACE_LABEL
    );
    if (choice !== TRUST_REPLACE_LABEL) {
      return false;
    }

    await this.trust(identity, fingerprint);
    return true;
  }

  /**
   * Records one trust decision against the store as it is NOW, not as it was
   * when `verifyInternal` read it: the modals above can stay open for minutes,
   * and a backup restore may rewrite the store meanwhile. Writing back the
   * earlier copy would silently undo that restore.
   */
  private async trust(identity: string, fingerprint: string): Promise<void> {
    const knownHosts = this.readKnownHosts();
    knownHosts[identity] = fingerprint;
    await this.state.update(KNOWN_HOSTS_STATE_KEY, knownHosts);
  }

  private readKnownHosts(): Record<string, string> {
    const value = this.state.get<Record<string, string>>(KNOWN_HOSTS_STATE_KEY);
    if (!value || typeof value !== "object") {
      return {};
    }
    return { ...value };
  }
}
