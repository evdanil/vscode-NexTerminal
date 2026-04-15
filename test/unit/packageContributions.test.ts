import { readFileSync } from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

const packageJsonPath = path.resolve(__dirname, "..", "..", "package.json");
const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
  dependencies: Record<string, string>;
  configurationDefaults?: Record<string, unknown>;
  contributes: {
    commands: Array<{ command: string; title: string; enablement?: string; icon?: string }>;
    menus: Record<string, Array<{ command: string; when?: string; group?: string }>>;
    configuration?: { properties?: Record<string, any> };
    viewsWelcome?: Array<{ view: string; contents: string }>;
    keybindings?: Array<{ command: string; key: string; mac?: string; when?: string }>;
  };
};

describe("package contributions", () => {
  it("includes serialport runtime dependency", () => {
    expect(packageJson.dependencies.serialport).toBeDefined();
  });

  it("contributes edit commands for server, tunnel, and serial profiles", () => {
    const commands = packageJson.contributes.commands.map((item) => item.command);
    expect(commands).toContain("nexus.server.edit");
    expect(commands).toContain("nexus.tunnel.edit");
    expect(commands).toContain("nexus.serial.edit");
  });

  it("binds context menus for server/tunnel edit actions", () => {
    const menuItems = packageJson.contributes.menus["view/item/context"] ?? [];
    const menuCommands = menuItems.map((item) => item.command);
    expect(menuCommands).toContain("nexus.server.edit");
    expect(menuCommands).toContain("nexus.tunnel.edit");
    expect(menuCommands).toContain("nexus.serial.edit");
    expect(menuItems.some((item) => item.when?.includes("viewItem == nexus.sessionNode"))).toBe(true);
    expect(menuItems.some((item) => item.when?.includes("viewItem == nexus.serverConnected"))).toBe(true);
    expect(menuItems.some((item) => item.when?.includes("viewItem =~ /^nexus\\.serialProfile(Connected|Waiting)?$/"))).toBe(true);
  });

  it("does not gate serial connect actions on the removed smart-follow lock", () => {
    const menuItems = packageJson.contributes.menus["view/item/context"] ?? [];
    const connectItems = menuItems.filter((item) => item.command === "nexus.serial.connect");
    expect(connectItems.length).toBeGreaterThan(0);
    expect(connectItems.every((item) => !item.when?.includes("nexus.smartSerialLocked"))).toBe(true);
    expect(
      connectItems.every((item) =>
        item.when?.includes("viewItem =~ /^nexus\\.serialProfile(Connected|Waiting)?$/")
      )
    ).toBe(true);
  });

  it("contributes unified profile.add, group.add, and group.remove commands", () => {
    const commands = packageJson.contributes.commands.map((item) => item.command);
    expect(commands).toContain("nexus.profile.add");
    expect(commands).toContain("nexus.group.add");
    expect(commands).toContain("nexus.group.remove");
  });

  it("contributes settings.openPanel command", () => {
    const commands = packageJson.contributes.commands.map((item) => item.command);
    expect(commands).toContain("nexus.settings.openPanel");
  });

  it("contributes macro.editor command", () => {
    const commands = packageJson.contributes.commands.map((item) => item.command);
    expect(commands).toContain("nexus.macro.editor");
  });

  it("does not gate secret macro paste behind clipboard context state", () => {
    const pasteSecret = packageJson.contributes.commands.find((item) => item.command === "nexus.macro.pasteSecret");
    expect(pasteSecret).toBeDefined();
    expect(pasteSecret?.enablement).toBeUndefined();
  });

  it("does not contribute the legacy macro.slot command", () => {
    const commands = packageJson.contributes.commands.map((item) => item.command);
    expect(commands).not.toContain("nexus.macro.slot");
  });

  it("includes secret property in macro schema", () => {
    const cfg = packageJson.contributes.configuration;
    const macroSchema = cfg?.properties?.["nexus.terminal.macros"];
    expect(macroSchema).toBeDefined();
    expect(macroSchema?.items?.properties?.secret).toBeDefined();
    expect(macroSchema?.items?.properties?.secret?.type).toBe("boolean");
    expect(macroSchema?.items?.properties?.triggerInitiallyDisabled).toBeDefined();
    expect(macroSchema?.items?.properties?.triggerInitiallyDisabled?.type).toBe("boolean");
    expect(macroSchema?.items?.properties?.triggerInterval).toBeDefined();
    expect(macroSchema?.items?.properties?.triggerInterval?.type).toBe("number");
  });

  it("uses nexus.folder contextValue in folder menu when clauses", () => {
    const menuItems = packageJson.contributes.menus["view/item/context"] ?? [];
    const folderMenuItems = menuItems.filter((item) => item.when?.includes("nexus.folder"));
    expect(folderMenuItems.length).toBeGreaterThan(0);
    const groupMenuItems = menuItems.filter((item) => item.when?.includes("nexus.group"));
    expect(groupMenuItems).toHaveLength(0);
  });

  it("has a single add button in the command center title bar", () => {
    const titleMenuItems = packageJson.contributes.menus["view/title"] ?? [];
    const commandCenterNavItems = titleMenuItems.filter(
      (item) => item.when === "view == nexusCommandCenter" && typeof item.group === "string" && item.group.startsWith("navigation")
    );
    const addCommands = commandCenterNavItems.filter(
      (item) => item.command === "nexus.profile.add" || item.command === "nexus.server.add" || item.command === "nexus.serial.add"
    );
    expect(addCommands).toHaveLength(1);
    expect(addCommands[0].command).toBe("nexus.profile.add");
  });

  it("uses explicit folder-server wording for folder connect actions", () => {
    const commands = packageJson.contributes.commands;
    const connect = commands.find((item) => item.command === "nexus.group.connect");
    const disconnect = commands.find((item) => item.command === "nexus.group.disconnect");
    expect(connect?.title).toBe("Connect Folder Servers");
    expect(disconnect?.title).toBe("Disconnect Folder Servers");
  });

  it("only skips shell for live macro commands", () => {
    const commandsToSkipShell = packageJson.configurationDefaults?.["terminal.integrated.commandsToSkipShell"];
    expect(commandsToSkipShell).toEqual(["nexus.macro.run", "nexus.macro.runBinding"]);
  });

  describe("Scripts view contributions (S1/S2/S3/F3/P1)", () => {
    it("contributes a viewsWelcome entry for nexusScripts with New Script and docs actions", () => {
      const welcome = packageJson.contributes.viewsWelcome ?? [];
      const entry = welcome.find((w) => w.view === "nexusScripts");
      expect(entry).toBeDefined();
      expect(entry?.contents).toContain("command:nexus.script.new");
      expect(entry?.contents).toContain("command:nexus.script.openDocs");
    });

    it("contributes a nexus.script.openDocs command", () => {
      const commands = packageJson.contributes.commands.map((item) => item.command);
      expect(commands).toContain("nexus.script.openDocs");
    });

    it("contributes a nexus.script.delete command", () => {
      const commands = packageJson.contributes.commands.map((item) => item.command);
      expect(commands).toContain("nexus.script.delete");
    });

    it("adds a New Script button to the nexusScripts view title bar", () => {
      const titleMenuItems = packageJson.contributes.menus["view/title"] ?? [];
      const newScriptItem = titleMenuItems.find(
        (item) => item.command === "nexus.script.new" && item.when === "view == nexusScripts"
      );
      expect(newScriptItem).toBeDefined();
      expect(newScriptItem?.group).toMatch(/^navigation/);
    });

    it("adds run/stop/reveal/delete context menus for the nexusScripts view items", () => {
      const items = packageJson.contributes.menus["view/item/context"] ?? [];
      const scriptItems = items.filter((i) => i.when?.includes("view == nexusScripts"));
      const commands = scriptItems.map((i) => i.command);
      expect(commands).toContain("nexus.script.run");
      expect(commands).toContain("nexus.script.stop");
      expect(commands).toContain("revealInExplorer");
      expect(commands).toContain("nexus.script.delete");

      // Inline run appears on idle items only
      const inlineRun = scriptItems.find(
        (i) => i.command === "nexus.script.run" && i.group === "inline"
      );
      expect(inlineRun?.when).toContain("viewItem == nexus.script.file");

      // Inline stop appears on running items only
      const inlineStop = scriptItems.find(
        (i) => i.command === "nexus.script.stop" && i.group === "inline"
      );
      expect(inlineStop?.when).toContain("viewItem == nexus.script.running");
    });

    it("hides nexus.script.runWithTarget from the command palette (F3)", () => {
      const palette = packageJson.contributes.menus["commandPalette"] ?? [];
      const entry = palette.find((p) => p.command === "nexus.script.runWithTarget");
      expect(entry).toBeDefined();
      expect(entry?.when).toBe("false");
    });

    it("contributes nexus.scripts.maxRuntimeMs setting (S3)", () => {
      const prop = packageJson.contributes.configuration?.properties?.["nexus.scripts.maxRuntimeMs"];
      expect(prop).toBeDefined();
      expect(prop?.type).toBe("number");
      expect(prop?.default).toBe(1_800_000);
      expect(prop?.minimum).toBe(10_000);
      expect(prop?.markdownDescription || prop?.description).toMatch(/runtime/i);
    });

    it("contributes optional keybindings for script run/stop (P1)", () => {
      const kbs = packageJson.contributes.keybindings ?? [];
      const runBinding = kbs.find((k) => k.command === "nexus.script.run");
      expect(runBinding).toBeDefined();
      expect(runBinding?.key.toLowerCase()).toContain("ctrl+alt+r");
      expect(runBinding?.mac?.toLowerCase()).toContain("cmd+alt+r");
      expect(runBinding?.when).toMatch(/editorTextFocus/);
      expect(runBinding?.when).toMatch(/resourceExtname == .js|resourceExtname == \.js/);

      const stopBinding = kbs.find((k) => k.command === "nexus.script.stop");
      expect(stopBinding).toBeDefined();
      expect(stopBinding?.key.toLowerCase()).toContain("ctrl+alt+s");
      expect(stopBinding?.mac?.toLowerCase()).toContain("cmd+alt+s");
      expect(stopBinding?.when).toMatch(/nexusHasRunningScripts/);
    });
  });
});
