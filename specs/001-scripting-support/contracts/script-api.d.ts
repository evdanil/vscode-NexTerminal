// Nexus Scripts API types — v6
/**
 * Nexus Terminal — Scripts API
 *
 * Authoritative TypeScript declarations for the Nexus script runtime API.
 *
 * This file is the single source of truth. At build time it is copied to
 *   src/services/scripts/assets/nexus-scripts.d.ts
 * and at first script-command invocation in a workspace it is written to
 *   <workspaceRoot>/<nexus.scripts.path>/types/nexus-scripts.d.ts
 * alongside a generated jsconfig.json so VS Code provides IntelliSense, JSDoc
 * hovers, and inline checking on every script file.
 *
 * Every API call below is async and only resolves after the runtime has
 * acknowledged the operation against the bound session (or rejected it on
 * timeout / disconnection / cancellation).
 */

export {};

declare global {
  // ---------------------------------------------------------------------------
  // Core types
  // ---------------------------------------------------------------------------

  /**
   * Result of a successful pattern match.
   */
  interface Match {
    /** Full matched text. */
    text: string;
    /** Regex capture groups (empty array for string patterns). */
    groups: string[];
    /** Bytes between the previous cursor position and the match. */
    before: string;
  }

  /**
   * Wait options accepted by `waitFor`, `expect`, and `waitAny`.
   */
  interface WaitOptions {
    /**
     * Maximum wait duration in milliseconds. Defaults to the script header's
     * `@default-timeout` or the `nexus.scripts.defaultTimeoutSeconds` setting.
     */
    timeout?: number;
    /**
     * Number of bytes of recent output to scan on the first attempt.
     * Defaults to 1024 on the very first wait of the run, 0 thereafter.
     */
    lookback?: number;
  }

  /**
   * Result of a `waitAny` call.
   */
  interface WaitAnyMatch {
    /** Index into the input `patterns` array of the pattern that matched. */
    index: number;
    /** Match details. */
    match: Match;
  }

  /**
   * Recognized control keys for `sendKey`.
   */
  type ControlKey =
    | "ctrl-a" | "ctrl-b" | "ctrl-c" | "ctrl-d" | "ctrl-e" | "ctrl-k"
    | "ctrl-l" | "ctrl-n" | "ctrl-p" | "ctrl-r" | "ctrl-u" | "ctrl-w"
    | "ctrl-z"
    | "enter" | "esc" | "tab" | "space" | "backspace"
    | "up" | "down" | "left" | "right"
    | "home" | "end" | "page-up" | "page-down"
    | "f1" | "f2" | "f3" | "f4" | "f5" | "f6"
    | "f7" | "f8" | "f9" | "f10" | "f11" | "f12";

  /**
   * Polling specification for `poll`.
   */
  interface PollOptions {
    /** Text to send each tick, or a function invoked each tick. */
    send: string | (() => Promise<void>);
    /** Pattern that ends the poll loop on first match. */
    until: string | RegExp;
    /** Tick interval in milliseconds. */
    every: number;
    /** Total wall-clock budget for the poll, in milliseconds. */
    timeout: number;
  }

  /**
   * Options for `prompt`.
   */
  interface PromptOptions {
    /** Pre-fill the input box with this string. */
    default?: string;
    /** When true, masks input characters and excludes the value from the script log. */
    password?: boolean;
  }

  /**
   * Read-only metadata about the session a script is bound to.
   */
  interface ScriptSession {
    /** Stable session id (matches `ActiveSession.id` in NexusCore). */
    id: string;
    /** Underlying transport. */
    type: "ssh" | "serial" | "local";
    /** User-visible session name (terminal title). */
    name: string;
    /** The id of the source profile (server id for SSH, profile id for serial/local shell). */
    targetId: string;
  }

  /**
   * Macro coordination handles. All operations are scoped to the script's bound session.
   */
  interface MacroControl {
    /** Allow the named macro(s) to fire on this session for the rest of the run. */
    allow(name: string | string[]): void;
    /** Block the named macro(s) from firing on this session for the rest of the run. */
    deny(name: string | string[]): void;
    /** Block all macros on this session (matches the default `suspend-all` policy). */
    disableAll(): void;
    /** Restore the policy that was active when the script started. */
    restore(): void;
  }

  /**
   * Script logger — output is timestamped and written to the "Nexus Scripts" Output Channel.
   * Sensitive data (e.g. password prompt results) is never written here unless the script does so explicitly.
   */
  interface ScriptLogger {
    info(...args: unknown[]): void;
    warn(...args: unknown[]): void;
    error(...args: unknown[]): void;
  }

  // ---------------------------------------------------------------------------
  // Globals available to every Nexus script
  // ---------------------------------------------------------------------------

  /**
   * Wait for the first occurrence of `pattern` in the session output.
   * Returns the match on success, `null` on timeout.
   *
   * @example
   *   const m = await waitFor(/Login: $/, { timeout: 10_000 });
   *   if (!m) { log.warn("no login prompt"); return; }
   */
  function waitFor(pattern: string | RegExp, opts?: WaitOptions): Promise<Match | null>;

  /**
   * Like `waitFor`, but throws a `TimeoutError` instead of returning `null` on timeout.
   * Use this when "the pattern must appear" is part of the script's contract.
   */
  function expect(pattern: string | RegExp, opts?: WaitOptions): Promise<Match>;

  /**
   * Wait for the first of several patterns to match. Resolves with the index of the matching pattern and the match details.
   */
  function waitAny(patterns: Array<string | RegExp>, opts?: WaitOptions): Promise<WaitAnyMatch>;

  /**
   * Send raw text to the bound session. No line terminator added.
   */
  function send(text: string): Promise<void>;

  /**
   * Send `text` followed by a carriage return (`\r`) — appropriate for terminal lines.
   */
  function sendLine(text: string): Promise<void>;

  /**
   * Send a named control key.
   */
  function sendKey(key: ControlKey): Promise<void>;

  /**
   * Send text (or invoke a callback) on a fixed cadence until `until` matches or `timeout` elapses.
   */
  function poll(opts: PollOptions): Promise<Match>;

  /**
   * Show a native VS Code input box. Resolves with the entered value, or empty string if the user cancelled.
   */
  function prompt(message: string, opts?: PromptOptions): Promise<string>;

  /**
   * Show a native VS Code modal confirmation. Resolves true on accept, false on cancel.
   */
  function confirm(message: string): Promise<boolean>;

  /**
   * Show a native VS Code modal information message with a single OK button.
   */
  function alert(message: string): Promise<void>;

  /**
   * Sleep for a fixed duration in milliseconds.
   */
  function sleep(ms: number): Promise<void>;

  /**
   * Return the last `n` characters of the stripped output buffer — useful inside `catch` blocks
   * or after a `waitFor` returns `null`, where you need to inspect what the session has emitted
   * without waiting for another match.
   *
   * The buffer is ANSI-stripped and capped at 64 KiB; values of `n` larger than that are clamped.
   * Default `n` is 512. Returns an empty string if nothing has been received yet.
   *
   * @example
   *   const m = await waitFor(/OK/, { timeout: 1000 });
   *   if (!m) log.warn("no OK — recent output:", await tail());
   */
  function tail(n?: number): Promise<string>;

  /**
   * Logger writing to the "Nexus Scripts" Output Channel.
   */
  const log: ScriptLogger;

  /**
   * Macro coordination on the bound session. Whatever you change here is automatically restored when the script ends.
   */
  const macros: MacroControl;

  /**
   * Read-only metadata about the bound session.
   */
  const session: ScriptSession;

  // ---------------------------------------------------------------------------
  // Errors
  // ---------------------------------------------------------------------------

  /**
   * Thrown by `expect` when the pattern does not appear within the timeout.
   * Catch with `catch (e) { if (e.code === "Timeout") ... }`.
   */
  interface TimeoutError extends Error {
    code: "Timeout";
    pattern: string;
    timeoutMs: number;
    elapsedMs: number;
  }

  /**
   * Thrown by any pending wait/send/poll when the bound session disconnects.
   */
  interface ConnectionLostError extends Error {
    code: "ConnectionLost";
    sessionId: string;
  }

  /**
   * Thrown when the user dismissed an alert/confirm/prompt that was modal-required.
   * Cancellation of `confirm` resolves to `false`; cancellation of `prompt` resolves to `""`;
   * `alert` cannot be cancelled. This error type is reserved for future expansion.
   */
  interface CancelledError extends Error {
    code: "Cancelled";
  }

  /**
   * Thrown by `nexus.fs` calls. Catch with `if (e.code === "FileNotFound") ...`.
   *
   * `ReadFailed` covers both "the path resolved but the read/probe itself
   * failed" (permissions, a misbehaving filesystem provider) and "the call hit
   * the fixed 30-second deadline every `nexus.fs` call is bounded by" — the
   * latter's message ends in `timed out after 30s`. Neither a timeout nor a
   * failed probe is ever reported as a missing file, an empty read, or (for
   * `exists`) a `false`.
   *
   * `FileTooLarge` additionally carries `sizeBytes` / `maxBytes` (see
   * `ScriptFsFileTooLargeError` below) — declared here too, optionally, so
   * `e.sizeBytes` type-checks straight off a plain `ScriptFsError`-typed
   * catch without narrowing to the subtype first.
   */
  interface ScriptFsError extends Error {
    code: "FileNotFound" | "PathOutsideScope" | "FileTooLarge" | "NotUtf8"
        | "NoScriptDir" | "InvalidPath" | "ReadFailed" | "InvalidJson";
    /**
     * Present when `code === "FileTooLarge"`. The file's size in bytes as
     * observed at read time — a LOWER BOUND when the true size could not be
     * determined (a file that grew past the cap mid-read, or a provider that
     * under-reported its size, reports the cap + 1).
     */
    sizeBytes?: number;
    /**
     * Present when `code === "FileTooLarge"`. The effective cap for this run —
     * `nexus.scripts.maxReadSizeMb` (default 4 MiB, range 1–16 MiB),
     * snapshotted when the script started.
     */
    maxBytes?: number;
  }

  /**
   * `ScriptFsError` narrowed to the `"FileTooLarge"` case, with `sizeBytes` /
   * `maxBytes` required instead of optional. Narrow a `ScriptFsError` (or
   * `ScriptFsError | ScriptFsFileTooLargeError`) down to this shape the usual
   * discriminated-union way:
   * ```js
   * try {
   *   await nexus.fs.readText(path);
   * } catch (e) {
   *   if (e.code === "FileTooLarge") {
   *     log.warn(`${path}: ${e.sizeBytes} bytes exceeds the ${e.maxBytes}-byte limit`);
   *   }
   * }
   * ```
   */
  interface ScriptFsFileTooLargeError extends ScriptFsError {
    code: "FileTooLarge";
    sizeBytes: number;
    maxBytes: number;
  }

  // ---------------------------------------------------------------------------
  // nexus.fs — read-only, scoped, logged file access
  // ---------------------------------------------------------------------------

  interface NexusFileSystem {
    /**
     * Read a UTF-8 text file. Relative paths resolve against THIS SCRIPT'S own
     * directory; the target must stay inside the Nexus scripts folder or the
     * script's own folder subtree. Max `nexus.scripts.maxReadSizeMb` (default
     * 4 MiB). Every read is logged to the "Nexus Scripts" Output Channel.
     *
     * Never blocks longer than 30 seconds, measured over the WHOLE call —
     * including any wait for a read slot when several reads are in flight at
     * once. A filesystem that hasn't answered by then (or a slot that never
     * came free) throws `ReadFailed` ("timed out after 30s") instead of
     * hanging the run.
     */
    readText(path: string): Promise<string>;
    /**
     * readText + JSON.parse. Parse failures throw SyntaxError with code
     * "InvalidJson". Defaults to `Promise<any>` so `.property` access on the
     * result type-checks without a cast; pass `T` for a typed result, e.g.
     * `await nexus.fs.readJson<{ devices: string[] }>("./config.json")`.
     */
    readJson<T = any>(path: string): Promise<T>;
    /**
     * True if an entry (file or directory) exists at the scoped path.
     * Out-of-scope paths throw rather than answering `false`.
     *
     * Bounded by the same 30-second deadline as `readText`, whole call
     * included: probes are throttled on their own pool — separate from
     * `readText`'s, so a slow read never delays a probe or vice versa — and a
     * wait for a probe slot counts against the deadline exactly like a wait
     * for the filesystem. A probe the filesystem hasn't answered by then
     * throws `ReadFailed` ("timed out after 30s"). A probe that FAILED — no
     * permission to look, an erroring or unavailable filesystem provider —
     * throws `ReadFailed` too; only a genuine "nothing is there" answers
     * `false`. "I couldn't tell" is deliberately never collapsed into
     * `false`.
     */
    exists(path: string): Promise<boolean>;
  }

  interface NexusApi {
    /** Read-only, scoped, logged file access. */
    fs: NexusFileSystem;
  }

  /** Nexus host API namespace. */
  const nexus: NexusApi;
}
