import { describe, expect, it } from "vitest";
import {
  MAX_RPC_TEXT_BYTES,
  MAX_TFTP_TRANSFERS,
  MAX_TRANSFER_ID_BYTES,
  parseRpcEnvelope,
  parseRpcEvent,
  parseRpcRequest,
  rpcResultParsers,
} from "../../../src/services/networkServers/networkServerRpcProtocol";
import { MAX_RPC_LINE_BYTES } from "../../../src/services/networkServers/boundedLineReader";
import { validateOptions } from "../../../src/services/networkServers/tftp/engine/protocol";

const DHCP_RUNTIME_LEASE_MAX = 65_536 + 1_024;
const TEXT_FIELD_BYTE_LIMIT = 1_047_552;

const TFTP_SNAPSHOT = {
  id: "tftp",
  name: "TFTP Server",
  port: 69,
  status: "stopped",
};

const DHCP_SNAPSHOT = {
  id: "dhcp",
  name: "DHCP Server",
  port: 67,
  status: "running",
};

function transfer(index = 1) {
  return {
    id: `127.0.0.1:${1000 + index}`,
    peer: { address: "127.0.0.1", port: 1000 + index },
    direction: "rrq",
    filename: `firmware-${index}.bin`,
    bytes: 512,
    totalBytes: 1024,
    blockSize: 512,
    windowSize: 1,
    speedBps: 256.5,
    etaSec: 2,
    startedAt: 1_700_000_000_000,
    clientHostname: null,
    client: "127.0.0.1",
  };
}

const TFTP_RUNTIME = {
  snapshot: TFTP_SNAPSHOT,
  transfers: [transfer()],
  root: "/tmp/nexus-tftp",
  allowWrite: false,
  boundPort: 69,
};

const DHCP_RUNTIME = {
  snapshot: DHCP_SNAPSHOT,
  leases: [{
    mac: "aa:bb:cc:dd:ee:ff",
    ip: "192.168.2.10",
    boundAt: 1_700_000_000_000,
    leaseSec: 3600,
    expiresAt: 1_700_000_003_600,
    remainingSec: 3599,
    hostname: null,
    leaseType: "dynamic",
  }],
  packetCounters: {
    packetsReceived: 1,
    packetsSentEstimate: 1,
    discoverCount: 1,
    offerCount: 1,
    requestCount: 1,
    declineCount: 0,
    ackCount: 1,
    nakCount: 0,
    releaseCount: 0,
    informCount: 0,
  },
  poolInfo: {
    rangeStart: "192.168.2.10",
    rangeEnd: "192.168.2.199",
    poolSize: 190,
    activeCount: 1,
    utilizationPct: 100 / 190,
    staticEntryCount: 0,
  },
  boundPort: null,
};

function expectAccepted(result: { readonly ok: boolean }): void {
  expect(result.ok).toBe(true);
}

function expectRejected(result: { readonly ok: boolean }): void {
  expect(result.ok).toBe(false);
}

describe("network-server RPC protocol", () => {
  describe("requests", () => {
    it.each([
      ["list", { id: 1, method: "list" }],
      ["getStatus", { id: 2, method: "getStatus", params: { id: "tftp" } }],
      ["configure", { id: 3, method: "configure", params: { configs: { tftp: { port: 69 } } } }],
      ["start", { id: 4, method: "start", params: { id: "tftp", config: { root: "/tmp/tftp", port: 69 } } }],
      ["stop", { id: 5, method: "stop", params: { id: "dhcp" } }],
      ["restart", { id: 6, method: "restart", params: { id: "dhcp", config: { gateway: "10.0.0.1" } } }],
      ["cancelTransfer", { id: 7, method: "cancelTransfer", params: { id: "tftp", transferId: "127.0.0.1:1069" } }],
      ["getServiceRuntime", { id: 8, method: "getServiceRuntime", params: { id: "dhcp" } }],
    ])("accepts the closed %s request shape", (_method, request) => {
      expectAccepted(parseRpcRequest(request));
    });

    it("accepts only finite non-negative safe request ids", () => {
      expectAccepted(parseRpcRequest({ id: 0, method: "list" }));
      expectAccepted(parseRpcRequest({ id: Number.MAX_SAFE_INTEGER, method: "list" }));

      for (const id of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity, -Infinity]) {
        expectRejected(parseRpcRequest({ id, method: "list" }));
      }

      expect(parseRpcRequest({ id: 1, method: "stop", params: { id: "tftp" } })).toMatchObject({ ok: true });
      expect(parseRpcRequest({ id: NaN, method: "stop", params: { id: "tftp" } })).toMatchObject({ ok: false });
    });

    it.each([
      ["list params", { id: 1, method: "list", params: {} }],
      ["unknown method", { id: 1, method: "delete", params: {} }],
      ["missing getStatus params", { id: 1, method: "getStatus" }],
      ["unknown request key", { id: 1, method: "list", extra: true }],
      ["unknown params key", { id: 1, method: "stop", params: { id: "tftp", force: true } }],
      ["unknown service", { id: 1, method: "stop", params: { id: "ftp" } }],
      ["non-TFTP cancellation", { id: 1, method: "cancelTransfer", params: { id: "dhcp", transferId: "x" } }],
      ["wrong service configuration", { id: 1, method: "start", params: { id: "tftp", config: { rangeStart: "10.0.0.2" } } }],
      ["unknown configuration key", { id: 1, method: "configure", params: { configs: { tftp: { unknown: true } } } }],
    ])("rejects %s", (_reason, request) => {
      expectRejected(parseRpcRequest(request));
    });

    it("enforces the transfer-id byte boundary", () => {
      expectAccepted(parseRpcRequest({
        id: 1,
        method: "cancelTransfer",
        params: { id: "tftp", transferId: "x".repeat(MAX_TRANSFER_ID_BYTES) },
      }));
      expectRejected(parseRpcRequest({
        id: 1,
        method: "cancelTransfer",
        params: { id: "tftp", transferId: "x".repeat(MAX_TRANSFER_ID_BYTES + 1) },
      }));
    });
  });

  describe("response envelopes", () => {
    it("accepts exactly one of result or a complete error", () => {
      expectAccepted(parseRpcEnvelope({ id: 0, result: null }));
      expectAccepted(parseRpcEnvelope({ id: 1, error: { code: "NOT_FOUND", message: "Server not found." } }));

      expectRejected(parseRpcEnvelope({ id: 1 }));
      expectRejected(parseRpcEnvelope({ id: 1, result: null, error: null }));
      expectRejected(parseRpcEnvelope({ id: 1, error: { code: "NOT_FOUND" } }));
      expectRejected(parseRpcEnvelope({ id: 1, error: { code: "NOT_FOUND", message: "x", detail: "leak" } }));
      expectRejected(parseRpcEnvelope({ id: 1, result: null, unexpected: true }));

      expect(parseRpcEnvelope({ id: 1, result: null, error: null })).toMatchObject({ ok: false });
    });

    it("enforces text boundaries in errors without coercing values", () => {
      expectAccepted(parseRpcEnvelope({ id: 1, error: { code: "X", message: "x".repeat(MAX_RPC_TEXT_BYTES) } }));
      expectRejected(parseRpcEnvelope({ id: 1, error: { code: "X", message: "x".repeat(MAX_RPC_TEXT_BYTES + 1) } }));
      expectRejected(parseRpcEnvelope({ id: 1, error: { code: "", message: "message" } }));
      expectRejected(parseRpcEnvelope({ id: 1, error: { code: 1, message: "message" } }));
    });

    it("keeps generic envelope cloning within the combined dynamic-and-static DHCP lease domain", () => {
      expectAccepted(parseRpcEnvelope({ id: 1, result: Array.from({ length: DHCP_RUNTIME_LEASE_MAX }, () => null) }));
      expectRejected(parseRpcEnvelope({ id: 1, result: Array.from({ length: DHCP_RUNTIME_LEASE_MAX + 1 }, () => null) }));
    });
  });

  describe("method-specific results", () => {
    it.each([
      ["list", [TFTP_SNAPSHOT, DHCP_SNAPSHOT]],
      ["getStatus", TFTP_SNAPSHOT],
      ["configure", { ok: true, changed: ["tftp"] }],
      ["start", { ok: true, id: "tftp" }],
      ["stop", { ok: true, id: "dhcp" }],
      ["restart", { ok: true, id: "tftp" }],
      ["cancelTransfer", { ok: false, id: "tftp", transferId: "127.0.0.1:1069" }],
      ["getServiceRuntime", TFTP_RUNTIME],
    ] as const)("accepts the complete %s result DTO", (method, result) => {
      expectAccepted(rpcResultParsers[method](result));
    });

    it("accepts both runtime service shapes and rejects a snapshot/discriminator mismatch", () => {
      expectAccepted(rpcResultParsers.getServiceRuntime(DHCP_RUNTIME));
      expectRejected(rpcResultParsers.getServiceRuntime({ ...TFTP_RUNTIME, snapshot: DHCP_SNAPSHOT }));
      expectRejected(rpcResultParsers.getServiceRuntime({ ...DHCP_RUNTIME, snapshot: TFTP_SNAPSHOT }));
      expectRejected(rpcResultParsers.getServiceRuntime({ ...TFTP_RUNTIME, leases: [] }));
      expectRejected(rpcResultParsers.getServiceRuntime({ ...DHCP_RUNTIME, transfers: [] }));
    });

    it("rejects missing, inherited, and malformed nested runtime DTO fields", () => {
      const missingTransferField = { ...transfer() } as Record<string, unknown>;
      delete missingTransferField.client;
      expectRejected(rpcResultParsers.getServiceRuntime({ ...TFTP_RUNTIME, transfers: [missingTransferField] }));
      expectRejected(rpcResultParsers.getServiceRuntime({ ...DHCP_RUNTIME, packetCounters: { packetsReceived: 1 } }));
      expectRejected(rpcResultParsers.getServiceRuntime({ ...TFTP_RUNTIME, root: "", boundPort: 65_536 }));
      expectRejected(rpcResultParsers.getServiceRuntime({ ...DHCP_RUNTIME, poolInfo: { ...DHCP_RUNTIME.poolInfo, utilizationPct: 101 } }));
    });

    it("accepts a static lease outside a one-address dynamic pool", () => {
      const staticLease = { ...DHCP_RUNTIME.leases[0], mac: "aa:bb:cc:dd:ee:01", ip: "192.168.2.250", leaseType: "static" };
      expectAccepted(rpcResultParsers.getServiceRuntime({
        ...DHCP_RUNTIME,
        leases: [DHCP_RUNTIME.leases[0], staticLease],
        poolInfo: {
          rangeStart: "192.168.2.10",
          rangeEnd: "192.168.2.10",
          poolSize: 1,
          activeCount: 2,
          utilizationPct: 100,
          staticEntryCount: 1,
        },
      }));
    });

    it("requires poolInfo.activeCount to match the returned DHCP leases", () => {
      expectRejected(rpcResultParsers.getServiceRuntime({
        ...DHCP_RUNTIME,
        poolInfo: { ...DHCP_RUNTIME.poolInfo, activeCount: 0 },
      }));
      expectRejected(rpcResultParsers.getServiceRuntime({
        ...DHCP_RUNTIME,
        leases: [DHCP_RUNTIME.leases[0], { ...DHCP_RUNTIME.leases[0], mac: "aa:bb:cc:dd:ee:01", ip: "192.168.2.250", leaseType: "static" }],
        poolInfo: { ...DHCP_RUNTIME.poolInfo, activeCount: 1, staticEntryCount: 1 },
      }));
    });

    it("accepts the full dynamic-plus-static DHCP lease maximum and rejects one more", () => {
      const leasesAtLimit = Array.from({ length: DHCP_RUNTIME_LEASE_MAX }, () => DHCP_RUNTIME.leases[0]);
      const poolInfoAtLimit = {
        rangeStart: "192.168.0.0",
        rangeEnd: "192.168.255.255",
        poolSize: 65_536,
        activeCount: DHCP_RUNTIME_LEASE_MAX,
        utilizationPct: 100,
        staticEntryCount: 1_024,
      };
      expectAccepted(rpcResultParsers.getServiceRuntime({ ...DHCP_RUNTIME, leases: leasesAtLimit, poolInfo: poolInfoAtLimit }));
      expectRejected(rpcResultParsers.getServiceRuntime({
        ...DHCP_RUNTIME,
        leases: [...leasesAtLimit, DHCP_RUNTIME.leases[0]],
        poolInfo: { ...poolInfoAtLimit, activeCount: DHCP_RUNTIME_LEASE_MAX + 1 },
      }));
    });

    it("accepts a totalBytes value emitted by the current TFTP tsize parser beyond Number.MAX_SAFE_INTEGER", () => {
      const totalBytes = validateOptions({ tsize: "9007199254740992" }).tsize;
      expect(totalBytes).toBe(9_007_199_254_740_992);
      expectAccepted(rpcResultParsers.getServiceRuntime({
        ...TFTP_RUNTIME,
        transfers: [{ ...transfer(), totalBytes }],
      }));
    });

    it("enforces bounded response collections at their exact limits", () => {
      expectAccepted(rpcResultParsers.list([TFTP_SNAPSHOT, DHCP_SNAPSHOT]));
      expectRejected(rpcResultParsers.list([TFTP_SNAPSHOT, DHCP_SNAPSHOT, TFTP_SNAPSHOT]));
      expectAccepted(rpcResultParsers.configure({ ok: true, changed: ["tftp", "dhcp"] }));
      expectRejected(rpcResultParsers.configure({ ok: true, changed: ["tftp", "dhcp", "tftp"] }));

      expectAccepted(rpcResultParsers.getServiceRuntime({
        ...TFTP_RUNTIME,
        transfers: Array.from({ length: MAX_TFTP_TRANSFERS }, (_, index) => transfer(index)),
      }));
      expectRejected(rpcResultParsers.getServiceRuntime({
        ...TFTP_RUNTIME,
        transfers: Array.from({ length: MAX_TFTP_TRANSFERS + 1 }, (_, index) => transfer(index)),
      }));
    });
  });

  describe("events", () => {
    it.each([
      ["ready", { event: "ready", data: null }],
      ["statusChange", { event: "statusChange", data: { id: "tftp", status: "running" } }],
      ["log", { event: "log", data: { id: "daemon", level: "info", message: "ready" } }],
      ["runtimeUpdate", { event: "runtimeUpdate", data: { id: "dhcp" } }],
      ["connection", {
        event: "connection",
        data: {
          id: "tftp",
          connection: {
            phase: "failed",
            summary: "download failed",
            detail: "disk full",
            code: "ENOSPC",
            id: "127.0.0.1:1069",
            resource: "firmware.bin",
            client: "127.0.0.1",
          },
        },
      }],
    ])("accepts the closed %s event shape", (_event, payload) => {
      expectAccepted(parseRpcEvent(payload));
    });

    it.each([
      ["unknown event", { event: "progress", data: null }],
      ["wrong ready data", { event: "ready", data: {} }],
      ["unknown event key", { event: "ready", data: null, sequence: 1 }],
      ["unknown status", { event: "statusChange", data: { id: "tftp", status: "online" } }],
      ["unknown log level", { event: "log", data: { id: "daemon", level: "notice", message: "x" } }],
      ["unknown event service", { event: "runtimeUpdate", data: { id: "ftp" } }],
      ["connection extra key", { event: "connection", data: { id: "dhcp", connection: { phase: "started", summary: "lease", extra: true } } }],
    ])("rejects %s", (_reason, payload) => {
      expectRejected(parseRpcEvent(payload));
    });

    it("keeps a multibyte log field within the planned JSON-line byte budget", () => {
      const messageAtLimit = "é".repeat(TEXT_FIELD_BYTE_LIMIT / 2);
      const eventAtLimit = { event: "log", data: { id: "daemon", level: "info", message: messageAtLimit } } as const;
      expect(Buffer.byteLength(messageAtLimit, "utf8")).toBe(TEXT_FIELD_BYTE_LIMIT);
      expectAccepted(parseRpcEvent(eventAtLimit));
      expect(Buffer.byteLength(`${JSON.stringify(eventAtLimit)}\n`, "utf8")).toBeLessThanOrEqual(MAX_RPC_LINE_BYTES);

      const messageOneByteOver = `${messageAtLimit}a`;
      expect(Buffer.byteLength(messageOneByteOver, "utf8")).toBe(TEXT_FIELD_BYTE_LIMIT + 1);
      expectRejected(parseRpcEvent({ event: "log", data: { id: "daemon", level: "info", message: messageOneByteOver } }));

      expect(parseRpcEvent({ event: "ready", data: {} })).toMatchObject({ ok: false });
    });
  });

  describe("hostile values", () => {
    it("rejects nulls, arrays, custom prototypes, inherited fields, accessors, and coercion traps without throwing", () => {
      const inheritedRequest = Object.create({ id: 1, method: "list" }) as Record<string, unknown>;
      const customPrototypeRequest = Object.assign(Object.create({}), { id: 1, method: "list" }) as Record<string, unknown>;
      const accessorRequest = {} as Record<string, unknown>;
      Object.defineProperty(accessorRequest, "id", {
        enumerable: true,
        get: () => {
          throw new Error("must not read accessor");
        },
      });
      Object.defineProperty(accessorRequest, "method", { enumerable: true, value: "list" });
      const coercionTrap = {
        valueOf: () => {
          throw new Error("must not coerce");
        },
        toString: () => {
          throw new Error("must not stringify");
        },
      };
      const configAccessor = { id: 1, method: "configure", params: {} as Record<string, unknown> };
      Object.defineProperty(configAccessor.params, "configs", {
        enumerable: true,
        get: () => {
          throw new Error("must not read config accessor");
        },
      });

      for (const payload of [null, [], inheritedRequest, customPrototypeRequest, accessorRequest, { id: coercionTrap, method: "list" }, configAccessor]) {
        expect(() => parseRpcRequest(payload)).not.toThrow();
        expectRejected(parseRpcRequest(payload));
      }

      const inheritedEnvelope = Object.create({ result: null }) as Record<string, unknown>;
      inheritedEnvelope.id = 1;
      const accessorEvent = {} as Record<string, unknown>;
      Object.defineProperty(accessorEvent, "event", { enumerable: true, value: "ready" });
      Object.defineProperty(accessorEvent, "data", {
        enumerable: true,
        get: () => {
          throw new Error("must not read event accessor");
        },
      });

      for (const payload of [null, [], inheritedEnvelope, accessorEvent]) {
        expect(() => parseRpcEnvelope(payload)).not.toThrow();
        expectRejected(parseRpcEnvelope(payload));
        expect(() => parseRpcEvent(payload)).not.toThrow();
        expectRejected(parseRpcEvent(payload));
      }
    });
  });
});
