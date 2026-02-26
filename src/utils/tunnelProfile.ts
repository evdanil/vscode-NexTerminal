import type { TunnelProfile } from "../models/config";
import { resolveTunnelType } from "../models/config";

export function resolveBrowserUrl(profile: TunnelProfile): string {
  const bindHost = profile.localBindAddress && profile.localBindAddress !== "127.0.0.1" && profile.localBindAddress !== "0.0.0.0"
    ? profile.localBindAddress : "localhost";
  const template = profile.browserUrl || `https://${bindHost}:{localPort}`;
  const url = template.replace(/\{localPort\}/g, String(profile.localPort));
  try {
    const scheme = new URL(url).protocol.replace(/:$/, "");
    if (scheme === "http" || scheme === "https") {
      return url;
    }
  } catch {
    // malformed URL — fall through to default
  }
  return `https://${bindHost}:${profile.localPort}`;
}

export function formatTunnelRoute(profile: TunnelProfile): string {
  const type = resolveTunnelType(profile);
  switch (type) {
    case "reverse": {
      const targetIP = profile.localTargetIP ?? "127.0.0.1";
      return `R ${profile.remotePort} <- ${targetIP}:${profile.localPort}`;
    }
    case "dynamic": {
      const dynamicBind = profile.localBindAddress && profile.localBindAddress !== "127.0.0.1"
        ? `${profile.localBindAddress}:` : ":";
      return `D ${dynamicBind}${profile.localPort} SOCKS5`;
    }
    default: {
      const localBind = profile.localBindAddress && profile.localBindAddress !== "127.0.0.1"
        ? `${profile.localBindAddress}:${profile.localPort}` : `${profile.localPort}`;
      return `L ${localBind} -> ${profile.remoteIP}:${profile.remotePort}`;
    }
  }
}

export function isTunnelRouteChanged(before: TunnelProfile, after: TunnelProfile): boolean {
  return (
    before.localPort !== after.localPort ||
    before.remoteIP !== after.remoteIP ||
    before.remotePort !== after.remotePort ||
    resolveTunnelType(before) !== resolveTunnelType(after) ||
    before.remoteBindAddress !== after.remoteBindAddress ||
    before.localTargetIP !== after.localTargetIP ||
    before.localBindAddress !== after.localBindAddress
  );
}
