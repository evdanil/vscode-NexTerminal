import { describe, expect, it } from "vitest";
import {
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

    expect(generic.title).toBe("Add Profile");
    expect(ssh.title).toBe("Add SSH Server");
    expect(serial.title).toBe("Add Serial Profile");
    expect(unifiedProfileFormId()).toBe("profile-add");
    expect(unifiedProfileFormId({ addMode: "ssh" })).toBe("server-add");
    expect(unifiedProfileFormId({ addMode: "serial" })).toBe("serial-add");
  });

  it("locks the profile type selector for explicit SSH and serial add forms", () => {
    const ssh = unifiedProfileFormDefinition({ addMode: "ssh" });
    const serial = unifiedProfileFormDefinition({ addMode: "serial" });

    expect(keyedField(ssh, "profileType")).toEqual(expect.objectContaining({ type: "hidden", value: "ssh" }));
    expect(keyedField(serial, "profileType")).toEqual(expect.objectContaining({ type: "hidden", value: "serial" }));
  });
});
