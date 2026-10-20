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

const CONFIG_FIELDS: InventoryConfigField[] = [
  {
    id: "location", label: "Discovery Location", type: "select", required: true,
    options: [{ label: "Local Extension Host", value: "local" }, { label: "Remote SSH", value: "ssh" }]
  },
  { id: "labHostId", label: "Lab Host SSH Profile", type: "ssh-profile", advanced: true },
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
  { id: "runnerContainer", label: "Existing Runner Container", type: "string", advanced: true },
  { id: "dockerSocket", label: "Docker Socket", type: "string", placeholder: "/var/run/docker.sock", advanced: true },
  { id: "sudo", label: "Use Noninteractive Sudo", type: "boolean", advanced: true },
  {
    id: "deviceConnection", label: "Device Connection", type: "select",
    options: [{ label: "Automatic", value: "automatic" }, { label: "Direct", value: "direct" }]
  },
  { id: "labFilter", label: "Lab Filter", type: "string", advanced: true },
  {
    id: "addressPreference", label: "Address Preference", type: "select",
    options: [{ label: "IPv4 First", value: "ipv4" }, { label: "IPv6 First", value: "ipv6" }]
  }
];

function unavailable(): InventoryProviderError {
  return new InventoryProviderError("protocol", "Containerlab execution runtime is unavailable in this provider instance.");
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
