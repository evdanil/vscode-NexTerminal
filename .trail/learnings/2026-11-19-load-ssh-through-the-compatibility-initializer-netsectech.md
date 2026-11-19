---
title: Load SSH through the compatibility initializer before credential parsing
author: NetSecTech
date: 2026-11-19
branch: fix/ssh-legacy-dh-load-order
id: l-61f87f8f
scope: repo
status: active
src: agent
touches:
  - AGENTS.md
  - CHANGELOG.md
  - docs/functional-documentation.md
  - docs/ssh-and-telnet.md
  - package-lock.json
  - package.json
  - src/extension.ts
  - src/services/credentials/externalCredentialProtocol.ts
  - src/services/ssh/externalSshAuthentication.ts
  - src/services/ssh/ssh2Connector.ts
---

## Decided

Use one runtime entry point for ssh2 so the Electron Diffie–Hellman shim wraps the lookup before ssh2 loads and restores the shared crypto export immediately afterward. Type-only imports can still come directly from ssh2.

## Tried and ruled out

The original connector-first integration test passed even while the desktop bundle failed. External credential parsing loads earlier during activation. A direct ssh2 import there made its key exchange code capture the unwrapped lookup before the connector ran, reproducing Unknown DH group with a Group 1 server.

## Watch out

Importing the credential parser first is part of the regression test. A new direct runtime import from ssh2 can bypass the initializer even if the connector still imports it. The legacy algorithm setting controls negotiation and cannot fix a named-group lookup.

In the code: src/services/ssh/ssh2Runtime.ts, src/services/credentials/externalCredentialProtocol.ts, test/integration/sshDhGroupCompat.integration.test.ts.
