import { afterEach, describe, expect, it, vi } from "vitest";

const mockGet = vi.fn();

vi.mock("vscode", () => ({
  workspace: {
    getConfiguration: vi.fn(() => ({
      get: (key: string, fallback: unknown) => mockGet(key, fallback)
    }))
  }
}));

import { readBoundedNumber } from "../../src/utils/boundedConfig";

describe("readBoundedNumber", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("returns the configured value when valid and in range", () => {
    mockGet.mockReturnValue(42);
    expect(readBoundedNumber("nexus.sftp", "x", 10, 0, 100)).toBe(42);
  });

  it("clamps a value above max", () => {
    mockGet.mockReturnValue(500);
    expect(readBoundedNumber("nexus.sftp", "x", 10, 0, 100)).toBe(100);
  });

  it("clamps a value below min", () => {
    mockGet.mockReturnValue(-5);
    expect(readBoundedNumber("nexus.sftp", "x", 10, 1, 100)).toBe(1);
  });

  it("falls back to default for NaN", () => {
    mockGet.mockReturnValue(NaN);
    expect(readBoundedNumber("nexus.sftp", "x", 10, 0, 100)).toBe(10);
  });

  it("falls back to default for Infinity", () => {
    mockGet.mockReturnValue(Infinity);
    expect(readBoundedNumber("nexus.sftp", "x", 10, 0, 100)).toBe(10);
  });

  it("falls back to default for a string value", () => {
    mockGet.mockReturnValue("abc");
    expect(readBoundedNumber("nexus.sftp", "x", 10, 0, 100)).toBe(10);
  });

  it("falls back to default for null", () => {
    mockGet.mockReturnValue(null);
    expect(readBoundedNumber("nexus.sftp", "x", 10, 0, 100)).toBe(10);
  });

  it("falls back to default for an object value", () => {
    mockGet.mockReturnValue({});
    expect(readBoundedNumber("nexus.sftp", "x", 10, 0, 100)).toBe(10);
  });

  it("keeps 0 when 0 is within range", () => {
    mockGet.mockReturnValue(0);
    expect(readBoundedNumber("nexus.sftp", "autoRefreshInterval", 10, 0, 60)).toBe(0);
  });
});
