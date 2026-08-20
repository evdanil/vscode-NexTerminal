/**
 * @author kanekitakitos
 *
 * Unit tests for the TFTP filesystem sandbox (`tftp/engine/PathGuard.ts`).
 *
 * Scope: the chroot-like boundary a client-supplied filename has to survive
 * before any `fs` call is made with it —
 *  1. Constructor rejects a missing root or a root that is a file.
 *  2. resolve() blocks every traversal shape (`../`, mixed separators, bare
 *     `..`, absolute paths) while still accepting `..` inside a filename.
 *  3. statFile() distinguishes ENOENT from NotAFileError.
 *  4. ensureWritableNew() refuses to overwrite and creates parent directories
 *     recursively (PXE clients WRQ into directories that do not exist yet).
 *
 * Real temp directories are used rather than a mocked `fs`: the module under
 * test is pure Node with no `vscode` coupling, and path normalization is
 * exactly the behaviour a mock would have to re-implement (and get wrong).
 *
 * Ported from the standalone add-on's `tests/unit/pathguard.test.ts`.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  PathGuard,
  PathViolationError,
  NotAFileError,
  FileAlreadyExistsError
} from "../../../src/services/networkServers/tftp/engine/PathGuard";
import { mkdtemp, randomPayload } from "../../helpers/networkServerTestHelpers";

describe("TFTP PathGuard (PathGuard.ts) — Pure+fs", () => {
  let root: string;
  let guard: PathGuard;

  beforeEach(() => {
    root = mkdtemp("nexus-pg-");
    guard = new PathGuard(root);
  });

  afterEach(() => {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  describe("constructor", () => {
    it("throws error if root directory does not exist", () => {
      expect(() => new PathGuard(path.join(root, "does-not-exist-xyz"))).toThrow();
    });

    it("throws error if root is a file instead of directory", () => {
      const f = path.join(root, "file.txt");
      fs.writeFileSync(f, "hi");
      expect(() => new PathGuard(f)).toThrow();
    });

    it("valid root: this.root === path.resolve(...)", () => {
      expect(guard.root).toBe(path.resolve(root));
    });
  });

  describe("resolve() — path traversal blocking", () => {
    it("normal filename returns absolute {root}/{filename}", () => {
      const abs = guard.resolve("firmware.bin");
      expect(abs).toBe(path.join(root, "firmware.bin"));
    });

    it("nested subdir a/b/c.bin ok", () => {
      const abs = guard.resolve("a/b/c.bin");
      expect(abs).toBe(path.join(root, "a", "b", "c.bin"));
    });

    it("leading slash /firmware.bin accepted but resolved to root", () => {
      const abs = guard.resolve("/firmware.bin");
      expect(abs).toBe(path.join(root, "firmware.bin"));
    });

    it("leading backslash Windows \\firmware.bin accepted and resolved", () => {
      const abs = guard.resolve("\\firmware.bin");
      expect(abs).toBe(path.join(root, "firmware.bin"));
    });

    it("../escape.txt → PathViolationError (exit root by 1 level)", () => {
      expect(() => guard.resolve("../escape.txt")).toThrow(PathViolationError);
    });

    it("a/b/../../../x.bin → PathViolationError (multiple levels up)", () => {
      expect(() => guard.resolve("a/b/../../../x.bin")).toThrow(PathViolationError);
    });

    it("mixed separators a\\b/../../../x.bin → PathViolationError (Windows+unix, 3 ups)", () => {
      expect(() => guard.resolve("a\\b/../../../x.bin")).toThrow(PathViolationError);
    });

    it("exact .. (nothing else) → PathViolationError", () => {
      expect(() => guard.resolve("..")).toThrow(PathViolationError);
    });

    it("absolute path /etc/passwd → PathViolationError (outside root)", () => {
      expect(() => guard.resolve(path.resolve(root, "..", "outside.bin"))).toThrow(PathViolationError);
    });

    it(".. in middle of name (not traversal) ex: my..file.bin → OK", () => {
      const p = guard.resolve("my..file.bin");
      expect(p).toBe(path.join(root, "my..file.bin"));
    });
  });

  describe("statFile()", () => {
    it("existing file returns correct {size, absPath} (async)", async () => {
      const p = path.join(root, "x.bin");
      const size = 1234;
      fs.writeFileSync(p, randomPayload(size));
      const res = await guard.statFile("x.bin");
      expect(res.size).toBe(size);
      expect(res.absPath).toBe(p);
    });

    it("statFile async: ENOENT (file does not exist) → throws non-NotAFile error", async () => {
      await expect(guard.statFile("nope.bin")).rejects.toThrow();
    });

    it("statFile async: directory instead of file → NotAFileError", async () => {
      const d = path.join(root, "subdir");
      fs.mkdirSync(d);
      await expect(guard.statFile("subdir")).rejects.toThrow(NotAFileError);
    });

    it("statFile async: size correct", async () => {
      const p = path.join(root, "big.bin");
      const size = 77_777;
      fs.writeFileSync(p, randomPayload(size));
      const res = await guard.statFile("big.bin");
      expect(res.size).toBe(size);
      expect(res.absPath).toBe(p);
    });

    it.skipIf(process.platform === "win32")(
      "SECURITY: a symlink inside root pointing OUTSIDE it → PathViolationError, not a followed read",
      async () => {
        // ⊘ lexical containment only (path.relative(root, abs) on the link's
        // own path, never on where it resolves): `abs` for "leak" sits
        // squarely inside root, so a guard that stops at resolve() sees
        // nothing wrong and hands the caller a size/path pair for a file
        // that physically lives outside the sandbox.
        const outsideDir = fs.mkdtempSync(path.join(path.dirname(root), "nexus-pg-outside-"));
        try {
          const secret = path.join(outsideDir, "secret.txt");
          fs.writeFileSync(secret, "outside the sandbox");
          fs.symlinkSync(secret, path.join(root, "leak"));
          await expect(guard.statFile("leak")).rejects.toThrow(PathViolationError);
        } finally {
          fs.rmSync(outsideDir, { recursive: true, force: true });
        }
      }
    );
  });

  describe("ensureWritableNew()", () => {
    it("new file in simple root → returns absPath + does not exist yet", async () => {
      const abs = await guard.ensureWritableNew("new.bin");
      expect(abs).toBe(path.join(root, "new.bin"));
      // Does not exist yet, only validated that it does not exist and parent is writable
      expect(fs.existsSync(abs)).toBe(false);
    });

    it("file already exists → FileAlreadyExistsError", async () => {
      const p = path.join(root, "exists.bin");
      fs.writeFileSync(p, "hi");
      await expect(guard.ensureWritableNew("exists.bin")).rejects.toThrow(FileAlreadyExistsError);
    });

    it("path traversal also blocked here: ../outside.bin → PathViolationError", async () => {
      await expect(guard.ensureWritableNew("../outside.bin")).rejects.toThrow(PathViolationError);
    });

    it("CRITICAL: non-existing subdirectories → mkdir({recursive:true}) creates automatically", async () => {
      const nested = path.join("a", "deeply", "nested", "folder", "upload.bin");
      const abs = await guard.ensureWritableNew(nested);
      const expectedParent = path.join(root, "a", "deeply", "nested", "folder");
      expect(fs.existsSync(expectedParent), "Parent directories were not created recursively").toBe(true);
      expect(fs.statSync(expectedParent).isDirectory()).toBe(true);
      expect(abs).toBe(path.join(root, nested));
    });

    it("several levels + FileAlreadyExists still works after dirs created", async () => {
      const nested = "a/b/c/d/exists.bin";
      const absPath = path.join(root, nested);
      await guard.ensureWritableNew(nested); // creates a/b/c/d
      // Now create the file
      fs.writeFileSync(absPath, "x");
      // Second call must block
      await expect(guard.ensureWritableNew(nested)).rejects.toThrow(FileAlreadyExistsError);
    });

    it.skipIf(process.platform === "win32")(
      "SECURITY: a DANGLING symlink at the destination → FileAlreadyExistsError, not an arbitrary-write primitive",
      async () => {
        // ⊘ access(F_OK)/stat(), which both follow the final symlink: a
        // symlink whose target does not exist yet reports ENOENT there — as
        // if nothing were at that path — so the caller proceeds to
        // `fs.open(abs, 'w')`, which follows the same symlink and creates
        // its target. lstat inspects the directory entry itself, so it
        // reports the symlink regardless of whether its target exists.
        const outsideDir = fs.mkdtempSync(path.join(path.dirname(root), "nexus-pg-outside-"));
        try {
          const target = path.join(outsideDir, "arbitrary.txt");
          fs.symlinkSync(target, path.join(root, "danger")); // target does not exist — dangling
          await expect(guard.ensureWritableNew("danger")).rejects.toThrow(FileAlreadyExistsError);
          expect(fs.existsSync(target)).toBe(false);
        } finally {
          fs.rmSync(outsideDir, { recursive: true, force: true });
        }
      }
    );

    it.skipIf(process.platform === "win32")(
      "SECURITY: an ancestor directory that is a symlink OUTSIDE root → PathViolationError, not a created escape",
      async () => {
        // ⊘ checking only that the LEXICAL parent path.relative(root, parent)
        // stays inside root: "linkedDir" itself resolves fine, so recursive
        // mkdir happily walks through the symlink and the caller ends up
        // holding a path that is lexically "inside root" but physically
        // writes wherever the symlink points.
        const outsideDir = fs.mkdtempSync(path.join(path.dirname(root), "nexus-pg-outside-"));
        try {
          fs.symlinkSync(outsideDir, path.join(root, "linkedDir"), "dir");
          await expect(guard.ensureWritableNew("linkedDir/upload.bin")).rejects.toThrow(PathViolationError);
          expect(fs.existsSync(path.join(outsideDir, "upload.bin"))).toBe(false);
        } finally {
          fs.rmSync(outsideDir, { recursive: true, force: true });
        }
      }
    );
  });
});
