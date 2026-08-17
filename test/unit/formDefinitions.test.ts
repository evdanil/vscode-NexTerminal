import { describe, expect, it } from "vitest";
import {
  inventorySourceFormDefinition,
  localShellFormDefinition,
  serialFormDefinition,
  serverFormDefinition,
  tunnelFormDefinition,
  unifiedProfileFormDefinition,
  unifiedProfileFormId,
  SAVED_FILTER_SELECT_KEY,
  SAVED_FILTER_SAVE_CURRENT_SENTINEL
} from "../../src/ui/formDefinitions";
import type { SavedFilterDefinition } from "../../src/models/savedFilter";
import type { FormDefinition, FormFieldDescriptor } from "../../src/ui/formTypes";
import type { InventoryProvider, InventorySourceConfig } from "../../src/models/inventory";
import type { AuthProfile } from "../../src/models/config";
import { authProfileOwnedCredentials } from "../../src/models/config";
import { formatAuthProfileLabel } from "../../src/utils/authProfileLabel";

function keyedField(definition: FormDefinition, key: string): Extract<FormFieldDescriptor, { key: string }> {
  const field = definition.fields.find(
    (candidate): candidate is Extract<FormFieldDescriptor, { key: string }> =>
      "key" in candidate && candidate.key === key
  );
  expect(field, `Expected field "${key}"`).toBeDefined();
  return field!;
}

function maybeKeyedField(definition: FormDefinition, key: string): Extract<FormFieldDescriptor, { key: string }> | undefined {
  return definition.fields.find(
    (candidate): candidate is Extract<FormFieldDescriptor, { key: string }> =>
      "key" in candidate && candidate.key === key
  );
}

function keyPathVisibleWhen(definition: ReturnType<typeof serverFormDefinition>) {
  const keyPathField = definition.fields.find(
    (field): field is Extract<(typeof definition.fields)[number], { key: string }> =>
      "key" in field && field.key === "keyPath"
  );
  expect(keyPathField).toBeDefined();
  return keyPathField!.visibleWhen;
}

describe("formDefinitions keyPath visibility", () => {
  it("shows server keyPath field only for authType=key on an SSH server", () => {
    // TELNET (Phase 0) — the key-file control now carries the SSH-only gate as
    // well: telnet has no key material, so the field must stay hidden there
    // whatever `authType` reads.
    const visibleWhen = keyPathVisibleWhen(serverFormDefinition());
    expect(visibleWhen).toEqual([
      { field: "protocol", value: "ssh" },
      { field: "authType", value: "key" }
    ]);
  });

  it("compounds unified form keyPath visibility with profileType=ssh", () => {
    const definition = unifiedProfileFormDefinition();
    const keyPathField = definition.fields.find(
      (field): field is Extract<(typeof definition.fields)[number], { key: string }> =>
        "key" in field && field.key === "keyPath"
    );
    expect(keyPathField).toBeDefined();
    expect(Array.isArray(keyPathField!.visibleWhen)).toBe(true);
    expect(keyPathField!.visibleWhen).toEqual([
      { field: "profileType", value: "ssh" },
      { field: "protocol", value: "ssh" },
      { field: "authType", value: "key" }
    ]);
  });

  it("always includes auth profile selector with inline-create option in server form", () => {
    const definition = serverFormDefinition();
    const authProfileField = definition.fields.find(
      (field): field is Extract<(typeof definition.fields)[number], { key: string }> =>
        "key" in field && field.key === "authProfileId"
    );
    expect(authProfileField).toBeDefined();
    expect(authProfileField!.type).toBe("select");
    if (authProfileField && authProfileField.type === "select") {
      expect(authProfileField.options.some((option) => option.value === "__create__authProfile")).toBe(true);
    }
  });

  it("formats key auth profile options with the private key file name", () => {
    const definition = serverFormDefinition(
      undefined,
      [],
      true,
      [],
      [{ id: "ap-1", name: "Shared Key", username: "deploy", authType: "key", keyPath: "/keys/id_ed25519" }]
    );
    const authProfileField = definition.fields.find(
      (field): field is Extract<(typeof definition.fields)[number], { key: string; options: Array<{ label: string; value: string }> }> =>
        "key" in field && field.key === "authProfileId" && "options" in field
    );
    expect(authProfileField).toBeDefined();
    expect(authProfileField!.options.some((option) => option.label === "Shared Key — key — deploy — id_ed25519")).toBe(true);
  });

  /**
   * REVIEW FINDING (P1) — the edit form renders what the LINKED PROFILE will
   * impose, and retains the record's own values beside it rather than in the
   * fields. Showing the record's values under a lock the profile owns is what
   * put the two out of step: `authType` rendered `password` while the profile
   * imposed `key`, which hid (and therefore disabled, and therefore dropped
   * from the submission) the Private Key File control — see the end-to-end
   * proof in authProfileSwitchTransition.test.ts, which follows it all the way
   * to the persisted record. Preservation of the stored values is
   * `preserveLinkedServerCredentials`' job at save, plus the displaced seed
   * below for an unlink; it was never this descriptor's.
   */
  it("renders the linked profile's credentials, and hands the stored ones to the webview's restore seed instead of into the fields", () => {
    const definition = serverFormDefinition(
      {
        id: "srv-1",
        username: "stored-user",
        authType: "password",
        keyPath: "/stored/key",
        authProfileId: "ap-1"
      },
      [],
      true,
      [],
      [{ id: "ap-1", name: "Production", username: "live-user", authType: "key", keyPath: "/live/key" }]
    );

    expect(keyedField(definition, "username").value).toBe("live-user");
    expect(keyedField(definition, "authType").value).toBe("key");
    expect(keyedField(definition, "keyPath").value).toBe("/live/key");

    const select = keyedField(definition, "authProfileId");
    expect(select.type === "select" ? select.autofillDisplacedValues : undefined).toEqual({
      username: "stored-user",
      authType: "password",
      keyPath: "/stored/key"
    });
  });

  it("displaces only the keys the profile actually supplies, so a field it leaves alone keeps the record's value AND stays out of the restore seed (kills overriding on the mere fact of a link: a keyless key profile would blank the server's own key file at render, which is the field it exists to let you set)", () => {
    const definition = serverFormDefinition(
      {
        id: "srv-1",
        username: "stored-user",
        authType: "password",
        keyPath: "/stored/key",
        authProfileId: "ap-keyless"
      },
      [],
      true,
      [],
      [{ id: "ap-keyless", name: "Shared key", username: "live-user", authType: "key" }]
    );

    // Supplied → rendered from the profile, and the record's own is retained.
    expect(keyedField(definition, "username").value).toBe("live-user");
    expect(keyedField(definition, "authType").value).toBe("key");
    // NOT supplied → the record's own file stays in the field, where the
    // profile-imposed `key` auth type now makes it visible and submittable.
    expect(keyedField(definition, "keyPath").value).toBe("/stored/key");

    const select = keyedField(definition, "authProfileId");
    expect(select.type === "select" ? select.autofillDisplacedValues : undefined).toEqual({
      username: "stored-user",
      authType: "password"
    });
  });

  it("displaces nothing when there is no link, or when the linked id resolves to no profile (kills seeding a restore for values no profile replaced — the release would then overwrite the user's own edits with a stale snapshot of the form's opening state)", () => {
    const seed = {
      id: "srv-1",
      username: "stored-user",
      authType: "password" as const,
      keyPath: "/stored/key",
      authProfileId: "ap-gone"
    };
    const profiles = [{ id: "ap-1", name: "Production", username: "live-user", authType: "key" as const, keyPath: "/live/key" }];

    for (const definition of [
      serverFormDefinition({ ...seed, authProfileId: undefined }, [], true, [], profiles),
      serverFormDefinition(seed, [], true, [], profiles)
    ]) {
      expect(keyedField(definition, "username").value).toBe("stored-user");
      expect(keyedField(definition, "authType").value).toBe("password");
      const select = keyedField(definition, "authProfileId");
      // Empty, exactly as `autofillFilledKeys` is `[]` for the same two cases —
      // and `renderField` omits the attribute entirely for an empty record, so
      // the webview seeds nothing.
      expect(select.type === "select" ? select.autofillDisplacedValues : undefined).toEqual({});
    }
  });

  it("marks optional SSH setup fields as advanced in the unified profile form", () => {
    const definition = unifiedProfileFormDefinition();

    for (const key of [
      "authProfileId",
      "proxyType",
      "proxyJumpHostId",
      "proxySocks5Host",
      "proxyHttpHost",
      "multiplexing",
      "legacyAlgorithms",
      "openFileExplorerOnFirstConnect",
      "logSession",
      "group"
    ]) {
      expect(keyedField(definition, key).advanced, key).toBe(true);
    }
  });

  it("adds an SSH-only File Explorer auto-open checkbox to SSH profile forms", () => {
    const editDefinition = serverFormDefinition({
      id: "srv-1",
      name: "Server",
      host: "example.com",
      port: 22,
      username: "dev",
      authType: "password",
      isHidden: false,
      openFileExplorerOnFirstConnect: true
    });
    const editField = keyedField(editDefinition, "openFileExplorerOnFirstConnect");

    expect(editField).toEqual(expect.objectContaining({
      type: "checkbox",
      label: "Open File Explorer on first connection",
      value: true,
      advanced: true,
      hint: "After a normal Connect, opens the File Explorer when it is not already showing this server. Saving this checked disables it on any other SSH profile. Ignored for jump hosts, tunnels, group Connect, and Connect and Run Script.",
      // TELNET (Phase 0) — the SFTP file explorer is SSH-only machinery.
      visibleWhen: { field: "protocol", value: "ssh" }
    }));

    const unifiedField = keyedField(unifiedProfileFormDefinition(), "openFileExplorerOnFirstConnect");
    expect(unifiedField).toEqual(expect.objectContaining({
      type: "checkbox",
      value: false,
      visibleWhen: [
        { field: "profileType", value: "ssh" },
        { field: "protocol", value: "ssh" }
      ]
    }));
    expect(maybeKeyedField(serialFormDefinition(), "openFileExplorerOnFirstConnect")).toBeUndefined();
    expect(maybeKeyedField(localShellFormDefinition(), "openFileExplorerOnFirstConnect")).toBeUndefined();
  });

  it("keeps basic SSH fields visible in the unified profile form", () => {
    const definition = unifiedProfileFormDefinition();

    for (const key of ["profileType", "name", "host", "port", "username", "authType", "keyPath"]) {
      expect(keyedField(definition, key).advanced, key).not.toBe(true);
    }
  });

  it("marks optional serial fields as advanced and keeps connection basics visible", () => {
    const definition = unifiedProfileFormDefinition({ profileType: "serial" });

    for (const key of ["dataBits", "stopBits", "parity", "rtscts", "logSession", "group"]) {
      expect(keyedField(definition, key).advanced, key).toBe(true);
    }
    for (const key of ["profileType", "name", "mode", "path", "baudRate"]) {
      expect(keyedField(definition, key).advanced, key).not.toBe(true);
    }
  });

  it("adds concise hints to first-run profile fields", () => {
    const definition = unifiedProfileFormDefinition();
    const serialDefinition = serialFormDefinition();

    for (const key of ["host", "authType", "keyPath", "baudRate", "group", "proxyType", "legacyAlgorithms", "openFileExplorerOnFirstConnect"]) {
      expect(keyedField(definition, key).hint, key).toBeTruthy();
    }
    expect(keyedField(serialDefinition, "path").hint).toBeTruthy();
  });

  it("uses distinct add form metadata for generic, SSH, and serial entry points", () => {
    const generic = unifiedProfileFormDefinition();
    const ssh = unifiedProfileFormDefinition({ addMode: "ssh" });
    const serial = unifiedProfileFormDefinition({ addMode: "serial" });
    const localShell = unifiedProfileFormDefinition({ addMode: "localShell" });

    expect(generic.title).toBe("Add Profile");
    expect(ssh.title).toBe("Add SSH Server Profile");
    expect(serial.title).toBe("Add Serial Profile");
    expect(localShell.title).toBe("Add Local Shell Profile");
    expect(unifiedProfileFormId()).toBe("profile-add");
    expect(unifiedProfileFormId({ addMode: "ssh" })).toBe("server-add");
    expect(unifiedProfileFormId({ addMode: "serial" })).toBe("serial-add");
    expect(unifiedProfileFormId({ addMode: "localShell" })).toBe("local-shell-add");
  });

  it("locks the profile type selector for explicit SSH, serial, and local shell add forms", () => {
    const ssh = unifiedProfileFormDefinition({ addMode: "ssh" });
    const serial = unifiedProfileFormDefinition({ addMode: "serial" });
    const localShell = unifiedProfileFormDefinition({ addMode: "localShell" });

    expect(keyedField(ssh, "profileType")).toEqual(expect.objectContaining({ type: "hidden", value: "ssh" }));
    expect(keyedField(serial, "profileType")).toEqual(expect.objectContaining({ type: "hidden", value: "serial" }));
    expect(keyedField(localShell, "profileType")).toEqual(expect.objectContaining({ type: "hidden", value: "localShell" }));
  });

  it("adds Local Shell profile type and launch fields to the unified form", () => {
    const definition = unifiedProfileFormDefinition();
    const profileType = keyedField(definition, "profileType");

    expect(profileType).toMatchObject({ type: "select" });
    if (profileType.type === "select") {
      expect(profileType.options).toContainEqual({ label: "Local Shell Profile", value: "localShell" });
    }
    expect(keyedField(definition, "launchMode")).toEqual(expect.objectContaining({
      label: "Launch Mode",
      visibleWhen: { field: "profileType", value: "localShell" }
    }));
    expect(keyedField(definition, "vscodeProfileName")).toEqual(expect.objectContaining({
      type: "combobox",
      label: "VS Code Terminal Profile",
      required: true,
      placeholder: "Select a launchable VS Code terminal profile",
      hint: expect.stringMatching(/mapped PowerShell, Git Bash, Command Prompt, and WSL profiles/i),
      visibleWhen: [
        { field: "profileType", value: "localShell" },
        { field: "launchMode", value: "vscodeProfile" }
      ]
    }));
    expect(definition.fields.some((field) => field.type === "info")).toBe(false);
    expect(keyedField(definition, "shellPath")).toEqual(expect.objectContaining({
      label: "Shell Path",
      required: true,
      hint: expect.stringMatching(/WSL.*wsl\.exe/i),
      visibleWhen: [
        { field: "profileType", value: "localShell" },
        { field: "launchMode", value: "custom" }
      ]
    }));
    expect(keyedField(definition, "shellArgs")).toEqual(expect.objectContaining({
      type: "textarea",
      label: "Arguments"
    }));
  });

  it("marks Local Shell launch-specific fields as required in direct forms", () => {
    const definition = localShellFormDefinition(undefined, undefined, {
      vscodeTerminalProfileNames: ["PowerShell", "Ubuntu"]
    });

    expect(keyedField(definition, "vscodeProfileName")).toEqual(expect.objectContaining({
      type: "combobox",
      required: true,
      suggestions: ["PowerShell", "Ubuntu"],
      visibleWhen: { field: "launchMode", value: "vscodeProfile" }
    }));
    expect(keyedField(definition, "shellPath")).toEqual(expect.objectContaining({
      required: true,
      hint: expect.stringMatching(/WSL.*wsl\.exe/i),
      visibleWhen: { field: "launchMode", value: "custom" }
    }));
    expect(definition.fields.some((field) => field.type === "info")).toBe(false);
  });

  it("marks Local Shell working directory and startup command as advanced with hints", () => {
    const definition = localShellFormDefinition();

    expect(keyedField(definition, "cwd")).toEqual(expect.objectContaining({
      label: "Working Directory",
      advanced: true,
      hint: expect.stringMatching(/\$\{workspaceFolder\}.*~/i)
    }));
    expect(keyedField(definition, "startupCommand")).toEqual(expect.objectContaining({
      label: "Startup Command",
      advanced: true,
      hint: expect.stringMatching(/sent/i)
    }));
  });

  it("omits transcript logging from Local Shell forms", () => {
    expect(keyedField(unifiedProfileFormDefinition(), "logSession").visibleWhen).toEqual({
      field: "profileType",
      value: ["ssh", "serial"]
    });
    expect(maybeKeyedField(localShellFormDefinition(), "logSession")).toBeUndefined();
    expect(maybeKeyedField(unifiedProfileFormDefinition({ addMode: "localShell" }), "logSession")).toBeUndefined();
    expect(keyedField(unifiedProfileFormDefinition({ addMode: "ssh" }), "logSession")).toBeDefined();
    expect(keyedField(unifiedProfileFormDefinition({ addMode: "serial" }), "logSession")).toBeDefined();
  });
});

describe("inventorySourceFormDefinition", () => {
  const fakeProvider: InventoryProvider = {
    id: "fake",
    label: "Fake Provider",
    configFields: [
      { id: "pollInterval", label: "Poll Interval", type: "number", placeholder: "seconds" }
    ],
    testConnection: async () => undefined,
    fetchInventory: async () => ({ nodes: [] }) as never
  };

  /**
   * EVE-NG (Phase 1) — `InventoryConfigField.defaultValue` for boolean fields.
   * A provider's documented default used to be unreachable: the checkbox was
   * always seeded `existingConfig[field.id] === true`, so a NEW source stored
   * `false` however the provider described the field.
   */
  describe("boolean field defaults", () => {
    const boolProvider = (defaultValue?: boolean): InventoryProvider => ({
      ...fakeProvider,
      configFields: [{ id: "includeStopped", label: "Include Stopped", type: "boolean", defaultValue }]
    });
    const seedWith = (config: Record<string, string | number | boolean>) => ({
      id: "src1",
      providerId: "fake",
      name: "Fake",
      targetFolder: "",
      prunePolicy: "orphan" as const,
      defaultUsername: "",
      config,
      secretFieldIds: []
    });

    it("starts a defaultValue:true boolean CHECKED on Add (⊘ seeding purely from the stored config leaves it unchecked, and the source silently imports none of the population the provider says it defaults to importing)", () => {
      const field = keyedField(inventorySourceFormDefinition(boolProvider(true)), "cfg_includeStopped");
      expect(field.type).toBe("checkbox");
      expect((field as Extract<FormFieldDescriptor, { type: "checkbox" }>).value).toBe(true);
    });

    it("leaves a boolean with no declared default unchecked on Add — NetBox's includeVms is byte-identical to before (⊘ defaulting every boolean to true silently turns VM import on for every new NetBox source)", () => {
      const field = keyedField(inventorySourceFormDefinition(boolProvider(undefined)), "cfg_includeStopped");
      expect((field as Extract<FormFieldDescriptor, { type: "checkbox" }>).value).toBe(false);
    });

    it("honours a STORED false over a defaultValue:true when editing — the user unchecked it, and a default that re-checks it every visit is a setting that cannot be turned off (⊘ `existingConfig[id] || defaultValue` reads a stored `false` as absent and re-checks the box)", () => {
      const definition = inventorySourceFormDefinition(boolProvider(true), seedWith({ includeStopped: false }));
      const field = keyedField(definition, "cfg_includeStopped");
      expect((field as Extract<FormFieldDescriptor, { type: "checkbox" }>).value).toBe(false);
    });

    it("still shows a stored true as checked when the default is false", () => {
      const definition = inventorySourceFormDefinition(boolProvider(false), seedWith({ includeStopped: true }));
      const field = keyedField(definition, "cfg_includeStopped");
      expect((field as Extract<FormFieldDescriptor, { type: "checkbox" }>).value).toBe(true);
    });
  });

  // EVE-NG (Phase 1) — the Target Folder placeholder is an EXAMPLE shown on
  // every provider's source form, so it must not read as an instruction to
  // name a folder after one specific provider.
  it("gives Target Folder a provider-neutral example placeholder (\u2298 \"e.g. Datacenter/NetBox\" is a NetBox instruction on an EVE-NG form)", () => {
    const field = keyedField(inventorySourceFormDefinition(fakeProvider), "targetFolder");
    const placeholder = String((field as { placeholder?: string }).placeholder ?? "");
    expect(placeholder).not.toMatch(/NetBox/i);
    expect(placeholder).toContain("e.g.");
  });

  it("marks a provider-declared number field with step \"any\" so fractional values pass native validation (kills the missing-step regression)", () => {
    const definition = inventorySourceFormDefinition(fakeProvider);
    const field = keyedField(definition, "cfg_pollInterval");
    expect(field.type).toBe("number");
    expect((field as Extract<FormFieldDescriptor, { type: "number" }>).step).toBe("any");
  });

  it("carries the fractional value through unchanged when reopening a source that already stores one", () => {
    const definition = inventorySourceFormDefinition(fakeProvider, {
      id: "src1",
      providerId: "fake",
      name: "Fake",
      targetFolder: "",
      prunePolicy: "orphan",
      defaultUsername: "",
      config: { pollInterval: 0.5 },
      secretFieldIds: []
    });
    const field = keyedField(definition, "cfg_pollInterval") as Extract<FormFieldDescriptor, { type: "number" }>;
    expect(field.value).toBe(0.5);
    expect(field.step).toBe("any");
  });

  const authProfiles: AuthProfile[] = [
    { id: "p1", name: "Lab credentials", username: "labuser", authType: "password" },
    { id: "p2", name: "Prod key", username: "deploy", authType: "key", keyPath: "/keys/id_ed25519" }
  ];

  function sourceSeed(overrides: Partial<InventorySourceConfig> = {}): InventorySourceConfig {
    return {
      id: "src1",
      providerId: "fake",
      name: "Fake",
      targetFolder: "",
      prunePolicy: "orphan",
      defaultUsername: "seeded-user",
      config: {},
      secretFieldIds: [],
      ...overrides
    };
  }

  it("renders the Auth Profile select outside Advanced, directly above Default SSH Username", () => {
    const definition = inventorySourceFormDefinition(fakeProvider, undefined, undefined, authProfiles);
    const keys = definition.fields.map((field) => ("key" in field ? field.key : undefined));
    const authProfileIndex = keys.indexOf("authProfileId");
    const defaultUsernameIndex = keys.indexOf("defaultUsername");

    expect(authProfileIndex).toBeGreaterThan(-1);
    expect(defaultUsernameIndex).toBe(authProfileIndex + 1);

    const field = keyedField(definition, "authProfileId");
    // The whole point of the feature: on this form the select is the primary
    // auth decision, not a power-user shortcut buried in Advanced (which is
    // where the shared helper's default puts it, and where the server form
    // keeps it).
    expect(field.advanced).toBeFalsy();
    expect(field.type).toBe("select");
    expect(field.hint).toBe(
      "Servers synced from this source connect with this profile's saved credentials. (None) uses the default username with SSH agent authentication."
    );
    if (field.type === "select") {
      expect(field.autofill).toBe(true);
      expect(field.value).toBe("");
      expect(field.options).toEqual([
        { label: "(None)", value: "" },
        { label: formatAuthProfileLabel(authProfiles[0]), value: "p1" },
        { label: formatAuthProfileLabel(authProfiles[1]), value: "p2" },
        { label: "Create new auth profile…", value: "__create__authProfile" }
      ]);
    }
  });

  it("the Default SSH Username hint explains why the field stays visible but locked while a profile is selected", () => {
    const definition = inventorySourceFormDefinition(fakeProvider, undefined, undefined, authProfiles);
    const field = keyedField(definition, "defaultUsername");
    // Selecting a profile mirrors its username in here and makes the field
    // read-only and dimmed. A hint that stops at the first sentence leaves the
    // user staring at a locked field with no explanation of where its value
    // came from or why it is still worth having.
    expect(field.hint).toBe(
      "Used when the inventory source doesn't provide a username. With an auth profile selected it comes from that profile, and is the fallback if the profile is ever removed."
    );
  });

  it("leaves the server and unified profile forms' Auth Profile select advanced with its original hint", () => {
    for (const definition of [serverFormDefinition(), unifiedProfileFormDefinition()]) {
      const field = keyedField(definition, "authProfileId");
      expect(field.advanced).toBe(true);
      expect(field.hint).toBe("Reuse saved SSH credentials instead of entering them here.");
    }
  });

  it("sanitizes a dangling seeded auth profile id to the (None) value so the form cannot submit a dead id", () => {
    const definition = inventorySourceFormDefinition(
      fakeProvider,
      sourceSeed({ authProfileId: "ghost" }),
      undefined,
      authProfiles
    );
    const field = keyedField(definition, "authProfileId");
    expect(field.type).toBe("select");
    if (field.type === "select") {
      // Passing "ghost" straight through would render the (None) LABEL (the
      // select renderer falls back to options[0] for the label) while the
      // hidden input still carries "ghost" as its VALUE — displaying one thing
      // and submitting another.
      expect(field.value).toBe("");
      expect(field.options.some((option) => option.value === "ghost")).toBe(false);
    }
  });

  it("keeps a seeded auth profile id that still resolves", () => {
    const definition = inventorySourceFormDefinition(
      fakeProvider,
      sourceSeed({ authProfileId: "p1" }),
      undefined,
      authProfiles
    );
    const field = keyedField(definition, "authProfileId");
    if (field.type === "select") {
      expect(field.value).toBe("p1");
    }
  });

  /**
   * REVIEW FINDING (P2) — the OTHER render-time half, and the source form's
   * copy of what `serverFormDefinition` already does: the lock seed above says
   * Default SSH Username is the profile's, so the field must SHOW the profile's
   * value. Rendering the record's underneath that lock is how the form came to
   * display one username and Save store another — `fallbackUsernameForSource`
   * (inventoryCommands.ts) derives the stored value from the live profile, so
   * the two part company the moment the profile is renamed, and the lock means
   * the user cannot even see it happen. Followed all the way to the persisted
   * record in inventoryCommands.test.ts.
   */
  it("renders Default SSH Username from the LINKED PROFILE, and hands the stored fallback to the webview's restore seed instead of leaving it in the field", () => {
    const definition = inventorySourceFormDefinition(
      fakeProvider,
      sourceSeed({ authProfileId: "p1", defaultUsername: "stored-fallback" }),
      undefined,
      authProfiles
    );

    expect(keyedField(definition, "defaultUsername").value).toBe("labuser");
    const select = keyedField(definition, "authProfileId");
    expect(select.type === "select" ? select.autofillDisplacedValues : undefined).toEqual({
      defaultUsername: "stored-fallback"
    });
  });

  it("keeps the record's own username, and seeds no restore, for a profile that supplies none (kills displacing on the mere fact of a link: that field is not locked for such a profile, so a restore entry would overwrite an edit the user is free to make)", () => {
    const blank: AuthProfile[] = [{ id: "p3", name: "Imported", username: "   ", authType: "password" }];
    const definition = inventorySourceFormDefinition(
      fakeProvider,
      sourceSeed({ authProfileId: "p3", defaultUsername: "stored-fallback" }),
      undefined,
      blank
    );

    expect(keyedField(definition, "defaultUsername").value).toBe("stored-fallback");
    const select = keyedField(definition, "authProfileId");
    expect(select.type === "select" ? select.autofillDisplacedValues : undefined).toEqual({});
  });

  it("displaces nothing on Add, nor when the seeded id resolves to no profile (kills seeding a restore for a value no profile replaced — the next release would then overwrite what the user typed)", () => {
    for (const definition of [
      inventorySourceFormDefinition(fakeProvider, undefined, "most-common-account", authProfiles),
      inventorySourceFormDefinition(fakeProvider, sourceSeed({ authProfileId: "ghost" }), undefined, authProfiles)
    ]) {
      expect(keyedField(definition, "defaultUsername").value).not.toBe("labuser");
      const select = keyedField(definition, "authProfileId");
      expect(select.type === "select" ? select.autofillDisplacedValues : undefined).toEqual({});
    }
  });

  /**
   * REVIEW FINDING (P2) — the render-time half of field-ownership tracking. The
   * webview locks exactly the keys it has been told the selected profile fills;
   * before the first autofill round trip, this is the only source of that.
   */
  describe("autofillFilledKeys — which managed fields the selected profile fills", () => {
    function filledKeys(definition: ReturnType<typeof inventorySourceFormDefinition>): string[] | undefined {
      const field = keyedField(definition, "authProfileId");
      return field.type === "select" ? field.autofillFilledKeys : undefined;
    }

    it("claims the username keys for a profile that has one, and the key path only for a key profile that has one", () => {
      expect(filledKeys(inventorySourceFormDefinition(fakeProvider, sourceSeed({ authProfileId: "p1" }), undefined, authProfiles)))
        .toEqual(["username", "authType", "defaultUsername"]);
      expect(filledKeys(inventorySourceFormDefinition(fakeProvider, sourceSeed({ authProfileId: "p2" }), undefined, authProfiles)))
        .toEqual(["username", "authType", "keyPath", "defaultUsername"]);
    });

    it("claims NO username key for a profile whose username is whitespace-only (kills seeding ownership from the mere fact that a profile is linked: the form opens with Default SSH Username prefilled — from the record on Edit, from mostCommonUsername on Add — and such a profile fills none of it, so locking it freezes the user's own fallback with no way to change it)", () => {
      const blank: AuthProfile[] = [{ id: "p3", name: "Imported", username: "   ", authType: "password" }];
      const definition = inventorySourceFormDefinition(
        fakeProvider,
        sourceSeed({ authProfileId: "p3", defaultUsername: "labuser" }),
        undefined,
        blank
      );
      expect(filledKeys(definition)).toEqual(["authType"]);
    });

    it("claims nothing when no profile is selected, or when the seeded id resolves to none", () => {
      expect(filledKeys(inventorySourceFormDefinition(fakeProvider, undefined, undefined, authProfiles))).toEqual([]);
      expect(filledKeys(inventorySourceFormDefinition(fakeProvider, sourceSeed({ authProfileId: "ghost" }), undefined, authProfiles)))
        .toEqual([]);
    });

    /**
     * REVIEW FINDING (P2) — the seed is a DERIVATION of the shared ownership
     * rule (`authProfileOwnedCredentials`, models/config.ts), not a second
     * opinion about it. The connect path and the save path read that same rule,
     * so pinning the seed to it here is what stops the three drifting apart
     * again — which is exactly how both findings on this branch arose.
     */
    it("is the shared ownership rule, key for key, on both forms that render the select", () => {
      const cases: AuthProfile[] = [
        { id: "c1", name: "Password", username: "root", authType: "password" },
        { id: "c2", name: "Key", username: "root", authType: "key", keyPath: "/keys/id" },
        { id: "c3", name: "Imported blank", username: "   ", authType: "password" },
        { id: "c4", name: "Keyless key", username: "root", authType: "key" },
        { id: "c5", name: "Padded", username: "  bob  ", authType: "key", keyPath: "   " }
      ];

      for (const profile of cases) {
        const owned = authProfileOwnedCredentials(profile);
        // The order is the webview lock loop's own managedKeys order, and
        // `defaultUsername` is the inventory source form's name for the very
        // username key the server form calls `username`.
        const expected = [
          ...(owned.username !== undefined ? ["username"] : []),
          ...(owned.authType !== undefined ? ["authType"] : []),
          ...(owned.keyPath !== undefined ? ["keyPath"] : []),
          ...(owned.username !== undefined ? ["defaultUsername"] : [])
        ];

        expect(
          filledKeys(inventorySourceFormDefinition(fakeProvider, sourceSeed({ authProfileId: profile.id }), undefined, [profile])),
          `inventory source form seed for ${profile.name}`
        ).toEqual(expected);

        const serverDefinition = serverFormDefinition(
          { id: "s1", name: "S", host: "h", port: 22, username: "stored", authType: "password", isHidden: false, authProfileId: profile.id },
          [],
          false,
          [],
          [profile]
        );
        const serverField = keyedField(serverDefinition, "authProfileId");
        expect(
          serverField.type === "select" ? serverField.autofillFilledKeys : undefined,
          `server form seed for ${profile.name}`
        ).toEqual(expected);
      }
    });
  });
});

/**
 * SAVED FILTER DEFINITIONS (issue #48 PR-E, backlog #1) — the "Saved Filter"
 * picker rendered directly above the Device Filter field, and the minimal
 * `select` config-field support the family preference (#3) rides on.
 */
describe("inventorySourceFormDefinition — saved-filter picker (PR-E)", () => {
  const netboxLike: InventoryProvider = {
    id: "nb",
    label: "NetBox-like",
    configFields: [
      { id: "baseUrl", label: "Base URL", type: "string", required: true },
      { id: "filter", label: "Device Filter", type: "string" },
      {
        id: "primaryIpFamily",
        label: "Primary IP Family",
        type: "select",
        options: [
          { label: "Automatic", value: "auto" },
          { label: "Prefer IPv4", value: "prefer-ipv4" },
          { label: "Prefer IPv6", value: "prefer-ipv6" }
        ]
      }
    ],
    testConnection: async () => undefined,
    fetchInventory: async () => ({ nodes: [] }) as never
  };
  const noFilterProvider: InventoryProvider = {
    id: "x",
    label: "No filter",
    configFields: [{ id: "baseUrl", label: "Base URL", type: "string", required: true }],
    testConnection: async () => undefined,
    fetchInventory: async () => ({ nodes: [] }) as never
  };
  const savedFilters: SavedFilterDefinition[] = [
    { id: "sf1", name: "Syd core", filter: "role=core&site=syd" },
    { id: "sf2", name: "Edge", filter: "role=edge" }
  ];

  it("renders the Saved Filter picker directly ABOVE the Device Filter field (kills placing it away from the field it fills)", () => {
    const definition = inventorySourceFormDefinition(netboxLike, undefined, undefined, [], [], savedFilters);
    const keys = definition.fields.map((f) => ("key" in f ? f.key : undefined));
    const pickerIndex = keys.indexOf(SAVED_FILTER_SELECT_KEY);
    const filterIndex = keys.indexOf("cfg_filter");
    expect(pickerIndex).toBeGreaterThan(-1);
    expect(filterIndex).toBeGreaterThan(-1);
    // Immediately above — the two read as one control.
    expect(pickerIndex).toBe(filterIndex - 1);
  });

  it("the picker offers each saved filter plus the save-current sentinel, and is a filterable SYNCHRONOUS-fill select (kills the async-autofill wiring FIX B removed)", () => {
    const definition = inventorySourceFormDefinition(netboxLike, undefined, undefined, [], [], savedFilters);
    const picker = keyedField(definition, SAVED_FILTER_SELECT_KEY);
    expect(picker.type).toBe("select");
    const select = picker as Extract<FormFieldDescriptor, { type: "select" }>;
    // FIX B (PR #64 Codex round 2) — the async round trip is gone: the picker no
    // longer opts into `autofill` and instead names its synchronous fill target.
    expect(select.autofill).toBeFalsy();
    expect(select.fillTarget).toBe("cfg_filter");
    expect(select.filterable).toBe(true);
    const values = select.options.map((o) => o.value);
    expect(values).toContain("");
    expect(values).toContain("sf1");
    expect(values).toContain("sf2");
    expect(values).toContain(SAVED_FILTER_SAVE_CURRENT_SENTINEL);
    // Only the real definition options carry a raw fillValue (the query string);
    // the (None) and save-current sentinels carry none, so picking them never fills.
    const byValue = new Map(select.options.map((o) => [o.value, o] as const));
    expect(byValue.get("sf1")!.fillValue).toBe("role=core&site=syd");
    expect(byValue.get("sf2")!.fillValue).toBe("role=edge");
    expect(byValue.get("")!.fillValue).toBeUndefined();
    expect(byValue.get(SAVED_FILTER_SAVE_CURRENT_SENTINEL)!.fillValue).toBeUndefined();
  });

  it("renders constructively with ZERO saved filters — still offers the save-current sentinel (kills a dead-end empty state)", () => {
    const definition = inventorySourceFormDefinition(netboxLike, undefined, undefined, [], [], []);
    const picker = keyedField(definition, SAVED_FILTER_SELECT_KEY) as Extract<FormFieldDescriptor, { type: "select" }>;
    expect(picker.options.map((o) => o.value)).toContain(SAVED_FILTER_SAVE_CURRENT_SENTINEL);
  });

  it("does NOT render the picker for a provider with no Device Filter field (kills showing a fill-nothing picker)", () => {
    const definition = inventorySourceFormDefinition(noFilterProvider, undefined, undefined, [], [], savedFilters);
    expect(maybeKeyedField(definition, SAVED_FILTER_SELECT_KEY)).toBeUndefined();
  });

  it("the picker never persists — parse ignores its key; the source stores only its own cfg_filter copy", () => {
    // The picker is a pure fill control (its key is not a stored source field), so
    // even a stray value on it changes nothing about what a save would persist.
    const definition = inventorySourceFormDefinition(netboxLike, undefined, undefined, [], [], savedFilters);
    const picker = keyedField(definition, SAVED_FILTER_SELECT_KEY) as Extract<FormFieldDescriptor, { type: "select" }>;
    // Opens on (None) — a source links to no definition, only copies its value.
    expect(picker.value).toBe("");
  });

  it("a select config field renders as a form select defaulting to its first option for a source with no stored value", () => {
    const definition = inventorySourceFormDefinition(netboxLike, undefined, undefined, [], [], []);
    const family = keyedField(definition, "cfg_primaryIpFamily") as Extract<FormFieldDescriptor, { type: "select" }>;
    expect(family.type).toBe("select");
    expect(family.value).toBe("auto");
    expect(family.options.map((o) => o.value)).toEqual(["auto", "prefer-ipv4", "prefer-ipv6"]);
  });

  it("a select config field carries a stored value through on reopen (kills a select that resets to default on edit)", () => {
    const seed: InventorySourceConfig = {
      id: "s1",
      providerId: "nb",
      name: "S",
      targetFolder: "",
      prunePolicy: "orphan",
      defaultUsername: "u",
      config: { primaryIpFamily: "prefer-ipv4" },
      secretFieldIds: []
    };
    const definition = inventorySourceFormDefinition(netboxLike, seed, undefined, [], [], []);
    const family = keyedField(definition, "cfg_primaryIpFamily") as Extract<FormFieldDescriptor, { type: "select" }>;
    expect(family.value).toBe("prefer-ipv4");
  });
});

/**
 * Issue #48 PR-B — the BMC fields on the server form. Both are Advanced (a
 * server with no BMC should not be asked about one) and both carry a hint that
 * says exactly what the setting does, which is the whole of their discoverability.
 */
describe("formDefinitions — IPMI auth profile and BMC web protocol", () => {
  const profiles: AuthProfile[] = [
    { id: "ap-ssh", name: "SSH accounts", username: "deploy", authType: "password" },
    { id: "ap-bmc", name: "BMC accounts", username: "bmc-operator", authType: "password" }
  ];

  it("offers every auth profile as an IPMI credential, seeded from the record", () => {
    const definition = serverFormDefinition({ ipmiAuthProfileId: "ap-bmc" }, [], true, [], profiles);
    const field = keyedField(definition, "ipmiAuthProfileId");

    expect(field.type).toBe("select");
    expect(field.advanced).toBe(true);
    expect(field.value).toBe("ap-bmc");
    if (field.type === "select") {
      // C2 — the inline "Create new auth profile…" escape hatch is offered here
      // too, so an empty list is not a dead end. It shares the SSH select's
      // sentinel (`__create__authProfile`); the follow-up MIRRORING into the SSH
      // credential fields is gated on autofill, which this field does not set
      // (see the autofill test below), so a created profile is appended and
      // selected without touching the SSH controls.
      expect(field.options.map((o) => o.value)).toEqual(["", "ap-ssh", "ap-bmc", "__create__authProfile"]);
    }
  });

  it("does NOT autofill — the BMC account must never overwrite the SSH credential fields", () => {
    // The one property that separates this select from `authProfileId`: autofill
    // drives the webview's mirror-and-lock of username/authType/keyPath, and the
    // BMC login is a different account on a different interface.
    const definition = serverFormDefinition({ ipmiAuthProfileId: "ap-bmc" }, [], true, [], profiles);
    const field = keyedField(definition, "ipmiAuthProfileId");
    expect(field.autofill).toBeUndefined();
    expect(keyedField(definition, "authProfileId").autofill).toBe(true);
  });

  it("tells the user what the link grants and what it ignores", () => {
    const hint = keyedField(serverFormDefinition(undefined, [], true, [], profiles), "ipmiAuthProfileId").hint ?? "";
    expect(hint).toContain("${profile.ipmiUsername}");
    expect(hint).toContain("environment");
    expect(hint).toMatch(/never the command line/i);
    // The documented limit of the link (see the cut line: no keyPath/authType
    // semantics on it).
    expect(hint).toMatch(/authentication type and key file are ignored/i);
  });

  it("defaults the BMC web protocol to HTTPS and warns about the alternative", () => {
    const field = keyedField(serverFormDefinition(undefined, [], true, [], profiles), "bmcWebProtocol");
    expect(field.advanced).toBe(true);
    expect(field.value).toBe("https");
    if (field.type === "select") {
      expect(field.options.map((o) => o.value)).toEqual(["https", "http"]);
    }
    expect(field.hint ?? "").toMatch(/clear text/i);
  });

  it("renders http when the record chose it, and https for anything else stored there", () => {
    expect(keyedField(serverFormDefinition({ bmcWebProtocol: "http" }), "bmcWebProtocol").value).toBe("http");
    // A garbage stored value renders as the default rather than as an empty
    // select the user cannot interpret — the same reading the runtime makes.
    expect(
      keyedField(serverFormDefinition({ bmcWebProtocol: "ftp" as unknown as "http" }), "bmcWebProtocol").value
    ).toBe("https");
  });

  it("carries both fields into the unified Add Profile form, scoped to the SSH type", () => {
    const definition = unifiedProfileFormDefinition(undefined, [], true, [], profiles);
    expect(keyedField(definition, "ipmiAuthProfileId").visibleWhen).toEqual({ field: "profileType", value: "ssh" });
    expect(keyedField(definition, "bmcWebProtocol").visibleWhen).toEqual({ field: "profileType", value: "ssh" });
  });
});

describe("PR-F1 — filterable adopters (backlog #4)", () => {
  function selectField(definition: FormDefinition, key: string): Extract<FormFieldDescriptor, { type: "select" }> {
    const field = keyedField(definition, key);
    expect(field.type, `field ${key} should be a select`).toBe("select");
    return field as Extract<FormFieldDescriptor, { type: "select" }>;
  }

  it("makes the Jump Host Server select filterable (the headline fix — falsifies dropping the flag from proxyJumpHostId)", () => {
    const definition = serverFormDefinition(undefined, [], true, [{ id: "s2", name: "Other", host: "h" } as never]);
    expect(selectField(definition, "proxyJumpHostId").filterable).toBe(true);
  });

  it("makes the SSH Auth Profile select filterable", () => {
    const definition = serverFormDefinition(undefined, [], true, [], [
      { id: "p1", name: "Prod", username: "root", authType: "password" }
    ]);
    expect(selectField(definition, "authProfileId").filterable).toBe(true);
  });

  it("makes the IPMI Auth Profile select filterable", () => {
    const definition = serverFormDefinition(undefined, [], true, [], [
      { id: "p1", name: "Prod", username: "root", authType: "password" }
    ]);
    expect(selectField(definition, "ipmiAuthProfileId").filterable).toBe(true);
  });

  it("makes the tunnel's target-server select filterable", () => {
    const definition = tunnelFormDefinition(undefined, {
      servers: [{ id: "s1", name: "web-1" }]
    } as never);
    expect(selectField(definition, "defaultServerId").filterable).toBe(true);
  });

  it("leaves small fixed-domain selects alone — authType is NOT filterable (filtering a 3-option list is noise)", () => {
    const definition = serverFormDefinition();
    expect(selectField(definition, "authType").filterable).toBeFalsy();
  });
});
