import type { AuthProfile, LocalShellProfile, SerialProfile, ServerConfig, TunnelProfile, TunnelType } from "../models/config";
import { resolveTunnelType } from "../models/config";
import { formatAuthProfileLabel } from "../utils/authProfileLabel";
import type { FormDefinition, FormFieldDescriptor, VisibleWhen, VisibleWhenCondition } from "./formTypes";
import { tunnelIllustrationSvgs } from "./tunnelIllustrations";

function authProfileSelectField(authProfiles?: AuthProfile[], vw?: VisibleWhen, selectedId?: string): FormFieldDescriptor {
  const options = [
    { label: "(None)", value: "" },
    ...(authProfiles ?? []).map((p) => ({ label: formatAuthProfileLabel(p), value: p.id })),
    { label: "Create new auth profile\u2026", value: "__create__authProfile" }
  ];
  return {
    type: "select",
    key: "authProfileId",
    label: "Auth Profile",
    options,
    value: selectedId ?? "",
    hint: "Reuse saved SSH credentials instead of entering them here.",
    advanced: true,
    autofill: true,
    visibleWhen: vw
  };
}

function sshFields(seed?: Partial<ServerConfig>, vw?: VisibleWhen): FormFieldDescriptor[] {
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
    { type: "checkbox", key: "multiplexing", label: "Enable connection multiplexing", value: seed?.multiplexing ?? true, hint: "Overrides the global multiplexing setting for this server.", advanced: true, visibleWhen: vw },
    { type: "checkbox", key: "legacyAlgorithms", label: "Enable legacy SSH algorithms", value: seed?.legacyAlgorithms ?? false, hint: "Use only for older devices that reject modern SSH algorithms.", advanced: true, visibleWhen: vw }
  ];
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
      placeholder: "Select a VS Code terminal profile with a shell path",
      value: seed?.vscodeProfileName ?? "",
      hint: "Only VS Code profiles with an explicit shell path appear here. Use Custom Shell for WSL or source/autodetected profiles.",
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

function proxyFields(
  seed?: Partial<ServerConfig>,
  servers?: ServerListEntry[],
  vw?: VisibleWhen
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
      advanced: true,
      visibleWhen: vw
    },
    // SSH Jump Host fields
    {
      type: "select",
      key: "proxyJumpHostId",
      label: "Jump Host Server",
      options: serverOptions,
      value: jumpHostId,
      advanced: true,
      visibleWhen: compoundVw(sshJumpVw)
    },
    // SOCKS5 fields
    { type: "text", key: "proxySocks5Host", label: "SOCKS5 Proxy Host", required: true, placeholder: "proxy.example.com", value: socks5Host, advanced: true, visibleWhen: compoundVw(socks5Vw) },
    { type: "number", key: "proxySocks5Port", label: "SOCKS5 Proxy Port", required: true, min: 1, max: 65535, value: socks5Port, advanced: true, visibleWhen: compoundVw(socks5Vw) },
    { type: "text", key: "proxySocks5Username", label: "SOCKS5 Username", placeholder: "Optional", value: socks5Username, advanced: true, visibleWhen: compoundVw(socks5Vw) },
    { type: "password", key: "proxySocks5Password", label: "SOCKS5 Password", placeholder: "Leave blank to keep existing", advanced: true, visibleWhen: compoundVw(socks5Vw) },
    // HTTP CONNECT fields
    { type: "text", key: "proxyHttpHost", label: "HTTP Proxy Host", required: true, placeholder: "proxy.example.com", value: httpHost, advanced: true, visibleWhen: compoundVw(httpVw) },
    { type: "number", key: "proxyHttpPort", label: "HTTP Proxy Port", required: true, min: 1, max: 65535, value: httpPort, advanced: true, visibleWhen: compoundVw(httpVw) },
    { type: "text", key: "proxyHttpUsername", label: "HTTP Proxy Username", placeholder: "Optional", value: httpUsername, advanced: true, visibleWhen: compoundVw(httpVw) },
    { type: "password", key: "proxyHttpPassword", label: "HTTP Proxy Password", placeholder: "Leave blank to keep existing", advanced: true, visibleWhen: compoundVw(httpVw) }
  ];
}

export function serverFormDefinition(
  seed?: Partial<ServerConfig>,
  existingGroups?: string[],
  defaultLogSession = true,
  servers?: ServerListEntry[],
  authProfiles?: AuthProfile[]
): FormDefinition {
  const isEdit = Boolean(seed?.id);

  return {
    title: isEdit ? "Edit SSH Server Profile" : "Add SSH Server Profile",
    fields: [
      { type: "text", key: "name", label: "Name", required: true, placeholder: "My Server", value: seed?.name },
      authProfileSelectField(authProfiles, undefined, seed?.authProfileId),
      ...sshFields(seed),
      ...proxyFields(seed, servers),
      ...sharedTrailingFields(seed, existingGroups, defaultLogSession)
    ]
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
    { label: "Create new server...", value: "__create__server" }
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
      ...sshFields(undefined, sshVw),
      ...proxyFields(undefined, servers, sshVw),
      ...serialFields(undefined, serialVw),
      ...localShellFields(undefined, localShellVw, localShellOptions),
      ...sharedFields
    ]
  };
}
