import { describe, expect, it, vi } from "vitest";
import {
  CONTAINERLAB_APPROVAL_STATE_KEY,
  VscodeContainerlabApprovalStore
} from "../../src/storage/vscodeContainerlabApprovalStore";
import { RESET_CLEARED_GLOBAL_STATE_KEYS } from "../../src/storage/globalStateKeys";

describe("VS Code Containerlab approval store", () => {
  it("uses one dedicated reset-cleared key and round-trips only its local memento value", async () => {
    const data = new Map<string, unknown>();
    const state = {
      get: <T>(key: string): T | undefined => data.get(key) as T | undefined,
      update: vi.fn(async (key: string, value: unknown) => {
        if (value === undefined) data.delete(key);
        else data.set(key, value);
      })
    };
    const store = new VscodeContainerlabApprovalStore(state as never);
    const document = { schema: 1, sessionNonce: "local-session", records: [] };

    expect(await store.load()).toBeUndefined();
    await store.save(document);

    expect(state.update).toHaveBeenCalledExactlyOnceWith(CONTAINERLAB_APPROVAL_STATE_KEY, document);
    expect(await store.load()).toEqual(document);
    expect([...data.keys()]).toEqual([CONTAINERLAB_APPROVAL_STATE_KEY]);
    expect(RESET_CLEARED_GLOBAL_STATE_KEYS).toContain(CONTAINERLAB_APPROVAL_STATE_KEY);
  });
});
