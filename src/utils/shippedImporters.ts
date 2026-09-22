/**
 * THE one place the import formats Nexus ships are named for the surfaces that
 * have to list them.
 *
 * Modelled on `builtInProviders.ts`, and for the same reason it exists: the
 * Command Center's welcome view carries a line reading
 * `Import Servers (CSV, MobaXterm, SecureCRT…)`, and that list was hand-written
 * in `package.json` with a hand-written check beside it. A hand-maintained
 * expectation can only verify the entries someone remembered to add — which is
 * exactly how Proxmox shipped as an inventory provider that no entry point
 * named, and how an importer shipped here would go unnamed on the one line a
 * first-run user reads before anything else exists in their tree.
 *
 * `packageContributions.test.ts` derives BOTH halves of its welcome-line check
 * from this array: every name here must appear on the line, and nothing on the
 * line may be a name that is not here (the absence pin — which is what catches
 * a stale name left behind by a removed importer, something an
 * include-everyone check cannot see).
 *
 * Kept `vscode`-free on purpose: `packageContributions.test.ts` has no vscode
 * mock, so a module it imports must not reach for the extension host.
 *
 * SHORT NAMES, not command titles: this is what a user scanning one line
 * recognizes their old client by. Add an importer, add its name here.
 */
export const SHIPPED_IMPORTER_NAMES = ["CSV", "MobaXterm", "SecureCRT", "SSH Config"] as const;

export type ShippedImporterName = (typeof SHIPPED_IMPORTER_NAMES)[number];
