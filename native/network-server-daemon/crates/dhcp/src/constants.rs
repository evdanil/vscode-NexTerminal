//! Ports, packaged defaults, option codes and the message-type vocabulary.

use std::net::Ipv4Addr;

/// IANA DHCP server port. Privileged on every supported platform.
pub const DEFAULT_PORT: u16 = 67;
/// Unprivileged fallback, used when 67 is refused for lack of privilege.
pub const FALLBACK_ALT_PORT: u16 = 1067;
/// IANA DHCP client port — where an OFFER/ACK is sent.
pub const CLIENT_PORT: u16 = 68;

/// Packaged defaults, matching `dhcpConstants.ts` value for value.
pub const DEFAULT_RANGE_START: Ipv4Addr = Ipv4Addr::new(192, 168, 2, 10);
pub const DEFAULT_RANGE_END: Ipv4Addr = Ipv4Addr::new(192, 168, 2, 199);
pub const DEFAULT_SUBNET: Ipv4Addr = Ipv4Addr::new(255, 255, 255, 0);
pub const DEFAULT_GATEWAY: Ipv4Addr = Ipv4Addr::new(192, 168, 2, 1);
pub const DEFAULT_SERVER_ID: Ipv4Addr = Ipv4Addr::new(192, 168, 2, 1);
pub const DEFAULT_BROADCAST: Ipv4Addr = Ipv4Addr::new(192, 168, 2, 255);
pub const DEFAULT_DNS: [Ipv4Addr; 2] = [Ipv4Addr::new(8, 8, 8, 8), Ipv4Addr::new(8, 8, 4, 4)];
pub const DEFAULT_LEASE_SECS: u32 = 86_400;
/// Maximum dynamic pool size accepted by the extension host runtime parser.
pub const MAX_DHCP_POOL_SIZE: u32 = 65_536;
/// Maximum static reservations accepted by the same parser, mirroring
/// `MAX_STATIC_RESERVATIONS` in `networkServerConfigValidation.ts`. A
/// reservation outside the dynamic range adds a lease the pool size does not
/// account for, so both bounds are needed to size the lease file.
pub const MAX_STATIC_RESERVATIONS: u32 = 1_024;
/// Byte ceiling the extension host puts on every DHCP lease string field,
/// mirroring `MAX_DHCP_FIELD_BYTES` in `networkServerRpcProtocol.ts`.
///
/// The host rejects the entire runtime response when one field exceeds it, and
/// treats that as a protocol failure — which terminates a running daemon. So
/// this is not a display preference: nothing above it may be allowed to reach a
/// lease, whether it came off the wire or out of the lease file.
pub const MAX_DHCP_FIELD_BYTES: usize = 255;

// -- Option codes (RFC 2132) ------------------------------------------------

pub const OPTION_PAD: u8 = 0;
pub const OPTION_SUBNET_MASK: u8 = 1;
pub const OPTION_ROUTER: u8 = 3;
pub const OPTION_DNS: u8 = 6;
pub const OPTION_HOSTNAME: u8 = 12;
pub const OPTION_BROADCAST: u8 = 28;
/// Vendor-specific information, TLV-encoded (RFC 2132 §8.4).
pub const OPTION_VENDOR_SPECIFIC: u8 = 43;
pub const OPTION_REQUESTED_IP: u8 = 50;
pub const OPTION_LEASE_TIME: u8 = 51;
/// Which BOOTP fixed fields also carry options (RFC 2131 §4.1.3).
pub const OPTION_OVERLOAD: u8 = 52;
pub const OPTION_MESSAGE_TYPE: u8 = 53;
pub const OPTION_SERVER_ID: u8 = 54;
pub const OPTION_PARAMETER_REQUEST_LIST: u8 = 55;
pub const OPTION_MESSAGE: u8 = 56;
pub const OPTION_MAX_MESSAGE_SIZE: u8 = 57;
pub const OPTION_RENEWAL_TIME: u8 = 58;
pub const OPTION_REBINDING_TIME: u8 = 59;
/// Vendor class identifier — the option 60 the boot-option gate matches on.
pub const OPTION_VENDOR_CLASS_ID: u8 = 60;
pub const OPTION_CLIENT_ID: u8 = 61;
/// TFTP server name (RFC 2132 §9.4).
pub const OPTION_TFTP_SERVER_NAME: u8 = 66;
/// Bootfile name (RFC 2132 §9.5).
pub const OPTION_BOOTFILE_NAME: u8 = 67;
/// Cisco-proprietary list of TFTP server addresses.
pub const OPTION_CISCO_TFTP_SERVERS: u8 = 150;
pub const OPTION_END: u8 = 255;

/// A DHCP option's value field is length-prefixed by a single byte.
pub const MAX_OPTION_VALUE_BYTES: usize = 255;

/// BOOTP operation codes.
pub const OP_BOOTREQUEST: u8 = 1;
pub const OP_BOOTREPLY: u8 = 2;

/// `htype` for 10 Mb Ethernet — the only hardware type served.
pub const HTYPE_ETHERNET: u8 = 1;
/// Length of an Ethernet hardware address.
pub const ETHERNET_HLEN: u8 = 6;

/// The broadcast bit of the `flags` field (RFC 2131 §2).
pub const FLAG_BROADCAST: u16 = 0x8000;

/// Human name for a DHCP message type, for logs.
#[must_use]
pub fn message_type_name(code: u8) -> &'static str {
    match code {
        1 => "DHCPDISCOVER",
        2 => "DHCPOFFER",
        3 => "DHCPREQUEST",
        4 => "DHCPDECLINE",
        5 => "DHCPACK",
        6 => "DHCPNAK",
        7 => "DHCPRELEASE",
        8 => "DHCPINFORM",
        _ => "DHCPUNKNOWN",
    }
}
