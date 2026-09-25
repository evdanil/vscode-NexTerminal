import type { ServerConfig } from "../../models/config";
import { underlyingConnection } from "./sshConnectionPool";
import type { SshConnection } from "./contracts";

export interface EndpointRouteIdentity {
  readonly hosts: readonly string[];
  readonly port: number;
}

export type NetworkRouteIdentity =
  | { readonly kind: "direct"; readonly endpoint: EndpointRouteIdentity }
  | { readonly kind: "cycle"; readonly serverId: string; readonly endpoint: EndpointRouteIdentity }
  | { readonly kind: "unresolved"; readonly serverId: string }
  | { readonly kind: "ssh"; readonly endpoint: EndpointRouteIdentity; readonly jump: NetworkRouteIdentity }
  | {
      readonly kind: "socks5" | "http";
      readonly proxyHost: string;
      readonly proxyPort: number;
      readonly endpoint: EndpointRouteIdentity;
    };

const connectionRoutes = new WeakMap<SshConnection, NetworkRouteIdentity>();

/**
 * Endpoint aliases are kept together because an alternate address can create
 * the pooled transport that later serves a tunnel started from the primary
 * server record.
 */
export function networkEndpointIdentity(
  server: ServerConfig,
  aliasSource: ServerConfig = server
): EndpointRouteIdentity {
  const hosts = [server.host, server.altHost, aliasSource.host, aliasSource.altHost]
    .filter((host): host is string => typeof host === "string" && host.trim().length > 0)
    .map((host) => host.trim().toLowerCase());
  return {
    hosts: [...new Set(hosts)].sort(),
    port: server.port
  };
}

/**
 * Builds the configured route used as a fallback for non-route-aware factories.
 * Production SSH connections are tagged with the immutable route their transport
 * actually used by ProxySshFactory.
 */
export function networkRouteIdentity(
  server: ServerConfig,
  serverLookup: ((id: string) => ServerConfig | undefined) | undefined,
  visited = new Set<string>(),
  aliasSource: ServerConfig = server
): NetworkRouteIdentity {
  const endpoint = networkEndpointIdentity(server, aliasSource);
  if (visited.has(server.id)) {
    return { kind: "cycle", serverId: server.id, endpoint };
  }
  const nextVisited = new Set(visited);
  nextVisited.add(server.id);

  const proxy = server.proxy;
  if (!proxy) {
    return { kind: "direct", endpoint };
  }
  if (proxy.type === "ssh") {
    const jumpHost = serverLookup?.(proxy.jumpHostId);
    return {
      kind: "ssh",
      endpoint,
      jump: jumpHost
        ? networkRouteIdentity(jumpHost, serverLookup, nextVisited)
        : { kind: "unresolved", serverId: proxy.jumpHostId }
    };
  }
  // Proxy credentials may select separate egress routes, so this can
  // serialize independent backends. The key protects the SSH server's
  // server-wide bind namespace; omitting username avoids racing two credentials
  // that reach the same proxy and SSH endpoint.
  return { kind: proxy.type, proxyHost: proxy.host.toLowerCase(), proxyPort: proxy.port, endpoint };
}

export function endpointRoutesOverlap(left: EndpointRouteIdentity, right: EndpointRouteIdentity): boolean {
  return left.port === right.port && left.hosts.some((host) => right.hosts.includes(host));
}

export function networkRoutesOverlap(left: NetworkRouteIdentity, right: NetworkRouteIdentity): boolean {
  if (left.kind !== right.kind) {
    return false;
  }

  switch (left.kind) {
    case "direct":
      return right.kind === "direct" && endpointRoutesOverlap(left.endpoint, right.endpoint);
    case "cycle":
      return right.kind === "cycle" && left.serverId === right.serverId && endpointRoutesOverlap(left.endpoint, right.endpoint);
    case "unresolved":
      return right.kind === "unresolved" && left.serverId === right.serverId;
    case "ssh":
      return right.kind === "ssh" && endpointRoutesOverlap(left.endpoint, right.endpoint) && networkRoutesOverlap(left.jump, right.jump);
    case "socks5":
    case "http":
      return (
        right.kind === left.kind &&
        left.proxyHost === right.proxyHost &&
        left.proxyPort === right.proxyPort &&
        endpointRoutesOverlap(left.endpoint, right.endpoint)
      );
  }
}

export function rememberSshNetworkRoute(connection: SshConnection, route: NetworkRouteIdentity): void {
  connectionRoutes.set(underlyingConnection(connection), route);
}

export function getSshNetworkRoute(connection: SshConnection): NetworkRouteIdentity | undefined {
  return connectionRoutes.get(underlyingConnection(connection));
}
