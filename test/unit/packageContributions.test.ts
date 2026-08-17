import { readFileSync } from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

const packageJsonPath = path.resolve(__dirname, "..", "..", "package.json");
const readmePath = path.resolve(__dirname, "..", "..", "README.md");
const functionalDocsPath = path.resolve(__dirname, "..", "..", "docs", "functional-documentation.md");
const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
  dependencies: Record<string, string>;
  activationEvents?: string[];
  configurationDefaults?: Record<string, unknown>;
  contributes: {
    commands: Array<{ command: string; title: string; category?: string; enablement?: string; icon?: string }>;
    menus: Record<string, Array<{ command: string; when?: string; group?: string }>>;
    configuration?: { properties?: Record<string, any> };
    viewsWelcome?: Array<{ view: string; contents: string }>;
    keybindings?: Array<{ command: string; key: string; mac?: string; when?: string }>;
  };
};
const readme = readFileSync(readmePath, "utf8");
const functionalDocs = readFileSync(functionalDocsPath, "utf8");

describe("package contributions", () => {
  it("includes onUri in activationEvents for URI handler support", () => {
    expect(packageJson.activationEvents).toContain("onUri");
  });

  /**
   * EVE-NG (Phase 1) — a SECOND inventory provider ships, so the entry points
   * into the add-source flow are provider-agnostic. Naming one provider in
   * them tells a user looking for the other that the feature is not there.
   */
  describe("provider-agnostic inventory entry points", () => {
    it("titles nexus.inventory.addSource without naming a provider (\u2298 \"Add Inventory Source (NetBox)\" reads as NetBox-only to an EVE-NG user)", () => {
      const title = packageJson.contributes.commands.find((c) => c.command === "nexus.inventory.addSource")?.title;
      expect(title).toBe("Add Inventory Source");
    });

    it("offers the same neutral wording in the Command Center welcome view", () => {
      const welcome = packageJson.contributes.viewsWelcome?.find((w) => w.view === "nexusCommandCenter")?.contents ?? "";
      expect(welcome).toContain("[Add Inventory Source](command:nexus.inventory.addSource)");
      expect(welcome).not.toMatch(/NetBox/i);
    });
  });

  /**
   * EVE-NG (Phase 1) — the Settings tree's per-source rows. Without these
   * entries the rows render but carry no actions, which is most of the point
   * of showing them at all.
   */
  describe("inventory source row actions", () => {
    const rowMenus = () =>
      (packageJson.contributes.menus["view/item/context"] ?? []).filter(
        (m) => (m.when ?? "").includes("nexus.inventorySource") && (m.when ?? "").includes("nexusSettings")
      );

    it("binds Sync / Edit / Template Rules / Remove inline on an inventory source row (\u2298 rows with no actions leave every operation behind the QuickPick hub they replace)", () => {
      expect(rowMenus().map((m) => m.command).sort()).toEqual([
        "nexus.deviceTemplate.editRules",
        "nexus.inventory.editSource",
        "nexus.inventory.removeSource",
        "nexus.inventory.syncNow"
      ]);
    });

    it("puts them in the `inline` group so they render as row buttons rather than hiding in the right-click menu", () => {
      expect(rowMenus().every((m) => (m.group ?? "").startsWith("inline"))).toBe(true);
    });

    it("matches the row contextValue EXACTLY, so the group row and unrelated tree items never inherit these actions", () => {
      for (const menu of rowMenus()) {
        expect(menu.when).toContain("viewItem == nexus.inventorySource");
      }
      expect(rowMenus()).not.toHaveLength(0);
    });
  });

  /**
   * EVE-NG (Phase 1) — documentation coverage. The provider's two sharp edges
   * (telnet-only consoles, Community-certified) are things a user hits during
   * setup, not afterwards, so they have to be written down.
   */
  describe("EVE-NG documentation", () => {
    it("documents the EVE-NG source in the functional docs, including the telnet-console requirement and the Pro stance", () => {
      expect(functionalDocs).toContain("EVE-NG");
      expect(functionalDocs).toMatch(/consoleHost/);
      expect(functionalDocs).toMatch(/includeStopped/);
      expect(functionalDocs).toMatch(/Community/);
      expect(functionalDocs).toMatch(/preliminary/i);
    });

    it("mentions EVE-NG in the README as a second inventory source", () => {
      expect(readme).toMatch(/EVE-NG/);
    });

    it("does not tell the reader to run a command title that no longer exists (\u2298 docs pinned to \"Add Inventory Source (NetBox)\" send an EVE-NG user looking for a NetBox-only command)", () => {
      const staleTitle = "Add Inventory Source (NetBox)";
      expect(readme).not.toContain(staleTitle);
      expect(functionalDocs).not.toContain(staleTitle);
    });

    it("documents the Settings tree's per-source rows", () => {
      expect(functionalDocs).toMatch(/Inventory Sources/);
      expect(functionalDocs).toMatch(/nexus\.inventorySource/);
    });
  });

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
    // BMC gating (Phase 2) broadened the connected-server menus to also match the
    // .ipmi variant; node control (Phase 4) broadened them again to tolerate the
    // optional .eveRunning/.eveStopped group, so the assertion follows the new form.
    expect(menuItems.some((item) => item.when?.includes("/^nexus\\.serverConnected(\\.ipmi)?(\\.eveRunning|\\.eveStopped)?$/"))).toBe(true);
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
    expect(commands).toContain("nexus.localShell.add");
    expect(commands).toContain("nexus.localShell.connect");
    expect(commands).toContain("nexus.localShell.runWithScript");
    expect(commands).toContain("nexus.group.add");
    expect(commands).toContain("nexus.group.remove");
  });

  it("contributes profile quick action and placeholder diagnostic commands", () => {
    const commands = packageJson.contributes.commands.map((item) => item.command);
    expect(commands).toContain("nexus.profile.actions");
    expect(commands).toContain("nexus.server.testConnection");
    expect(commands).toContain("nexus.serial.testConnection");
  });

  it("surfaces test connection actions in the Command Center row menus", () => {
    const menuItems = packageJson.contributes.menus["view/item/context"] ?? [];
    expect(menuItems).toEqual(expect.arrayContaining([
      expect.objectContaining({
        command: "nexus.server.testConnection",
        when: "view == nexusCommandCenter && viewItem =~ /^nexus\\.server(\\.ipmi)?(\\.eveRunning|\\.eveStopped)?$/",
        group: "inline@2"
      }),
      expect.objectContaining({
        command: "nexus.server.testConnection",
        when: "view == nexusCommandCenter && viewItem =~ /^nexus\\.server(\\.ipmi)?(\\.eveRunning|\\.eveStopped)?$/",
        group: "0_connect@4"
      }),
      expect.objectContaining({
        command: "nexus.serial.testConnection",
        when: "view == nexusCommandCenter && viewItem =~ /^nexus\\.serialProfile(Waiting)?$/",
        group: "inline@2"
      }),
      expect.objectContaining({
        command: "nexus.serial.testConnection",
        when: "view == nexusCommandCenter && viewItem =~ /^nexus\\.serialProfile(Waiting)?$/",
        group: "0_connect@4"
      })
    ]));
  });

  it("does not show test connection for connected SSH or serial profiles", () => {
    const menuItems = packageJson.contributes.menus["view/item/context"] ?? [];
    const serverTestItems = menuItems.filter((item) => item.command === "nexus.server.testConnection");
    const serialTestItems = menuItems.filter((item) => item.command === "nexus.serial.testConnection");
    // No SSH test connection entry should reference nexus.serverConnected
    expect(serverTestItems.every((item) => !item.when?.includes("nexus.serverConnected"))).toBe(true);
    // No serial test connection entry should reference nexus.serialProfileConnected
    expect(serialTestItems.every((item) => !item.when?.includes("Connected"))).toBe(true);
  });

  it("contributes Local Shell Open and Run Script without adding a Test Connection action", () => {
    const commands = packageJson.contributes.commands.map((item) => item.command);
    expect(commands).toContain("nexus.localShell.runWithScript");
    expect(commands).not.toContain("nexus.localShell.testConnection");

    const menuItems = packageJson.contributes.menus["view/item/context"] ?? [];
    expect(menuItems).toEqual(expect.arrayContaining([
      expect.objectContaining({
        command: "nexus.localShell.runWithScript",
        when: "view == nexusCommandCenter && viewItem =~ /^nexus\\.localShellProfile(Connected)?$/",
        group: "0_connect@3"
      })
    ]));
    expect(menuItems.some((item) => item.command === "nexus.localShell.testConnection")).toBe(false);
  });

  it("hides the tree-only profile quick action command from the command palette", () => {
    const paletteMenu = packageJson.contributes.menus.commandPalette ?? [];
    const item = paletteMenu.find((entry) => entry.command === "nexus.profile.actions");
    expect(item).toBeDefined();
    expect(item?.when).toBe("false");
  });

  it("contributes settings.openPanel command", () => {
    const commands = packageJson.contributes.commands.map((item) => item.command);
    expect(commands).toContain("nexus.settings.openPanel");
  });

  it("contributes explicit macro keybinding repair command", () => {
    const commands = packageJson.contributes.commands.map((item) => item.command);
    expect(commands).toContain("nexus.settings.fixMacroKeybindings");
  });

  it("contributes macro.editor command", () => {
    const commands = packageJson.contributes.commands.map((item) => item.command);
    expect(commands).toContain("nexus.macro.editor");
  });

  it("contributes macro.addFromTemplate command", () => {
    const commands = packageJson.contributes.commands.map((item) => item.command);
    expect(commands).toContain("nexus.macro.addFromTemplate");
  });

  it("labels the blank macro command consistently with guided macro copy", () => {
    const command = packageJson.contributes.commands.find((item) => item.command === "nexus.macro.add");
    expect(command?.title).toBe("Add Blank Macro");
  });

  it("contributes macro.openDocs command for the command palette", () => {
    const command = packageJson.contributes.commands.find((item) => item.command === "nexus.macro.openDocs");
    expect(command).toBeDefined();
    expect(command?.title).toBe("Open Macro Guide");
    expect(command?.category).toBe("Nexus");
    expect(command?.icon).toBe("$(book)");

    const paletteMenu = packageJson.contributes.menus.commandPalette ?? [];
    const paletteOverride = paletteMenu.find((item) => item.command === "nexus.macro.openDocs");
    expect(paletteOverride?.when).not.toBe("false");
  });

  it("uses a plain Nexus-category title for macro JSON export", () => {
    const command = packageJson.contributes.commands.find((item) => item.command === "nexus.macro.copyAllAsJson");
    expect(command).toBeDefined();
    expect(command?.title).toBe("Copy All Macros as JSON");
    expect(command?.category).toBe("Nexus");
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

  it("does not include nexus.terminal.macros in configuration schema (migrated to globalState)", () => {
    const cfg = packageJson.contributes.configuration;
    // macros are now stored in context.globalState + SecretStorage; no longer in settings.json
    expect(cfg?.properties?.["nexus.terminal.macros"]).toBeUndefined();
    // sub-key settings that control auto-trigger behaviour must still be present
    expect(cfg?.properties?.["nexus.terminal.macros.autoTrigger"]).toBeDefined();
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

  it("uses guided welcome links for empty views", () => {
    const welcome = packageJson.contributes.viewsWelcome ?? [];
    const entry = (view: string) => {
      const found = welcome.find((item) => item.view === view);
      expect(found, `Expected welcome entry for ${view}`).toBeDefined();
      return found!.contents;
    };

    const hub = entry("nexusCommandCenter");
    expect(hub).toContain("command:nexus.profile.add");
    expect(hub).toContain("command:nexus.server.add");
    expect(hub).toContain("command:nexus.serial.add");
    expect(hub).toContain("command:nexus.localShell.add");
    expect(hub).toContain("command:nexus.serial.listPorts");

    const files = entry("nexusFileExplorer");
    expect(files).toMatch(/connected profile/i);
    expect(files).toContain("command:nexus.files.browse");

    expect(entry("nexusTunnels")).toContain("command:nexus.tunnel.add");

    const settings = entry("nexusSettings");
    expect(settings).toContain("command:nexus.settings.openPanel");
    expect(settings).toContain("command:nexus.config.export.backup");
    expect(settings).toContain("command:nexus.config.import");
    // Relabeled alongside the command's own retitle to "Import…" (was "Import Configuration").
    expect(settings).toContain("[Import…](command:nexus.config.import)");
  });

  it("links the unified importer — not the old inventory-only deep link — from the empty Command Center welcome view, second after Add Profile", () => {
    const welcome = packageJson.contributes.viewsWelcome ?? [];
    const hub = welcome.find((item) => item.view === "nexusCommandCenter");
    expect(hub?.contents).toContain("command:nexus.config.import");
    expect(hub?.contents).not.toContain("command:nexus.config.import.inventory");

    // Lead persona action (bulk import) sits right after the first add-profile link,
    // ahead of the per-type Add Server/Serial/Local Shell links.
    const contents = hub!.contents;
    const addProfileIdx = contents.indexOf("command:nexus.profile.add");
    const importIdx = contents.indexOf("command:nexus.config.import");
    const addServerIdx = contents.indexOf("command:nexus.server.add");
    expect(addProfileIdx).toBeGreaterThanOrEqual(0);
    expect(importIdx).toBeGreaterThan(addProfileIdx);
    expect(importIdx).toBeLessThan(addServerIdx);
  });

  it("surfaces the unified importer in the Command Center's overflow menu even once the tree isn't empty (issue #29)", () => {
    // viewsWelcome only renders while the tree is empty — a user who already has
    // servers and wants to add 200 more had no import affordance in the Hub at all.
    const titleMenuItems = packageJson.contributes.menus["view/title"] ?? [];
    const entry = titleMenuItems.find(
      (item) => item.command === "nexus.config.import" && item.when === "view == nexusCommandCenter"
    );
    expect(entry).toBeDefined();
    // Lands in the "..." overflow (non-navigation group), beside New Folder (1_manage@1).
    expect(entry?.group).toBe("1_manage@2");
  });

  it("retitles nexus.config.import to the universal chooser label", () => {
    const command = packageJson.contributes.commands.find((item) => item.command === "nexus.config.import");
    expect(command).toBeDefined();
    expect(command?.title).toBe("Import…");
    expect(command?.category).toBe("Nexus");
    expect((command as unknown as { icon?: string })?.icon).toBe("$(cloud-download)");
  });

  it("surfaces local shell actions without terminal-tab command contexts", () => {
    const menuItems = packageJson.contributes.menus["view/item/context"] ?? [];
    expect(menuItems).toEqual(expect.arrayContaining([
      expect.objectContaining({
        command: "nexus.localShell.connect",
        when: "view == nexusCommandCenter && viewItem =~ /^nexus\\.localShellProfile(Connected)?$/",
        group: "inline@1"
      }),
      expect.objectContaining({
        command: "nexus.localShell.edit",
        when: "view == nexusCommandCenter && viewItem =~ /^nexus\\.localShellProfile(Connected)?$/"
      })
    ]));
    const terminalTabCommands = ["nexus.terminal.reset", "nexus.terminal.clearScrollback", "nexus.terminal.copyAll"];
    for (const command of terminalTabCommands) {
      const items = menuItems.filter((item) => item.command === command);
      expect(items.every((item) => !item.when?.includes("localShell"))).toBe(true);
    }
  });

  it("links macro templates from the Macros welcome view", () => {
    const entry = packageJson.contributes.viewsWelcome?.find((item) => item.view === "nexusMacros");
    expect(entry?.contents).toContain("command:nexus.macro.add");
    expect(entry?.contents).toContain("command:nexus.macro.addFromTemplate");
  });

  it("links the macro guide from public docs and command references", () => {
    expect(readme).toContain("step-by-step setup, trigger scopes, cooldowns, intervals, and regex examples");
    expect(functionalDocs).toContain("step-by-step setup, trigger scopes, cooldowns, intervals, and regex examples");
    expect(functionalDocs).toContain("nexus.macro.openDocs");
  });

  it("orders Macros welcome links by guided setup path", () => {
    const entry = packageJson.contributes.viewsWelcome?.find((item) => item.view === "nexusMacros");
    expect(entry).toBeDefined();
    const contents = entry!.contents;

    expect(contents).toContain("command:nexus.macro.addFromTemplate");
    expect(contents).toContain("command:nexus.macro.add");
    expect(contents).toContain("command:nexus.macro.openDocs");
    expect(contents).toMatch(/starter/i);

    const templateIndex = contents.indexOf("command:nexus.macro.addFromTemplate");
    const blankIndex = contents.indexOf("[Add Blank Macro](command:nexus.macro.add)");
    const docsIndex = contents.indexOf("command:nexus.macro.openDocs");
    expect(templateIndex).toBeLessThan(blankIndex);
    expect(blankIndex).toBeLessThan(docsIndex);
  });

  it("adds ordered Macros title-bar actions for blank, template, and guide flows", () => {
    const titleMenuItems = packageJson.contributes.menus["view/title"] ?? [];
    const macroItems = titleMenuItems.filter((item) => item.when === "view == nexusMacros");
    expect(macroItems).toEqual(expect.arrayContaining([
      expect.objectContaining({ command: "nexus.macro.add", group: "navigation@1" }),
      expect.objectContaining({ command: "nexus.macro.addFromTemplate", group: "navigation@2" }),
      expect.objectContaining({ command: "nexus.macro.openDocs", group: "navigation@3" })
    ]));
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

  it("keeps Ctrl+Q terminal passthrough configurable", () => {
    const prop = packageJson.contributes.configuration?.properties?.["nexus.terminal.passthroughKeys"];
    expect(prop?.default).toContain("q");
    expect(prop?.items?.enum).toContain("q");

    const binding = packageJson.contributes.keybindings?.find((item) => item.key === "ctrl+q");
    expect(binding?.when).toContain("nexus.passthrough.ctrlQ");
  });

  describe("Scripts view contributions (S1/S2/S3/F3/P1)", () => {
    it("contributes a viewsWelcome entry for nexusScripts with New Script and docs actions", () => {
      const welcome = packageJson.contributes.viewsWelcome ?? [];
      const entry = welcome.find((w) => w.view === "nexusScripts");
      expect(entry).toBeDefined();
      expect(entry?.contents).toContain("command:nexus.script.new");
      expect(entry?.contents).toContain("command:nexus.script.openDocs");
      expect(entry?.contents).toContain("command:nexus.script.openExamples");
      expect(entry?.contents).toMatch(/templates/i);
      expect(entry?.contents).toMatch(/backup running config/i);
    });

    it("contributes a nexus.script.openDocs command", () => {
      const commands = packageJson.contributes.commands.map((item) => item.command);
      expect(commands).toContain("nexus.script.openDocs");
    });

    it("contributes a nexus.script.openExamples command", () => {
      const commands = packageJson.contributes.commands.map((item) => item.command);
      expect(commands).toContain("nexus.script.openExamples");
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

    it("adds scripts folder, docs, and examples buttons to the nexusScripts view title bar", () => {
      const titleMenuItems = packageJson.contributes.menus["view/title"] ?? [];
      const commands = titleMenuItems
        .filter((item) => item.when === "view == nexusScripts")
        .map((item) => item.command);
      expect(commands).toContain("nexus.script.openScriptsFolder");
      expect(commands).toContain("nexus.script.openDocs");
      expect(commands).toContain("nexus.script.openExamples");
    });

    it("adds run/stop/reveal/delete context menus for the nexusScripts view items", () => {
      const items = packageJson.contributes.menus["view/item/context"] ?? [];
      const scriptItems = items.filter((i) => i.when?.includes("view == nexusScripts"));
      const commands = scriptItems.map((i) => i.command);
      expect(commands).toContain("nexus.script.run");
      expect(commands).toContain("nexus.script.stop");
      expect(commands).toContain("nexus.script.revealInExplorer");
      expect(commands).toContain("nexus.script.delete");

      // Inline ▶ run is bound to runQuick so it auto-picks the focused terminal;
      // the context-menu "Run" entry keeps the explicit picker flow.
      const inlineRun = scriptItems.find(
        (i) => i.command === "nexus.script.runQuick" && i.group === "inline"
      );
      expect(inlineRun?.when).toContain("viewItem == nexus.script.file");

      // Inline stop appears on running items only
      const inlineStop = scriptItems.find(
        (i) => i.command === "nexus.script.stop" && i.group === "inline"
      );
      expect(inlineStop?.when).toContain("viewItem == nexus.script.running");
    });

    it("contributes seconds-facing script max runtime setting that allows disabling", () => {
      const prop = packageJson.contributes.configuration?.properties?.["nexus.scripts.maxRuntimeSeconds"];
      expect(prop).toBeDefined();
      expect(prop?.type).toBe("number");
      expect(prop?.default).toBe(1800);
      expect(prop?.minimum).toBe(0);
      expect(prop?.maximum).toBe(2147483);
      expect(prop?.markdownDescription || prop?.description).toMatch(/runtime/i);
      expect(prop?.markdownDescription || prop?.description).toMatch(/0 disables/i);
    });

    it("contributes seconds-facing default wait timeout and hides the legacy millisecond key", () => {
      const prop = packageJson.contributes.configuration?.properties?.["nexus.scripts.defaultTimeoutSeconds"];
      expect(prop).toBeDefined();
      expect(prop?.type).toBe("number");
      expect(prop?.default).toBe(30);
      expect(prop?.minimum).toBe(1);
      expect(prop?.markdownDescription || prop?.description).toMatch(/seconds/i);
      expect(packageJson.contributes.configuration?.properties?.["nexus.scripts.defaultTimeout"]).toBeUndefined();
    });

    it("contributes the configurable nexus.fs read cap with its documented bounds", () => {
      // ⊘ registering the setting with no bounds (or the wrong ones): VS Code's
      // settings UI would then offer values the resolver silently clamps away,
      // and the two would disagree about what is configurable.
      const prop = packageJson.contributes.configuration?.properties?.["nexus.scripts.maxReadSizeMb"];
      expect(prop).toBeDefined();
      expect(prop?.type).toBe("number");
      expect(prop?.default).toBe(4);
      expect(prop?.minimum).toBe(1);
      expect(prop?.maximum).toBe(16);
      const description = prop?.markdownDescription || prop?.description || "";
      expect(description).toMatch(/nexus\.fs\.readText/);
      expect(description).toMatch(/MiB|MB/);
      // The snapshot-at-run-start semantics are load-bearing for users: a
      // change made while a script is running does not apply to it.
      expect(description).toMatch(/start/i);
    });

    it("keeps legacy maxRuntimeMs compatible and allows 0", () => {
      const prop = packageJson.contributes.configuration?.properties?.["nexus.scripts.maxRuntimeMs"];
      expect(prop).toBeDefined();
      expect(prop?.minimum).toBe(0);
      expect(prop?.maximum).toBe(2147483647);
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

  describe("terminal tab commands (feature 002)", () => {
    const terminalCommands = packageJson.contributes.commands.filter((c) =>
      ["nexus.terminal.reset", "nexus.terminal.clearScrollback", "nexus.terminal.copyAll"].includes(c.command)
    );
    const titleMenu = packageJson.contributes.menus["terminal/title/context"] ?? [];
    const paletteMenu = packageJson.contributes.menus.commandPalette ?? [];
    const bodyMenu = packageJson.contributes.menus["terminal/context"] ?? [];
    const editorTitleMenu = packageJson.contributes.menus["editor/title/context"] ?? [];

    it("bumps extension version to at least 2.8.9", () => {
      const parts = ((packageJson as unknown as { version: string }).version ?? "0.0.0")
        .split(".")
        .map((x) => Number(x));
      const [maj, min, pat] = parts;
      const atLeast = maj > 2 || (maj === 2 && min > 8) || (maj === 2 && min === 8 && pat >= 9);
      expect(atLeast).toBe(true);
    });

    it("exposes nexus.terminal.reset with correct title, category, and enablement", () => {
      const cmd = terminalCommands.find((c) => c.command === "nexus.terminal.reset");
      expect(cmd).toBeDefined();
      expect(cmd?.title).toMatch(/reset terminal/i);
      expect((cmd as unknown as { category?: string }).category).toBe("Nexus");
      expect(cmd?.enablement).toBe("nexus.isNexusTerminalConnected");
    });

    it("exposes nexus.terminal.clearScrollback with enablement on connected-terminal key", () => {
      const cmd = terminalCommands.find((c) => c.command === "nexus.terminal.clearScrollback");
      expect(cmd).toBeDefined();
      expect(cmd?.title).toMatch(/clear scrollback/i);
      expect((cmd as unknown as { category?: string }).category).toBe("Nexus");
      expect(cmd?.enablement).toBe("nexus.isNexusTerminalConnected");
    });

    it("exposes nexus.terminal.copyAll enabled on any Nexus terminal (even disconnected)", () => {
      const cmd = terminalCommands.find((c) => c.command === "nexus.terminal.copyAll");
      expect(cmd).toBeDefined();
      expect(cmd?.title).toMatch(/copy all/i);
      expect((cmd as unknown as { category?: string }).category).toBe("Nexus");
      expect(cmd?.enablement).toBe("nexus.isNexusTerminal");
    });

    it("contributes terminal/title/context entries grouped nexus@1..3 in the correct order", () => {
      const byCmd = (id: string) => titleMenu.find((m) => m.command === id);
      const reset = byCmd("nexus.terminal.reset");
      const clear = byCmd("nexus.terminal.clearScrollback");
      const copy = byCmd("nexus.terminal.copyAll");
      expect(reset?.group).toBe("nexus@1");
      expect(clear?.group).toBe("nexus@2");
      expect(copy?.group).toBe("nexus@3");
      for (const m of [reset, clear, copy]) {
        expect(m?.when).toBeUndefined();
      }
    });

    it("contributes commandPalette entries gated on nexus.isNexusTerminal", () => {
      const ids = paletteMenu
        .filter((m) => typeof m.command === "string" && m.command.startsWith("nexus.terminal."))
        .map((m) => m.command);
      expect(ids).toContain("nexus.terminal.reset");
      expect(ids).toContain("nexus.terminal.clearScrollback");
      expect(ids).toContain("nexus.terminal.copyAll");
      const gated = paletteMenu.filter((m) => m.command?.startsWith("nexus.terminal."));
      for (const m of gated) {
        expect(m.when).toBe("nexus.isNexusTerminal");
      }
    });

    it("does NOT contribute terminal/context entries for these commands", () => {
      const bodyHits = bodyMenu.filter((m) => m.command?.startsWith("nexus.terminal."));
      expect(bodyHits).toEqual([]);
    });

    it("contributes editor/title/context entries for editor-tab right-click with vscode-terminal scheme gate", () => {
      const byCmd = (id: string) => editorTitleMenu.find((m) => m.command === id);
      const reset = byCmd("nexus.terminal.reset");
      const clear = byCmd("nexus.terminal.clearScrollback");
      const copy = byCmd("nexus.terminal.copyAll");
      expect(reset?.group).toBe("nexus@1");
      expect(clear?.group).toBe("nexus@2");
      expect(copy?.group).toBe("nexus@3");
      for (const m of [reset, clear, copy]) {
        expect(m?.when).toBe("resourceScheme == 'vscode-terminal'");
      }
    });
  });

  describe("direct BMC commands (issue #48 §3.6)", () => {
    const ids = ["nexus.server.connectBmcSol", "nexus.server.openBmcWebConsole"];

    it("contributes both as palette-invocable Nexus commands", () => {
      for (const id of ids) {
        const command = packageJson.contributes.commands.find((item) => item.command === id);
        expect(command, id).toBeDefined();
        expect(command!.category).toBe("Nexus");
        expect(command!.title).toBeTruthy();
      }
    });

    // BMC-menu gating (task #27, Phase 2) — the two BMC entries now require the
    // `.ipmi` contextValue marker, so they show ONLY on a server that actually
    // has an ipmiHost. Every OTHER server menu was broadened with an optional
    // `(\.ipmi)?` so a BMC server keeps all its ordinary actions.
    function viewItemRegex(when?: string): RegExp | null {
      const m = /viewItem =~ \/(.+?)\/(?=\s|$)/.exec(when ?? "");
      return m ? new RegExp(m[1]) : null;
    }

    it("gates both BMC entries on the .ipmi marker: shown for a server WITH ipmiHost, hidden for one without (⊘ offering BMC on a server with no ipmiHost is an action that can only fail)", () => {
      const menuItems = packageJson.contributes.menus["view/item/context"] ?? [];
      for (const id of ids) {
        const entry = menuItems.find((item) => item.command === id);
        expect(entry, id).toBeDefined();
        expect(entry!.group).toMatch(/^0_connect@/);
        const re = viewItemRegex(entry!.when);
        expect(re, id).not.toBeNull();
        // The .ipmi variants match; the plain (no-BMC) contextValues do not.
        expect(re!.test("nexus.server.ipmi"), id).toBe(true);
        expect(re!.test("nexus.serverConnected.ipmi"), id).toBe(true);
        expect(re!.test("nexus.server"), id).toBe(false);
        expect(re!.test("nexus.serverConnected"), id).toBe(false);
      }
    });

    // P2-4 — AFFIRMATIVE per-entry table. For every server-scoped
    // view/item/context entry, assert EXACTLY which of the four server
    // contextValues it must and must-not match, driven off the real package.json.
    // This kills the dangerous over-narrowing the one-directional check let
    // through: shrinking nexus.server.edit to `.ipmi`-only (hiding Edit on every
    // normal server) fails here, as does reverting any broadened entry to a
    // base-only regex or dropping `.ipmi` off a BMC entry.
    it("matches exactly the intended subset of {server, serverConnected, .ipmi, .eve* variants} for each server menu, and never a non-server contextValue (M10 + the #83/#28 hazard die)", () => {
      // NODE CONTROL (task #28) — the four base contextValues plus every EVE
      // node-control variant `nexus.server[Connected][.ipmi][.eveRunning|.eveStopped]`.
      // Broadening the ~20 anchored server-menu regexes to TOLERATE the optional
      // eve group is load-bearing: without it an EVE node (whose contextValue now
      // carries the marker) loses EVERY context action — the exact #83 failure
      // mode. This affirmative both-directions table is what pins it: a regex that
      // fails to match a value its command must offer, OR matches one it must not,
      // fails here.
      const BASE = ["nexus.server", "nexus.serverConnected", "nexus.server.ipmi", "nexus.serverConnected.ipmi"];
      const EVE = [
        "nexus.server.eveRunning", "nexus.server.eveStopped",
        "nexus.serverConnected.eveRunning", "nexus.serverConnected.eveStopped",
        "nexus.server.ipmi.eveRunning", "nexus.server.ipmi.eveStopped",
        "nexus.serverConnected.ipmi.eveRunning", "nexus.serverConnected.ipmi.eveStopped"
      ];
      const SERVER_VALUES = [...BASE, ...EVE];

      // Intent-driven category predicates — deliberately NOT the regexes under
      // test, so a regex mutated to agree with itself still fails the table.
      const DISCONNECTED = SERVER_VALUES.filter((v) => !v.includes("Connected"));
      const CONNECTED = SERVER_VALUES.filter((v) => v.includes("Connected"));
      const IPMI_ONLY = SERVER_VALUES.filter((v) => v.includes(".ipmi"));
      const ALL = SERVER_VALUES;
      const EVE_STOPPED = SERVER_VALUES.filter((v) => v.endsWith(".eveStopped"));
      const EVE_RUNNING = SERVER_VALUES.filter((v) => v.endsWith(".eveRunning"));

      // Sanity on the fixtures themselves: the eve variants must actually widen
      // each category (a table that silently lost them would be vacuous).
      expect(DISCONNECTED).toHaveLength(6);
      expect(CONNECTED).toHaveLength(6);
      expect(IPMI_ONLY).toHaveLength(6);
      expect(EVE_STOPPED).toEqual([
        "nexus.server.eveStopped", "nexus.serverConnected.eveStopped",
        "nexus.server.ipmi.eveStopped", "nexus.serverConnected.ipmi.eveStopped"
      ]);
      expect(EVE_RUNNING).toHaveLength(4);

      const NON_SERVER = [
        "nexus.folder", "nexus.folderWithServers", "nexus.macro", "nexus.serialProfile",
        "nexus.serialProfileConnected", "nexus.inventorySource", "nexus.sessionNode",
        "nexus.localShellProfile", "nexus.localShellProfileConnected",
        // near-misses that the `$` anchor must reject
        "nexus.serverFoo", "nexus.server.ipmi.extra", "nexus.serverConnectedX",
        // eve near-misses — the optional group must be EXACT and stay in order
        "nexus.server.eve", "nexus.server.eveRunningX", "nexus.server.eveStopped.extra",
        "nexus.serverConnected.ipmi.eveStopped.extra",
        // eve BEFORE ipmi is the wrong order — the fixed composition must reject it
        "nexus.server.eveStopped.ipmi"
      ];

      // command|group → the contextValues that entry MUST match (and only those).
      const EXPECTED: Record<string, string[]> = {
        "nexus.server.connect|inline": DISCONNECTED,
        "nexus.server.testConnection|inline@2": DISCONNECTED,
        "nexus.server.connect|inline@1": CONNECTED,
        "nexus.server.disconnect|inline@2": CONNECTED,
        "nexus.server.connect|0_connect": DISCONNECTED,
        "nexus.server.runWithScript|0_connect@3": ALL,
        "nexus.server.runMacro|0_connect@5": ALL,
        "nexus.server.connectBmcSol|0_connect@6": IPMI_ONLY,
        "nexus.server.openBmcWebConsole|0_connect@7": IPMI_ONLY,
        "nexus.inventory.startNode|0_connect@8": EVE_STOPPED,
        "nexus.inventory.stopNode|0_connect@9": EVE_RUNNING,
        "nexus.server.testConnection|0_connect@4": DISCONNECTED,
        "nexus.server.connect|0_connect@1": CONNECTED,
        "nexus.server.disconnect|0_connect@2": CONNECTED,
        "nexus.server.edit|1_manage@1": ALL,
        "nexus.server.rename|1_manage@2": ALL,
        "nexus.server.duplicate|1_manage@3": ALL,
        "nexus.files.browse|1_manage@4": CONNECTED,
        "nexus.server.deployKey|1_manage@5": ALL,
        "nexus.authProfile.applyToServer|1_manage@6": ALL,
        "nexus.server.copyInfo|2_clipboard": ALL,
        "nexus.server.remove|3_destructive": ALL
      };

      const menuItems = packageJson.contributes.menus["view/item/context"] ?? [];
      // Every Command Center view/item/context entry whose viewItem clause targets
      // a server contextValue (regex form — after Phase 2 no server menu uses `==`).
      const serverMenus = menuItems.filter(
        (m) => (m.when ?? "").includes("nexusCommandCenter") && (m.when ?? "").includes("viewItem =~ /^nexus\\.server")
      );

      // No server menu may still pin an exact `== nexus.server[...]` (would miss .ipmi).
      expect(menuItems.filter((m) => (m.when ?? "").includes("viewItem == nexus.server")).map((m) => m.command)).toEqual([]);

      // The set of entries present must be EXACTLY the table's keys — a newly
      // added server menu on the wrong form, or a missing one, fails here.
      const presentKeys = serverMenus.map((m) => `${m.command}|${m.group}`).sort();
      expect(presentKeys).toEqual(Object.keys(EXPECTED).sort());

      for (const m of serverMenus) {
        const key = `${m.command}|${m.group}`;
        const expected = EXPECTED[key];
        const re = viewItemRegex(m.when);
        expect(re, key).not.toBeNull();
        for (const value of SERVER_VALUES) {
          expect(re!.test(value), `${key} vs ${value}`).toBe(expected.includes(value));
        }
        for (const value of NON_SERVER) {
          expect(re!.test(value), `${key} must not match ${value}`).toBe(false);
        }
      }
    });
  });

  describe("Live lab status (Phase 2)", () => {
    it("contributes nexus.inventory.refreshStatus as a palette-invocable Nexus command", () => {
      const command = packageJson.contributes.commands.find((item) => item.command === "nexus.inventory.refreshStatus");
      expect(command).toBeDefined();
      expect(command?.category).toBe("Nexus");
      expect(command?.title).toBeTruthy();

      const paletteMenu = packageJson.contributes.menus.commandPalette ?? [];
      const paletteEntry = paletteMenu.find((item) => item.command === "nexus.inventory.refreshStatus");
      expect(paletteEntry).toBeDefined();
      expect(paletteEntry?.when).not.toBe("false");
    });

    it("surfaces Refresh Lab Status as a Command Center title action (least-intrusive tree affordance)", () => {
      const titleMenuItems = packageJson.contributes.menus["view/title"] ?? [];
      const entry = titleMenuItems.find(
        (item) => item.command === "nexus.inventory.refreshStatus" && item.when === "view == nexusCommandCenter"
      );
      expect(entry).toBeDefined();
    });

    it("does NOT add refreshStatus to the inventory-source row inline group, keeping those rows' four actions intact", () => {
      const rowMenus = (packageJson.contributes.menus["view/item/context"] ?? []).filter(
        (m) => (m.when ?? "").includes("nexus.inventorySource") && (m.when ?? "").includes("nexusSettings")
      );
      expect(rowMenus.map((m) => m.command)).not.toContain("nexus.inventory.refreshStatus");
    });

    it("contributes nexus.inventory.statusPollSeconds as an integer setting defaulting to 0 (off), bounded 0..3600", () => {
      // ⊘ registering it only in SETTINGS_META: VS Code's settings.json UI would
      // not know the key, and the poll timer in extension.ts reads it via
      // workspace.getConfiguration — an unregistered key returns undefined and the
      // poll never arms.
      const prop = packageJson.contributes.configuration?.properties?.["nexus.inventory.statusPollSeconds"];
      expect(prop).toBeDefined();
      expect(prop?.type).toBe("integer");
      expect(prop?.default).toBe(0);
      expect(prop?.minimum).toBe(0);
      expect(prop?.maximum).toBe(3600);
      const description = prop?.markdownDescription || prop?.description || "";
      expect(description).toMatch(/0 disables|0 = off|disables/i);
    });

    it("documents the live-status feature, the poll setting, and the BMC-menu gating in the functional docs and README", () => {
      expect(functionalDocs).toContain("nexus.inventory.statusPollSeconds");
      expect(functionalDocs).toMatch(/Refresh Lab Status/);
      expect(functionalDocs).toMatch(/Live lab status/i);
      // BMC-menu gating note.
      expect(functionalDocs).toMatch(/ipmiHost/);
      expect(functionalDocs).toMatch(/connectBmcSol|BMC menu gating/);
      expect(readme).toMatch(/Refresh Lab Status/);
    });
  });

  it("contributes nexus.config.import.inventory as a palette-invocable Nexus command", () => {
    const command = packageJson.contributes.commands.find((item) => item.command === "nexus.config.import.inventory");
    expect(command).toBeDefined();
    expect(command?.title).toBe("Import Servers from List (CSV/Text)");
    expect(command?.category).toBe("Nexus");

    const paletteMenu = packageJson.contributes.menus.commandPalette ?? [];
    const paletteEntry = paletteMenu.find((item) => item.command === "nexus.config.import.inventory");
    expect(paletteEntry?.when).not.toBe("false");
  });

  // The Settings-tree link is a broken button unless the command it points at
  // is BOTH declared here and registered; this covers the declaration half
  // (registration is covered by inventoryCommands.test.ts's hub tests, and the
  // web-extension stub by webExtensionCommands.test.ts).
  it("contributes nexus.inventory.manage as a palette-invocable Nexus command", () => {
    const command = packageJson.contributes.commands.find((item) => item.command === "nexus.inventory.manage");
    expect(command).toBeDefined();
    expect(command?.title).toBe("Manage Inventory Sources");
    expect(command?.category).toBe("Nexus");

    const paletteMenu = packageJson.contributes.menus.commandPalette ?? [];
    const paletteEntry = paletteMenu.find((item) => item.command === "nexus.inventory.manage");
    expect(paletteEntry).toBeDefined();
    expect(paletteEntry?.when).toBe("true");
  });

  describe("Edit as Root (nexus.files.editAsRoot)", () => {
    it("contributes the command with a Nexus category and shield icon", () => {
      const cmd = packageJson.contributes.commands.find((c) => c.command === "nexus.files.editAsRoot");
      expect(cmd).toBeDefined();
      expect(cmd?.title).toMatch(/edit as root/i);
      expect(cmd?.category).toBe("Nexus");
      expect((cmd as unknown as { icon?: string })?.icon).toBe("$(shield)");
    });

    it("binds a view/item/context entry scoped to file (not directory) items", () => {
      const menuItems = packageJson.contributes.menus["view/item/context"] ?? [];
      const entry = menuItems.find((m) => m.command === "nexus.files.editAsRoot");
      expect(entry).toBeDefined();
      expect(entry?.when).toBe("view == nexusFileExplorer && viewItem == nexus.fileExplorer.file");
    });

    it("enables the command from the command palette only when a nexterm:// file is the active editor (P6a)", () => {
      const paletteItems = packageJson.contributes.menus.commandPalette ?? [];
      const entry = paletteItems.find((m) => m.command === "nexus.files.editAsRoot");
      expect(entry).toBeDefined();
      expect(entry?.when).toBe("resourceScheme == nexterm");
    });

    it("contributes the two nexus.sftp.sudo.* settings with distinct order values", () => {
      const props = packageJson.contributes.configuration?.properties ?? {};
      expect(props["nexus.sftp.sudo.enabled"]).toMatchObject({ type: "boolean", default: true });
      expect(props["nexus.sftp.sudo.rememberPasswordForSession"]).toMatchObject({ type: "boolean", default: false });
      const enabledOrder = props["nexus.sftp.sudo.enabled"].order;
      const rememberOrder = props["nexus.sftp.sudo.rememberPasswordForSession"].order;
      expect(enabledOrder).not.toBe(rememberOrder);
    });

    it("does not overstate what rememberPasswordForSession does, and stays in sync with the Settings UI copy (P7)", async () => {
      const props = packageJson.contributes.configuration?.properties ?? {};
      const description: string = props["nexus.sftp.sudo.rememberPasswordForSession"].description;

      // Not "for the duration of the session" — it's cleared earlier, on disconnect
      // or window close.
      expect(description).toMatch(/disconnects or the window closes/i);
      // Turning it off does not mean "prompted every time" — sudo's own credential
      // timestamp can still skip the prompt.
      expect(description).toMatch(/does not guarantee a prompt/i);

      const { SETTINGS_META } = await import("../../src/ui/settingsMetadata");
      const meta = SETTINGS_META.find((m) => m.section === "nexus.sftp" && m.key === "sudo.rememberPasswordForSession");
      expect(meta?.description).toBe(description);
    });
  });

  describe("Directory Sync (Follow Terminal Directory, issue #35 Phase 1)", () => {
    const followCommands = [
      "nexus.files.followTerminal",
      "nexus.files.unfollowTerminal",
      "nexus.files.resumeFollowTerminal",
      "nexus.files.syncFromTerminal"
    ];

    it("contributes all four commands with the expected titles and icons", () => {
      const byId = (id: string) => packageJson.contributes.commands.find((c) => c.command === id);
      expect(byId("nexus.files.followTerminal")).toMatchObject({ title: "Follow Terminal Directory", icon: "$(link)" });
      expect(byId("nexus.files.unfollowTerminal")).toMatchObject({
        title: "Stop Following Terminal Directory",
        icon: "$(circle-slash)"
      });
      expect(byId("nexus.files.resumeFollowTerminal")).toMatchObject({
        title: "Resume Following Terminal Directory",
        icon: "$(pinned)"
      });
      expect(byId("nexus.files.syncFromTerminal")).toMatchObject({
        title: "Go to Terminal Directory",
        icon: "$(arrow-circle-down)"
      });
    });

    it("gates nexus.files.syncFromTerminal's enablement on a connected Nexus terminal", () => {
      const cmd = packageJson.contributes.commands.find((c) => c.command === "nexus.files.syncFromTerminal");
      expect(cmd?.enablement).toBe("nexus.isNexusTerminalConnected");
    });

    it("puts exactly the three toggle commands inline at navigation@1 in the File Explorer title bar, with mutually exclusive when-clauses", () => {
      const titleMenuItems = packageJson.contributes.menus["view/title"] ?? [];
      const fileExplorerNav1 = titleMenuItems.filter(
        (item) => item.when?.startsWith("view == nexusFileExplorer") && item.group === "navigation@1"
      );
      const byCmd = (id: string) => fileExplorerNav1.find((i) => i.command === id);
      expect(fileExplorerNav1.map((i) => i.command).sort()).toEqual([
        "nexus.files.followTerminal",
        "nexus.files.resumeFollowTerminal",
        "nexus.files.unfollowTerminal"
      ]);
      expect(byCmd("nexus.files.followTerminal")?.when).toBe("view == nexusFileExplorer && !nexus.files.followingTerminal");
      expect(byCmd("nexus.files.unfollowTerminal")?.when).toBe(
        "view == nexusFileExplorer && nexus.files.followingTerminal && !nexus.files.followPaused"
      );
      expect(byCmd("nexus.files.resumeFollowTerminal")?.when).toBe("view == nexusFileExplorer && nexus.files.followPaused");
    });

    it("demotes createFile, createDir, and disconnect out of navigation, leaving 6 inline navigation slots", () => {
      const titleMenuItems = packageJson.contributes.menus["view/title"] ?? [];
      const fileExplorerNav = titleMenuItems.filter(
        (item) => item.when?.startsWith("view == nexusFileExplorer") && item.group?.startsWith("navigation")
      );
      const navCommands = fileExplorerNav.map((item) => item.command);
      expect(navCommands).not.toContain("nexus.files.createFile");
      expect(navCommands).not.toContain("nexus.files.createDir");
      expect(navCommands).not.toContain("nexus.files.disconnect");
      expect(new Set(fileExplorerNav.map((item) => item.group)).size).toBe(6);

      const secondary = titleMenuItems.filter(
        (item) => item.when === "view == nexusFileExplorer" && !item.group?.startsWith("navigation")
      );
      expect(secondary.map((item) => item.command).sort()).toEqual([
        "nexus.files.createDir",
        "nexus.files.createFile",
        "nexus.files.disconnect",
        "nexus.files.syncFromTerminal"
      ]);
    });

    it("places Go to Terminal Directory in its own secondary title group (1_sync@1)", () => {
      const titleMenuItems = packageJson.contributes.menus["view/title"] ?? [];
      const entry = titleMenuItems.find(
        (item) => item.command === "nexus.files.syncFromTerminal" && item.when === "view == nexusFileExplorer"
      );
      expect(entry?.group).toBe("1_sync@1");
    });

    it("adds the four sync entries to the '.' row context menu, gated on the currentDir contextValue", () => {
      const menuItems = packageJson.contributes.menus["view/item/context"] ?? [];
      const currentDirItems = menuItems.filter((item) => item.when?.includes("nexus.fileExplorer.currentDir"));
      expect(currentDirItems.map((item) => item.command).sort()).toEqual(followCommands.slice().sort());

      const byCmd = (id: string) => currentDirItems.find((item) => item.command === id);
      expect(byCmd("nexus.files.syncFromTerminal")?.when).toBe(
        "view == nexusFileExplorer && viewItem == nexus.fileExplorer.currentDir"
      );
      expect(byCmd("nexus.files.followTerminal")?.when).toBe(
        "view == nexusFileExplorer && viewItem == nexus.fileExplorer.currentDir && !nexus.files.followingTerminal"
      );
      expect(byCmd("nexus.files.unfollowTerminal")?.when).toBe(
        "view == nexusFileExplorer && viewItem == nexus.fileExplorer.currentDir && nexus.files.followingTerminal && !nexus.files.followPaused"
      );
      expect(byCmd("nexus.files.resumeFollowTerminal")?.when).toBe(
        "view == nexusFileExplorer && viewItem == nexus.fileExplorer.currentDir && nexus.files.followPaused"
      );
    });

    it("adds nexus.files.syncFromTerminal as nexus@4 to both terminal/title/context and editor/title/context", () => {
      const terminalTitleMenu = packageJson.contributes.menus["terminal/title/context"] ?? [];
      const editorTitleMenu = packageJson.contributes.menus["editor/title/context"] ?? [];

      const terminalEntry = terminalTitleMenu.find((item) => item.command === "nexus.files.syncFromTerminal");
      expect(terminalEntry?.group).toBe("nexus@4");
      expect(terminalEntry?.when).toBeUndefined();

      const editorEntry = editorTitleMenu.find((item) => item.command === "nexus.files.syncFromTerminal");
      expect(editorEntry?.group).toBe("nexus@4");
      expect(editorEntry?.when).toBe("resourceScheme == 'vscode-terminal'");
    });

    it("contributes an explicit commandPalette when-clause per command, gating the three toggles on the same context keys", () => {
      const paletteMenu = packageJson.contributes.menus.commandPalette ?? [];
      const byCmd = (id: string) => paletteMenu.find((item) => item.command === id);

      for (const id of followCommands) {
        expect(byCmd(id)?.when).toBeDefined();
      }
      expect(byCmd("nexus.files.followTerminal")?.when).toBe("!nexus.files.followingTerminal");
      expect(byCmd("nexus.files.unfollowTerminal")?.when).toBe("nexus.files.followingTerminal && !nexus.files.followPaused");
      expect(byCmd("nexus.files.resumeFollowTerminal")?.when).toBe("nexus.files.followPaused");
    });
  });
});

describe("terminal output performance defaults", () => {
  const props = packageJson.contributes.configuration?.properties ?? {};

  describe("nexus.logging.terminalOutputTrace", () => {
    it("is contributed as a boolean that defaults to off", () => {
      expect(props["nexus.logging.terminalOutputTrace"]).toMatchObject({
        type: "boolean",
        default: false
      });
    });

    it("tells the user why it is off — the cost and the plaintext session data", () => {
      const description: string = props["nexus.logging.terminalOutputTrace"].markdownDescription;
      expect(description).toMatch(/troubleshooting only/i);
      expect(description).toMatch(/plaintext/i);
      expect(description).toMatch(/password/i);
    });

    it("is exposed in the Settings UI and documented", async () => {
      const { SETTINGS_META } = await import("../../src/ui/settingsMetadata");
      const meta = SETTINGS_META.find(
        (item) => item.section === "nexus.logging" && item.key === "terminalOutputTrace"
      );
      expect(meta).toBeDefined();
      expect(meta?.default).toBe(false);
      expect(readme).toContain("nexus.logging.terminalOutputTrace");
      expect(functionalDocs).toContain("nexus.logging.terminalOutputTrace");
    });
  });

  describe("nexus.terminal.highlighting.rules defaults", () => {
    const defaultRules = (props["nexus.terminal.highlighting.rules"].default ?? []) as Array<{
      pattern: string;
      color: string;
      flags?: string;
      label?: string;
      description?: string;
      enabled?: boolean;
    }>;

    // Enabled-only view — mirrors what TerminalHighlighter.reload() actually
    // compiles (it skips rule.enabled === false before compiling). Using this
    // for the "still off by default" assertions means the test fails if
    // someone flips IPv6/UUID back to enabled by accident.
    function highlights(sample: string): boolean {
      return defaultRules
        .filter((rule) => rule.enabled !== false)
        .some((rule) => new RegExp(rule.pattern, rule.flags ?? "gi").test(sample));
    }

    // Includes disabled rules — used to prove the shipped-but-off patterns
    // still actually work, not merely that they're inert.
    function highlightsIncludingDisabled(sample: string): boolean {
      return defaultRules.some((rule) => new RegExp(rule.pattern, rule.flags ?? "gi").test(sample));
    }

    it("ships the IPv6 and UUID rules disabled by default — the two most expensive patterns", () => {
      // Located by label, not by a fragment of the regex: the IPv6 pattern was
      // rewritten in v2.8.187 to stop truncating compressed addresses, and a
      // structural finder silently returned undefined (making every assertion
      // below vacuous) rather than failing loudly.
      const ipv6Rule = defaultRules.find((rule) => rule.label === "IPv6 addresses");
      const uuidRule = defaultRules.find((rule) => rule.label === "UUIDs");
      expect(ipv6Rule).toBeDefined();
      expect(uuidRule).toBeDefined();
      expect(ipv6Rule?.enabled).toBe(false);
      expect(uuidRule?.enabled).toBe(false);

      // Enabled-only view (what actually compiles): both stay dark.
      expect(highlights("2001:0db8:85a3:0000:0000:8a2e:0370:7334")).toBe(false);
      expect(highlights("3f2504e0-4f89-11d3-9a0c-0305e82c3301")).toBe(false);

      // Including the disabled rules: both patterns still actually match —
      // guards against shipping a broken pattern behind the disabled flag.
      expect(highlightsIncludingDisabled("2001:0db8:85a3:0000:0000:8a2e:0370:7334")).toBe(true);
      expect(highlightsIncludingDisabled("3f2504e0-4f89-11d3-9a0c-0305e82c3301")).toBe(true);
    });

    describe("IPv6 pattern coverage (trailing compression, PR #72)", () => {
      const ipv6Rule = defaultRules.find((rule) => rule.label === "IPv6 addresses")!;

      it("is defined", () => {
        expect(ipv6Rule).toBeDefined();
      });

      it("matches addresses whose compression reaches the end (fe80::, 2001:db8::), plus ::1 and a full form", () => {
        // Fails against the old three-alternative pattern — every alternative
        // there requires a hex group after the final "::", so a trailing-
        // compressed address like "fe80::" or "2001:db8::" matched nothing.
        expect(highlightsIncludingDisabled("fe80::")).toBe(true);
        expect(highlightsIncludingDisabled("2001:db8::")).toBe(true);
        expect(highlightsIncludingDisabled("::1")).toBe(true);
        expect(highlightsIncludingDisabled("2001:0db8:85a3:0000:0000:8a2e:0370:7334")).toBe(true);
      });

      it("matches a mixed compressed+trailing address (2001:db8::1) in full, not truncated at the ::", () => {
        // The trailing-compression alternative is LAST in the alternation, so a
        // complete form like "2001:db8::1" must still be consumed whole by an
        // earlier alternative rather than stopping short at "2001:db8::".
        const re = new RegExp(ipv6Rule.pattern, ipv6Rule.flags ?? "g");
        const match = re.exec("2001:db8::1");
        expect(match).not.toBeNull();
        expect(match![0]).toBe("2001:db8::1");
      });

      it("matches multi-hextet compressed addresses whole (v2.8.187 truncation fix)", () => {
        // Both historical patterns allowed exactly ONE hextet after "::", so
        // this address highlighted as "fe80::b3ff". The full matrix lives in
        // highlightIpv6Default.test.ts; this row keeps the defaults suite
        // honest about the bug the pattern was rewritten for.
        const re = new RegExp(ipv6Rule.pattern, ipv6Rule.flags ?? "g");
        expect(re.exec("fe80::b3ff:fe1e:8329")?.[0]).toBe("fe80::b3ff:fe1e:8329");
      });

      it("does NOT match the bare all-zeros :: (a C++/Ruby scope operator in real terminal output) or std::map", () => {
        expect(highlightsIncludingDisabled("::")).toBe(false);
        expect(highlightsIncludingDisabled("std::map")).toBe(false);
      });

      it("stays dark in the enabled-only view for every positive IPv6 sample (rule ships disabled)", () => {
        for (const sample of ["fe80::", "2001:db8::", "::1", "2001:0db8:85a3:0000:0000:8a2e:0370:7334", "2001:db8::1"]) {
          expect(highlights(sample), sample).toBe(false);
        }
      });
    });

    it("keeps every other default rule, including IPv4 and MAC addresses", () => {
      expect(highlights("10.0.0.1")).toBe(true);
      expect(highlights("aa:bb:cc:dd:ee:ff")).toBe(true);
      expect(highlights("ERROR")).toBe(true);
      expect(highlights("https://example.com")).toBe(true);
    });

    it("gives every default rule a non-empty label and description within the length caps", () => {
      expect(defaultRules.length).toBeGreaterThan(0);
      for (const rule of defaultRules) {
        expect(rule.label, `label for pattern ${rule.pattern}`).toBeTruthy();
        expect(rule.label!.length).toBeGreaterThan(0);
        expect(rule.label!.length).toBeLessThanOrEqual(100);
        expect(rule.description, `description for pattern ${rule.pattern}`).toBeTruthy();
        expect(rule.description!.length).toBeGreaterThan(0);
        expect(rule.description!.length).toBeLessThanOrEqual(500);
      }
    });

    it("tells the user the IPv6 and UUID rules ship disabled, without instructing users to paste the regex", () => {
      const description: string = props["nexus.terminal.highlighting.rules"].markdownDescription;
      expect(description).toMatch(/IPv6/);
      expect(description).toMatch(/UUID/);
      expect(description).toMatch(/disabled/i);
      // The old copy told users to paste this literal UUID pattern into a new
      // rule; that instruction (and the pattern literal) should be gone now
      // that the rule ships in place, just switched off.
      expect(description).not.toContain("[0-9a-fA-F]{8}-[0-9a-fA-F]{4}");
    });

    it("passes every default rule through validateAndSanitizeHighlightRulesWithError", async () => {
      const { validateAndSanitizeHighlightRulesWithError } = await import("../../src/utils/highlightRuleValidation");
      const result = validateAndSanitizeHighlightRulesWithError(defaultRules);
      expect(result.ok).toBe(true);
    });
  });
});
