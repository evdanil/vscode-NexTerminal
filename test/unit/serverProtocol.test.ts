import { describe, expect, it, vi } from "vitest";

// `serverCommands` reaches for the host API at import time; the pure save-path
// helper under test here needs none of it.
vi.mock("vscode", () => ({
  commands: { registerCommand: vi.fn(() => ({ dispose: vi.fn() })), executeCommand: vi.fn() },
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
  workspace: { getConfiguration: vi.fn(() => ({ get: vi.fn(() => true) })) },
  Uri: { file: (path: string) => ({ fsPath: path, scheme: "file" }) },
  ProgressLocation: { Notification: 15 },
  TerminalLocation: { Editor: 2, Panel: 1 },
  TreeItem: class {
    public constructor(
      public readonly label: string,
      public readonly collapsibleState?: number
    ) {}
  },
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
  ThemeIcon: class {
    public constructor(public readonly id: string) {}
  },
  ThemeColor: class {
    public constructor(public readonly id: string) {}
  },
  EventEmitter: class {
    public readonly event = vi.fn();
    public fire = vi.fn();
  }
}));

import {
  mergeServerConfigFields,
  resolveServerProtocol,
  serverConfigsEqual
} from "../../src/models/config";
import type { ServerConfig } from "../../src/models/config";
import { isValidServerOrigin, validateServerConfig } from "../../src/utils/validation";
import { serverFormDefinition, unifiedProfileFormDefinition } from "../../src/ui/formDefinitions";
import { formValuesToServer } from "../../src/commands/serverCommands";
import type { FormDefinition, FormFieldDescriptor, VisibleWhenCondition } from "../../src/ui/formTypes";

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

function conditions(field: FormFieldDescriptor | undefined): VisibleWhenCondition[] {
  const vw = field?.visibleWhen;
  if (!vw) return [];
  return Array.isArray(vw) ? vw : [vw];
}

/** Is this field gated on `protocol === "ssh"`? */
function isSshOnly(field: FormFieldDescriptor | undefined): boolean {
  return conditions(field).some((c) => c.field === "protocol" && c.value === "ssh");
}

describe("resolveServerProtocol", () => {
  // ⊘ A reader that trusts `server.protocol` verbatim lets a hand-edited backup
  // choose a third protocol string; one that resolves absent to anything but
  // "ssh" changes the behaviour of every record written before this field.
  it("resolves absent to ssh — the compatibility default", () => {
    expect(resolveServerProtocol(server())).toBe("ssh");
    expect(resolveServerProtocol(server({ protocol: "ssh" }))).toBe("ssh");
  });

  it("resolves telnet only when it is spelled exactly", () => {
    expect(resolveServerProtocol(server({ protocol: "telnet" }))).toBe("telnet");
    expect(resolveServerProtocol({ protocol: "TELNET" } as unknown as ServerConfig)).toBe("ssh");
    expect(resolveServerProtocol({ protocol: "rdp" } as unknown as ServerConfig)).toBe("ssh");
    expect(resolveServerProtocol({ protocol: 7 } as unknown as ServerConfig)).toBe("ssh");
  });
});

describe("ServerConfig.protocol — field-enumeration sites", () => {
  // ⊘ Constructed so protocol is the ONLY difference: with anything else
  // differing, a comparator that skips the new field still answers false and
  // the fixture would prove nothing.
  it("two servers differing ONLY in protocol are not equal", () => {
    expect(serverConfigsEqual(server({ protocol: "telnet" }), server())).toBe(false);
    expect(serverConfigsEqual(server({ protocol: "telnet" }), server({ protocol: "ssh" }))).toBe(false);
    expect(serverConfigsEqual(server({ protocol: "telnet" }), server({ protocol: "telnet" }))).toBe(true);
    expect(serverConfigsEqual(server(), server())).toBe(true);
  });

  it("the rollback merge keeps a concurrently-written protocol instead of reverting it", () => {
    // protocol is the ONLY field separating batchSnapshot from current, so a
    // merge that does not compare it reverts the user's switch to `prior`'s.
    const prior = server({ protocol: undefined });
    const batchSnapshot = server({ name: "renamed", protocol: undefined });
    const current = server({ name: "renamed", protocol: "telnet" });

    expect(mergeServerConfigFields(prior, batchSnapshot, current).protocol).toBe("telnet");
  });

  it("the rollback merge discards the rejected batch's protocol when nothing else touched it", () => {
    const prior = server({ protocol: "telnet" });
    const batchSnapshot = server({ protocol: "ssh" });
    const current = server({ protocol: "ssh" });

    expect(mergeServerConfigFields(prior, batchSnapshot, current).protocol).toBe("telnet");
  });
});

describe("validateServerConfig — protocol", () => {
  it("accepts absent and both literals", () => {
    expect(validateServerConfig(server())).toBe(true);
    expect(validateServerConfig(server({ protocol: "ssh" }))).toBe(true);
    expect(validateServerConfig(server({ protocol: "telnet", username: "" }))).toBe(true);
  });

  // ⊘ A tolerant TYPE check (the `bmcWebProtocol` disposition) passes every row
  // here; the spec calls for the closed-enum disposition `SerialProfile.mode`
  // uses, so a value outside the two literals fails the record.
  it("rejects a present-but-invalid value", () => {
    expect(validateServerConfig({ ...server(), protocol: "TELNET" })).toBe(false);
    expect(validateServerConfig({ ...server(), protocol: "rdp" })).toBe(false);
    expect(validateServerConfig({ ...server(), protocol: "" })).toBe(false);
    expect(validateServerConfig({ ...server(), protocol: 7 })).toBe(false);
    expect(validateServerConfig({ ...server(), protocol: null })).toBe(false);
  });

  // ⊘ A guard that keeps requiring a non-empty username drops every telnet
  // record at the storage boundary — telnet has no protocol-level login, so the
  // form never collects one and the field is legitimately blank.
  it("accepts a blank username on a telnet server but not on an SSH one", () => {
    expect(validateServerConfig(server({ protocol: "telnet", username: "" }))).toBe(true);
    expect(validateServerConfig(server({ protocol: "ssh", username: "" }))).toBe(false);
    expect(validateServerConfig(server({ username: "" }))).toBe(false);
  });

  // ⊘ MAJOR-2 (review) — ABSENT, not merely blank. An inventory sync writes
  // `endpoint.username ?? source.defaultUsername`, which is `undefined` for a
  // telnet console whose device names no username and whose source has no
  // default. A guard demanding `typeof === "string"` rejected the sync's OWN
  // output, and `VscodeConfigRepository.getServers` drops a rejected row with
  // only a console warning — so the server synced in, worked, and silently
  // disappeared on reload, on every re-sync forever.
  it("accepts a telnet server with no username member at all", () => {
    const { username: _dropped, ...withoutUsername } = server({ protocol: "telnet" });
    expect(validateServerConfig(withoutUsername)).toBe(true);
    // Scoped to the transport with no login — SSH still requires one.
    const { username: _alsoDropped, ...sshWithoutUsername } = server();
    expect(validateServerConfig(sshWithoutUsername)).toBe(false);
  });

  it("still rejects a non-string username on a telnet server", () => {
    expect(validateServerConfig({ ...server({ protocol: "telnet" }), username: 42 })).toBe(false);
    expect(validateServerConfig({ ...server({ protocol: "telnet" }), username: null })).toBe(false);
  });
});

describe("formValuesToServer — protocol", () => {
  const base = { name: "lab-sw", host: "10.0.0.9", port: 23 };

  // ⊘ Storing `"ssh"` explicitly puts a member on every server record that no
  // build before this one understands; absent already means ssh.
  it("stores nothing for ssh and the literal for telnet", () => {
    expect(formValuesToServer({ ...base, username: "admin" })?.protocol).toBeUndefined();
    expect(formValuesToServer({ ...base, username: "admin", protocol: "ssh" })?.protocol).toBeUndefined();
    expect(formValuesToServer({ ...base, protocol: "telnet" })?.protocol).toBe("telnet");
  });

  it("ignores an unrecognised protocol value rather than storing it", () => {
    expect(formValuesToServer({ ...base, username: "admin", protocol: "rdp" })?.protocol).toBeUndefined();
  });

  // ⊘ The form DISABLES the username control for a telnet server, so the
  // submission carries no username at all. A save path that still requires one
  // rejects every telnet server with nothing on screen to say why.
  it("accepts a telnet submission with no username and stores a blank one", () => {
    const saved = formValuesToServer({ ...base, protocol: "telnet" });
    expect(saved).toBeDefined();
    expect(saved?.username).toBe("");
    expect(saved?.host).toBe("10.0.0.9");
    expect(saved?.port).toBe(23);
  });

  it("still requires a username for an SSH server", () => {
    expect(formValuesToServer({ ...base })).toBeUndefined();
    expect(formValuesToServer({ ...base, protocol: "ssh" })).toBeUndefined();
  });

  it("still requires name and host for a telnet server", () => {
    expect(formValuesToServer({ host: "10.0.0.9", protocol: "telnet" })).toBeUndefined();
    expect(formValuesToServer({ name: "lab-sw", protocol: "telnet" })).toBeUndefined();
  });
});

describe("server form — Protocol field", () => {
  it("offers a Protocol select defaulting to SSH", () => {
    const field = keyedField(serverFormDefinition(), "protocol");
    expect(field).toBeDefined();
    expect(field?.type).toBe("select");
    expect(field && "options" in field ? field.options.map((o) => o.value) : []).toEqual(["ssh", "telnet"]);
    expect(field && "value" in field ? field.value : undefined).toBe("ssh");
  });

  it("seeds the select from the record on an edit", () => {
    const field = keyedField(serverFormDefinition({ id: "s1", protocol: "telnet" }), "protocol");
    expect(field && "value" in field ? field.value : undefined).toBe("telnet");
  });

  // ⊘ Ungated auth controls ask a telnet server for credentials nothing will
  // ever use, and — because `username` is `required` — make a telnet-only device
  // impossible to save without inventing one.
  it("gates every SSH-only control on protocol === ssh", () => {
    const definition = serverFormDefinition({ id: "s1" });
    for (const key of [
      "username",
      "authType",
      "keyPath",
      "authProfileId",
      "altHost",
      "multiplexing",
      "legacyAlgorithms",
      "openFileExplorerOnFirstConnect",
      "proxyType"
    ]) {
      expect(isSshOnly(keyedField(definition, key)), `${key} must be gated on protocol === ssh`).toBe(true);
    }
  });

  it("leaves protocol-independent fields ungated", () => {
    const definition = serverFormDefinition({ id: "s1" });
    for (const key of ["name", "host", "port", "protocol", "group"]) {
      expect(isSshOnly(keyedField(definition, key)), `${key} must not be gated`).toBe(false);
    }
  });

  it("keeps the keyPath control gated on BOTH protocol and authType", () => {
    const field = keyedField(serverFormDefinition({ id: "s1" }), "keyPath");
    expect(conditions(field)).toEqual(
      expect.arrayContaining([
        { field: "protocol", value: "ssh" },
        { field: "authType", value: "key" }
      ])
    );
  });
});

describe("unified add form — Protocol field", () => {
  it("offers the Protocol select inside the SSH branch", () => {
    const field = keyedField(unifiedProfileFormDefinition(), "protocol");
    expect(field).toBeDefined();
    expect(conditions(field)).toEqual([{ field: "profileType", value: "ssh" }]);
  });

  // ⊘ Compounding only the protocol condition (dropping the parent
  // `profileType` one) would show SSH credential fields while the Serial branch
  // is selected.
  it("compounds the protocol gate with the profile-type gate", () => {
    const field = keyedField(unifiedProfileFormDefinition(), "username");
    expect(conditions(field)).toEqual(
      expect.arrayContaining([
        { field: "profileType", value: "ssh" },
        { field: "protocol", value: "ssh" }
      ])
    );
  });
});

describe("isValidServerOrigin — syncedProtocol stamp", () => {
  const valid = { sourceId: "src-1", externalId: "device:1", syncedAt: 1 };

  // ⊘ A guard that skipped the new member lets a hand-edited backup carry a
  // third value into `syncOwnsProtocol`, where it resolves to "ssh" on one side
  // of the comparison and to itself on the other.
  it("accepts absent and both literals, rejects anything else", () => {
    expect(isValidServerOrigin(valid)).toBe(true);
    expect(isValidServerOrigin({ ...valid, syncedProtocol: "telnet" })).toBe(true);
    expect(isValidServerOrigin({ ...valid, syncedProtocol: "ssh" })).toBe(true);
    expect(isValidServerOrigin({ ...valid, syncedProtocol: "TELNET" })).toBe(false);
    expect(isValidServerOrigin({ ...valid, syncedProtocol: "" })).toBe(false);
    expect(isValidServerOrigin({ ...valid, syncedProtocol: 1 })).toBe(false);
  });
});

/**
 * MAJOR-3 (review) — a telnet server must never be offered as an SSH jump host
 * or an IPMI gateway. Both are id references the SSH connect path dereferences
 * and then authenticates against: choosing one used to read the vault, prompt
 * for a password for the telnet server, and finally fail with a raw ssh2
 * handshake error against port 23.
 */
describe("server form — telnet servers are not selectable as SSH infrastructure", () => {
  const servers = [
    { id: "srv-ssh", name: "bastion" },
    { id: "srv-tel", name: "eve-console", protocol: "telnet" as const },
    { id: "srv-self", name: "me" }
  ];

  function optionValues(definition: FormDefinition, key: string): string[] {
    const field = keyedField(definition, key);
    return field && "options" in field ? field.options.map((o) => o.value) : [];
  }

  // ⊘ A filter that only excludes self (`s.id !== seed?.id`) lists the telnet
  // server here; the fixture keeps an ordinary SSH server in the list so a
  // filter that dropped EVERYTHING would fail too.
  it("omits telnet servers from the Jump Host picker", () => {
    const values = optionValues(serverFormDefinition({ id: "srv-self" }, undefined, true, servers), "proxyJumpHostId");
    expect(values).toContain("srv-ssh");
    expect(values).not.toContain("srv-tel");
    expect(values).not.toContain("srv-self");
  });

  it("omits telnet servers from the IPMI Gateway picker", () => {
    const values = optionValues(serverFormDefinition({ id: "srv-self" }, undefined, true, servers), "ipmiGatewayServerId");
    expect(values).toContain("srv-ssh");
    expect(values).not.toContain("srv-tel");
  });

  it("omits telnet servers from the unified add form's pickers too", () => {
    const definition = unifiedProfileFormDefinition(undefined, undefined, true, servers);
    expect(optionValues(definition, "proxyJumpHostId")).not.toContain("srv-tel");
    expect(optionValues(definition, "ipmiGatewayServerId")).not.toContain("srv-tel");
  });
});
