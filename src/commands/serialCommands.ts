import { randomUUID } from "node:crypto";
import * as vscode from "vscode";
import type { SerialDataBits, SerialParity, SerialProfile, SerialStopBits } from "../models/config";
import { createSessionTranscript } from "../logging/sessionTranscriptLogger";
import { SerialPty } from "../services/serial/serialPty";
import type { SerialSidecarManager } from "../services/serial/serialSidecarManager";
import { serialFormDefinition } from "../ui/formDefinitions";
import type { FormValues } from "../ui/formTypes";
import {
  SerialProfileTreeItem,
  SerialSessionTreeItem
} from "../ui/nexusTreeProvider";
import { WebviewFormPanel } from "../ui/webviewFormPanel";
import { toParityCode } from "../utils/helpers";
import { collectGroups } from "./serverCommands";
import type { CommandContext } from "./types";

async function pickSerialProfile(
  core: import("../core/nexusCore").NexusCore
): Promise<SerialProfile | undefined> {
  const profiles = core.getSnapshot().serialProfiles;
  if (profiles.length === 0) {
    vscode.window.showWarningMessage("No Nexus serial profiles configured");
    return undefined;
  }
  const pick = await vscode.window.showQuickPick(
    profiles
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((profile) => ({
        label: profile.name,
        description: `${profile.path} @ ${profile.baudRate} (${profile.dataBits}${toParityCode(profile.parity)}${profile.stopBits})`,
        profile
      })),
    { title: "Select Serial Profile" }
  );
  return pick?.profile;
}

function isSerialRuntimeMissingError(message: string): boolean {
  const lower = message.toLowerCase();
  return lower.includes("serialport module not installed") || lower.includes("cannot find module 'serialport'");
}

function toSerialProfileFromArg(
  core: import("../core/nexusCore").NexusCore,
  arg: unknown
): SerialProfile | undefined {
  if (arg instanceof SerialProfileTreeItem) {
    return arg.profile;
  }
  if (arg instanceof SerialSessionTreeItem) {
    return core.getSerialProfile(arg.session.profileId);
  }
  if (typeof arg === "object" && arg) {
    const withProfile = arg as { profile?: SerialProfile };
    if (withProfile.profile?.id) {
      return core.getSerialProfile(withProfile.profile.id) ?? withProfile.profile;
    }
    const withSession = arg as { session?: { profileId?: string } };
    if (withSession.session?.profileId) {
      return core.getSerialProfile(withSession.session.profileId);
    }
  }
  if (typeof arg === "string") {
    return core.getSerialProfile(arg);
  }
  return undefined;
}

function toSerialSessionIdFromArg(arg: unknown): string | undefined {
  if (arg instanceof SerialSessionTreeItem) {
    return arg.session.id;
  }
  if (typeof arg === "object" && arg) {
    const withSession = arg as { session?: { id?: string } };
    if (withSession.session?.id) {
      return withSession.session.id;
    }
  }
  return undefined;
}

async function listSerialPorts(
  serialSidecar: SerialSidecarManager
): Promise<Array<{ path: string; manufacturer?: string }>> {
  try {
    const ports = await serialSidecar.listPorts();
    if (ports.length === 0) {
      void vscode.window.showInformationMessage(
        "No serial ports detected. Verify device connection, drivers, and OS permissions."
      );
    }
    return ports;
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown serial runtime error";
    if (isSerialRuntimeMissingError(message)) {
      void vscode.window.showErrorMessage(
        "Serial runtime missing or incompatible. Reinstall/upgrade Nexus Terminal and ensure host supports native serial modules."
      );
      return [];
    }
    void vscode.window.showErrorMessage(`Failed to query serial ports: ${message}`);
    return [];
  }
}

export async function scanForPort(ctx: CommandContext): Promise<string | undefined> {
  const ports = await listSerialPorts(ctx.serialSidecar);
  if (ports.length === 0) {
    return undefined;
  }
  const pick = await vscode.window.showQuickPick(
    ports.map((p) => ({
      label: p.path,
      description: p.manufacturer ?? ""
    })),
    { title: "Select Serial Port" }
  );
  return pick?.label;
}

const VALID_DATA_BITS = new Set<number>([5, 6, 7, 8]);
const VALID_STOP_BITS = new Set<number>([1, 2]);
const VALID_PARITY = new Set<string>(["none", "even", "odd", "mark", "space"]);

export function formValuesToSerial(values: FormValues, existingId?: string): SerialProfile | undefined {
  const name = typeof values.name === "string" ? values.name.trim() : "";
  const portPath = typeof values.path === "string" ? values.path.trim() : "";
  if (!name || !portPath) {
    return undefined;
  }
  const dataBits = typeof values.dataBits === "string" ? Number(values.dataBits) : 8;
  const stopBits = typeof values.stopBits === "string" ? Number(values.stopBits) : 1;
  const parity = typeof values.parity === "string" ? values.parity : "none";
  return {
    id: existingId ?? randomUUID(),
    name,
    path: portPath,
    baudRate: typeof values.baudRate === "string" ? Number(values.baudRate) : 115200,
    dataBits: VALID_DATA_BITS.has(dataBits) ? (dataBits as SerialDataBits) : 8,
    stopBits: VALID_STOP_BITS.has(stopBits) ? (stopBits as SerialStopBits) : 1,
    parity: VALID_PARITY.has(parity) ? (parity as SerialParity) : "none",
    rtscts: values.rtscts === true,
    logSession: values.logSession !== false,
    group: typeof values.group === "string" && values.group ? values.group : undefined
  };
}

export function registerSerialCommands(ctx: CommandContext): vscode.Disposable[] {
  return [
    vscode.commands.registerCommand("nexus.serial.add", () => {
      void vscode.commands.executeCommand("nexus.profile.add");
    }),

    vscode.commands.registerCommand("nexus.serial.edit", async (arg?: unknown) => {
      const existing = toSerialProfileFromArg(ctx.core, arg) ?? (await pickSerialProfile(ctx.core));
      if (!existing) {
        return;
      }
      const existingGroups = collectGroups(ctx);
      const definition = serialFormDefinition(existing, existingGroups);
      WebviewFormPanel.open("serial-edit", definition, {
        onScan: () => scanForPort(ctx),
        onSubmit: async (values) => {
          const updated = formValuesToSerial(values, existing.id);
          if (!updated) {
            return;
          }
          await ctx.core.addOrUpdateSerialProfile(updated);
          if (ctx.core.isSerialProfileConnected(existing.id)) {
            void vscode.window.showInformationMessage(
              "Serial profile updated. Existing sessions keep current settings until reconnect."
            );
          }
        }
      });
    }),

    vscode.commands.registerCommand("nexus.serial.remove", async (arg?: unknown) => {
      const profile = toSerialProfileFromArg(ctx.core, arg) ?? (await pickSerialProfile(ctx.core));
      if (!profile) {
        return;
      }
      const confirm = await vscode.window.showWarningMessage(
        `Remove serial profile "${profile.name}" and disconnect all sessions?`,
        { modal: true },
        "Remove"
      );
      if (confirm !== "Remove") {
        return;
      }
      for (const [sessionId, entry] of ctx.serialTerminals.entries()) {
        if (entry.profileId === profile.id) {
          entry.terminal.dispose();
          ctx.serialTerminals.delete(sessionId);
        }
      }
      await ctx.core.removeSerialProfile(profile.id);
    }),

    vscode.commands.registerCommand("nexus.serial.connect", async (arg?: unknown) => {
      try {
        const profile = toSerialProfileFromArg(ctx.core, arg) ?? (await pickSerialProfile(ctx.core));
        if (!profile) {
          return;
        }
        const terminalName = `Nexus Serial: ${profile.name}`;
        let terminalRef: vscode.Terminal | undefined;
        const pty = new SerialPty(
          ctx.serialSidecar,
          {
            path: profile.path,
            baudRate: profile.baudRate,
            dataBits: profile.dataBits,
            stopBits: profile.stopBits,
            parity: profile.parity,
            rtscts: profile.rtscts
          },
          {
            onSessionOpened: (sessionId) => {
              if (terminalRef) {
                ctx.serialTerminals.set(sessionId, { terminal: terminalRef, profileId: profile.id });
              }
              ctx.core.registerSerialSession({
                id: sessionId,
                profileId: profile.id,
                terminalName,
                startedAt: Date.now()
              });
            },
            onSessionClosed: (sessionId) => {
              ctx.serialTerminals.delete(sessionId);
              ctx.core.unregisterSerialSession(sessionId);
            }
          },
          ctx.loggerFactory.create("terminal", `serial-${profile.id}`),
          createSessionTranscript(ctx.sessionLogDir, profile.name, profile.logSession !== false),
          ctx.highlighter
        );

        const openInEditor = vscode.workspace.getConfiguration("nexus.terminal").get("openLocation") === "editor";
        const terminal = vscode.window.createTerminal({
          name: terminalName,
          pty,
          location: openInEditor ? vscode.TerminalLocation.Editor : vscode.TerminalLocation.Panel
        });
        terminalRef = terminal;
        terminal.show();
      } catch (error) {
        const message = error instanceof Error ? error.message : "unknown serial connection error";
        if (isSerialRuntimeMissingError(message)) {
          void vscode.window.showErrorMessage(
            "Serial runtime missing or incompatible. Reinstall/upgrade Nexus Terminal and ensure host supports native serial modules."
          );
          return;
        }
        void vscode.window.showErrorMessage(`Failed to open serial terminal: ${message}`);
      }
    }),

    vscode.commands.registerCommand("nexus.serial.disconnect", async (arg?: unknown) => {
      const sessionId = toSerialSessionIdFromArg(arg);
      if (sessionId) {
        const selected = ctx.serialTerminals.get(sessionId);
        if (selected) {
          selected.terminal.dispose();
          ctx.serialTerminals.delete(sessionId);
        }
        return;
      }

      const profile = toSerialProfileFromArg(ctx.core, arg);
      if (profile) {
        for (const [activeSessionId, entry] of ctx.serialTerminals.entries()) {
          if (entry.profileId === profile.id) {
            entry.terminal.dispose();
            ctx.serialTerminals.delete(activeSessionId);
          }
        }
        return;
      }

      if (ctx.serialTerminals.size === 0) {
        void vscode.window.showInformationMessage("No active serial sessions.");
        return;
      }

      const pick = await vscode.window.showQuickPick(
        [...ctx.serialTerminals.entries()].map(([sid, entry]) => ({
          label: entry.terminal.name,
          description: sid,
          terminal: entry.terminal
        })),
        { title: "Disconnect serial session" }
      );
      if (!pick) {
        return;
      }
      pick.terminal.dispose();
    }),

    vscode.commands.registerCommand("nexus.serial.copyInfo", async (arg?: unknown) => {
      const profile = toSerialProfileFromArg(ctx.core, arg) ?? (await pickSerialProfile(ctx.core));
      if (!profile) {
        return;
      }
      const info = `${profile.path} @ ${profile.baudRate} (${profile.dataBits}${toParityCode(profile.parity)}${profile.stopBits})`;
      await vscode.env.clipboard.writeText(info);
      void vscode.window.showInformationMessage(`Copied: ${info}`);
    }),

    vscode.commands.registerCommand("nexus.serial.rename", async (arg?: unknown) => {
      const profile = toSerialProfileFromArg(ctx.core, arg) ?? (await pickSerialProfile(ctx.core));
      if (!profile) {
        return;
      }
      const newName = await vscode.window.showInputBox({
        title: "Rename Serial Profile",
        value: profile.name,
        prompt: "Enter new name",
        validateInput: (value) => (value.trim() ? null : "Name cannot be empty")
      });
      if (!newName || newName.trim() === profile.name) {
        return;
      }
      await ctx.core.addOrUpdateSerialProfile({ ...profile, name: newName.trim() });
    }),

    vscode.commands.registerCommand("nexus.serial.duplicate", async (arg?: unknown) => {
      const profile = toSerialProfileFromArg(ctx.core, arg) ?? (await pickSerialProfile(ctx.core));
      if (!profile) {
        return;
      }
      const copy = { ...profile, id: randomUUID(), name: `${profile.name} (copy)` };
      await ctx.core.addOrUpdateSerialProfile(copy);
    }),

    vscode.commands.registerCommand("nexus.serial.listPorts", async () => {
      try {
        const ports = await listSerialPorts(ctx.serialSidecar);
        if (ports.length === 0) {
          return;
        }
        const formatted = ports
          .map((port) => `${port.path}${port.manufacturer ? ` (${port.manufacturer})` : ""}`)
          .join(", ");
        void vscode.window.showInformationMessage(`Detected serial ports: ${formatted}`);
      } catch (error) {
        const message = error instanceof Error ? error.message : "unknown serial error";
        void vscode.window.showErrorMessage(`Failed to list serial ports: ${message}`);
      }
    })
  ];
}
