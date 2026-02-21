import type { SerialProfile, ServerConfig, TunnelProfile, TunnelType } from "../models/config";
import { resolveTunnelType } from "../models/config";
import type { FormDefinition, FormFieldDescriptor, VisibleWhen } from "./formTypes";

function sshFields(seed?: Partial<ServerConfig>, vw?: VisibleWhen): FormFieldDescriptor[] {
  return [
    { type: "text", key: "host", label: "Host", required: true, placeholder: "192.168.1.100 or hostname", value: seed?.host, visibleWhen: vw },
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
      visibleWhen: vw
    },
    { type: "file", key: "keyPath", label: "Private Key File", value: seed?.keyPath, visibleWhen: vw }
  ];
}

function serialFields(seed?: Partial<SerialProfile>, vw?: VisibleWhen): FormFieldDescriptor[] {
  return [
    { type: "text", key: "path", label: "Port Path", required: true, placeholder: "COM3 or /dev/ttyUSB0", value: seed?.path, scannable: true, visibleWhen: vw },
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
      visibleWhen: vw
    },
    { type: "checkbox", key: "rtscts", label: "Enable RTS/CTS hardware flow control", value: seed?.rtscts ?? false, visibleWhen: vw }
  ];
}

function sharedTrailingFields(
  seed?: { logSession?: boolean; group?: string },
  existingGroups?: string[],
  defaultLogSession = true
): FormFieldDescriptor[] {
  return [
    { type: "checkbox", key: "logSession", label: "Log session transcript", value: seed?.logSession ?? defaultLogSession },
    {
      type: "combobox",
      key: "group",
      label: "Folder",
      suggestions: existingGroups ?? [],
      placeholder: "Type a folder path or pick existing...",
      value: seed?.group ?? ""
    }
  ];
}

export function serverFormDefinition(
  seed?: Partial<ServerConfig>,
  existingGroups?: string[],
  defaultLogSession = true
): FormDefinition {
  const isEdit = Boolean(seed?.id);

  return {
    title: isEdit ? "Edit Server" : "Add Server",
    fields: [
      { type: "text", key: "name", label: "Name", required: true, placeholder: "My Server", value: seed?.name },
      ...sshFields(seed),
      ...sharedTrailingFields(seed, existingGroups, defaultLogSession)
    ]
  };
}

export interface TunnelFormOptions {
  servers?: Array<{ id: string; name: string; host: string; username: string }>;
  defaultBindAddress?: string;
}

export function tunnelFormDefinition(seed?: Partial<TunnelProfile>, options?: TunnelFormOptions): FormDefinition {
  const isEdit = Boolean(seed?.id);
  const tunnelType: TunnelType = seed ? resolveTunnelType(seed as TunnelProfile) : "local";
  const defaultBindAddress = options?.defaultBindAddress?.trim() || "127.0.0.1";
  const serverOptions = [
    { label: "(Assign later)", value: "" },
    ...(options?.servers ?? []).map((s) => ({ label: s.name, value: s.id })),
    { label: "Create new server...", value: "__create__server" }
  ];

  const localVw = { field: "tunnelType", value: "local" };
  const reverseVw = { field: "tunnelType", value: "reverse" };
  const dynamicVw = { field: "tunnelType", value: "dynamic" };
  const localOrDynamicVw = { field: "tunnelType", value: "local" };

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
      { type: "text", key: "name", label: "Name", required: true, placeholder: "Database tunnel", value: seed?.name },
      // Local forwarding fields
      { type: "number", key: "localPort", label: "Local Port", required: true, min: 1, max: 65535, placeholder: "5432", value: seed?.localPort, visibleWhen: localVw },
      { type: "text", key: "remoteIP", label: "Remote Host", required: true, placeholder: "127.0.0.1", value: seed?.remoteIP ?? "127.0.0.1", visibleWhen: localVw },
      { type: "number", key: "remotePort", label: "Remote Port", required: true, min: 1, max: 65535, placeholder: "5432", value: seed?.remotePort, visibleWhen: localVw },
      // Reverse forwarding fields
      { type: "text", key: "remoteBindAddress", label: "Remote Bind Address", required: true, placeholder: "127.0.0.1", value: seed?.remoteBindAddress ?? defaultBindAddress, hint: "Non-loopback addresses require GatewayPorts clientspecified in sshd_config", visibleWhen: reverseVw },
      { type: "number", key: "remotePort_reverse", label: "Remote Bind Port", required: true, min: 1, max: 65535, placeholder: "8080", value: seed?.remotePort, visibleWhen: reverseVw },
      { type: "text", key: "localTargetIP", label: "Local Target Host", required: true, placeholder: "127.0.0.1", value: seed?.localTargetIP ?? "127.0.0.1", visibleWhen: reverseVw },
      { type: "number", key: "localPort_reverse", label: "Local Target Port", required: true, min: 1, max: 65535, placeholder: "3000", value: seed?.localPort, visibleWhen: reverseVw },
      // Dynamic SOCKS5 fields
      { type: "number", key: "localPort_dynamic", label: "Local Port", required: true, min: 1, max: 65535, placeholder: "1080", value: seed?.localPort ?? 1080, visibleWhen: dynamicVw },
      // Always visible
      {
        type: "select",
        key: "defaultServerId",
        label: "Server",
        options: serverOptions,
        value: seed?.defaultServerId ?? ""
      },
      { type: "checkbox", key: "autoStart", label: "Auto-start when server connects", value: seed?.autoStart ?? false },
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

export interface UnifiedProfileSeed {
  profileType?: "ssh" | "serial";
  group?: string;
}

export function unifiedProfileFormDefinition(
  seed?: UnifiedProfileSeed,
  existingGroups?: string[],
  defaultLogSession = true
): FormDefinition {
  const sshVw = { field: "profileType", value: "ssh" };
  const serialVw = { field: "profileType", value: "serial" };

  return {
    title: "Add Profile",
    fields: [
      {
        type: "select",
        key: "profileType",
        label: "Profile Type",
        options: [
          { label: "SSH Server", value: "ssh" },
          { label: "Serial Port", value: "serial" }
        ],
        value: seed?.profileType ?? "ssh"
      },
      { type: "text", key: "name", label: "Name", required: true, placeholder: "My Server or Arduino" },
      ...sshFields(undefined, sshVw),
      ...serialFields(undefined, serialVw),
      ...sharedTrailingFields({ group: seed?.group }, existingGroups, defaultLogSession)
    ]
  };
}
