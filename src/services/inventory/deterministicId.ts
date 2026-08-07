import { createHash } from "node:crypto";

/**
 * Fixed namespace UUID for the name-based UUIDv8 ids minted for
 * inventory-synced servers. Never change this value — doing so would silently
 * re-mint every previously-synced server's id on the next sync (treated as a
 * brand-new device by every consumer keyed on ServerConfig.id).
 */
export const INVENTORY_ID_NAMESPACE = "5f6b0f89-6d3e-4f8e-9c1a-2b7d9e4a1c33";

function uuidToBytes(uuid: string): Buffer {
  return Buffer.from(uuid.replace(/-/g, ""), "hex");
}

function bytesToUuid(bytes: Buffer): string {
  const hex = bytes.toString("hex");
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20, 32)].join("-");
}

/**
 * Deterministic id for a server materialized from an inventory device, so
 * re-syncing the same (source, externalId) pair always upserts the same
 * ServerConfig.id rather than accumulating duplicates.
 *
 * Name-based deterministic id in UUIDv8 (RFC 9562 §5.8, custom/name-based)
 * format, derived via SHA-256. Stability is the whole contract here: the
 * namespace, the name-composition scheme, and the hash algorithm must never
 * change once released — server ids derived from this function key saved
 * passwords, tunnel defaults, and jump-host references.
 *
 * Name is `${sourceId.length}:${sourceId}:${externalId}` rather than a bare
 * `sourceId:externalId` concatenation — sourceId is a user-editable inventory
 * source id (not guaranteed `:`-free like a randomUUID), so without a length
 * prefix two different (sourceId, externalId) splits of the same joined
 * string could collide (e.g. "a:b" + "c" vs "a" + "b:c").
 */
export function deterministicServerId(sourceId: string, externalId: string): string {
  const name = `${sourceId.length}:${sourceId}:${externalId}`;
  const digest = createHash("sha256").update(Buffer.concat([uuidToBytes(INVENTORY_ID_NAMESPACE), Buffer.from(name, "utf8")])).digest();
  const bytes = Buffer.from(digest.subarray(0, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x80; // version 8
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant RFC 4122
  return bytesToUuid(bytes);
}
