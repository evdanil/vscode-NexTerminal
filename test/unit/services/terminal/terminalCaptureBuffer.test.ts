import { beforeEach, describe, expect, it, vi } from "vitest";

type ConfigChangeListener = (e: { affectsConfiguration: (k: string) => boolean }) => void;

const state = {
  scrollbackValue: 1000,
  configListeners: new Set<ConfigChangeListener>(),
  disposeDisposables: [] as Array<() => void>
};

vi.mock("vscode", () => ({
  workspace: {
    getConfiguration: (section?: string) => ({
      get: (key: string, def?: unknown) => {
        if (section === "terminal.integrated" && key === "scrollback") return state.scrollbackValue;
        if (key === "terminal.integrated.scrollback") return state.scrollbackValue;
        return def;
      }
    }),
    onDidChangeConfiguration: (listener: ConfigChangeListener) => {
      state.configListeners.add(listener);
      return {
        dispose: () => {
          state.configListeners.delete(listener);
        }
      };
    }
  }
}));

import { TerminalCaptureBuffer } from "../../../../src/services/terminal/terminalCaptureBuffer";

function fireConfigChange(affected: string[]): void {
  const evt = { affectsConfiguration: (k: string) => affected.includes(k) };
  state.configListeners.forEach((l) => l(evt));
}

describe("TerminalCaptureBuffer", () => {
  beforeEach(() => {
    state.scrollbackValue = 1000;
    state.configListeners.clear();
  });

  describe("ingest-time stripping", () => {
    it("removes ANSI color sequences", () => {
      const buf = new TerminalCaptureBuffer();
      buf.append("\x1b[31mred\x1b[0m\n");
      expect(buf.getText()).toBe("red");
    });

    it("removes C0 control characters except newline, carriage-return, and tab", () => {
      const buf = new TerminalCaptureBuffer();
      buf.append("bell\x07here\n");
      buf.append("formfeed\x0cthere\n");
      buf.append("tabs\there\n");
      const text = buf.getText();
      expect(text).toContain("bellhere");
      expect(text).not.toContain("\x07");
      expect(text).toContain("formfeedthere");
      expect(text).not.toContain("\x0c");
      expect(text).toContain("tabs\there");
    });

    it("preserves carriage-return characters (terminal lines often end with CRLF)", () => {
      const buf = new TerminalCaptureBuffer();
      buf.append("line1\r\nline2\r\n");
      expect(buf.getText()).toBe("line1\r\nline2\r");
      // Note: final \r is retained; the \n after it closes the line.
    });

    it("appends multi-chunk data correctly", () => {
      const buf = new TerminalCaptureBuffer();
      buf.append("hel");
      buf.append("lo\nwor");
      buf.append("ld\n");
      expect(buf.getText()).toBe("hello\nworld");
    });
  });

  describe("partial-line retention", () => {
    it("holds a partial (no-newline) line as pending and includes it in getText", () => {
      const buf = new TerminalCaptureBuffer();
      buf.append("prompt> ");
      expect(buf.getText()).toBe("prompt> ");
      expect(buf.lineCount()).toBe(1);
    });

    it("merges subsequent data into the pending line until a newline arrives", () => {
      const buf = new TerminalCaptureBuffer();
      buf.append("pro");
      buf.append("mpt> ");
      buf.append("echo\n");
      expect(buf.getText()).toBe("prompt> echo");
      expect(buf.lineCount()).toBe(1);
    });

    it("returns empty string on a fresh buffer", () => {
      const buf = new TerminalCaptureBuffer();
      expect(buf.getText()).toBe("");
      expect(buf.lineCount()).toBe(0);
    });
  });

  describe("line cap and oldest-drop", () => {
    it("enforces maxLines by dropping oldest lines", () => {
      const buf = new TerminalCaptureBuffer({ maxLines: 3 });
      buf.append("one\ntwo\nthree\nfour\n");
      expect(buf.getText()).toBe("two\nthree\nfour");
      expect(buf.lineCount()).toBe(3);
    });

    it("honors the default cap from terminal.integrated.scrollback", () => {
      state.scrollbackValue = 2;
      const buf = new TerminalCaptureBuffer();
      buf.append("a\nb\nc\nd\n");
      expect(buf.getText()).toBe("c\nd");
    });
  });

  describe("clear()", () => {
    it("empties both lines and pending", () => {
      const buf = new TerminalCaptureBuffer();
      buf.append("line1\nline2\npartial");
      buf.clear();
      expect(buf.getText()).toBe("");
      expect(buf.lineCount()).toBe(0);
    });
  });

  describe("setMaxLines()", () => {
    it("trims existing lines from the front when the cap is lowered", () => {
      const buf = new TerminalCaptureBuffer({ maxLines: 10 });
      buf.append("a\nb\nc\nd\ne\n");
      buf.setMaxLines(2);
      expect(buf.getText()).toBe("d\ne");
    });

    it("does not backfill when the cap is raised", () => {
      const buf = new TerminalCaptureBuffer({ maxLines: 2 });
      buf.append("a\nb\nc\nd\n");
      buf.setMaxLines(10);
      expect(buf.getText()).toBe("c\nd");
    });
  });

  describe("reacts to terminal.integrated.scrollback config change", () => {
    it("updates its cap when the scrollback setting changes", () => {
      const buf = new TerminalCaptureBuffer();
      buf.append("a\nb\nc\nd\ne\n");
      state.scrollbackValue = 2;
      fireConfigChange(["terminal.integrated.scrollback"]);
      expect(buf.getText()).toBe("d\ne");
    });

    it("ignores unrelated configuration changes", () => {
      const buf = new TerminalCaptureBuffer({ maxLines: 3 });
      buf.append("a\nb\nc\n");
      state.scrollbackValue = 1;
      fireConfigChange(["unrelated.section"]);
      expect(buf.getText()).toBe("a\nb\nc");
    });
  });

  describe("memory bound (SC-005 proxy)", () => {
    it("keeps getText().length below maxLines * 256 bytes after appending 10x capacity", () => {
      const maxLines = 100;
      const buf = new TerminalCaptureBuffer({ maxLines });
      const line = "x".repeat(80);
      for (let i = 0; i < maxLines * 10; i++) {
        buf.append(`${line}\n`);
      }
      const text = buf.getText();
      expect(text.length).toBeLessThan(maxLines * 256);
      expect(buf.lineCount()).toBe(maxLines);
    });
  });

  /**
   * `maxLines` bounds completed lines only. Output that never emits a `\n` —
   * cursor-addressed full-screen programs (htop, watch, vim), `\r`-only
   * progress bars — all accumulates in `pending`, which every append()
   * re-concatenates and re-splits. Unbounded, that is both a leak and a
   * per-chunk cost that grows with the session.
   */
  describe("unterminated-line bound", () => {
    const MAX_PENDING = 65536;

    it("bounds pending at 64 KiB across 1 MB of newline-free output", () => {
      const buf = new TerminalCaptureBuffer({ maxLines: 1000 });
      const chunk = "\r" + "y".repeat(2047); // 2 KiB, no \n anywhere
      for (let i = 0; i < 512; i++) {
        buf.append(chunk);
      }

      // getText() is pending here (no line ever completed), so its length IS
      // the bound. Uncapped this would be ~1 MB.
      expect(buf.getText().length).toBeLessThanOrEqual(MAX_PENDING);
      expect(buf.lineCount()).toBe(1);
    });

    it("keeps the tail — the most recent bytes — when it truncates", () => {
      const buf = new TerminalCaptureBuffer({ maxLines: 1000 });
      buf.append("OLDEST-MARKER" + "z".repeat(MAX_PENDING));
      buf.append("NEWEST-MARKER");

      const text = buf.getText();
      expect(text.length).toBeLessThanOrEqual(MAX_PENDING);
      expect(text.endsWith("NEWEST-MARKER")).toBe(true);
      expect(text).not.toContain("OLDEST-MARKER");
    });

    it("leaves short partial lines completely untouched", () => {
      const buf = new TerminalCaptureBuffer();
      buf.append("prompt> ");
      buf.append("ls -la");
      expect(buf.getText()).toBe("prompt> ls -la");
    });

    it("still closes a capped pending line into the ring buffer when a newline arrives", () => {
      const buf = new TerminalCaptureBuffer({ maxLines: 10 });
      buf.append("q".repeat(MAX_PENDING * 2));
      buf.append("-TAIL\nnext line");

      const lines = buf.getText().split("\n");
      expect(lines).toHaveLength(2);
      // The completed line carries the capped pending tail plus whatever this
      // chunk added — bounded, unlike the 128 KiB it would be uncapped.
      expect(lines[0].length).toBeLessThanOrEqual(MAX_PENDING + 1024);
      expect(lines[0].endsWith("-TAIL")).toBe(true);
      expect(lines[1]).toBe("next line");
      expect(buf.lineCount()).toBe(2);
    });

    it("keeps per-append cost flat once the bound is reached", () => {
      const buf = new TerminalCaptureBuffer({ maxLines: 1000 });
      const chunk = "\r" + "w".repeat(2047);

      // Seed well past the cap. Without the cap this loop alone builds a 4 MB
      // pending string, and each of the 2000 appends below then copies it.
      for (let i = 0; i < 2048; i++) {
        buf.append(chunk);
      }

      const start = performance.now();
      for (let i = 0; i < 2000; i++) {
        buf.append(chunk);
      }
      const elapsed = performance.now() - start;

      // Capped, 2000 appends of 2 KiB onto a 64 KiB buffer measure in the tens
      // of milliseconds. Uncapped, the same 2000 appends copy an average of
      // ~6 MB each and take seconds. The threshold is deliberately loose: it is
      // a guard against the growth curve returning, not a benchmark.
      expect(elapsed).toBeLessThan(1500);
      expect(buf.getText().length).toBeLessThanOrEqual(MAX_PENDING);
    });
  });

  describe("dispose()", () => {
    it("unsubscribes the config listener and empties the buffer", () => {
      const buf = new TerminalCaptureBuffer();
      buf.append("data\n");
      const before = state.configListeners.size;
      buf.dispose();
      expect(state.configListeners.size).toBeLessThan(before);
      expect(buf.getText()).toBe("");
    });
  });
});
