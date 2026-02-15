import type { TunnelProfile } from "../models/config";

export function isTunnelRouteChanged(before: TunnelProfile, after: TunnelProfile): boolean {
  return (
    before.localPort !== after.localPort ||
    before.remoteIP !== after.remoteIP ||
    before.remotePort !== after.remotePort
  );
}
