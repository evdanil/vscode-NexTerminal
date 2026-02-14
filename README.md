# Nexus Terminal (VS Code Extension)
Nexus Terminal is a unified SSH + Serial command center for VS Code with a stability-first architecture:
SSH runs in-process, while Serial runs in an isolated sidecar process.

## MVP Status
- Implemented: core architecture, Command Center TreeView, Tunnel Patch Bay with drag/drop, dedicated Tunnel Monitor panel, Silent Auth, isolated tunnel forwarding, serial sidecar IPC + serial terminals, terminal/tunnel logging, unit + integration tests.
- Remaining (intentional MVP gap): full serial terminal session UX, deep traffic panel visuals, and browser-host parity.

## Quick Start
```bash
npm install
npm run build
npm test
```

To package a VSIX:
```bash
npm run package:vsix
```

## Main Commands
- `Nexus: Add Server`
- `Nexus: Connect Server`
- `Nexus: Add Tunnel`
- `Nexus: Start Tunnel`
- `Nexus: Stop Tunnel`
- `Nexus: Connect Serial Port`
- `Nexus: Disconnect Serial Session`
- `Nexus: List Serial Ports`

## Documentation
- Functional documentation: `docs/functional-documentation.md`
