# nexus-network-server-daemon

Out-of-process supervisor for Nexus Terminal's embedded network services.

The extension host spawns this binary as a child process and speaks
newline-delimited JSON-RPC to it over stdio. The wire contract is
[`docs/network-server-daemon-protocol.md`](../../docs/network-server-daemon-protocol.md),
which is written to be implementation-independent: either side can be built from
that document alone.

## Status

| Service | State |
| --- | --- |
| TFTP | Implemented — RFC 1350 with the option extensions RFC 2347/2348/2349/7440 |
| DHCP | Implemented — RFC 2131/2132 DORA state machine, lease persistence, static-reservation seeding, ZTP boot options |

Both engines are proven on Windows x64: the full workspace test suite (351 tests,
including real-UDP e2e) passes, and the extension-side parity suite
(`test/integration/networkServers/daemonEngineParity.test.ts`) drives the real
`daemonHost.ts` RPC client against the built binary with identical results to the
existing Node/TypeScript daemon. Prebuilt artifacts for all six supported platforms are built and packaged by
`.github/workflows/release.yml` at release time — see
`native/network-server-daemon-artifacts/README.md` for how that works.
The `nexus.networkServers.engine` default became `"rust"` in 2.8.205. The Node
daemon stays in the tree and stays the automatic fallback for any platform
without a packaged binary, so it is not dead code and its tests still run.

## Layout

```
crates/
  tftp/     protocol codec, filesystem sandbox, transfer state machine, UDP engine
  dhcp/     DORA state machine, lease store + persistence, ZTP boot options
  rpc/      newline-delimited JSON-RPC framing and message shapes over stdio
  daemon/   the binary: configuration store, service lifecycle, request dispatch
```

The split follows the boundaries that make things testable rather than the
boundaries of the wire protocol. Everything outside `tftp::engine` is pure enough
to drive from a unit test; `tftp::engine` itself can be driven through a
recording `Datagram` instead of a real socket; and `daemon::Daemon` dispatches
requests without owning stdio, so the whole method surface can be exercised
without a process.

## Design decisions worth knowing before reading the code

**No async runtime.** One thread per service owns its socket and every session,
with a read timeout that also paces the maintenance tick and the control channel.
A reactor would buy nothing here — one socket, one block of file I/O at a time,
no fan-out — and would cost a large dependency tree under a component whose value
is that it can be read end to end. `serde` and `serde_json` are the only
third-party crates in the workspace.

**No `unsafe`.** Every crate carries `#![forbid(unsafe_code)]`, so this is a
compile error rather than a convention.

**Memory safety is not the interesting property here.** Every hardening fix in
the sandbox and the state machine guards a *logic* bug — which file gets opened,
which block number counts as next, how much a client can make the server
allocate. Rust prevents none of those. They are ported deliberately, each with a
comment saying what went wrong without it.

## Building and testing

```bash
cargo build                 # debug
cargo build --release       # shipped binary
cargo test --workspace      # unit + integration, including real UDP and a real spawned process
cargo clippy --workspace --all-targets   # pedantic lints are on; the tree is clean
```

The integration suites bind real sockets on loopback and spawn the real binary.
Nothing reaches the network beyond `127.0.0.1`, and every temporary directory is
removed on drop.

### Symlink tests on Windows

The sandbox tests that plant symlinks *skip themselves* when the platform refuses
to create one — Windows grants that only to an elevated process or one running
with Developer Mode enabled. A skip is announced on stderr, so an "all green" run
on a machine that skipped them is not mistaken for one that exercised them. Run
`cargo test -- --nocapture` to see it, and enable Developer Mode to get real
coverage of the symlink-escape defences on Windows.

### Mutation audit

`mutation-audit.py` reverts each hardening fix in turn and asserts that a test
catches it — the repository's rule that a regression test must fail against the
specific wrong implementation it exists to prevent, applied mechanically.

```bash
python mutation-audit.py
```

It restores every file it touches, including on failure. One mutation is listed
as an expected survivor with a written reason; anything else surviving is a
vacuous test and fails the run.
