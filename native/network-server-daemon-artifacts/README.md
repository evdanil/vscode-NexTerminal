# Network server daemon — prebuilt artifacts

Prebuilt binaries of the native network-server daemon (`native/network-server-daemon/`,
Rust). `scripts/installNetworkServerDaemonArtifacts.mjs` copies whatever is here into
`dist/native/network-server-daemon/<platform-key>/` during `npm run build`, and
`daemonHost.ts` spawns the one matching the running platform when the
`nexus.networkServers.engine` setting is `"rust"`.

This mirrors `native/local-pty-artifacts/` exactly — same six platform keys, same
"missing directory just means skip" contract.

## Layout

```
native/network-server-daemon-artifacts/
  win32-x64/nexus-network-server-daemon.exe
  win32-arm64/nexus-network-server-daemon.exe
  linux-x64/nexus-network-server-daemon
  linux-arm64/nexus-network-server-daemon
  darwin-x64/nexus-network-server-daemon
  darwin-arm64/nexus-network-server-daemon
```

## Current state

No prebuilt network-server daemon binaries are committed in this repository
today. The `rust` engine can still be exercised by setting
`NEXUS_NETWORK_SERVER_DAEMON_BIN` to a locally built daemon, and future packaging
can populate the platform directories shown above.

An absent directory is deliberate: copying a binary into the wrong platform key
would ship something that cannot execute there, and the fallback below would
never fire because the file *would* exist. Until release automation supplies
real artifacts, packaged extensions transparently use the bundled Node daemon.

## Graceful degradation (why a missing platform is safe)

Nothing breaks when a platform is missing:

- `installNetworkServerDaemonArtifacts.mjs` copies what exists and logs the rest;
  a missing source directory logs `No network server daemon artifacts found` and
  exits 0. The build never fails over this.
- `daemonHost.ts` treats `engine: "rust"` as a *preference*. If no binary is
  present for the running platform it spawns the Node daemon instead and logs a
  warning naming the reason, to the *Nexus Network Servers* output channel. TFTP
  and DHCP always start.

So the setting is safe to expose on every platform today. Each real artifact
added here starts being used by packaged builds for its matching platform.

## Producing artifacts

Rust cannot realistically cross-compile to another *operating system* from one
machine — each target needs that OS's linker, system libraries and SDK. Do not
try to produce these by hand from Windows; build each on its native OS.

Per platform, from `native/network-server-daemon/`:

```bash
cargo build --release --target <triple>
# binary lands in target/<triple>/release/nexus-network-server-daemon[.exe]
```

| Platform key   | Target triple                | Build host                     |
| -------------- | ---------------------------- | ------------------------------ |
| `win32-x64`    | `x86_64-pc-windows-msvc`     | `windows-latest`               |
| `win32-arm64`  | `aarch64-pc-windows-msvc`    | `windows-latest` (cross, MSVC) |
| `linux-x64`    | `x86_64-unknown-linux-gnu`   | `ubuntu-latest`                |
| `linux-arm64`  | `aarch64-unknown-linux-gnu`  | `ubuntu-latest` (cross) or ARM runner |
| `darwin-x64`   | `x86_64-apple-darwin`        | `macos-latest`                 |
| `darwin-arm64` | `aarch64-apple-darwin`       | `macos-latest`                 |

Notes:

- **Same-OS cross-compiles are fine** and only need `rustup target add <triple>`:
  Windows ARM64 from Windows x64, and both macOS arches from either Mac.
  `linux-arm64` from `linux-x64` needs a cross linker
  (`gcc-aarch64-linux-gnu`, with `CARGO_TARGET_AARCH64_UNKNOWN_LINUX_GNU_LINKER`)
  or the `cross` tool.
- **Cross-OS is what needs separate runners** — three jobs minimum
  (`windows-latest`, `ubuntu-latest`, `macos-latest`).
- Link **glibc as old as you can** for the Linux artifacts, or a modern-distro
  build will refuse to start on an older one. Building in an older container, or
  targeting `*-unknown-linux-musl` for a static binary, both avoid this.
- macOS binaries need **signing and notarization** before they will run on other
  people's machines from a downloaded VSIX.

## CI

There is **no workflow that builds these**, and there is none for
`local-pty-artifacts` either — both are supplied externally today. That is the
existing convention, and this phase deliberately did not invent a new one.

A future workflow would be a matrix over the three runner OSes, each running the
`cargo build --release --target` above, uploading the binary as an artifact, and a
final job committing them here (or attaching them to the release that
`package:vsix` consumes). Whoever writes it should also decide whether these
binaries belong in git at all — ~850 KB each, six platforms, changing every
release — or whether they should be fetched at package time instead.

## Verifying an artifact

The daemon speaks newline-delimited JSON-RPC on stdio
(`docs/network-server-daemon-protocol.md`). A one-line smoke test:

```bash
printf '{"id":1,"method":"list"}\n' | ./nexus-network-server-daemon
```

Expect a `{"event":"ready","data":null}` push followed by an `id: 1` result
listing the `tftp` and `dhcp` services as `stopped`.

For real coverage, run the parity suite against the binary — it drives the actual
extension-side RPC client (`daemonHost.ts`) through transfer cancellation,
admission caps, option negotiation and DHCP lease persistence:

```bash
NEXUS_NETWORK_SERVERS_ENGINE=rust \
NEXUS_NETWORK_SERVER_DAEMON_BIN=/abs/path/to/nexus-network-server-daemon \
npx vitest run test/integration/networkServers/daemonEngineParity.test.ts
```
