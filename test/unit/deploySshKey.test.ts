import { describe, expect, it, vi, beforeEach } from "vitest";
import * as path from "node:path";

// Mock fs/promises before importing module under test
vi.mock("node:fs/promises", () => ({
  readdir: vi.fn(),
  mkdir: vi.fn(),
  readFile: vi.fn(),
}));

// Mock child_process
vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
}));

import { readdir } from "node:fs/promises";
import { findLocalKeyPairs } from "../../src/services/ssh/deploySshKey";

describe("findLocalKeyPairs", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("discovers ed25519 and rsa key pairs", async () => {
    vi.mocked(readdir).mockResolvedValue([
      "id_ed25519", "id_ed25519.pub",
      "id_rsa", "id_rsa.pub",
      "known_hosts", "config",
    ] as any);

    const result = await findLocalKeyPairs("/home/user/.ssh");
    expect(result).toHaveLength(2);
    expect(result[0].name).toBe("id_ed25519");
    expect(result[0].publicKeyPath).toBe(path.join("/home/user/.ssh", "id_ed25519.pub"));
    expect(result[1].name).toBe("id_rsa");
  });

  it("returns empty array when .ssh dir does not exist", async () => {
    const err = Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    vi.mocked(readdir).mockRejectedValue(err);

    const result = await findLocalKeyPairs("/home/user/.ssh");
    expect(result).toEqual([]);
  });

  it("sorts ed25519 keys first", async () => {
    vi.mocked(readdir).mockResolvedValue([
      "id_rsa", "id_rsa.pub",
      "id_ecdsa", "id_ecdsa.pub",
      "id_ed25519", "id_ed25519.pub",
    ] as any);

    const result = await findLocalKeyPairs("/home/user/.ssh");
    expect(result[0].name).toBe("id_ed25519");
  });

  it("only returns pairs where both private and .pub exist", async () => {
    vi.mocked(readdir).mockResolvedValue([
      "id_ed25519",       // no .pub
      "id_rsa.pub",       // no private
      "id_ecdsa", "id_ecdsa.pub",
    ] as any);

    const result = await findLocalKeyPairs("/home/user/.ssh");
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("id_ecdsa");
  });
});
