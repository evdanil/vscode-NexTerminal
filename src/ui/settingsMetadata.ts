export interface SettingMeta {
  key: string;
  section: string;
  label: string;
  type: "boolean" | "number" | "string" | "enum" | "directory" | "multi-checkbox";
  category: "logging" | "ssh" | "tunnels" | "terminal" | "ui" | "sftp" | "serial" | "scripts";
  description?: string;
  badge?: string;
  badgeClass?: string;
  default?: number | string | boolean;
  enumOptions?: Array<{ label: string; value: string; description?: string; recommended?: boolean }>;
  checkboxOptions?: Array<{ label: string; value: string }>;
  min?: number;
  max?: number;
  unit?: string;
  subgroup?: string;
  visibleWhen?: { setting: string; value: unknown };
}

export const SETTINGS_META: SettingMeta[] = [
  // --- Logging ---
  {
    key: "sessionTranscripts",
    section: "nexus.logging",
    label: "Session Logging",
    type: "boolean",
    category: "logging",
    description: "Log session transcripts for SSH and serial connections by default."
  },
  {
    key: "sessionLogDirectory",
    section: "nexus.logging",
    label: "Session Log Directory",
    type: "directory",
    category: "logging",
    description: "Leave empty to use the default extension storage location."
  },
  {
    key: "maxFileSizeMb",
    section: "nexus.logging",
    label: "Max Log File Size",
    type: "number",
    category: "logging",
    min: 1,
    max: 1024,
    unit: "MB"
  },
  {
    key: "maxRotatedFiles",
    section: "nexus.logging",
    label: "Max Rotated Files",
    type: "number",
    category: "logging",
    min: 0,
    max: 99
  },
  // --- SSH ---
  {
    key: "enabled",
    section: "nexus.ssh.multiplexing",
    label: "Connection Multiplexing",
    type: "boolean",
    category: "ssh",
    subgroup: "Connection",
    description: "Share a single SSH connection per server across terminals, tunnels, and SFTP.",
    badge: "Requires reload"
  },
  {
    key: "idleTimeout",
    section: "nexus.ssh.multiplexing",
    label: "Multiplexing Idle Timeout",
    type: "number",
    category: "ssh",
    subgroup: "Connection",
    description: "Seconds to keep an idle multiplexed connection alive after all channels close.",
    min: 0,
    max: 3600,
    unit: "seconds",
    badge: "Requires reload"
  },
  {
    key: "trustNewHosts",
    section: "nexus.ssh",
    label: "Trust New Hosts",
    type: "boolean",
    category: "ssh",
    subgroup: "Security",
    description: "Trust-On-First-Use: auto-accept host keys on first connection. Only prompt when a key changes (possible MITM)."
  },
  // --- SSH > Advanced ---
  {
    key: "connectionTimeout",
    section: "nexus.ssh",
    label: "Connection Timeout",
    type: "number",
    category: "ssh",
    subgroup: "Advanced",
    description: "SSH connection timeout. Increase for slow or high-latency networks.",
    min: 5,
    max: 300,
    unit: "seconds",
    default: 60
  },
  {
    key: "keepaliveInterval",
    section: "nexus.ssh",
    label: "Keepalive Interval",
    type: "number",
    category: "ssh",
    subgroup: "Advanced",
    description: "Interval between SSH keepalive packets. Set to 0 to disable.",
    min: 0,
    max: 300,
    unit: "seconds",
    default: 10
  },
  {
    key: "keepaliveCountMax",
    section: "nexus.ssh",
    label: "Missed Keepalive Limit",
    type: "number",
    category: "ssh",
    subgroup: "Advanced",
    description: "Number of missed keepalive responses before the connection is considered dead.",
    min: 1,
    max: 30,
    default: 3
  },
  {
    key: "terminalType",
    section: "nexus.ssh",
    label: "Terminal Type",
    type: "enum",
    category: "ssh",
    subgroup: "Advanced",
    enumOptions: [
      { label: "xterm-256color", value: "xterm-256color", description: "Full 256-color xterm emulation", recommended: true },
      { label: "xterm", value: "xterm", description: "Standard xterm emulation" },
      { label: "vt100", value: "vt100", description: "DEC VT100 terminal" },
      { label: "vt220", value: "vt220", description: "DEC VT220 terminal" },
      { label: "dumb", value: "dumb", description: "Minimal terminal" }
    ]
  },
  {
    key: "proxyTimeout",
    section: "nexus.ssh",
    label: "Proxy Handshake Timeout",
    type: "number",
    category: "ssh",
    subgroup: "Advanced",
    description: "Timeout for proxy handshake (SOCKS5 or HTTP CONNECT).",
    min: 5,
    max: 300,
    unit: "seconds",
    default: 60
  },
  // --- Tunnels ---
  {
    key: "defaultConnectionMode",
    section: "nexus.tunnel",
    label: "Default Connection Mode",
    type: "enum",
    category: "tunnels",
    enumOptions: [
      { label: "Shared", value: "shared", description: "All clients share a single SSH connection", recommended: true },
      { label: "Isolated", value: "isolated", description: "Each TCP client gets its own SSH connection" }
    ]
  },
  {
    key: "defaultBindAddress",
    section: "nexus.tunnel",
    label: "Default Bind Address",
    type: "string",
    category: "tunnels",
    description: "Default bind address for reverse tunnels. Use 127.0.0.1 for local-only or 0.0.0.0 for all interfaces (requires GatewayPorts on server)."
  },
  // --- Tunnels > Advanced ---
  {
    key: "socks5HandshakeTimeout",
    section: "nexus.tunnel",
    label: "SOCKS5 Handshake Timeout",
    type: "number",
    category: "tunnels",
    subgroup: "Advanced",
    description: "Timeout for the SOCKS5 proxy handshake on dynamic tunnels.",
    min: 2,
    max: 60,
    unit: "seconds",
    default: 10
  },
  // --- Terminal ---
  {
    key: "openLocation",
    section: "nexus.terminal",
    label: "Open Location",
    type: "enum",
    category: "terminal",
    subgroup: "General",
    enumOptions: [
      { label: "Panel", value: "panel", recommended: true },
      { label: "Editor Tab", value: "editor" }
    ]
  },
  // --- UI ---
  {
    key: "showTreeDescriptions",
    section: "nexus.ui",
    label: "Show Tree Descriptions",
    type: "boolean",
    category: "ui",
    description: "Show connection details (user@host) next to device names in the Connectivity Hub."
  },
  {
    key: "keyboardPassthrough",
    section: "nexus.terminal",
    label: "Keyboard Passthrough",
    type: "boolean",
    category: "terminal",
    subgroup: "Keyboard",
    description: "Pass Ctrl+ key combinations through to the terminal instead of VS Code."
  },
  {
    key: "passthroughKeys",
    section: "nexus.terminal",
    label: "Passthrough Keys",
    type: "multi-checkbox",
    category: "terminal",
    subgroup: "Keyboard",
    checkboxOptions: [
      { label: "Ctrl+B", value: "b" },
      { label: "Ctrl+E", value: "e" },
      { label: "Ctrl+G", value: "g" },
      { label: "Ctrl+J", value: "j" },
      { label: "Ctrl+K", value: "k" },
      { label: "Ctrl+N", value: "n" },
      { label: "Ctrl+O", value: "o" },
      { label: "Ctrl+P", value: "p" },
      { label: "Ctrl+R", value: "r" },
      { label: "Ctrl+W", value: "w" }
    ],
    visibleWhen: { setting: "nexus.terminal.keyboardPassthrough", value: true }
  },
  // --- SFTP ---
  {
    key: "cacheTtlSeconds",
    section: "nexus.sftp",
    label: "Directory Cache Duration",
    type: "number",
    category: "sftp",
    description: "How long directory listings are cached before being re-fetched from the server.",
    min: 0,
    max: 300,
    unit: "seconds"
  },
  {
    key: "maxCacheEntries",
    section: "nexus.sftp",
    label: "Max Cache Entries",
    type: "number",
    category: "sftp",
    description: "Maximum number of directory listings kept in the SFTP cache.",
    min: 10,
    max: 5000
  },
  {
    key: "autoRefreshInterval",
    section: "nexus.sftp",
    label: "Auto-Refresh Interval",
    type: "number",
    category: "sftp",
    description: "Polling interval for the File Explorer (in seconds). Used for polling mode and as a safety-net refresh cadence in auto mode unless recursive inotify watching is available.",
    min: 0,
    max: 60,
    unit: "seconds"
  },
  {
    key: "remoteWatchMode",
    section: "nexus.sftp",
    label: "Remote Watch Mode",
    type: "enum",
    category: "sftp",
    description: "Choose how the File Explorer tracks remote changes. Auto prefers recursive inotify watching and otherwise keeps polling available as the safety net.",
    enumOptions: [
      { label: "Auto", value: "auto", description: "Prefer recursive inotify watching when the server supports it.", recommended: true },
      { label: "Polling", value: "polling", description: "Disable remote watch probes and refresh using only the polling interval." }
    ]
  },
  {
    key: "maxOpenFileSizeMB",
    section: "nexus.sftp",
    label: "Max File Size to Open",
    type: "number",
    category: "sftp",
    description: "Maximum file size (in MB) that can be opened in the editor. Larger files can still be downloaded via right-click.",
    min: 1,
    max: 200,
    unit: "MB"
  },
  // --- SFTP > Advanced ---
  {
    key: "operationTimeout",
    section: "nexus.sftp",
    label: "Operation Timeout",
    type: "number",
    category: "sftp",
    subgroup: "Advanced",
    description: "Timeout for SFTP directory and metadata operations (listing, stat, realpath, rename, mkdir, delete). Prevents explorer stalls on congested connections.",
    min: 5,
    max: 300,
    unit: "seconds",
    default: 30
  },
  {
    key: "commandTimeout",
    section: "nexus.sftp",
    label: "Command / Transfer Timeout",
    type: "number",
    category: "sftp",
    subgroup: "Advanced",
    description: "Timeout for remote SFTP commands, file transfers, and editor file open/save streams. Upload/download use it as an inactivity timeout, so long transfers can continue while progress is still flowing.",
    min: 10,
    max: 3600,
    unit: "seconds",
    default: 300
  },
  {
    key: "deleteDepthLimit",
    section: "nexus.sftp",
    label: "Delete Depth Limit",
    type: "number",
    category: "sftp",
    subgroup: "Advanced",
    description: "Maximum directory nesting depth for recursive delete operations.",
    min: 10,
    max: 500,
    unit: "levels",
    default: 100,
    badge: "Safety limit",
    badgeClass: "setting-badge-safety"
  },
  {
    key: "deleteOperationLimit",
    section: "nexus.sftp",
    label: "Delete Operation Limit",
    type: "number",
    category: "sftp",
    subgroup: "Advanced",
    description: "Maximum number of files and directories in a single recursive delete.",
    min: 100,
    max: 100000,
    default: 10000,
    badge: "Safety limit",
    badgeClass: "setting-badge-safety"
  },
  // --- Highlighting ---
  {
    key: "enabled",
    section: "nexus.terminal.highlighting",
    label: "Terminal Highlighting",
    type: "boolean",
    category: "terminal",
    subgroup: "Highlighting",
    description: "Enable regex-based pattern highlighting in terminal output."
  },
  // --- Terminal > Macro Auto-Trigger ---
  {
    key: "defaultCooldown",
    section: "nexus.terminal.macros",
    label: "Default Trigger Cooldown",
    type: "number",
    category: "terminal",
    subgroup: "Macro Auto-Trigger",
    description: "Default cooldown between auto-trigger firings on the same terminal. Individual macros can override this.",
    min: 0,
    max: 300,
    unit: "seconds",
    default: 3
  },
  {
    key: "bufferLength",
    section: "nexus.terminal.macros",
    label: "Prompt Buffer Size",
    type: "number",
    category: "terminal",
    subgroup: "Macro Auto-Trigger",
    description: "Maximum characters kept in the auto-trigger prompt buffer per terminal.",
    min: 256,
    max: 16384,
    unit: "characters",
    default: 2048
  },
  // --- Serial ---
  {
    key: "rpcTimeout",
    section: "nexus.serial",
    label: "Command Timeout",
    type: "number",
    category: "serial",
    description: "Timeout for commands sent to the serial port sidecar process.",
    min: 2,
    max: 60,
    unit: "seconds",
    default: 10
  },
  // --- Scripts ---
  {
    key: "path",
    section: "nexus.scripts",
    label: "Scripts Folder",
    type: "directory",
    category: "scripts",
    description:
      "Directory for your .js scripts. Absolute paths are used as-is. A relative path is resolved against the workspace root when a folder is open; otherwise scripts live in Nexus's extension storage. Leave empty for the default.",
    default: ".nexus/scripts"
  },
  {
    key: "defaultTimeout",
    section: "nexus.scripts",
    label: "Default Wait Timeout",
    type: "number",
    category: "scripts",
    description:
      "Used by waitFor / expect / waitAny when the call site does not pass its own timeout. Override per-script with the @default-timeout JSDoc tag.",
    min: 100,
    unit: "ms",
    default: 30000
  },
  {
    key: "maxRuntimeMs",
    section: "nexus.scripts",
    label: "Max Script Runtime",
    type: "number",
    category: "scripts",
    description:
      "Overall cap per run. Set to 0 to disable. Scripts over the cap stop with reason max-runtime-exceeded.",
    min: 0,
    unit: "ms",
    default: 1800000
  },
  {
    key: "macroPolicy",
    section: "nexus.scripts",
    label: "Macro Behaviour During Runs",
    type: "enum",
    category: "scripts",
    description:
      "How macro auto-triggers on the bound session behave while a script is running. Applies to new runs only — in-flight scripts keep the policy they started with.",
    enumOptions: [
      {
        label: "Suspend all macros",
        value: "suspend-all",
        description: "Block every macro trigger on this session for the run. The safe default.",
        recommended: true
      },
      {
        label: "Keep macros enabled",
        value: "keep-enabled",
        description: "Let every macro keep firing. Use with care — macros can race with script sends."
      }
    ],
    default: "suspend-all"
  }
];

export const CATEGORY_ORDER = ["logging", "ssh", "tunnels", "terminal", "ui", "sftp", "serial", "scripts"] as const;

export const CATEGORY_LABELS: Record<string, string> = {
  logging: "Logging",
  ssh: "SSH",
  tunnels: "Tunnels",
  terminal: "Terminal",
  ui: "Interface",
  sftp: "SFTP / File Explorer",
  serial: "Serial",
  scripts: "Scripts"
};

export const CATEGORY_ICONS: Record<string, string> = {
  logging: "output",
  ssh: "remote",
  tunnels: "plug",
  terminal: "terminal",
  ui: "layout",
  sftp: "folder-opened",
  serial: "circuit-board",
  scripts: "play"
};

export function formatSettingValueForTree(meta: SettingMeta, rawValue: unknown): string {
  switch (meta.type) {
    case "boolean":
      return rawValue ? "ON" : "OFF";
    case "number": {
      const num = typeof rawValue === "number" ? rawValue : (meta.min ?? 0);
      return meta.unit ? `${num} ${meta.unit}` : String(num);
    }
    case "directory":
      return typeof rawValue === "string" && rawValue.length > 0 ? rawValue : "(default)";
    case "string":
      return typeof rawValue === "string" && rawValue.length > 0 ? rawValue : "(default)";
    case "enum": {
      const val = typeof rawValue === "string" ? rawValue : (meta.enumOptions?.[0]?.value ?? "");
      const opt = meta.enumOptions?.find((o) => o.value === val);
      const label = opt?.label ?? val;
      return opt?.recommended ? `${label} \u2713` : label;
    }
    case "multi-checkbox": {
      const arr = Array.isArray(rawValue) ? rawValue : [];
      const total = meta.checkboxOptions?.length ?? 0;
      return `${arr.length} of ${total}`;
    }
  }
}
