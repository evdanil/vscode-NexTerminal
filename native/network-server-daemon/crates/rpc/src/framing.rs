//! Newline-delimited framing over a byte stream.
//!
//! See `docs/network-server-daemon-protocol.md` §1 for the normative rules this
//! implements: one UTF-8 JSON object per line, `\r` tolerated before the `\n`,
//! blank lines ignored, and a bounded line length.

use crate::{ErrorCode, Outgoing};
use std::io::{self, BufRead, Write};
use std::sync::Mutex;

/// Maximum bytes in a single inbound line.
///
/// The cap is not politeness. `BufRead::read_line` and friends grow a buffer
/// without limit, so a peer that writes megabytes with no newline drives this
/// process to an out-of-memory abort — a process that is holding privileged UDP
/// sockets on behalf of a user. 1 MiB intentionally matches the TypeScript
/// host's `MAX_RPC_LINE_BYTES` contract, leaving ample space for every real
/// request while keeping both sides on one explicit wire ceiling.
pub const MAX_LINE_BYTES: usize = 1_048_576;

/// One framing event.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Line {
    /// A complete, decoded line. May be empty.
    Text(String),
    /// A line exceeded [`MAX_LINE_BYTES`] and was discarded in full, along with
    /// however many bytes it turned out to hold. It is never parsed, not even
    /// partially: a truncated JSON fragment is not a smaller request, it is a
    /// different one.
    Oversized(usize),
    /// A complete line that was not valid UTF-8.
    InvalidUtf8,
    /// The stream ended.
    Eof,
}

/// Reads newline-delimited lines with a hard length cap.
#[derive(Debug)]
pub struct LineReader<R: BufRead> {
    inner: R,
    limit: usize,
}

impl<R: BufRead> LineReader<R> {
    #[must_use]
    pub fn new(inner: R) -> Self {
        Self {
            inner,
            limit: MAX_LINE_BYTES,
        }
    }

    #[must_use]
    pub fn with_limit(inner: R, limit: usize) -> Self {
        Self { inner, limit }
    }

    /// Reads the next line.
    ///
    /// A line longer than the limit is consumed to its terminator and reported
    /// as [`Line::Oversized`], so the stream stays in sync: the bytes after it
    /// are still framed correctly and the connection does not have to be torn
    /// down over one bad write.
    #[allow(
        clippy::needless_continue,
        reason = "the arm must diverge; its sibling breaks out of the loop with a value"
    )]
    pub fn next_line(&mut self) -> io::Result<Line> {
        let mut buf: Vec<u8> = Vec::new();
        let mut overflowed = false;
        let mut dropped = 0usize;
        let mut saw_terminator = false;

        loop {
            // Fill first, taking only the length out of the borrow, so the
            // retry-on-interrupt loop does not hold a borrow across iterations.
            let filled = loop {
                match self.inner.fill_buf() {
                    Ok(available) => break available.len(),
                    Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
                    Err(e) => return Err(e),
                }
            };
            if filled == 0 {
                break; // end of stream
            }
            // The buffer is already populated, so this cannot block or fail.
            let available = self.inner.fill_buf()?;
            let (take, found) = match available.iter().position(|b| *b == b'\n') {
                Some(index) => (index, true),
                None => (available.len(), false),
            };
            if overflowed {
                dropped += take;
            } else if buf.len() + take > self.limit {
                overflowed = true;
                dropped = buf.len() + take;
                buf = Vec::new();
            } else {
                buf.extend_from_slice(&available[..take]);
            }
            self.inner.consume(if found { take + 1 } else { take });
            if found {
                saw_terminator = true;
                break;
            }
        }

        if overflowed {
            return Ok(Line::Oversized(dropped));
        }
        if buf.is_empty() && !saw_terminator {
            return Ok(Line::Eof);
        }
        // A CRLF-normalising pipe on Windows is the usual source of this.
        if buf.last() == Some(&b'\r') {
            buf.pop();
        }
        match String::from_utf8(buf) {
            Ok(text) => Ok(Line::Text(text)),
            Err(_) => Ok(Line::InvalidUtf8),
        }
    }
}

/// Writes newline-delimited JSON messages.
///
/// Serialisation happens into an owned buffer and the whole line — payload plus
/// terminator — reaches the underlying writer in a single `write_all` while the
/// lock is held. Two threads emitting at once therefore cannot interleave halves
/// of two messages into one corrupt line, which is the one framing failure the
/// reader on the other end has no way to recover from.
pub struct MessageWriter {
    inner: Mutex<Box<dyn Write + Send>>,
}

impl std::fmt::Debug for MessageWriter {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("MessageWriter")
    }
}

impl MessageWriter {
    #[must_use]
    pub fn new(inner: Box<dyn Write + Send>) -> Self {
        Self {
            inner: Mutex::new(inner),
        }
    }

    /// Writes to this process's standard output.
    #[must_use]
    pub fn stdout() -> Self {
        Self::new(Box::new(io::stdout()))
    }

    /// Serialises and writes one message.
    ///
    /// A write failure is returned rather than swallowed, but callers on the
    /// event path generally have nowhere to report it: if the host has gone
    /// away, the next stdin read returns EOF and the daemon shuts down anyway.
    pub fn write(&self, message: &Outgoing) -> io::Result<()> {
        let mut line = serde_json::to_vec(message).map_err(io::Error::other)?;
        if line.len() > MAX_LINE_BYTES {
            line = match message {
                Outgoing::Result { id, .. } | Outgoing::Error { id, .. } => {
                    serde_json::to_vec(&Outgoing::error(
                        *id,
                        ErrorCode::ResponseTooLarge,
                        "Daemon response exceeds the RPC line limit.",
                    ))
                    .map_err(io::Error::other)?
                }
                Outgoing::Event { .. } => return Ok(()),
            };
        }
        if line.len() > MAX_LINE_BYTES {
            return Err(io::Error::other(
                "RESPONSE_TOO_LARGE fallback exceeded the RPC line limit",
            ));
        }
        // Any newline inside a value is escaped by the serialiser, so this is
        // the only `\n` the payload can contain.
        debug_assert!(!line.contains(&b'\n'), "serialised message must be one line");
        line.push(b'\n');
        let mut guard = self
            .inner
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        guard.write_all(&line)?;
        guard.flush()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;
    use std::sync::Arc;

    fn reader(input: &str) -> LineReader<Cursor<Vec<u8>>> {
        LineReader::new(Cursor::new(input.as_bytes().to_vec()))
    }

    #[test]
    fn lines_are_split_on_newlines() {
        let mut r = reader("{\"a\":1}\n{\"b\":2}\n");
        assert_eq!(r.next_line().unwrap(), Line::Text("{\"a\":1}".into()));
        assert_eq!(r.next_line().unwrap(), Line::Text("{\"b\":2}".into()));
        assert_eq!(r.next_line().unwrap(), Line::Eof);
    }

    #[test]
    fn a_trailing_carriage_return_is_stripped() {
        let mut r = reader("{\"a\":1}\r\n");
        assert_eq!(r.next_line().unwrap(), Line::Text("{\"a\":1}".into()));
    }

    #[test]
    fn a_final_line_without_a_terminator_is_still_delivered() {
        let mut r = reader("{\"a\":1}");
        assert_eq!(r.next_line().unwrap(), Line::Text("{\"a\":1}".into()));
        assert_eq!(r.next_line().unwrap(), Line::Eof);
    }

    #[test]
    fn blank_lines_are_delivered_as_empty_text_not_as_eof() {
        // Reporting a blank line as EOF would shut the daemon down over a stray
        // newline from the host.
        let mut r = reader("\n\nx\n");
        assert_eq!(r.next_line().unwrap(), Line::Text(String::new()));
        assert_eq!(r.next_line().unwrap(), Line::Text(String::new()));
        assert_eq!(r.next_line().unwrap(), Line::Text("x".into()));
        assert_eq!(r.next_line().unwrap(), Line::Eof);
    }

    #[test]
    fn an_oversized_line_is_discarded_and_the_stream_stays_in_sync() {
        // Without the cap this allocates the whole thing. With a cap that
        // *truncated* instead of discarding, the fragment would parse as a
        // different, shorter request than the one that was sent.
        let payload = "x".repeat(64);
        let input = format!("{payload}\nshort\n");
        let mut r = LineReader::with_limit(Cursor::new(input.into_bytes()), 16);
        match r.next_line().unwrap() {
            Line::Oversized(n) => assert_eq!(n, 64),
            other => panic!("expected Oversized, got {other:?}"),
        }
        assert_eq!(
            r.next_line().unwrap(),
            Line::Text("short".into()),
            "framing must survive the oversized line"
        );
    }

    #[test]
    fn an_oversized_line_spanning_many_buffer_fills_is_fully_counted() {
        let payload = "y".repeat(10_000);
        let mut r = LineReader::with_limit(Cursor::new(format!("{payload}\nok\n").into_bytes()), 100);
        match r.next_line().unwrap() {
            Line::Oversized(n) => assert_eq!(n, 10_000),
            other => panic!("expected Oversized, got {other:?}"),
        }
        assert_eq!(r.next_line().unwrap(), Line::Text("ok".into()));
    }

    #[test]
    fn a_line_at_exactly_the_limit_is_accepted() {
        let payload = "z".repeat(16);
        let mut r = LineReader::with_limit(Cursor::new(format!("{payload}\n").into_bytes()), 16);
        assert_eq!(r.next_line().unwrap(), Line::Text(payload));
    }

    #[test]
    fn invalid_utf8_is_reported_rather_than_lossily_decoded() {
        let mut r = LineReader::new(Cursor::new(vec![0xFF, 0xFE, b'\n', b'o', b'k', b'\n']));
        assert_eq!(r.next_line().unwrap(), Line::InvalidUtf8);
        assert_eq!(r.next_line().unwrap(), Line::Text("ok".into()));
    }

    /// A writer that records what reaches it, shareable across threads.
    #[derive(Clone, Default)]
    struct Sink(Arc<Mutex<Vec<u8>>>);

    impl Write for Sink {
        fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
            self.0.lock().unwrap().extend_from_slice(buf);
            Ok(buf.len())
        }
        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    #[test]
    fn each_message_is_written_as_exactly_one_line() {
        let sink = Sink::default();
        let writer = MessageWriter::new(Box::new(sink.clone()));
        writer.write(&Outgoing::result(1, serde_json::Value::Null)).unwrap();
        writer.write(&Outgoing::event("ready", serde_json::Value::Null)).unwrap();
        let out = String::from_utf8(sink.0.lock().unwrap().clone()).unwrap();
        assert_eq!(out.lines().count(), 2);
        assert!(out.ends_with('\n'));
    }

    #[test]
    fn an_oversized_response_is_replaced_with_a_correlated_error() {
        let sink = Sink::default();
        let writer = MessageWriter::new(Box::new(sink.clone()));
        writer
            .write(&Outgoing::result(
                7,
                serde_json::json!({ "payload": "x".repeat(MAX_LINE_BYTES) }),
            ))
            .unwrap();

        let out = String::from_utf8(sink.0.lock().unwrap().clone()).unwrap();
        assert!(
            out.trim_end().len() <= MAX_LINE_BYTES,
            "fallback response must respect the line limit"
        );
        let parsed: serde_json::Value = serde_json::from_str(out.trim_end()).unwrap();
        assert_eq!(
            parsed,
            serde_json::json!({
                "id": 7,
                "error": {
                    "code": "RESPONSE_TOO_LARGE",
                    "message": "Daemon response exceeds the RPC line limit."
                }
            })
        );
    }

    #[test]
    fn an_oversized_event_is_dropped_instead_of_breaking_the_peer_reader() {
        let sink = Sink::default();
        let writer = MessageWriter::new(Box::new(sink.clone()));
        writer
            .write(&Outgoing::event(
                "log",
                serde_json::json!({
                    "id": "dhcp",
                    "level": "info",
                    "message": "x".repeat(MAX_LINE_BYTES)
                }),
            ))
            .unwrap();
        assert!(sink.0.lock().unwrap().is_empty());
    }

    #[test]
    fn a_value_containing_a_newline_does_not_break_the_framing() {
        // The framing's one unrecoverable failure is a payload that splits into
        // two lines. Serialiser escaping is what prevents it; this pins it down.
        let sink = Sink::default();
        let writer = MessageWriter::new(Box::new(sink.clone()));
        writer
            .write(&Outgoing::event(
                "log",
                serde_json::json!({ "id": "tftp", "level": "warn", "message": "a\nb\r\nc" }),
            ))
            .unwrap();
        let out = String::from_utf8(sink.0.lock().unwrap().clone()).unwrap();
        assert_eq!(out.lines().count(), 1, "got {out:?}");
    }

    #[test]
    fn concurrent_writers_never_interleave_halves_of_a_line() {
        let sink = Sink::default();
        let writer = Arc::new(MessageWriter::new(Box::new(sink.clone())));
        let mut handles = Vec::new();
        for worker in 0..8u32 {
            let writer = Arc::clone(&writer);
            handles.push(std::thread::spawn(move || {
                for seq in 0..50u32 {
                    writer
                        .write(&Outgoing::event(
                            "log",
                            serde_json::json!({
                                "id": "tftp",
                                "level": "info",
                                "message": format!("{}-{worker}-{seq}", "x".repeat(500))
                            }),
                        ))
                        .unwrap();
                }
            }));
        }
        for handle in handles {
            handle.join().unwrap();
        }
        let out = String::from_utf8(sink.0.lock().unwrap().clone()).unwrap();
        let lines: Vec<&str> = out.lines().collect();
        assert_eq!(lines.len(), 400);
        for line in lines {
            serde_json::from_str::<serde_json::Value>(line)
                .unwrap_or_else(|e| panic!("corrupt line {line:?}: {e}"));
        }
    }
}
