import { describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import type { ServerConfig } from "../../src/models/config";
import { VscodePasswordPrompt } from "../../src/services/ssh/vscodePasswordPrompt";

vi.mock("vscode", () => ({
  CancellationTokenSource: class {
    private readonly listeners = new Set<() => void>();
    public readonly token = {
      isCancellationRequested: false,
      onCancellationRequested: (listener: () => void) => {
        this.listeners.add(listener);
        return { dispose: () => this.listeners.delete(listener) };
      }
    };
    public cancel(): void {
      this.token.isCancellationRequested = true;
      for (const listener of this.listeners) listener();
    }
    public dispose(): void { this.listeners.clear(); }
  },
  window: {
    showInputBox: vi.fn(),
    showQuickPick: vi.fn()
  }
}));

const server: ServerConfig = {
  id: "srv", name: "Server", host: "example.com", port: 22,
  username: "user", authType: "password", isHidden: false
};

describe("VscodePasswordPrompt", () => {
  it("closes its active input box when the connection owner cancels", async () => {
    const controller = new AbortController();
    vi.mocked(vscode.window.showInputBox).mockImplementation((_options, token) =>
      new Promise<string | undefined>((resolve) => {
        token?.onCancellationRequested(() => resolve(undefined));
      })
    );

    const answer = new VscodePasswordPrompt().prompt(server, controller.signal);
    await vi.waitFor(() => expect(vscode.window.showInputBox).toHaveBeenCalledTimes(1));
    controller.abort();

    await expect(answer).resolves.toBeUndefined();
    expect(vscode.window.showQuickPick).not.toHaveBeenCalled();
  });
});
