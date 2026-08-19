/** @author kanekitakitos */

/**
 * TypeScript declarations for the `dhcp` module (npm: dhcp@0.2.20).
 *
 * **Why this .d.ts file (KISS + Ports & Adapters):**
 * - The `dhcp` package does not provide official `@types/dhcp` nor embedded
 *   types in the package itself.
 * - Without this file, TypeScript would treat `import * as dhcp from 'dhcp'`
 *   as `any`, losing all strong typing in the Nexus-tools ecosystem.
 * - This module declares **only** the API surface that `DhcpAdapter` actually
 *   uses (we do not try to type EVERYTHING in the library), following the
 *   YAGNI principle.
 *
 * @module
 */

declare module 'dhcp' {
  import type { EventEmitter } from 'node:events';
  import type { Socket } from 'node:dgram';

  /**
   * A config entry is either a literal value or a resolver the library calls
   * per request (`Server.prototype.config`, dhcp.js:152-163). The resolver
   * receives the incoming request's options keyed by their `attr` name
   * (e.g. `vendorClassId` for option 60) and returns `null` to suppress the
   * option for that client — the only value the option writer skips.
   */
  export type DhcpConfigValue<T> = T | ((requestOptions: Record<string, unknown>) => T | null);

  export interface ServerConfig {
    readonly range: [string, string];
    readonly forceOptions?: string[];
    readonly randomIP?: boolean;
    readonly static?: Record<string, string> | ((clientMAC: string, req: any) => string | undefined);
    readonly netmask?: string;
    readonly router?: string[];
    readonly dns?: string[];
    readonly hostname?: string;
    readonly domainName?: string;
    readonly broadcast?: string;
    readonly server?: string;
    readonly leaseTime?: number;
    readonly renewalTime?: number;
    readonly rebindingTime?: number;
    /** Option 67 — bootfile name. */
    readonly bootFile?: DhcpConfigValue<string>;
    /** Option 66 — TFTP server name. */
    readonly tftpServer?: DhcpConfigValue<string>;
    /** Option 43 — vendor-specific info, already TLV-encoded to raw bytes. */
    readonly vendor?: DhcpConfigValue<number[]>;
    /**
     * Option 150 — Cisco TFTP server list. Not shipped by the library; the
     * key exists only after `addOption(150, …)` registers it (see
     * `ensureCiscoTftpOptionRegistered` in `DhcpEngine.ts`).
     */
    readonly tftpServerAddresses?: DhcpConfigValue<string[]>;
  }

  export interface LeaseState {
    readonly bindTime?: Date;
    readonly leasePeriod: number;
    readonly renewPeriod: number;
    readonly rebindPeriod: number;
    readonly state: string;
    readonly server: string;
    readonly address: string;
    readonly options?: Record<string, any>;
    readonly tries: number;
    readonly xid: number;
    readonly leaseTime?: number;
  }

  export interface ServerEvents {
    listening: [sock: Socket];
    close: [];
    error: [err: Error, data?: any];
    message: [req: any];
    bound: [state: Record<string, LeaseState>];
  }

  export interface ClientEvents {
    listening: [sock: Socket];
    close: [];
    error: [err: Error, data?: any];
    message: [req: any];
    bound: [state: LeaseState];
    released: [];
  }

  export class Server extends EventEmitter {
    public constructor(config: ServerConfig | null, listenOnly?: boolean);
    public listen(port?: number, host?: string, cb?: () => void): void;
    public close(cb?: (err?: Error) => void): void;
    public on<E extends keyof ServerEvents>(
      event: E,
      listener: (...args: ServerEvents[E]) => void,
    ): this;
    public once<E extends keyof ServerEvents>(
      event: E,
      listener: (...args: ServerEvents[E]) => void,
    ): this;
    public off<E extends keyof ServerEvents>(
      event: E,
      listener: (...args: ServerEvents[E]) => void,
    ): this;
    public readonly _sock: Socket;
    public readonly _conf: ServerConfig | null;
    public readonly _state: Record<string, LeaseState>;
  }

  export class Client extends EventEmitter {
    public constructor(config?: any);
    public listen(port?: number, host?: string, cb?: () => void): void;
    public close(cb?: (err?: Error) => void): void;
    public sendDiscover(): void;
    public sendRequest(req: any): void;
    public sendRelease(req: any): void;
    public sendRenew(): void;
    public sendRebind(): void;
    public on<E extends keyof ClientEvents>(
      event: E,
      listener: (...args: ClientEvents[E]) => void,
    ): this;
  }

  export const DHCPDISCOVER: 1;
  export const DHCPOFFER: 2;
  export const DHCPREQUEST: 3;
  export const DHCPDECLINE: 4;
  export const DHCPACK: 5;
  export const DHCPNAK: 6;
  export const DHCPRELEASE: 7;
  export const DHCPINFORM: 8;

  export function createServer(cfg?: ServerConfig): Server;
  export function createClient(cfg?: any): Client;
  export function createBroadcastHandler(): Server;
  export function addOption(id: number, def: { config: string; type: string; name: string }): void;
}
