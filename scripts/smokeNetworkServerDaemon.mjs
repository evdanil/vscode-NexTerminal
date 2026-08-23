// Proves a freshly built network-server daemon binary actually starts.
//
// A cross-built binary can link, upload and ship while being unable to run on
// the platform it was built for — the failure then surfaces as "the services
// never start" in somebody's lab. This runs the real binary the release is about
// to package: it must announce `ready` on stdout, and it must exit cleanly when
// stdin closes, which is the shutdown path the extension host relies on.
import { spawn } from "node:child_process";

const TIMEOUT_MS = 10_000;

function run(binaryPath) {
  return new Promise((resolve, reject) => {
    const child = spawn(binaryPath, [], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(new Error(`daemon did not become ready within ${TIMEOUT_MS}ms; stdout: ${stdout}`));
    }, TIMEOUT_MS);

    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`failed to spawn ${binaryPath}: ${error.message}`));
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
      if (!stdout.includes("\n")) return;
      const [first] = stdout.split("\n");
      let parsed;
      try {
        parsed = JSON.parse(first);
      } catch {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.kill("SIGKILL");
        reject(new Error(`first line was not JSON: ${first}`));
        return;
      }
      if (parsed.event !== "ready") {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.kill("SIGKILL");
        reject(new Error(`expected a ready event, got: ${first}`));
        return;
      }
      // Ready. Closing stdin is how the host asks it to stop.
      child.stdin.end();
    });

    child.on("exit", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          `daemon exited with code=${code} signal=${signal}; stdout: ${stdout}; stderr: ${stderr}`
        )
      );
    });
  });
}

const binaryPath = process.argv[2];
if (!binaryPath) {
  console.error("Usage: node scripts/smokeNetworkServerDaemon.mjs <path-to-daemon>");
  process.exit(1);
}

run(binaryPath)
  .then(() => {
    console.log(`Network server daemon smoke test passed: ${binaryPath}`);
  })
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
