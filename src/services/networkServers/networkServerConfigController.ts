import {
  ServerStatus,
  type DhcpAdapterConfig,
  type ServerManager,
  type TftpAdapterConfig,
} from "./core/index";

export type NetworkServerConfigStore = {
  tftp?: TftpAdapterConfig;
  dhcp?: DhcpAdapterConfig;
};

export type ConfigurableNetworkServerId = "tftp" | "dhcp";

/**
 * Publishes daemon configuration and keeps a cached idle adapter from being
 * reused after that configuration changes.
 */
export class NetworkServerConfigController {
  private readonly staleConfigIds = new Set<ConfigurableNetworkServerId>();

  public constructor(
    private readonly manager: Pick<ServerManager, "getInstance" | "dropInstance">,
    private readonly configStore: NetworkServerConfigStore,
  ) {}

  public requiresEviction(id: ConfigurableNetworkServerId): boolean {
    return this.staleConfigIds.has(id);
  }

  /** Drops an idle owner, retaining its staleness if cleanup must be retried. */
  public async evictIfIdle(id: ConfigurableNetworkServerId): Promise<void> {
    const instance = this.manager.getInstance(id);
    if (!instance) {
      this.staleConfigIds.delete(id);
      return;
    }
    if (instance.status === ServerStatus.RUNNING || instance.status === ServerStatus.STARTING) {
      this.staleConfigIds.add(id);
      return;
    }

    // Configuration is already published for the next factory invocation.
    // Keep the old owner marked stale until disposal has actually succeeded,
    // otherwise an equal-config retry could restart that owner as though it
    // had been constructed from the new configuration.
    this.staleConfigIds.add(id);
    await this.manager.dropInstance(id);
    this.staleConfigIds.delete(id);
  }

  /** Publishes one service configuration and evicts any idle cached owner. */
  public async apply(
    id: ConfigurableNetworkServerId,
    config: TftpAdapterConfig | DhcpAdapterConfig,
  ): Promise<boolean> {
    const current = id === "tftp" ? this.configStore.tftp : this.configStore.dhcp;
    if (JSON.stringify(current ?? null) === JSON.stringify(config)) return false;

    if (id === "tftp") this.configStore.tftp = config as TftpAdapterConfig;
    else this.configStore.dhcp = config as DhcpAdapterConfig;
    await this.evictIfIdle(id);
    return true;
  }
}
