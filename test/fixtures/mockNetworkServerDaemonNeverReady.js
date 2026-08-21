/**
 * A network-servers daemon that starts, holds its pipes open, and never
 * announces readiness — the shape of a daemon wedged during initialisation.
 *
 * `NetworkServerDaemonHost.launch()` must time out AND take this process down
 * with it. Left alive it is unreachable by `dispose()` (a retry overwrites the
 * host's reference to it) while still holding stdio, and any UDP port a later
 * command talked it into binding.
 */
process.stdin.resume();
setInterval(() => {}, 60_000);
