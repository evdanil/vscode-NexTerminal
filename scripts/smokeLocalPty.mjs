import { spawn } from "node:child_process";
import path from "node:path";

const MARKER = "NEXUS_SMOKE_OK";
const TIMEOUT_MS = 10000;
const CURSOR_POSITION_QUERY = "\x1b[6n";
const CURSOR_POSITION_RESPONSE = "\x1b[1;1R";

function parseArgs(argv) {
  const binaryPath = argv[2];
  if (!binaryPath) {
    throw new Error("Usage: node scripts/smokeLocalPty.mjs <path-to-sidecar>");
  }
  return { binaryPath };
}

function launchOptions() {
  if (process.platform === "win32") {
    return {
      shellPath: "cmd.exe",
      shellArgs: ["/d", "/c", `echo ${MARKER}`]
    };
  }
  return {
    shellPath: "/bin/sh",
    shellArgs: ["-lc", `echo ${MARKER}`]
  };
}

function decodeBase64(data) {
  return Buffer.from(data ?? "", "base64").toString("utf8");
}

function encodeInput(text) {
  return `${JSON.stringify({ type: "input", data: Buffer.from(text, "utf8").toString("base64") })}\n`;
}

async function smoke(binaryPath) {
  const resolvedBinary = path.resolve(binaryPath);
  const child = spawn(resolvedBinary, [], {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true
  });
  const stdoutLines = [];
  const stderrChunks = [];
  let stdoutBuffer = "";
  let sawReady = false;
  let sawMarker = false;
  let exitCode;
  let exitSignal;

  const timeout = setTimeout(() => {
    child.kill();
  }, TIMEOUT_MS);

  const done = new Promise((resolve) => {
    child.on("exit", (code, signal) => {
      exitCode = code;
      exitSignal = signal;
      resolve();
    });
    child.on("error", (error) => {
      stderrChunks.push(error.message);
      resolve();
    });
  });

  child.stdout.on("data", (chunk) => {
    stdoutBuffer += chunk.toString("utf8");
    let newline = stdoutBuffer.indexOf("\n");
    while (newline >= 0) {
      const line = stdoutBuffer.slice(0, newline).trim();
      stdoutBuffer = stdoutBuffer.slice(newline + 1);
      if (line) {
        stdoutLines.push(line);
        try {
          const frame = JSON.parse(line);
          if (frame.type === "ready") {
            sawReady = true;
          } else if (frame.type === "data") {
            const text = decodeBase64(frame.data);
            if (text.includes(CURSOR_POSITION_QUERY)) {
              child.stdin.write(encodeInput(CURSOR_POSITION_RESPONSE));
            }
            if (text.includes(MARKER)) {
              sawMarker = true;
              child.stdin.write(`${JSON.stringify({ type: "kill" })}\n`);
            }
          }
        } catch {
          stderrChunks.push(`Malformed sidecar output: ${line}`);
        }
      }
      newline = stdoutBuffer.indexOf("\n");
    }
  });
  child.stderr.on("data", (chunk) => {
    stderrChunks.push(chunk.toString("utf8"));
  });

  const options = launchOptions();
  child.stdin.write(`${JSON.stringify({
    type: "spawn",
    shellPath: options.shellPath,
    shellArgs: options.shellArgs,
    rows: 24,
    cols: 80
  })}\n`);

  await done;
  clearTimeout(timeout);

  if (!sawReady || !sawMarker) {
    throw new Error([
      `Local PTY smoke test failed for ${resolvedBinary}`,
      `ready=${sawReady}`,
      `marker=${sawMarker}`,
      `exit=${exitCode ?? "null"}`,
      `signal=${exitSignal ?? "null"}`,
      `stdout=${stdoutLines.join("\\n") || "<empty>"}`,
      `stderr=${stderrChunks.join("\\n") || "<empty>"}`
    ].join("\n"));
  }

  console.log(`Local PTY smoke test passed: ${resolvedBinary}`);
}

try {
  const { binaryPath } = parseArgs(process.argv);
  await smoke(binaryPath);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
