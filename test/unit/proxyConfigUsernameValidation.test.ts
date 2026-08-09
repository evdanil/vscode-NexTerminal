import { describe, expect, it } from "vitest";
import { validateDeviceTemplate, validateProxyConfig } from "../../src/utils/validation";

/**
 * DEVICE TEMPLATES (issue #48 PR-T1 / PR #61 Codex review round 12, P2) —
 * `validateProxyConfig` must reject a socks5/http proxy whose optional
 * `username` is present but not a string. An imported template (or server
 * record) carrying a non-string username used to pass validation, be stamped
 * fleet-wide, and only then crash at connect (`username.replace(...)` for HTTP;
 * an invalid user id for SOCKS). Since `validateProxyConfig` also backs
 * `validateDeviceTemplate`'s `fields.proxy` and `isValidTemplatedStamps`, the
 * template-import and origin-stamp paths inherit the check.
 *
 * Each malformed-username fixture below FAILS against the pre-round-12 code
 * (which validated only `host`+`port` for socks5/http) and passes only once the
 * `username` guard is added.
 */
describe("validateProxyConfig — optional username must be a string (round 12, P2)", () => {
  it("socks5 with a string username is valid", () => {
    expect(validateProxyConfig({ type: "socks5", host: "10.9.9.1", port: 1080, username: "puser" })).toBe(true);
  });

  it("socks5 with username undefined (omitted) is valid", () => {
    expect(validateProxyConfig({ type: "socks5", host: "10.9.9.1", port: 1080 })).toBe(true);
  });

  it("http with a string username is valid", () => {
    expect(validateProxyConfig({ type: "http", host: "proxy.example", port: 8080, username: "puser" })).toBe(true);
  });

  it("http with username undefined (omitted) is valid", () => {
    expect(validateProxyConfig({ type: "http", host: "proxy.example", port: 8080 })).toBe(true);
  });

  // MUST FAIL against pre-round-12 code (a non-string username was accepted).
  it("socks5 with a NUMBER username is rejected", () => {
    expect(validateProxyConfig({ type: "socks5", host: "10.9.9.1", port: 1080, username: 42 })).toBe(false);
  });

  it("socks5 with an OBJECT username is rejected", () => {
    expect(validateProxyConfig({ type: "socks5", host: "10.9.9.1", port: 1080, username: { u: "x" } })).toBe(false);
  });

  it("http with a NUMBER username is rejected", () => {
    expect(validateProxyConfig({ type: "http", host: "proxy.example", port: 8080, username: 42 })).toBe(false);
  });

  // Over-rejection guard: an ssh jump proxy has no username field and is unaffected.
  it("ssh jump proxy (no username field) is unaffected", () => {
    expect(validateProxyConfig({ type: "ssh", jumpHostId: "bastion-1" })).toBe(true);
  });
});

describe("validateDeviceTemplate — a template proxy with a malformed username is rejected on import (round 12, P2)", () => {
  function template(proxyValue: unknown) {
    return { id: "tmpl-1", name: "T", fields: { proxy: { mode: "override", value: proxyValue } } };
  }

  it("a socks5 template proxy with a string username is accepted", () => {
    expect(validateDeviceTemplate(template({ type: "socks5", host: "10.9.9.1", port: 1080, username: "puser" }))).toBe(true);
  });

  // MUST FAIL against pre-round-12 code (accepted, then stamped fleet-wide).
  it("a socks5 template proxy whose username is a NUMBER is rejected", () => {
    expect(validateDeviceTemplate(template({ type: "socks5", host: "10.9.9.1", port: 1080, username: 42 }))).toBe(false);
  });

  it("a socks5 template proxy whose username is an OBJECT is rejected", () => {
    expect(validateDeviceTemplate(template({ type: "socks5", host: "10.9.9.1", port: 1080, username: { u: "x" } }))).toBe(false);
  });

  it("an http template proxy whose username is a NUMBER is rejected", () => {
    expect(validateDeviceTemplate(template({ type: "http", host: "proxy.example", port: 8080, username: 42 }))).toBe(false);
  });
});
