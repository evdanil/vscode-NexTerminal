import type { TunnelProfile } from "../models/config";
import { resolveTunnelType } from "../models/config";

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
