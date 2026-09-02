import { readFileSync } from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { configMutationLock } from "../../src/services/configMutationLock";

/**
 * DRAG-DROP GROUP CHANGES MUST SERIALIZE — ALL FOUR BRANCHES, NOT JUST `server`.
 *
 * `extension.ts`'s `onItemGroupChanged` is the single handler behind dropping a
 * row into a Command Center folder. The #84 serialization audit wrapped its
 * `server` branch in `configMutationLock` and re-read the live record inside
 * the lock; the `serial`, `localShell` and `localServer` branches sitting right
 * next to it were missed and committed a FULL captured snapshot lock-free —
 * which is exactly the kind of divergence between siblings that is invisible on
 * review.
 *
 * The concrete loss: "Remove folder (cascade)" captures its collection
 * snapshots synchronously and then awaits a multi-collection write. A drop
 * landing while that await is in flight settles first, the cascade's pre-drop
 * snapshot settles last, and the move is silently reverted — in-memory and
 * persisted state then disagree until reload. Folder rename and replace-mode
 * import have the same shape.
 *
 * WHY THE HANDLER IS EXTRACTED FROM SOURCE AND EXECUTED. It is an inline
 * property of the callbacks object `activate()` hands to `NexusTreeProvider`,
 * and `activate()` cannot be loaded without mocking the whole extension host —
 * so `test/unit/focusSessionTerminalWiring.test.ts` asserts that wiring from
 * source text. String matching is not enough here: the property under test is
 * an ORDERING one, and "the source mentions configMutationLock" would stay
 * green against a wrapper that captured the record before acquiring. So the
 * real handler source is compiled and run against the REAL shared mutex, the
 * same reason `macroVariables.test.ts` executes the generated scanner rather
 * than only diffing its regex sources.
 *
 * The handler's parameters are contextually typed, so its text is already
 * valid JavaScript; brace matching is safe because nothing in the body puts a
 * brace inside a string or a comment.
 */

const extensionPath = path.resolve(__dirname, "..", "..", "src", "extension.ts");

const MARKER = "async onItemGroupChanged(itemType, itemId, newGroup) {";

type ItemType = "server" | "serial" | "localShell" | "localServer";

interface Lock {
  runExclusive<T>(fn: () => Promise<T>): Promise<T>;
}

type Handler = (itemType: ItemType, itemId: string, newGroup: string | undefined) => Promise<void>;

function extensionSource(): string {
  return readFileSync(extensionPath, "utf8");
}

/** The handler's own text, from `async onItemGroupChanged(` to its closing brace. */
function handlerSource(source: string): string {
  const start = source.indexOf(MARKER);
  expect(start, "onItemGroupChanged not found in extension.ts").toBeGreaterThan(-1);
  let depth = 0;
  for (let index = source.indexOf("{", start); index < source.length; index++) {
    if (source[index] === "{") {
      depth++;
    } else if (source[index] === "}") {
      depth--;
      if (depth === 0) {
        return source.slice(start, index + 1);
      }
    }
  }
  throw new Error("onItemGroupChanged's closing brace was never reached");
}

function compileHandler(core: unknown, lock: Lock): Handler {
  const factory = new Function(
    "core",
    "configMutationLock",
    `return { ${handlerSource(extensionSource())} };`
  ) as (core: unknown, lock: Lock) => { onItemGroupChanged: Handler };
  return factory(core, lock).onItemGroupChanged;
}

interface Record {
  id: string;
  name: string;
  group?: string;
}

const BRANCHES: ReadonlyArray<{ itemType: ItemType; read: string; write: string }> = [
  // `server` is already serialized; it rides along so a regression in either
  // direction — the fixed branch losing its lock, or the new ones losing theirs
  // — shows up here.
  { itemType: "server", read: "getServer", write: "addOrUpdateServer" },
  { itemType: "serial", read: "getSerialProfile", write: "addOrUpdateSerialProfile" },
  { itemType: "localShell", read: "getLocalShellProfile", write: "addOrUpdateLocalShellProfile" },
  { itemType: "localServer", read: "getLocalServer", write: "addOrUpdateLocalServerConfig" }
];

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("extension.ts onItemGroupChanged — every branch serializes the group write (#108/#84 follow-up)", () => {
  it("takes its mutex from the shared configMutationLock module, so the lock the branches acquire is the one every other writer takes", () => {
    expect(extensionSource()).toMatch(
      /import \{ configMutationLock \} from "\.\/services\/configMutationLock"/
    );
  });

  for (const branch of BRANCHES) {
    it(`waits for an in-flight folder cascade before writing a ${branch.itemType} row's new group, and re-reads the record it landed on`, async () => {
      const events: string[] = [];
      const records = new Map<string, Record>([
        ["row-1", { id: "row-1", name: "Bench", group: "Lab/Old" }]
      ]);
      const core = {
        [branch.read]: (id: string) => records.get(id),
        [branch.write]: async (record: Record) => {
          events.push("drop:write");
          records.set(record.id, record);
        }
      };
      const lock: Lock = {
        runExclusive: (fn) =>
          configMutationLock.runExclusive(async () => {
            events.push("drop:start");
            try {
              return await fn();
            } finally {
              events.push("drop:end");
            }
          })
      };

      // Stand-in for "Remove folder (cascade)": it captures the record
      // SYNCHRONOUSLY, awaits its multi-collection write, and only then
      // persists — writing a whole record derived from that pre-drop capture,
      // with one field of its own changed.
      let releaseGate!: () => void;
      const gate = new Promise<void>((resolve) => {
        releaseGate = resolve;
      });
      events.push("cascade:start");
      const cascade = configMutationLock.runExclusive(async () => {
        const captured = records.get("row-1")!;
        await gate;
        records.set("row-1", { ...captured, name: "Bench (renamed)" });
        events.push("cascade:persisted");
      });

      await delay(10);
      expect(events).toEqual(["cascade:start"]);

      const dropPromise = compileHandler(core, lock)(branch.itemType, "row-1", "Lab/New");

      // Long enough for the handler's body to reach its acquisition. Unlocked,
      // the write has already landed by now.
      await delay(10);
      expect(events).toEqual(["cascade:start"]);

      releaseGate();
      await cascade;
      await dropPromise;

      expect(events).toEqual([
        "cascade:start",
        "cascade:persisted",
        "drop:start",
        "drop:write",
        "drop:end"
      ]);
      // `group` is the only field this gesture owns, and it wins — a drop is an
      // explicit newest-wins move. Everything else must come from the record as
      // the cascade left it: an implementation that acquired the lock but wrote
      // its pre-drop capture would put `name` back to "Bench" here, and one
      // that never acquired at all would have `group` back at "Lab/Old",
      // reverted by the cascade's own snapshot.
      expect(records.get("row-1")).toEqual({ id: "row-1", name: "Bench (renamed)", group: "Lab/New" });
    });
  }
});
