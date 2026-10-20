import {
  InventoryProviderError,
  type InventoryConfigField,
  type InventoryOperationContext,
  type InventoryProvider,
  type InventorySourceSecrets,
  type InventorySourceValues
} from "../../../models/inventory";
import type { ContainerlabRuntime } from "../containerlabRuntimeContracts";
import { containerlabDefaultRoute, parseContainerlabConfig } from "./containerlabConfig";
import { parseContainerlabInspection } from "./containerlabParser";

export const CONTAINERLAB_STATUS_POLL_FIELD_ID = "statusPollSeconds";
export const CONTAINERLAB_STATUS_POLL_MIN_SECONDS = 0;
export const CONTAINERLAB_STATUS_POLL_MAX_SECONDS = 3600;

export function readContainerlabStatusPollSeconds(config: InventorySourceValues): number {
  const raw = config[CONTAINERLAB_STATUS_POLL_FIELD_ID];
  if (typeof raw !== "number" || !Number.isFinite(raw)) return CONTAINERLAB_STATUS_POLL_MIN_SECONDS;
  return Math.floor(Math.min(Math.max(raw, CONTAINERLAB_STATUS_POLL_MIN_SECONDS), CONTAINERLAB_STATUS_POLL_MAX_SECONDS));
}

const CONFIG_FIELDS: InventoryConfigField[] = [
  {
    id: "location", label: "Discovery Location", type: "select", required: true,
    options: [{ label: "Local Extension Host", value: "local" }, { label: "Remote SSH", value: "ssh" }]
  },
  {
    id: "labHostId", label: "Lab Host SSH Profile", type: "ssh-profile", advanced: true,
    description: "Required for remote discovery. This route also becomes the automatic SSH route for discovered devices; Direct device routing does not change where discovery runs."
  },
  {
    id: "runner", label: "CLI Runner", type: "select", required: true,
    options: [
      { label: "Host Binary", value: "host" },
      { label: "Disposable Docker Image", value: "disposable" },
      { label: "Existing Docker Container", value: "existing" }
    ]
  },
  { id: "containerlabExecutable", label: "Containerlab Executable", type: "string", placeholder: "containerlab" },
  { id: "dockerExecutable", label: "Docker Executable", type: "string", placeholder: "docker" },
  { id: "runnerImage", label: "Installed Runner Image", type: "string", advanced: true },
  {
    id: "runnerContainer",
    label: "Existing Runner Container",
    type: "string",
    description: "Enter an exact container name or its full 64-character Docker ID; abbreviated IDs are not accepted.",
    advanced: true
  },
  { id: "dockerSocket", label: "Docker Socket", type: "string", placeholder: "/var/run/docker.sock", advanced: true },
  { id: "sudo", label: "Use Noninteractive Sudo", type: "boolean", advanced: true },
  {
    id: "deviceConnection", label: "Device Connection", type: "select",
    options: [{ label: "Automatic", value: "automatic" }, { label: "Direct", value: "direct" }]
  },
  { id: "labFilter", label: "Lab Filter", type: "string", advanced: true },
  {
    id: CONTAINERLAB_STATUS_POLL_FIELD_ID,
    label: "Lab Status Poll Interval (seconds)",
    type: "number",
    min: CONTAINERLAB_STATUS_POLL_MIN_SECONDS,
    max: CONTAINERLAB_STATUS_POLL_MAX_SECONDS,
    integer: true,
    placeholder: "0",
    description: "Set to 0 to keep background status polling off. A poll uses only already-approved, noninteractive discovery."
  },
  {
    id: "addressPreference", label: "Address Preference", type: "select",
    options: [{ label: "IPv4 First", value: "ipv4" }, { label: "IPv6 First", value: "ipv6" }]
  }
];

function unavailable(): InventoryProviderError {
  return new InventoryProviderError(
    "protocol",
    "Containerlab discovery requires desktop VS Code with the Containerlab runtime. Open this source in desktop VS Code, then run Test or Sync."
  );
}

export function createContainerlabProvider(runtime?: ContainerlabRuntime): InventoryProvider {
  const inspect = async (values: InventorySourceValues, context?: InventoryOperationContext) => {
    if (!runtime) throw unavailable();
    const config = parseContainerlabConfig(values);
    const result = await runtime.inspect(config, context);
    return parseContainerlabInspection(result, config);
  };

  return {
    id: "containerlab",
    label: "Containerlab",
    configFields: CONFIG_FIELDS.map((field) => ({
      ...field,
      ...(field.options ? { options: field.options.map((option) => ({ ...option })) } : {})
    })),
    attributeKeys: ["lab", "kind", "image", "nodeName", "name"],
    sourceDefaultRoute: (values) => containerlabDefaultRoute(parseContainerlabConfig(values)),
    discoverySshHostId: (values) => {
      const config = parseContainerlabConfig(values);
      return config.location === "ssh" ? config.labHostId : undefined;
    },
    async testConnection(config, _secrets, context) {
      await inspect(config, context);
    },
    async fetchInventory(config, _secrets, context) {
      return inspect(config, context);
    },
    async fetchStatus(config, _secrets, context) {
      const tree = await inspect(config, context);
      if (!tree.status) {
        throw new InventoryProviderError("protocol", "Containerlab inspection did not produce node status.");
      }
      return tree.status;
    }
  };
}
