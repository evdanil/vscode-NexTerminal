export interface SettingMeta {
  key: string;
  section: string;
  label: string;
  type: "boolean" | "number" | "string" | "enum" | "directory" | "multi-checkbox";
  category: "logging" | "ssh" | "tunnels" | "terminal" | "sftp" | "highlighting";
  description?: string;
  badge?: string;
  enumOptions?: Array<{ label: string; value: string; description?: string }>;
  checkboxOptions?: Array<{ label: string; value: string }>;
  min?: number;
  max?: number;
  unit?: string;
  visibleWhen?: { setting: string; value: unknown };
}

export const SETTINGS_META: SettingMeta[] = [
  // --- Logging ---
  {
    key: "sessionTranscripts",
    section: "nexus.logging",
    label: "Session Transcripts",
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
    description: "Share a single SSH connection per server across terminals, tunnels, and SFTP.",
    badge: "Requires reload"
  },
  {
    key: "idleTimeout",
    section: "nexus.ssh.multiplexing",
    label: "Idle Timeout",
    type: "number",
    category: "ssh",
    description: "Seconds to keep an idle multiplexed connection alive after all channels close.",
    min: 0,
    max: 3600,
    unit: "seconds",
    badge: "Requires reload"
  },
  // --- Tunnels ---
  {
    key: "defaultConnectionMode",
    section: "nexus.tunnel",
    label: "Default Connection Mode",
    type: "enum",
    category: "tunnels",
    enumOptions: [
      { label: "Shared", value: "shared", description: "All clients share a single SSH connection (recommended)" },
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
  // --- Terminal ---
  {
    key: "openLocation",
    section: "nexus.terminal",
    label: "Open Location",
    type: "enum",
    category: "terminal",
    enumOptions: [
      { label: "Panel", value: "panel" },
      { label: "Editor Tab", value: "editor" }
    ]
  },
  {
    key: "keyboardPassthrough",
    section: "nexus.terminal",
    label: "Keyboard Passthrough",
    type: "boolean",
    category: "terminal",
    description: "Pass Ctrl+ key combinations through to the terminal instead of VS Code."
  },
  {
    key: "passthroughKeys",
    section: "nexus.terminal",
    label: "Passthrough Keys",
    type: "multi-checkbox",
    category: "terminal",
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
    label: "Cache TTL",
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
    description: "Auto-refresh interval for the File Explorer (in seconds). Set to 0 to disable. Only polls when the view is visible.",
    min: 0,
    max: 60,
    unit: "seconds"
  },
  // --- Highlighting ---
  {
    key: "enabled",
    section: "nexus.terminal.highlighting",
    label: "Terminal Highlighting",
    type: "boolean",
    category: "highlighting",
    description: "Enable regex-based pattern highlighting in terminal output."
  }
];

export const CATEGORY_ORDER = ["logging", "ssh", "tunnels", "terminal", "sftp", "highlighting"] as const;

export const CATEGORY_LABELS: Record<string, string> = {
  logging: "Logging",
  ssh: "SSH",
  tunnels: "Tunnels",
  terminal: "Terminal",
  sftp: "SFTP / File Explorer",
  highlighting: "Highlighting"
};
