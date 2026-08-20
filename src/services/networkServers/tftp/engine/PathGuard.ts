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
 *     at absolute paths in the RRQ/WRQ filename.
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
    this.root = path.resolve(root);
    if (!fs.existsSync(this.root)) {
      throw new Error(`TFTP root does not exist: ${this.root}`);
    }
    if (!fs.statSync(this.root).isDirectory()) {
      throw new Error(`TFTP root is not a directory: ${this.root}`);
    }
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
    await fsPromises.mkdir(parent, { recursive: true });
    // `parent` is only lexically inside `root` — if an ancestor directory
    // component is itself a symlink pointing outside root, the recursive
    // mkdir above just created (or reused) directories through it. `parent`
    // is guaranteed to exist now, so resolve its real path and confirm.
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
