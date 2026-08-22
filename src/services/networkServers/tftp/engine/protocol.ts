/** @author kanekitakitos */
/**
 * @author kanekitakitos
 *
 * Binary encoding and parsing (serialization/deserialization) of TFTP packets.
 *
 * GPL clean-room implementation. Per RFC 1350 §4:
 *   - All multi-byte integers use network byte order (big-endian).
 *   - Strings are null-terminated ASCII.
 *   - RRQ/WRQ have format: [2B opcode] | filename | 0 | mode | 0 | [opt|0|val|0]*
 *   - DATA has format: [2B opcode] | [2B block#] | data (up to blksize octets)
 *   - ACK  has format: [2B opcode] | [2B block#]
 *   - ERROR: [2B opcode] | [2B errorCode] | errMsg | 0
 *   - OACK (RFC 2347): [2B opcode] | [opt|0|val|0]*
 *
 * Supported RFCs:
 *   - RFC 1350: core parsing/encoding (RRQ, WRQ, DATA, ACK, ERROR)
 *   - RFC 2347: OACK + option negotiation (RRQ/WRQ options extension)
 *   - RFC 2348: "blksize" option validation
 *   - RFC 2349: "timeout" and "tsize" options validation
 *   - RFC 7440: "windowsize" option validation
 *
 * @module
 */

import {
  Opcode,
  ErrorCode,
  ERROR_MESSAGES,
  DEFAULT_BLOCK_SIZE,
  DEFAULT_WINDOW_SIZE,
  OPTION_LIMITS,
  MAX_IN_FLIGHT_BYTES,
  DATA_HEADER_LEN,
  type RawOptions,
  type ValidatedOptions,
  type OptionName,
  type TransferMode,
  type TftpPacket,
  type RRQPacket,
  type WRQPacket,
  type DATAPacket,
  type ACKPacket,
  type ERRORPacket,
  type OACKPacket,
} from './types';

/**
 * Error thrown when a received packet violates the TFTP protocol syntax.
 *
 * Indicates an unrecoverable problem at the wire format level (not transfer
 * state) — typically handled by emitting ERROR(IllegalOperation) to the
 * client and aborting the session.
 */
export class ProtocolError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'ProtocolError';
  }
}

const KNOWN_OPTIONS: Set<OptionName> = new Set(['blksize', 'timeout', 'tsize', 'windowsize']);
const VALID_MODES: Set<TransferMode> = new Set(['netascii', 'octet']);

/**
 * Splits a buffer into ASCII tokens separated by null bytes (0x00).
 *
 * Used to extract filename/mode/options from RRQ, WRQ and OACK.
 *
 * @param buf Buffer containing the series of null-terminated strings.
 * @returns Array of strings (without the null bytes).
 */
function splitNullStrings(buf: Buffer): string[] {
  const parts: string[] = [];
  let start = 0;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0) {
      parts.push(buf.toString('ascii', start, i));
      start = i + 1;
    }
  }
  if (start < buf.length) {
    parts.push(buf.toString('ascii', start));
  }
  return parts;
}

/**
 * Writes an ASCII string followed by a null byte into `buf` starting at `offset`.
 *
 * @param buf Destination buffer (pre-allocated).
 * @param offset Initial write position.
 * @param str String to write (ASCII).
 * @returns New offset immediately after the null terminator.
 */
function writeNullString(buf: Buffer, offset: number, str: string): number {
  const len = buf.write(str, offset, 'ascii');
  offset += len;
  buf.writeUInt8(0, offset);
  return offset + 1;
}

/**
 * Serializes an option map (key/value) into null-separated ASCII pairs.
 *
 * @param buf Destination buffer.
 * @param offset Initial write position.
 * @param opts Raw option map.
 * @returns New offset after the last pair.
 */
function writeOptionPairs(buf: Buffer, offset: number, opts: RawOptions): number {
  for (const [key, value] of Object.entries(opts)) {
    if (value === undefined) continue;
    offset = writeNullString(buf, offset, key);
    offset = writeNullString(buf, offset, value);
  }
  return offset;
}

/**
 * Calculates the bytes needed to serialize an option map.
 *
 * @param opts Options to serialize.
 * @returns Number of occupied octets (including null terminators).
 */
function optionPairsLen(opts: RawOptions): number {
  let len = 0;
  for (const [key, value] of Object.entries(opts)) {
    if (value === undefined) continue;
    len += key.length + 1 + value.length + 1;
  }
  return len;
}

/**
 * Parses the key/value option pairs coming from RRQ/WRQ/OACK.
 *
 * Unknown options are silently ignored (RFC 2347 §3: "unknown
 * options are ignored").
 *
 * @param payload Buffer containing only the option bytes (after filename/mode).
 * @returns {@link RawOptions} object with only recognized options.
 * @throws {ProtocolError} if the list has an odd number of tokens.
 */
function parseOptionPairs(payload: Buffer): RawOptions {
  const parts = splitNullStrings(payload);
  if (parts.length > 0 && parts[parts.length - 1] === '') parts.pop();
  if (parts.length % 2 !== 0) {
    throw new ProtocolError('Malformed option list (odd token count)');
  }
  const opts: RawOptions = {};
  for (let i = 0; i < parts.length; i += 2) {
    const key = (parts[i] as string).toLowerCase() as OptionName;
    const value = parts[i + 1] as string;
    if (KNOWN_OPTIONS.has(key)) opts[key] = value;
  }
  return opts;
}

/**
 * Extracts the opcode (first 2 BE bytes) from a raw UDP datagram.
 *
 * @param buf Buffer received from the socket.
 * @returns Opcode or `undefined` if the buffer is too short (<2B).
 */
export function getOpcode(buf: Buffer): Opcode | undefined {
  if (buf.length < 2) return undefined;
  return buf.readUInt16BE(0) as Opcode;
}

/**
 * Encodes an RRQ (Read Request) packet.
 *
 * @param filename File path (as sent by the client).
 * @param mode     "netascii" or "octet".
 * @param opts     Extension options (RFC 2347+) to negotiate.
 * @returns Buffer with the complete datagram (2B opcode + payload).
 */
export function encodeRRQ(filename: string, mode: string, opts: RawOptions = {}): Buffer {
  const body = filename.length + 1 + mode.length + 1 + optionPairsLen(opts);
  const buf = Buffer.alloc(2 + body);
  let off = 0;
  buf.writeUInt16BE(Opcode.RRQ, off);
  off = 2;
  off = writeNullString(buf, off, filename);
  off = writeNullString(buf, off, mode);
  writeOptionPairs(buf, off, opts);
  return buf;
}

/**
 * Encodes a WRQ (Write Request) packet.
 *
 * Binary structure identical to RRQ; only the opcode differs.
 *
 * @param filename File path to write.
 * @param mode     "netascii" or "octet".
 * @param opts     Extension options (RFC 2347+).
 * @returns Buffer with the complete datagram.
 */
export function encodeWRQ(filename: string, mode: string, opts: RawOptions = {}): Buffer {
  const body = filename.length + 1 + mode.length + 1 + optionPairsLen(opts);
  const buf = Buffer.alloc(2 + body);
  let off = 0;
  buf.writeUInt16BE(Opcode.WRQ, off);
  off = 2;
  off = writeNullString(buf, off, filename);
  off = writeNullString(buf, off, mode);
  writeOptionPairs(buf, off, opts);
  return buf;
}

/**
 * Encodes a DATA packet containing a block.
 *
 * The length of `data` must be ≤ blksize; a packet with length
 * `< blksize` signals the last block of the transfer (RFC 1350 §9).
 *
 * @param blockNum Block number (1..65535, wrap-around after 65535).
 * @param data     Block payload (0..blksize octets).
 * @returns Buffer [opcode|blockNum|data].
 */
export function encodeDATA(blockNum: number, data: Buffer): Buffer {
  const buf = Buffer.alloc(DATA_HEADER_LEN + data.length);
  buf.writeUInt16BE(Opcode.DATA, 0);
  buf.writeUInt16BE(blockNum, 2);
  data.copy(buf, 4);
  return buf;
}

/**
 * Encodes an ACK (acknowledgment) packet.
 *
 * @param blockNum Acknowledged block number (or 0 for initial WRQ/OACK ACK).
 * @returns 4-octet buffer.
 */
export function encodeACK(blockNum: number): Buffer {
  const buf = Buffer.alloc(4);
  buf.writeUInt16BE(Opcode.ACK, 0);
  buf.writeUInt16BE(blockNum, 2);
  return buf;
}

/**
 * Encodes an ERROR packet.
 *
 * @param code    Error code (RFC 1350 §5.1).
 * @param message Optional descriptive message; if omitted uses {@link ERROR_MESSAGES}.
 * @returns Complete buffer with the ERROR packet.
 */
export function encodeERROR(code: ErrorCode, message?: string): Buffer {
  const msg = message ?? ERROR_MESSAGES[code];
  const msgLen = Buffer.byteLength(msg, 'ascii');
  const buf = Buffer.alloc(2 + 2 + msgLen + 1);
  buf.writeUInt16BE(Opcode.ERROR, 0);
  buf.writeUInt16BE(code, 2);
  writeNullString(buf, 4, msg);
  return buf;
}

/**
 * Encodes an OACK (Option Acknowledgment — RFC 2347 §3) packet.
 *
 * Contains only the options actually negotiated by the server.
 *
 * @param opts Validated options converted to raw format.
 * @returns Buffer [2B OACK opcode | option pairs].
 */
export function encodeOACK(opts: RawOptions): Buffer {
  const len = optionPairsLen(opts);
  const buf = Buffer.alloc(2 + len);
  buf.writeUInt16BE(Opcode.OACK, 0);
  writeOptionPairs(buf, 2, opts);
  return buf;
}

/**
 * Parses an RRQ or WRQ (they share the same payload format).
 *
 * @param opcode  Discriminator opcode (RRQ or WRQ).
 * @param payload Packet bytes excluding the 2 opcode bytes.
 * @returns Packet typed as RRQ or WRQ.
 * @throws {ProtocolError} in case of missing fields, invalid mode or empty filename.
 */
function parseRRQorWRQ(
  opcode: Opcode.RRQ | Opcode.WRQ,
  payload: Buffer,
): RRQPacket | WRQPacket {
  const parts = splitNullStrings(payload);
  if (parts.length > 0 && parts[parts.length - 1] === '') parts.pop();
  if (parts.length < 2) throw new ProtocolError(`${opcode === Opcode.RRQ ? 'RRQ' : 'WRQ'} too short`);
  const filename = parts[0] as string;
  if (!filename) throw new ProtocolError('Empty filename');
  const mode = (parts[1] as string).toLowerCase();
  if (!VALID_MODES.has(mode as TransferMode)) {
    throw new ProtocolError(`Unknown mode: ${mode}`);
  }
  // `netascii` (RFC 1350 §2) is not a labelling convention — it is a transform:
  // the sender rewrites its host line endings to CR/LF on the wire and the
  // receiver rewrites them back. This engine does neither; RRQ and WRQ are raw
  // byte operations end to end. Accepting the mode therefore corrupted every
  // text transfer between hosts with different line conventions, silently, with
  // both sides believing the transfer succeeded.
  //
  // Refusing is the honest answer, and it costs nothing in this product's
  // actual use: network devices fetch and store images and configs in `octet`.
  // A client that asks for netascii gets a specific error and can retry in
  // binary, which is what it wanted anyway.
  if (mode === 'netascii') {
    throw new ProtocolError('Unsupported mode: netascii (this server implements octet only)');
  }
  const optionTokens = parts.slice(2);
  if (optionTokens.length % 2 !== 0) throw new ProtocolError('Malformed option list');
  const options: RawOptions = {};
  for (let i = 0; i < optionTokens.length; i += 2) {
    const key = (optionTokens[i] as string).toLowerCase() as OptionName;
    const value = optionTokens[i + 1] as string;
    if (KNOWN_OPTIONS.has(key)) options[key] = value;
  }
  return {
    opcode,
    filename,
    mode: mode as TransferMode,
    options,
  } as RRQPacket | WRQPacket;
}

/**
 * Parses a complete TFTP datagram (including opcode).
 *
 * @param buf Buffer received from the UDP socket.
 * @returns Corresponding typed packet, or `undefined` for unknown opcode.
 * @throws {ProtocolError} if the format is invalid (short, missing fields, etc.).
 */
export function parsePacket(buf: Buffer): TftpPacket | undefined {
  const op = getOpcode(buf);
  if (op === undefined) throw new ProtocolError('Packet too short');
  const payload = buf.subarray(2);
  switch (op) {
    case Opcode.RRQ:
      return parseRRQorWRQ(Opcode.RRQ, payload) as RRQPacket;
    case Opcode.WRQ:
      return parseRRQorWRQ(Opcode.WRQ, payload) as WRQPacket;
    case Opcode.DATA: {
      if (payload.length < 2) throw new ProtocolError('DATA too short');
      return {
        opcode: Opcode.DATA,
        blockNum: payload.readUInt16BE(0),
        data: Buffer.from(payload.subarray(2)),
      } satisfies DATAPacket;
    }
    case Opcode.ACK: {
      if (payload.length < 2) throw new ProtocolError('ACK too short');
      return { opcode: Opcode.ACK, blockNum: payload.readUInt16BE(0) } satisfies ACKPacket;
    }
    case Opcode.ERROR: {
      if (payload.length < 2) throw new ProtocolError('ERROR too short');
      const code = payload.readUInt16BE(0) as ErrorCode;
      const rest = payload.subarray(2);
      const nullIdx = rest.indexOf(0);
      const message = (nullIdx >= 0 ? rest.subarray(0, nullIdx) : rest).toString('ascii');
      return { opcode: Opcode.ERROR, errorCode: code, message } satisfies ERRORPacket;
    }
    case Opcode.OACK: {
      if (payload.length === 0) return { opcode: Opcode.OACK, options: {} } satisfies OACKPacket;
      return { opcode: Opcode.OACK, options: parseOptionPairs(payload) } satisfies OACKPacket;
    }
    default:
      return undefined;
  }
}

/**
 * Validates and converts raw options (strings) to usable numeric values.
 *
 * Applies the limits from RFCs 2348/2349/7440. Missing values use the
 * provided defaults or the protocol ones (blksize=512, windowsize=1).
 *
 * @param raw      Options as they arrive in an RRQ/WRQ/OACK.
 * @param defaults Default values to apply when the option is not present.
 * @returns Validated and typed options.
 * @throws {ProtocolError} if any value is invalid or out of bounds.
 */
export function validateOptions(
  raw: RawOptions,
  defaults: Partial<ValidatedOptions> = {},
): ValidatedOptions {
  const out: ValidatedOptions = {
    blksize: defaults.blksize ?? DEFAULT_BLOCK_SIZE,
    windowsize: defaults.windowsize ?? DEFAULT_WINDOW_SIZE,
    timeout: defaults.timeout,
    tsize: defaults.tsize,
  };
  if (raw.blksize !== undefined) {
    const v = parseInt(raw.blksize, 10);
    if (Number.isNaN(v) || v < OPTION_LIMITS.blksize.min || v > OPTION_LIMITS.blksize.max) {
      throw new ProtocolError(
        `Invalid blksize: ${raw.blksize} (${OPTION_LIMITS.blksize.min}-${OPTION_LIMITS.blksize.max})`,
      );
    }
    out.blksize = v;
  }
  if (raw.timeout !== undefined) {
    const v = parseInt(raw.timeout, 10);
    if (Number.isNaN(v) || v < OPTION_LIMITS.timeout.min || v > OPTION_LIMITS.timeout.max) {
      throw new ProtocolError(
        `Invalid timeout: ${raw.timeout} (${OPTION_LIMITS.timeout.min}-${OPTION_LIMITS.timeout.max})`,
      );
    }
    out.timeout = v;
  }
  if (raw.tsize !== undefined) {
    const v = parseInt(raw.tsize, 10);
    if (Number.isNaN(v) || v < 0) throw new ProtocolError(`Invalid tsize: ${raw.tsize}`);
    out.tsize = v;
  }
  if (raw.windowsize !== undefined) {
    const v = parseInt(raw.windowsize, 10);
    if (
      Number.isNaN(v) ||
      v < OPTION_LIMITS.windowsize.min ||
      v > OPTION_LIMITS.windowsize.max
    ) {
      throw new ProtocolError(
        `Invalid windowsize: ${raw.windowsize} (${OPTION_LIMITS.windowsize.min}-${OPTION_LIMITS.windowsize.max})`,
      );
    }
    out.windowsize = v;
  }
  // RFC 2347 §2 lets the server answer an option with a value the client must
  // then use, and RFC 7440 §3 names windowsize explicitly as one the server may
  // lower. So a window whose bytes exceed the in-flight budget is clamped here
  // rather than refused: the transfer still runs, just with a window the server
  // can afford to allocate. Clamping windowsize (and not blksize) is deliberate
  // — blksize is what a client picks to match its MTU, and shrinking it below
  // that would fragment every datagram of the transfer.
  //
  // This is the single place option values become numbers, so the clamp lands
  // before anything can read them — including `validatedToRaw`, which is what
  // the OACK is built from. Clamping later (say, in the engine) would answer
  // the client with the value it asked for and then use a different one.
  const maxWindow = Math.max(1, Math.floor(MAX_IN_FLIGHT_BYTES / out.blksize));
  if (out.windowsize > maxWindow) out.windowsize = maxWindow;
  return out;
}

/**
 * Converts validated options back to the raw (string) format used in OACK.
 *
 * Only includes options that differ from the protocol defaults, reducing
 * the OACK datagram size.
 *
 * @param opts Validated options of the session.
 * @returns Subset of options in string format for OACK serialization.
 */
export function validatedToRaw(opts: ValidatedOptions): RawOptions {
  const raw: RawOptions = {};
  if (opts.blksize !== DEFAULT_BLOCK_SIZE) raw.blksize = String(opts.blksize);
  if (opts.timeout !== undefined) raw.timeout = String(opts.timeout);
  if (opts.tsize !== undefined) raw.tsize = String(opts.tsize);
  if (opts.windowsize !== DEFAULT_WINDOW_SIZE) raw.windowsize = String(opts.windowsize);
  return raw;
}
