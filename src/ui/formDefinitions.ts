import type { SerialProfile, ServerConfig, TunnelProfile } from "../models/config";
import type { FormDefinition } from "./formTypes";

export function serverFormDefinition(seed?: Partial<ServerConfig>, existingGroups?: string[]): FormDefinition {
  const isEdit = Boolean(seed?.id);

  return {
    title: isEdit ? "Edit Server" : "Add Server",
    fields: [
      { type: "text", key: "name", label: "Name", required: true, placeholder: "My Server", value: seed?.name },
      { type: "text", key: "host", label: "Host", required: true, placeholder: "192.168.1.100 or hostname", value: seed?.host },
      { type: "number", key: "port", label: "Port", required: true, min: 1, max: 65535, value: seed?.port ?? 22 },
      { type: "text", key: "username", label: "Username", required: true, placeholder: "root", value: seed?.username },
      {
        type: "select",
        key: "authType",
        label: "Authentication",
        options: [
          { label: "Password", value: "password" },
          { label: "Private Key", value: "key" },
          { label: "SSH Agent", value: "agent" }
        ],
        value: seed?.authType ?? "password"
      },
      { type: "file", key: "keyPath", label: "Private Key File", value: seed?.keyPath },
      { type: "checkbox", key: "logSession", label: "Log session transcript", value: seed?.logSession ?? true },
      {
        type: "combobox",
        key: "group",
        label: "Group",
        suggestions: existingGroups ?? [],
        placeholder: "Type a new group or pick existing...",
        value: seed?.group ?? ""
      }
    ]
  };
}

export interface TunnelFormOptions {
  servers?: Array<{ id: string; name: string; host: string; username: string }>;
}

export function tunnelFormDefinition(seed?: Partial<TunnelProfile>, options?: TunnelFormOptions): FormDefinition {
  const isEdit = Boolean(seed?.id);
  const serverOptions = [
    { label: "(Assign later)", value: "" },
    ...(options?.servers ?? []).map((s) => ({ label: s.name, value: s.id })),
    { label: "Create new server...", value: "__create__server" }
  ];

  return {
    title: isEdit ? "Edit Tunnel" : "Add Tunnel",
    fields: [
      { type: "text", key: "name", label: "Name", required: true, placeholder: "Database tunnel", value: seed?.name },
      { type: "number", key: "localPort", label: "Local Port", required: true, min: 1, max: 65535, placeholder: "5432", value: seed?.localPort },
      { type: "text", key: "remoteIP", label: "Remote IP", required: true, placeholder: "127.0.0.1", value: seed?.remoteIP ?? "127.0.0.1" },
      { type: "number", key: "remotePort", label: "Remote Port", required: true, min: 1, max: 65535, placeholder: "5432", value: seed?.remotePort },
      {
        type: "select",
        key: "defaultServerId",
        label: "Server",
        options: serverOptions,
        value: seed?.defaultServerId ?? ""
      },
      { type: "checkbox", key: "autoStart", label: "Auto-start when server connects", value: seed?.autoStart ?? false }
    ]
  };
}

export function serialFormDefinition(seed?: Partial<SerialProfile>, existingGroups?: string[]): FormDefinition {
  const isEdit = Boolean(seed?.id);

  return {
    title: isEdit ? "Edit Serial Profile" : "Add Serial Profile",
    fields: [
      { type: "text", key: "name", label: "Name", required: true, placeholder: "Arduino", value: seed?.name },
      { type: "text", key: "path", label: "Port Path", required: true, placeholder: "COM3 or /dev/ttyUSB0", value: seed?.path },
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
        value: `${seed?.baudRate ?? 115200}`
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
        value: `${seed?.dataBits ?? 8}`
      },
      {
        type: "select",
        key: "stopBits",
        label: "Stop Bits",
        options: [
          { label: "1", value: "1" },
          { label: "2", value: "2" }
        ],
        value: `${seed?.stopBits ?? 1}`
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
        value: seed?.parity ?? "none"
      },
      { type: "checkbox", key: "rtscts", label: "Enable RTS/CTS hardware flow control", value: seed?.rtscts ?? false },
      { type: "checkbox", key: "logSession", label: "Log session transcript", value: seed?.logSession ?? true },
      {
        type: "combobox",
        key: "group",
        label: "Group",
        suggestions: existingGroups ?? [],
        placeholder: "Type a new group or pick existing...",
        value: seed?.group ?? ""
      }
    ]
  };
}
