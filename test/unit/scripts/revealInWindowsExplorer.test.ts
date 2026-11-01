import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import type { ChildProcess, spawn } from "node:child_process";
import { revealInWindowsExplorer } from "../../../src/services/scripts/revealInWindowsExplorer";

function starter(event: "spawn" | "error" = "spawn") {
  const child = Object.assign(new EventEmitter(), { unref: vi.fn() });
  const start = vi.fn(() => {
    queueMicrotask(() => event === "spawn" ? child.emit("spawn") : child.emit("error", new Error("missing Explorer")));
    return child as unknown as ChildProcess;
  });
  return { start: start as unknown as typeof spawn, calls: start, child };
}

describe("revealInWindowsExplorer", () => {
  it.each([
    String.raw`C:\scripts\backup.js`,
    String.raw`C:\scripts,old\my script & backup.js`,
    String.raw`C:\scripts\路由器.js`,
    String.raw`\\server\share\scripts,old\file.js`
  ])("passes one quoted, literal selection argument for %s", async (file) => {
    const { start, calls, child } = starter();
    await revealInWindowsExplorer(file, String.raw`C:\Windows`, start);
    expect(calls).toHaveBeenCalledOnce();
    expect(calls).toHaveBeenCalledWith(String.raw`C:\Windows\explorer.exe`, [`/select,"${file}"`], {
      argv0: String.raw`"C:\Windows\explorer.exe"`, detached: true, stdio: "ignore", windowsVerbatimArguments: true
    });
    expect(child.unref).toHaveBeenCalledOnce();
  });

  it.each([String.raw`\scripts\file.js`, String.raw`C:relative.js`, "relative.js", String.raw`C:\dir\bad"name.js`, "C:\\bad\0name.js", "C:\\dir\\"])(
    "rejects invalid or non-file paths before starting Explorer: %s", async (file) => {
      const { start, calls } = starter();
      await expect(revealInWindowsExplorer(file, String.raw`C:\Windows`, start)).rejects.toThrow();
      expect(calls).not.toHaveBeenCalled();
    }
  );

  it("quotes Explorer's executable argument when the system directory contains spaces", async () => {
    const { start, calls } = starter();
    await revealInWindowsExplorer(String.raw`C:\scripts\test.js`, String.raw`C:\Windows NT`, start);
    expect(calls).toHaveBeenCalledWith(
      String.raw`C:\Windows NT\explorer.exe`,
      expect.any(Array),
      expect.objectContaining({ argv0: String.raw`"C:\Windows NT\explorer.exe"` })
    );
  });

  it("reports a launch error", async () => {
    const { start } = starter("error");
    await expect(revealInWindowsExplorer(String.raw`C:\scripts\test.js`, String.raw`C:\Windows`, start)).rejects.toThrow("missing Explorer");
  });
});
