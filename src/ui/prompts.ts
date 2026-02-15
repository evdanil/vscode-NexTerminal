import { randomUUID } from "node:crypto";
import * as vscode from "vscode";
import type {
  AuthType,
  SerialDataBits,
  SerialParity,
  SerialProfile,
  SerialStopBits,
  ServerConfig,
  TunnelConnectionMode,
  TunnelProfile
} from "../models/config";

interface PromptModeOptions {
  mode?: "add" | "edit";
}

function stepTitle(title: string, step: number, totalSteps: number): string {
  return `${title} (${step}/${totalSteps})`;
}

async function requiredInput(title: string, prompt: string, value = "", password = false): Promise<string | undefined> {
  const result = await vscode.window.showInputBox({
    title,
    prompt,
    value,
    ignoreFocusOut: true,
    password,
    validateInput: (input) => (input.trim() ? undefined : "Value is required")
  });
  if (!result) {
    return undefined;
  }
  return result.trim();
}

async function numberInput(title: string, prompt: string, value: number, min?: number, max?: number): Promise<number | undefined> {
  const result = await requiredInput(title, prompt, `${value}`);
  if (!result) {
    return undefined;
  }
  const parsed = Number(result);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    vscode.window.showErrorMessage("Expected a positive integer");
    return undefined;
  }
  if (min !== undefined && max !== undefined && (parsed < min || parsed > max)) {
    vscode.window.showErrorMessage(`Must be a number between ${min} and ${max}`);
    return undefined;
  }
  return parsed;
}

type Choice<T extends string> = {
  label: string;
  value: T;
  description?: string;
};

async function pickChoice<T extends string>(
  title: string,
  choices: Array<Choice<T>>,
  defaultValue?: T
): Promise<T | undefined> {
  const pick = await vscode.window.showQuickPick(
    choices.map((choice) => ({
      ...choice,
      picked: choice.value === defaultValue
    })),
    { title, canPickMany: false }
  );
  return (pick as Choice<T> | undefined)?.value;
}

async function pickOrCreateGroup(title: string, existingGroups?: string[], current?: string): Promise<string | undefined> {
  if (!existingGroups || existingGroups.length === 0) {
    return vscode.window.showInputBox({
      title,
      prompt: "Group (optional)",
      value: current ?? "",
      ignoreFocusOut: true
    });
  }
  const items = [
    { label: "(No group)", value: "" },
    ...existingGroups.map((g) => ({ label: g, value: g, picked: g === current })),
    { label: "Create new...", value: "__create__", picked: false }
  ];
  const pick = await vscode.window.showQuickPick(items, { title, canPickMany: false });
  if (!pick) {
    return undefined;
  }
  if (pick.value === "__create__") {
    return vscode.window.showInputBox({
      title,
      prompt: "New group name",
      value: "",
      ignoreFocusOut: true
    });
  }
  return pick.value;
}

export async function promptServerConfig(
  seed?: Partial<ServerConfig>,
  options?: PromptModeOptions & { existingGroups?: string[] }
): Promise<ServerConfig | undefined> {
  const mode = options?.mode ?? (seed?.id ? "edit" : "add");
  const base = mode === "edit" ? "Edit Nexus Server" : "Add Nexus Server";
  const total = 8;

  const name = await requiredInput(stepTitle(base, 1, total), "Display name", seed?.name ?? "");
  if (!name) {
    return undefined;
  }
  const host = await requiredInput(stepTitle(base, 2, total), "Hostname or IP", seed?.host ?? "");
  if (!host) {
    return undefined;
  }
  const port = await numberInput(stepTitle(base, 3, total), "SSH Port", seed?.port ?? 22, 1, 65535);
  if (!port) {
    return undefined;
  }
  const username = await requiredInput(stepTitle(base, 4, total), "SSH Username", seed?.username ?? "");
  if (!username) {
    return undefined;
  }
  const authTypePick = await pickChoice<AuthType>(
    stepTitle(base, 5, total),
    [
      { label: "Password", value: "password" },
      { label: "Private Key", value: "key" },
      { label: "Agent", value: "agent" }
    ],
    seed?.authType
  );
  if (!authTypePick) {
    return undefined;
  }
  let keyPath: string | undefined;
  if (authTypePick === "key") {
    const homeDir = require("node:os").homedir();
    const uris = await vscode.window.showOpenDialog({
      canSelectFiles: true,
      canSelectMany: false,
      title: stepTitle(base, 6, total) + " — Select SSH Private Key",
      defaultUri: vscode.Uri.file(homeDir + "/.ssh/"),
      openLabel: "Select Key",
      filters: { "All Files": ["*"] }
    });
    keyPath = uris?.[0]?.fsPath ?? seed?.keyPath;
    if (!keyPath) {
      return undefined;
    }
  }
  const group = await pickOrCreateGroup(stepTitle(base, 7, total), options?.existingGroups, seed?.group);
  const hiddenPick = await pickChoice<"No" | "Yes">(
    stepTitle(base, 8, total) + " — Hide from main server list (jump host)?",
    [
      { label: "No", value: "No" },
      { label: "Yes", value: "Yes" }
    ],
    seed?.isHidden ? "Yes" : "No"
  );
  if (!hiddenPick) {
    return undefined;
  }

  return {
    id: seed?.id ?? randomUUID(),
    name,
    group: group?.trim() || undefined,
    host,
    port,
    username,
    authType: authTypePick,
    keyPath,
    isHidden: hiddenPick === "Yes"
  };
}

export async function promptTunnelProfile(
  seed?: Partial<TunnelProfile>,
  options?: PromptModeOptions
): Promise<TunnelProfile | undefined> {
  const mode = options?.mode ?? (seed?.id ? "edit" : "add");
  const base = mode === "edit" ? "Edit Tunnel Profile" : "Add Tunnel Profile";
  const total = 6;

  const name = await requiredInput(stepTitle(base, 1, total), "Tunnel name", seed?.name ?? "");
  if (!name) {
    return undefined;
  }
  const localPort = await numberInput(stepTitle(base, 2, total), "Local port", seed?.localPort ?? 5432, 1, 65535);
  if (!localPort) {
    return undefined;
  }
  const remoteIP = await requiredInput(stepTitle(base, 3, total), "Remote IP", seed?.remoteIP ?? "127.0.0.1");
  if (!remoteIP) {
    return undefined;
  }
  const remotePort = await numberInput(stepTitle(base, 4, total), "Remote port", seed?.remotePort ?? localPort, 1, 65535);
  if (!remotePort) {
    return undefined;
  }
  const autoStartPick = await pickChoice<"No" | "Yes">(
    stepTitle(base, 5, total) + " — Autostart this tunnel?",
    [
      { label: "No", value: "No" },
      { label: "Yes", value: "Yes" }
    ],
    seed?.autoStart ? "Yes" : "No"
  );
  if (!autoStartPick) {
    return undefined;
  }
  const connectionModeChoices: Array<Choice<TunnelConnectionMode>> = [
    { label: "Isolated per connection (recommended)", value: "isolated" },
    { label: "Shared SSH connection", value: "shared" },
    { label: "Ask every start", value: "ask" }
  ];
  const connectionModePick = await pickChoice<TunnelConnectionMode>(
    stepTitle(base, 6, total) + " — Tunnel connection mode",
    connectionModeChoices,
    seed?.connectionMode
  );
  if (!connectionModePick) {
    return undefined;
  }

  return {
    id: seed?.id ?? randomUUID(),
    name,
    localPort,
    remoteIP,
    remotePort,
    defaultServerId: seed?.defaultServerId,
    autoStart: autoStartPick === "Yes",
    connectionMode: connectionModePick
  };
}

export async function promptSerialProfile(
  seed?: Partial<SerialProfile>,
  options?: PromptModeOptions & { existingGroups?: string[] }
): Promise<SerialProfile | undefined> {
  const mode = options?.mode ?? (seed?.id ? "edit" : "add");
  const base = mode === "edit" ? "Edit Serial Profile" : "Add Serial Profile";
  const total = 8;

  const name = await requiredInput(stepTitle(base, 1, total), "Connection name", seed?.name ?? "");
  if (!name) {
    return undefined;
  }
  const portPath = await requiredInput(stepTitle(base, 2, total), "Port path (e.g. COM3, /dev/ttyUSB0)", seed?.path ?? "");
  if (!portPath) {
    return undefined;
  }
  const commonBaudRates = [9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600];
  const baudRateItems = [
    ...commonBaudRates.map((rate) => ({
      label: `${rate}`,
      value: rate,
      picked: rate === (seed?.baudRate ?? 115200)
    })),
    { label: "Custom...", value: -1, picked: false }
  ];
  const baudRatePick = await vscode.window.showQuickPick(baudRateItems, {
    title: stepTitle(base, 3, total) + " — Baud rate",
    canPickMany: false
  });
  if (!baudRatePick) {
    return undefined;
  }
  let baudRate: number;
  if (baudRatePick.value === -1) {
    const customRate = await numberInput(stepTitle(base, 3, total), "Custom baud rate", seed?.baudRate ?? 115200, 1, 4000000);
    if (!customRate) {
      return undefined;
    }
    baudRate = customRate;
  } else {
    baudRate = baudRatePick.value;
  }
  const dataBitsPick = await pickChoice<`${SerialDataBits}`>(
    stepTitle(base, 4, total) + " — Data bits",
    [
      { label: "8", value: "8" },
      { label: "7", value: "7" },
      { label: "6", value: "6" },
      { label: "5", value: "5" }
    ],
    `${seed?.dataBits ?? 8}` as `${SerialDataBits}`
  );
  if (!dataBitsPick) {
    return undefined;
  }
  const stopBitsPick = await pickChoice<`${SerialStopBits}`>(
    stepTitle(base, 5, total) + " — Stop bits",
    [
      { label: "1", value: "1" },
      { label: "2", value: "2" }
    ],
    `${seed?.stopBits ?? 1}` as `${SerialStopBits}`
  );
  if (!stopBitsPick) {
    return undefined;
  }
  const parity = await pickChoice<SerialParity>(
    stepTitle(base, 6, total) + " — Parity",
    [
      { label: "None", value: "none" },
      { label: "Even", value: "even" },
      { label: "Odd", value: "odd" },
      { label: "Mark", value: "mark" },
      { label: "Space", value: "space" }
    ],
    seed?.parity ?? "none"
  );
  if (!parity) {
    return undefined;
  }
  const rtsctsPick = await pickChoice<"No" | "Yes">(
    stepTitle(base, 7, total) + " — Enable RTS/CTS hardware flow control?",
    [
      { label: "No", value: "No" },
      { label: "Yes", value: "Yes" }
    ],
    seed?.rtscts ? "Yes" : "No"
  );
  if (!rtsctsPick) {
    return undefined;
  }

  const group = await pickOrCreateGroup(stepTitle(base, 8, total), options?.existingGroups, seed?.group);

  return {
    id: seed?.id ?? randomUUID(),
    name,
    group: group?.trim() || undefined,
    path: portPath,
    baudRate,
    dataBits: Number(dataBitsPick) as SerialDataBits,
    stopBits: Number(stopBitsPick) as SerialStopBits,
    parity,
    rtscts: rtsctsPick === "Yes"
  };
}
