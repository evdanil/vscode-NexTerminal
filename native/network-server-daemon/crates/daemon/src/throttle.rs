//! Trailing-edge coalescing for `runtimeUpdate` notifications.
//!
//! The engines emit one runtime change per *real* state change — one per TFTP
//! block acknowledged — which is the right granularity in-process and disastrous
//! on a pipe: a firmware image pulled over a fast LAN at a negotiated block size
//! near 1400 bytes produces thousands of JSON lines per second, every one
//! describing a state no human can perceive at that rate. Coalescing here, at
//! the process boundary rather than inside the engines, keeps the event
//! granularity intact upstream while collapsing wire traffic to a rate a UI can
//! render.
//!
//! **Trailing edge, deliberately.** The notification carries only the service
//! id; the host answers it by asking for the current runtime. So an update is
//! useful only if it is delivered *after* the change it announces. A
//! leading-edge throttle would announce the first block of a burst and then stay
//! silent through the rest, leaving the host's view frozen mid-transfer.
//!
//! **Terminal updates bypass the window.** A completed or failed transfer has
//! just left the runtime, and that disappearance must not wait out a window that
//! later pushes keep extending — that is exactly how a finished transfer ends up
//! stuck in the sidebar forever.

use std::collections::HashMap;
use std::sync::mpsc::{self, RecvTimeoutError, Sender, SyncSender};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

/// Coalescing window.
///
/// 10 Hz is roughly the ceiling at which a human reads a changing value, so
/// anything faster is spent on the pipe rather than on the reader.
pub const WINDOW: Duration = Duration::from_millis(100);

/// Idle poll interval when nothing is pending — bounds how long a shutdown
/// waits for the worker to notice.
const IDLE_TICK: Duration = Duration::from_millis(250);

enum Message {
    Push { id: String, terminal: bool },
    Flush(SyncSender<()>),
    Stop,
}

/// Cloneable handle to the coalescer.
#[derive(Debug, Clone)]
pub struct Throttle {
    tx: Sender<Message>,
}

/// Owns the worker thread; kept by the daemon's main function so shutdown can
/// join it after the final flush.
#[derive(Debug)]
pub struct ThrottleWorker {
    join: Option<JoinHandle<()>>,
    tx: Sender<Message>,
}

impl Throttle {
    /// Records that `id`'s runtime changed.
    ///
    /// Ids are coalesced independently, so a busy TFTP transfer cannot delay a
    /// DHCP notification.
    pub fn push(&self, id: &str, terminal: bool) {
        let _ = self.tx.send(Message::Push {
            id: id.to_owned(),
            terminal,
        });
    }
}

impl ThrottleWorker {
    /// Emits every pending update now and waits for them to be written.
    ///
    /// Used at shutdown: a pending window that is simply dropped is a state
    /// change the host is never told about.
    pub fn flush(&self) {
        let (tx, rx) = mpsc::sync_channel(1);
        if self.tx.send(Message::Flush(tx)).is_ok() {
            let _ = rx.recv();
        }
    }

    /// Flushes, stops the worker and joins it.
    pub fn shutdown(&mut self) {
        self.flush();
        let _ = self.tx.send(Message::Stop);
        if let Some(join) = self.join.take() {
            let _ = join.join();
        }
    }
}

impl Drop for ThrottleWorker {
    fn drop(&mut self) {
        self.shutdown();
    }
}

/// Starts the coalescer. `emit` is invoked once per window per id, on the
/// worker thread.
#[must_use]
pub fn spawn<F>(emit: F, window: Duration) -> (Throttle, ThrottleWorker)
where
    F: Fn(&str) + Send + 'static,
{
    let (tx, rx) = mpsc::channel::<Message>();
    let join = std::thread::Builder::new()
        .name("nexus-runtime-throttle".into())
        .spawn(move || {
            let mut pending: HashMap<String, Instant> = HashMap::new();
            loop {
                let wait = pending
                    .values()
                    .min()
                    .map_or(IDLE_TICK, |due| due.saturating_duration_since(Instant::now()));
                match rx.recv_timeout(wait) {
                    Ok(Message::Push { id, terminal }) => {
                        if terminal {
                            pending.remove(&id);
                            emit(&id);
                        } else {
                            // `or_insert`, not `insert`: re-arming the deadline
                            // on every push is a *debounce*, which under a
                            // continuous stream of blocks never fires at all.
                            pending.entry(id).or_insert_with(|| Instant::now() + window);
                        }
                    }
                    Ok(Message::Flush(reply)) => {
                        fire_all(&mut pending, &emit);
                        let _ = reply.send(());
                    }
                    // A `Stop` and a dropped sender mean the same thing: no more
                    // pushes are coming. Both flush first, because a pending
                    // window dropped here is a state change the host is never
                    // told about.
                    Ok(Message::Stop) | Err(RecvTimeoutError::Disconnected) => {
                        fire_all(&mut pending, &emit);
                        break;
                    }
                    Err(RecvTimeoutError::Timeout) => {
                        let now = Instant::now();
                        let due: Vec<String> = pending
                            .iter()
                            .filter(|(_, at)| **at <= now)
                            .map(|(id, _)| id.clone())
                            .collect();
                        for id in due {
                            pending.remove(&id);
                            emit(&id);
                        }
                    }
                }
            }
        })
        .expect("runtime-throttle thread");

    (
        Throttle { tx: tx.clone() },
        ThrottleWorker {
            join: Some(join),
            tx,
        },
    )
}

fn fire_all<F: Fn(&str)>(pending: &mut HashMap<String, Instant>, emit: &F) {
    let ids: Vec<String> = pending.keys().cloned().collect();
    pending.clear();
    for id in ids {
        emit(&id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    fn recorder() -> (Arc<Mutex<Vec<String>>>, impl Fn(&str) + Send + 'static) {
        let seen = Arc::new(Mutex::new(Vec::new()));
        let sink = Arc::clone(&seen);
        (seen, move |id: &str| sink.lock().unwrap().push(id.to_owned()))
    }

    #[test]
    fn a_burst_collapses_to_one_notification_per_window() {
        let (seen, emit) = recorder();
        let (throttle, mut worker) = spawn(emit, Duration::from_millis(40));
        for _ in 0..500 {
            throttle.push("tftp", false);
        }
        std::thread::sleep(Duration::from_millis(150));
        let count = seen.lock().unwrap().len();
        assert!(
            (1..=3).contains(&count),
            "500 pushes collapsed to {count} notifications"
        );
        worker.shutdown();
    }

    #[test]
    fn a_continuous_stream_still_fires_rather_than_being_debounced_away() {
        // The difference between `entry().or_insert()` and `insert()`: with the
        // deadline re-armed on every push, a transfer that never pauses never
        // produces a single notification and the UI freezes mid-transfer.
        let (seen, emit) = recorder();
        let (throttle, mut worker) = spawn(emit, Duration::from_millis(20));
        let deadline = Instant::now() + Duration::from_millis(200);
        while Instant::now() < deadline {
            throttle.push("tftp", false);
            std::thread::sleep(Duration::from_millis(2));
        }
        std::thread::sleep(Duration::from_millis(60));
        assert!(
            seen.lock().unwrap().len() >= 3,
            "a continuous stream must keep producing updates"
        );
        worker.shutdown();
    }

    #[test]
    fn a_terminal_update_is_emitted_immediately() {
        let (seen, emit) = recorder();
        let (throttle, mut worker) = spawn(emit, Duration::from_secs(30));
        throttle.push("tftp", false);
        throttle.push("tftp", true);
        std::thread::sleep(Duration::from_millis(60));
        assert_eq!(
            seen.lock().unwrap().as_slice(),
            &["tftp".to_owned()],
            "a terminal update must not wait out a 30 s window"
        );
        worker.shutdown();
    }

    #[test]
    fn ids_are_coalesced_independently() {
        let (seen, emit) = recorder();
        let (throttle, mut worker) = spawn(emit, Duration::from_secs(30));
        throttle.push("tftp", false);
        throttle.push("dhcp", true);
        std::thread::sleep(Duration::from_millis(60));
        assert_eq!(seen.lock().unwrap().as_slice(), &["dhcp".to_owned()]);
        worker.shutdown();
    }

    #[test]
    fn shutdown_flushes_pending_windows() {
        // A pending window dropped at shutdown is a state change the host is
        // never told about, and its view stays stale until something else moves.
        let (seen, emit) = recorder();
        let (throttle, mut worker) = spawn(emit, Duration::from_secs(30));
        throttle.push("tftp", false);
        worker.shutdown();
        assert_eq!(seen.lock().unwrap().as_slice(), &["tftp".to_owned()]);
    }
}
