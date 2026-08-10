import { describe, expect, it } from "vitest";
import { mergeServerConfigFields, serverConfigsEqual } from "../../src/models/config";
import type { ServerConfig } from "../../src/models/config";
import { validateServerConfig } from "../../src/utils/validation";
import { serverFormDefinition, unifiedProfileFormDefinition } from "../../src/ui/formDefinitions";
import type { FormDefinition, FormFieldDescriptor } from "../../src/ui/formTypes";

function server(overrides: Partial<ServerConfig> = {}): ServerConfig {
  return {
    id: "s1",
    name: "core-sw",
    host: "10.0.0.1",
    port: 22,
    username: "admin",
    authType: "agent",
    isHidden: false,
    ...overrides
  };
}

function keyedField(definition: FormDefinition, key: string): Extract<FormFieldDescriptor, { key: string }> | undefined {
  return definition.fields.find(
    (candidate): candidate is Extract<FormFieldDescriptor, { key: string }> =>
      "key" in candidate && candidate.key === key
  );
}

describe("ServerConfig.altHost — field-enumeration sites", () => {
  it("two servers differing ONLY in altHost are not equal (kills a comparator that forgot the new field)", () => {
    // Constructed so the field is the ONLY difference: with anything else
    // differing, a comparator that skips altHost still answers false and the
    // fixture would prove nothing.
    const withAlt = server({ altHost: "2001:db8::1" });
    const withoutAlt = server();
    expect(serverConfigsEqual(withAlt, withoutAlt)).toBe(false);
    expect(serverConfigsEqual(withAlt, server({ altHost: "2001:db8::2" }))).toBe(false);
    expect(serverConfigsEqual(withAlt, server({ altHost: "2001:db8::1" }))).toBe(true);
    expect(serverConfigsEqual(withoutAlt, server())).toBe(true);
  });

  it("the rollback merge keeps a concurrently-written altHost instead of reverting it", () => {
    // prior: before the (now-rejected) batch write. batchSnapshot: what the
    // batch wrote. current: the live record, whose altHost a concurrent edit
    // set. altHost is the ONLY field separating batchSnapshot from current, so a
    // merge that does not compare it reverts the user's edit to `prior`'s value —
    // here, to no alternate address at all.
    const prior = server({ altHost: undefined });
    const batchSnapshot = server({ name: "renamed", altHost: undefined });
    const current = server({ name: "renamed", altHost: "2001:db8::1" });

    expect(mergeServerConfigFields(prior, batchSnapshot, current).altHost).toBe("2001:db8::1");
  });

  it("the rollback merge discards the rejected batch's altHost when nothing else touched it", () => {
    const prior = server({ altHost: "2001:db8::1" });
    const batchSnapshot = server({ altHost: "2001:db8::2" });
    const current = server({ altHost: "2001:db8::2" });

    expect(mergeServerConfigFields(prior, batchSnapshot, current).altHost).toBe("2001:db8::1");
  });
});

describe("validateServerConfig — altHost", () => {
  it("accepts absent, empty and ordinary values", () => {
    expect(validateServerConfig(server())).toBe(true);
    expect(validateServerConfig(server({ altHost: "" }))).toBe(true);
    expect(validateServerConfig(server({ altHost: "2001:db8::1" }))).toBe(true);
  });

  it("rejects a non-string, which no writer of ours produces", () => {
    expect(validateServerConfig({ ...server(), altHost: 42 })).toBe(false);
    expect(validateServerConfig({ ...server(), altHost: { host: "x" } })).toBe(false);
  });
});

describe("server form — Alternate host field", () => {
  it("is offered on the edit form, advanced, and seeded from the record", () => {
    const field = keyedField(serverFormDefinition({ id: "s1", altHost: "2001:db8::1" }), "altHost");
    expect(field).toBeDefined();
    expect(field?.type).toBe("text");
    expect(field?.label).toBe("Alternate host");
    expect(field && "advanced" in field ? field.advanced : undefined).toBe(true);
    expect(field && "value" in field ? field.value : undefined).toBe("2001:db8::1");
    // Never required — a server with a single address must still be savable.
    expect(field && "required" in field ? field.required : undefined).toBeFalsy();
  });

  it("is offered on the unified add form too", () => {
    expect(keyedField(unifiedProfileFormDefinition(), "altHost")).toBeDefined();
  });
});
