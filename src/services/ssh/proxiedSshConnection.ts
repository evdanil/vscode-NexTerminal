import type { Duplex } from "node:stream";
import type { SFTPWrapper } from "ssh2";
import type { PtyOptions, SshConnection, TcpConnectionInfo } from "./contracts";
import type { Socket } from "node:net";

export class ProxiedSshConnection implements SshConnection {
  public constructor(
    private readonly inner: SshConnection,
    private readonly proxyCleanup: () => void
  ) {}

  public openShell(ptyOptions?: PtyOptions): Promise<Duplex> {
    return this.inner.openShell(ptyOptions);
  }

  public openDirectTcp(remoteIP: string, remotePort: number): Promise<Duplex> {
    return this.inner.openDirectTcp(remoteIP, remotePort);
  }

  public openSftp(): Promise<SFTPWrapper> {
    return this.inner.openSftp();
  }

  public exec(command: string): Promise<Duplex> {
    return this.inner.exec(command);
  }

  public requestForwardIn(bindAddr: string, bindPort: number): Promise<number> {
    return this.inner.requestForwardIn(bindAddr, bindPort);
  }

  public cancelForwardIn(bindAddr: string, bindPort: number): Promise<void> {
    return this.inner.cancelForwardIn(bindAddr, bindPort);
  }

  public onTcpConnection(
    handler: (info: TcpConnectionInfo, accept: () => Duplex, reject: () => void) => void
  ): () => void {
    return this.inner.onTcpConnection(handler);
  }

  public onClose(listener: () => void): () => void {
    return this.inner.onClose(listener);
  }

  public dispose(): void {
    this.inner.dispose();
    this.proxyCleanup();
  }
}

export function jumpHostCleanup(jumpConnection: SshConnection): () => void {
  return () => jumpConnection.dispose();
}

export function socketCleanup(socket: Socket | Duplex): () => void {
  return () => {
    if ("destroy" in socket && typeof socket.destroy === "function") {
      socket.destroy();
    }
  };
}
