import { PassThrough } from "node:stream";
import { createRequire } from "node:module";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { writeHeapSnapshot } from "node:v8";

const require = createRequire(import.meta.url);
const { buildSync } = require("esbuild");
const Module = require("node:module");
const sourcePath = resolve(process.cwd(), "src/services/networkServers/boundedLineReader.ts");
const bundle = buildSync({
  entryPoints: [sourcePath],
  bundle: true,
  format: "cjs",
  platform: "node",
  write: false,
}).outputFiles[0].text;
const sourceModule = new Module(sourcePath);
sourceModule.filename = sourcePath;
sourceModule.paths = Module._nodeModulePaths(process.cwd());
sourceModule._compile(bundle, sourcePath);
const { attachBoundedLineReader } = sourceModule.exports;

const ROLLING_EVENT_COUNT = 5_000;
const PAYLOAD = "x".repeat(1_023);
const MESSAGE = Buffer.from(`${PAYLOAD}\n`);
const originalAllocUnsafeSlow = Buffer.allocUnsafeSlow;
const SNAPSHOT_MARKER = "__bounded_line_reader_rolling_snapshot__";
Buffer.allocUnsafeSlow = (size) => {
  const allocation = originalAllocUnsafeSlow(size);
  if (size === MESSAGE.length) allocation[SNAPSHOT_MARKER] = true;
  return allocation;
};

try {
  const stream = new PassThrough();
  let emitted = 0;
  let liveSnapshots = -1;
  attachBoundedLineReader(stream, {
    maxBytes: MESSAGE.length,
    onLine: (line) => {
      if (line === "start") {
        emitted += 1;
        stream.emit("data", MESSAGE);
        return;
      }
      if (emitted === ROLLING_EVENT_COUNT) {
        global.gc();
        const directory = mkdtempSync(join(tmpdir(), "bounded-line-reader-"));
        const snapshotPath = join(directory, "heap.heapsnapshot");
        try {
          const heap = JSON.parse(readFileSync(writeHeapSnapshot(snapshotPath), "utf8"));
          const nodeFields = heap.snapshot.meta.node_fields;
          const edgeFields = heap.snapshot.meta.edge_fields;
          const edgeCountIndex = nodeFields.indexOf("edge_count");
          const edgeNameIndex = edgeFields.indexOf("name_or_index");
          const edgeFieldCount = edgeFields.length;
          const markerStringIndex = heap.strings.indexOf(SNAPSHOT_MARKER);
          let edgeIndex = 0;
          liveSnapshots = 0;
          for (let nodeIndex = 0; nodeIndex < heap.nodes.length; nodeIndex += nodeFields.length) {
            const edgeCount = heap.nodes[nodeIndex + edgeCountIndex];
            for (let edge = 0; edge < edgeCount; edge += 1) {
              if (heap.edges[edgeIndex + edgeNameIndex] === markerStringIndex) liveSnapshots += 1;
              edgeIndex += edgeFieldCount;
            }
          }
        } finally {
          rmSync(directory, { recursive: true, force: true });
        }
        return;
      }
      emitted += 1;
      stream.emit("data", MESSAGE);
    },
    onError: (error) => {
      throw error;
    },
  });

  stream.write(Buffer.from("start\n"));
  process.stdout.write(JSON.stringify({ liveSnapshots }));
} finally {
  Buffer.allocUnsafeSlow = originalAllocUnsafeSlow;
}
