//! Filesystem sandbox for the TFTP server.
//!
//! Every filesystem access made on behalf of a client goes through here. The
//! engine MUST NOT touch `std::fs` with a client-supplied name directly.
//!
//! # What it defends, and why each defence exists
//!
//! Each of the following was a demonstrated escape in the reference
//! implementation before it was fixed. None of them is theoretical, and none of
//! them is made safe by Rust's memory safety — they are logic bugs about which
//! *file* is opened, not about memory.
//!
//! * **Lexical containment.** `..` is collapsed against the root by walking
//!   [`std::path::Component`]s, and a `..` that would step above the root is a
//!   violation. Because the walk is component-based, `/rootevil` can never pass
//!   as being inside `/root` the way a string prefix test would allow.
//!
//! * **Leading separators are stripped, not rejected.** A client-supplied
//!   `/etc/passwd` is treated as `etc/passwd` relative to the root. This is a
//!   deliberate decision matching standard TFTP server practice: RFC 1350
//!   defines no absolute-path semantics, because the whole namespace a TFTP
//!   client can see *is* the root. A drive-qualified Windows path has no leading
//!   separator to strip, so it survives as a path prefix and is rejected
//!   outright — different mechanism, same guarantee.
//!
//! * **The root is canonicalised, not merely absolutised.** The root can itself
//!   sit behind a symlinked ancestor outside our control — macOS's `/var` is a
//!   symlink to `/private/var`, and the system temp directory lives under it.
//!   Containment is checked by comparing an already-canonicalised descendant
//!   against this root; if the root were only lexically resolved, *every*
//!   legitimate file under such a root would look like an escape and be
//!   refused.
//!
//! * **Symlink resolution on read.** A path that is lexically inside the root
//!   can still be a symlink — at the leaf or at any ancestor — pointing outside
//!   it. The real path is resolved and re-checked before anything reads through
//!   it.
//!
//! * **`symlink_metadata`, never `metadata`, for the "does it already exist?"
//!   test on write.** [`std::fs::metadata`] follows the final symlink, so a
//!   *dangling* symlink reports `NotFound` — as if nothing were there — even
//!   though a symlink already sits at that path, and the `open` that follows
//!   would create the symlink's target. That is an arbitrary-write primitive
//!   reachable from an unauthenticated WRQ. [`std::fs::symlink_metadata`] (the
//!   `lstat` equivalent) inspects the directory entry itself and never follows
//!   it. This is also the only *portable* defence: POSIX's `O_EXCL` refuses to
//!   create through an existing symlink, but Windows' `CREATE_NEW` follows the
//!   reparse point instead of refusing, so the `open` cannot be relied on.
//!
//! * **Containment is checked BEFORE any directory is created.** Recursive
//!   directory creation only ever makes ordinary directories, so it cannot
//!   itself manufacture an escape — but if an ancestor were *already* a symlink
//!   pointing outside the root, the recursive create would walk straight through
//!   it and make real directories on the far side. That is a filesystem-
//!   modifying primitive reachable from the network whether or not the write
//!   that follows is blocked. Since the parent may not exist yet, the check is
//!   applied to the deepest ancestor that *does* exist — the one whose real
//!   location this request would actually create directories under.
//!
//! * **NUL bytes are rejected.** A NUL survives pure string path manipulation
//!   unchanged. On Windows, where paths are counted UTF-16, an embedded NUL is
//!   the classic truncation trick; on Unix it makes the underlying `CString`
//!   conversion fail with an error that matches no meaningful error class. It is
//!   not an escape, but it is rejected here rather than mis-mapped later.

use std::fmt;
use std::fs;
use std::io;
use std::path::{Component, Path, PathBuf};

/// A root directory that cannot be used as a sandbox.
#[derive(Debug)]
pub enum RootError {
    Missing(PathBuf),
    NotADirectory(PathBuf),
    Io(PathBuf, io::Error),
}

impl fmt::Display for RootError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Missing(p) => write!(f, "TFTP root does not exist: {}", p.display()),
            Self::NotADirectory(p) => write!(f, "TFTP root is not a directory: {}", p.display()),
            Self::Io(p, e) => write!(f, "TFTP root is unusable ({}): {e}", p.display()),
        }
    }
}

impl std::error::Error for RootError {}

/// A client-supplied path was refused, or the filesystem refused the operation.
#[derive(Debug)]
pub enum GuardError {
    /// Confirmed traversal or symlink escape. Maps to ERROR(2) on the wire.
    PathViolation(String),
    /// The path exists but is not a regular file — a directory, a device node,
    /// a fifo. Maps to ERROR(1); RFC 1350 offers nothing more specific.
    NotAFile(String),
    /// A WRQ named a path that already has something at it. Maps to ERROR(6).
    FileAlreadyExists(String),
    /// Anything the filesystem itself refused; mapped by error kind at the call
    /// site so `NotFound`, `PermissionDenied` and out-of-space stay distinct.
    Io(io::Error),
}

impl fmt::Display for GuardError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::PathViolation(name) => write!(f, "Path traversal blocked: {name}"),
            Self::NotAFile(name) => write!(f, "Not a file: {name}"),
            Self::FileAlreadyExists(name) => write!(f, "File already exists: {name}"),
            Self::Io(e) => write!(f, "{e}"),
        }
    }
}

impl std::error::Error for GuardError {}

impl From<io::Error> for GuardError {
    fn from(value: io::Error) -> Self {
        Self::Io(value)
    }
}

/// A file accepted for reading.
#[derive(Debug, Clone)]
pub struct StatResult {
    pub size: u64,
    pub abs_path: PathBuf,
}

/// Mediates all client-driven filesystem access for one TFTP service.
#[derive(Debug, Clone)]
pub struct PathGuard {
    root: PathBuf,
}

impl PathGuard {
    /// Anchors a sandbox at `root`, which must already exist and be a directory.
    ///
    /// Validation happens here — at service start — rather than lazily on the
    /// first request. A root checked per request meant a misconfigured service
    /// still bound its socket and reported "running", then failed outside the
    /// request's own error handling so no TFTP ERROR was ever sent: every client
    /// simply timed out, with nothing anywhere saying why.
    pub fn new(root: impl AsRef<Path>) -> Result<Self, RootError> {
        let requested = root.as_ref();
        let absolute = if requested.is_absolute() {
            requested.to_path_buf()
        } else {
            std::env::current_dir()
                .map_err(|e| RootError::Io(requested.to_path_buf(), e))?
                .join(requested)
        };
        match fs::metadata(&absolute) {
            Ok(meta) if meta.is_dir() => {}
            Ok(_) => return Err(RootError::NotADirectory(absolute)),
            Err(e) if e.kind() == io::ErrorKind::NotFound => {
                return Err(RootError::Missing(absolute))
            }
            Err(e) => return Err(RootError::Io(absolute, e)),
        }
        let canonical =
            fs::canonicalize(&absolute).map_err(|e| RootError::Io(absolute.clone(), e))?;
        Ok(Self { root: canonical })
    }

    /// The canonicalised sandbox root.
    ///
    /// On Windows this carries the `\\?\` verbatim prefix that
    /// [`fs::canonicalize`] produces. That is correct for filesystem calls and
    /// deliberately *not* what the daemon reports to the UI, which echoes the
    /// operator's configured path instead.
    #[must_use]
    pub fn root(&self) -> &Path {
        &self.root
    }

    /// Maps a client-supplied filename onto an absolute path inside the root,
    /// using lexical containment only. Symlinks are handled by the callers that
    /// go on to touch the filesystem.
    pub fn resolve(&self, filename: &str) -> Result<PathBuf, GuardError> {
        if filename.contains('\0') {
            return Err(GuardError::PathViolation(filename.to_owned()));
        }
        let cleaned = filename.trim_start_matches(['/', '\\']);
        let mut segments: Vec<&std::ffi::OsStr> = Vec::new();
        for component in Path::new(cleaned).components() {
            match component {
                Component::Normal(segment) => {
                    reject_reserved_device_name(segment, filename)?;
                    segments.push(segment);
                }
                Component::CurDir => {}
                Component::ParentDir => {
                    // Stepping above the root is the escape this whole type
                    // exists to stop. There is no "clamp at root" fallback: a
                    // request that tried is answered with a violation.
                    if segments.pop().is_none() {
                        return Err(GuardError::PathViolation(filename.to_owned()));
                    }
                }
                // Reachable only on Windows, and only for a path that carries
                // its own prefix (`C:\x`, `\\?\C:\x`, `\\server\share\x`) —
                // leading separators were already stripped above. Such a path
                // names a location the root has no say over.
                Component::RootDir | Component::Prefix(_) => {
                    return Err(GuardError::PathViolation(filename.to_owned()))
                }
            }
        }
        if segments.is_empty() {
            // The request resolved to the root itself, which is a directory and
            // never a legal RRQ/WRQ target.
            return Err(GuardError::PathViolation(filename.to_owned()));
        }
        let mut absolute = self.root.clone();
        for segment in segments {
            absolute.push(segment);
        }
        Ok(absolute)
    }

    /// Validates a filename for reading (RRQ) and reports its size.
    pub fn stat_file(&self, filename: &str) -> Result<StatResult, GuardError> {
        let absolute = self.resolve(filename)?;
        // Follows symlinks, exactly as the read that comes after it will.
        let meta = fs::metadata(&absolute)?;
        if !meta.is_file() {
            // Also what keeps a Windows device name (`NUL`, `COM1`) from being
            // served even if one slipped past the name check in `resolve`: a
            // character device is not a regular file.
            return Err(GuardError::NotAFile(filename.to_owned()));
        }
        // `absolute` is only *lexically* inside the root. A symlink at the leaf,
        // or at any ancestor, can still resolve outside it — `metadata` above
        // already followed that chain to answer `is_file()`. Verify the same
        // real path it followed is contained before anything reads through it.
        let real = fs::canonicalize(&absolute)?;
        self.assert_contained(&real, filename)?;
        Ok(StatResult {
            size: meta.len(),
            abs_path: absolute,
        })
    }

    /// Prepares a filename for writing (WRQ): refuses to overwrite, and creates
    /// the parent directories a PXE client assumes already exist.
    ///
    /// Returns the path the caller should open with create-new semantics. It
    /// deliberately does not probe writability: the authoritative answer is the
    /// `create_new` open the caller performs next, whose error maps to the same
    /// wire codes, and an advisory probe here would only add a syscall and a
    /// window between check and use.
    pub fn ensure_writable_new(&self, filename: &str) -> Result<PathBuf, GuardError> {
        let absolute = self.resolve(filename)?;
        // `resolve` guarantees at least one segment, so the parent is the root
        // at worst and this cannot be `None`.
        let parent = absolute
            .parent()
            .ok_or_else(|| GuardError::PathViolation(filename.to_owned()))?
            .to_path_buf();

        // BEFORE any directory is created — see the module header. The parent
        // may not exist yet, so canonicalise the deepest ancestor that does:
        // that is the one whose real location this request would create
        // directories under.
        let anchor = deepest_existing_ancestor(&parent);
        let real_anchor = fs::canonicalize(&anchor)?;
        self.assert_contained(&real_anchor, filename)?;

        fs::create_dir_all(&parent)?;

        // Re-check the parent itself now that it is guaranteed to exist. This is
        // defence in depth against the (much narrower, locally-timed) race
        // between the check above and the create, not the primary defence.
        let real_parent = fs::canonicalize(&parent)?;
        self.assert_contained(&real_parent, filename)?;

        // `symlink_metadata`, not `metadata`: see the module header. A dangling
        // symlink must read as "something is already here", not as "nothing is
        // here".
        match fs::symlink_metadata(&absolute) {
            Ok(_) => return Err(GuardError::FileAlreadyExists(filename.to_owned())),
            Err(e) if e.kind() == io::ErrorKind::NotFound => {}
            Err(e) => return Err(GuardError::Io(e)),
        }
        Ok(absolute)
    }

    /// Confirms a real (symlink-resolved) path is still inside the root.
    ///
    /// [`Path::starts_with`] compares whole components, so `/srv/tftp-evil` is
    /// correctly *not* inside `/srv/tftp`; a string prefix test would accept it.
    fn assert_contained(&self, real: &Path, filename: &str) -> Result<(), GuardError> {
        if real.starts_with(&self.root) {
            Ok(())
        } else {
            Err(GuardError::PathViolation(filename.to_owned()))
        }
    }
}

/// Walks up from `dir` to the nearest ancestor that exists on disk.
///
/// Always terminates: the walk stops at the filesystem root at the latest, and
/// in practice at the sandbox root, which the constructor proved exists.
fn deepest_existing_ancestor(dir: &Path) -> PathBuf {
    let mut current = dir;
    loop {
        if fs::metadata(current).is_ok() {
            return current.to_path_buf();
        }
        match current.parent() {
            Some(parent) if parent != current => current = parent,
            _ => return current.to_path_buf(),
        }
    }
}

/// Windows resolves the legacy DOS device names in *any* directory, so
/// `<root>/NUL` opens the null device rather than a file inside the sandbox and
/// `<root>/COM1` opens a serial port. That is an escape from the sandbox even
/// though the path is lexically contained.
///
/// This goes beyond the reference implementation, which relied on the
/// `is_file()` check in [`PathGuard::stat_file`] to reject the resulting
/// character device. That check does hold for reads, but nothing equivalent
/// protects a write, so the names are refused by name as well.
///
/// Compiled on every platform and applied on every platform: a root shared over
/// SMB can be served by a Unix daemon and consumed by a Windows client, and the
/// name is dangerous wherever it is *interpreted*, not wherever it is created.
fn reject_reserved_device_name(
    segment: &std::ffi::OsStr,
    filename: &str,
) -> Result<(), GuardError> {
    const RESERVED: [&str; 22] = [
        "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
        "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
    ];
    let Some(text) = segment.to_str() else {
        // A non-UTF-8 segment cannot spell an ASCII device name.
        return Ok(());
    };
    // Windows ignores everything from the first dot, plus trailing dots and
    // spaces, when matching a device name: `NUL.txt`, `nul ` and `NUL.` all
    // reach the null device.
    let stem = text.split('.').next().unwrap_or(text);
    let stem = stem.trim_end_matches([' ', '.']);
    if RESERVED.iter().any(|r| stem.eq_ignore_ascii_case(r)) {
        return Err(GuardError::PathViolation(filename.to_owned()));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testsupport::{symlink_dir, symlink_file, TempDir};

    fn guard_in(dir: &TempDir) -> PathGuard {
        PathGuard::new(dir.path()).expect("temp dir is a usable root")
    }

    // --- constructor ---------------------------------------------------------

    #[test]
    fn a_missing_root_is_refused_with_a_specific_message() {
        let temp = TempDir::new("pg-missing");
        let err = PathGuard::new(temp.path().join("does-not-exist")).unwrap_err();
        assert!(matches!(err, RootError::Missing(_)), "got {err}");
        assert!(err.to_string().contains("does not exist"));
    }

    #[test]
    fn a_root_that_is_a_file_is_refused_with_a_specific_message() {
        let temp = TempDir::new("pg-file-root");
        let file = temp.path().join("root.txt");
        fs::write(&file, b"x").unwrap();
        let err = PathGuard::new(&file).unwrap_err();
        assert!(matches!(err, RootError::NotADirectory(_)), "got {err}");
        assert!(err.to_string().contains("not a directory"));
    }

    #[test]
    fn the_root_is_canonicalised_not_merely_absolutised() {
        let temp = TempDir::new("pg-canon");
        let guard = guard_in(&temp);
        assert_eq!(guard.root(), fs::canonicalize(temp.path()).unwrap());
    }

    // --- resolve -------------------------------------------------------------

    #[test]
    fn ordinary_and_nested_names_resolve_under_the_root() {
        let temp = TempDir::new("pg-resolve");
        let guard = guard_in(&temp);
        assert_eq!(
            guard.resolve("firmware.bin").unwrap(),
            guard.root().join("firmware.bin")
        );
        assert_eq!(
            guard.resolve("a/b/c.bin").unwrap(),
            guard.root().join("a").join("b").join("c.bin")
        );
    }

    #[test]
    fn a_leading_separator_is_stripped_not_rejected() {
        let temp = TempDir::new("pg-leading");
        let guard = guard_in(&temp);
        assert_eq!(
            guard.resolve("/firmware.bin").unwrap(),
            guard.root().join("firmware.bin")
        );
        assert_eq!(
            guard.resolve("\\firmware.bin").unwrap(),
            guard.root().join("firmware.bin")
        );
    }

    #[test]
    fn every_traversal_shape_is_refused() {
        let temp = TempDir::new("pg-traverse");
        let guard = guard_in(&temp);
        for attempt in [
            "../escape.txt",
            "a/b/../../../x.bin",
            "a\\b/../../../x.bin",
            "..",
            "/../escape.txt",
            "./../../escape.txt",
            "",
            "/",
        ] {
            assert!(
                matches!(guard.resolve(attempt), Err(GuardError::PathViolation(_))),
                "{attempt:?} must be refused"
            );
        }
    }

    #[test]
    fn dots_inside_a_name_are_not_traversal() {
        let temp = TempDir::new("pg-dots");
        let guard = guard_in(&temp);
        assert_eq!(
            guard.resolve("my..file.bin").unwrap(),
            guard.root().join("my..file.bin")
        );
        assert_eq!(
            guard.resolve("...").unwrap(),
            guard.root().join("...")
        );
    }

    #[test]
    fn a_nul_byte_is_refused_rather_than_handed_to_the_filesystem() {
        let temp = TempDir::new("pg-nul");
        let guard = guard_in(&temp);
        // Without the explicit check this reaches the OS, where on Windows the
        // counted UTF-16 path is truncated at the NUL and the request is served
        // as `passwd` — a different file than the one that was validated.
        assert!(matches!(
            guard.resolve("passwd\0.bin"),
            Err(GuardError::PathViolation(_))
        ));
    }

    #[test]
    fn a_drive_qualified_path_cannot_re_anchor_the_resolution() {
        let temp = TempDir::new("pg-drive");
        let guard = guard_in(&temp);
        // On Windows this parses as a path prefix and is refused outright. On
        // Unix `C:` is an ordinary filename component, so it lands inside the
        // root — contained either way, which is the property under test.
        let resolved = guard.resolve("C:\\Windows\\System32\\config\\SAM");
        match resolved {
            Err(GuardError::PathViolation(_)) => {}
            Ok(path) => assert!(
                path.starts_with(guard.root()),
                "{} escaped the root",
                path.display()
            ),
            Err(other) => panic!("unexpected {other}"),
        }
    }

    #[test]
    fn windows_device_names_are_refused_in_any_position() {
        let temp = TempDir::new("pg-device");
        let guard = guard_in(&temp);
        for attempt in ["NUL", "nul", "com1", "LPT9", "NUL.txt", "sub/CON", "aux ", "NUL."] {
            assert!(
                matches!(guard.resolve(attempt), Err(GuardError::PathViolation(_))),
                "{attempt:?} reaches a DOS device on Windows and must be refused"
            );
        }
        // Names that merely start with a device name are ordinary files.
        assert!(guard.resolve("console.log").is_ok());
        assert!(guard.resolve("nulls.bin").is_ok());
    }

    #[test]
    fn a_sibling_directory_sharing_the_root_prefix_is_not_inside_it() {
        // `Path::starts_with` is component-wise; a string prefix test would
        // accept `/tmp/root-evil` as living inside `/tmp/root`.
        let temp = TempDir::new("pg-prefix");
        let root = temp.path().join("root");
        let sibling = temp.path().join("root-evil");
        fs::create_dir(&root).unwrap();
        fs::create_dir(&sibling).unwrap();
        let guard = PathGuard::new(&root).unwrap();
        let intruder = fs::canonicalize(&sibling).unwrap().join("x.bin");
        assert!(matches!(
            guard.assert_contained(&intruder, "x.bin"),
            Err(GuardError::PathViolation(_))
        ));
    }

    // --- stat_file -----------------------------------------------------------

    #[test]
    fn stat_file_reports_size_and_path_for_a_real_file() {
        let temp = TempDir::new("pg-stat");
        let guard = guard_in(&temp);
        fs::write(guard.root().join("x.bin"), vec![7u8; 1234]).unwrap();
        let stat = guard.stat_file("x.bin").unwrap();
        assert_eq!(stat.size, 1234);
        assert_eq!(stat.abs_path, guard.root().join("x.bin"));
    }

    #[test]
    fn stat_file_separates_missing_from_not_a_file() {
        let temp = TempDir::new("pg-stat-kinds");
        let guard = guard_in(&temp);
        assert!(matches!(
            guard.stat_file("nope.bin"),
            Err(GuardError::Io(e)) if e.kind() == io::ErrorKind::NotFound
        ));
        fs::create_dir(guard.root().join("subdir")).unwrap();
        assert!(matches!(
            guard.stat_file("subdir"),
            Err(GuardError::NotAFile(_))
        ));
    }

    #[test]
    fn a_symlink_inside_the_root_pointing_outside_it_is_refused() {
        // Reverting the canonicalisation in `stat_file` makes this pass a
        // size/path pair for a file that physically lives outside the sandbox:
        // the link's own path is squarely inside the root, so lexical
        // containment alone sees nothing wrong.
        let outside = TempDir::new("pg-outside");
        let temp = TempDir::new("pg-symlink-read");
        let guard = guard_in(&temp);
        let secret = outside.path().join("secret.txt");
        fs::write(&secret, b"outside the sandbox").unwrap();
        let Some(()) = symlink_file(&secret, &guard.root().join("leak")) else {
            return; // platform refuses symlink creation for this user
        };
        assert!(matches!(
            guard.stat_file("leak"),
            Err(GuardError::PathViolation(_))
        ));
    }

    // --- ensure_writable_new -------------------------------------------------

    #[test]
    fn a_new_file_is_accepted_without_being_created() {
        let temp = TempDir::new("pg-new");
        let guard = guard_in(&temp);
        let abs = guard.ensure_writable_new("new.bin").unwrap();
        assert_eq!(abs, guard.root().join("new.bin"));
        assert!(!abs.exists(), "the guard validates, it does not create");
    }

    #[test]
    fn an_existing_file_is_refused() {
        let temp = TempDir::new("pg-exists");
        let guard = guard_in(&temp);
        fs::write(guard.root().join("exists.bin"), b"hi").unwrap();
        assert!(matches!(
            guard.ensure_writable_new("exists.bin"),
            Err(GuardError::FileAlreadyExists(_))
        ));
    }

    #[test]
    fn traversal_is_refused_on_the_write_path_too() {
        let temp = TempDir::new("pg-write-traverse");
        let guard = guard_in(&temp);
        assert!(matches!(
            guard.ensure_writable_new("../outside.bin"),
            Err(GuardError::PathViolation(_))
        ));
    }

    #[test]
    fn missing_parent_directories_are_created_recursively() {
        // PXE clients WRQ into directories that do not exist yet; without this
        // the open fails with NotFound and the upload never starts.
        let temp = TempDir::new("pg-mkdir");
        let guard = guard_in(&temp);
        let abs = guard
            .ensure_writable_new("a/deeply/nested/folder/upload.bin")
            .unwrap();
        let parent = guard.root().join("a/deeply/nested/folder");
        assert!(parent.is_dir(), "parents were not created recursively");
        assert_eq!(abs, parent.join("upload.bin"));
    }

    #[test]
    fn a_dangling_symlink_at_the_destination_is_not_an_arbitrary_write() {
        // With `metadata` instead of `symlink_metadata` this returns Ok: the
        // link's target does not exist, so the follow reports NotFound and the
        // caller goes on to open — through the link — and create the target
        // outside the sandbox.
        let outside = TempDir::new("pg-dangling-outside");
        let temp = TempDir::new("pg-dangling");
        let guard = guard_in(&temp);
        let target = outside.path().join("arbitrary.txt");
        let Some(()) = symlink_file(&target, &guard.root().join("danger")) else {
            return;
        };
        assert!(
            matches!(
                guard.ensure_writable_new("danger"),
                Err(GuardError::FileAlreadyExists(_))
            ),
            "a dangling symlink must read as 'something is already here'"
        );
        assert!(!target.exists(), "nothing may have been created outside the root");
    }

    #[test]
    fn an_ancestor_that_is_a_symlink_out_of_the_root_is_refused() {
        let outside = TempDir::new("pg-anc-outside");
        let temp = TempDir::new("pg-ancestor");
        let guard = guard_in(&temp);
        let Some(()) = symlink_dir(outside.path(), &guard.root().join("linkedDir")) else {
            return;
        };
        assert!(matches!(
            guard.ensure_writable_new("linkedDir/upload.bin"),
            Err(GuardError::PathViolation(_))
        ));
        assert!(!outside.path().join("upload.bin").exists());
    }

    #[test]
    fn a_deep_path_through_a_symlinked_ancestor_creates_nothing_outside_the_root() {
        // This is the test the ORDER of the check depends on. The shallow case
        // above passes either way: `linkedDir` already exists, so the recursive
        // create has nothing to make and a post-create check still rejects. The
        // ordering only becomes observable when the path names directories that
        // do NOT exist yet — then a create performed before the containment
        // check walks straight through the symlink and manufactures real
        // directories on the far side of the sandbox. That is a filesystem-
        // modifying primitive reachable from an unauthenticated WRQ, whether or
        // not the write that follows is blocked.
        let outside = TempDir::new("pg-deep-outside");
        let temp = TempDir::new("pg-deep");
        let guard = guard_in(&temp);
        let Some(()) = symlink_dir(outside.path(), &guard.root().join("linkedDir")) else {
            return;
        };
        assert!(matches!(
            guard.ensure_writable_new("linkedDir/a/b/c/upload.bin"),
            Err(GuardError::PathViolation(_))
        ));
        assert!(
            !outside.path().join("a").exists(),
            "the recursive create must not run before the escape is detected"
        );
        assert_eq!(
            fs::read_dir(outside.path()).unwrap().count(),
            0,
            "nothing at all may be created outside the root"
        );
    }

    // --- a root that itself sits behind a symlink ----------------------------
    //
    // The mirror image of the tests above, and the reason the constructor
    // canonicalises. Comparing an already-dereferenced descendant against a root
    // that was only lexically resolved makes every file under such a root look
    // like an escape — which is exactly what happens on macOS, where the system
    // temp directory lives under `/var` → `/private/var`.

    #[test]
    fn a_root_behind_a_symlink_still_serves_the_files_under_it() {
        let temp = TempDir::new("pg-linked-root");
        let real = temp.path().join("real");
        let linked = temp.path().join("linked");
        fs::create_dir(&real).unwrap();
        let Some(()) = symlink_dir(&real, &linked) else {
            return;
        };
        fs::write(real.join("firmware.bin"), vec![3u8; 2048]).unwrap();

        let guard = PathGuard::new(&linked).unwrap();
        let stat = guard.stat_file("firmware.bin").unwrap();
        assert_eq!(stat.size, 2048);

        let abs = guard.ensure_writable_new("a/b/upload.bin").unwrap();
        assert!(abs.starts_with(guard.root()));
        assert!(real.join("a/b").is_dir());

        assert!(matches!(
            guard.resolve("../escape.bin"),
            Err(GuardError::PathViolation(_))
        ));
    }
}
