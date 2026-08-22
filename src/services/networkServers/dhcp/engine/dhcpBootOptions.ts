/** @author kanekitakitos */
/**
 * @author kanekitakitos
 *
 * Pure protocol helpers for the DHCP options that make Zero-Touch
 * Provisioning work: 66 (TFTP server name), 67 (bootfile name), 150 (Cisco
 * TFTP server address list), 60 (vendor class identifier) and 43
 * (vendor-specific information).
 *
 * **Why a separate file:** everything here is byte-level encoding and input
 * validation with no dependency on the `dhcp` library, on sockets or on
 * `vscode`. That makes each function testable in isolation — which matters
 * most for {@link encodeVendorSpecificInfo}, where a single off-by-one in a
 * length byte produces a packet a device silently ignores.
 *
 * @module
 */

/** Option code carrying the TFTP server name (RFC 2132 §9.4). */
export const DHCP_OPTION_TFTP_SERVER_NAME = 66;
/** Option code carrying the bootfile name (RFC 2132 §9.5). */
export const DHCP_OPTION_BOOTFILE_NAME = 67;
/** Option code a client uses to identify its vendor (RFC 2132 §9.13). */
export const DHCP_OPTION_VENDOR_CLASS_ID = 60;
/** Option code carrying vendor-specific information (RFC 2132 §8.4). */
export const DHCP_OPTION_VENDOR_SPECIFIC = 43;
/** Cisco-proprietary option carrying a list of TFTP server IPv4 addresses. */
export const DHCP_OPTION_CISCO_TFTP_SERVERS = 150;

/** A DHCP option's value field is length-prefixed by a single byte. */
export const MAX_OPTION_VALUE_BYTES = 255;

/**
 * One TLV entry inside option 43.
 *
 * `value` is either a hex literal (`0x0A0B`, separators `: - _` and spaces
 * tolerated) or, when it does not start with `0x`, a plain string encoded as
 * UTF-8 bytes.
 */
export interface DhcpVendorSpecificEntry {
  readonly subOption: number;
  readonly value: string;
}

const HEX_PREFIX = /^0x/i;
const HEX_BODY = /^[0-9a-f]*$/i;
const HEX_SEPARATORS = /[\s:_-]/g;

/**
 * Sub-option codes 0 and 255 are reserved by the option encoding itself —
 * 0 is PAD and 255 is END — so neither can carry a value.
 */
export function isValidSubOptionCode(code: number): boolean {
  return Number.isInteger(code) && code >= 1 && code <= 254;
}

/**
 * Converts a user-supplied option value into the bytes that go on the wire.
 *
 * @throws {Error} When a `0x` literal contains non-hex characters or an odd
 *   number of digits (which would silently drop or invent half a byte).
 */
export function parseVendorOptionValue(raw: string): Buffer {
  if (!HEX_PREFIX.test(raw)) {
    return Buffer.from(raw, 'utf8');
  }
  const body = raw.slice(2).replace(HEX_SEPARATORS, '');
  if (!HEX_BODY.test(body)) {
    throw new Error(`Invalid hex value "${raw}": only 0-9 and a-f are allowed after the 0x prefix.`);
  }
  if (body.length % 2 !== 0) {
    throw new Error(`Invalid hex value "${raw}": ${body.length} digits is not a whole number of bytes.`);
  }
  return Buffer.from(body, 'hex');
}

/**
 * Encodes option 43's payload as the repeated
 * `[sub-option code][length][value…]` sequence described by RFC 2132 §8.4.
 *
 * There is no envelope around the sequence: the option code and the overall
 * length byte belong to the surrounding DHCP option header, which the packet
 * writer adds. Every field here is a single byte, so no byte order applies.
 *
 * @throws {Error} On an out-of-range sub-option code, a value longer than 255
 *   bytes, or a total payload that cannot fit a single DHCP option.
 */
export function encodeVendorSpecificInfo(entries: readonly DhcpVendorSpecificEntry[]): Buffer {
  const chunks: Buffer[] = [];
  for (const entry of entries) {
    if (!isValidSubOptionCode(entry.subOption)) {
      throw new Error(
        `Invalid option 43 sub-option code ${entry.subOption}: expected an integer between 1 and 254 (0 is PAD, 255 is END).`,
      );
    }
    const value = parseVendorOptionValue(entry.value);
    if (value.length > MAX_OPTION_VALUE_BYTES) {
      throw new Error(
        `Option 43 sub-option ${entry.subOption} is ${value.length} bytes; the length field carries at most ${MAX_OPTION_VALUE_BYTES}.`,
      );
    }
    const tlv = Buffer.alloc(2 + value.length);
    tlv.writeUInt8(entry.subOption, 0);
    tlv.writeUInt8(value.length, 1);
    value.copy(tlv, 2);
    chunks.push(tlv);
  }

  const encoded = Buffer.concat(chunks);
  if (encoded.length > MAX_OPTION_VALUE_BYTES) {
    throw new Error(
      `Option 43 payload is ${encoded.length} bytes; a single DHCP option carries at most ${MAX_OPTION_VALUE_BYTES}. Remove or shorten sub-options.`,
    );
  }
  return encoded;
}

/**
 * Decides whether the boot options apply to the client behind a request.
 *
 * **Deliberate v1 limitation:** a single global vendor class, not a set of
 * per-vendor profiles. With `configured` empty every client gets the boot
 * options; with it set, only clients whose option 60 matches do, and everyone
 * else gets an address and nothing else. Serving two vendors different
 * bootfiles from one instance is out of scope.
 *
 * The comparison is trimmed and case-insensitive but otherwise exact —
 * `Cisco` does not match `Cisco Systems, Inc.`. The observed value is logged
 * on every DISCOVER so the exact string can be copied from the log.
 */
export function matchesVendorClass(configured: string | undefined, observed: unknown): boolean {
  const expected = configured?.trim();
  if (!expected) return true;
  if (typeof observed !== 'string') return false;
  return observed.trim().toLowerCase() === expected.toLowerCase();
}
