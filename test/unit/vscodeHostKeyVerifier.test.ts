import { beforeEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import { VscodeHostKeyVerifier } from "../../src/services/ssh/vscodeHostKeyVerifier";
import type { ServerConfig } from "../../src/models/config";

vi.mock("vscode", () => ({
  window: {
    showWarningMessage: vi.fn()
  },
  workspace: {
    getConfiguration: vi.fn()
  }
}));

function makeMemento(): vscode.Memento {
  const store = new Map<string, unknown>();
  return {
    keys: () => [...store.keys()],
    get: <T>(key: string, fallback?: T) => (store.get(key) as T) ?? fallback,
    update: async (key: string, value: unknown) => { store.set(key, value); }
  } as vscode.Memento;
}

function makeServer(overrides: Partial<ServerConfig> = {}): ServerConfig {
  return {
    id: "srv-1",
    name: "Test Server",
    host: "example.com",
    port: 22,
    username: "dev",
    authType: "password",
    isHidden: false,
    ...overrides
  };
}

const DUMMY_KEY = Buffer.from("ssh-rsa AAAA_dummy_key_data");
const DIFFERENT_KEY = Buffer.from("ssh-ed25519 BBBB_different_key");

describe("VscodeHostKeyVerifier TOFU", () => {
  let memento: vscode.Memento;

  beforeEach(() => {
    vi.clearAllMocks();
    memento = makeMemento();
  });

  function mockTrustNewHosts(value: boolean) {
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
      get: (key: string) => key === "trustNewHosts" ? value : undefined
    } as any);
  }

  it("silently accepts unknown host when trustNewHosts is true", async () => {
    mockTrustNewHosts(true);
    const verifier = new VscodeHostKeyVerifier(memento);
    const result = await verifier.verify(makeServer(), DUMMY_KEY);
    expect(result).toBe(true);
    expect(vscode.window.showWarningMessage).not.toHaveBeenCalled();
  });

  it("stores fingerprint after silent accept", async () => {
    mockTrustNewHosts(true);
    const verifier = new VscodeHostKeyVerifier(memento);
    await verifier.verify(makeServer(), DUMMY_KEY);
    // Second call with same key should still succeed silently
    const result = await verifier.verify(makeServer(), DUMMY_KEY);
    expect(result).toBe(true);
    expect(vscode.window.showWarningMessage).not.toHaveBeenCalled();
  });

  it("prompts for unknown host when trustNewHosts is false", async () => {
    mockTrustNewHosts(false);
    vi.mocked(vscode.window.showWarningMessage).mockResolvedValue("Trust and Continue" as any);
    const verifier = new VscodeHostKeyVerifier(memento);
    const result = await verifier.verify(makeServer(), DUMMY_KEY);
    expect(result).toBe(true);
    expect(vscode.window.showWarningMessage).toHaveBeenCalledTimes(1);
  });

  it("rejects unknown host when user cancels prompt (trustNewHosts false)", async () => {
    mockTrustNewHosts(false);
    vi.mocked(vscode.window.showWarningMessage).mockResolvedValue(undefined as any);
    const verifier = new VscodeHostKeyVerifier(memento);
    const result = await verifier.verify(makeServer(), DUMMY_KEY);
    expect(result).toBe(false);
  });

  it("always prompts when fingerprint changes (MITM warning)", async () => {
    mockTrustNewHosts(true);
    const verifier = new VscodeHostKeyVerifier(memento);
    // First: silently accept
    await verifier.verify(makeServer(), DUMMY_KEY);
    // Second: different key — must prompt
    vi.mocked(vscode.window.showWarningMessage).mockResolvedValue("Accept New Key" as any);
    const result = await verifier.verify(makeServer(), DIFFERENT_KEY);
    expect(result).toBe(true);
    expect(vscode.window.showWarningMessage).toHaveBeenCalledTimes(1);
    const msg = vi.mocked(vscode.window.showWarningMessage).mock.calls[0][0] as string;
    expect(msg).toContain("CHANGED");
    expect(msg).toContain("man-in-the-middle");
  });

  it("rejects changed fingerprint when user cancels MITM warning", async () => {
    mockTrustNewHosts(true);
    const verifier = new VscodeHostKeyVerifier(memento);
    await verifier.verify(makeServer(), DUMMY_KEY);
    vi.mocked(vscode.window.showWarningMessage).mockResolvedValue(undefined as any);
    const result = await verifier.verify(makeServer(), DIFFERENT_KEY);
    expect(result).toBe(false);
  });

  /**
   * The store has a second writer now — a backup restore rewrites
   * `nexus.ssh.knownHostFingerprints.v1` — so a trust decision must not write
   * back the copy it read BEFORE a modal the user may leave open for minutes.
   * Doing that silently discarded whatever landed in between.
   */
  it("a trust decision made across a modal does not write back a stale copy of the store", async () => {
    mockTrustNewHosts(false);
    let answer: (choice: string) => void = () => undefined;
    vi.mocked(vscode.window.showWarningMessage).mockImplementation(
      () => new Promise((resolve) => { answer = resolve as (choice: string) => void; }) as any
    );
    const verifier = new VscodeHostKeyVerifier(memento);
    const pending = verifier.verify(makeServer(), DUMMY_KEY);
    await Promise.resolve();

    // Another writer (a backup restore) lands while the modal is open.
    await memento.update("nexus.ssh.knownHostFingerprints.v1", { "restored.lab:22": "SHA256:restored" });
    answer("Trust and Continue");
    expect(await pending).toBe(true);

    const stored = memento.get<Record<string, string>>("nexus.ssh.knownHostFingerprints.v1");
    expect(stored?.["restored.lab:22"]).toBe("SHA256:restored");
    expect(stored?.["example.com:22"]).toMatch(/^SHA256:/u);
  });

  it("an accepted CHANGED key does not write back a stale copy of the store either", async () => {
    mockTrustNewHosts(true);
    const verifier = new VscodeHostKeyVerifier(memento);
    await verifier.verify(makeServer(), DUMMY_KEY);
    let answer: (choice: string) => void = () => undefined;
    vi.mocked(vscode.window.showWarningMessage).mockImplementation(
      () => new Promise((resolve) => { answer = resolve as (choice: string) => void; }) as any
    );
    const pending = verifier.verify(makeServer(), DIFFERENT_KEY);
    await Promise.resolve();

    const current = memento.get<Record<string, string>>("nexus.ssh.knownHostFingerprints.v1") ?? {};
    await memento.update("nexus.ssh.knownHostFingerprints.v1", { ...current, "restored.lab:22": "SHA256:restored" });
    answer("Accept New Key");
    expect(await pending).toBe(true);

    const stored = memento.get<Record<string, string>>("nexus.ssh.knownHostFingerprints.v1");
    expect(stored?.["restored.lab:22"]).toBe("SHA256:restored");
    const second = new VscodeHostKeyVerifier(memento);
    vi.mocked(vscode.window.showWarningMessage).mockClear();
    expect(await second.verify(makeServer(), DIFFERENT_KEY)).toBe(true);
    expect(vscode.window.showWarningMessage).not.toHaveBeenCalled();
  });

  it("accepts known host with matching fingerprint silently", async () => {
    mockTrustNewHosts(true);
    const verifier = new VscodeHostKeyVerifier(memento);
    await verifier.verify(makeServer(), DUMMY_KEY);
    vi.clearAllMocks();
    mockTrustNewHosts(true);
    const result = await verifier.verify(makeServer(), DUMMY_KEY);
    expect(result).toBe(true);
    expect(vscode.window.showWarningMessage).not.toHaveBeenCalled();
  });
});
