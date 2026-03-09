import type { Duplex } from "node:stream";
import type { SFTPWrapper } from "ssh2";
import type { PtyOptions, SshConnection, TcpConnectionInfo } from "./contracts";
import type { Socket } from "node:net";

type CloseRelay = (listener: () => void) => () => void;

export class ProxiedSshConnection implements SshConnection {
  private readonly closeListeners = new Set<() => void>();
  private readonly innerCloseUnsubscribe: () => void;
  private readonly proxyCloseUnsubscribe?: () => void;
  private closed = false;

  public constructor(
    private readonly inner: SshConnection,
    private readonly proxyCleanup: () => void,
    proxyOnClose?: CloseRelay
  ) {
    this.innerCloseUnsubscribe = this.inner.onClose(() => {
      this.emitClose();
    });
    this.proxyCloseUnsubscribe = proxyOnClose?.(() => {
      this.emitClose();
    });
  }

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
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  public getBanner(): string | undefined {
    return this.inner.getBanner();
  }

  public dispose(): void {
    this.innerCloseUnsubscribe();
    this.proxyCloseUnsubscribe?.();
    this.inner.dispose();
    this.proxyCleanup();
  }

  private emitClose(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    for (const listener of this.closeListeners) {
      listener();
    }
  }
}

export function jumpHostCleanup(jumpConnection: SshConnection): () => void {
  return () => jumpConnection.dispose();
}

export function socketCleanup(socket: Socket | Duplex): () => void {
  return () => socket.destroy();
}

export function socketCloseRelay(socket: Socket | Duplex): CloseRelay {
  return (listener) => {
    let notified = false;
    const notify = (): void => {
      if (notified) {
        return;
      }
      notified = true;
      listener();
    };
    socket.on("close", notify);
    socket.on("end", notify);
    socket.on("error", notify);
    return () => {
      socket.removeListener("close", notify);
      socket.removeListener("end", notify);
      socket.removeListener("error", notify);
    };
  };
}
