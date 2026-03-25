import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthProfile } from "../../src/models/config";
import { createInlineAuthProfileCreation } from "../../src/commands/inlineAuthProfileCreation";

const mockOpenNew = vi.fn();

vi.mock("../../src/ui/authProfileEditorPanel", () => ({
  AuthProfileEditorPanel: {
    openNew: (...args: unknown[]) => mockOpenNew(...args)
  }
}));

function makeCore(initialProfiles: AuthProfile[] = []) {
  let profiles = [...initialProfiles];
  const listeners = new Set<((snapshot: { authProfiles: AuthProfile[] }) => void)>();
  return {
    getSnapshot: vi.fn(() => ({ authProfiles: [...profiles] })),
    onDidChange: vi.fn((listener: (snapshot: { authProfiles: AuthProfile[] }) => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    }),
    addProfile(profile: AuthProfile) {
      profiles = [...profiles, profile];
      const snapshot = { authProfiles: [...profiles] };
      for (const listener of listeners) {
        listener(snapshot);
      }
    },
    listenerCount() {
      return listeners.size;
    }
  };
}

function makePanel() {
  const disposeListeners = new Set<() => void>();
  return {
    addSelectOption: vi.fn(),
    onDidDispose: vi.fn((listener: () => void) => {
      disposeListeners.add(listener);
      return {
        dispose: () => {
          disposeListeners.delete(listener);
        }
      };
    }),
    fireDispose() {
      for (const listener of [...disposeListeners]) {
        listener();
      }
    }
  };
}

describe("inlineAuthProfileCreation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("adds created auth profile to the form select and unsubscribes watcher", () => {
    const core = makeCore([
      { id: "ap0", name: "Base", username: "root", authType: "password" }
    ]);
    const panel = makePanel();
    const controller = createInlineAuthProfileCreation({ core: core as any, secretVault: undefined });
    controller.attachPanel(panel as any);

    controller.handleCreateInline("authProfileId");
    expect(mockOpenNew).toHaveBeenCalledWith(core, undefined);
    expect(core.listenerCount()).toBe(1);

    core.addProfile({ id: "ap1", name: "Prod", username: "deploy", authType: "key", keyPath: "/keys/id_ed25519" });

    expect(panel.addSelectOption).toHaveBeenCalledWith(
      "authProfileId",
      "ap1",
      "Prod — key — deploy — id_ed25519"
    );
    expect(core.listenerCount()).toBe(0);
  });

  it("keeps only one pending watcher when create-inline is triggered repeatedly", () => {
    const core = makeCore();
    const panel = makePanel();
    const controller = createInlineAuthProfileCreation({ core: core as any, secretVault: undefined });
    controller.attachPanel(panel as any);

    controller.handleCreateInline("authProfileId");
    controller.handleCreateInline("authProfileId");

    expect(mockOpenNew).toHaveBeenCalledTimes(2);
    expect(core.listenerCount()).toBe(1);
  });

  it("cleans up pending watcher when form panel is disposed", () => {
    const core = makeCore();
    const panel = makePanel();
    const controller = createInlineAuthProfileCreation({ core: core as any, secretVault: undefined });
    controller.attachPanel(panel as any);

    controller.handleCreateInline("authProfileId");
    expect(core.listenerCount()).toBe(1);

    panel.fireDispose();
    expect(core.listenerCount()).toBe(0);

    core.addProfile({ id: "ap1", name: "Late", username: "root", authType: "password" });
    expect(panel.addSelectOption).not.toHaveBeenCalled();
  });
});
