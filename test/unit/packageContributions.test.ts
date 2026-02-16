import { readFileSync } from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

const packageJsonPath = path.resolve(__dirname, "..", "..", "package.json");
const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
  dependencies: Record<string, string>;
  contributes: {
    commands: Array<{ command: string; title: string }>;
    menus: Record<string, Array<{ command: string; when?: string }>>;
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
    expect(menuItems.some((item) => item.when?.includes("viewItem == nexus.serialProfileConnected"))).toBe(true);
  });

  it("contributes unified profile.add, group.add, and group.remove commands", () => {
    const commands = packageJson.contributes.commands.map((item) => item.command);
    expect(commands).toContain("nexus.profile.add");
    expect(commands).toContain("nexus.group.add");
    expect(commands).toContain("nexus.group.remove");
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
});
