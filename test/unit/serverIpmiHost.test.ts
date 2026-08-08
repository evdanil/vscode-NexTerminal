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

describe("ServerConfig.ipmiHost — field-enumeration sites", () => {
  it("two servers differing ONLY in ipmiHost are not equal (kills a comparator that forgot the new field)", () => {
    // Constructed so the field is the ONLY difference: with anything else
    // differing, a comparator that skips ipmiHost still answers false and the
    // fixture would prove nothing.
    const withBmc = server({ ipmiHost: "10.0.0.99" });
    const withoutBmc = server();
    expect(serverConfigsEqual(withBmc, withoutBmc)).toBe(false);
    expect(serverConfigsEqual(withBmc, server({ ipmiHost: "10.0.0.98" }))).toBe(false);
    expect(serverConfigsEqual(withBmc, server({ ipmiHost: "10.0.0.99" }))).toBe(true);
    expect(serverConfigsEqual(withoutBmc, server())).toBe(true);
  });

  it("the rollback merge keeps a concurrently-written ipmiHost instead of reverting it", () => {
    // prior: before the (now-rejected) batch write. batchSnapshot: what the
    // batch wrote. current: the live record, whose ipmiHost a concurrent edit
    // set. ipmiHost is the ONLY field separating batchSnapshot from current, so
    // a merge that does not compare it reverts the user's edit to `prior`'s
    // value — here, to no BMC address at all.
    const prior = server({ ipmiHost: undefined });
    const batchSnapshot = server({ name: "renamed", ipmiHost: undefined });
    const current = server({ name: "renamed", ipmiHost: "10.0.0.99" });

    expect(mergeServerConfigFields(prior, batchSnapshot, current).ipmiHost).toBe("10.0.0.99");
  });

  it("the rollback merge discards the rejected batch's ipmiHost when nothing else touched it", () => {
    const prior = server({ ipmiHost: "10.0.0.1" });
    const batchSnapshot = server({ ipmiHost: "192.168.0.1" });
    const current = server({ ipmiHost: "192.168.0.1" });

    expect(mergeServerConfigFields(prior, batchSnapshot, current).ipmiHost).toBe("10.0.0.1");
  });
});

describe("validateServerConfig — ipmiHost", () => {
  it("accepts absent, empty and ordinary values", () => {
    expect(validateServerConfig(server())).toBe(true);
    expect(validateServerConfig(server({ ipmiHost: "" }))).toBe(true);
    expect(validateServerConfig(server({ ipmiHost: "bmc.example.com" }))).toBe(true);
  });

  it("rejects a non-string, which no writer of ours produces", () => {
    expect(validateServerConfig({ ...server(), ipmiHost: 10 })).toBe(false);
    expect(validateServerConfig({ ...server(), ipmiHost: { host: "x" } })).toBe(false);
  });
});

describe("server form — IPMI / BMC Host field", () => {
  it("is offered on the edit form and seeded from the record", () => {
    const field = keyedField(serverFormDefinition({ id: "s1", ipmiHost: "10.0.0.99" }), "ipmiHost");
    expect(field).toBeDefined();
    expect(field?.type).toBe("text");
    expect(field?.label).toBe("IPMI / BMC Host");
    expect(field && "value" in field ? field.value : undefined).toBe("10.0.0.99");
    // Never required — a server without a BMC must still be savable.
    expect(field && "required" in field ? field.required : undefined).toBeFalsy();
  });

  it("is offered on the unified add form too", () => {
    expect(keyedField(unifiedProfileFormDefinition(), "ipmiHost")).toBeDefined();
  });
});
