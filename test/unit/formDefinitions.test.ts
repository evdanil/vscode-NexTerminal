import { describe, expect, it } from "vitest";
import {
  localShellFormDefinition,
  serialFormDefinition,
  serverFormDefinition,
  unifiedProfileFormDefinition,
  unifiedProfileFormId
} from "../../src/ui/formDefinitions";
import type { FormDefinition, FormFieldDescriptor } from "../../src/ui/formTypes";

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
  it("shows server keyPath field only for authType=key", () => {
    const visibleWhen = keyPathVisibleWhen(serverFormDefinition());
    expect(visibleWhen).toEqual({ field: "authType", value: "key" });
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

  it("preserves stored server credentials in edit form when auth profile is linked", () => {
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
    const usernameField = definition.fields.find(
      (field): field is Extract<(typeof definition.fields)[number], { key: string; value?: unknown }> =>
        "key" in field && field.key === "username"
    );
    expect(usernameField).toBeDefined();
    expect(usernameField!.value).toBe("stored-user");
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
      "logSession",
      "group"
    ]) {
      expect(keyedField(definition, key).advanced, key).toBe(true);
    }
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

    for (const key of ["host", "authType", "keyPath", "baudRate", "group", "proxyType", "legacyAlgorithms"]) {
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
      placeholder: "Select a VS Code terminal profile with a shell path",
      hint: expect.stringMatching(/Custom Shell.*WSL/i),
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
