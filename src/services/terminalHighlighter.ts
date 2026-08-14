import * as vscode from "vscode";
import { createAnsiRegex } from "../utils/ansi";
import { validateRegexSafety } from "../utils/regexSafety";
import { validateAndSanitizeHighlightRules, type HighlightRule } from "../utils/highlightRuleValidation";

const MAX_INPUT_LENGTH = 65536;
// Upper bound on how long a fragment with no line boundary may sit in the
// stream before it is rendered. This is the terminal's *typing latency floor*:
// a keystroke echo carries neither \n nor \r, so it always waits out this
// timer. 100 ms was measurable as lag on a LAN; 15 ms is below the threshold
// where a local echo reads as delayed while still coalescing the sub-millisecond
// chunk storms that TCP segmentation produces.
const STREAM_FLUSH_DELAY_MS = 15;
const STREAM_MAX_PENDING_LENGTH = 16384;
// Bytes retained at the tail when the pending buffer hits its hard cap
// (STREAM_MAX_PENDING_LENGTH) mid-burst, so cross-chunk matches (IPs, MACs,
// UUIDs, etc.) still see enough context to identify the full token when the
// continuation arrives. Covers every built-in rule; user patterns whose matches
// can exceed this length may still split at chunk boundaries.
//
// Retention applies on exactly one path: the hard cap below, which fires only
// because 16 KiB arrived faster than a flush period — the continuation really
// is moments away, so holding a tail costs no perceptible latency and saves the
// match. Neither timer retains: both are latency deadlines, and a deadline that
// holds bytes back is not one. See onIdleFlush() and STREAM_MAX_PENDING_PERIODS.
const STREAM_RETAIN_MARGIN = 256;

// Ceiling on how long the oldest pending byte may wait, expressed in flush
// periods, so the relationship holds whatever delay a stream is built with.
//
// The idle timer is restarted by every push (that is what makes it an *idle*
// timer), so a stream whose chunks keep arriving closer together than one flush
// period never reaches it. STREAM_MAX_PENDING_LENGTH bounds that case in bytes,
// but not in time: a sustained trickle — a 9600-baud serial link, an unbroken
// `base64 -w0` line over a slow hop — can hold well under 16 KiB for a long
// while. This bounds it in time as well.
//
// GUARANTEE: no byte waits longer than one ceiling period before it is
// rendered, for any arrival pattern. Two properties carry that, and both are
// load-bearing. (1) The deadline belongs to the oldest byte that is *still
// pending*: the timer is armed when a byte enters an empty buffer, is never
// restarted while the bytes it was armed for are still waiting, and is
// re-anchored when an emit leaves behind only bytes that arrived after it —
// see push() and rearmTimers(). (2) When it fires it emits everything, so that
// byte is actually rendered.
//
// "Oldest byte that is still pending" is the whole of (1), and "oldest byte
// that was once pending" is not a weaker form of it but a different and wrong
// one. A boundary emit renders the bytes the ceiling was armed for and leaves
// a fresh tail behind — which is what *every* chunk of continuous mid-line
// output does — and an anchor that does not move then points at bytes already
// on the screen: it fires early on a tail that has barely arrived, splitting
// whatever token straddles it, and since such a stream never empties `pending`
// it does that once per ceiling period for as long as the output runs. The
// re-anchor is exact rather than merely safe: the tail is a suffix of the
// chunk that has just arrived, so the fresh period really does start at its
// arrival. Where that is not provable — a cut backed off past the start of
// this chunk, leaving carried-over bytes in the tail (see safeCutIndex), or
// the hard cap, whose retained margin may predate this push — the old anchor
// is kept, which can only fire early, never late.
//
// (2) is why it retains nothing, even though it is the one deadline that fires
// while data is still arriving. Retaining STREAM_RETAIN_MARGIN here emitted
// *nothing at all* whenever the buffer held less than the margin, and the
// cleared timer was then re-armed by the next push from a fresh anchor — so a
// trickle of one character every 14 ms stayed invisible until it crossed 256
// characters, about 3.6 s. A latency backstop that can emit nothing is not a
// backstop, and the guarantee its comment claimed was simply false. The cost of
// emitting everything is at most one split token per ceiling period, and only
// during a stream that produces no line boundary for that long — the same trade
// onIdleFlush() already makes, for the same reason: rendering beats matching
// once a deadline is up.
//
// The VALUE is bracketed from both sides, and 6 (90 ms at the shipped 15 ms
// delay) is the only integer inside the bracket:
//
// - Upper bound: under 100 ms. The ceiling is the first paint for boundary-free
//   interactive output — a cursor-addressed redraw over a slow link (BIOS setup
//   over IPMI SOL, a TUI on a congested hop) answers a keypress with bytes that
//   carry no \n or \r, so the ceiling is how long that answer stays invisible.
//   100 ms is both the threshold where feedback stops reading as immediate and
//   the first paint v2.8.180 shipped for this pattern (its 100 ms timer was
//   anchored to the first push); a latency fix must not measure worse than the
//   release it fixes on any pattern, and 8 periods (120 ms) did.
//
// - Lower bound: over ~83 ms. The commonest stream that runs sub-idle with no
//   boundary *yet* is a serial console line still arriving: at 9600 baud — the
//   default console rate on the network gear this extension exists for — a
//   full 80-column line takes ~83 ms, and its \r\n then flushes it whole. A
//   ceiling below that fires mid-line on every ordinary console line, and a
//   fire splits whatever token straddles it (see the trade above) — clipping
//   ERROR / IP / MAC highlights on the flagship serial-log surface to buy
//   first-paint headroom that is already below perception. 2–3 periods
//   (30–45 ms) would do exactly that.
//
// Lines longer than ~86 columns at 9600 baud still split once mid-line — they
// did on v2.8.180 too (at its 100 ms anchor) — and links at 19200 baud or
// faster deliver a full line well inside one period. The ~86 is a per-line
// figure precisely because of the re-anchor above: a line's period starts at
// its own first byte, not at whenever the buffer last happened to empty. Only
// the token actually straddling the fire loses its match; everything on either
// side highlights normally, and the next boundary resets the stream.
const STREAM_MAX_PENDING_PERIODS = 6;

const VALID_FLAGS_RE = /^[gi]*$/;

const COLOR_MAP: Record<string, number> = {
  black: 30, red: 31, green: 32, yellow: 33, blue: 34, magenta: 35, cyan: 36, white: 37,
  brightblack: 90, brightred: 91, brightgreen: 92, brightyellow: 93,
  brightblue: 94, brightmagenta: 95, brightcyan: 96, brightwhite: 97
};

// Foreground-only raw SGR codes allowed from user config
function isForegroundCode(code: number): boolean {
  return (code >= 30 && code <= 37) || (code >= 90 && code <= 97);
}

const enum SgrClass {
  None,
  FgSet,
  FgReset,
  Reset
}

// Zero-allocation SGR classifier — scans the sequence in-place
function classifySgr(seq: string): SgrClass {
  // SGR sequences: \x1b[ <params> m — minimum length 3
  if (seq.length < 3 || seq.charCodeAt(0) !== 0x1b || seq.charCodeAt(1) !== 0x5b
      || seq.charCodeAt(seq.length - 1) !== 0x6d) {
    return SgrClass.None;
  }

  // Parse semicolon-separated numeric params in-place
  let num = 0;
  let hasDigit = false;
  let foundFg = false;
  let foundReset = false;
  let foundFgReset = false;

  for (let i = 2, len = seq.length - 1; i < len; i++) {
    const ch = seq.charCodeAt(i);
    if (ch >= 0x30 && ch <= 0x39) { // digit
      num = num * 10 + (ch - 0x30);
      hasDigit = true;
    } else if (ch === 0x3b) { // semicolon
      if (!hasDigit) { num = 0; }
      if (num === 0) { foundReset = true; }
      else if (num === 39) { foundFgReset = true; }
      else if ((num >= 30 && num <= 37) || (num >= 90 && num <= 97) || num === 38) { foundFg = true; }
      num = 0;
      hasDigit = false;
    }
  }
  // Process final param
  if (!hasDigit) { num = 0; }
  if (num === 0) { foundReset = true; }
  else if (num === 39) { foundFgReset = true; }
  else if ((num >= 30 && num <= 37) || (num >= 90 && num <= 97) || num === 38) { foundFg = true; }

  // Priority: full reset > fg reset > fg set
  if (foundReset) { return SgrClass.Reset; }
  if (foundFgReset) { return SgrClass.FgReset; }
  if (foundFg) { return SgrClass.FgSet; }
  return SgrClass.None;
}

interface CompiledRule {
  regex: RegExp;
  openCode: string;
  closeCode: string;
}

function compileRule(rule: HighlightRule): CompiledRule | undefined {
  try {
    if (!validateRegexSafety(rule.pattern).ok) {
      return undefined;
    }
    const rawFlags = typeof rule.flags === "string" ? rule.flags : "gi";
    const flags = VALID_FLAGS_RE.test(rawFlags) ? rawFlags : "gi";
    const regex = new RegExp(rule.pattern, flags);

    // Reject patterns that match empty strings
    if (regex.test("")) {
      return undefined;
    }

    const sgrParts: number[] = [];
    const resetParts: number[] = [];

    const colorLower = rule.color.toLowerCase();
    if (COLOR_MAP[colorLower] !== undefined) {
      sgrParts.push(COLOR_MAP[colorLower]);
      resetParts.push(39);
    } else {
      const code = Number(rule.color);
      // Only allow foreground-range SGR codes from raw numeric input
      if (Number.isFinite(code) && isForegroundCode(code)) {
        sgrParts.push(code);
        resetParts.push(39);
      }
    }

    if (rule.bold) {
      sgrParts.push(1);
      resetParts.push(22);
    }
    if (rule.underline) {
      sgrParts.push(4);
      resetParts.push(24);
    }

    if (sgrParts.length === 0) {
      return undefined;
    }

    return {
      regex,
      openCode: `\x1b[${sgrParts.join(";")}m`,
      closeCode: `\x1b[${resetParts.join(";")}m`
    };
  } catch {
    return undefined;
  }
}

interface Match {
  start: number;
  end: number;
  ruleIndex: number;
}

function findStableBoundary(text: string): number {
  const lastLf = text.lastIndexOf("\n");
  const lastCr = text.lastIndexOf("\r");
  return Math.max(lastLf, lastCr) + 1;
}

/**
 * Return the largest index <= `desired` that does not fall strictly inside a
 * complete or incomplete escape sequence.
 *
 * - If `desired` lands inside a *complete* escape sequence span [start, end),
 *   back off to `start` so the whole sequence stays in the retained tail.
 * - If there is a *trailing incomplete* escape (an \x1b that is not covered by
 *   any complete span and has no terminator before text.length), back off to
 *   the start of that escape.
 * - If backing off would reach 0 (the escape starts at 0, making forward
 *   progress impossible), fall back to returning `desired` unchanged so the
 *   stream never stalls.
 */
function safeCutIndex(text: string, desired: number): number {
  if (desired <= 0 || desired >= text.length) {
    return desired;
  }

  const ansiRe = createAnsiRegex();
  let lastCompleteEnd = 0;
  let m: RegExpExecArray | null;

  // Walk all complete escape sequences, check if desired falls inside one.
  while ((m = ansiRe.exec(text)) !== null) {
    const start = m.index;
    const end = m.index + m[0].length;

    if (start >= desired) {
      // All remaining sequences start at or after desired — stop scanning
      break;
    }

    if (desired < end) {
      // desired falls strictly inside this complete span — back off to start
      if (start === 0) {
        // Escape sequence starts at 0; can't back off further — keep desired
        return desired;
      }
      return start;
    }

    lastCompleteEnd = end;
  }

  // Check for a trailing incomplete escape: an \x1b in [lastCompleteEnd, desired)
  // that is not covered by any complete sequence.
  const escIdx = text.lastIndexOf("\x1b", desired - 1);
  if (escIdx >= lastCompleteEnd && escIdx < desired) {
    // Verify it's not the start of a complete sequence within text
    // (if it were, the main loop above would have caught it).
    // Re-check with a fresh regex to be safe.
    const checkRe = createAnsiRegex();
    checkRe.lastIndex = escIdx;
    const checkMatch = checkRe.exec(text);
    const isComplete = checkMatch !== null && checkMatch.index === escIdx && checkMatch.index + checkMatch[0].length <= desired;

    if (!isComplete) {
      // Trailing incomplete escape — back off to its start
      if (escIdx === 0) {
        return desired; // can't back off; fallback to avoid stalling
      }
      return escIdx;
    }
  }

  return desired;
}

// Single-pass rule matching: find all matches against original text, resolve overlaps, build result
function applyRulesToPlainText(text: string, rules: CompiledRule[]): string {
  // Collect all matches from all rules against the original text
  const matches: Match[] = [];
  for (let ri = 0; ri < rules.length; ri++) {
    const regex = rules[ri].regex;
    regex.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = regex.exec(text)) !== null) {
      if (m[0].length > 0) {
        matches.push({ start: m.index, end: m.index + m[0].length, ruleIndex: ri });
      }
      // Avoid infinite loop on zero-length matches (should not happen due to compileRule guard)
      if (m[0].length === 0) { regex.lastIndex++; }
      if (!regex.global) break;
    }
  }

  if (matches.length === 0) {
    return text;
  }

  // Sort by start position, then by rule index (earlier rule wins on tie)
  matches.sort((a, b) => a.start - b.start || a.ruleIndex - b.ruleIndex);

  // Discard overlapping matches — first match at each position wins
  const filtered: Match[] = [matches[0]];
  for (let i = 1; i < matches.length; i++) {
    if (matches[i].start >= filtered[filtered.length - 1].end) {
      filtered.push(matches[i]);
    }
  }

  // Build result in one pass
  const parts: string[] = [];
  let pos = 0;
  for (const fm of filtered) {
    if (fm.start > pos) {
      parts.push(text.slice(pos, fm.start));
    }
    const rule = rules[fm.ruleIndex];
    parts.push(rule.openCode, text.slice(fm.start, fm.end), rule.closeCode);
    pos = fm.end;
  }
  if (pos < text.length) {
    parts.push(text.slice(pos));
  }

  return parts.join("");
}

export class TerminalHighlighter {
  private enabled = false;
  private rules: CompiledRule[] = [];

  public constructor() {
    this.reload();
  }

  public reload(): void {
    const config = vscode.workspace.getConfiguration("nexus.terminal.highlighting");
    this.enabled = config.get<boolean>("enabled", true);
    const rawRules = config.get<unknown>("rules", []);
    const rawRulesArray = Array.isArray(rawRules) ? rawRules : [];
    const rules = rawRulesArray.flatMap((rule) => validateAndSanitizeHighlightRules([rule]) ?? []);
    this.rules = [];
    for (const rule of rules) {
      if (!rule.pattern || !rule.color) { continue; }
      // enabled === false means the rule stays in the persisted list but is not
      // applied — absent/true is the enabled default.
      if (rule.enabled === false) { continue; }
      const compiled = compileRule(rule);
      if (compiled) {
        this.rules.push(compiled);
      }
    }
  }

  /**
   * True when `apply()` can actually change its input — the setting is on AND
   * at least one *enabled* rule compiled (`reload()` drops `enabled: false`
   * rules before compiling, so a config with only disabled rules leaves
   * `this.rules` empty and this returns false with no special-casing here).
   * Callers use this to decide whether output needs to go through the
   * buffering `TerminalHighlighterStream` at all: when it is false the stream
   * would spend a full flush period holding text it is going to hand back
   * unmodified, which is pure added latency (see `PtyObserverHub.notifyOutput`).
   * Re-read after every `reload()` — the setting is live and this must never
   * be cached across a config change.
   */
  public isEnabled(): boolean {
    return this.enabled && this.rules.length > 0;
  }

  public apply(text: string): string {
    if (!this.enabled || this.rules.length === 0) {
      return text;
    }

    // Input length guard — protect against hostile large payloads
    if (text.length > MAX_INPUT_LENGTH) {
      return text;
    }

    // Fast-path for ANSI-free text (common in serial terminals / simple output)
    if (text.indexOf("\x1b") === -1) {
      return applyRulesToPlainText(text, this.rules);
    }

    // Inline ANSI segmentation — process segments as index ranges, no object allocation
    const ansiRe = createAnsiRegex();
    const parts: string[] = [];
    let colorActive = false;
    let lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = ansiRe.exec(text)) !== null) {
      // Plain text segment before this ANSI sequence
      if (match.index > lastIndex) {
        const plain = text.slice(lastIndex, match.index);
        parts.push(colorActive ? plain : applyRulesToPlainText(plain, this.rules));
      }

      // ANSI sequence — classify for color tracking
      const seq = match[0];
      const cls = classifySgr(seq);
      if (cls === SgrClass.Reset || cls === SgrClass.FgReset) {
        colorActive = false;
      } else if (cls === SgrClass.FgSet) {
        colorActive = true;
      }
      parts.push(seq);
      lastIndex = ansiRe.lastIndex;
    }

    // Trailing plain text
    if (lastIndex < text.length) {
      const plain = text.slice(lastIndex);
      parts.push(colorActive ? plain : applyRulesToPlainText(plain, this.rules));
    }

    return parts.join("");
  }

  public createStream(emit: (text: string) => void, flushDelayMs = STREAM_FLUSH_DELAY_MS): TerminalHighlighterStream {
    return new TerminalHighlighterStream(this, emit, flushDelayMs);
  }
}

export class TerminalHighlighterStream implements vscode.Disposable {
  private pending = "";
  /** Restarted by every push — fires only after the stream has gone quiet. */
  private flushTimer?: ReturnType<typeof setTimeout>;
  /**
   * Anchored to the oldest byte that is still pending. A push never restarts
   * it while the bytes it was armed for are still waiting; a push that renders
   * all of them and leaves a tail of its own re-anchors it. See
   * STREAM_MAX_PENDING_PERIODS.
   */
  private ceilingTimer?: ReturnType<typeof setTimeout>;

  public constructor(
    private readonly highlighter: TerminalHighlighter,
    private readonly emit: (text: string) => void,
    private readonly flushDelayMs: number
  ) {}

  public push(text: string): void {
    const carried = this.pending.length;
    this.pending += text;
    const rawBoundary = findStableBoundary(this.pending);
    if (rawBoundary > 0) {
      const boundary = safeCutIndex(this.pending, rawBoundary);
      if (boundary > 0) {
        this.emit(this.highlighter.apply(this.pending.slice(0, boundary)));
        this.pending = this.pending.slice(boundary);
        if (boundary >= carried) {
          // The emit consumed everything that was pending before this push, so
          // every byte still here arrived in it — and a ceiling left running
          // would be anchored to bytes that are now on the screen. Drop it;
          // rearmTimers() below anchors a fresh period to this tail, which is
          // both the oldest pending byte and one that arrived just now, so the
          // new deadline is exact. Without this, a stream that ends every
          // chunk mid-line (USB-batched serial at 19200 baud and up, `tail -f`
          // over a congested hop) never empties `pending`, the anchor never
          // moves, and the ceiling fires once per period however many line
          // boundaries flow through it — one needless mid-line split per
          // 90 ms of continuous scroll.
          //
          // `boundary >= carried` is the proof, not a heuristic: the cut fell
          // at or after the end of what was carried in, so the tail is a
          // suffix of `text`. When safeCutIndex backs off further than that
          // (an escape sequence spanning the chunk boundary), older bytes
          // survive in the tail and their anchor is left alone.
          this.clearCeilingTimer();
        }
      }
    }
    if (this.pending.length >= STREAM_MAX_PENDING_LENGTH) {
      this.emitWithRetention();
    }
    this.rearmTimers();
  }

  public flush(): void {
    this.clearTimers();
    this.emitAllPending();
  }

  public dispose(): void {
    this.flush();
  }

  /**
   * Render everything pending, in ONE tick, retaining nothing.
   *
   * Both deadlines end here. Neither may retain a margin: a deadline exists to
   * bound how long a byte can stay invisible, and a path that can emit nothing
   * — which is exactly what emitWithRetention() does when the buffer is
   * smaller than the margin — bounds nothing at all.
   */
  private emitAllPending(): void {
    if (!this.pending) {
      return;
    }
    this.emit(this.highlighter.apply(this.pending));
    this.pending = "";
  }

  /**
   * Emit all but the trailing margin, so a token that is still arriving keeps
   * enough context to match when its continuation lands. Only the hard cap
   * calls this: it fires because bytes are arriving faster than a flush period,
   * never because time ran out, so holding a tail back costs nothing in
   * latency. Emits nothing when the buffer is at or under the margin — which is
   * why no deadline may route through here.
   */
  private emitWithRetention(): void {
    if (this.pending.length <= STREAM_RETAIN_MARGIN) {
      return;
    }
    const rawCut = this.pending.length - STREAM_RETAIN_MARGIN;
    // Back off from the cut if it would split an escape sequence.
    // safeCutIndex falls back to rawCut when backing off would reach 0.
    const emitUpTo = safeCutIndex(this.pending, rawCut);
    this.emit(this.highlighter.apply(this.pending.slice(0, emitUpTo)));
    this.pending = this.pending.slice(emitUpTo);
  }

  /**
   * Restart the idle deadline, and start the ceiling if nothing is running one.
   *
   * The idle timer is restarted — not left running — on every push. Anchoring
   * it to the first push after the buffer was last emptied made it fire *while*
   * data was still arriving, and since `onIdleFlush()` retains nothing, a token
   * straddling that moment was emitted in halves: `ERRO` rendered, `R` arriving
   * a millisecond later, and neither fragment matching an `ERROR` rule.
   *
   * The ceiling timer is the opposite: it must not be restarted, or a stream
   * that never goes quiet would never reach it either.
   *
   * That asymmetry is what makes the ceiling's deadline belong to the oldest
   * byte that is *still pending*. It is armed here only while none is running,
   * and every path that leaves it un-armed has first either emptied the buffer
   * (this method when the buffer is empty, both flush paths, and the ceiling
   * firing) or established that everything left in the buffer arrived in the
   * push that is running now — see the boundary emit in push(). So an arm
   * always follows the arrival of what is then the oldest pending byte, and
   * that byte's deadline is the one the timer carries until it fires.
   */
  private rearmTimers(): void {
    this.clearFlushTimer();
    if (!this.pending) {
      this.clearCeilingTimer();
      return;
    }
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined;
      this.onIdleFlush();
    }, this.flushDelayMs);
    if (this.ceilingTimer === undefined) {
      this.ceilingTimer = setTimeout(() => {
        this.ceilingTimer = undefined;
        // Everything, not emitWithRetention(): see STREAM_MAX_PENDING_PERIODS.
        // Emptying the buffer is also what keeps the next arm honest — the next
        // push anchors a fresh period to its own byte.
        this.emitAllPending();
      }, this.flushDelayMs * STREAM_MAX_PENDING_PERIODS);
    }
  }

  /**
   * The stream has been quiet for a full flush period: render everything that
   * is pending, in ONE tick.
   *
   * This deliberately does NOT retain a trailing margin. Retention exists to
   * keep a token that is mid-arrival intact (see STREAM_RETAIN_MARGIN), and by
   * definition nothing is mid-arrival here — the deadline expired with no new
   * data. Retaining anyway meant the tail of every quiet-ending burst (the
   * shell prompt the user is waiting to type at, most of all) emitted a whole
   * flush period late, in two stages instead of one.
   */
  private onIdleFlush(): void {
    this.emitAllPending();
    this.clearCeilingTimer();
  }

  private clearTimers(): void {
    this.clearFlushTimer();
    this.clearCeilingTimer();
  }

  private clearFlushTimer(): void {
    if (this.flushTimer !== undefined) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
  }

  private clearCeilingTimer(): void {
    if (this.ceilingTimer !== undefined) {
      clearTimeout(this.ceilingTimer);
      this.ceilingTimer = undefined;
    }
  }
}
