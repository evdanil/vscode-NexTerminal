# Release Checklist

Maintainer-only checklist for shipping a new Nexus Terminal extension release.

## Prerequisites

- **VS Code Marketplace PAT** with publisher rights (used by `vsce publish`).
- **Open VSX PAT** with publish rights (used by `ovsx publish`).
- CI secrets configured in **GitHub Actions repository secrets**:
  - `VSCE_PAT` for Marketplace publishing.
  - `OVSX_PAT` for Open VSX publishing.

## Ordered Release Steps

1. **Bump `package.json` version**
   ```bash
   npm version <major|minor|patch>
   ```
2. **Update `CHANGELOG.md`**
   - Add a new section for the exact version from `package.json`.
3. **Run build/package commands** (matching repo scripts)
   ```bash
   npm run build
   npm run build:production
   npm run package:vsix
   ```
4. **Validate the produced `.vsix`**
   ```bash
   VSIX_FILE=$(ls *.vsix)
   unzip -l "$VSIX_FILE" | grep -c "serialport"
   unzip -l "$VSIX_FILE" | grep "prebuilds.*\.node"
   ```
5. **Publish to both registries**
   ```bash
   npx @vscode/vsce publish --packagePath *.vsix --pat "$VSCE_PAT"
   npm run publish:ovsx
   ```
6. **Verify listing pages**
   - VS Code Marketplace: confirm latest version/changelog is visible.
   - Open VSX: confirm latest version/changelog is visible.
