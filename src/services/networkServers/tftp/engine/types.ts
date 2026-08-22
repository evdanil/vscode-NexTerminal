/** @author kanekitakitos */
/**
 * @author kanekitakitos
 *
 * Fundamental types and constants of the TFTP protocol for Nexus-tools.
 *
 * GPL clean-room implementation based on the following RFCs:
 *   - RFC 1350  - TFTP Protocol (Revision 2)       : opcode, base packet types, ERROR codes 0-7
 *   - RFC 2347  - TFTP Option Extension            : OACK/RFC option negotiation mechanism
 *   - RFC 2348  - TFTP Blocksize Option            : blksize (8–65464)
 *   - RFC 2349  - TFTP Timeout Interval and Transfer Size Options : timeout + tsize
 *   - RFC 7440  - TFTP Windowsize Option           : windowsize (sliding window selective ACK)
 *
 * Why GPL clean-room: the Node.js TFTP ecosystem is dominated by libraries
 * inherited from unlicensed code or permissive licenses with chronic bugs
 * (15s timeout, no windowsize, path traversal, etc.). The in-house implementation
 * guarantees full auditing, strict RFC compliance, and the possibility
 * of GPL licensing aligned with the rest of Nexus-tools without third-party
 * copyright violation.
 */

/** Opcode of each TFTP message (RFC 1350 §4 + RFC 2347). */
export enum Opcode {
  RRQ = 1,
  WRQ = 2,
  DATA = 3,
  ACK = 4,
  ERROR = 5,
  OACK = 6,
}

/** Standard error codes (RFC 1350 §5.1 + RFC 2347). */
export enum ErrorCode {
  NotDefined = 0,
  FileNotFound = 1,
  AccessViolation = 2,
  DiskFull = 3,
  IllegalOperation = 4,
  UnknownTransferID = 5,
  FileAlreadyExists = 6,
  NoSuchUser = 7,
  OptionNegotiation = 8,
}

/** Human-readable messages per error code (RFC 1350 §5.1). */
export const ERROR_MESSAGES: Record<ErrorCode, string> = {
  [ErrorCode.NotDefined]: 'Not defined, see error message.',
  [ErrorCode.FileNotFound]: 'File not found.',
  [ErrorCode.AccessViolation]: 'Access violation.',
  [ErrorCode.DiskFull]: 'Disk full or allocation exceeded.',
  [ErrorCode.IllegalOperation]: 'Illegal TFTP operation.',
  [ErrorCode.UnknownTransferID]: 'Unknown transfer ID.',
  [ErrorCode.FileAlreadyExists]: 'File already exists.',
  [ErrorCode.NoSuchUser]: 'No such user.',
  [ErrorCode.OptionNegotiation]: 'Option negotiation failed.',
};

/** Supported transfer mode (RFC 1350 §1). */
export type TransferMode = 'netascii' | 'octet';

/** Default block-size (RFC 1350) — 512 octets. */
export const DEFAULT_BLOCK_SIZE = 512;

/** Default window-size (RFC 7440) — 1 = classic stop-and-wait. */
export const DEFAULT_WINDOW_SIZE = 1;

/** Strict limits of negotiable options (RFCs 2348/2349/7440). */
export const OPTION_LIMITS = {
  blksize: { min: 8, max: 65464 } as const,
  timeout: { min: 1, max: 255 } as const,
  windowsize: { min: 1, max: 65535 } as const,
} as const;

/**
 * Ceiling on `blksize * windowsize` — the bytes one session may hold in flight.
 *
 * The two options are individually bounded by their RFCs but their PRODUCT is
 * not, and that product is what gets allocated: `produceNextSendPackets` builds
 * a whole window of DATA buffers in memory before any of it is sent. At the
 * RFC maxima an unauthenticated client can ask for 65464 * 65535 ≈ 4.3 GB in a
 * single RRQ, and `maxTransfers` sessions can each ask for it — so the option
 * negotiation of one datagram is a remote OOM.
 *
 * 1 MiB is chosen because it is far above what any real client uses and far
 * below what hurts: RFC 7440 windows in the field are 4–64 blocks, and even a
 * jumbo-frame blksize of 8192 still leaves room for 128 of them. At the
 * absolute maximum blksize (65464) it still permits a 16-block window, so the
 * clamp never degrades a transfer to stop-and-wait. Worst case across the
 * default 64-session pool is 64 MiB rather than unbounded.
 */
export const MAX_IN_FLIGHT_BYTES = 1024 * 1024;

/** Names of options recognized by the engine. */
export type OptionName = 'blksize' | 'timeout' | 'tsize' | 'windowsize';

/** Options as they arrive in RRQ/WRQ/OACK (raw strings). */
export type RawOptions = Partial<Record<OptionName, string>>;

/** Validated options converted to usable numeric values. */
export interface ValidatedOptions {
  blksize: number;
  windowsize: number;
  timeout?: number;
  tsize?: number;
}

/** RRQ packet — read request. */
export interface RRQPacket {
  readonly opcode: Opcode.RRQ;
  readonly filename: string;
  readonly mode: TransferMode;
  readonly options: RawOptions;
}

/** WRQ packet — write request. */
export interface WRQPacket {
  readonly opcode: Opcode.WRQ;
  readonly filename: string;
  readonly mode: TransferMode;
  readonly options: RawOptions;
}

/** DATA packet — data block (RFC 1350 §5). */
export interface DATAPacket {
  readonly opcode: Opcode.DATA;
  readonly blockNum: number;
  readonly data: Buffer;
}

/** ACK packet — block acknowledgment (RFC 1350 §5). */
export interface ACKPacket {
  readonly opcode: Opcode.ACK;
  readonly blockNum: number;
}

/** ERROR packet — fatal transfer error (RFC 1350 §5.1). */
export interface ERRORPacket {
  readonly opcode: Opcode.ERROR;
  readonly errorCode: ErrorCode;
  readonly message: string;
}

/** OACK packet — Option ACK (RFC 2347 §3). */
export interface OACKPacket {
  readonly opcode: Opcode.OACK;
  readonly options: RawOptions;
}

/** Union of all known TFTP packets. */
export type TftpPacket = RRQPacket | WRQPacket | DATAPacket | ACKPacket | ERRORPacket | OACKPacket;

/** Length of the DATA header (2 bytes opcode + 2 bytes blockNum). */
export const DATA_HEADER_LEN = 4;
