//! Daemon entry point: owns stdio, and nothing else.
//!
//! The lifecycle is the one specified in `docs/network-server-daemon-protocol.md`
//! §7 — seed configuration, announce `ready`, serve requests until stdin reaches
//! EOF, then stop every service and exit 0.
//!
//! # On signals
//!
//! `SIGTERM` and `SIGINT` are deliberately **not** handled. The host's teardown
//! closes stdin first, and that EOF is the graceful path; the signals that
//! follow are its escalation, and their default disposition already terminates
//! the process and lets the operating system release every socket. Installing a
//! handler would need either an extra dependency or `unsafe`, and would buy one
//! log line — while risking the far worse outcome of *delaying* termination past
//! the host's two-second escalation window, which is precisely how an orphan
//! ends up holding UDP 69 into the next session.

#![forbid(unsafe_code)]

use nexus_network_server_daemon::events::Emitter;
use nexus_network_server_daemon::{throttle, Daemon};
use nexus_rpc::{Line, LineReader, MessageWriter, Outgoing, Request, RequestError};
use serde_json::json;
use std::io::BufReader;
use std::sync::Arc;

fn main() {
    let writer = Arc::new(MessageWriter::stdout());

    // The coalescer writes through the same lock as everything else, so a
    // `runtimeUpdate` fired from its own thread can never interleave with a
    // response being written from this one.
    let throttle_writer = Arc::clone(&writer);
    let (throttle, mut throttle_worker) = throttle::spawn(
        move |id| {
            let _ = throttle_writer.write(&Outgoing::event("runtimeUpdate", json!({ "id": id })));
        },
        throttle::WINDOW,
    );

    let emitter = Emitter::new(Arc::clone(&writer), throttle);
    let mut daemon = Daemon::new(emitter.clone());

    // Seed BEFORE announcing readiness: the host may fire `list` the instant it
    // sees `ready`, and that snapshot must already reflect configured ports.
    daemon.apply_env_seed();
    emitter.ready();

    // `BufReader` around the lock rather than `Stdin::lock()`'s own buffering,
    // so the bounded line reader sees a plain `BufRead` it can drive itself.
    let stdin = std::io::stdin();
    let mut reader = LineReader::new(BufReader::new(stdin.lock()));

    loop {
        match reader.next_line() {
            Ok(Line::Eof) => break,
            Ok(Line::Text(line)) => {
                let trimmed = line.trim();
                if trimmed.is_empty() {
                    continue;
                }
                match Request::parse(trimmed) {
                    Ok(request) => {
                        let response = daemon.handle(&request);
                        emitter.respond(&response);
                    }
                    // Neither case is answerable: without a usable `id` there is
                    // nothing to correlate a response to, and fabricating one
                    // could resolve a pending call that belongs to a different
                    // request entirely.
                    Err(RequestError::NotJson(detail)) => emitter.log(
                        "daemon",
                        "warn",
                        &format!("Ignored invalid JSON line: {}", clip(&detail)),
                    ),
                    Err(RequestError::Malformed(detail)) => emitter.log(
                        "daemon",
                        "warn",
                        &format!("Ignored malformed request: {detail}"),
                    ),
                    Err(error @ RequestError::AnswerableMalformed { .. }) => {
                        if let Some(id) = error.response_id() {
                            emitter.respond(&Outgoing::error(
                                id,
                                nexus_rpc::ErrorCode::InvalidRequest,
                                "Malformed RPC request.",
                            ));
                        }
                        emitter.log(
                            "daemon",
                            "warn",
                            &format!("Rejected malformed request: {error}"),
                        );
                    }
                }
            }
            Ok(Line::Oversized(bytes)) => emitter.log(
                "daemon",
                "warn",
                &format!("Discarded an oversized request line ({bytes} bytes)"),
            ),
            Ok(Line::InvalidUtf8) => {
                emitter.log("daemon", "warn", "Ignored a line that was not valid UTF-8");
            }
            // A read error on stdin means the pipe is gone. Treated exactly like
            // EOF: there is nobody left to serve, and staying alive would leak a
            // process holding privileged sockets.
            Err(error) => {
                emitter.log("daemon", "warn", &format!("stdin read failed: {error}"));
                break;
            }
        }
    }

    emitter.log("daemon", "info", "Shutting down (stdin closed)…");
    // Flush pending coalescing windows before the services go away: a pending
    // update dropped here is a state change the host is never told about.
    throttle_worker.flush();
    daemon.stop_all();
    throttle_worker.shutdown();
}

fn clip(text: &str) -> String {
    text.chars().take(160).collect()
}
