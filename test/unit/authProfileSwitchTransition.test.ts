import { describe, expect, it, vi } from "vitest";
import { inventorySourceFormDefinition, serverFormDefinition } from "../../src/ui/formDefinitions";
import type { FormValues } from "../../src/ui/formTypes";
import { openForm, type FormHarness } from "../helpers/formScriptHarness";
import type { AuthProfile, ServerConfig } from "../../src/models/config";
import { authProfileOwnedCredentials, formOfferedServerCredentials } from "../../src/models/config";
import type { InventoryProvider } from "../../src/models/inventory";
import {
  authProfileCredentialMirror,
  formValuesToServer,
  preserveLinkedServerCredentials
} from "../../src/commands/serverCommands";
import { SilentAuthSshFactory } from "../../src/services/ssh/silentAuth";
import type { PasswordPrompt, SecretVault, SshConnection, SshConnector } from "../../src/services/ssh/contracts";

vi.mock("vscode", () => ({
  commands: {
    registerCommand: vi.fn(() => ({ dispose: vi.fn() })),
    executeCommand: vi.fn()
  },
  window: {
    showWarningMessage: vi.fn(),
    showQuickPick: vi.fn(),
    showInformationMessage: vi.fn(),
    showErrorMessage: vi.fn(),
    showInputBox: vi.fn(),
    showOpenDialog: vi.fn(),
    withProgress: vi.fn(),
    createTerminal: vi.fn(() => ({ show: vi.fn(), dispose: vi.fn() })),
    activeTerminal: undefined as unknown
  },
  env: { clipboard: { writeText: vi.fn() } },
  workspace: {
    getConfiguration: vi.fn(() => ({ get: vi.fn(() => true) }))
  },
  Uri: { file: (path: string) => ({ fsPath: path, scheme: "file" }) },
  ProgressLocation: { Notification: 15 },
  TerminalLocation: { Editor: 2, Panel: 1 },
  TreeItem: class {
    public id?: string;
    public tooltip?: string;
    public description?: string;
    public contextValue?: string;
    public iconPath?: unknown;
    public constructor(
      public readonly label: string,
      public readonly collapsibleState?: number
    ) {}
  },
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
  ThemeIcon: class {
    public constructor(
      public readonly id: string,
      public readonly color?: unknown
    ) {}
  },
  ThemeColor: class {
    public constructor(public readonly id: string) {}
  },
  EventEmitter: class {
    public readonly event = vi.fn();
    public fire = vi.fn();
  }
}));

/**
 * The extension side of the autofill round trip, as `WebviewFormPanel` runs it:
 * the real mirror answers, and `undefined` (an id that resolves to no profile)
 * suppresses the `fillFields` reply entirely.
 */
function answerAutofill(harness: FormHarness, profiles: AuthProfile[]): void {
  const autofill = [...harness.posted].reverse().find((msg) => msg.type === "autofill");
  if (!autofill || autofill.type !== "autofill") {
    throw new Error("no autofill was posted");
  }
  const values = authProfileCredentialMirror(profiles.find((p) => p.id === autofill.value));
  if (values) {
    // `value` echoes the id the request named, exactly as WebviewFormPanel
    // answers — the webview drops an answer that does not describe the option
    // currently selected (see the late-answer tests below).
    harness.deliver({ type: "fillFields", key: autofill.key, value: autofill.value, values });
  }
}

/** Pick a profile from the list and let its mirror answer. */
function pickProfile(harness: FormHarness, profiles: AuthProfile[], profileId: string): void {
  harness.choose("authProfileId", profileId);
  if (profileId !== "") {
    answerAutofill(harness, profiles);
  }
}

/* ── the save path, verbatim from nexus.server.edit's onSubmit ───────────── */
function saveServerEdit(existing: ServerConfig, values: FormValues, profiles: AuthProfile[]): ServerConfig {
  const candidate = formValuesToServer(values, existing.id, existing.isHidden);
  if (!candidate) {
    throw new Error("the form's values were refused by formValuesToServer");
  }
  const linked = candidate.authProfileId ? profiles.find((p) => p.id === candidate.authProfileId) : undefined;
  return preserveLinkedServerCredentials(existing, candidate, linked);
}

/* ── the connect path ────────────────────────────────────────────────────── */
async function resolveForConnect(server: ServerConfig, profiles: AuthProfile[]): Promise<ServerConfig> {
  const connection = {
    openShell: vi.fn(),
    openDirectTcp: vi.fn(),
    openSftp: vi.fn(),
    exec: vi.fn(),
    requestForwardIn: vi.fn(),
    cancelForwardIn: vi.fn(),
    onTcpConnection: vi.fn(() => () => {}),
    onClose: vi.fn(() => () => {}),
    getBanner: vi.fn(() => undefined),
    dispose: vi.fn()
  } as unknown as SshConnection;
  const connector: SshConnector = { connect: vi.fn(async () => connection) };
  const vault: SecretVault = {
    get: vi.fn(async () => undefined),
    store: vi.fn(async () => {}),
    delete: vi.fn(async () => {})
  };
  // Reached only by a password server with no saved secret; answering keeps the
  // flow on the path that calls the connector, which is what this reads back.
  const prompt: PasswordPrompt = { prompt: vi.fn(async () => ({ password: "typed", save: false })) };
  const factory = new SilentAuthSshFactory(connector, vault, prompt, undefined, (id: string) =>
    profiles.find((p) => p.id === id)
  );
  await factory.connect(server);
  const call = vi.mocked(connector.connect).mock.calls[0];
  return call[0];
}

const KEY_PROFILE: AuthProfile = {
  id: "ap-key",
  name: "Datacenter key",
  username: "dcuser",
  authType: "key",
  keyPath: "/keys/datacenter_ed25519"
};
const KEYLESS_PROFILE: AuthProfile = {
  id: "ap-keyless",
  name: "Shared key (bring your own)",
  username: "shared",
  authType: "key"
};
const PASSWORD_PROFILE: AuthProfile = {
  id: "ap-pass",
  name: "Lab password",
  username: "labuser",
  authType: "password"
};
const AGENT_PROFILE: AuthProfile = {
  id: "ap-agent",
  name: "Bastion agent",
  username: "agentuser",
  authType: "agent"
};
/** Only reachable through an imported backup — the profile editor trims and
 *  refuses a blank username — and the one profile that owns NO username. */
const BLANK_USERNAME_PROFILE: AuthProfile = {
  id: "ap-blank",
  name: "Imported",
  username: "   ",
  authType: "password"
};
const PROFILES = [KEY_PROFILE, KEYLESS_PROFILE, PASSWORD_PROFILE, AGENT_PROFILE, BLANK_USERNAME_PROFILE];

function makeServer(overrides: Partial<ServerConfig> = {}): ServerConfig {
  return {
    id: "srv-1",
    name: "Core switch",
    host: "10.0.0.1",
    port: 22,
    username: "my-own-account",
    authType: "key",
    keyPath: "/home/me/.ssh/my_own_key",
    isHidden: false,
    ...overrides
  };
}

function openServerForm(server: ServerConfig, profiles: AuthProfile[] = PROFILES): FormHarness {
  return openForm(serverFormDefinition(server, [], true, [], profiles));
}

describe("an auth-profile switch hands back the values the previous profile displaced", () => {
  describe("end to end — form, persisted record, resolved connect config", () => {
    it("keeps the server's own key path when a key profile that carries none replaces one that did (THE REPORTED SCENARIO: without the restore the first profile's private key is saved onto the server as its own and used by the connection, from a field that shows it unlocked as though the user had chosen it)", async () => {
      const server = makeServer();
      const harness = openServerForm(server);

      pickProfile(harness, PROFILES, KEY_PROFILE.id);
      expect(harness.value("keyPath")).toBe("/keys/datacenter_ed25519");
      expect(harness.locked("keyPath")).toBe(true);

      pickProfile(harness, PROFILES, KEYLESS_PROFILE.id);

      // What the form shows: the server's own key path, editable again, because
      // the profile now linked supplies none.
      expect(harness.value("keyPath")).toBe("/home/me/.ssh/my_own_key");
      expect(harness.locked("keyPath")).toBe(false);
      // …and the username IS supplied, so it stays mirrored and locked.
      expect(harness.value("username")).toBe("shared");
      expect(harness.locked("username")).toBe(true);

      // What a Save persists.
      const persisted = saveServerEdit(server, harness.submit(), PROFILES);
      expect(persisted.keyPath).toBe("/home/me/.ssh/my_own_key");
      expect(persisted.username).toBe("my-own-account");
      expect(persisted.authProfileId).toBe(KEYLESS_PROFILE.id);

      // What the connection then uses.
      const resolved = await resolveForConnect(persisted, PROFILES);
      expect(resolved.keyPath).toBe("/home/me/.ssh/my_own_key");
      expect(resolved.username).toBe("shared");
      expect(resolved.authType).toBe("key");

      // The three layers agree: the field the user was left looking at is the
      // one that was stored and the one the connection dials with.
      expect(harness.value("keyPath")).toBe(persisted.keyPath);
      expect(persisted.keyPath).toBe(resolved.keyPath);
    });

    it("hands every credential back when the profile is set to (None), so an unlink cannot make the server adopt credentials it never had (kills leaving the outgoing profile's values in the now-unlinked fields: nothing downstream restores them — preserveLinkedServerCredentials only acts on a LINKED record)", async () => {
      const server = makeServer({ authType: "password", keyPath: undefined, username: "my-own-account" });
      const harness = openServerForm(server);

      pickProfile(harness, PROFILES, KEY_PROFILE.id);
      expect(harness.value("username")).toBe("dcuser");
      expect(harness.value("authType")).toBe("key");
      expect(harness.value("keyPath")).toBe("/keys/datacenter_ed25519");

      harness.choose("authProfileId", "");

      expect(harness.value("username")).toBe("my-own-account");
      expect(harness.value("authType")).toBe("password");
      expect(harness.locked("username")).toBe(false);

      const persisted = saveServerEdit(server, harness.submit(), PROFILES);
      expect(persisted.authProfileId).toBeUndefined();
      expect(persisted.username).toBe("my-own-account");
      expect(persisted.authType).toBe("password");
      expect(persisted.keyPath).toBeUndefined();

      const resolved = await resolveForConnect(persisted, PROFILES);
      expect(resolved.username).toBe("my-own-account");
      expect(resolved.authType).toBe("password");
      expect(resolved.keyPath).toBeUndefined();
    });
  });

  describe("a form OPENED on an already-linked server — the render is a transition too", () => {
    /**
     * REVIEW FINDING (P1) — the reported scenario, and it is self-inflicting:
     * the state it destroys is precisely the state the PREVIOUS save produced.
     * Link a keyless `key` profile to a password server and browse to a key
     * file; the profile owns `authType` (closed enum) but not `keyPath`, so
     * `preserveLinkedServerCredentials` puts the record's own `password` back
     * underneath the link and stores the key file you just chose. Reopen that
     * record and the form used to render the RECORD's `authType` — "Password",
     * locked, because the seed said the profile owns it — which hides the
     * Private Key File control behind its `authType === "key"` rule.
     * `updateVisibility` disables exactly what the submit loop skips, so any
     * unrelated edit saved a record with no `keyPath` at all, and the next
     * connection resolved `key` from the profile with no file to read.
     */
    it("keeps the server's own key file when an unrelated edit is saved (THE REPORTED SCENARIO — kills seeding the lock from the profile while rendering the record's authType: the key path control is hidden, therefore disabled, therefore never submitted, and preserveLinkedServerCredentials cannot restore a field the profile does not own)", async () => {
      const server = makeServer({
        // What the previous save left: the profile's `key` is imposed at
        // connect time, the record keeps its own type underneath the link.
        authType: "password",
        keyPath: "/home/me/.ssh/my_own_key",
        authProfileId: KEYLESS_PROFILE.id
      });
      const harness = openServerForm(server);

      // An edit with nothing to do with credentials — a rename.
      harness.type("name", "Core switch (renamed)");
      const persisted = saveServerEdit(server, harness.submit(), PROFILES);

      expect(persisted.name).toBe("Core switch (renamed)");
      expect(persisted.keyPath).toBe("/home/me/.ssh/my_own_key");
      // The link and the record's own auth type are both untouched by the save.
      expect(persisted.authProfileId).toBe(KEYLESS_PROFILE.id);
      expect(persisted.authType).toBe("password");

      // And the connection still has a key to read: the profile imposes `key`,
      // the server supplies the file, which is the whole point of this pairing.
      const resolved = await resolveForConnect(persisted, PROFILES);
      expect(resolved.authType).toBe("key");
      expect(resolved.keyPath).toBe("/home/me/.ssh/my_own_key");
      expect(resolved.username).toBe("shared");
    });

    it("opens showing the auth type the profile will actually impose, with the key path control visible and editable because the profile supplies none (kills a form whose locked value and its lock disagree: the user is shown 'Password' for a server every connection dials with key auth)", () => {
      const server = makeServer({
        authType: "password",
        keyPath: "/home/me/.ssh/my_own_key",
        authProfileId: KEYLESS_PROFILE.id
      });
      const harness = openServerForm(server);

      expect(harness.value("authType")).toBe("key");
      expect(harness.selectLabel("authType")).toBe("Private Key");
      expect(harness.locked("authType")).toBe(true);
      // Supplied by the profile, so locked and showing the profile's value…
      expect(harness.value("username")).toBe("shared");
      expect(harness.locked("username")).toBe(true);
      // …and NOT supplied, so editable and showing the server's own file.
      expect(harness.value("keyPath")).toBe("/home/me/.ssh/my_own_key");
      expect(harness.locked("keyPath")).toBe(false);
      // Editable in the sense that matters: Browse can still replace it, and
      // what it writes is what a Save stores.
      harness.browseResult("keyPath", "/home/me/.ssh/rotated_key");
      expect(saveServerEdit(server, harness.submit(), PROFILES).keyPath).toBe("/home/me/.ssh/rotated_key");
    });

    it("hands the server's own credentials back when the link is removed, having rendered the profile's (kills seeding the render without seeding the RESTORE: (None) would unlock fields still holding the profile's username and private key with nothing behind them, and the save would then store those onto the server as its own)", async () => {
      const server = makeServer({
        // The shape every inventory-synced server has, and the one a keyed
        // profile visibly overwrites at render.
        authType: "agent",
        keyPath: undefined,
        username: "my-own-account",
        authProfileId: KEY_PROFILE.id
      });
      const harness = openServerForm(server);

      expect(harness.value("authType")).toBe("key");
      expect(harness.value("username")).toBe("dcuser");
      expect(harness.value("keyPath")).toBe("/keys/datacenter_ed25519");

      harness.choose("authProfileId", "");

      expect(harness.value("authType")).toBe("agent");
      expect(harness.selectLabel("authType")).toBe("SSH Agent");
      expect(harness.value("username")).toBe("my-own-account");
      expect(harness.value("keyPath")).toBe("");

      const persisted = saveServerEdit(server, harness.submit(), PROFILES);
      expect(persisted.authProfileId).toBeUndefined();
      expect(persisted.authType).toBe("agent");
      expect(persisted.username).toBe("my-own-account");
      expect(persisted.keyPath).toBeUndefined();

      const resolved = await resolveForConnect(persisted, PROFILES);
      expect(resolved.authType).toBe("agent");
      expect(resolved.username).toBe("my-own-account");
      expect(resolved.keyPath).toBeUndefined();
    });

    it("hands them back on a SWITCH to another profile too, not only on (None) — the render's seed is consumed once and then the per-fill capture takes over", () => {
      const server = makeServer({
        authType: "agent",
        keyPath: undefined,
        username: "my-own-account",
        authProfileId: KEY_PROFILE.id
      });
      const harness = openServerForm(server);

      // KEYLESS_PROFILE supplies a username but no key path, so the key path
      // must come back to the server's own — which is nothing.
      pickProfile(harness, PROFILES, KEYLESS_PROFILE.id);
      expect(harness.value("username")).toBe("shared");
      expect(harness.value("keyPath")).toBe("");
      expect(harness.locked("keyPath")).toBe(false);

      const persisted = saveServerEdit(server, harness.submit(), PROFILES);
      expect(persisted.keyPath).toBeUndefined();
      expect(persisted.authProfileId).toBe(KEYLESS_PROFILE.id);
      // Still the server's own underneath the new link, as for the old one.
      expect(persisted.username).toBe("my-own-account");
      expect(persisted.authType).toBe("agent");
    });

    /**
     * REVIEW FINDING (P1) — THE MIRROR IMAGE of the scenario above, and the
     * reason the fix is an invariant rather than a third conditional.
     *
     * The previous round taught the render to show the profile's EFFECTIVE
     * auth type, which put the key field back on screen for a keyless `key`
     * profile. It also meant a `password`/`agent` profile now hides that field
     * on a server whose own `authType` is `key`: the control is hidden,
     * therefore disabled, therefore absent from the submission — and the save
     * declined to restore it because such a profile does not own `keyPath`.
     * Saving a rename left `authType: "key"` (restored, since `authType` IS
     * owned) over no key file at all, so unlinking the profile later produced a
     * server that could not connect and had nothing left to say what it used to
     * point at.
     */
    it("keeps the server's own key file when the linked profile HIDES the Private Key File control (THE REPORTED SCENARIO — kills restoring only the fields the profile owns: a password profile owns no keyPath, so the field the form never showed was written back as empty)", async () => {
      const server = makeServer({
        authType: "key",
        keyPath: "/home/me/.ssh/my_own_key",
        username: "my-own-account",
        authProfileId: PASSWORD_PROFILE.id
      });
      const harness = openServerForm(server);

      // The form shows what the profile imposes, so the key field is not on
      // screen at all — and what is not on screen is not submitted.
      expect(harness.value("authType")).toBe("password");
      expect(harness.submit().keyPath).toBeUndefined();

      // An edit with nothing to do with credentials — a rename.
      harness.type("name", "Core switch (renamed)");
      const persisted = saveServerEdit(server, harness.submit(), PROFILES);

      expect(persisted.name).toBe("Core switch (renamed)");
      expect(persisted.keyPath).toBe("/home/me/.ssh/my_own_key");
      expect(persisted.authType).toBe("key");
      expect(persisted.username).toBe("my-own-account");
      expect(persisted.authProfileId).toBe(PASSWORD_PROFILE.id);

      // The link is doing its job meanwhile — the profile's password auth is
      // what the connection uses…
      const resolved = await resolveForConnect(persisted, PROFILES);
      expect(resolved.authType).toBe("password");
      expect(resolved.username).toBe("labuser");

      // …and the record underneath is still whole, so unlinking gives the
      // server back exactly the key auth it had before the profile was chosen.
      const unlinked = { ...persisted, authProfileId: undefined };
      const resolvedUnlinked = await resolveForConnect(unlinked, PROFILES);
      expect(resolvedUnlinked.authType).toBe("key");
      expect(resolvedUnlinked.keyPath).toBe("/home/me/.ssh/my_own_key");
    });

    it("keeps it under an AGENT profile too, which hides the same control for the same reason (kills fixing only the profile type the report happened to name)", () => {
      const server = makeServer({
        authType: "key",
        keyPath: "/home/me/.ssh/my_own_key",
        authProfileId: AGENT_PROFILE.id
      });
      const harness = openServerForm(server);

      expect(harness.value("authType")).toBe("agent");
      harness.type("name", "Core switch (renamed)");

      const persisted = saveServerEdit(server, harness.submit(), PROFILES);
      expect(persisted.keyPath).toBe("/home/me/.ssh/my_own_key");
      expect(persisted.authType).toBe("key");
    });

    it("still saves a key file the user supplies through a keyless key profile, which is the OPPOSITE direction of the same rule (kills closing the reported direction by restoring every field the profile does not own: this server has no stored key path, so the one the user just browsed to would be written back as empty)", () => {
      const server = makeServer({
        authType: "password",
        keyPath: undefined,
        username: "my-own-account",
        authProfileId: KEYLESS_PROFILE.id
      });
      const harness = openServerForm(server);

      // The profile forces key auth and supplies no file, so the control is on
      // screen, unlocked and empty — the whole point of this pairing.
      expect(harness.value("authType")).toBe("key");
      expect(harness.value("keyPath")).toBe("");
      expect(harness.locked("keyPath")).toBe(false);

      harness.browseResult("keyPath", "/home/me/.ssh/brought_my_own");
      const persisted = saveServerEdit(server, harness.submit(), PROFILES);

      expect(persisted.keyPath).toBe("/home/me/.ssh/brought_my_own");
      expect(persisted.authType).toBe("password");
      expect(persisted.username).toBe("my-own-account");
    });

    it("renders the record's own values for a link whose profile no longer resolves, exactly as the save path treats that id (kills overriding from a dangling id: the fields would lock onto nothing and the record's credentials would be dropped)", () => {
      const server = makeServer({
        authType: "password",
        keyPath: "/home/me/.ssh/my_own_key",
        username: "my-own-account",
        authProfileId: "ap-deleted-while-the-form-sat-open"
      });
      const harness = openServerForm(server);

      expect(harness.value("authType")).toBe("password");
      expect(harness.value("username")).toBe("my-own-account");
      expect(harness.locked("username")).toBe(false);

      const persisted = saveServerEdit(server, harness.submit(), PROFILES);
      expect(persisted.username).toBe("my-own-account");
      expect(persisted.authType).toBe("password");
    });
  });

  describe("every kind of transition releases what the profile displaced", () => {
    it("releases on an inline-created profile injected into the open form, exactly as on a picked one (kills leaving the addSelectOption path resetting ownership without restoring values — the new profile's fill lands on top of the old one's leftovers)", () => {
      const server = makeServer();
      const created: AuthProfile = { id: "ap-new", name: "Just created", username: "fresh", authType: "key" };
      const profiles = [...PROFILES, created];
      const harness = openServerForm(server, PROFILES);

      pickProfile(harness, PROFILES, KEY_PROFILE.id);
      expect(harness.value("keyPath")).toBe("/keys/datacenter_ed25519");

      // What `WebviewFormPanel.addSelectOption` posts after an inline create.
      harness.deliver({ type: "addSelectOption", key: "authProfileId", value: created.id, label: created.name });
      answerAutofill(harness, profiles);

      expect(harness.value("username")).toBe("fresh");
      expect(harness.locked("username")).toBe(true);
      // The created profile carries no key path, so the server's own comes back.
      expect(harness.value("keyPath")).toBe("/home/me/.ssh/my_own_key");
      expect(harness.locked("keyPath")).toBe(false);

      const persisted = saveServerEdit(server, harness.submit(), profiles);
      expect(persisted.keyPath).toBe("/home/me/.ssh/my_own_key");
    });

    it("hands back the value as it was immediately before the LAST fill, so an edit made between two selections survives (kills snapshotting once at form open: that restores the value the form was opened with and silently discards the browse the user did in between)", () => {
      const server = makeServer();
      const harness = openServerForm(server);

      pickProfile(harness, PROFILES, KEY_PROFILE.id);
      expect(harness.value("keyPath")).toBe("/keys/datacenter_ed25519");

      // A profile that supplies no key path — the field unlocks holding the
      // server's own value again.
      pickProfile(harness, PROFILES, KEYLESS_PROFILE.id);
      expect(harness.value("keyPath")).toBe("/home/me/.ssh/my_own_key");

      // The user browses to a different key while the field is unlocked.
      harness.browseResult("keyPath", "/home/me/.ssh/picked_by_hand");

      // Another profile that DOES supply one, then off it again.
      pickProfile(harness, PROFILES, KEY_PROFILE.id);
      expect(harness.value("keyPath")).toBe("/keys/datacenter_ed25519");
      pickProfile(harness, PROFILES, KEYLESS_PROFILE.id);

      expect(harness.value("keyPath")).toBe("/home/me/.ssh/picked_by_hand");

      const persisted = saveServerEdit(server, harness.submit(), PROFILES);
      expect(persisted.keyPath).toBe("/home/me/.ssh/picked_by_hand");
    });

    it("restores the visible label of a custom select, not just the value the form submits (kills writing only the hidden input: the Authentication control would keep reading as the profile that is no longer selected while submitting something else)", () => {
      const harness = openServerForm(makeServer({ authType: "key", keyPath: "/home/me/.ssh/my_own_key" }));

      expect(harness.selectLabel("authType")).toBe("Private Key");
      pickProfile(harness, PROFILES, PASSWORD_PROFILE.id);
      expect(harness.value("authType")).toBe("password");
      expect(harness.selectLabel("authType")).toBe("Password");

      harness.choose("authProfileId", "");

      expect(harness.value("authType")).toBe("key");
      expect(harness.selectLabel("authType")).toBe("Private Key");
    });

    it("re-shows a field the restored authType makes relevant again (kills leaving visibility settled on the released profile's authType — the key path control would stay hidden and its value would be dropped from the submission)", () => {
      const server = makeServer({ authType: "key", keyPath: "/home/me/.ssh/my_own_key" });
      const harness = openServerForm(server);

      // A password profile hides the key path field entirely…
      pickProfile(harness, PROFILES, PASSWORD_PROFILE.id);
      expect(harness.submit().keyPath).toBeUndefined();

      // …and going back to (None) restores authType `key`, so it comes back
      // with the server's own value and is submitted again.
      harness.choose("authProfileId", "");
      const values = harness.submit();
      expect(values.authType).toBe("key");
      expect(values.keyPath).toBe("/home/me/.ssh/my_own_key");

      const persisted = saveServerEdit(server, values, PROFILES);
      expect(persisted.keyPath).toBe("/home/me/.ssh/my_own_key");
    });

    it("does not write a key the profile supplied BLANK, which owns nothing and so would never be handed back (kills applying a fill payload verbatim: the user's own username is replaced by whitespace in an unlocked field, and the save is then refused for a required field nobody emptied)", () => {
      const server = makeServer();
      const harness = openServerForm(server);

      // A payload no current mirror sends — defence in depth against one that
      // hands the profile's username over unfiltered (an imported profile can
      // carry a whitespace-only one).
      harness.choose("authProfileId", KEY_PROFILE.id);
      harness.deliver({
        type: "fillFields",
        key: "authProfileId",
        value: KEY_PROFILE.id,
        values: { username: "   ", authType: "key" }
      });

      expect(harness.value("username")).toBe("my-own-account");
      expect(harness.locked("username")).toBe(false);
      expect(harness.value("authType")).toBe("key");
      expect(harness.locked("authType")).toBe(true);
      expect(harness.submit().username).toBe("my-own-account");
    });

    it("leaves another autofill-capable select's answer alone — it fills, but takes no ownership and displaces nothing (kills applying the profile's rules to every fill: a foreign answer would seize the lock from the profile, and its value would then be thrown away by the next release)", () => {
      const server = makeServer();
      const harness = openServerForm(server);

      pickProfile(harness, PROFILES, KEYLESS_PROFILE.id);
      expect(harness.locked("username")).toBe(true);

      harness.deliver({
        type: "fillFields",
        key: "someOtherSelect",
        value: "some-other-option",
        values: { keyPath: "/from/another/select" }
      });

      // Filled as any autofill fills…
      expect(harness.value("keyPath")).toBe("/from/another/select");
      // …but the profile's ownership is untouched: it owns the username it
      // supplied, and still does not own the key path it did not.
      expect(harness.locked("keyPath")).toBe(false);
      expect(harness.locked("username")).toBe(true);

      // And nothing recorded the foreign answer as something a profile
      // displaced, so releasing the profile leaves it exactly where it is.
      harness.choose("authProfileId", "");
      expect(harness.value("keyPath")).toBe("/from/another/select");
      expect(harness.value("username")).toBe("my-own-account");
    });
  });

  /**
   * REVIEW FINDING (P1) — THE INVARIANT ITSELF, checked against the real form
   * rather than restated.
   *
   * Every defect in this family has been the render and the save disagreeing
   * about one question — "did the form actually OFFER this credential field?" —
   * and each round closed one direction of that disagreement while opening its
   * mirror. `formOfferedServerCredentials` (models/config.ts) is now the single
   * answer the save path reads. This is what stops it drifting from the form
   * that produced the submission: the form's answer is observable (a field is
   * offered when it is submitted AND not locked), so the two are compared
   * directly, over pairs chosen so that every field is on the wrong side of the
   * rule in at least one of them.
   */
  describe("what the form offers and what the save keeps are one decision", () => {
    /** The form's own answer: submitted (i.e. not hidden, since
     *  updateVisibility disables what it hides and the submit loop skips
     *  disabled controls) and not locked by the profile. */
    function offeredByForm(harness: FormHarness, values: FormValues): Record<string, boolean> {
      return {
        username: values.username !== undefined && !harness.locked("username"),
        authType: values.authType !== undefined && !harness.locked("authType"),
        keyPath: values.keyPath !== undefined && !harness.locked("keyPath")
      };
    }

    const cases: Array<{ what: string; server: ServerConfig; profileId: string | undefined }> = [
      {
        what: "a key server under a password profile — the reported direction: keyPath hidden by a profile that does not own it",
        server: makeServer({ authType: "key", keyPath: "/home/me/.ssh/my_own_key" }),
        profileId: PASSWORD_PROFILE.id
      },
      {
        what: "a key server under an agent profile",
        server: makeServer({ authType: "key", keyPath: "/home/me/.ssh/my_own_key" }),
        profileId: AGENT_PROFILE.id
      },
      {
        what: "a password server under a keyless key profile — the opposite direction: keyPath shown and unowned, so it IS the user's",
        server: makeServer({ authType: "password", keyPath: undefined }),
        profileId: KEYLESS_PROFILE.id
      },
      {
        what: "an agent server under a key profile that carries its own file",
        server: makeServer({ authType: "agent", keyPath: undefined }),
        profileId: KEY_PROFILE.id
      },
      {
        what: "a key server under a profile whose username is blank — the one profile that owns no username",
        server: makeServer({ authType: "key", keyPath: "/home/me/.ssh/my_own_key" }),
        profileId: BLANK_USERNAME_PROFILE.id
      },
      {
        what: "a key server whose link resolves to nothing — every field is the user's own",
        server: makeServer({ authType: "key", keyPath: "/home/me/.ssh/my_own_key" }),
        profileId: "ap-deleted-while-the-form-sat-open"
      },
      {
        what: "an unlinked key server",
        server: makeServer({ authType: "key", keyPath: "/home/me/.ssh/my_own_key" }),
        profileId: undefined
      }
    ];

    for (const { what, server, profileId } of cases) {
      it(`agrees for ${what}`, () => {
        const linked = { ...server, authProfileId: profileId };
        const harness = openServerForm(linked);
        const values = harness.submit();
        const candidate = formValuesToServer(values, linked.id, linked.isHidden);
        if (!candidate) {
          throw new Error("the form's values were refused by formValuesToServer");
        }
        const profile = PROFILES.find((p) => p.id === profileId);

        expect(offeredByForm(harness, values)).toEqual({ ...formOfferedServerCredentials(candidate, profile) });
      });
    }

    it("and the save keeps exactly the fields the form offered, for every one of those pairs (kills a rule that answers correctly while the save consults something else)", () => {
      for (const { what, server, profileId } of cases) {
        const linked = { ...server, authProfileId: profileId };
        const harness = openServerForm(linked);
        const values = harness.submit();
        const candidate = formValuesToServer(values, linked.id, linked.isHidden);
        if (!candidate) {
          throw new Error("the form's values were refused by formValuesToServer");
        }
        const persisted = saveServerEdit(linked, values, PROFILES);
        const profile = PROFILES.find((p) => p.id === profileId);
        // The oracle is the SUBMISSION, never the record the save produced —
        // reading `persisted.authType` here would ask the restored value
        // whether the form showed the key field, which is the very confusion
        // this whole family of defects is made of (and would make this
        // assertion vacuous under the pre-fix save).
        const offered = formOfferedServerCredentials(candidate, profile);

        // A field the form did not offer must read back as the record's own,
        // whatever the submission did or did not carry for it.
        if (!offered.keyPath && profileId !== undefined) {
          expect(persisted.keyPath, what).toBe(linked.keyPath);
        }
        if (!offered.username && profileId !== undefined) {
          expect(persisted.username, what).toBe(linked.username);
        }
        if (!offered.authType && profileId !== undefined) {
          expect(persisted.authType, what).toBe(linked.authType);
        }
      }
    });
  });

  /**
   * REVIEW FINDING (P2) — AN AUTOFILL IS A ROUND TRIP, AND THE USER CAN OUTRUN
   * IT. Every test above delivers the answer while its profile is still
   * selected, which is the only ordering the harness produced; these two force
   * the other one.
   *
   * The gating is explicit, never a race: the answer is COMPOSED (the real
   * mirror, from the profile the request named) and held, the next selection is
   * made, and only then is it delivered — so "the late answer arrives after the
   * user moved on" is a property of the test, not of its timing.
   *
   * The oracle is the PERSISTED RECORD, because that is where the damage lands:
   * the selection already ran the release, so those fields are unlocked and
   * hold the user's own values, and a save decided against the profile that is
   * now selected (or against no profile at all) keeps whatever the form
   * submits — `preserveLinkedServerCredentials` has nothing to restore from for
   * an unlinked record, and keeps a field the currently-linked profile does not
   * own.
   */
  describe("an answer that arrives for a profile the form has moved away from", () => {
    /** Composes the extension's answer to the autofill just posted, WITHOUT
     *  delivering it — the half of `answerAutofill` that runs before the round
     *  trip returns. */
    function composeAnswer(harness: FormHarness, profiles: AuthProfile[]): { profileId: string; values: Record<string, string> } {
      const autofill = [...harness.posted].reverse().find((msg) => msg.type === "autofill");
      if (!autofill || autofill.type !== "autofill") {
        throw new Error("no autofill was posted");
      }
      const values = authProfileCredentialMirror(profiles.find((p) => p.id === autofill.value));
      if (!values) {
        throw new Error("the mirror declined to answer");
      }
      return { profileId: autofill.value, values };
    }

    it("is discarded when the profile was deselected, so an UNLINKED save cannot adopt its credentials (kills applying a fillFields payload without checking which option it describes: with no link left, every submitted credential is kept verbatim as the user's own)", async () => {
      const server = makeServer();
      const harness = openServerForm(server);

      harness.choose("authProfileId", KEY_PROFILE.id);
      const late = composeAnswer(harness, PROFILES);
      // The user gets to (None) first — the release hands the server's own
      // values back and unlocks the fields…
      harness.choose("authProfileId", "");
      // …and only now does the profile's answer land.
      harness.deliver({ type: "fillFields", key: "authProfileId", value: late.profileId, values: late.values });

      expect(harness.value("username")).toBe("my-own-account");
      expect(harness.value("keyPath")).toBe("/home/me/.ssh/my_own_key");
      expect(harness.locked("username")).toBe(false);
      expect(harness.locked("keyPath")).toBe(false);

      const persisted = saveServerEdit(server, harness.submit(), PROFILES);
      expect(persisted.authProfileId).toBeUndefined();
      expect(persisted.username).toBe("my-own-account");
      expect(persisted.keyPath).toBe("/home/me/.ssh/my_own_key");
      expect(persisted.authType).toBe("key");

      const resolved = await resolveForConnect(persisted, PROFILES);
      expect(resolved.username).toBe("my-own-account");
      expect(resolved.keyPath).toBe("/home/me/.ssh/my_own_key");
    });

    it("is discarded when ANOTHER profile was picked, so the server does not adopt the first one's private key (kills a fix that only compares against (None): the profile now linked owns no key path, so the save keeps the submitted one — whatever the late answer left in that field)", () => {
      const server = makeServer();
      const harness = openServerForm(server);

      harness.choose("authProfileId", KEY_PROFILE.id);
      const late = composeAnswer(harness, PROFILES);
      // A second profile is picked and answers normally, in time.
      pickProfile(harness, PROFILES, KEYLESS_PROFILE.id);
      // Only now does the FIRST profile's answer arrive.
      harness.deliver({ type: "fillFields", key: "authProfileId", value: late.profileId, values: late.values });

      // The key path field belongs to the user under a keyless key profile —
      // it must still hold the server's own file, not the first profile's.
      expect(harness.value("keyPath")).toBe("/home/me/.ssh/my_own_key");
      expect(harness.locked("keyPath")).toBe(false);
      expect(harness.value("username")).toBe("shared");

      const persisted = saveServerEdit(server, harness.submit(), PROFILES);
      expect(persisted.authProfileId).toBe(KEYLESS_PROFILE.id);
      expect(persisted.keyPath).toBe("/home/me/.ssh/my_own_key");
      expect(persisted.username).toBe("my-own-account");
    });
  });

  describe("the inventory source form releases its one managed field too", () => {
    const provider: InventoryProvider = {
      id: "fake",
      label: "Fake Provider",
      configFields: [],
      testConnection: async () => undefined,
      fetchInventory: async () => ({ nodes: [] }) as never
    };

    /** `authProfileUsernameMirror` (inventoryCommands.ts), which is not
     *  exported — rebuilt here from the same shared rule it reads. */
    function usernameMirror(profile: AuthProfile | undefined): Record<string, string> | undefined {
      if (!profile) {
        return undefined;
      }
      const username = authProfileOwnedCredentials(profile).username;
      return username !== undefined ? { defaultUsername: username } : {};
    }

    it("hands the source's own default username back on (None) (kills leaving the profile's username in the field: with no profile linked the source save stores whatever was submitted, so the source silently adopts the username of a profile it is no longer using)", () => {
      const harness = openForm(
        inventorySourceFormDefinition(
          provider,
          {
            id: "src-1",
            providerId: "fake",
            name: "Fake",
            targetFolder: "",
            prunePolicy: "orphan",
            defaultUsername: "source-own-account",
            config: {},
            secretFieldIds: []
          },
          undefined,
          PROFILES
        )
      );

      harness.choose("authProfileId", PASSWORD_PROFILE.id);
      harness.deliver({
        type: "fillFields",
        key: "authProfileId",
        value: PASSWORD_PROFILE.id,
        values: usernameMirror(PASSWORD_PROFILE)!
      });
      expect(harness.value("defaultUsername")).toBe("labuser");
      expect(harness.locked("defaultUsername")).toBe(true);

      harness.choose("authProfileId", "");

      expect(harness.value("defaultUsername")).toBe("source-own-account");
      expect(harness.locked("defaultUsername")).toBe(false);
      expect(harness.submit().defaultUsername).toBe("source-own-account");
    });

    it("keeps an edit the user makes while the field is unlocked, then hands THAT back (kills a form-open snapshot on the source form as well)", () => {
      const harness = openForm(
        inventorySourceFormDefinition(provider, undefined, "most-common-account", PROFILES)
      );

      // The Add form's only "original" is the prefilled mostCommonUsername.
      expect(harness.value("defaultUsername")).toBe("most-common-account");
      harness.type("defaultUsername", "typed-by-hand");

      harness.choose("authProfileId", PASSWORD_PROFILE.id);
      harness.deliver({
        type: "fillFields",
        key: "authProfileId",
        value: PASSWORD_PROFILE.id,
        values: usernameMirror(PASSWORD_PROFILE)!
      });
      expect(harness.value("defaultUsername")).toBe("labuser");

      harness.choose("authProfileId", "");
      expect(harness.value("defaultUsername")).toBe("typed-by-hand");
    });
  });
});
