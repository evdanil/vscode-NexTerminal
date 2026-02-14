import { v4 as uuidv4 } from "uuid";
import * as vscode from "vscode";
import type { AuthType, ServerConfig, TunnelProfile } from "../models/config";

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

async function numberInput(title: string, prompt: string, value: number): Promise<number | undefined> {
  const result = await requiredInput(title, prompt, `${value}`);
  if (!result) {
    return undefined;
  }
  const parsed = Number(result);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    vscode.window.showErrorMessage("Expected a positive integer");
    return undefined;
  }
  return parsed;
}

export async function promptServerConfig(seed?: Partial<ServerConfig>): Promise<ServerConfig | undefined> {
  const name = await requiredInput("Add Nexus Server", "Display name", seed?.name ?? "");
  if (!name) {
    return undefined;
  }
  const host = await requiredInput("Add Nexus Server", "Hostname or IP", seed?.host ?? "");
  if (!host) {
    return undefined;
  }
  const port = await numberInput("Add Nexus Server", "SSH Port", seed?.port ?? 22);
  if (!port) {
    return undefined;
  }
  const username = await requiredInput("Add Nexus Server", "SSH Username", seed?.username ?? "");
  if (!username) {
    return undefined;
  }
  const authTypePick = (await vscode.window.showQuickPick(["password", "key", "agent"] as const, {
    title: "Authentication Method",
    canPickMany: false
  })) as AuthType | undefined;
  if (!authTypePick) {
    return undefined;
  }
  let keyPath: string | undefined;
  if (authTypePick === "key") {
    keyPath = await requiredInput("Add Nexus Server", "Private key path", seed?.keyPath ?? "");
    if (!keyPath) {
      return undefined;
    }
  }
  const group = await vscode.window.showInputBox({
    title: "Add Nexus Server",
    prompt: "Group (optional)",
    value: seed?.group ?? "",
    ignoreFocusOut: true
  });
  const hiddenPick = (await vscode.window.showQuickPick(["No", "Yes"] as const, {
    title: "Hide from main server list (jump host)?",
    canPickMany: false
  })) as "No" | "Yes" | undefined;
  if (!hiddenPick) {
    return undefined;
  }

  return {
    id: seed?.id ?? uuidv4(),
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

export async function promptTunnelProfile(seed?: Partial<TunnelProfile>): Promise<TunnelProfile | undefined> {
  const name = await requiredInput("Add Tunnel Profile", "Tunnel name", seed?.name ?? "");
  if (!name) {
    return undefined;
  }
  const localPort = await numberInput("Add Tunnel Profile", "Local port", seed?.localPort ?? 5432);
  if (!localPort) {
    return undefined;
  }
  const remoteIP = await requiredInput("Add Tunnel Profile", "Remote IP", seed?.remoteIP ?? "127.0.0.1");
  if (!remoteIP) {
    return undefined;
  }
  const remotePort = await numberInput("Add Tunnel Profile", "Remote port", seed?.remotePort ?? localPort);
  if (!remotePort) {
    return undefined;
  }
  const autoStartPick = (await vscode.window.showQuickPick(["No", "Yes"] as const, {
    title: "Autostart this tunnel?",
    canPickMany: false
  })) as "No" | "Yes" | undefined;
  if (!autoStartPick) {
    return undefined;
  }

  return {
    id: seed?.id ?? uuidv4(),
    name,
    localPort,
    remoteIP,
    remotePort,
    defaultServerId: seed?.defaultServerId,
    autoStart: autoStartPick === "Yes"
  };
}
