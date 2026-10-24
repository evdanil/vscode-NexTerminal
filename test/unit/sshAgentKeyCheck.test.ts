import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
// The connector first: it loads ssh2 behind its DH-group shim (sshDhGroupCompat.ts).
import { countAgentKeys } from "../../src/services/ssh/ssh2Connector";
import { AgentProtocol, utils } from "ssh2";

/**
 * The pre-flight key check against a real agent socket speaking the OpenSSH
 * agent protocol — ssh2's own server-side AgentProtocol — so what is tested is
 * the exchange ssh2 will have with Pageant or ssh-agent, not a stand-in.
 */
type Behaviour = { keys: number } | "silent";

const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length > 0) {
    cleanups.pop()!();
  }
});

function socketPath(): string {
  if (process.platform === "win32") {
    return `\\\\.\\pipe\\nexus-agent-test-${process.pid}-${Math.random().toString(16).slice(2)}`;
  }
  const dir = mkdtempSync(path.join(tmpdir(), "nexus-agent-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, "agent.sock");
}

/** Resolves once every connection the fake agent accepted has closed. */
let agentConnectionsClosed: () => Promise<void> = async () => {};

async function fakeAgent(behaviour: Behaviour): Promise<string> {
  const publicKeys = behaviour === "silent"
    ? []
    : Array.from({ length: behaviour.keys }, () => {
        const parsed = utils.parseKey(utils.generateKeyPairSync("ed25519").public);
        if (parsed instanceof Error) throw parsed;
        return parsed;
      });
  const sockets = new Set<Socket>();
  const closed: Array<Promise<void>> = [];
  agentConnectionsClosed = () => Promise.all(closed).then(() => undefined);
  const server: Server = createServer((socket) => {
    sockets.add(socket);
    closed.push(new Promise((resolve) => socket.once("close", () => resolve())));
    if (behaviour === "silent") {
      // A hung agent: reads the request, never answers. Reading matters — a
      // paused socket would never see the client close it.
      socket.resume();
      return;
    }
    const protocol = new AgentProtocol(false);
    protocol.on("identities", (request) => protocol.getIdentitiesReply(request, publicKeys));
    socket.pipe(protocol).pipe(socket);
  });
  const where = socketPath();
  await new Promise<void>((resolve) => server.listen(where, resolve));
  cleanups.push(() => {
    for (const socket of sockets) socket.destroy();
    server.close();
  });
  return where;
}

describe("countAgentKeys", () => {
  it("counts the keys a running agent offers", async () => {
    expect(await countAgentKeys(await fakeAgent({ keys: 2 }))).toBe(2);
  });

  it("reports an agent that holds no keys as zero, not as a failure", async () => {
    expect(await countAgentKeys(await fakeAgent({ keys: 0 }))).toBe(0);
  });

  it("gives up on an agent that never answers (⊘ a hung agent would hang every connect)", async () => {
    const started = Date.now();
    await expect(countAgentKeys(await fakeAgent("silent"), undefined, 100)).rejects.toThrow("it did not answer within 0.1 seconds");
    expect(Date.now() - started).toBeLessThan(1_500);
  }, 2_000);

  it("closes its connection to an agent it gave up on (⊘ leaving one socket open per connect to a hung agent)", async () => {
    await expect(countAgentKeys(await fakeAgent("silent"), undefined, 100)).rejects.toThrow("did not answer");
    const outcome = await Promise.race([
      agentConnectionsClosed().then(() => "closed"),
      new Promise((resolve) => setTimeout(() => resolve("still open"), 1_000))
    ]);
    expect(outcome).toBe("closed");
  }, 3_000);

  it("stops at once, closing the connection, when the connect is cancelled mid-check", async () => {
    const path = await fakeAgent("silent");
    const controller = new AbortController();
    const reason = new Error("terminal closed");
    const checking = countAgentKeys(path, controller.signal, 5_000);
    setTimeout(() => controller.abort(reason), 50);
    const started = Date.now();
    await expect(checking).rejects.toBe(reason);
    expect(Date.now() - started).toBeLessThan(1_000);
    await expect(agentConnectionsClosed()).resolves.toBeUndefined();
  }, 3_000);

  it("never opens the agent for a connect that was already cancelled", async () => {
    const path = await fakeAgent({ keys: 1 });
    const controller = new AbortController();
    controller.abort(new Error("gone"));
    await expect(countAgentKeys(path, controller.signal)).rejects.toThrow("gone");
  });

  it("rejects when nothing listens at the path", async () => {
    await expect(countAgentKeys(socketPath())).rejects.toThrow("Failed to connect to agent");
  });
});
