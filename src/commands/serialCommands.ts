import { randomUUID } from "node:crypto";
import * as vscode from "vscode";
import { resolveSerialProfileMode, type SerialDataBits, type SerialDeviceHint, type SerialParity, type SerialProfile, type SerialSessionStatus, type SerialStopBits } from "../models/config";
import { createSessionTranscript } from "../logging/sessionTranscriptLogger";
import { SerialPty } from "../services/serial/serialPty";
import { isSerialRuntimeMissingError } from "../services/serial/errorMatchers";
import {
  SmartSerialPty,
  normalizePortPath,
  type SmartFollowPromptInput,
  type SmartFollowPromptResult,
  type SmartSerialTransport
} from "../services/serial/smartSerialPty";
import type { SerialPortInfo } from "../services/serial/protocol";
import type { SerialSidecarManager } from "../services/serial/serialSidecarManager";
import { serialFormDefinition } from "../ui/formDefinitions";
import type { FormValues } from "../ui/formTypes";
import {
  SerialProfileTreeItem,
  SerialSessionTreeItem
} from "../ui/nexusTreeProvider";
import { WebviewFormPanel } from "../ui/webviewFormPanel";
import { toParityCode } from "../utils/helpers";
import { normalizeOptionalFolderPath, INVALID_FOLDER_PATH_MESSAGE } from "../utils/folderPaths";
import { collectGroups } from "./serverCommands";
import type { CommandContext, SerialTerminalEntry } from "./types";
import { pickScriptFromWorkspace } from "../services/scripts/scriptPicker";

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

/**
 * Collect normalized paths of serial ports currently held by other Nexus serial sessions.
 * Used by Smart Follow to filter out ports another session owns before opening or showing pickers.
 */
function collectBusySerialPaths(
  ctx: CommandContext,
  excludeSessionKey?: string
): Set<string> {
  const busy = new Set<string>();
  for (const [key, entry] of ctx.serialTerminals.entries()) {
    if (key === excludeSessionKey) {
      continue;
    }
    if (entry.activePath) {
      busy.add(normalizePortPath(entry.activePath));
    }
  }
  return busy;
}

function formatVidPid(port: SerialPortInfo): string | undefined {
  if (port.vendorId && port.productId) {
    return `VID:PID ${port.vendorId}:${port.productId}`;
  }
  return undefined;
}

/**
 * QuickPick used by Smart Follow when the preferred port is missing/busy and the
 * candidate set requires explicit user choice. Always includes a "Keep waiting" item.
 */
async function promptSmartSerialPortChoice(
  input: SmartFollowPromptInput
): Promise<SmartFollowPromptResult> {
  type Item = vscode.QuickPickItem & { port?: SerialPortInfo; wait?: boolean };
  const items: Item[] = [];

  const sortedHints = [...input.hintMatches].sort((a, b) => a.path.localeCompare(b.path));
  for (const port of sortedHints) {
    items.push({
      label: `$(plug) ${port.path}`,
      description: port.manufacturer ?? formatVidPid(port) ?? "Unknown device",
      detail: "Matches saved device (same vendor/serial)",
      port
    });
  }

  const sortedOthers = [...input.otherCandidates].sort((a, b) => a.path.localeCompare(b.path));
  for (const port of sortedOthers) {
    const detail = input.hasHint
      ? "New device — does not match saved device"
      : `Serial: ${port.serialNumber ?? "?"}  ${formatVidPid(port) ?? ""}`.trim();
    items.push({
      label: `$(plug) ${port.path}`,
      description: port.manufacturer ?? formatVidPid(port) ?? "Unknown device",
      detail,
      port
    });
  }

  items.push({
    label: "$(clock) Keep waiting",
    description: "",
    detail: "Dismiss this picker; Smart Follow will keep polling and reappear when ports change",
    wait: true
  });

  const placeholder =
    input.preferredStatus === "busy"
      ? `Preferred port ${input.preferredPath} is busy. Pick a replacement or keep waiting.`
      : `Preferred port ${input.preferredPath} is missing. Pick a replacement or keep waiting.`;

  const pick = await vscode.window.showQuickPick<Item>(items, {
    title: `Smart Follow: choose port for ${input.profileName}`,
    placeHolder: placeholder,
    ignoreFocusOut: true,
    matchOnDescription: true,
    matchOnDetail: true
  });

  if (!pick || pick.wait || !pick.port) {
    return { kind: "wait" };
  }
  return { kind: "connect", port: pick.port };
}

const VALID_DATA_BITS = new Set<number>([5, 6, 7, 8]);
const VALID_STOP_BITS = new Set<number>([1, 2]);
const VALID_PARITY = new Set<string>(["none", "even", "odd", "mark", "space"]);

function getDefaultSessionTranscriptsEnabled(): boolean {
  return vscode.workspace.getConfiguration("nexus.logging").get<boolean>("sessionTranscripts", true);
}

function serialTerminalName(profile: SerialProfile): string {
  return resolveSerialProfileMode(profile) === "smartFollow"
    ? `Nexus Serial: ${profile.name} [Smart Follow]`
    : `Nexus Serial: ${profile.name}`;
}

function sameDeviceHint(left: SerialDeviceHint | undefined, right: SerialDeviceHint | undefined): boolean {
  return (
    left?.manufacturer === right?.manufacturer &&
    left?.serialNumber === right?.serialNumber &&
    left?.vendorId === right?.vendorId &&
    left?.productId === right?.productId
  );
}

/**
 * Look up an existing serial terminal entry for a profile so a second "Connect"
 * click refocuses the existing terminal instead of creating a duplicate.
 */
function findSerialSessionForProfile(
  ctx: CommandContext,
  profileId: string
): SerialTerminalEntry | undefined {
  for (const entry of ctx.serialTerminals.values()) {
    if (entry.profileId === profileId) {
      return entry;
    }
  }
  return undefined;
}

/**
 * Find a serial terminal entry whose session currently holds a specific COM path.
 * Used to block a new session from opening a port another session owns and to
 * name the offending session in the warning toast.
 */
function findSerialSessionHoldingPath(
  ctx: CommandContext,
  targetPath: string
): SerialTerminalEntry | undefined {
  const normalized = normalizePortPath(targetPath);
  for (const entry of ctx.serialTerminals.values()) {
    if (entry.activePath && normalizePortPath(entry.activePath) === normalized) {
      return entry;
    }
  }
  return undefined;
}

/**
 * Apply the "same profile → refocus" and "port already held by another session →
 * warn and bail" rules. Returns `true` if the connect should proceed; `false` if
 * the caller must return early (because the rule handled the interaction).
 */
function enforceSerialConnectPreconditions(
  ctx: CommandContext,
  profile: SerialProfile
): boolean {
  const existing = findSerialSessionForProfile(ctx, profile.id);
  if (existing) {
    ctx.focusedTerminal = existing.terminal;
    existing.terminal.show();
    return false;
  }
  const conflict = findSerialSessionHoldingPath(ctx, profile.path);
  if (conflict) {
    void vscode.window.showWarningMessage(
      `Serial port ${profile.path} is already in use by "${conflict.terminal.name}". Close that session or pick a different port.`
    );
    return false;
  }
  return true;
}

export function formValuesToSerial(values: FormValues, existing?: Partial<SerialProfile>): SerialProfile | undefined {
  const name = typeof values.name === "string" ? values.name.trim() : "";
  const portPath = typeof values.path === "string" ? values.path.trim() : "";
  const normalizedGroup = normalizeOptionalFolderPath(values.group);
  if (!name || !portPath) {
    return undefined;
  }
  if (normalizedGroup === null) {
    return undefined;
  }
  const dataBits = typeof values.dataBits === "string" ? Number(values.dataBits) : 8;
  const stopBits = typeof values.stopBits === "string" ? Number(values.stopBits) : 1;
  const parity = typeof values.parity === "string" ? values.parity : "none";
  const rawMode = typeof values.mode === "string" ? values.mode : existing?.mode;
  return {
    id: existing?.id ?? randomUUID(),
    name,
    path: portPath,
    baudRate: typeof values.baudRate === "string" ? Number(values.baudRate) : 115200,
    dataBits: VALID_DATA_BITS.has(dataBits) ? (dataBits as SerialDataBits) : 8,
    stopBits: VALID_STOP_BITS.has(stopBits) ? (stopBits as SerialStopBits) : 1,
    parity: VALID_PARITY.has(parity) ? (parity as SerialParity) : "none",
    rtscts: values.rtscts === true,
    logSession: typeof values.logSession === "boolean" ? values.logSession : getDefaultSessionTranscriptsEnabled(),
    group: normalizedGroup,
    mode: rawMode === "smartFollow" ? "smartFollow" : "standard",
    deviceHint: existing?.deviceHint
  };
}

async function connectStandardSerialProfile(ctx: CommandContext, profile: SerialProfile): Promise<void> {
  if (!enforceSerialConnectPreconditions(ctx, profile)) {
    return;
  }
  const terminalName = serialTerminalName(profile);
  let terminalRef: vscode.Terminal | undefined;
  let ptyRef: SerialPty | undefined;
  const triggerObserver = ctx.macroAutoTrigger.createObserver(
    (text) => ptyRef?.handleInput(text),
    () => ctx.focusedTerminal === terminalRef
  );
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
          ctx.serialTerminals.set(sessionId, {
            terminal: terminalRef,
            profileId: profile.id,
            transportSessionId: sessionId,
            activePath: profile.path
          });
        }
        if (ptyRef) {
          ctx.activityIndicators.set(sessionId, ptyRef);
        }
        ctx.core.registerSerialSession({
          id: sessionId,
          profileId: profile.id,
          terminalName,
          startedAt: Date.now(),
          pty: ptyRef
        });
        ctx.macroAutoTrigger.bindObserverToSession(triggerObserver, sessionId);
      },
      onSessionClosed: (sessionId) => {
        ctx.serialTerminals.delete(sessionId);
        ctx.activityIndicators.delete(sessionId);
        ctx.core.unregisterSerialSession(sessionId);
      },
      onDataReceived: (sessionId) => {
        if (terminalRef && ctx.focusedTerminal !== terminalRef) {
          ctx.core.markSessionActivity(sessionId);
          ptyRef?.setActivityIndicator(true);
        }
      }
    },
    ctx.loggerFactory.create("terminal", `serial-${profile.id}`),
    createSessionTranscript(
      ctx.sessionLogDir,
      profile.name,
      profile.logSession ?? getDefaultSessionTranscriptsEnabled()
    ),
    ctx.highlighter,
    triggerObserver
  );
  ptyRef = pty;

  const openInEditor = vscode.workspace.getConfiguration("nexus.terminal").get("openLocation") === "editor";
  const terminal = vscode.window.createTerminal({
    name: terminalName,
    pty,
    location: openInEditor ? vscode.TerminalLocation.Editor : vscode.TerminalLocation.Panel
  });
  terminalRef = terminal;
  ctx.terminalRegistry?.register(terminal, pty);
  ctx.focusedTerminal = terminal;
  terminal.show();
}

async function connectSmartSerialProfile(ctx: CommandContext, profile: SerialProfile): Promise<void> {
  if (!enforceSerialConnectPreconditions(ctx, profile)) {
    return;
  }

  const logicalSessionId = randomUUID();
  const startedAt = Date.now();
  const terminalName = serialTerminalName(profile);
  let terminalRef: vscode.Terminal | undefined;
  let ptyRef: SmartSerialPty | undefined;
  let currentProfile = profile;
  const triggerObserver = ctx.macroAutoTrigger.createObserver(
    (text) => ptyRef?.handleInput(text),
    () => ctx.focusedTerminal === terminalRef
  );

  const pty = new SmartSerialPty(
    ctx.serialSidecar as SmartSerialTransport,
    profile,
    {
      onClosed: () => {
        ctx.serialTerminals.delete(logicalSessionId);
        ctx.activityIndicators.delete(logicalSessionId);
        ctx.core.unregisterSerialSession(logicalSessionId);
      },
      onDataReceived: () => {
        if (terminalRef && ctx.focusedTerminal !== terminalRef) {
          ctx.core.markSessionActivity(logicalSessionId);
          ptyRef?.setActivityIndicator(true);
        }
      },
      onTransportSessionChanged: (transportSessionId) => {
        const entry = ctx.serialTerminals.get(logicalSessionId);
        if (entry) {
          entry.transportSessionId = transportSessionId;
        }
      },
      onResolvedPort: async (path, deviceHint) => {
        const latest = ctx.core.getSerialProfile(currentProfile.id) ?? currentProfile;
        if (latest.path === path && sameDeviceHint(latest.deviceHint, deviceHint)) {
          currentProfile = latest;
          return;
        }
        currentProfile = { ...latest, path, deviceHint };
        await ctx.core.addOrUpdateSerialProfile(currentProfile);
      },
      onStateChanged: (status: SerialSessionStatus) => {
        ctx.core.registerSerialSession({
          id: logicalSessionId,
          profileId: profile.id,
          terminalName,
          startedAt,
          status,
          pty: ptyRef
        });
      },
      onFatalError: (message) => {
        // Notification only — Smart Follow keeps the terminal tab open in a sticky stopped state.
        void vscode.window.showErrorMessage(`Smart Follow stopped for ${profile.name}: ${message}`);
      },
      getBusyPaths: () => collectBusySerialPaths(ctx, logicalSessionId),
      promptPortChoice: (input) => promptSmartSerialPortChoice(input),
      onActivePortChanged: (path) => {
        const entry = ctx.serialTerminals.get(logicalSessionId);
        if (entry) {
          entry.activePath = path;
        }
      }
    },
    ctx.loggerFactory.create("terminal", `smart-serial-${profile.id}`),
    createSessionTranscript(
      ctx.sessionLogDir,
      profile.name,
      profile.logSession ?? getDefaultSessionTranscriptsEnabled()
    ),
    ctx.highlighter,
    triggerObserver
  );
  ptyRef = pty;

  const openInEditor = vscode.workspace.getConfiguration("nexus.terminal").get("openLocation") === "editor";
  const terminal = vscode.window.createTerminal({
    name: terminalName,
    pty,
    location: openInEditor ? vscode.TerminalLocation.Editor : vscode.TerminalLocation.Panel
  });
  terminalRef = terminal;
  ctx.terminalRegistry?.register(terminal, pty);
  ctx.serialTerminals.set(logicalSessionId, {
    terminal,
    profileId: profile.id,
    smartFollow: true,
    activePath: undefined
  });
  ctx.activityIndicators.set(logicalSessionId, pty);
  ctx.core.registerSerialSession({
    id: logicalSessionId,
    profileId: profile.id,
    terminalName,
    startedAt,
    status: "waiting",
    pty
  });
  ctx.macroAutoTrigger.bindObserverToSession(triggerObserver, logicalSessionId);
  ctx.focusedTerminal = terminal;
  terminal.show();
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
      const definition = serialFormDefinition(existing, existingGroups, getDefaultSessionTranscriptsEnabled());
      WebviewFormPanel.open("serial-edit", definition, {
        onScan: () => scanForPort(ctx),
        onSubmit: async (values) => {
          if (normalizeOptionalFolderPath(values.group) === null) {
            throw new Error(INVALID_FOLDER_PATH_MESSAGE);
          }
          const updated = formValuesToSerial(values, existing);
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
        if (resolveSerialProfileMode(profile) === "smartFollow") {
          await connectSmartSerialProfile(ctx, profile);
        } else {
          await connectStandardSerialProfile(ctx, profile);
        }
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

    // Connect to a serial profile and auto-run a picked Nexus script once the
    // session is registered. Same pattern as nexus.server.runWithScript but for
    // the serial active-session list.
    vscode.commands.registerCommand("nexus.serial.runWithScript", async (arg?: unknown) => {
      const profile = toSerialProfileFromArg(ctx.core, arg) ?? (await pickSerialProfile(ctx.core));
      if (!profile) return;
      if (!ctx.scriptRuntimeManager) {
        void vscode.window.showErrorMessage("Nexus script runtime is not available in this context.");
        return;
      }
      const scriptUri = await pickScriptFromWorkspace("serial");
      if (!scriptUri) return;

      const preExisting = new Set(
        ctx.core
          .getSnapshot()
          .activeSerialSessions.filter((s) => s.profileId === profile.id)
          .map((s) => s.id)
      );
      const timeoutMs = 90_000;
      let resolved = false;
      const unsubscribe = ctx.core.onDidChange(() => {
        if (resolved) return;
        const newSession = ctx.core
          .getSnapshot()
          .activeSerialSessions.find((s) => s.profileId === profile.id && !preExisting.has(s.id));
        if (!newSession) return;
        resolved = true;
        clearTimeout(timer);
        unsubscribe();
        void ctx.scriptRuntimeManager!.runScript(scriptUri, newSession.id).catch((err) => {
          const message = err instanceof Error ? err.message : String(err);
          void vscode.window.showErrorMessage(`Failed to start script after connect: ${message}`);
        });
      });
      const timer = setTimeout(() => {
        if (resolved) return;
        resolved = true;
        unsubscribe();
        void vscode.window.showWarningMessage(
          `Connected to ${profile.name} but the script did not start within ${timeoutMs / 1000}s.`
        );
      }, timeoutMs);

      try {
        if (resolveSerialProfileMode(profile) === "smartFollow") {
          await connectSmartSerialProfile(ctx, profile);
        } else {
          await connectStandardSerialProfile(ctx, profile);
        }
      } catch (err) {
        resolved = true;
        clearTimeout(timer);
        unsubscribe();
        const message = err instanceof Error ? err.message : String(err);
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

    vscode.commands.registerCommand("nexus.serial.sendBreak", async () => {
      const activeTerminal = vscode.window.activeTerminal;
      if (!activeTerminal) {
        return;
      }
      for (const [sessionId, entry] of ctx.serialTerminals.entries()) {
        if (entry.terminal === activeTerminal) {
          if (!entry.transportSessionId) {
            void vscode.window.showWarningMessage("Smart Follow is waiting for a live serial port. Send Break is unavailable right now.");
            return;
          }
          try {
            await ctx.serialSidecar.sendBreak(entry.transportSessionId ?? sessionId);
          } catch (error) {
            const message = error instanceof Error ? error.message : "unknown serial break error";
            void vscode.window.showErrorMessage(`Failed to send break: ${message}`);
          }
          return;
        }
      }
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
