export interface SettingMeta {
  key: string;
  section: string;
  label: string;
  type: "boolean" | "number" | "string" | "enum" | "directory" | "multi-checkbox";
  category:
    | "logging"
    | "ssh"
    | "securityData"
    | "tunnels"
    | "terminal"
    | "ui"
    | "sftp"
    | "serial"
    | "scripts"
    | "networkServers"
    | "tftpServer"
    | "dhcpServer";
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
  {
    key: "terminalOutputTrace",
    section: "nexus.logging",
    label: "Terminal Output Trace",
    type: "boolean",
    category: "logging",
    // Deliberately no badge: every `.setting-badge` in this webview is wired to
    // post `reloadWindow` on click, and this setting takes effect immediately
    // on open sessions.
    description:
      "Troubleshooting only. Writes every chunk of terminal output to the diagnostic log as it arrives — which slows terminal output and stores session data, including anything echoed on screen such as passwords, as plaintext on disk. Leave off unless support asks for it.",
    default: false
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
    category: "securityData",
    subgroup: "Host Trust",
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
      { label: "Panel", value: "panel" },
      { label: "Editor Tab", value: "editor", recommended: true }
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
      { label: "Ctrl+Q", value: "q" },
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
    label: "Max File Size to Hold in Memory",
    type: "number",
    category: "sftp",
    description: "Largest single file Nexus keeps in memory — opening a remote file in the editor, and transferring a file that reports its size as 0. Ordinary transfers stream and are not limited by this.",
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
  // --- SFTP > Sudo (elevated saves) ---
  {
    key: "sudo.enabled",
    section: "nexus.sftp",
    label: "Enable Elevated (sudo) Saves",
    type: "boolean",
    category: "sftp",
    subgroup: "Sudo",
    description: "Offer to save remote files with sudo when the SSH user lacks write permission.",
    default: true
  },
  {
    key: "sudo.rememberPasswordForSession",
    section: "nexus.sftp",
    label: "Remember Sudo Password for Session",
    type: "boolean",
    category: "sftp",
    subgroup: "Sudo",
    description: "Keep the sudo password in memory until that server disconnects or the window closes, rather than clearing it after each save. Never written to disk or to VS Code's secret storage. Turning this off does not guarantee a prompt on every save: the remote host's own sudo credential timestamp (~5 minutes) can skip it regardless, and a short grace window (30 seconds) after you enter a password also covers an immediately-following elevated save on the same server either way.",
    default: false
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
    key: "autoTrigger",
    section: "nexus.terminal.macros",
    label: "Macro Auto-Trigger",
    type: "boolean",
    category: "terminal",
    subgroup: "Macro Auto-Trigger",
    description: "Enable auto-trigger for macros with a trigger pattern. Secret macros default to all terminals for compatibility; use per-macro scope for safer matching.",
    default: true
  },
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
    key: "defaultTimeoutSeconds",
    section: "nexus.scripts",
    label: "Default Wait Timeout",
    type: "number",
    category: "scripts",
    description:
      "Used by waitFor / expect / waitAny when the call site does not pass its own timeout. Override per-script with the @default-timeout JSDoc tag.",
    min: 1,
    max: 2147483,
    unit: "seconds",
    default: 30
  },
  {
    key: "maxRuntimeSeconds",
    section: "nexus.scripts",
    label: "Max Script Runtime",
    type: "number",
    category: "scripts",
    description:
      "Overall cap per run in seconds. Set to 0 to disable. Scripts over the cap stop with reason max-runtime-exceeded.",
    min: 0,
    max: 2147483,
    unit: "seconds",
    default: 1800
  },
  {
    key: "maxReadSizeMb",
    section: "nexus.scripts",
    label: "Max File Read Size",
    type: "number",
    category: "scripts",
    description:
      "Largest file nexus.fs.readText / readJson will read for a script. Bigger files are refused with FileTooLarge. Snapshotted when a run starts — a change does not affect scripts already running.",
    min: 1,
    max: 16,
    unit: "MB",
    default: 4
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
  },
  {
    key: "enabled",
    section: "nexus.settingsGuard",
    label: "Settings Guard",
    type: "boolean",
    category: "terminal",
    description:
      "Automatically restore terminal.integrated.commandsToSkipShell when an external program strips it. Forensic logging stays active even when disabled.",
    default: true
  },
  // --- Network Servers (shared by TFTP and DHCP) ---
  {
    key: "verboseMode",
    section: "nexus.networkServers",
    label: "Verbose Mode",
    type: "boolean",
    category: "networkServers",
    subgroup: "Notifications",
    description:
      "Show a notification for embedded TFTP and DHCP activity: each Start / Stop / Restart, every TFTP transfer that opens, finishes or fails, and every DHCP lease granted or declined. Off by default because a device booting over ZTP fetches one file per notification and a bench full of hardware leases addresses all day. Failed Start / Stop / Restart commands are always reported regardless of this setting, and the Nexus Network Servers output channel records everything either way.",
    default: false
  },
  // --- TFTP Server ---
  {
    key: "tftp.root",
    section: "nexus.networkServers",
    label: "TFTP Root Directory",
    type: "directory",
    category: "tftpServer",
    subgroup: "Network",
    description:
      "Directory served by the embedded TFTP service. Leave empty to use ~/Nexus/tftp-root, which is created on first start (falling back to the system temp directory if it cannot be created). Every file beneath this directory is readable by any host that can reach the bound port — point it at a staging directory, not at a source tree or a home directory."
  },
  {
    key: "tftp.interface",
    section: "nexus.networkServers",
    label: "TFTP Bind Interface",
    type: "string",
    category: "tftpServer",
    subgroup: "Network",
    description:
      "Local IPv4 address to bind the TFTP socket to, i.e. which network interface serves TFTP. Leave empty for 0.0.0.0 (all interfaces). On a multi-homed machine, set this to the lab-facing NIC so the service is not also reachable over the corporate LAN or VPN. This address is also what Auto-Link TFTP advertises to DHCP clients, so binding all interfaces leaves the DHCP boot options unset."
  },
  {
    key: "tftp.port",
    section: "nexus.networkServers",
    label: "TFTP Port",
    type: "number",
    category: "tftpServer",
    subgroup: "Network",
    description:
      "UDP port for the embedded TFTP service. The IANA port 69 is privileged: if binding it is denied (no root/Administrator), the service automatically falls back to 1069 and logs a warning instead of failing. Clients must then be pointed at the fallback port — the port actually in use is shown next to the service.",
    min: 1,
    max: 65535,
    default: 69
  },
  {
    key: "tftp.allowWrite",
    section: "nexus.networkServers",
    label: "Allow TFTP Uploads",
    type: "boolean",
    category: "tftpServer",
    subgroup: "Access",
    description:
      "Accept TFTP write requests (WRQ), letting remote clients upload files into the TFTP root. TFTP has no authentication whatsoever, so anything that can reach the port can overwrite files. Leave disabled unless a device genuinely needs to push configs or crash dumps back.",
    default: false
  },
  // --- DHCP Server ---
  {
    key: "dhcp.interface",
    section: "nexus.networkServers",
    label: "DHCP Bind Interface",
    type: "string",
    category: "dhcpServer",
    subgroup: "Network",
    description:
      "Local IPv4 address to bind the DHCP socket to, i.e. which network interface serves DHCP. Leave empty for 0.0.0.0 (all interfaces) — on a multi-homed machine this is what stops a lab DHCP server from answering DISCOVERs arriving on the corporate LAN. The service always uses the IANA port 67; if binding it is denied, it falls back to 1067 and logs a warning, which normal DHCP clients will not reach."
  },
  {
    key: "dhcp.rangeStart",
    section: "nexus.networkServers",
    label: "Pool Start Address",
    type: "string",
    category: "dhcpServer",
    subgroup: "Address Pool",
    description:
      "First address of the dynamic pool. Leave empty for 192.168.2.10. Must not be higher than the pool end address; static reservations are handed out regardless of this range."
  },
  {
    key: "dhcp.rangeEnd",
    section: "nexus.networkServers",
    label: "Pool End Address",
    type: "string",
    category: "dhcpServer",
    subgroup: "Address Pool",
    description:
      "Last address of the dynamic pool. Leave empty for 192.168.2.199. The pool size this implies drives the utilization figure shown beside the running service."
  },
  {
    key: "dhcp.subnet",
    section: "nexus.networkServers",
    label: "Subnet Mask",
    type: "string",
    category: "dhcpServer",
    subgroup: "Address Pool",
    description:
      "Subnet mask handed to clients (option 1). Leave empty for 255.255.255.0. Its set bits must be contiguous (255.255.254.0 is a mask, 255.0.255.0 is not); together with the gateway it also derives the broadcast address when that is left empty."
  },
  {
    key: "dhcp.gateway",
    section: "nexus.networkServers",
    label: "Default Gateway",
    type: "string",
    category: "dhcpServer",
    subgroup: "Address Pool",
    description: "Default gateway handed to clients (option 3). Leave empty for 192.168.2.1."
  },
  {
    key: "dhcp.leaseTimeSec",
    section: "nexus.networkServers",
    label: "Lease Time",
    type: "number",
    category: "dhcpServer",
    subgroup: "Address Pool",
    description:
      "Lease duration handed to clients (option 51). Values below 60 seconds — shorter leases make clients renew faster than the server can meaningfully track — or above 7 days fall back to the 24-hour default.",
    min: 60,
    max: 604800,
    unit: "seconds",
    default: 86400
  },
  {
    key: "dhcp.serverId",
    section: "nexus.networkServers",
    label: "Server Identifier",
    type: "string",
    category: "dhcpServer",
    subgroup: "Address Pool",
    description:
      "Server identifier advertised to clients (option 54). Leave empty for 192.168.2.1. This should be the address clients see this machine on, otherwise renewals are sent to the wrong host. It is also the value carried in the BOOTP siaddr header field, which devices that ignore option 66 boot from."
  },
  {
    key: "dhcp.broadcast",
    section: "nexus.networkServers",
    label: "Broadcast Address",
    type: "string",
    category: "dhcpServer",
    subgroup: "Address Pool",
    description:
      "Broadcast address handed to clients (option 28). Leave empty to derive it from the gateway and the subnet mask."
  },
  {
    key: "dhcp.bootFileName",
    section: "nexus.networkServers",
    label: "Boot File Name",
    type: "string",
    category: "dhcpServer",
    subgroup: "Boot / ZTP",
    description:
      "Option 67 (bootfile-name) — the file a PXE or ZTP client fetches from the boot server once it has an address, for example ios-image.bin, pxelinux.0 or ztp.py. Leave empty to send no bootfile, in which case a device gets an address and nothing to boot from."
  },
  {
    key: "dhcp.nextServer",
    section: "nexus.networkServers",
    label: "Boot Server (TFTP)",
    type: "string",
    category: "dhcpServer",
    subgroup: "Boot / ZTP",
    description:
      "Option 66 (tftp-server-name) — the boot server IPv4 address clients fetch the boot file from, as a dotted-quad address. Leave empty and Auto-Link TFTP fills it in from the embedded TFTP service's own interface. The BOOTP siaddr header field is not configurable — it always carries the server identifier — so devices that read siaddr instead of option 66 follow that address."
  },
  {
    key: "dhcp.autoLinkTftp",
    section: "nexus.networkServers",
    label: "Auto-Link TFTP",
    type: "boolean",
    category: "dhcpServer",
    subgroup: "Boot / ZTP",
    description:
      "Point DHCP clients at this machine's own TFTP service. When the boot server and the option 150 address list are both empty, options 66 and 150 are filled in from the TFTP bind interface so ZTP works without typing the same address twice. Setting either one by hand turns the link off for both — quietly advertising a second, different boot server under the other option number is how a device boots from the wrong host. If TFTP is bound to all interfaces there is no single address to advertise, and both options are left unset rather than guessed.",
    default: true
  },
  {
    key: "dhcp.vendorClassId",
    section: "nexus.networkServers",
    label: "Vendor Class Identifier Filter",
    type: "string",
    category: "dhcpServer",
    subgroup: "Boot / ZTP",
    description:
      "Option 60 (vendor class identifier) to match on. When set, the boot options (66, 67, 150 and 43) are served only to clients whose DISCOVER carries this exact identifier — everyone else still gets an address from the pool, just no boot information. The match is case-insensitive but otherwise exact, so Cisco will not match Cisco Systems, Inc.; the value each client actually sends is logged in the Nexus Network Servers channel at debug level. Leave empty to serve the boot options to every client."
  }
];

// PER-SOURCE LAB STATUS POLL — there is no "inventory" settings category. Its
// only member was ever `nexus.inventory.statusPollSeconds`, a single global
// cadence for something that belongs to a source: the interval now lives on the
// EVE-NG source's own "Lab Status Poll Interval (seconds)" field, so two lab
// servers can be polled differently, or one not at all. The category went with
// it — the settings TREE renders a row per CATEGORY_ORDER entry regardless of
// whether anything carries that category, so an emptied category is a row that
// opens onto nothing.

export const CATEGORY_ORDER = [
  "logging",
  "ssh",
  "securityData",
  "tunnels",
  "terminal",
  "ui",
  "sftp",
  "serial",
  "scripts",
  "networkServers",
  "tftpServer",
  "dhcpServer"
] as const;

export const CATEGORY_LABELS: Record<string, string> = {
  logging: "Logging",
  ssh: "SSH",
  securityData: "Security & Data",
  tunnels: "Tunnels",
  terminal: "Terminal",
  ui: "Interface",
  sftp: "SFTP / File Explorer",
  serial: "Serial",
  scripts: "Scripts",
  networkServers: "Network Servers",
  tftpServer: "TFTP Server",
  dhcpServer: "DHCP Server"
};

export const CATEGORY_ICONS: Record<string, string> = {
  logging: "output",
  ssh: "remote",
  securityData: "shield",
  tunnels: "plug",
  terminal: "terminal",
  ui: "layout",
  sftp: "folder-opened",
  serial: "circuit-board",
  scripts: "play",
  networkServers: "bell",
  tftpServer: "radio-tower",
  dhcpServer: "broadcast"
};

export const CATEGORY_DESCRIPTIONS: Record<string, string> = {
  logging: "Control session transcripts, log locations, and rotation limits.",
  ssh: "Tune SSH connection sharing, timeouts, keepalives, proxy handshakes, and terminal identity.",
  securityData: "Review host trust, credentials, backups, exports, imports, resets, and data deletion.",
  tunnels: "Set defaults for shared or isolated tunnel connections and bind behavior.",
  terminal: "Choose terminal placement, keyboard passthrough, highlighting, and macro trigger behavior.",
  ui: "Adjust how Nexus connection details are shown in the VS Code views.",
  sftp: "Configure remote file browsing, caching, watching, transfer timeouts, and delete safety limits.",
  serial: "Set serial command timeout behavior.",
  scripts: "Configure script storage, wait timing, runtime limits, and macro behavior during runs.",
  networkServers:
    "Behaviour shared by both embedded network services — how much of what TFTP and DHCP are doing is surfaced as notifications.",
  tftpServer:
    "Configure the embedded TFTP service — served directory, bind interface, port, and upload access.",
  dhcpServer:
    "Configure the embedded DHCP service — bind interface, address pool, lease timing, and boot/ZTP options."
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
