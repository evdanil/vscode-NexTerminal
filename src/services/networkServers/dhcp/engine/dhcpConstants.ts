/** @author kanekitakitos */

/**
 * Constants shared by the DHCP module: bind ports, configuration defaults
 * and DHCP message type mapping (option 53).
 */

/** Official IANA DHCP server port (requires root/Administrator). */
export const DEFAULT_PORT = 67;
/** Alternate port used when elevated privileges do not exist. */
export const FALLBACK_ALT_PORT = 1067;

/** Engine defaults when the user does not provide configuration. */
export const DEFAULTS = {
  rangeStart: '192.168.2.10',
  rangeEnd: '192.168.2.199',
  subnet: '255.255.255.0',
  gateway: '192.168.2.1',
  dns: ['8.8.8.8', '8.8.4.4'] as const,
  leaseTimeSec: 86400,
  serverId: '192.168.2.1',
  broadcast: '192.168.2.255',
} as const;

/** DHCP message number mapping (option 53) → human name. */
export const DHCP_MESSAGE_NAMES: Readonly<Record<number, string>> = {
  1: 'DHCPDISCOVER',
  2: 'DHCPOFFER',
  3: 'DHCPREQUEST',
  4: 'DHCPDECLINE',
  5: 'DHCPACK',
  6: 'DHCPNAK',
  7: 'DHCPRELEASE',
  8: 'DHCPINFORM',
};
