import type { HttpConnectProxy, ProxyConfig, ServerConfig, Socks5Proxy } from "../../models/config";
import type { SecretVault } from "../ssh/contracts";
import { proxyPasswordSecretKey } from "../ssh/silentAuth";

/**
 * PROXY-SECRET HYGIENE — the ONE shared rule for clearing a stale per-server
 * `proxy-password-{id}` secret when a proxy config write moves the server's
 * proxy identity AWAY from the authenticated SOCKS5/HTTP endpoint that secret
 * was entered for, BEFORE the write publishes the new proxy.
 *
 * FIX A (issue #48 PR-T1b / PR #62 Codex review round 2) — EXTRACTED here so
 * BOTH writers of proxy config share a single guard rather than each patching
 * its own corner. The original home was `inventoryCommands.ts` (sync path); the
 * manual device-template apply (`deviceTemplateCommands.ts`,
 * `nexus.deviceTemplate.applyToFolder`) is the SECOND caller and was leaking a
 * stale password by publishing a new proxy without this clear. The behavior
 * below is byte-for-byte the round-9/10/11/12 sync-path implementation; the two
 * callers now route through this one module. Kept free of `vscode` so it lives
 * cleanly beside the sync engine and stays unit-testable.
 *
 * FIX B (issue #48 PR-T1 / PR #61 Codex review rounds 9+10, SECURITY) — clear the
 * stale per-server `proxy-password-{id}` when an inventory update moves the
 * server's proxy identity AWAY from the authenticated SOCKS5/HTTP endpoint that
 * secret was entered for, BEFORE the apply publishes the new proxy.
 *
 * `ProxySshFactory` reads `proxy-password-{serverId}` by server id and sends it
 * to whatever proxy the record now names whenever that proxy carries a username.
 * A device template that repoints a server's proxy from one authenticated
 * socks5/http endpoint to a DIFFERENT one — or to an ssh/none proxy — leaves the
 * OLD password in the vault, so the factory would send the old proxy's password
 * to the NEW endpoint: a credential leak to the wrong host.
 *
 * ROUND 10 — WHY BEFORE THE APPLY, NOT AFTER. `nexus.server.connect` deliberately
 * does NOT take `configMutationLock` (out of scope to change — a much larger
 * refactor). Round 9 cleared the secret AFTER `applyInventorySyncPlan` had already
 * published the new proxy into the core map: a connect landing in the awaited
 * apply/save/cleanup window would read the NEW proxy config with the OLD
 * `proxy-password-{id}` still in the vault and send it to the new endpoint — the
 * exact leak, only now through a race instead of a persistent stale key. Because
 * connect can't be serialized against the apply, the ONLY way to close the window
 * is to delete the stale secret BEFORE the new proxy becomes reachable. Moving the
 * delete before publish shrinks the worst case from a credential leak to at most a
 * transient "old proxy can't authenticate until the next connect prompt" window —
 * the fail-SAFE direction.
 *
 * FAIL CLOSED ON DELETE, RESTORE ON APPLY FAILURE. The delete is security-critical,
 * so it must NOT be best-effort: if `vault.delete` throws we cannot secure the
 * proxy change, so we restore any secret already deleted in this pass and rethrow
 * to ABORT the whole apply (the new proxy is never published) — fail closed, not
 * open. Conversely, when the delete succeeds but the apply then throws, the plan
 * did NOT commit: the OLD proxy config is still live and still needs its password,
 * so the caller restores the captured values (best-effort). Ordering is therefore:
 * capture+delete → publish → restore-on-failure.
 *
 * §5.3 of the device-template design: templates never carry proxy SECRETS — a
 * template-set socks5/http proxy relies on the per-connect prompt — so clearing
 * the stale secret is exactly right: the new proxy prompts per-connect rather
 * than reusing a password meant for a different endpoint.
 *
 * STALE (must be cleared) iff EITHER `before.proxy` OR `after.proxy` is a
 * password-bearing (`socks5`|`http`) endpoint AND the two are NOT the SAME
 * authenticated endpoint (same `type`+`host`+`port`+`username` — the identity
 * the password was entered for). The SAME-endpoint case KEEPS the secret — it
 * still applies. An ssh proxy never carries a password, so ssh↔ssh (and any
 * neither-side-bearing update, e.g. undefined↔ssh) needs no handling; a change
 * FROM socks5/http TO ssh/none clears the stale secret.
 *
 * ROUND 11 — WHY THE `after`-SIDE TRIGGER, not just `before`. A non-password-bearing
 * `before.proxy` (undefined or ssh) does NOT prove no `proxy-password-{id}` secret
 * exists: `configCommands.ts` restores every exported proxy password for an imported
 * server id WITHOUT requiring that server to currently carry a socks5/http proxy, so
 * a legacy backup can leave an ORPHANED entry sitting under an undefined/ssh proxy.
 * If a template then assigns that server a NEW authenticated socks5/http endpoint, a
 * `before`-only rule would early-return (before isn't password-bearing) and SKIP the
 * clear — sending the orphaned password to the new proxy. Triggering on EITHER side
 * closes that leak. It is a strict SUPERSET of the round-9 rule (every case it
 * cleared, this clears), and because the capture step reads the vault value first,
 * an update that newly matches but has no stored secret captures nothing and deletes
 * nothing — broadening the trigger costs nothing where there is no orphan.
 *
 * ROUND 12 — ALSO covers the plan's ADDS, not just its updates. A delete-pruned
 * device whose best-effort `proxy-password-{id}` delete FAILED can reappear as an
 * ADD under the same reused deterministic id; treating an add's `before` as "no
 * proxy" (undefined) makes the EITHER-side rule fire exactly when the add's proxy
 * is a password-bearing socks5/http endpoint, clearing the orphan before the add
 * is published. See the inline note on the helper for the reuse mechanism.
 *
 * Centralized so EVERY proxy-config writer shares one rule — invoked before the
 * fast-path recompute apply, the in-lock confirmed sync apply, AND the manual
 * device-template folder apply. Deliberately NOT the server-form
 * `syncProxyPasswordSecret` path — that governs hand-edited proxies and bypasses
 * these apply flows entirely.
 *
 * Returns the `{key,value}` pairs it captured+deleted so the caller can restore
 * them if the subsequent apply throws. On any delete error it restores what it
 * already deleted in this pass (capture-delete atomicity — a mid-loop failure
 * must not strip a password with no publish and no restore) and rethrows.
 */

/** One captured proxy-password secret, held so a failed apply can put it back. */
export interface CapturedProxyPasswordSecret {
  key: string;
  value: string;
}

/**
 * A `proxy-password-{id}` secret only ever belongs to a `socks5`/`http` proxy —
 * the only kinds `ProxySshFactory` sends it to (an ssh jump proxy carries no
 * password). Narrows to that authenticated shape so both sides of an update can
 * be compared by identity below.
 */
export function isPasswordBearingProxy(proxy: ProxyConfig | undefined): proxy is Socks5Proxy | HttpConnectProxy {
  return proxy !== undefined && (proxy.type === "socks5" || proxy.type === "http");
}

/**
 * Whether `before` and `after` are the SAME authenticated (socks5/http) endpoint —
 * same `type`+`host`+`port`+`username`, the identity the stored password was
 * entered for. This is the ONE case a proxy update KEEPS the secret: it still
 * applies. Both sides must be password-bearing to be "the same endpoint"; an
 * ssh/none on either side is never equal to a socks5/http one.
 */
export function isSameAuthenticatedEndpoint(before: ProxyConfig | undefined, after: ProxyConfig | undefined): boolean {
  return (
    isPasswordBearingProxy(before) &&
    isPasswordBearingProxy(after) &&
    before.type === after.type &&
    before.host === after.host &&
    before.port === after.port &&
    before.username === after.username
  );
}

export async function clearStaleProxyPasswordSecretsBeforeApply(
  vault: SecretVault,
  updates: ReadonlyArray<{ before: ServerConfig; after: ServerConfig }>,
  adds: ReadonlyArray<ServerConfig> = []
): Promise<CapturedProxyPasswordSecret[]> {
  // ROUND 12 — ADDS are scanned too, not just updates. Deterministic server ids
  // are REUSED, and the delete-prune path clears `proxy-password-{id}` only
  // best-effort — so a device delete-pruned with a FAILED secret delete can
  // reappear as an ADD under the same id with the orphaned password still in the
  // vault. A template can add it with a NEW authenticated socks5/http endpoint,
  // and the first connect would send the orphan there. An add has no prior
  // proxy, so its `before` is "no proxy" (undefined): the round-11 EITHER-side
  // rule then fires exactly when the add's proxy is password-bearing. A fresh
  // sync-added server never legitimately stores a proxy password (templates
  // prompt per-connect, §5.3), so any secret under its id is an orphan — clearing
  // it is correct.
  const entries: Array<{ id: string; beforeProxy: ProxyConfig | undefined; afterProxy: ProxyConfig | undefined }> = [];
  for (const { before, after } of updates) {
    // before.id === after.id (same record through an update); use after.id.
    entries.push({ id: after.id, beforeProxy: before.proxy, afterProxy: after.proxy });
  }
  for (const add of adds) {
    entries.push({ id: add.id, beforeProxy: undefined, afterProxy: add.proxy });
  }
  const captured: CapturedProxyPasswordSecret[] = [];
  for (const { id, beforeProxy: bp, afterProxy: ap } of entries) {
    // ROUND 11 — trigger on EITHER side being a password-bearing endpoint. A
    // non-password-bearing `before.proxy` does NOT prove no secret exists (an
    // orphaned legacy-backup entry can sit under an undefined/ssh proxy, and an
    // add's `before` is always undefined), so an `after`-side authenticated
    // endpoint must trigger the clear too — see the function doc for why.
    if (!isPasswordBearingProxy(bp) && !isPasswordBearingProxy(ap)) {
      continue; // neither side carries a proxy password — nothing to leak (ssh proxies never send one)
    }
    if (isSameAuthenticatedEndpoint(bp, ap)) {
      continue; // still the same authenticated endpoint — the stored password still applies
    }
    const key = proxyPasswordSecretKey(id);
    let existing: string | undefined;
    try {
      existing = await vault.get(key);
    } catch (error) {
      // Cannot even read the secret — restore what we've deleted so far, abort.
      await restoreProxyPasswordSecrets(vault, captured);
      throw error;
    }
    // Capture BEFORE the delete so an aborting delete restores this key too (the
    // delete may have partially applied; restoring the old value is fail-safe).
    if (existing !== undefined) {
      captured.push({ key, value: existing });
    }
    try {
      await vault.delete(key);
    } catch (error) {
      // FAIL CLOSED — a proxy change we cannot secure must not be published.
      await restoreProxyPasswordSecrets(vault, captured);
      throw error;
    }
  }
  return captured;
}

/**
 * ROUND 10 — put back the proxy-password secrets captured by
 * `clearStaleProxyPasswordSecretsBeforeApply` when the apply they preceded did
 * NOT commit (or a mid-pass delete aborted). The old proxy config is still live
 * and still needs its password, so restoring is the fail-safe recovery. Best
 * effort per key: a failed restore here costs at most a re-prompt on the next
 * connect, and must not mask the original failure that triggered the restore.
 */
export async function restoreProxyPasswordSecrets(
  vault: SecretVault,
  captured: ReadonlyArray<CapturedProxyPasswordSecret>
): Promise<void> {
  for (const { key, value } of captured) {
    try {
      await vault.store(key, value);
    } catch (error) {
      console.warn(`[Nexus] Failed to restore proxy password secret "${key}":`, error);
    }
  }
}
