# Hide Tree Credentials & SSH Trust-On-First-Use Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Two user-requested features: (1) setting to hide credentials next to device names in the Connectivity Hub tree, (2) auto-accept SSH fingerprints for new hosts, only prompt when fingerprint changes.

**Architecture:** Both features are setting-gated behavior changes. Feature 1 conditionally sets `description` on tree items based on a new `nexus.ui.showTreeDescriptions` boolean. Feature 2 changes `VscodeHostKeyVerifier` to silently accept unknown hosts (TOFU) gated by `nexus.ssh.trustNewHosts`, with an improved mismatch warning message.

**Tech Stack:** VS Code extension API, TypeScript, Vitest

---

### Task 1: Add `nexus.ssh.trustNewHosts` setting definition

**Files:**
- Modify: `package.json:2254` (after `nexus.ssh.multiplexing.idleTimeout`)
- Modify: `src/ui/settingsMetadata.ts:74` (after idleTimeout entry, in ssh category)

**Step 1: Add setting to package.json**

Insert after the `nexus.ssh.multiplexing.idleTimeout` block (after line 2255's closing `}`):

```json
"nexus.ssh.trustNewHosts": {
  "type": "boolean",
  "default": true,
  "order": 5.3,
  "markdownDescription": "Automatically trust SSH host keys on first connection (Trust-On-First-Use). When enabled, you will only be prompted if a host's key **changes** from what was previously stored — which may indicate a man-in-the-middle attack. Disable to be prompted for every new host."
}
```

**Step 2: Add setting to settingsMetadata.ts**

Insert after the `idleTimeout` entry (after line 74's `}`), in the ssh category:

```typescript
{
  key: "trustNewHosts",
  section: "nexus.ssh",
  label: "Trust New Hosts",
  type: "boolean",
  category: "ssh",
  description: "Auto-accept host keys on first connection. Only prompt when a key changes (possible MITM)."
},
```

**Step 3: Verify build**

Run: `npm run compile`
Expected: Clean, no errors.

**Step 4: Commit**

```
feat: add nexus.ssh.trustNewHosts setting definition
```

---

### Task 2: Implement TOFU in VscodeHostKeyVerifier

**Files:**
- Modify: `src/services/ssh/vscodeHostKeyVerifier.ts`
- Create: `test/unit/vscodeHostKeyVerifier.test.ts`

**Step 1: Write tests for the host key verifier**

Create `test/unit/vscodeHostKeyVerifier.test.ts`:

```typescript
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import { VscodeHostKeyVerifier } from "../../src/services/ssh/vscodeHostKeyVerifier";
import type { ServerConfig } from "../../src/models/config";

vi.mock("vscode", () => ({
  window: {
    showWarningMessage: vi.fn()
  },
  workspace: {
    getConfiguration: vi.fn()
  }
}));

function makeMemento(): vscode.Memento {
  const store = new Map<string, unknown>();
  return {
    keys: () => [...store.keys()],
    get: <T>(key: string, fallback?: T) => (store.get(key) as T) ?? fallback,
    update: async (key: string, value: unknown) => { store.set(key, value); }
  } as vscode.Memento;
}

function makeServer(overrides: Partial<ServerConfig> = {}): ServerConfig {
  return {
    id: "srv-1",
    name: "Test Server",
    host: "example.com",
    port: 22,
    username: "dev",
    authType: "password",
    isHidden: false,
    ...overrides
  };
}

const DUMMY_KEY = Buffer.from("ssh-rsa AAAA_dummy_key_data");
const DIFFERENT_KEY = Buffer.from("ssh-ed25519 BBBB_different_key");

describe("VscodeHostKeyVerifier TOFU", () => {
  let memento: vscode.Memento;

  beforeEach(() => {
    vi.clearAllMocks();
    memento = makeMemento();
  });

  function mockTrustNewHosts(value: boolean) {
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
      get: (key: string) => key === "trustNewHosts" ? value : undefined
    } as any);
  }

  it("silently accepts unknown host when trustNewHosts is true", async () => {
    mockTrustNewHosts(true);
    const verifier = new VscodeHostKeyVerifier(memento);
    const result = await verifier.verify(makeServer(), DUMMY_KEY);
    expect(result).toBe(true);
    expect(vscode.window.showWarningMessage).not.toHaveBeenCalled();
  });

  it("stores fingerprint after silent accept", async () => {
    mockTrustNewHosts(true);
    const verifier = new VscodeHostKeyVerifier(memento);
    await verifier.verify(makeServer(), DUMMY_KEY);
    // Second call with same key should still succeed silently
    const result = await verifier.verify(makeServer(), DUMMY_KEY);
    expect(result).toBe(true);
    expect(vscode.window.showWarningMessage).not.toHaveBeenCalled();
  });

  it("prompts for unknown host when trustNewHosts is false", async () => {
    mockTrustNewHosts(false);
    vi.mocked(vscode.window.showWarningMessage).mockResolvedValue("Trust and Continue" as any);
    const verifier = new VscodeHostKeyVerifier(memento);
    const result = await verifier.verify(makeServer(), DUMMY_KEY);
    expect(result).toBe(true);
    expect(vscode.window.showWarningMessage).toHaveBeenCalledTimes(1);
  });

  it("rejects unknown host when user cancels prompt (trustNewHosts false)", async () => {
    mockTrustNewHosts(false);
    vi.mocked(vscode.window.showWarningMessage).mockResolvedValue(undefined as any);
    const verifier = new VscodeHostKeyVerifier(memento);
    const result = await verifier.verify(makeServer(), DUMMY_KEY);
    expect(result).toBe(false);
  });

  it("always prompts when fingerprint changes (MITM warning)", async () => {
    mockTrustNewHosts(true);
    const verifier = new VscodeHostKeyVerifier(memento);
    // First: silently accept
    await verifier.verify(makeServer(), DUMMY_KEY);
    // Second: different key — must prompt
    vi.mocked(vscode.window.showWarningMessage).mockResolvedValue("Accept New Key" as any);
    const result = await verifier.verify(makeServer(), DIFFERENT_KEY);
    expect(result).toBe(true);
    expect(vscode.window.showWarningMessage).toHaveBeenCalledTimes(1);
    const msg = vi.mocked(vscode.window.showWarningMessage).mock.calls[0][0] as string;
    expect(msg).toContain("changed");
    expect(msg).toContain("man-in-the-middle");
  });

  it("rejects changed fingerprint when user cancels MITM warning", async () => {
    mockTrustNewHosts(true);
    const verifier = new VscodeHostKeyVerifier(memento);
    await verifier.verify(makeServer(), DUMMY_KEY);
    vi.mocked(vscode.window.showWarningMessage).mockResolvedValue(undefined as any);
    const result = await verifier.verify(makeServer(), DIFFERENT_KEY);
    expect(result).toBe(false);
  });

  it("accepts known host with matching fingerprint silently", async () => {
    mockTrustNewHosts(true);
    const verifier = new VscodeHostKeyVerifier(memento);
    await verifier.verify(makeServer(), DUMMY_KEY);
    vi.clearAllMocks();
    mockTrustNewHosts(true);
    const result = await verifier.verify(makeServer(), DUMMY_KEY);
    expect(result).toBe(true);
    expect(vscode.window.showWarningMessage).not.toHaveBeenCalled();
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run test/unit/vscodeHostKeyVerifier.test.ts`
Expected: Failures because `VscodeHostKeyVerifier` doesn't read the setting yet.

**Step 3: Implement TOFU in VscodeHostKeyVerifier**

Modify `src/services/ssh/vscodeHostKeyVerifier.ts`:

1. Change `TRUST_REPLACE_LABEL` from `"Replace and Continue"` to `"Accept New Key"`

2. Replace the `verifyInternal` method's unknown-host block (the `if (!knownFingerprint)` branch):

```typescript
if (!knownFingerprint) {
  const trustNewHosts = vscode.workspace.getConfiguration("nexus.ssh").get<boolean>("trustNewHosts", true);
  if (trustNewHosts) {
    knownHosts[identity] = fingerprint;
    await this.state.update(KNOWN_HOSTS_STATE_KEY, knownHosts);
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
  knownHosts[identity] = fingerprint;
  await this.state.update(KNOWN_HOSTS_STATE_KEY, knownHosts);
  return true;
}
```

3. Replace the mismatch warning message (the final `showWarningMessage` call) with an improved message:

```typescript
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
```

**Step 4: Run tests to verify they pass**

Run: `npx vitest run test/unit/vscodeHostKeyVerifier.test.ts`
Expected: All pass.

**Step 5: Commit**

```
feat: SSH trust-on-first-use with improved key-change warning
```

---

### Task 3: Add `nexus.ui.showTreeDescriptions` setting and implement

**Files:**
- Modify: `package.json:2269` (after `nexus.terminal.openLocation`)
- Modify: `src/ui/settingsMetadata.ts` (new "ui" category)
- Modify: `src/ui/nexusTreeProvider.ts:39-79` (ServerTreeItem, SerialProfileTreeItem constructors)
- Modify: `test/unit/nexusTreeProvider.test.ts`

**Step 1: Add setting to package.json**

Insert after `nexus.terminal.openLocation` block (after line 2269):

```json
"nexus.ui.showTreeDescriptions": {
  "type": "boolean",
  "default": true,
  "order": 6.1,
  "markdownDescription": "Show connection details (e.g. `user@host`) next to device names in the Connectivity Hub tree."
}
```

**Step 2: Add "ui" category to settingsMetadata.ts**

Add `"ui"` to the `SettingMeta.category` type union:
```typescript
category: "logging" | "ssh" | "tunnels" | "terminal" | "ui" | "sftp" | "highlighting";
```

Add entry before the `// --- Terminal ---` section:
```typescript
// --- UI ---
{
  key: "showTreeDescriptions",
  section: "nexus.ui",
  label: "Show Tree Descriptions",
  type: "boolean",
  category: "ui",
  description: "Show connection details (user@host) next to device names in the Connectivity Hub."
},
```

Add `"ui"` to `CATEGORY_ORDER` (before `"sftp"`):
```typescript
export const CATEGORY_ORDER = ["logging", "ssh", "tunnels", "terminal", "ui", "sftp", "highlighting"] as const;
```

Add to `CATEGORY_LABELS`:
```typescript
ui: "Interface",
```

Add to `CATEGORY_ICONS`:
```typescript
ui: "layout",
```

**Step 3: Write test for hidden descriptions**

Add to `test/unit/nexusTreeProvider.test.ts`:

```typescript
describe("NexusTreeProvider description visibility", () => {
  it("hides server description when showTreeDescriptions is false", () => {
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
      get: (key: string) => key === "showTreeDescriptions" ? false : undefined
    } as any);
    const provider = new NexusTreeProvider(noopCallbacks);
    provider.setSnapshot({ ...emptySnapshot(), servers: [makeServer()] });
    const children = provider.getChildren(undefined) as ServerTreeItem[];
    const server = children.find((c) => c instanceof ServerTreeItem);
    expect(server!.description).toBeUndefined();
  });

  it("shows server description when showTreeDescriptions is true", () => {
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
      get: (key: string) => key === "showTreeDescriptions" ? true : undefined
    } as any);
    const provider = new NexusTreeProvider(noopCallbacks);
    provider.setSnapshot({ ...emptySnapshot(), servers: [makeServer()] });
    const children = provider.getChildren(undefined) as ServerTreeItem[];
    const server = children.find((c) => c instanceof ServerTreeItem);
    expect(server!.description).toBe("dev@example.com");
  });
});
```

Note: The existing vscode mock in the test file doesn't include `workspace.getConfiguration`. It needs to be added to the mock at the top of the file:
```typescript
workspace: {
  getConfiguration: vi.fn(() => ({ get: () => undefined }))
}
```

**Step 4: Run tests to verify they fail**

Run: `npx vitest run test/unit/nexusTreeProvider.test.ts`
Expected: Fail — tree items don't read the setting yet.

**Step 5: Implement conditional descriptions**

The setting needs to be read where tree items are created. Since `ServerTreeItem` and `SerialProfileTreeItem` are plain constructors, pass a `showDescriptions` boolean from the provider.

In `nexusTreeProvider.ts`, modify `toServerItem()`:

```typescript
private toServerItem(server: ServerConfig): ServerTreeItem {
  const connected = this.snapshot.activeSessions.some((session) => session.serverId === server.id);
  const lookup = (id: string): ServerConfig | undefined => this.snapshot.servers.find((s) => s.id === id);
  const showDesc = vscode.workspace.getConfiguration("nexus.ui").get<boolean>("showTreeDescriptions", true);
  return new ServerTreeItem(server, connected, lookup, showDesc);
}
```

In `ServerTreeItem` constructor, add optional `showDescription = true` parameter:

```typescript
export class ServerTreeItem extends vscode.TreeItem {
  public constructor(
    public readonly server: ServerConfig,
    connected: boolean,
    serverLookup?: (id: string) => ServerConfig | undefined,
    showDescription = true
  ) {
    super(server.name, connected ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None);
    this.id = `server:${server.id}`;
    this.tooltip = `${server.username}@${server.host}:${server.port}${proxyTooltipSuffix(server.proxy, serverLookup)}`;
    this.description = showDescription ? `${server.username}@${server.host}` : undefined;
    this.contextValue = connected ? "nexus.serverConnected" : "nexus.server";
    // ...icon unchanged
  }
}
```

Same pattern for `toSerialProfileItem()` and `SerialProfileTreeItem`:

```typescript
private toSerialProfileItem(profile: SerialProfile): SerialProfileTreeItem {
  const connected = this.snapshot.activeSerialSessions.some((session) => session.profileId === profile.id);
  const showDesc = vscode.workspace.getConfiguration("nexus.ui").get<boolean>("showTreeDescriptions", true);
  return new SerialProfileTreeItem(profile, connected, showDesc);
}
```

```typescript
export class SerialProfileTreeItem extends vscode.TreeItem {
  public constructor(public readonly profile: SerialProfile, connected: boolean, showDescription = true) {
    // ...
    this.description = showDescription
      ? `${profile.path} @ ${profile.baudRate} (${profile.dataBits}${toParityCode(profile.parity)}${profile.stopBits})`
      : undefined;
    // ...
  }
}
```

**Step 6: Run tests to verify they pass**

Run: `npx vitest run test/unit/nexusTreeProvider.test.ts`
Expected: All pass.

**Step 7: Run full test suite**

Run: `npm test`
Expected: All pass (including settingsMetadata tests which validate category consistency).

**Step 8: Commit**

```
feat: add setting to hide credentials in Connectivity Hub tree
```

---

### Task 4: Final verification

**Step 1: Type-check**

Run: `npm run compile`
Expected: Clean.

**Step 2: Full test suite with coverage**

Run: `npm test`
Expected: All tests pass.
