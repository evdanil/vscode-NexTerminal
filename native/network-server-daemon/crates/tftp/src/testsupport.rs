//! Minimal test scaffolding shared by this crate's unit tests and its
//! integration tests.
//!
//! It lives in the library rather than in a `dev-dependency` because the
//! workspace deliberately carries no third-party crates beyond `serde`: a
//! sandbox whose whole job is to be audited is not the place to pull in a
//! transitive tree for the sake of a temp directory.

#![doc(hidden)]

use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

static COUNTER: AtomicU64 = AtomicU64::new(0);

/// A uniquely-named temporary directory, removed when dropped.
#[derive(Debug)]
pub struct TempDir {
    path: PathBuf,
}

impl TempDir {
    /// Creates a directory under the system temp directory.
    ///
    /// Uniqueness comes from the process id, a monotonic counter and the wall
    /// clock, so parallel test binaries and parallel threads within one binary
    /// cannot collide.
    #[must_use]
    #[allow(
        clippy::needless_continue,
        reason = "reads as 'that name was taken, try the next one'"
    )]
    pub fn new(prefix: &str) -> Self {
        let base = std::env::temp_dir();
        for _ in 0..64 {
            let nonce = COUNTER.fetch_add(1, Ordering::Relaxed);
            let stamp = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map_or(0, |d| d.as_nanos());
            let candidate = base.join(format!(
                "nexus-{prefix}-{}-{nonce}-{stamp}",
                std::process::id()
            ));
            match std::fs::create_dir(&candidate) {
                Ok(()) => return Self { path: candidate },
                Err(e) if e.kind() == io::ErrorKind::AlreadyExists => continue,
                Err(e) => panic!("cannot create temp dir under {}: {e}", base.display()),
            }
        }
        panic!("exhausted temp directory name attempts");
    }

    #[must_use]
    pub fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.path);
    }
}

/// Creates a directory symlink, or returns `None` when the platform refuses.
///
/// Windows only grants symlink creation to an elevated process or to one
/// running with Developer Mode enabled. A test that needs one therefore has to
/// be able to opt out at runtime rather than at compile time — and it says so on
/// stderr, so an "all green" run on a machine that skipped them is not mistaken
/// for one that exercised them.
#[must_use]
pub fn symlink_dir(target: &Path, link: &Path) -> Option<()> {
    #[cfg(unix)]
    let result = std::os::unix::fs::symlink(target, link);
    #[cfg(windows)]
    let result = std::os::windows::fs::symlink_dir(target, link);
    #[cfg(not(any(unix, windows)))]
    let result: io::Result<()> = Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "no symlink support",
    ));
    report(result, link)
}

/// Creates a file symlink, or returns `None` when the platform refuses.
///
/// The target need not exist: creating a *dangling* symlink is the whole point
/// of the write-path tests that call this.
#[must_use]
pub fn symlink_file(target: &Path, link: &Path) -> Option<()> {
    #[cfg(unix)]
    let result = std::os::unix::fs::symlink(target, link);
    #[cfg(windows)]
    let result = std::os::windows::fs::symlink_file(target, link);
    #[cfg(not(any(unix, windows)))]
    let result: io::Result<()> = Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "no symlink support",
    ));
    report(result, link)
}

fn report(result: io::Result<()>, link: &Path) -> Option<()> {
    match result {
        Ok(()) => Some(()),
        Err(e) => {
            eprintln!(
                "SKIPPED symlink test: cannot create {} ({e}). \
                 On Windows this needs Developer Mode or an elevated shell.",
                link.display()
            );
            None
        }
    }
}
