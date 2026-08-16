/**
 * Domain models for named TFTP/DHCP configuration profiles ("presets").
 *
 * A profile is **not** a second runtime model. The two embedded services stay
 * configured entirely through `nexus.networkServers.{tftp,dhcp}.*`, and the
 * daemon, the manager and the tree view keep reading those settings exactly as
 * before. A profile is a named snapshot of one service's fields that can be
 * written back *into* those same settings later — save a bench setup once,
 * restore it next week without retyping a pool.
 *
 * TFTP and DHCP keep independent lists. A bench swaps its address pool far more
 * often than its file root, and pairing the two would force a re-save of one
 * service every time the other changed.
 *
 * Shapes are additive-only, like every other ConfigRepository record: every
 * field post-v1 is optional so profiles written by older builds round-trip
 * cleanly under the whole-object storage discipline (profiles are stored as an
 * opaque JSON array under a single globalState key).
 */

import type { DhcpAdapterConfig, DhcpVendorSpecificEntry, TftpAdapterConfig } from "../services/networkServers/core/index";

export interface TftpConfigProfile {
  id: string;
  kind: "tftp";
  name: string;
  description?: string;
  config: TftpAdapterConfig;
}

export interface DhcpConfigProfile {
  id: string;
  kind: "dhcp";
  name: string;
  description?: string;
  config: DhcpAdapterConfig;
  /**
   * `nexus.networkServers.dhcp.autoLinkTftp` — a setting, but not an adapter
   * field, so it has no home inside `config`. Kept beside it because applying a
   * profile has to restore the *switch*: by the time `readDhcpConfig` returns,
   * the link has already been resolved into `nextServer`/`tftpServerAddresses`,
   * and writing only those back would silently freeze whatever address the link
   * happened to point at when the profile was saved.
   */
  autoLinkTftp?: boolean;
}

/** Either service's profile, discriminated by `kind`. */
export type NetworkServerConfigProfile = TftpConfigProfile | DhcpConfigProfile;

/**
 * Shallow structural clone. `TftpAdapterConfig` owns no nested objects at all,
 * so recreating the config object is sufficient for the snapshot discipline
 * NexusCore's stores rely on.
 */
export function cloneTftpProfile(profile: TftpConfigProfile): TftpConfigProfile {
  return { ...profile, config: { ...profile.config } };
}

/**
 * Same discipline as {@link cloneTftpProfile}, one level deeper: the DHCP
 * config carries four collection fields, recreated here so a stored profile can
 * never share an array or a map with a caller's object. Entries inside
 * `vendorSpecificOptions` are flat `{ subOption, value }` pairs, so copying the
 * array is enough — this mirrors what `DhcpAdapter`'s own constructor does.
 */
export function cloneDhcpProfile(profile: DhcpConfigProfile): DhcpConfigProfile {
  const config = profile.config;
  return {
    ...profile,
    config: {
      ...config,
      dns: config.dns ? [...config.dns] : config.dns,
      static: config.static ? { ...config.static } : config.static,
      tftpServerAddresses: config.tftpServerAddresses ? [...config.tftpServerAddresses] : config.tftpServerAddresses,
      vendorSpecificOptions: config.vendorSpecificOptions ? [...config.vendorSpecificOptions] : config.vendorSpecificOptions
    }
  };
}

export function tftpProfilesEqual(a: TftpConfigProfile, b: TftpConfigProfile): boolean {
  if (a.id !== b.id) return false;
  if (a.name !== b.name) return false;
  if (a.description !== b.description) return false;
  return (
    a.config.root === b.config.root &&
    a.config.port === b.config.port &&
    a.config.allowWrite === b.config.allowWrite &&
    a.config.interface === b.config.interface
  );
}

export function dhcpProfilesEqual(a: DhcpConfigProfile, b: DhcpConfigProfile): boolean {
  if (a.id !== b.id) return false;
  if (a.name !== b.name) return false;
  if (a.description !== b.description) return false;
  if (a.autoLinkTftp !== b.autoLinkTftp) return false;
  const left = a.config;
  const right = b.config;
  if (
    left.rangeStart !== right.rangeStart ||
    left.rangeEnd !== right.rangeEnd ||
    left.subnet !== right.subnet ||
    left.gateway !== right.gateway ||
    left.leaseTimeSec !== right.leaseTimeSec ||
    left.serverId !== right.serverId ||
    left.broadcast !== right.broadcast ||
    left.bindAddress !== right.bindAddress ||
    left.leaseStorePath !== right.leaseStorePath ||
    left.bootFileName !== right.bootFileName ||
    left.nextServer !== right.nextServer ||
    left.vendorClassId !== right.vendorClassId
  ) {
    return false;
  }
  return (
    stringListsEqual(left.dns, right.dns) &&
    stringListsEqual(left.tftpServerAddresses, right.tftpServerAddresses) &&
    stringMapsEqual(left.static, right.static) &&
    vendorOptionsEqual(left.vendorSpecificOptions, right.vendorSpecificOptions)
  );
}

function stringListsEqual(a: readonly string[] | undefined, b: readonly string[] | undefined): boolean {
  const left = a ?? [];
  const right = b ?? [];
  if (left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
}

function stringMapsEqual(
  a: Readonly<Record<string, string>> | undefined,
  b: Readonly<Record<string, string>> | undefined
): boolean {
  const left = a ?? {};
  const right = b ?? {};
  const leftKeys = Object.keys(left);
  if (leftKeys.length !== Object.keys(right).length) return false;
  return leftKeys.every((key) => left[key] === right[key]);
}

function vendorOptionsEqual(
  a: readonly DhcpVendorSpecificEntry[] | undefined,
  b: readonly DhcpVendorSpecificEntry[] | undefined
): boolean {
  const left = a ?? [];
  const right = b ?? [];
  if (left.length !== right.length) return false;
  return left.every((entry, index) => entry.subOption === right[index].subOption && entry.value === right[index].value);
}
