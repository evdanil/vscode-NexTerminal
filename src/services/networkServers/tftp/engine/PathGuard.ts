/** @author kanekitakitos */
/**
 * @author kanekitakitos
 *
 * Path guardian (sandbox) for the TFTP server.
 *
 * Ensures that all filesystem accesses remain strictly inside an authorized
 * root directory (`root`), preventing path-traversal attacks
 * (e.g., `../../etc/passwd`).
 *
 * Also ensures that parent directories are automatically created
 * (recursive mkdir) before a write, in accordance with the expectation
 * of modern TFTP clients.
 *
 * Security mechanisms:
 *   - Normalization via `path.resolve` (collapses `../`, relative symlinks, etc.)
 *   - Verification via `path.relative` against `root`: any path that
 *     "escapes" upwards (starts with `..` or is absolute) is rejected.
 *   - Stripping of leading slashes (`/` and `\`) to neutralize attempts
 *     at absolute paths in the RRQ/WRQ filename. **This is a deliberate
 *     decision, not an oversight**: a client-supplied absolute path (e.g.
 *     `/etc/passwd` or a Windows drive path) is treated as relative-to-root
 *     by stripping its leading separator, matching standard TFTP server
 *     practice (RFC 1350 defines no absolute-path semantics — the whole
 *     namespace a TFTP client sees IS the root) rather than being rejected
 *     outright.
 *   - `realpath` verification (see {@link assertRealPathContained}) against
 *     both the resolved path and, for writes, its parent directory — a
 *     symlink inside root pointing outside it, or an ancestor directory
 *     that is itself such a symlink, is rejected even though it passes the
 *     lexical check above.
 */

import path from 'node:path';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';

/**
 * Mediates all file path access for the TFTP server,
 * ensuring that no operation leaves an authorized root directory.
 *
 * The {@link TftpEngine} filesystem operations MUST ALWAYS go
 * through here — never use `fs` directly with paths coming from the client.
 */
export class PathGuard {
  /** Resolved absolute path of the authorized root directory. */
  public readonly root: string;

  /**
   * Creates a new PathGuard anchored to `root`.
   *
   * @param root Allowed root directory (relative or absolute).
   * @throws {Error} if the directory does not exist or is not a directory.
   */
  public constructor(root: string) {
    const resolved = path.resolve(root);
    if (!fs.existsSync(resolved)) {
      throw new Error(`TFTP root does not exist: ${resolved}`);
    }
    if (!fs.statSync(resolved).isDirectory()) {
      throw new Error(`TFTP root is not a directory: ${resolved}`);
    }
    // realpath, not just resolve: `root` can itself sit behind a symlinked
    // ancestor outside our control — macOS's /var is a symlink to /private/var,
    // and os.tmpdir() (a common default parent for a configured root) lives
    // under it. assertRealPathContained() compares an already-realpath'd
    // descendant against `this.root`; if `this.root` were only lexically
    // resolved, every legitimate file under such a root would realpath to
    // something path.relative sees as "outside" this un-dereferenced root,
    // and get rejected as an escape.
    this.root = fs.realpathSync(resolved);
  }

  /**
   * Resolves a `filename` coming from the client to a safe absolute path,
   * ensuring that it remains inside {@link root}.
   *
   * @param filename Path provided by the client (RRQ/WRQ).
   * @returns Safe absolute path for use in `fs`.
   * @throws {PathViolationError} if the resolved path leaves `root`.
   */
  public resolve(filename: string): string {
    // A NUL byte survives path.resolve()/path.relative() unchanged (they are
    // pure string operations), so it would otherwise reach an `fs` call
    // holding a filename fs itself rejects with `ERR_INVALID_ARG_VALUE` — a
    // TypeError, not an NodeJS.ErrnoException, so it does not match any
    // `err.code` branch in the caller's wire-error mapping. Not an escape,
    // but reject it here rather than as an unhandled/mismapped error later.
    if (filename.includes('\0')) {
      throw new PathViolationError(filename);
    }
    const cleaned = filename.replace(/^[\/\\]+/, '');
    const absolute = path.resolve(this.root, cleaned);
    const relative = path.relative(this.root, absolute);
    if (
      !relative ||
      relative === '..' ||
      relative.startsWith('..' + path.sep) ||
      relative.startsWith('..' + path.posix.sep) ||
      path.isAbsolute(relative)
    ) {
      throw new PathViolationError(filename);
    }
    return absolute;
  }

  /**
   * Verifies that a file exists and is a regular file (not a directory,
   * socket, etc.), required before an RRQ.
   *
   * @param filename Path relative to root (coming from the client).
   * @returns File size and resolved absolute path.
   * @throws {PathViolationError} on path-traversal.
   * @throws {NotAFileError} if the path exists but is not a file.
   * @throws {NodeJS.ErrnoException} other FS errors (e.g., ENOENT).
   */
  public async statFile(filename: string): Promise<{ size: number; absPath: string }> {
    const abs = this.resolve(filename);
    const st = await fsPromises.stat(abs);
    if (!st.isFile()) throw new NotAFileError(filename);
    // `abs` is only lexically inside `root` — a symlink at `abs` itself, or at
    // any ancestor, can still resolve outside it. `stat` above already
    // followed that chain to answer `isFile()`; verify the same real path it
    // followed is still contained before anything reads through it.
    this.assertRealPathContained(await fsPromises.realpath(abs), filename);
    return { size: st.size, absPath: abs };
  }

  /**
   * Prepares a path for WRQ: ensures the file does NOT exist yet,
   * creates all necessary parent directories (recursive mkdir) and validates
   * write permissions on the destination directory.
   *
   * @param filename Path relative to root.
   * @returns Safe absolute path, ready for `fs.open(..., 'w')`.
   * @throws {PathViolationError}    if there is path-traversal.
   * @throws {FileAlreadyExistsError} if the file already exists.
   * @throws {NodeJS.ErrnoException}  EACCES/EPERM if no write access, etc.
   */
  public async ensureWritableNew(filename: string): Promise<string> {
    const abs = this.resolve(filename);
    const parent = path.dirname(abs);
    // Containment must be checked BEFORE any directory is created, not after:
    // `mkdir(parent, {recursive:true})` only ever creates ordinary
    // directories, so it cannot itself manufacture an escape — but if some
    // ancestor of `parent` were ALREADY a symlink pointing outside root
    // (planted before this request), recursive mkdir would walk straight
    // through it and create new, real directories on the far side, which is
    // itself a filesystem-modifying primitive reachable from the network,
    // regardless of whether the later write is blocked. `parent` itself may
    // not exist yet, so realpath the deepest ancestor that DOES exist —
    // that is the one whose real location this request would actually create
    // directories under.
    this.assertRealPathContained(await fsPromises.realpath(await this.deepestExistingAncestor(parent)), filename);
    await fsPromises.mkdir(parent, { recursive: true });
    // Re-check `parent` itself now that it is guaranteed to exist: this is
    // defense-in-depth against the (much narrower, local-attacker-timed)
    // TOCTOU race between the check above and this mkdir, not the primary
    // defense.
    this.assertRealPathContained(await fsPromises.realpath(parent), filename);
    try {
      // lstat, not access()/stat(): both of those follow the final symlink,
      // so a *dangling* symlink at `abs` reports ENOENT — as if nothing
      // exists — even though a symlink file already sits at that path. lstat
      // inspects the directory entry itself and never follows it, so a
      // symlink (dangling or not) is correctly seen as "already something
      // here." This is also the only *portable* defense against it: POSIX's
      // O_EXCL refuses to create through an existing symlink, but Windows'
      // CreateFile(CREATE_NEW) does not — it follows the reparse point and
      // creates the symlink's target — so the actual `open()` this path is
      // handed to cannot be relied on to catch this on every platform.
      await fsPromises.lstat(abs);
      throw new FileAlreadyExistsError(filename);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    await fsPromises.access(parent, fs.constants.W_OK);
    return abs;
  }

  /**
   * Walks up from `dir` to the nearest ancestor that actually exists on
   * disk. Used before a recursive `mkdir`, whose real containment depends on
   * where that first *existing* ancestor really is, not on the (possibly
   * still-nonexistent) path being created.
   *
   * Always terminates at {@link root} at the latest, since the constructor
   * already guarantees `root` exists.
   */
  private async deepestExistingAncestor(dir: string): Promise<string> {
    let current = dir;
    for (;;) {
      try {
        await fsPromises.stat(current);
        return current;
      } catch {
        const up = path.dirname(current);
        if (up === current) return current; // filesystem root; stat would have thrown above already
        current = up;
      }
    }
  }

  /**
   * Confirms a real (symlink-resolved) path is still inside {@link root}.
   * Shares the same relative-path containment logic as {@link resolve},
   * applied to a path the OS has already dereferenced rather than one built
   * lexically from client input.
   */
  private assertRealPathContained(real: string, filename: string): void {
    const relative = path.relative(this.root, real);
    if (relative === '' ) return;
    if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
      throw new PathViolationError(filename);
    }
  }
}

/**
 * Thrown when a client attempts to access a path outside the authorized
 * root directory (confirmed path-traversal attempt).
 *
 * Typically maps to a {@link ErrorCode.AccessViolation} on the wire.
 */
export class PathViolationError extends Error {
  public constructor(filename: string) {
    super(`Path traversal blocked: ${filename}`);
    this.name = 'PathViolationError';
  }
}

/**
 * Thrown when a path exists but is not a regular file
 * (e.g., directory, device node, fifo).
 *
 * Maps to {@link ErrorCode.FileNotFound} on the wire (RFC 1350 does not
 * provide a more specific code).
 */
export class NotAFileError extends Error {
  public constructor(filename: string) {
    super(`Not a file: ${filename}`);
    this.name = 'NotAFileError';
  }
}

/**
 * Thrown by {@link PathGuard.ensureWritableNew} when the WRQ refers
 * to a file that already exists on the filesystem.
 *
 * Directly corresponds to {@link ErrorCode.FileAlreadyExists}.
 */
export class FileAlreadyExistsError extends Error {
  public constructor(filename: string) {
    super(`File already exists: ${filename}`);
    this.name = 'FileAlreadyExistsError';
  }
}
