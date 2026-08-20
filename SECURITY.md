# Security Policy

Nexus Terminal handles SSH credentials, serial devices, telnet sessions, port forwards, stored secrets and remote file transfers. Security reports are taken seriously, and this document explains how to make one and what to expect.

## Reporting a vulnerability

**Please do not open a public issue for a security vulnerability.**

Use GitHub's private vulnerability reporting on this repository:

**→ [Report a vulnerability](https://github.com/evdanil/vscode-NexTerminal/security/advisories/new)**

That creates a private advisory visible only to the maintainer, so the problem can be confirmed and fixed before it is public.

If private reporting is unavailable to you for any reason, open a public issue containing **only** a request for a private contact — no details of the vulnerability itself.

### What helps

You do not need a polished report. A short one that lets the problem be reproduced beats a long one that does not. If you can, include:

- What an attacker can achieve, and what access they need to start (on the network? on the local machine? able to make the user open a workspace or import a file?).
- The version of the extension, and of VS Code.
- Steps to reproduce, or a minimal proof of concept.
- Which component you believe is involved, if you know.

Please do not test against systems you do not own or have permission to test.

### What to expect

This is a small project maintained by one person, so response times are best-effort rather than contractual:

- **Acknowledgement** — normally within a few days.
- **An assessment** — whether it is confirmed, what severity it looks like, and a rough plan.
- **A fix**, released as a normal patch version, with the advisory published afterwards.
- **Credit** in the advisory if you want it. Tell us the name or handle you would like used, or say you would prefer to stay anonymous.

If you have a disclosure deadline in mind, say so in the report and it will be respected where possible — please just say it up front rather than after the fact.

## Supported versions

Fixes land on the **latest released version**, published to the VS Code Marketplace and Open VSX. There are no long-term support branches: if you are affected, updating to the current release is the remedy.

## Scope

### In scope

Anything where the extension's own behaviour puts a user at risk beyond what they asked for:

- Leakage or mishandling of credentials — SSH passwords and keys, auth profiles, API tokens for inventory providers, anything held in VS Code SecretStorage.
- Sending credentials or session data somewhere the user did not intend.
- Command, argument or path injection through server names, hostnames, file paths, macro or script content, or data imported from an inventory source.
- Path traversal or sandbox escape in file browsing, transfers, scripting APIs, or anything that serves files to a network client.
- Weakening of transport security that the user did not opt into — for example certificate verification being skipped where it was not requested.
- Code execution triggered by opening a workspace, importing a configuration file, or syncing an inventory source, without the user knowingly running something.
- Bypass of VS Code Workspace Trust gating.
- Listening on a network port, or accepting a connection, without the user having asked for it.

### Out of scope

These are known and documented properties, not vulnerabilities. Reports about them will be closed with a pointer here — though if you can show one behaving *differently from how it is documented*, that is very much in scope:

- **Telnet is cleartext.** It carries credentials and session data unencrypted, by design of the protocol. The extension says so where you enable it.
- **The self-signed / mismatched certificate opt-in** (`Allow a Self-Signed or Mismatched Certificate`) disables certificate verification for the source it is enabled on. That is its entire purpose; the exposure is documented at the point of use and repeated in every sync plan that runs with it on.
- **Config import is a trust boundary.** Importing a configuration file can add servers, jump hosts, proxies and other records. Import files you trust.
- **Scripts and macros run code you provide,** gated on Workspace Trust. A script doing what its author wrote is not a vulnerability.
- **Stored secrets are only as protected as the host.** Secrets live in VS Code SecretStorage, which relies on the operating system keychain; an attacker who already controls the user's account or machine can reach them.
- Vulnerabilities in VS Code itself, or in a remote server the extension connects to. Report those to their own maintainers.
- Findings from an automated scanner with no demonstrated impact in this codebase. A CodeQL or `npm audit` line on its own is not a report; explain what it means *here*.

## Security-relevant design notes

Useful background if you are looking at the code:

- **Credentials** are stored in VS Code SecretStorage, never in `globalState` alongside ordinary configuration, and never in exported share files.
- **Transport security is opt-out per source, never global.** The one place certificate verification can be disabled is scoped to a single inventory source, and there is exactly one place in `src/` where it is set. The process-wide `NODE_TLS_REJECT_UNAUTHORIZED` escape hatch is deliberately never used, because the extension host is shared with every other installed extension.
- **Risky components are isolated.** Native serial access runs in a child process; user scripts run in worker threads with their own V8 isolate. Anything that can crash the host or hold an OS resource is expected to follow that pattern.
- **The web build is deliberately degraded.** `dist/webExtension.js` registers stubs rather than shipping connection code to the browser.
- **Workspace Trust** gates script execution and file-system access from scripts.

## Fixes and disclosure

Confirmed vulnerabilities are fixed in a normal patch release. The advisory is published once the fix is available, with credit to the reporter unless they ask otherwise.

If a fix requires users to take action — changing a setting, rotating a credential, revoking a token — the release notes will say so plainly rather than describing the change in the abstract.
