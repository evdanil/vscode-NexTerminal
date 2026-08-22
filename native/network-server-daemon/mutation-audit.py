"""Temporarily reverts each hardening fix and confirms a test catches it.

Not part of the build. Run from the workspace root:  python mutation-audit.py
Every mutation is undone before the next one runs, and on any failure path.
"""
import subprocess, sys, shutil, os

ROOT = os.path.dirname(os.path.abspath(__file__))

MUTATIONS = [
    ("block wrap: at_or_after becomes a numeric compare",
     "crates/tftp/src/session.rs",
     "    block_distance(earlier, later) < BLOCK_SPACE / 2",
     "    later >= earlier"),

    ("block wrap: next_block becomes plain increment",
     "crates/tftp/src/session.rs",
     "    if block == u16::MAX {\n        1\n    } else {\n        block + 1\n    }",
     "    block.wrapping_add(1)"),

    ("block wrap: predecessor computed as block - 1",
     "crates/tftp/src/session.rs",
     "        let previous = if self.block <= 1 { u16::MAX } else { self.block - 1 };",
     "        let previous = self.block.wrapping_sub(1);"),

    ("in-flight budget: windowsize clamp removed",
     "crates/tftp/src/protocol.rs",
     "    let max_window = (MAX_IN_FLIGHT_BYTES / out.blksize).max(1);\n    if out.windowsize > max_window {\n        out.windowsize = max_window;\n    }",
     "    let _ = MAX_IN_FLIGHT_BYTES;"),

    ("sandbox: symlink_metadata becomes metadata (dangling-symlink write)",
     "crates/tftp/src/path_guard.rs",
     "        match fs::symlink_metadata(&absolute) {",
     "        match fs::metadata(&absolute) {"),

    ("sandbox: directories created before the containment check",
     "crates/tftp/src/path_guard.rs",
     "        let anchor = deepest_existing_ancestor(&parent);\n        let real_anchor = fs::canonicalize(&anchor)?;\n        self.assert_contained(&real_anchor, filename)?;\n\n        fs::create_dir_all(&parent)?;",
     "        fs::create_dir_all(&parent)?;"),

    ("sandbox: read path stops at lexical containment",
     "crates/tftp/src/path_guard.rs",
     "        let real = fs::canonicalize(&absolute)?;\n        self.assert_contained(&real, filename)?;",
     ""),

    ("sandbox: root absolutised instead of canonicalised",
     "crates/tftp/src/path_guard.rs",
     "        let canonical =\n            fs::canonicalize(&absolute).map_err(|e| RootError::Io(absolute.clone(), e))?;\n        Ok(Self { root: canonical })",
     "        Ok(Self { root: absolute })"),

    ("sandbox: NUL byte accepted",
     "crates/tftp/src/path_guard.rs",
     "        if filename.contains('\\0') {\n            return Err(GuardError::PathViolation(filename.to_owned()));\n        }",
     ""),

    ("sandbox: DOS device names accepted",
     "crates/tftp/src/path_guard.rs",
     "                    reject_reserved_device_name(segment, filename)?;",
     ""),

    ("admission: reservation becomes a check of the session table",
     "crates/tftp/src/engine.rs",
     "        if registered + self.reserved >= self.max {\n            return false;\n        }\n        self.reserved += 1;\n        true",
     "        if registered >= self.max {\n            return false;\n        }\n        self.reserved += 1;\n        true"),

    ("admission: slot released only on success",
     "crates/tftp/src/engine.rs",
     "        self.admit(request.0, request.1, peer);\n        self.admission.release();",
     "        self.admit(request.0, request.1, peer);"),

    ("startup: socket bound before the root is validated",
     "crates/tftp/src/engine.rs",
     "        let guard = PathGuard::new(&options.root).map_err(StartError::Root)?;\n        let socket = UdpSocket::bind(SocketAddr::new(options.address, options.port))\n            .map_err(StartError::Bind)?;",
     "        let socket = UdpSocket::bind(SocketAddr::new(options.address, options.port))\n            .map_err(StartError::Bind)?;\n        let guard = PathGuard::new(&options.root).map_err(StartError::Root)?;"),

    ("retransmission: the OACK jams the queue behind it",
     "crates/tftp/src/session.rs",
     "                None => true,",
     "                None => false,"),

    ("retransmission: record after send would be untestable; queue never drains",
     "crates/tftp/src/session.rs",
     "        if confirmed > 0 {\n            self.outbound.drain(..confirmed);\n        }",
     "        if confirmed > 0 && false {\n            self.outbound.drain(..confirmed);\n        }"),

    ("file reads: a short read is treated as end of file",
     "crates/tftp/src/session.rs",
     "    let mut filled = 0usize;\n    while filled < buf.len() {",
     "    let mut filled = 0usize;\n    while filled < buf.len() && filled == 0 {"),

    ("RFC 2347: a write client answering an OACK with DATA(1) is ignored",
     "crates/tftp/src/session.rs",
     "        if matches!(self.phase, Phase::RecvInitialAck)\n            || (matches!(self.phase, Phase::SendOack) && self.direction == Direction::Write)\n        {",
     "        if matches!(self.phase, Phase::RecvInitialAck) {"),

    ("framing: unbounded line reader",
     "crates/rpc/src/framing.rs",
     "            } else if buf.len() + take > self.limit {",
     "            } else if false {"),

    ("framing: a null result is omitted",
     "crates/rpc/src/message.rs",
     "    Result { id: i64, result: Value },",
     "    Result { id: i64, #[serde(skip_serializing_if = \"Value::is_null\")] result: Value },"),

    ("throttle: terminal updates wait out the window",
     "crates/daemon/src/throttle.rs",
     "                        if terminal {\n                            pending.remove(&id);\n                            emit(&id);\n                        } else {",
     "                        if false {\n                            pending.remove(&id);\n                            emit(&id);\n                        } else {"),

    ("throttle: window re-armed on every push (debounce, not throttle)",
     "crates/daemon/src/throttle.rs",
     "                            pending.entry(id).or_insert_with(|| Instant::now() + window);",
     "                            pending.insert(id, Instant::now() + window);"),

    ("lifecycle: a failed start answers success",
     "crates/daemon/src/daemon.rs",
     "            tftp_service::SERVICE_ID => match self.tftp.start() {\n                Ok(()) => Self::ok(request.id, service),\n                Err(message) => Outgoing::error(request.id, ErrorCode::InternalError, message),\n            },",
     "            tftp_service::SERVICE_ID => match self.tftp.start() {\n                Ok(()) => Self::ok(request.id, service),\n                Err(_) => Self::ok(request.id, service),\n            },"),

    # Listed with a documented reason rather than dropped: *why* a mutation
    # cannot be caught is itself a fact a reviewer should see.
    ("lifecycle: restart applies configuration before stopping",
     "crates/daemon/src/daemon.rs",
     "                self.tftp.stop();\n                if let Err(response) = self.apply_inline_config(request, service) {\n                    return response;\n                }\n                match self.tftp.start() {",
     "                if let Err(response) = self.apply_inline_config(request, service) {\n                    return response;\n                }\n                self.tftp.stop();\n                match self.tftp.start() {",
     # Listed with a documented reason rather than dropped: *why* a mutation
     # cannot be caught is itself a fact a reviewer should see.
     "no cached service instance exists to be evicted, so both orderings are "
     "equivalent here; the order is kept for the day one does"),

    ("config: a bad interface silently falls back to all interfaces",
     "crates/daemon/src/config.rs",
     "            Some(raw) => raw.trim().parse::<IpAddr>().map_err(|_| {\n                format!(\n                    \"'{raw}' is not a valid IP address for the TFTP interface setting. \\\n                     Leave it empty to serve on all interfaces.\"\n                )\n            }),",
     "            Some(raw) => Ok(raw.trim().parse::<IpAddr>().unwrap_or(IpAddr::V4(Ipv4Addr::UNSPECIFIED))),"),

    ("config: a tftp-only apply clobbers dhcp",
     "crates/daemon/src/config.rs",
     "        if let Some(incoming) = configs.get(\"dhcp\") {\n            if self.dhcp_raw.as_ref() != Some(incoming) {",
     "        {\n            let incoming = configs.get(\"dhcp\").cloned().unwrap_or(Value::Null);\n            let incoming = &incoming;\n            if self.dhcp_raw.as_ref() != Some(incoming) {"),

    ("protocol: netascii accepted and served as raw bytes",
     "crates/tftp/src/protocol.rs",
     "        \"netascii\" => {\n            return Err(ProtocolError::new(\n                \"Unsupported mode: netascii (this server implements octet only)\",\n            ))\n        }",
     "        \"netascii\" => TransferMode::Octet,"),

    ("protocol: option values parsed leniently (parseInt semantics)",
     "crates/tftp/src/protocol.rs",
     "    if trimmed.is_empty() || !trimmed.bytes().all(|b| b.is_ascii_digit()) {\n        return Err(ProtocolError::new(format!(\"Invalid {name}: {raw}\")));\n    }",
     "    let trimmed: String = trimmed.chars().take_while(char::is_ascii_digit).collect();\n    let trimmed = trimmed.as_str();\n    if trimmed.is_empty() {\n        return Err(ProtocolError::new(format!(\"Invalid {name}: {raw}\")));\n    }"),

    ("protocol: filename length unbounded",
     "crates/tftp/src/protocol.rs",
     "    if filename.len() > MAX_FILENAME_BYTES {\n        return Err(ProtocolError::new(format!(\n            \"Filename exceeds {MAX_FILENAME_BYTES} bytes\"\n        )));\n    }",
     ""),

    ("engine: peer text echoed verbatim into the log stream",
     "crates/tftp/src/engine.rs",
     "    let cleaned: String = text\n        .chars()\n        .take(MAX_ECHOED_TEXT)\n        .map(|c| if c.is_control() { '\\u{fffd}' } else { c })\n        .collect();",
     "    let cleaned: String = text.chars().collect();"),

    ("service: progress logged per block instead of rate limited",
     "crates/daemon/src/tftp_service.rs",
     "        if last.elapsed() < PROGRESS_LOG_INTERVAL {\n            return None;\n        }",
     ""),
]

# The DHCP half lives in its own module so this list stays readable. Same shape,
# same rules, same runner.
sys.path.insert(0, ROOT)
from dhcp_mutations import MUTATIONS as DHCP_MUTATIONS  # noqa: E402

MUTATIONS += DHCP_MUTATIONS


def run(cmd):
    return subprocess.run(cmd, cwd=ROOT, shell=True, capture_output=True, text=True)


def touch(path):
    """Bump the mtime to now.

    Cargo's fingerprint compares modification times, so restoring a file from a
    backup — which carries an OLDER mtime than the mutated version cargo last
    built — leaves cargo convinced its cached artifact is still fresh. It then
    runs the MUTATED binary against the restored source, and every later
    mutation is scored against the wrong build. This cost an hour of chasing a
    serde bug that did not exist; do not remove it.
    """
    os.utime(path, None)


def failing_tests(output):
    names = []
    for line in output.splitlines():
        line = line.strip()
        if line.startswith("test ") and line.endswith("... FAILED"):
            names.append(line[len("test "):-len(" ... FAILED")].strip())
    return names


def main():
    baseline = run("cargo test --workspace -q")
    if baseline.returncode != 0:
        print("BASELINE IS NOT GREEN — fix that first")
        print(baseline.stdout[-4000:], baseline.stderr[-4000:])
        return 1

    undetected = []
    expected_survivors = []
    for mutation in MUTATIONS:
        name, rel, original, replacement = mutation[:4]
        expected_reason = mutation[4] if len(mutation) > 4 else None
        path = os.path.join(ROOT, rel)
        backup = path + ".bak"
        shutil.copyfile(path, backup)
        try:
            source = open(path, encoding="utf-8").read()
            if original not in source:
                print(f"SKIP  {name}\n      (anchor not found in {rel} — audit is stale)")
                undetected.append((name, "ANCHOR NOT FOUND"))
                continue
            open(path, "w", encoding="utf-8").write(source.replace(original, replacement, 1))
            touch(path)
            result = run("cargo test --workspace")
            combined = result.stdout + result.stderr
            if result.returncode == 0:
                if expected_reason:
                    print(f"survives (expected)  {name}")
                    print(f"          reason: {expected_reason}")
                    expected_survivors.append(name)
                else:
                    print(f"UNDETECTED  {name}")
                    undetected.append((name, "tests still pass"))
            else:
                caught = failing_tests(combined)
                if not caught:
                    # A mutation that does not compile is still "detected", but
                    # says nothing about test coverage, so it is called out.
                    print(f"COMPILE-ERROR  {name}  (no test proves it)")
                    undetected.append((name, "did not compile"))
                else:
                    print(f"caught  {name}")
                    for test in caught[:4]:
                        print(f"          <- {test}")
        finally:
            shutil.move(backup, path)
            touch(path)

    print("\n" + "=" * 70)
    if undetected:
        print(f"{len(undetected)} of {len(MUTATIONS)} mutations need attention:")
        for name, why in undetected:
            print(f"  - {name}: {why}")
        return 1
    caught = len(MUTATIONS) - len(expected_survivors)
    print(f"{caught} of {len(MUTATIONS)} mutations were caught by a test")
    if expected_survivors:
        print(f"{len(expected_survivors)} survive for documented reasons:")
        for name in expected_survivors:
            print(f"  - {name}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
