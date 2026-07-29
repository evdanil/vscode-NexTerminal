import { describe, expect, it, vi } from "vitest";
import type * as vscode from "vscode";
import { wireViewVisibility, type VisibilityAwareView } from "../../src/services/terminal/viewVisibilityWiring";

// No `vi.mock("vscode")` anywhere in this file — `viewVisibilityWiring.ts`
// only imports `vscode` for types, so it is fully testable with a plain fake.

function makeFakeView(initialVisible: boolean): {
  view: VisibilityAwareView;
  fireVisibilityChange(visible: boolean): void;
} {
  let listener: ((e: { visible: boolean }) => void) | undefined;
  const state = { visible: initialVisible };
  const view: VisibilityAwareView = {
    get visible() {
      return state.visible;
    },
    onDidChangeVisibility: vi.fn((l: (e: { visible: boolean }) => void) => {
      listener = l;
      return { dispose: vi.fn() } as unknown as vscode.Disposable;
    })
  };
  return {
    view,
    fireVisibilityChange(visible: boolean) {
      state.visible = visible;
      listener?.({ visible });
    }
  };
}

describe("wireViewVisibility", () => {
  it("seeds the consumer with the view's current visible=true state immediately, before any event ever fires (the BLOCKER fix)", () => {
    const { view } = makeFakeView(true);
    const onVisibilityChange = vi.fn();

    wireViewVisibility(view, onVisibilityChange);

    // VS Code's createTreeView() never fires onDidChangeVisibility at
    // registration — without an explicit seed call, a consumer that only
    // reacts to the event would never learn the view started out visible.
    expect(onVisibilityChange).toHaveBeenCalledTimes(1);
    expect(onVisibilityChange).toHaveBeenCalledWith(true);
  });

  it("seeds the consumer with visible=false when the view starts hidden", () => {
    const { view } = makeFakeView(false);
    const onVisibilityChange = vi.fn();

    wireViewVisibility(view, onVisibilityChange);

    expect(onVisibilityChange).toHaveBeenCalledWith(false);
  });

  it("forwards subsequent onDidChangeVisibility events after the initial seed", () => {
    const { view, fireVisibilityChange } = makeFakeView(true);
    const onVisibilityChange = vi.fn();

    wireViewVisibility(view, onVisibilityChange);
    onVisibilityChange.mockClear();

    fireVisibilityChange(false);
    expect(onVisibilityChange).toHaveBeenCalledWith(false);

    fireVisibilityChange(true);
    expect(onVisibilityChange).toHaveBeenCalledWith(true);
  });

  it("returns the underlying listener's disposable", () => {
    const { view } = makeFakeView(true);
    const disposable = wireViewVisibility(view, vi.fn());

    expect(() => disposable.dispose()).not.toThrow();
  });
});
