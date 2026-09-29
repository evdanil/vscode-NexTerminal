import { flattenProviderText } from "../../models/inventory";

/**
 * The warning shown when the sidecar could not release a port whose open the
 * extension had already given up on. The path comes from the device list / user
 * profile, so it is flattened like other untrusted text before it is composed
 * into a message.
 */
export function buildPortReleaseFailedMessage(portPath: string): string {
  const name = flattenProviderText(portPath) || "a serial port";
  return `Nexus could not release ${name} after a timed-out open, so it may stay busy for other connections. Reload Window restarts the serial sidecar and frees it (or unplug and replug the device).`;
}
