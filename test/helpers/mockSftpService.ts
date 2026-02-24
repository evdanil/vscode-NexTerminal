import { vi } from "vitest";
import type { SftpService } from "../../src/services/sftp/sftpService";

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
    dispose: vi.fn(),
  };
  service.tryStat.mockImplementation(async (...args: any[]) => {
    try {
      return await service.stat(...args);
    } catch {
      return undefined;
    }
  });
  service.tryLstat.mockImplementation(async (...args: any[]) => {
    try {
      return await service.lstat(...args);
    } catch {
      return undefined;
    }
  });
  return service as SftpService;
}
