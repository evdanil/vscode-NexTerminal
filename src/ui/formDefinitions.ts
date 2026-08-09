import type { AuthProfile, AuthProfileOwnedCredentials, LocalShellProfile, SerialProfile, ServerConfig, TunnelProfile, TunnelType } from "../models/config";
import { authProfileOwnedCredentials, resolveTunnelType } from "../models/config";
import type { InventoryConfigField, InventoryProvider, InventorySourceConfig, InventorySourceValues, TemplateRule } from "../models/inventory";
import type { DeviceTemplateProfile } from "../models/deviceTemplate";
import { isCatchAllFilter, templateAppliedFields, type TemplatableField } from "../services/inventory/templateApply";
import { ORPHAN_FOLDER_NAME } from "../services/inventory/syncEngine";
import { formatAuthProfileLabel } from "../utils/authProfileLabel";
import { randomUUID } from "node:crypto";
import type { FormDefinition, FormFieldDescriptor, FormValues, VisibleWhen, VisibleWhenCondition } from "./formTypes";
import { tunnelIllustrationSvgs } from "./tunnelIllustrations";

/** Default placement/wording of the shared Auth Profile select — the profile
 *  and serial/SSH profile forms treat it as a power-user shortcut tucked into
 *  Advanced. The inventory source form overrides both (see
 *  `INVENTORY_SOURCE_AUTH_PROFILE_HINT`): there the profile IS the answer to
 *  "how will these servers authenticate", sibling to a basic field. */
const AUTH_PROFILE_HINT = "Reuse saved SSH credentials instead of entering them here.";

interface AuthProfileSelectOptions {
  /** Defaults to `true` — keep the shared select inside Advanced. */
  advanced?: boolean;
  /** Defaults to `AUTH_PROFILE_HINT`. */
  hint?: string;
  /**
   * Device templates (PR-T1b) — the form key this select submits under. Defaults
   * to `"authProfileId"`. The device-template editor keeps that key (it IS the
   * template's own auth field) but every OTHER caller relies on the default.
   */
  key?: string;
  /**
   * Device templates (PR-T1b) — defaults to `true` (mirror the chosen profile's
   * username/authType/keyPath into the form's own controls and lock them). The
   * template editor sets it `false`: there is NO server SSH form on that editor
   * to mirror INTO, so autofill must be off and no lock/mirror machinery runs.
   */
  autofill?: boolean;
  /** What this render already overwrote with the selected profile's values —
   *  see `applyLinkedAuthProfileValues`. Absent on forms that cannot open with
   *  a profile already selected (the unified Add Profile form), where there is
   *  nothing for a render to have displaced. */
  displacedValues?: Record<string, string>;
  /**
   * P2 (adversarial minor 3) — drop the "Create new auth profile…" sentinel
   * option. The template editor sets this: `openDeviceTemplateEditor` wires NO
   * inline-create handler for its auth select, so offering the sentinel there
   * makes the auth field silently vanish on submit (the sentinel is not a real
   * profile id). Suppressing the option removes the dead capability rather than
   * leaving a dangling one. Every OTHER caller keeps it (defaults to `false`).
   */
  suppressCreate?: boolean;
}

/**
 * REVIEW FINDING (P2) \u2014 the render-time half of the webview's field-ownership
 * tracking (`profileFilledKeys` in formHtml.ts). A form opens with its managed
 * fields already populated \u2014 Edit from the record, Add from
 * `mostCommonUsername` \u2014 so the webview cannot tell from a field's contents
 * whether the linked profile put them there; it has to be told, and only this
 * side knows the profile.
 *
 * Derived from THE ONE RULE (`authProfileOwnedCredentials`, models/config.ts),
 * the same one the connect path and the save path read, so the three can never
 * drift apart again. The runtime mirrors this seed stands in for until the
 * first autofill answers \u2014 `authProfileCredentialMirror` (serverCommands.ts)
 * and `authProfileUsernameMirror` (inventoryCommands.ts) \u2014 send exactly the
 * owned keys, so the webview's own record (`filledKeysFromValues`, which
 * independently drops blanks) rebuilds this same set.
 *
 * `defaultUsername` is the inventory source form's name for the username the
 * profile supplies; the server and unified profile forms call it `username`.
 * Keys a form does not render are skipped by the lock loop, so one list serves
 * every form that renders this select (the same arrangement as its
 * `managedKeys`) \u2014 and the list is emitted in that loop's own order so the
 * two read together.
 */
function authProfileFilledKeys(profile: AuthProfile | undefined): string[] {
  const owned = authProfileOwnedCredentials(profile);
  const keys: string[] = [];
  if (owned.username !== undefined) {
    keys.push("username");
  }
  if (owned.authType !== undefined) {
    keys.push("authType");
  }
  if (owned.keyPath !== undefined) {
    keys.push("keyPath");
  }
  if (owned.username !== undefined) {
    keys.push("defaultUsername");
  }
  return keys;
}

/**
 * REVIEW FINDING (P1) — what a form OPENS showing, for the fields a linked
 * profile owns. The lock seed above says which managed fields the profile
 * fills; this says what it fills them with, and the two must be one decision.
 *
 * THE BUG THIS CLOSES: the seed alone locked `authType` (always owned — a
 * closed enum) while `sshFields` went on rendering the RECORD's own value. A
 * server whose stored `authType` is `password`/`agent`, linked to a `key`
 * profile, therefore opened showing "Password", locked — and the Private Key
 * File control is `visibleWhen: authType === "key"`, so it was hidden AND
 * disabled, and `updateVisibility` disables exactly what the submit loop
 * skips. Saving any unrelated edit submitted no `keyPath` at all;
 * `preserveLinkedServerCredentials` could not put it back because the profile,
 * carrying no key path of its own, does not own that field. The server's own
 * key file was deleted by opening the form and pressing Save, and the next
 * connection — which resolves `authType: "key"` from the profile — failed with
 * `Missing keyPath for key auth`. That configuration is not exotic: it is
 * exactly what the previous Save produces, since the profile owns `authType`
 * and the record therefore keeps whatever it had underneath.
 *
 * So the render now shows what the profile will actually impose
 * (`authProfileOwnedCredentials` — the same rule the connect path spreads and
 * the save path restores), which makes the key path field visible, editable
 * and prefilled, and its value survives Save because it is submitted.
 *
 * WHAT IT DISPLACES IS KEPT, NOT DROPPED. Each overwritten key's original —
 * the value the descriptor would have carried without the profile, defaults
 * included — is returned for the select to hand to the webview, which seeds
 * `profileDisplacedValues` (formHtml.ts) from it. Unlinking then restores the
 * server's own `authType`, `username` and `keyPath` through the mechanism that
 * already handles every mid-session switch, rather than a second one invented
 * here. Without that seed the render's substitution would become permanent:
 * choosing `(None)` would leave the profile's `key` sitting in an unlocked
 * field with nothing behind it to restore, and Save would write it onto the
 * server as its own.
 */
interface LinkedAuthProfileValues {
  /** `fields`, with every key the profile owns showing the PROFILE's value. */
  fields: FormFieldDescriptor[];
  /** For each key overwritten above, what it would otherwise have shown. */
  displaced: Record<string, string>;
}

/** Narrowing lookup into the owned set — `field.key` is a bare string, and
 *  only these keys are ever profile-owned (`AuthProfileOwnedCredentials`).
 *
 *  `defaultUsername` is the inventory source form's name for the username the
 *  profile supplies, exactly as it is in `authProfileFilledKeys` above and in
 *  `updateProfileManagedFields`'s `managedKeys` (formHtml.ts) — one key, three
 *  form-side readers, so a form that locks the field also renders it from the
 *  profile and hands the record's own value to the restore. */
function ownedValueForFieldKey(owned: AuthProfileOwnedCredentials, key: string): string | undefined {
  switch (key) {
    case "username":
    case "defaultUsername":
      return owned.username;
    case "authType":
      return owned.authType;
    case "keyPath":
      return owned.keyPath;
    default:
      return undefined;
  }
}

function applyLinkedAuthProfileValues(
  fields: FormFieldDescriptor[],
  profile: AuthProfile | undefined
): LinkedAuthProfileValues {
  const owned = authProfileOwnedCredentials(profile);
  const displaced: Record<string, string> = {};
  const applied = fields.map((field): FormFieldDescriptor => {
    if (field.type !== "text" && field.type !== "file" && field.type !== "select") {
      return field;
    }
    const value = ownedValueForFieldKey(owned, field.key);
    if (value === undefined) {
      return field;
    }
    if (field.type === "select") {
      // A select with no explicit value renders its first option, which is what
      // the webview would read back out of the control — so that, not "", is
      // what this key held before the profile took it over.
      displaced[field.key] = field.value ?? field.options[0]?.value ?? "";
      return { ...field, value };
    }
    displaced[field.key] = field.value ?? "";
    return { ...field, value };
  });
  return { fields: applied, displaced };
}

function authProfileSelectField(
  authProfiles?: AuthProfile[],
  vw?: VisibleWhen,
  selectedId?: string,
  opts?: AuthProfileSelectOptions
): FormFieldDescriptor {
  const options = [
    { label: "(None)", value: "" },
    ...(authProfiles ?? []).map((p) => ({ label: formatAuthProfileLabel(p), value: p.id })),
    // P2 \u2014 suppressed in the device-template editor, whose auth select has no
    // inline-create handler wired (choosing it would silently drop the field).
    ...(opts?.suppressCreate ? [] : [{ label: "Create new auth profile\u2026", value: "__create__authProfile" }])
  ];
  const selectedProfile = selectedId ? (authProfiles ?? []).find((p) => p.id === selectedId) : undefined;
  const autofill = opts?.autofill ?? true;
  return {
    type: "select",
    key: opts?.key ?? "authProfileId",
    label: "Auth Profile",
    options,
    // Grows with the auth-profile list; type-to-filter with (None)/create
    // pinned (PR-F1). The inline-create round trip survives — the filter input
    // is a distinct node, so addSelectOption still injects before the pinned
    // __create__ option.
    filterable: true,
    value: selectedId ?? "",
    hint: opts?.hint ?? AUTH_PROFILE_HINT,
    advanced: opts?.advanced ?? true,
    // Device templates (PR-T1b) — autofill/lock/mirror is meaningless without a
    // server SSH form to mirror INTO, so the template editor turns it OFF and,
    // with it, the render-time filled-keys/displaced seeds it feeds.
    autofill,
    autofillFilledKeys: autofill ? authProfileFilledKeys(selectedProfile) : undefined,
    autofillDisplacedValues: autofill ? opts?.displacedValues : undefined,
    visibleWhen: vw
  };
}

/**
 * The BMC's OWN credentials — a second link into the same `AuthProfile` store,
 * deliberately NOT the SSH one (`authProfileSelectField`). Two differences carry
 * the whole distinction:
 *
 *   - `autofill` is OFF. The SSH select mirrors the chosen profile's username /
 *     auth type / key path into the form's own controls and locks them; this one
 *     must never touch them, because the BMC account and the SSH account are two
 *     different logins on two different interfaces of the same appliance.
 *   - Only `username` and the stored password are ever read from the profile it
 *     names, so `authType`/`keyPath` are ignored on this link and the hint says
 *     so — a `key` or `agent` profile is accepted and simply supplies a username.
 */
function ipmiAuthProfileSelectField(
  authProfiles?: AuthProfile[],
  selectedId?: string,
  vw?: VisibleWhen
): FormFieldDescriptor {
  return {
    type: "select",
    key: "ipmiAuthProfileId",
    label: "IPMI Auth Profile",
    // Same growth problem and same (None)/__create__ sentinels as the SSH
    // select — filterable (PR-F1).
    filterable: true,
    options: [
      { label: "(None)", value: "" },
      ...(authProfiles ?? []).map((p) => ({ label: formatAuthProfileLabel(p), value: p.id })),
      // C2 — same inline-create escape hatch as the SSH select above, so an empty
      // list is not a dead end. NO `autofill` on this field (see the header), so
      // the created profile is appended and selected without mirroring anything
      // into the SSH controls — the BMC login and the SSH login are separate.
      { label: "Create new auth profile…", value: "__create__authProfile" }
    ],
    value: selectedId ?? "",
    hint:
      "The BMC's own login — separate from the SSH credentials above. Its username fills ${profile.ipmiUsername}, " +
      "and its saved password is handed to ipmitool through the environment (never the command line) by macros you tick " +
      '"Provide IPMI credentials" on, and by Connect BMC Serial Console. Only the username and password are used; ' +
      "the profile's authentication type and key file are ignored here.",
    advanced: true,
    visibleWhen: vw
  };
}

function sshFields(seed?: Partial<ServerConfig>, vw?: VisibleWhen, authProfiles?: AuthProfile[]): FormFieldDescriptor[] {
  return [
    { type: "text", key: "host", label: "Host", required: true, placeholder: "192.168.1.100 or hostname", value: seed?.host, hint: "Hostname or IP address of the SSH server.", visibleWhen: vw },
    { type: "number", key: "port", label: "Port", required: true, min: 1, max: 65535, value: seed?.port ?? 22, visibleWhen: vw },
    { type: "text", key: "username", label: "Username", required: true, placeholder: "root", value: seed?.username, visibleWhen: vw },
    {
      type: "select",
      key: "authType",
      label: "Authentication",
      options: [
        { label: "Password", value: "password" },
        { label: "Private Key", value: "key" },
        { label: "SSH Agent", value: "agent" }
      ],
      value: seed?.authType ?? "password",
      hint: "Choose how Nexus should authenticate to this server.",
      visibleWhen: vw
    },
    { type: "file", key: "keyPath", label: "Private Key File", value: seed?.keyPath, hint: "Private key used when Authentication is Private Key.", visibleWhen: vw ? [...(Array.isArray(vw) ? vw : [vw]), { field: "authType", value: "key" }] : { field: "authType", value: "key" } },
    // Not part of the SSH connection at all — it is the out-of-band address
    // `${profile.ipmiHost}` resolves to when a macro is run against this
    // profile (services/profileTokens.ts). Advanced, because a server that has
    // no BMC should not be asked about one.
    { type: "text", key: "ipmiHost", label: "IPMI / BMC Host", placeholder: "10.0.0.1 or bmc.example.com", value: seed?.ipmiHost, hint: "Optional out-of-band management address — the address only, no https:// or path (e.g. 10.0.0.1, not https://10.0.0.1/). Used by macros through ${profile.ipmiHost}; never used to connect over SSH.", advanced: true, visibleWhen: vw },
    ipmiAuthProfileSelectField(authProfiles, seed?.ipmiAuthProfileId, vw),
    // Two literals, never a free-text scheme: `ipmiHost` is an address (no `/`,
    // no scheme concept — see profileTokens.ts's ADDRESS_CHARSET), so the scheme
    // has to live in its own typed field or not at all.
    {
      type: "select",
      key: "bmcWebProtocol",
      label: "BMC Web Protocol",
      options: [
        { label: "HTTPS (default)", value: "https" },
        { label: "HTTP (insecure)", value: "http" }
      ],
      value: seed?.bmcWebProtocol === "http" ? "http" : "https",
      hint: "Scheme used by Open BMC Web Console. Some older BMCs only serve their web interface over plain HTTP. HTTP sends your BMC login in clear text over the management network — use it only where the BMC offers nothing else.",
      advanced: true,
      visibleWhen: vw
    },
    { type: "checkbox", key: "multiplexing", label: "Enable connection multiplexing", value: seed?.multiplexing ?? true, hint: "Overrides the global multiplexing setting for this server.", advanced: true, visibleWhen: vw },
    { type: "checkbox", key: "legacyAlgorithms", label: "Enable legacy SSH algorithms", value: seed?.legacyAlgorithms ?? false, hint: "Use only for older devices that reject modern SSH algorithms.", advanced: true, visibleWhen: vw }
  ];
}

function openFileExplorerOnFirstConnectField(seed?: Partial<ServerConfig>, vw?: VisibleWhen): FormFieldDescriptor {
  return {
    type: "checkbox",
    key: "openFileExplorerOnFirstConnect",
    label: "Open File Explorer on first connection",
    value: seed?.openFileExplorerOnFirstConnect ?? false,
    hint: "After a normal Connect, opens the File Explorer when it is not already showing this server. Saving this checked disables it on any other SSH profile. Ignored for jump hosts, tunnels, group Connect, and Connect and Run Script.",
    advanced: true,
    visibleWhen: vw
  };
}

function serialFields(seed?: Partial<SerialProfile>, vw?: VisibleWhen): FormFieldDescriptor[] {
  const smartFollowVw = vw ? [...(Array.isArray(vw) ? vw : [vw]), { field: "mode", value: "smartFollow" }] : { field: "mode", value: "smartFollow" };
  return [
    {
      type: "select",
      key: "mode",
      label: "Connection Mode",
      options: [
        { label: "Standard", value: "standard" },
        { label: "Smart Follow", value: "smartFollow" }
      ],
      value: seed?.mode ?? "standard",
      hint: "Smart Follow keeps one serial session attached across Windows COM port renumbering.",
      visibleWhen: vw
    },
    {
      type: "html",
      content: [
        "<div style=\"padding: 12px; border-left: 4px solid var(--vscode-inputValidation-warningBorder, #c08a00); background: var(--vscode-inputValidation-warningBackground, rgba(200, 150, 0, 0.15)); border-radius: 6px; line-height: 1.5;\">",
        "<strong>Smart Follow warning</strong><br>",
        "This mode takes an exclusive serial lock, can auto-switch to a newly detected port, updates the saved preferred port after a successful move, and keeps the terminal waiting for reattach when the device disappears.",
        "</div>"
      ].join(""),
      visibleWhen: smartFollowVw
    },
    { type: "text", key: "path", label: "Port Path", required: true, placeholder: "COM3 or /dev/ttyUSB0", value: seed?.path, scannable: true, hint: "Serial device path such as COM3 or /dev/ttyUSB0.", visibleWhen: vw },
    {
      type: "select",
      key: "baudRate",
      label: "Baud Rate",
      options: [
        { label: "9600", value: "9600" },
        { label: "19200", value: "19200" },
        { label: "38400", value: "38400" },
        { label: "57600", value: "57600" },
        { label: "115200", value: "115200" },
        { label: "230400", value: "230400" },
        { label: "460800", value: "460800" },
        { label: "921600", value: "921600" }
      ],
      value: `${seed?.baudRate ?? 115200}`,
      hint: "Serial speed; 115200 is common for development boards.",
      visibleWhen: vw
    },
    {
      type: "select",
      key: "dataBits",
      label: "Data Bits",
      options: [
        { label: "8", value: "8" },
        { label: "7", value: "7" },
        { label: "6", value: "6" },
        { label: "5", value: "5" }
      ],
      value: `${seed?.dataBits ?? 8}`,
      advanced: true,
      visibleWhen: vw
    },
    {
      type: "select",
      key: "stopBits",
      label: "Stop Bits",
      options: [
        { label: "1", value: "1" },
        { label: "2", value: "2" }
      ],
      value: `${seed?.stopBits ?? 1}`,
      advanced: true,
      visibleWhen: vw
    },
    {
      type: "select",
      key: "parity",
      label: "Parity",
      options: [
        { label: "None", value: "none" },
        { label: "Even", value: "even" },
        { label: "Odd", value: "odd" },
        { label: "Mark", value: "mark" },
        { label: "Space", value: "space" }
      ],
      value: seed?.parity ?? "none",
      advanced: true,
      visibleWhen: vw
    },
    { type: "checkbox", key: "rtscts", label: "Enable RTS/CTS hardware flow control", value: seed?.rtscts ?? false, advanced: true, visibleWhen: vw }
  ];
}

function localShellVisibleWhen(vw: VisibleWhen | undefined, field: string, value: string): VisibleWhen {
  const inner: VisibleWhenCondition = { field, value };
  if (!vw) return inner;
  return [...(Array.isArray(vw) ? vw : [vw]), inner];
}

interface LocalShellFormOptions {
  vscodeTerminalProfileNames?: string[];
}

function localShellFields(
  seed?: Partial<LocalShellProfile>,
  vw?: VisibleWhen,
  options: LocalShellFormOptions = {}
): FormFieldDescriptor[] {
  const launchMode = seed?.launchMode ?? "custom";
  return [
    {
      type: "select",
      key: "launchMode",
      label: "Launch Mode",
      options: [
        { label: "VS Code Profile", value: "vscodeProfile" },
        { label: "Custom Shell", value: "custom" }
      ],
      value: launchMode,
      visibleWhen: vw
    },
    {
      type: "combobox",
      key: "vscodeProfileName",
      label: "VS Code Terminal Profile",
      suggestions: options.vscodeTerminalProfileNames ?? [],
      required: true,
      placeholder: "Select a launchable VS Code terminal profile",
      value: seed?.vscodeProfileName ?? "",
      hint: "Shows explicit-path profiles plus mapped PowerShell, Git Bash, Command Prompt, and WSL profiles when Nexus can resolve their executable.",
      visibleWhen: localShellVisibleWhen(vw, "launchMode", "vscodeProfile")
    },
    {
      type: "text",
      key: "shellPath",
      label: "Shell Path",
      required: true,
      placeholder: "/bin/bash or C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      value: seed?.shellPath ?? "",
      hint: "For WSL on Windows, use wsl.exe and set distro or shell options in Arguments.",
      visibleWhen: localShellVisibleWhen(vw, "launchMode", "custom")
    },
    {
      type: "textarea",
      key: "shellArgs",
      label: "Arguments",
      placeholder: "--login\n-i",
      value: (seed?.shellArgs ?? []).join("\n"),
      rows: 4,
      hint: "Enter one argument per line. For WSL distro selection, use -d on one line and the distro name on the next.",
      visibleWhen: localShellVisibleWhen(vw, "launchMode", "custom")
    },
    {
      type: "text",
      key: "cwd",
      label: "Working Directory",
      placeholder: "${workspaceFolder}/project or ~",
      value: seed?.cwd ?? "",
      hint: "Optional startup directory. Supports ${workspaceFolder}, ${workspaceRoot}, and ~.",
      advanced: true,
      visibleWhen: vw
    },
    {
      type: "textarea",
      key: "startupCommand",
      label: "Startup Command",
      placeholder: "npm run dev",
      value: seed?.startupCommand ?? "",
      rows: 3,
      hint: "Optional text sent to the terminal after it opens.",
      advanced: true,
      visibleWhen: vw
    }
  ];
}

function sharedTrailingFields(
  seed?: { logSession?: boolean; group?: string },
  existingGroups?: string[],
  defaultLogSession = true,
  logSessionVisibleWhen?: VisibleWhen
): FormFieldDescriptor[] {
  return [
    {
      type: "checkbox",
      key: "logSession",
      label: "Log session transcript",
      value: seed?.logSession ?? defaultLogSession,
      advanced: true,
      visibleWhen: logSessionVisibleWhen
    },
    {
      type: "combobox",
      key: "group",
      label: "Folder",
      suggestions: existingGroups ?? [],
      placeholder: "Type a folder path or pick existing...",
      value: seed?.group ?? "",
      hint: "Optional sidebar folder for organizing profiles.",
      advanced: true
    }
  ];
}

export interface ServerListEntry {
  id: string;
  name: string;
}

// Device templates (PR-T1b, UX-M4/m13) — per-server proxy passwords are never
// stored in a template (§5.3: templates carry no SECRETS); a template-set
// socks5/http proxy prompts for its password per-connect. This hint replaces the
// password control the template editor omits, so a user isn't left wondering
// where to type one.
const TEMPLATE_PROXY_PASSWORD_HINT =
  "Proxy passwords aren't stored in templates — each server prompts for its own the first time it connects.";

function proxyFields(
  seed?: Partial<ServerConfig>,
  servers?: ServerListEntry[],
  vw?: VisibleWhen,
  // Device templates (PR-T1b, UX-M4/m13) — defaults to `true` so every existing
  // call site is byte-identical. The template editor passes `false`: the proxy
  // controls ARE the field being templated, so burying them under the Advanced
  // chevron would hide the editor's main content.
  advanced = true,
  // Device templates (PR-T1b, PR #62 Codex round 2, Fix C) — defaults to `true`
  // so the server form and every other caller keep both password controls. The
  // template editor passes `false`: `parseDeviceTemplateFormValues` calls only
  // `formValuesToProxy`, which silently DISCARDS the proxy passwords (§5.3 —
  // templates carry no secrets), so rendering the two password inputs would let a
  // user type a value that Save throws away, then hit an unexpected auth prompt at
  // connect. Omitting them, plus the per-server hint above, states the real model.
  includePasswords = true
): FormFieldDescriptor[] {
  const proxy = seed?.proxy;
  const proxyType = proxy?.type ?? "none";

  const sshJumpVw: VisibleWhenCondition = { field: "proxyType", value: "ssh" };
  const socks5Vw: VisibleWhenCondition = { field: "proxyType", value: "socks5" };
  const httpVw: VisibleWhenCondition = { field: "proxyType", value: "http" };

  // When inside the unified form, compound the proxy visibility with the parent vw
  const compoundVw = (inner: VisibleWhenCondition): VisibleWhen => {
    if (!vw) return inner;
    const conditions = Array.isArray(vw) ? vw : [vw];
    return [...conditions, inner];
  };

  // Server options for jump host picker (exclude self to prevent circular ref)
  const serverOptions = [
    { label: "(Select jump host)", value: "" },
    ...(servers ?? [])
      .filter((s) => s.id !== seed?.id)
      .map((s) => ({ label: s.name, value: s.id }))
  ];

  const jumpHostId = proxy?.type === "ssh" ? proxy.jumpHostId : "";
  const socks5Host = proxy?.type === "socks5" ? proxy.host : "";
  const socks5Port = proxy?.type === "socks5" ? proxy.port : 1080;
  const socks5Username = proxy?.type === "socks5" ? (proxy.username ?? "") : "";
  const httpHost = proxy?.type === "http" ? proxy.host : "";
  const httpPort = proxy?.type === "http" ? proxy.port : 3128;
  const httpUsername = proxy?.type === "http" ? (proxy.username ?? "") : "";

  return [
    {
      type: "select",
      key: "proxyType",
      label: "Proxy",
      options: [
        { label: "None (direct connection)", value: "none" },
        { label: "SSH Jump Host", value: "ssh" },
        { label: "SOCKS5 Proxy", value: "socks5" },
        { label: "HTTP CONNECT Proxy", value: "http" }
      ],
      value: proxyType,
      hint: "Route SSH through a jump host, SOCKS5 proxy, or HTTP CONNECT proxy.",
      advanced,
      visibleWhen: vw
    },
    // SSH Jump Host fields
    {
      type: "select",
      key: "proxyJumpHostId",
      label: "Jump Host Server",
      // The headline fix (PR-F1): lists every server, so it grows with the
      // fleet. Type-to-filter, sorted, with the "(Select jump host)" sentinel
      // (value "") pinned on top.
      filterable: true,
      options: serverOptions,
      value: jumpHostId,
      advanced,
      visibleWhen: compoundVw(sshJumpVw)
    },
    // SOCKS5 fields
    { type: "text", key: "proxySocks5Host", label: "SOCKS5 Proxy Host", required: true, placeholder: "proxy.example.com", value: socks5Host, advanced, visibleWhen: compoundVw(socks5Vw) },
    { type: "number", key: "proxySocks5Port", label: "SOCKS5 Proxy Port", required: true, min: 1, max: 65535, value: socks5Port, advanced, visibleWhen: compoundVw(socks5Vw) },
    { type: "text", key: "proxySocks5Username", label: "SOCKS5 Username", placeholder: "Optional", value: socks5Username, advanced, ...(includePasswords ? {} : { hint: TEMPLATE_PROXY_PASSWORD_HINT }), visibleWhen: compoundVw(socks5Vw) },
    ...(includePasswords
      ? [{ type: "password" as const, key: "proxySocks5Password", label: "SOCKS5 Password", placeholder: "Leave blank to keep existing", advanced, visibleWhen: compoundVw(socks5Vw) }]
      : []),
    // HTTP CONNECT fields
    { type: "text", key: "proxyHttpHost", label: "HTTP Proxy Host", required: true, placeholder: "proxy.example.com", value: httpHost, advanced, visibleWhen: compoundVw(httpVw) },
    { type: "number", key: "proxyHttpPort", label: "HTTP Proxy Port", required: true, min: 1, max: 65535, value: httpPort, advanced, visibleWhen: compoundVw(httpVw) },
    { type: "text", key: "proxyHttpUsername", label: "HTTP Proxy Username", placeholder: "Optional", value: httpUsername, advanced, ...(includePasswords ? {} : { hint: TEMPLATE_PROXY_PASSWORD_HINT }), visibleWhen: compoundVw(httpVw) },
    ...(includePasswords
      ? [{ type: "password" as const, key: "proxyHttpPassword", label: "HTTP Proxy Password", placeholder: "Leave blank to keep existing", advanced, visibleWhen: compoundVw(httpVw) }]
      : [])
  ];
}

// ---------------------------------------------------------------------------
// DEVICE TEMPLATES (issue #48 PR-T1b) — the tri-state template editor (§7.1),
// built entirely on the existing form framework: a per-field mode select gating
// the field's value control(s) via `visibleWhen`, with every quoted string here
// adopted verbatim from §7.1. No new webview machinery.
// ---------------------------------------------------------------------------

/** The five v1 templatable fields, in editor order. */
export type TemplatableFormField = "proxy" | "authProfileId" | "multiplexing" | "legacyAlgorithms" | "logSession";

/** The form key of a field's companion mode select (`mode_proxy`, …). */
export function deviceTemplateModeKey(field: TemplatableFormField): string {
  return `mode_${field}`;
}

// §7.1 mode-select copy, VERBATIM.
const TEMPLATE_MODE_OPTIONS = [
  { label: "Not set", value: "none" },
  { label: "Fill — only where nothing is set", value: "fill" },
  { label: "Override — replace source and sync values", value: "override" }
];
const TEMPLATE_MODE_SHARED_HINT =
  "Fill writes this value only where the field isn't configured yet. Override also replaces values the source or an earlier sync supplied. Neither mode ever changes a value you set yourself — your own edits always win.";
const TEMPLATE_AUTH_MODE_HINT =
  "Fill links this profile only on servers whose SSH login was never configured by hand. Override also moves servers a sync previously linked — but never a link you chose yourself.";
const TEMPLATE_OVERRIDE_PREEMPTION =
  "Values a server already had before any template applied count as hand-configured and are kept. To replace those deliberately, use Apply Device Template to Folder.";
// §7.1 editor intro (UX-M1) — the three invariants, VERBATIM.
const TEMPLATE_EDITOR_INTRO_HTML = [
  '<div style="padding: 12px; border-left: 4px solid var(--vscode-focusBorder, #007acc); background: var(--vscode-textBlockQuote-background, rgba(127,127,127,0.1)); border-radius: 6px; line-height: 1.5;">',
  "A device template applies these settings to servers synced from inventory. Three rules always hold: <strong>your own edits win</strong> — a template never changes a value you set by hand; <strong>clearing a template-applied value opts that server out</strong> — it won't be re-applied; <strong>changes apply on each source's next sync</strong>, not immediately.",
  "</div>"
].join("");

/** The companion mode select for one templatable field. Always visible; its
 *  value gates the field's controls below through `visibleWhen`. */
function templateModeSelect(field: TemplatableFormField, seededMode: string): FormFieldDescriptor {
  return {
    type: "select",
    key: deviceTemplateModeKey(field),
    label: `${field === "authProfileId" ? "Auth Profile" : field === "proxy" ? "Proxy" : field === "multiplexing" ? "Connection multiplexing" : field === "legacyAlgorithms" ? "Legacy SSH algorithms" : "Session Logging"} — Template mode`,
    options: TEMPLATE_MODE_OPTIONS,
    value: seededMode,
    hint: field === "authProfileId" ? TEMPLATE_AUTH_MODE_HINT : TEMPLATE_MODE_SHARED_HINT
  };
}

/** The row-7 pre-emption line (UX-M2), shown only when this field's mode is
 *  `override`. VERBATIM copy. */
function templateOverridePreemption(field: TemplatableFormField): FormFieldDescriptor {
  return {
    type: "html",
    content: `<div style="padding: 8px 12px; opacity: 0.85; line-height: 1.5;">${TEMPLATE_OVERRIDE_PREEMPTION}</div>`,
    visibleWhen: { field: deviceTemplateModeKey(field), value: "override" }
  };
}

/** `visibleWhen` for a field's value control(s): visible when its mode is fill or override. */
function templateValueVisibleWhen(field: TemplatableFormField): VisibleWhen {
  return { field: deviceTemplateModeKey(field), value: ["fill", "override"] };
}

export function deviceTemplateFormDefinition(
  seed?: DeviceTemplateProfile,
  servers?: ServerListEntry[],
  authProfiles?: AuthProfile[]
): FormDefinition {
  const isEdit = Boolean(seed?.id);
  const modeOf = (field: TemplatableFormField): string => seed?.fields[field]?.mode ?? "none";

  const proxyVw = templateValueVisibleWhen("proxy");
  const authVw = templateValueVisibleWhen("authProfileId");
  const mpxVw = templateValueVisibleWhen("multiplexing");
  const legacyVw = templateValueVisibleWhen("legacyAlgorithms");
  const logVw = templateValueVisibleWhen("logSession");

  return {
    title: isEdit ? "Edit Device Template" : "New Device Template",
    // The whole editor is main content — nothing lives behind the Advanced
    // chevron (the proxy controls pass `advanced: false`, m13).
    fields: [
      { type: "html", content: TEMPLATE_EDITOR_INTRO_HTML },
      { type: "text", key: "name", label: "Name", required: true, placeholder: "Branch-office defaults", value: seed?.name },

      // Proxy
      templateModeSelect("proxy", modeOf("proxy")),
      // Fix C (PR #62 Codex round 2) — `includePasswords: false`: §5.3 templates
      // carry no proxy SECRETS, and `parseDeviceTemplateFormValues` discards them,
      // so the password inputs are omitted (a per-server hint replaces them).
      ...proxyFields({ proxy: seed?.fields.proxy?.value }, servers, proxyVw, false, false),
      templateOverridePreemption("proxy"),

      // Auth Profile — autofill OFF (no server SSH form to mirror into, m13).
      templateModeSelect("authProfileId", modeOf("authProfileId")),
      authProfileSelectField(authProfiles, authVw, seed?.fields.authProfileId?.value, {
        advanced: false,
        autofill: false,
        // P2 — no inline-create handler is wired for this select, so drop the
        // "Create new auth profile…" option rather than let it silently vanish
        // the field on submit.
        suppressCreate: true,
        // P8 (UX polish 5) — rung-3 cascade vocabulary leak: nothing in T1b
        // "matches" (catch-all only), so name what actually happens.
        hint: "The saved SSH credentials this template links onto the servers it applies to."
      }),
      templateOverridePreemption("authProfileId"),

      // Connection multiplexing
      templateModeSelect("multiplexing", modeOf("multiplexing")),
      { type: "checkbox", key: "multiplexing", label: "Enable connection multiplexing", value: seed?.fields.multiplexing?.value ?? true, visibleWhen: mpxVw },
      templateOverridePreemption("multiplexing"),

      // Legacy SSH algorithms
      templateModeSelect("legacyAlgorithms", modeOf("legacyAlgorithms")),
      { type: "checkbox", key: "legacyAlgorithms", label: "Enable legacy SSH algorithms", value: seed?.fields.legacyAlgorithms?.value ?? false, visibleWhen: legacyVw },
      templateOverridePreemption("legacyAlgorithms"),

      // Session transcript logging
      templateModeSelect("logSession", modeOf("logSession")),
      { type: "checkbox", key: "logSession", label: "Log session transcript", value: seed?.fields.logSession?.value ?? true, visibleWhen: logVw },
      templateOverridePreemption("logSession")
    ]
  };
}

// §7.3 (UX-S5) — VERBATIM hint appended to a field that is currently
// template-applied on the server being edited.
const TEMPLATE_APPLIED_FIELD_HINT =
  "This value was applied by a device template. Changing it here makes your value permanent — future syncs and template edits will leave it alone.";

/** The Edit Server form key each templatable field's control carries. */
const TEMPLATE_FIELD_FORM_KEY: Record<Exclude<TemplatableField, "authProfileId">, string> = {
  proxy: "proxyType",
  multiplexing: "multiplexing",
  legacyAlgorithms: "legacyAlgorithms",
  logSession: "logSession"
};

/**
 * §7.3 (UX-S5) — appends the template-applied hint to the control(s) of each
 * field the server is CURRENTLY carrying a template value for (`cur === stamp`,
 * derived by `templateAppliedFields`). No lock, no badge — template values are
 * editable by design. A hand-edited or unset field is not in the set, so it is
 * untouched. The hint is appended to whatever hint the field already had.
 */
function withTemplateAppliedHints(seed: Partial<ServerConfig> | undefined, fields: FormFieldDescriptor[]): FormFieldDescriptor[] {
  if (!seed) {
    return fields;
  }
  const applied = new Set(templateAppliedFields(seed));
  if (applied.size === 0) {
    return fields;
  }
  const appliedKeys = new Set<string>();
  for (const field of applied) {
    if (field !== "authProfileId") {
      appliedKeys.add(TEMPLATE_FIELD_FORM_KEY[field]);
    }
  }
  return fields.map((field) => {
    if ("key" in field && appliedKeys.has(field.key)) {
      const existingHint = "hint" in field && field.hint ? `${field.hint} ` : "";
      return { ...field, hint: `${existingHint}${TEMPLATE_APPLIED_FIELD_HINT}` };
    }
    return field;
  });
}

export function serverFormDefinition(
  seed?: Partial<ServerConfig>,
  existingGroups?: string[],
  defaultLogSession = true,
  servers?: ServerListEntry[],
  authProfiles?: AuthProfile[]
): FormDefinition {
  const isEdit = Boolean(seed?.id);
  // Resolved the same way `authProfileSelectField` resolves the selected
  // option, and the same way the save path re-resolves the submitted id: an id
  // that names no profile owns nothing, so the record's own values render
  // unlocked — which is exactly what `preserveLinkedServerCredentials` then
  // keeps for it.
  const linkedProfile = seed?.authProfileId
    ? (authProfiles ?? []).find((profile) => profile.id === seed.authProfileId)
    : undefined;
  const ssh = applyLinkedAuthProfileValues(sshFields(seed, undefined, authProfiles), linkedProfile);

  return {
    title: isEdit ? "Edit SSH Server Profile" : "Add SSH Server Profile",
    fields: withTemplateAppliedHints(seed, [
      { type: "text", key: "name", label: "Name", required: true, placeholder: "My Server", value: seed?.name },
      authProfileSelectField(authProfiles, undefined, seed?.authProfileId, { displacedValues: ssh.displaced }),
      ...ssh.fields,
      ...proxyFields(seed, servers),
      openFileExplorerOnFirstConnectField(seed),
      ...sharedTrailingFields(seed, existingGroups, defaultLogSession)
    ])
  };
}

export interface TunnelFormOptions {
  servers?: Array<{ id: string; name: string; host: string; username: string }>;
  defaultBindAddress?: string;
  networkInterfaces?: Array<{ label: string; value: string }>;
}

function localBindAddressOptions(networkInterfaces?: Array<{ label: string; value: string }>): Array<{ label: string; value: string }> {
  const opts: Array<{ label: string; value: string }> = [
    { label: "127.0.0.1 (localhost)", value: "127.0.0.1" }
  ];
  if (networkInterfaces) {
    for (const iface of networkInterfaces) {
      if (iface.value !== "127.0.0.1" && iface.value !== "0.0.0.0") {
        opts.push(iface);
      }
    }
  }
  opts.push({ label: "0.0.0.0 (all interfaces)", value: "0.0.0.0" });
  return opts;
}

export function tunnelFormDefinition(seed?: Partial<TunnelProfile>, options?: TunnelFormOptions): FormDefinition {
  const isEdit = Boolean(seed?.id);
  const tunnelType: TunnelType = seed ? resolveTunnelType(seed as TunnelProfile) : "local";
  const defaultBindAddress = options?.defaultBindAddress?.trim() || "127.0.0.1";
  const bindOptions = localBindAddressOptions(options?.networkInterfaces);
  const serverOptions = [
    { label: "(Assign later)", value: "" },
    ...(options?.servers ?? []).map((s) => ({ label: s.name, value: s.id })),
    { label: "Create new server…", value: "__create__server" }
  ];

  const localVw = { field: "tunnelType", value: "local" };
  const reverseVw = { field: "tunnelType", value: "reverse" };
  const dynamicVw = { field: "tunnelType", value: "dynamic" };

  return {
    title: isEdit ? "Edit Tunnel" : "Add Tunnel",
    fields: [
      {
        type: "select",
        key: "tunnelType",
        label: "Tunnel Type",
        options: [
          { label: "Local Forward (-L)", value: "local" },
          { label: "Reverse Forward (-R)", value: "reverse" },
          { label: "Dynamic SOCKS5 (-D)", value: "dynamic" }
        ],
        value: tunnelType
      },
      { type: "html", content: tunnelIllustrationSvgs.local, visibleWhen: localVw },
      { type: "html", content: tunnelIllustrationSvgs.reverse, visibleWhen: reverseVw },
      { type: "html", content: tunnelIllustrationSvgs.dynamic, visibleWhen: dynamicVw },
      { type: "text", key: "name", label: "Name", required: true, placeholder: "Database tunnel", value: seed?.name },
      // Local forwarding fields
      { type: "number", key: "localPort", label: "Local Port", required: true, min: 1, max: 65535, placeholder: "5432", value: seed?.localPort, visibleWhen: localVw },
      { type: "select", key: "localBindAddress", label: "Local Bind Address", options: bindOptions, value: seed?.localBindAddress ?? "127.0.0.1", hint: "Network interface for the local listener", visibleWhen: localVw },
      { type: "text", key: "remoteIP", label: "Remote Host", required: true, placeholder: "127.0.0.1", value: seed?.remoteIP ?? "127.0.0.1", visibleWhen: localVw },
      { type: "number", key: "remotePort", label: "Remote Port", required: true, min: 1, max: 65535, placeholder: "5432", value: seed?.remotePort, visibleWhen: localVw },
      // Reverse forwarding fields
      { type: "text", key: "remoteBindAddress", label: "Remote Bind Address", required: true, placeholder: "127.0.0.1", value: seed?.remoteBindAddress ?? defaultBindAddress, hint: "Non-loopback addresses require GatewayPorts clientspecified in sshd_config", visibleWhen: reverseVw },
      { type: "number", key: "remotePort_reverse", label: "Remote Bind Port", required: true, min: 1, max: 65535, placeholder: "8080", value: seed?.remotePort, visibleWhen: reverseVw },
      { type: "text", key: "localTargetIP", label: "Local Target Host", required: true, placeholder: "127.0.0.1", value: seed?.localTargetIP ?? "127.0.0.1", visibleWhen: reverseVw },
      { type: "number", key: "localPort_reverse", label: "Local Target Port", required: true, min: 1, max: 65535, placeholder: "3000", value: seed?.localPort, visibleWhen: reverseVw },
      // Dynamic SOCKS5 fields
      { type: "number", key: "localPort_dynamic", label: "Local Port", required: true, min: 1, max: 65535, placeholder: "1080", value: seed?.localPort ?? 1080, visibleWhen: dynamicVw },
      { type: "select", key: "localBindAddress_dynamic", label: "Local Bind Address", options: bindOptions, value: seed?.localBindAddress ?? "127.0.0.1", hint: "Network interface for the local listener", visibleWhen: dynamicVw },
      // Always visible
      {
        type: "select",
        key: "defaultServerId",
        label: "Server",
        // The tunnel's target-server picker — same server-list growth as the
        // jump-host select, with an "(Assign later)" (value "") and a
        // "Create new server…" (__create__server) sentinel. Filterable (PR-F1).
        filterable: true,
        options: serverOptions,
        value: seed?.defaultServerId ?? ""
      },
      { type: "checkbox", key: "autoStart", label: "Auto-start when server connects", value: seed?.autoStart ?? false },
      { type: "checkbox", key: "autoStop", label: "Auto-stop when server disconnects", value: seed?.autoStop ?? true },
      { type: "text", key: "browserUrl", label: "Browser URL", placeholder: "https://localhost:{localPort}", value: seed?.browserUrl ?? "", hint: "HTTP/HTTPS URL opened by the globe icon. Use {localPort} as placeholder. Leave empty for https://localhost:{localPort}", visibleWhen: localVw },
      { type: "text", key: "notes", label: "Notes", placeholder: "Optional description or notes", value: seed?.notes ?? "" }
    ]
  };
}

export function serialFormDefinition(
  seed?: Partial<SerialProfile>,
  existingGroups?: string[],
  defaultLogSession = true
): FormDefinition {
  const isEdit = Boolean(seed?.id);

    return {
      title: isEdit ? "Edit Serial Profile" : "Add Serial Profile",
    fields: [
      { type: "text", key: "name", label: "Name", required: true, placeholder: "Arduino", value: seed?.name },
      ...serialFields(seed),
      ...sharedTrailingFields(seed, existingGroups, defaultLogSession)
    ]
  };
}

export function localShellFormDefinition(
  seed?: Partial<LocalShellProfile>,
  existingGroups?: string[],
  options?: LocalShellFormOptions
): FormDefinition {
  const isEdit = Boolean(seed?.id);

  return {
    title: isEdit ? "Edit Local Shell Profile" : "Add Local Shell Profile",
    fields: [
      { type: "text", key: "name", label: "Name", required: true, placeholder: "Local Shell Profile", value: seed?.name },
      ...localShellFields(seed, undefined, options),
      ...sharedTrailingFields(seed, existingGroups, false).filter((field) => !("key" in field) || field.key !== "logSession")
    ]
  };
}

export type UnifiedProfileAddMode = "profile" | "ssh" | "serial" | "localShell";

export interface UnifiedProfileSeed {
  profileType?: "ssh" | "serial" | "localShell";
  group?: string;
  addMode?: UnifiedProfileAddMode;
}

function normalizedUnifiedProfileMode(seed?: UnifiedProfileSeed): UnifiedProfileAddMode {
  return seed?.addMode ?? "profile";
}

export function unifiedProfileFormId(seed?: UnifiedProfileSeed): string {
  switch (normalizedUnifiedProfileMode(seed)) {
    case "ssh":
      return "server-add";
    case "serial":
      return "serial-add";
    case "localShell":
      return "local-shell-add";
    case "profile":
      return "profile-add";
  }
}

function unifiedProfileFormTitle(seed?: UnifiedProfileSeed): string {
  switch (normalizedUnifiedProfileMode(seed)) {
    case "ssh":
      return "Add SSH Server Profile";
    case "serial":
      return "Add Serial Profile";
    case "localShell":
      return "Add Local Shell Profile";
    case "profile":
      return "Add Profile";
  }
}

function unifiedProfileTypeValue(seed?: UnifiedProfileSeed): "ssh" | "serial" | "localShell" {
  if (seed?.profileType) {
    return seed.profileType;
  }
  const mode = normalizedUnifiedProfileMode(seed);
  if (mode === "serial") return "serial";
  if (mode === "localShell") return "localShell";
  return "ssh";
}

function unifiedProfileTypeField(seed?: UnifiedProfileSeed): FormFieldDescriptor {
  const value = unifiedProfileTypeValue(seed);
  if (normalizedUnifiedProfileMode(seed) !== "profile") {
    return { type: "hidden", key: "profileType", value };
  }
  return {
    type: "select",
    key: "profileType",
    label: "Profile Type",
    options: [
      { label: "SSH Server Profile", value: "ssh" },
      { label: "Serial Profile", value: "serial" },
      { label: "Local Shell Profile", value: "localShell" }
    ],
    value
  };
}

export function unifiedProfileFormDefinition(
  seed?: UnifiedProfileSeed,
  existingGroups?: string[],
  defaultLogSession = true,
  servers?: ServerListEntry[],
  authProfiles?: AuthProfile[],
  localShellOptions?: LocalShellFormOptions
): FormDefinition {
  const sshVw: VisibleWhenCondition = { field: "profileType", value: "ssh" };
  const serialVw: VisibleWhenCondition = { field: "profileType", value: "serial" };
  const localShellVw: VisibleWhenCondition = { field: "profileType", value: "localShell" };
  const mode = normalizedUnifiedProfileMode(seed);
  const sharedFields = mode === "localShell"
    ? sharedTrailingFields({ group: seed?.group }, existingGroups, defaultLogSession)
      .filter((field) => !("key" in field) || field.key !== "logSession")
    : sharedTrailingFields(
      { group: seed?.group },
      existingGroups,
      defaultLogSession,
      mode === "profile" ? { field: "profileType", value: ["ssh", "serial"] } : undefined
    );

  return {
    title: unifiedProfileFormTitle(seed),
    fields: [
      unifiedProfileTypeField(seed),
      { type: "text", key: "name", label: "Name", required: true, placeholder: "My Server, Console, or Project Shell" },
      authProfileSelectField(authProfiles, sshVw),
      ...sshFields(undefined, sshVw, authProfiles),
      ...proxyFields(undefined, servers, sshVw),
      openFileExplorerOnFirstConnectField(undefined, sshVw),
      ...serialFields(undefined, serialVw),
      ...localShellFields(undefined, localShellVw, localShellOptions),
      ...sharedFields
    ]
  };
}

/**
 * F2 — every provider-declared field's FORM key (never its `field.id`
 * itself — that stays the raw key used in InventorySourceValues/Secrets and
 * the vault) is prefixed so it can never collide with a reserved top-level
 * source field key ("name", "targetFolder", "authProfileId",
 * "defaultUsername", "prunePolicy"). A provider whose configFields include e.g. `{ id: "name" }`
 * previously clobbered whichever of the two — the source's own Name field or
 * the provider's "name" config value — happened to be assigned last into the
 * single flat FormValues object; there was no way for both to coexist.
 * inventoryConfigFieldPrefixedKey is the one shared mapping both this
 * descriptor (writing the form key) and inventoryCommands.ts's
 * formValuesToProviderConfig (reading it back, then writing the VALUE under
 * the unprefixed `field.id` into config/secrets) call, so the two stay in
 * sync by construction rather than by convention.
 */
export function inventoryConfigFieldPrefixedKey(fieldId: string): string {
  return `cfg_${fieldId}`;
}

/**
 * Maps one provider-declared InventoryConfigField to a form field descriptor.
 * `existingSecretFieldIds` (edit mode only) marks which password fields
 * already have a saved vault value: those become optional in the form (blank
 * means "keep the saved value", mirroring the placeholder text) even when the
 * provider itself declares the field required — required-ness for a NEW
 * value only applies when there's nothing saved yet to fall back on.
 */
function inventoryConfigFieldDescriptor(
  field: InventoryConfigField,
  existingConfig: InventorySourceValues,
  existingSecretFieldIds: ReadonlySet<string>
): FormFieldDescriptor {
  const key = inventoryConfigFieldPrefixedKey(field.id);
  if (field.type === "password") {
    const hasSaved = existingSecretFieldIds.has(field.id);
    return {
      type: "password",
      key,
      label: field.label,
      required: field.required && !hasSaved,
      placeholder: hasSaved ? "Leave empty to keep the saved value" : field.placeholder,
      hint: field.description
    };
  }
  if (field.type === "boolean") {
    return {
      type: "checkbox",
      key,
      label: field.label,
      value: existingConfig[field.id] === true,
      hint: field.description
    };
  }
  if (field.type === "number") {
    const existing = existingConfig[field.id];
    return {
      type: "number",
      key,
      label: field.label,
      required: field.required,
      // The provider contract (`InventoryConfigField`) has no integer
      // constraint — providers may store fractional values (e.g. a 0.5-second
      // poll interval). `step: "any"` disables the browser's default
      // step="1" native validation, which otherwise silently blocks Save
      // (including on reopening a source that already has a fractional value
      // saved) with no visible error.
      step: "any",
      placeholder: field.placeholder,
      value: typeof existing === "number" ? existing : undefined,
      hint: field.description
    };
  }
  const existing = existingConfig[field.id];
  return {
    type: "text",
    key,
    label: field.label,
    required: field.required,
    placeholder: field.placeholder,
    value: existing !== undefined ? String(existing) : "",
    hint: field.description
  };
}

/** The source form's "Create new device template…" sentinel (the established
 *  `__create__` convention, §7.1). */
export const DEVICE_TEMPLATE_CREATE_SENTINEL = "__create__deviceTemplate";

// §7.2 rung-1 hint, VERBATIM (no cascade vocabulary).
const DEVICE_TEMPLATE_SOURCE_HINT =
  "Servers synced from this source also receive this device template's settings. Your own per-server edits always win.";

/**
 * §7.2 selectRepresentable guard — the single "Device Template" select can
 * round-trip a rule set losslessly iff it is zero rules, or exactly one CATCH-ALL
 * rule. Deliberately SYNTACTIC (not parse-based, §7.2): empty/whitespace filters
 * canonicalize to catch-all first (`isCatchAllFilter` trims), so `filter: ""` is
 * representable, but any rule carrying a real filter — even a bare `name=*` glob
 * that PARSES to zero conditions — takes the read-only fallback. A filtered rule
 * means the select was never rendered, so writing/clearing the catch-all can
 * never touch it.
 */
export function deviceTemplateSelectRepresentable(rules: readonly TemplateRule[] | undefined): boolean {
  const list = rules ?? [];
  return list.length === 0 || (list.length === 1 && isCatchAllFilter(list[0].filter));
}

/**
 * §7.2 — the source form's "Device Template" control: a single select over the
 * one catch-all rule when the rule set is representable, else a read-only
 * `type: "html"` fallback that submits NO template key (so Save cannot mutate
 * `templateRules`, UX-M3). Fallback copy pluralized on the rule count, VERBATIM.
 *
 * NOTE (PR-T2, U4 de-gate): the fallback names "Edit Template Rules…", now a REAL
 * command (`nexus.deviceTemplate.editRules`, registered in deviceTemplateCommands
 * .ts and on the inventory-source context menu). The T1b "(requires a newer
 * version of Nexus)" qualifier is DROPPED — the command exists, so pointing at it
 * is honest. The string stays doc-adopted (§7.2, kept in sync with the design doc).
 */
function deviceTemplateSourceField(
  deviceTemplates: DeviceTemplateProfile[] | undefined,
  rules: readonly TemplateRule[] | undefined
): FormFieldDescriptor {
  const list = rules ?? [];
  if (!deviceTemplateSelectRepresentable(list)) {
    const content =
      list.length === 1
        ? "A filtered template rule is configured for this source. Manage it with <strong>Edit Template Rules…</strong>."
        : `${list.length} template rules are configured for this source. Manage them with <strong>Edit Template Rules…</strong>.`;
    return {
      type: "html",
      content: `<div style="padding: 12px; border-left: 4px solid var(--vscode-inputValidation-infoBorder, #3794ff); background: var(--vscode-inputValidation-infoBackground, rgba(55,148,255,0.1)); border-radius: 6px; line-height: 1.5;">${content}</div>`
    };
  }
  const catchAll = list.find((r) => isCatchAllFilter(r.filter));
  // Sanitize a dangling reference to `(None)` the same way the auth-profile
  // select does: a catch-all rule whose template no longer resolves would
  // otherwise display "(None)" while submitting a dead id. `removeDeviceTemplate`
  // and the backup import both sweep such rules, so this only ever bites a
  // hand-mangled record.
  const selectedTemplateId =
    catchAll?.templateId !== undefined && (deviceTemplates ?? []).some((t) => t.id === catchAll.templateId)
      ? catchAll.templateId
      : "";
  return {
    type: "select",
    key: "deviceTemplateId",
    label: "Device Template",
    // Grows with the template list — filterable, with (None)/create pinned, same
    // as the auth-profile select.
    filterable: true,
    options: [
      { label: "(None)", value: "" },
      ...(deviceTemplates ?? []).map((t) => ({ label: t.name, value: t.id })),
      { label: "Create new device template…", value: DEVICE_TEMPLATE_CREATE_SENTINEL }
    ],
    value: selectedTemplateId,
    hint: DEVICE_TEMPLATE_SOURCE_HINT
  };
}

/**
 * §7.2 — resolve what `templateRules` should become from a submitted source
 * form. When the "Device Template" select was rendered (rule set representable),
 * the form submits a `deviceTemplateId` key and this returns the new list: `[]`
 * for `(None)`, or exactly ONE catch-all rule (reusing the existing catch-all
 * rule's id if there was one, so a no-op edit doesn't churn the id). When the
 * read-only fallback was shown instead, NO key is submitted, so this returns
 * `undefined` = "leave the existing rules untouched" — the guard that makes it
 * impossible to widen or destroy a filtered rule the select could not represent
 * (UX-M3). The `__create__` sentinel (never actually submitted as a value) and a
 * not-currently-representable rule set both degrade to "leave unchanged". Pure
 * (no `vscode`), so tests exercise it directly. */
export function resolveSubmittedTemplateRules(
  values: FormValues,
  existingRules: readonly TemplateRule[] | undefined
): TemplateRule[] | undefined {
  if (!Object.prototype.hasOwnProperty.call(values, "deviceTemplateId")) {
    return undefined; // the fallback was shown — never touch templateRules
  }
  const existing = existingRules ?? [];
  // Defensive: never rewrite a rule set the select cannot faithfully represent.
  if (!deviceTemplateSelectRepresentable(existing)) {
    return undefined;
  }
  const chosen = typeof values.deviceTemplateId === "string" ? values.deviceTemplateId : "";
  if (chosen === DEVICE_TEMPLATE_CREATE_SENTINEL) {
    return undefined; // a stray sentinel is not a selection — leave rules as they are
  }
  if (chosen === "") {
    return []; // (None) removes the catch-all rule
  }
  const existingCatchAll = existing.find((r) => isCatchAllFilter(r.filter));
  return [{ id: existingCatchAll?.id ?? randomUUID(), templateId: chosen }];
}

/** UX §6, verbatim. Explains both halves of the select in one breath: what a
 *  linked profile does, and what `(None)` leaves in place. */
const INVENTORY_SOURCE_AUTH_PROFILE_HINT =
  "Servers synced from this source connect with this profile's saved credentials. (None) uses the default username with SSH agent authentication.";

/**
 * Add/Edit Inventory Source form. Collection-only — every persistence
 * decision (vault-first secret storage, drift guards, stale-key cleanup,
 * secret hydration for kept values, testConnection plumbing) lives in
 * inventoryCommands.ts's onSubmit/onTest closures, which call the same
 * shared critical-section functions the old sequential-prompt wizard used to
 * call after its last prompt resolved.
 *
 * `defaultUsernameSeed` is only consulted on Add (mostCommonUsername from the
 * caller); Edit always prefills from `seed.defaultUsername`.
 *
 * `authProfiles` populates the Auth Profile select AND decides whether the
 * seeded `authProfileId` still resolves — pass the live snapshot, never a
 * cached list.
 */
export function inventorySourceFormDefinition(
  provider: InventoryProvider,
  seed?: InventorySourceConfig,
  defaultUsernameSeed?: string,
  authProfiles?: AuthProfile[],
  deviceTemplates?: DeviceTemplateProfile[]
): FormDefinition {
  const isEdit = Boolean(seed);
  const existingSecretFieldIds = new Set(seed?.secretFieldIds ?? []);
  const existingConfig = seed?.config ?? {};

  // A seeded id whose profile is gone must seed as `(None)`, not merely LOOK
  // like it. `renderField`'s select case resolves the displayed LABEL by
  // falling back to `options[0]` when nothing matches, but writes
  // `field.value` verbatim into the hidden input — so an unsanitized dangling
  // id displays "(None)" while submitting the dead id, and a plain Save would
  // silently rewrite the source with a reference that resolves nowhere.
  const seededAuthProfileId = seed?.authProfileId;
  const sanitizedAuthProfileId =
    seededAuthProfileId !== undefined && (authProfiles ?? []).some((profile) => profile.id === seededAuthProfileId)
      ? seededAuthProfileId
      : undefined;
  // Resolved from the SAME list the select's options and the sanitizer above
  // are built from, so what the form renders, what it locks and what it offers
  // are one lookup — never a second, later one that could disagree.
  const linkedProfile =
    sanitizedAuthProfileId !== undefined
      ? (authProfiles ?? []).find((profile) => profile.id === sanitizedAuthProfileId)
      : undefined;

  /**
   * REVIEW FINDING (P2) — the source form's copy of the server form's render
   * rule (`applyLinkedAuthProfileValues`): a field the linked profile owns
   * opens showing THE PROFILE's value, not the record's.
   *
   * THE BUG THIS CLOSES: reopening a source whose linked profile's username had
   * been edited since the last save seeded the profile as selected and locked
   * Default SSH Username — while the field still displayed the STORED
   * `defaultUsername`. The lock made that stale value un-editable, and Save
   * derived the stored username from the profile anyway
   * (`fallbackUsernameForSource`, inventoryCommands.ts), so pressing Save with
   * no edit at all silently replaced the source's default username with one the
   * form never displayed. Rendering from the profile makes the field, the lock
   * and the derived value one statement.
   *
   * What it displaces is kept, not dropped: the stored fallback rides back to
   * the webview as the select's `autofillDisplacedValues`, so choosing `(None)`
   * hands it straight back through the same release every mid-session switch
   * uses — see `applyLinkedAuthProfileValues`. Without that seed the render's
   * substitution would be permanent, and an unlink would save the profile's
   * username onto the source as its own.
   *
   * A profile that supplies NO usable username (an imported one whose username
   * is whitespace — THE ONE RULE) owns nothing here, so the field keeps the
   * record's own value, stays unlocked, and seeds no restore: exactly what
   * `authProfileUsernameMirror` answers for it and what
   * `fallbackUsernameForSource` then stores.
   */
  const managed = applyLinkedAuthProfileValues(
    [
      {
        type: "text",
        key: "defaultUsername",
        label: "Default SSH Username",
        required: true,
        value: seed?.defaultUsername ?? defaultUsernameSeed ?? "",
        // Second sentence explains why the field stays VISIBLE but locked once
        // a profile is selected: it is not disabled decoration, it is the
        // value the profile supplied, and the one synced servers fall back
        // to if that profile is ever deleted (silentAuth reads the record's
        // own username once the profile stops resolving).
        hint: "Used when the inventory source doesn't provide a username. With an auth profile selected it comes from that profile, and is the fallback if the profile is ever removed."
      }
    ],
    linkedProfile
  );

  return {
    title: `${isEdit ? "Edit" : "Add"} Inventory Source (${provider.label})`,
    testable: true,
    fields: [
      { type: "text", key: "name", label: "Name", required: true, value: seed?.name ?? provider.label },
      {
        type: "text",
        key: "targetFolder",
        label: "Target Folder",
        placeholder: "e.g. Datacenter/NetBox — leave empty for the top level",
        value: seed?.targetFolder ?? "",
        hint: "Servers synced from this source are placed under this folder. Leave empty for the top level."
      },
      // Directly above Default SSH Username, and NOT advanced: selecting a
      // profile puts its username into that field and locks it
      // (updateProfileManagedFields in formHtml.ts), so the two must read as
      // one decision with the cause above the effect.
      authProfileSelectField(authProfiles, undefined, sanitizedAuthProfileId, {
        advanced: false,
        hint: INVENTORY_SOURCE_AUTH_PROFILE_HINT,
        displacedValues: managed.displaced
      }),
      ...managed.fields,
      // Device Template (PR-T1b, §7.2) — sibling to the Auth Profile select,
      // reading/writing a single catch-all rule in `templateRules`, or a
      // read-only fallback when the rule set is not select-representable.
      deviceTemplateSourceField(deviceTemplates, seed?.templateRules),
      {
        type: "select",
        key: "prunePolicy",
        label: "Removed-Device Policy",
        // NIT — the old sequential-prompt wizard could show the FULL
        // destination path (`${targetFolder}/${ORPHAN_FOLDER_NAME}`) because
        // it prompted for Target Folder and this policy as two separate,
        // ordered steps and could read the just-entered folder back. Here
        // both live as sibling fields in one static form descriptor built
        // once at open time — Target Folder is itself just another field the
        // user can still edit after this descriptor is built, so recomputing
        // "${liveTargetFolder}/${ORPHAN_FOLDER_NAME}" here would either go
        // stale the moment the user retypes Target Folder, or require wiring
        // a live cross-field recompute into the (currently static) option
        // list — disproportionate for a label. Chosen instead: wording that
        // stays true regardless of what Target Folder currently holds.
        options: [
          {
            label: `Move to the source's "${ORPHAN_FOLDER_NAME}" subfolder`,
            value: "orphan",
            description: "Recommended — keeps synced settings if the device returns"
          },
          { label: "Delete", value: "delete", description: "Removes the server and its saved credentials" },
          { label: "Keep", value: "keep", description: "Leaves the server where it is" }
        ],
        value: seed?.prunePolicy ?? "orphan",
        hint: "What should happen when a device disappears from the source."
      },
      ...provider.configFields.map((field) => inventoryConfigFieldDescriptor(field, existingConfig, existingSecretFieldIds))
    ]
  };
}
