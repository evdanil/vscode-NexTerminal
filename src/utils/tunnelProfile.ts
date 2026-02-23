import type { TunnelProfile } from "../models/config";
import { resolveTunnelType } from "../models/config";

export function resolveBrowserUrl(profile: TunnelProfile): string {
  const template = profile.browserUrl || "https://localhost:{localPort}";
  const url = template.replace(/\{localPort\}/g, String(profile.localPort));
  try {
    const scheme = new URL(url).protocol.replace(/:$/, "");
    if (scheme === "http" || scheme === "https") {
      return url;
    }
  } catch {
    // malformed URL — fall through to default
  }
  return `https://localhost:${profile.localPort}`;
}

export function isTunnelRouteChanged(before: TunnelProfile, after: TunnelProfile): boolean {
  return (
    before.localPort !== after.localPort ||
    before.remoteIP !== after.remoteIP ||
    before.remotePort !== after.remotePort ||
    resolveTunnelType(before) !== resolveTunnelType(after) ||
    before.remoteBindAddress !== after.remoteBindAddress ||
    before.localTargetIP !== after.localTargetIP
  );
}
