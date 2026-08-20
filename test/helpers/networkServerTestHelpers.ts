/**
 * @author kanekitakitos
 *
 * Shared fixtures for the Embedded Network Servers suites (TFTP + DHCP).
 *
 * Lives under `test/helpers/` rather than beside one suite because both the
 * unit tests (temp roots + payloads for PathGuard / TransferSession) and the
 * integration tests (real UDP clients against a bound TftpEngine) draw from it.
 */

import dgram from "node:dgram";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";

export function mkdtemp(prefix = "nexus-tftp-test-"): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function randomPayload(n: number): Buffer {
  return randomBytes(n);
}

export interface UdpClient {
  readonly socket: dgram.Socket;
  readonly port: number;
  sendTo(buffer: Buffer, port: number, address?: string): void;
  nextMsg(timeoutMs?: number): Promise<{ message: Buffer; rinfo: dgram.RemoteInfo }>;
  close(): void;
}

export function createUdpClient(): Promise<UdpClient> {
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket("udp4");
    // The stress suites park dozens of one-shot `once("message")` waiters on a
    // single socket; Node's default cap of 10 would spam MaxListenersExceeded.
    socket.setMaxListeners(999);
    socket.on("error", (e) => reject(e));
    socket.bind(0, "127.0.0.1", () => {
      const addr = socket.address() as { port: number };
      resolve({
        socket,
        port: addr.port,
        sendTo(buf, port, address = "127.0.0.1") {
          socket.send(buf, 0, buf.length, port, address);
        },
        nextMsg(timeoutMs = 15_000) {
          return new Promise((res, rej) => {
            const tm = setTimeout(() => rej(new Error(`udp nextMsg timeout after ${timeoutMs}ms`)), timeoutMs);
            socket.once("message", (message, rinfo) => {
              clearTimeout(tm);
              res({ message, rinfo });
            });
          });
        },
        close() {
          try {
            socket.close();
          } catch {
            /* ignore */
          }
        }
      });
    });
  });
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
