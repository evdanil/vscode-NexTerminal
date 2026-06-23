import * as vscode from "vscode";
import type { ServerConfig, SerialProfile, LocalShellProfile } from "../models/config";
import type { NexusCore } from "../core/nexusCore";

// ---------------------------------------------------------------------------
// Pure parser — no VS Code UI side effects, fully unit-testable.
// ---------------------------------------------------------------------------

export type ParsedNexusUri =
  | { name?: string; id?: string; sftp: boolean }
  | { error: string };

/**
 * Parse a `vscode://sentriflow.vscode-nexterminal/<path>[?query]` URI.
 *
 * - Path segment (URL-decoded, leading `/` stripped) → profile name.
 * - `?id=<uuid>` → exact id; takes precedence over name during resolution.
 * - `?sftp` (presence-only) → request the SFTP File Explorer (SSH only).
 * - Empty path AND no `id` → `{ error: "…" }`.
 *
 * The profile KIND (ssh / serial / localShell) is NOT encoded in the URI — it
 * is derived from which saved profile the name/id resolves to.
 */
export function parseNexusUri(uri: vscode.Uri): ParsedNexusUri {
  // Strip leading/trailing slash and URL-decode the name from the path.
  const rawPath = uri.path.replace(/^\//, "").replace(/\/$/, "");
  const name = rawPath ? decodeURIComponent(rawPath) : undefined;

  const params = new URLSearchParams(uri.query ?? "");

  const id = params.get("id") ?? undefined;
  const sftp =
    params.has("sftp") ||
    params.get("sftp") === "1" ||
    params.get("sftp") === "";

  if (!name && !id) {
    return { error: "no profile name or id in URI" };
  }

  return { name, id, sftp };
}

// ---------------------------------------------------------------------------
// Pure resolver — operates over the snapshot collections, no VS Code calls.
// ---------------------------------------------------------------------------

export type ProfileKind = "ssh" | "serial" | "localShell";

export interface ResolveProfileResult {
  profile?: ServerConfig | SerialProfile | LocalShellProfile;
  kind?: ProfileKind;
  ambiguous: boolean;
}

interface ProfileCollections {
  servers: ServerConfig[];
  serialProfiles: SerialProfile[];
  localShellProfiles: LocalShellProfile[];
}

interface KindedProfile {
  profile: ServerConfig | SerialProfile | LocalShellProfile;
  kind: ProfileKind;
}

/**
 * Flatten the three profile collections into one list, preserving the
 * deterministic kind order: ssh → serial → localShell.
 */
function flattenProfiles(collections: ProfileCollections): KindedProfile[] {
  return [
    ...collections.servers.map((p) => ({ profile: p, kind: "ssh" as const })),
    ...collections.serialProfiles.map((p) => ({ profile: p, kind: "serial" as const })),
    ...collections.localShellProfiles.map((p) => ({ profile: p, kind: "localShell" as const }))
  ];
}

/**
 * Resolve a profile identifier to a saved profile of any kind.
 *
 * Resolution order:
 *  1. If `ident.id` is provided, exact `id` match across ALL three collections
 *     in deterministic order (ssh → serial → localShell).
 *  2. Otherwise case-insensitive `name` match across all three collections.
 *
 * When more than one profile (across ANY type) matches by name, `ambiguous` is
 * `true` and the first match in deterministic order is returned.
 */
export function resolveProfile(
  collections: ProfileCollections,
  ident: { id?: string; name?: string }
): ResolveProfileResult {
  const all = flattenProfiles(collections);

  // Exact id match always wins.
  if (ident.id) {
    const match = all.find((entry) => entry.profile.id === ident.id);
    if (!match) {
      return { profile: undefined, kind: undefined, ambiguous: false };
    }
    return { profile: match.profile, kind: match.kind, ambiguous: false };
  }

  // Case-insensitive name match across all kinds.
  if (ident.name) {
    const lower = ident.name.toLowerCase();
    const matches = all.filter((entry) => entry.profile.name.toLowerCase() === lower);
    if (matches.length === 0) {
      return { profile: undefined, kind: undefined, ambiguous: false };
    }
    return { profile: matches[0].profile, kind: matches[0].kind, ambiguous: matches.length > 1 };
  }

  return { profile: undefined, kind: undefined, ambiguous: false };
}

// ---------------------------------------------------------------------------
// Handler factory — all vscode API calls are here, not in pure helpers.
// ---------------------------------------------------------------------------

export interface NexusUriHandlerDeps {
  core: NexusCore;
}

/**
 * Create a `vscode.UriHandler` that opens any saved Nexus profile — SSH,
 * Serial, or Local Shell — from a
 * `vscode://sentriflow.vscode-nexterminal/<name>[?sftp][?id=<uuid>]` URI.
 *
 * Security: the handler acts ONLY on existing saved profiles; the URI is never
 * used to build a connection target — path/query are lookup keys only.
 */
export function createNexusUriHandler(deps: NexusUriHandlerDeps): vscode.UriHandler {
  return {
    async handleUri(uri: vscode.Uri): Promise<void> {
      const parsed = parseNexusUri(uri);

      if ("error" in parsed) {
        void vscode.window.showErrorMessage(`Nexus: ${parsed.error}`);
        return;
      }

      const { name, id, sftp } = parsed;
      const snapshot = deps.core.getSnapshot();
      const { profile, kind, ambiguous } = resolveProfile(
        {
          servers: snapshot.servers,
          serialProfiles: snapshot.serialProfiles,
          localShellProfiles: snapshot.localShellProfiles
        },
        { id, name }
      );

      if (!profile || !kind) {
        const label = id ? `id "${id}"` : `name "${name}"`;
        void vscode.window.showErrorMessage(`Nexus: no profile matching ${label}`);
        return;
      }

      // SFTP is an SSH-only feature.
      if (sftp && kind !== "ssh") {
        void vscode.window.showErrorMessage("Nexus: SFTP is only available for SSH profiles.");
        return;
      }

      if (ambiguous) {
        void vscode.window.showWarningMessage(
          `Nexus: multiple profiles named "${name}" — using the first match. ` +
          `Use ?id=${profile.id} to open this profile unambiguously.`
        );
      }

      switch (kind) {
        case "ssh":
          await vscode.commands.executeCommand("nexus.server.connect", profile.id);
          if (sftp) {
            // Connect first (establishes the SSH session), then open the File
            // Explorer. browseServerFiles creates its own SFTP connection via
            // ctx.sftpService.connect(), independent of the SSH terminal — so
            // there is no readiness race; the await just orders the UI.
            await vscode.commands.executeCommand("nexus.files.browse", profile.id);
          }
          break;
        case "serial":
          await vscode.commands.executeCommand("nexus.serial.connect", profile.id);
          break;
        case "localShell":
          await vscode.commands.executeCommand("nexus.localShell.connect", profile.id);
          break;
      }
    }
  };
}
