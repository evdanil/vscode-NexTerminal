# Network Server Daemon Protocol

**Protocol version: 1.1.0**

Changes since 1.0.0: DHCP is now implemented (§6.4-6.6 replace the earlier
"not implemented in this build" section). Backwards-compatible — the wire
shapes in §5.3/§5.4 were already fully specified; a host built against 1.0.0
already handles them correctly and simply starts receiving real success
responses instead of `NOT_IMPLEMENTED` where it previously did not.

This document is the interop contract between the Nexus extension host (the
*host*) and the network-server *daemon* — the out-of-process supervisor for the
embedded TFTP and DHCP services.

It is written to be implementation-independent. Either side can be built from
this document alone: the host is currently TypeScript
(`src/services/networkServers/daemonHost.ts`), the daemon is currently Node
(`src/services/networkServers/networkServerDaemon.ts`) and is being reimplemented
in Rust (`native/network-server-daemon/`). Nothing below depends on either
language.

Everything in this document is normative unless a paragraph is explicitly marked
as rationale. Where the wording says MUST / MUST NOT, an implementation that
violates it will break the other side in a way the other side cannot detect.

---

## 1. Transport and framing

The daemon is a child process. All control traffic flows over its standard
streams; **no network port is used for control**, deliberately — a pipe never
collides with a user-occupied port and never raises a host firewall prompt.

| Stream | Direction | Content |
| --- | --- | --- |
| `stdin` | host → daemon | Requests, one JSON object per line |
| `stdout` | daemon → host | Responses and events, one JSON object per line |
| `stderr` | daemon → host | Free-form diagnostics, not parsed |

### 1.1 Line framing

* Each message is exactly one UTF-8 JSON **object**, followed by `U+000A` (`\n`).
* A message MUST NOT contain a raw newline. JSON string escaping (`\n`,
  `\r`, ` `) makes this automatic for every conforming serializer; a
  daemon MUST NOT hand-assemble JSON in a way that could emit a literal newline
  inside a value.
* A trailing `\r` before the `\n` MUST be tolerated by both readers (a
  CRLF-normalising pipe on Windows).
* Blank lines and whitespace-only lines MUST be ignored, not treated as errors.
* A line that is not valid JSON MUST be ignored with a warning, never fatal.
  The host emits a `warn` log; the daemon emits a `log` event.
* Readers MUST bound the length of a single line. The daemon rejects any line
  longer than **8 MiB** (see §7.3). This is not theoretical politeness: an
  unbounded line reader turns one malformed write into an out-of-memory abort of
  a process that is holding privileged UDP sockets.

### 1.2 Message discrimination

A reader classifies each parsed object by shape, in this order:

1. **Response** — has a numeric `id` **and** either an own `result` key (of any
   type, including `null`) or an `error` object carrying a string `message`.
2. **Event** — has a string `event` **and** an own `data` key (of any type,
   including `null`).
3. Anything else is unknown and MUST be ignored with a warning.

> **Critical serialization consequence.** Because discrimination tests for *key
> presence*, not for a non-null value, a serializer that omits null-valued keys
> will produce messages the other side silently drops. `{"event":"ready"}` is
> **not** a valid `ready` event; `{"event":"ready","data":null}` is. Likewise a
> result of `null` MUST be written as `"result":null`, never omitted.

### 1.3 Character encoding

All three streams are UTF-8. Log messages and error strings are free text and
MAY contain any Unicode scalar value; they MUST NOT contain lone surrogates.
The daemon MUST NOT emit a byte sequence that is not valid UTF-8 on `stdout`.

---

## 2. Message shapes

### 2.1 Request (host → daemon)

```jsonc
{ "id": 7, "method": "start", "params": { "id": "tftp" } }
```

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `id` | integer | yes | Correlation id. Monotonically increasing, starts at 1, unique within a daemon lifetime. |
| `method` | string | yes | One of §3. |
| `params` | object | no | Method-specific. Absent and `{}` are equivalent. |

A request whose `id` is not a number, or whose `method` is not a string, MUST be
ignored with a warning and MUST NOT produce a response — there is no id to
answer to. This is deliberate: fabricating a response for a request with no
usable id could resolve an unrelated pending call.

Note that this protocol is **not** JSON-RPC 2.0. There is no `jsonrpc` member,
notifications-from-host do not exist, and batching is not supported. The shape
is JSON-RPC-*like* purely for familiarity.

### 2.2 Response (daemon → host)

Success:

```jsonc
{ "id": 7, "result": { "ok": true, "id": "tftp" } }
```

Failure:

```jsonc
{ "id": 7, "error": { "code": "NOT_FOUND", "message": "Server 'ftp' not found." } }
```

| Field | Type | Notes |
| --- | --- | --- |
| `id` | integer | Echoes the request's `id` exactly. |
| `result` | any | Present on success. May be `null`. Mutually exclusive with `error`. |
| `error.code` | string | Machine-readable, from the closed set in §2.3. |
| `error.message` | string | Human-readable. Surfaced to the user verbatim; MUST NOT contain secrets or absolute paths the user did not configure. |

The daemon MUST send exactly one response per well-formed request, and MUST NOT
send a response for an id it was never asked about. Responses MAY be emitted out
of order relative to request arrival; the host correlates purely by `id`.

### 2.3 Error codes

| Code | Meaning |
| --- | --- |
| `NOT_FOUND` | The named service id does not exist, or does not support the operation. |
| `METHOD_NOT_FOUND` | Unknown `method`. |
| `INVALID_PARAMS` | `params` is missing a required member or has the wrong type. |
| `NOT_IMPLEMENTED` | The service exists but this build does not implement it. No service currently reports this; the code is retained so a host stays forward-compatible with a build that ships a service in name only. |
| `INTERNAL_ERROR` | Anything else. `message` carries the underlying failure. |

The host maps `error.code` onto the thrown error's `name` and `error.message`
onto its `message`. New codes MAY be added in a minor version; a host MUST treat
an unrecognised code as equivalent to `INTERNAL_ERROR`.

### 2.4 Event (daemon → host)

```jsonc
{ "event": "statusChange", "data": { "id": "tftp", "status": "running" } }
```

Events are unsolicited and carry no `id` correlation. See §4.

---

## 3. Methods

Throughout, `<service-id>` is one of the fixed strings `"tftp"` or `"dhcp"`.
Service ids are a closed set in this version; there is no registration method.

### 3.1 `list`

**Params:** none.
**Result:** array of `ServerSnapshot` (§5.1), one per known service, including
services that have never been started.

Listing MUST NOT start, bind, or otherwise activate anything. It reports the
port a service *would* use, taken from current configuration.

### 3.2 `getStatus`

**Params:** `{ "id": <service-id> }`
**Result:** one `ServerSnapshot`.
**Errors:** `NOT_FOUND` when `id` names no known service.

### 3.3 `configure`

**Params:** `{ "configs": { "tftp"?: TftpConfig, "dhcp"?: DhcpConfig } }` (§5.4)
**Result:** `{ "ok": true, "changed": string[] }` — the service ids whose stored
configuration actually differs from what was already held.

Semantics:

* Absent keys are left alone. A `configure` carrying only `tftp` MUST NOT
  clobber stored DHCP configuration.
* Configuration is stored, not applied to a live service. A **running** service
  keeps serving under the configuration it was started with; the new values take
  effect on its next `start` (or `restart`). Silently rebuilding a live service
  would drop in-flight TFTP transfers and DHCP leases that the user did not ask
  to lose.
* A service that is **stopped** MUST be rebuilt from the new configuration on its
  next `start`. An implementation that caches a built service object MUST evict
  that cache here, and — if the service was running at `configure` time and so
  could not be evicted — MUST remember the pending eviction and perform it as
  soon as the service stops. Forgetting this is a real bug with a subtle
  signature: the value-equality short-circuit above means a later re-send of the
  same configuration reports `changed: []`, so the stale service is never
  rebuilt and the user's edit never takes effect.

### 3.4 `start`

**Params:** `{ "id": <service-id>, "config"?: TftpConfig | DhcpConfig }`
**Result:** `{ "ok": true, "id": <service-id> }`
**Errors:** `NOT_FOUND` for an unknown id; `INTERNAL_ERROR` when the service
fails to start (bind refused, root directory missing, …); `NOT_IMPLEMENTED`
for a service this build does not provide.

If `config` is present it is applied — scoped to this request's service id —
before the start, with the same semantics as `configure`. This is what makes
"start uses the settings the user is looking at right now" true without a daemon
restart.

`start` MUST be idempotent for a service already `running` or `starting`: it
returns success and does nothing.

> **A failed start MUST produce an `error` response.** It is not enough to move
> the service to `error` status and answer `{"ok":true}`. The host turns the
> rejection into a user-visible failure; without it the user is told the service
> started while the sidebar shows an error state, which is how a bind failure
> once became invisible.

### 3.5 `stop`

**Params:** `{ "id": <service-id> }`
**Result:** `{ "ok": true, "id": <service-id> }`

Idempotent. Stopping a service that was never started, or is already stopped, is
success. A stopped service MUST have released every socket and file handle it
held before the response is written.

### 3.6 `restart`

**Params:** `{ "id": <service-id>, "config"?: TftpConfig | DhcpConfig }`
**Result:** `{ "ok": true, "id": <service-id> }`

Equivalent to `stop` then `start`, **in that order, with any `config` applied
between the two**. Applying configuration before the stop would hit the
"refuse to evict a running service" rule in §3.3 and restart the service with
stale settings.

If the `stop` half fails, the `start` half MUST NOT be attempted and the error
is returned.

### 3.7 `cancelTransfer`

**Params:** `{ "id": "tftp", "transferId": string }`
**Result:** `{ "ok": boolean, "id": "tftp", "transferId": string }`
**Errors:** `NOT_FOUND` when `id` is any service other than `"tftp"` — only TFTP
has cancellable transfers.

`ok` is `true` when a live transfer with that id existed and was aborted, and
`false` when it had already finished on its own. `false` is a benign race (the
operator clicked Cancel as the last block landed), not an error.

Cancelling MUST NOT bring a service into existence: if TFTP has never been
started, the answer is `{"ok": false, …}`, not a lazily-constructed service.

Abort mechanics are defined by TFTP itself (RFC 1350 §2): the server sends one
ERROR packet, which the client must not acknowledge. There is no "aborted by
server" code in the RFC 1350 §5 table, so code `0` (Not defined) carries a
human-readable reason.

### 3.8 `getServiceRuntime`

**Params:** `{ "id": <service-id> }`
**Result:** service-specific, see §5.2 (TFTP) and §5.3 (DHCP).
**Errors:** `NOT_FOUND` for an unknown id or a service with no runtime view.

This is the payload a tree view renders from. It is a pull, answered on demand:
the daemon never pushes runtime state, it pushes only the `runtimeUpdate` hint
(§4.4) telling the host that pulling again is worthwhile.

---

## 4. Events

### 4.1 `ready`

```jsonc
{ "event": "ready", "data": null }
```

Emitted exactly once per daemon lifetime, as the last step of initialization.
See §7.2 for the ordering rules that make this meaningful.

### 4.2 `statusChange`

```jsonc
{ "event": "statusChange", "data": { "id": "tftp", "status": "running" } }
{ "event": "statusChange", "data": { "id": "tftp", "status": "error", "error": "UDP port 69 is already in use." } }
```

`data.status` is a `ServerStatus` (§5.1). `data.error` is present only when
`status` is `"error"`.

Emitted on every lifecycle transition, including the ones driven by an RPC the
host itself issued. The host does not infer state from RPC results; this event
is the authority.

### 4.3 `log`

```jsonc
{ "event": "log", "data": { "id": "tftp", "level": "info", "message": "Download started: boot.img (192.168.2.7:52001)" } }
```

`data.id` is a service id, or the literal `"daemon"` for the daemon process
itself. `data.level` is one of `trace`, `debug`, `info`, `warn`, `error`. An
unrecognised level MUST be tolerated by the host (treated as `info`).

### 4.4 `runtimeUpdate`

```jsonc
{ "event": "runtimeUpdate", "data": { "id": "tftp" } }
```

"Something in this service's mutable runtime changed; call
`getServiceRuntime` if you are displaying it." Carries no state.

**Coalescing is required, and it must be trailing-edge.** The engines emit one
runtime change per acknowledged TFTP block, which at a negotiated `blksize` near
1400 bytes on a fast LAN is thousands of events per second — one JSON line each,
every one describing a state no human can perceive at that rate. The daemon
therefore coalesces per service id over a **100 ms** window.

Trailing edge specifically: the notification carries only an id, so it is useful
only if it arrives *after* the change it announces. A leading-edge throttle would
announce the first block of a burst and then stay silent through the rest,
freezing the host's view mid-transfer.

**Terminal updates bypass the window.** A transfer that completed or failed has
just left the runtime, and that disappearance must not wait out a window that
later pushes keep extending — that is how a finished transfer ends up stuck in
the sidebar forever. The daemon MUST emit these immediately, and MUST flush all
pending windows during shutdown before its listeners go away.

### 4.5 `connection`

```jsonc
{
  "event": "connection",
  "data": {
    "id": "tftp",
    "connection": {
      "phase": "completed",
      "summary": "Download finished from 192.168.2.7 · boot.img (4194304 B in 3s)",
      "id": "192.168.2.7:52001",
      "resource": "boot.img",
      "client": "192.168.2.7"
    }
  }
}
```

One event per client-facing lifecycle **edge**: a TFTP transfer opened, finished
or failed; a DHCP lease granted or declined.

**This is deliberately not a progress feed.** `runtimeUpdate` already fires per
progress tick. Consumers of `connection` are expected to surface exactly one
user-visible message per emission — a notification, a history row — so the
daemon MUST emit only at edges, never per packet or per block, and MUST NOT
coalesce these events. Folding two together drops one the host is contracted to
show one-for-one.

`ServerConnectionEvent` fields (§5.5): `summary` is what a consumer *shows* and
is pre-formatted by the daemon, because only the daemon knows the protocol's
vocabulary. `id` / `resource` / `client` are the same facts in a form a consumer
can *store* — a transfer-history list needs a filename on its own, and parsing it
back out of a sentence assembled for a human breaks the moment that sentence is
reworded.

---

## 5. Data types

### 5.1 `ServerSnapshot` and `ServerStatus`

```jsonc
{ "id": "tftp", "name": "TFTP Server", "port": 69, "status": "running" }
```

| Field | Type | Notes |
| --- | --- | --- |
| `id` | string | Service id. |
| `name` | string | Human-friendly display name. |
| `port` | integer | The *configured* port — what the service will bind, not necessarily what it did bind. Compare `boundPort` in §5.2 for the difference. |
| `status` | `ServerStatus` | See below. |
| `errorMessage` | string? | Present only when `status` is `"error"`. |

`ServerStatus` is the closed set
`"stopped" | "starting" | "running" | "stopping" | "error"`.

### 5.2 TFTP runtime (`getServiceRuntime` result for `"tftp"`)

```jsonc
{
  "snapshot":   { "id": "tftp", "name": "TFTP Server", "port": 69, "status": "running" },
  "transfers":  [ /* TftpTransferView[] */ ],
  "root":       "/home/u/Nexus/tftp-root",
  "allowWrite": false,
  "boundPort":  1069
}
```

`boundPort` is the port actually held by the UDP socket while the service is
running. It can legitimately differ from `snapshot.port`: see the
privileged-port fallback in §6.1.

When the service is **stopped** it falls back to the configured port rather than
reporting `null`, so the UI always has a number to render. The DHCP payload
(§5.3) reports `null` instead, because a service that has never bound anything
has no port to fall back to that would mean anything. A host MUST accept either
an integer or `null` for both.

**`TftpTransferView`:**

| Field | Type | Notes |
| --- | --- | --- |
| `id` | string | `"<address>:<port>"` — the client's TID. Stable for the transfer's life; this is what `cancelTransfer` takes. |
| `peer` | `{ address: string, port: integer }` | Client UDP endpoint. |
| `direction` | `"rrq" \| "wrq"` | From the client's point of view: `rrq` = the client is downloading, `wrq` = uploading. |
| `filename` | string | As requested on the wire, before sandboxing. |
| `bytes` | integer | Bytes transferred so far, including not-yet-acknowledged in-flight data. |
| `totalBytes` | integer \| null | File size for a download; the negotiated `tsize` for an upload; `null` when unknown. |
| `blockSize` | integer | Negotiated `blksize`. |
| `windowSize` | integer | Negotiated `windowsize`, **after** the daemon's clamp (§6.2). |
| `speedBps` | number | Smoothed bytes/second. |
| `etaSec` | number \| null | Seconds remaining, or `null` when not computable. |
| `startedAt` | integer | Unix epoch milliseconds. |
| `clientHostname` | string \| null | Reverse-DNS name, or `null` when unresolved or unsupported. |
| `client` | string | Display form: `"hostname (ip)"` when resolved, else the bare IP. Pre-rendered by the daemon so logs, `connection.summary` and the tree view all show the same string. |

### 5.3 DHCP runtime (`getServiceRuntime` result for `"dhcp"`)

```jsonc
{
  "snapshot":       { "id": "dhcp", "name": "DHCP Server", "port": 67, "status": "running" },
  "leases":         [ /* DhcpLeaseView[] */ ],
  "packetCounters": {
    "packetsReceived": 12, "packetsSentEstimate": 8,
    "discoverCount": 4, "offerCount": 4, "requestCount": 4,
    "declineCount": 0, "ackCount": 4, "nakCount": 0,
    "releaseCount": 0, "informCount": 0, "malformedCount": 0
  },
  "poolInfo": {
    "rangeStart": "192.168.2.10", "rangeEnd": "192.168.2.199",
    "poolSize": 190, "activeCount": 4, "utilizationPct": 2.1,
    "staticEntryCount": 1
  },
  "boundPort": 67
}
```

`boundPort` is the port actually held by the UDP socket while the service is
running, and `null` when it is stopped — unlike TFTP (§5.2), which falls back to
its configured port. A service that has never bound anything has no port to fall
back to that would mean anything. A host MUST accept either an integer or `null`
for both.

`poolInfo` is reported even when the service is stopped, derived from
configuration, so the sidebar shows the range the operator configured rather
than blanks. `activeCount` and `utilizationPct` are then `0`.

**`DhcpLeaseView`:**

| Field | Type | Notes |
| --- | --- | --- |
| `mac` | string | Client hardware address, canonicalised as uppercase hex pairs joined by dashes (`AA-BB-CC-DD-EE-FF`). This is the lease table's key. |
| `ip` | string | Dotted-quad IPv4 address assigned. |
| `boundAt` | integer | Unix epoch milliseconds of the **first** bind. A renewal does not reset it, so this is how long the device has held the address. |
| `leaseSec` | integer | Total lease duration granted. |
| `expiresAt` | integer | Unix epoch milliseconds at which the lease lapses if not renewed. |
| `remainingSec` | integer | Seconds left at the moment of the snapshot. |
| `hostname` | string \| null | Option 12 as the client sent it, sanitised (control characters replaced, length capped), or `null`. |
| `leaseType` | `"dynamic" \| "static" \| "renewed" \| "inform"` | `static` means the address came from a configured reservation. |

**`packetCounters` notes.** `offerCount`, `ackCount` and `nakCount` count
messages the daemon **sent**; the rest count messages it received.
`packetsSentEstimate` keeps its name for host compatibility but is an exact
count in the Rust daemon. `malformedCount` — datagrams that did not decode — is
additive; a host that does not know it MUST ignore it.

**Reservations are not leases.** A configured reservation whose device has not
yet booted holds its address out of the pool but does **not** appear in
`leases`, does not count toward `activeCount`, and is not persisted. It becomes
a lease with `leaseType: "static"` the moment its device completes an exchange.

### 5.4 Service configuration

**`TftpConfig`** — every field optional:

| Field | Type | Default | Notes |
| --- | --- | --- | --- |
| `root` | string | `~/Nexus/tftp-root` | Sandbox root. Absolute. |
| `port` | integer | `69` | UDP port. |
| `allowWrite` | boolean | `false` | Whether WRQ (upload) is accepted at all. |
| `interface` | string | `0.0.0.0` | Local IPv4 to bind — which NIC serves TFTP. |

**`DhcpConfig`** — every field optional. The daemon MUST also store the payload
verbatim and round-trip it unchanged, so a field a newer host sends survives an
older daemon.

| Field | Type | Default | Notes |
| --- | --- | --- | --- |
| `port` | integer | `67` | UDP port. |
| `bindAddress` | string | `0.0.0.0` | Local IPv4 to bind — which NIC serves DHCP. Note the name differs from TFTP's `interface`; both are long-standing host spellings. |
| `rangeStart` / `rangeEnd` | string | `192.168.2.10` / `192.168.2.199` | Inclusive dynamic pool. An inverted pair MUST be refused, not silently emptied. |
| `subnet` | string | `255.255.255.0` | Option 1. MUST be a contiguous mask. |
| `gateway` | string | `192.168.2.1` | Option 3. |
| `dns` | string[] | `["8.8.8.8","8.8.4.4"]` | Option 6. |
| `leaseTimeSec` | integer | `86400` | Option 51. |
| `serverId` | string | `192.168.2.1` | Option 54. |
| `broadcast` | string | derived | Option 28. When absent it is derived as `(gateway & subnet) | ~subnet`, **not** defaulted to a fixed address. |
| `static` | object | `{}` | MAC → IPv4 reservations. Keys are accepted in any common spelling and canonicalised; an address outside the pool is honoured just as one inside it. |
| `leaseStorePath` | string | unset | Absolute path the lease table is mirrored to. Unset keeps leases in memory only. |
| `nextServer` | string | unset | Option 66 — TFTP server name or address. |
| `bootFileName` | string | unset | Option 67. |
| `tftpServerAddresses` | string[] | unset | Option 150 (Cisco). |
| `vendorClassId` | string | unset | Option 60 the *client* must send for the boot options above to be served. Empty serves every client. |
| `vendorSpecificOptions` | `{subOption, value}[]` | unset | Option 43 sub-options. `subOption` is 1–254; `value` is a `0x…` hex literal or plain text. |

Malformed values MUST be refused at `configure` time with `INVALID_PARAMS` and
MUST NOT be stored — falling back to a default would report one configuration in
the UI while the service ran another.

### 5.5 `ServerConnectionEvent`

| Field | Type | Notes |
| --- | --- | --- |
| `phase` | `"started" \| "completed" \| "failed"` | |
| `summary` | string | One-line human summary. Always present. |
| `detail` | string? | Failure cause. Present when `phase` is `"failed"`. |
| `code` | string? | Machine-readable failure classification, when one exists. |
| `id` | string? | Stable id of the subject — for TFTP, the transfer TID. |
| `resource` | string? | What the event is about — for TFTP, the filename. |
| `client` | string? | The client as shown to the operator; the exact string `summary` embeds. |

All of `id` / `resource` / `client` are optional because a protocol emits only
the ones it has.

---

## 6. Service semantics

### 6.1 TFTP privileged-port fallback

Port 69 is privileged on every supported platform. When the configured port is
**69** and binding fails with a permission error, the daemon MUST retry once on
**1069**, and:

* log a `warn` before the retry naming both ports,
* on success, log an `info` saying it is on the alternate port and that
  re-running elevated would get port 69,
* report the real port in `boundPort` while leaving `snapshot.port` at the
  configured 69 — the host renders the difference.

The fallback applies **only** to a permission failure on **exactly** port 69. A
permission failure on a user-chosen port, or an address-already-in-use failure on
any port, is a hard failure: silently moving a user's configured port would be a
worse outcome than a clear error.

If the fallback also fails, the service reports `error` status and the `start`
RPC returns an error naming both attempts.

### 6.2 TFTP option negotiation bounds

The daemon implements RFC 1350 with the option extensions RFC 2347 (OACK),
2348 (`blksize`), 2349 (`timeout`, `tsize`) and 7440 (`windowsize`). Individual
option bounds are the RFC ones: `blksize` 8–65464, `timeout` 1–255,
`windowsize` 1–65535, `tsize` ≥ 0. A value outside its bound MUST be answered
with ERROR code 8 (Option negotiation failed), not silently clamped.

**Additionally, and not from any RFC:** the *product* `blksize × windowsize` —
the bytes one session may hold in flight, and the amount a windowed sender
allocates before sending any of it — MUST be bounded. At the RFC maxima a single
unauthenticated datagram can request ≈4.3 GB, and every admitted session can
request it, which makes option negotiation a remote out-of-memory. The bound is
**1 MiB**.

`windowsize` is **clamped** to fit that budget rather than refused, because
RFC 2347 §2 lets a server answer an option with a value the client must then use
and RFC 7440 §3 names `windowsize` explicitly as one the server may lower. The
clamp MUST happen before the OACK is built, so the OACK reports the value the
server will actually use — answering with the requested value and then using a
different one desynchronises the window.

`blksize` is deliberately **not** clamped: it is what a client picks to match its
MTU, and shrinking it below that fragments every datagram of the transfer.

### 6.3 TFTP transfer mode

Only `octet` is served. A request for `netascii` MUST be refused with a
protocol error naming `octet`, not accepted-and-ignored.

Rationale: `netascii` (RFC 1350 §2) is a transform, not a label — the sender
rewrites host line endings to CR/LF and the receiver rewrites them back.
Accepting the mode without implementing the transform corrupts every text
transfer between hosts with different line conventions, silently, with both sides
believing it succeeded. Refusing costs nothing in practice: network devices fetch
images and configs in `octet`, and a client told specifically that only `octet` is
supported can retry in binary, which is what it wanted.

### 6.4 DHCP privileged-port fallback

Port 67 is privileged on every supported platform, and the fallback rule is the
same shape as §6.1's: when the configured port is **67** and binding fails with
a permission error, the daemon MUST retry once on **1067**, log a `warn` before
the retry and an `info` on success naming the alternate port, and report the
real bound port in `boundPort` while `snapshot.port` stays at the configured 67.
As in §6.1, the fallback applies only to a permission failure on exactly port
67 — a failure on a user-chosen port, or address-already-in-use on any port, is
a hard failure reported as such, never silently retried on a different port.

### 6.5 DHCP lease lifecycle and static reservations

The daemon implements DORA (Discover/Offer/Request/Ack) over RFC 2131/2132.
Leases persist to disk (atomic temp-file-plus-rename, so a crash mid-write
leaves either the old file or the new one, never a partial one) and are
restored on the next `start`.

Static reservations (`DhcpConfig.reservations`, MAC → IP) are seeded into the
lease table at `start`, **after** the persisted-lease restore, so a reservation
takes precedence over a stale persisted dynamic lease for the same address.
Seeding is idempotent — a reservation whose address already holds the correct
lease is left untouched, so a device that reboots keeps the `bindTime` it
already had — and applies only to reservations that fall inside the configured
pool; a reservation outside the pool is never a competitor for a pool address,
so it is not seeded. Without this seeding, address allocation would just walk
the pool for the first free slot and hand a reserved address to whichever
client asks first, if that client asks before the reservation's own device
boots.

### 6.6 ZTP boot options

Options 66 (TFTP server name), 67 (bootfile name), 60 (vendor class, used as an
allow-filter — an OFFER is made only to a DISCOVER whose option 60 matches, when
configured), 150 (Cisco TFTP server addresses, one or more), and 43
(vendor-specific, raw bytes or a hex string) are all supported. Option 43's
encoded value MUST NOT exceed 255 bytes — the field is a single length-prefixed
byte in the DHCP option format, so a longer value cannot be represented on the
wire and MUST be refused at `configure` time, not truncated silently.

---

## 7. Lifecycle

### 7.1 Spawn

The host spawns the daemon with all three streams piped, and MAY pass a
configuration seed through the environment variable
**`NEXUS_NETWORK_SERVERS_CONFIG`**, whose value is the JSON serialization of
`{ "tftp"?: TftpConfig, "dhcp"?: DhcpConfig }`.

The seed exists because the daemon cannot read the host's settings store itself,
and because there is a window between spawn and the first `configure` in which
the host may already have issued `list`. Without the seed that `list` reports
*default* ports for services the user has reconfigured — a wrong port rendered in
the UI before anything is started.

A malformed or absent seed MUST NOT be fatal. The daemon logs a `warn` and starts
on defaults, waiting for `configure`. The seed is a one-shot snapshot; the
`configure` RPC and per-`start` config are the authoritative path.

### 7.2 Ready handshake

1. Daemon initializes its service registry and configuration store.
2. Daemon applies the environment seed, if present.
3. Daemon emits `{"event":"ready","data":null}`.

The seed MUST be applied **before** `ready` is emitted: the host may issue `list`
the instant it sees `ready`, and that snapshot has to already reflect configured
ports.

The daemon MUST NOT emit `ready` more than once, and MUST NOT answer any request
before it. In practice the host does not send one — it awaits `ready` first — but
a daemon that starts reading stdin before it is initialized must queue, not
answer.

The host arms a **ready timeout** when it spawns, default **10 s**, clamped to
the range **1–60 s**. On expiry the host MUST terminate that child using the
escalation in §7.4 before retrying. Abandoning it instead leaks a live process
holding pipes and possibly a bound privileged UDP port, unreachable by any later
teardown — and its late `ready`, arriving on a stream nobody closed, would
resolve waiters that belong to its replacement.

### 7.3 Request/response

The host arms a **per-request timeout**, default **15 s**, clamped to the range
**2–60 s**. On expiry the host rejects that call locally; a response arriving
afterwards is dropped silently (its id is no longer pending). The daemon is not
told, and MUST tolerate a request whose answer nobody is waiting for.

The daemon MUST bound the length of a stdin line at **8 MiB** and MUST discard —
not buffer — the remainder of an over-long line, logging one `warn`. It MUST NOT
attempt to parse the truncated fragment as JSON.

### 7.4 Shutdown

The graceful path is **stdin EOF**:

1. The host closes the daemon's stdin.
2. The daemon observes EOF on its stdin reader.
3. The daemon flushes pending `runtimeUpdate` windows.
4. The daemon stops every service — closing UDP sockets and file handles.
5. The daemon exits with status **0**.

The host then escalates, unconditionally and without waiting to observe the
above:

1. `SIGTERM` (or the platform equivalent).
2. `SIGKILL` **2 s** later if the process is still alive.

This escalation is not a fallback for a badly-behaved daemon so much as a
guarantee: no orphan may outlive the extension host holding UDP 69 or 67, because
the next session would then fail to bind with no visible cause.

A daemon MAY handle `SIGTERM`/`SIGINT` for a tidier log line, but MUST NOT rely
on being able to: the default disposition of `SIGTERM` already terminates the
process and the operating system releases its sockets, so the only thing an
unhandled signal costs is a farewell log. A daemon MUST NOT install a handler
that could *delay* termination past the host's 2 s escalation window.

If the daemon exits on its own, the host rejects every pending request with an
error naming the exit code, clears its ready state, and notifies exit listeners.

---

## 8. Versioning

This document's version is the **protocol** version, independent of the
extension's release version.

* **Patch** — clarification only; no wire change.
* **Minor** — backwards-compatible additions: a new method, a new event, a new
  optional field, a new error code. A reader MUST ignore unknown object members
  and unknown event names rather than failing, so that a newer daemon can run
  against an older host.
* **Major** — a breaking change to an existing shape. Both sides ship together;
  there is no negotiation step, because the daemon is bundled with the host that
  spawns it.

The absence of a negotiation handshake is deliberate. Adding one would imply the
two sides can be versioned apart, which for a bundled child process is a
fiction — and a fiction that costs a round-trip on every startup.
