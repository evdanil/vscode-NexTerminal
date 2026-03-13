import { vi } from "vitest";
import type { SftpService } from "../../src/services/sftp/sftpService";

function isMissingPathError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  const candidate = error as { code?: number | string; message?: string };
  return candidate.code === 2 || candidate.code === "ENOENT" || (
    typeof candidate.message === "string" && /\b(no such file|not found)\b/i.test(candidate.message)
  );
}

export function createMockSftpService(): SftpService {
  const service: any = {
    connect: vi.fn(),
    disconnect: vi.fn(),
    isConnected: vi.fn(),
    readDirectory: vi.fn(),
    stat: vi.fn(),
    lstat: vi.fn(),
    tryStat: vi.fn(),
    tryLstat: vi.fn(),
    readFile: vi.fn(),
    writeFile: vi.fn(),
    delete: vi.fn(),
    rename: vi.fn(),
    createDirectory: vi.fn(),
    realpath: vi.fn(),
    download: vi.fn(),
    upload: vi.fn(),
    copyRemote: vi.fn(),
    invalidateCache: vi.fn(),
    onRemoteChange: vi.fn().mockReturnValue(() => {}),
    startWatching: vi.fn().mockResolvedValue(undefined),
    stopWatching: vi.fn(),
    getWatchMode: vi.fn().mockReturnValue(undefined),
    dispose: vi.fn(),
  };
  service.tryStat.mockImplementation(async (...args: any[]) => {
    try {
      return await service.stat(...args);
    } catch (error) {
      if (isMissingPathError(error)) {
        return undefined;
      }
      throw error;
    }
  });
  service.tryLstat.mockImplementation(async (...args: any[]) => {
    try {
      return await service.lstat(...args);
    } catch (error) {
      if (isMissingPathError(error)) {
        return undefined;
      }
      throw error;
    }
  });
  return service as SftpService;
}
