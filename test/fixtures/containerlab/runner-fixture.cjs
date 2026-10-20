const fs = require("node:fs");
const { spawn } = require("node:child_process");

const values = Object.fromEntries(process.argv.slice(2).map((argument) => {
  const separator = argument.indexOf("=");
  return separator < 0
    ? [argument.replace(/^--/u, ""), "true"]
    : [argument.slice(2, separator), argument.slice(separator + 1)];
}));

function mark(file, value) {
  if (file) fs.writeFileSync(file, value);
}

function writeBytes(stream, count, byte) {
  const chunk = Buffer.alloc(16 * 1024, byte);
  let remaining = count;
  while (remaining > 0) {
    const next = Math.min(remaining, chunk.length);
    stream.write(next === chunk.length ? chunk : chunk.subarray(0, next));
    remaining -= next;
  }
}

let helper;
let exiting = false;
const exitFile = values["exit-file"];
const childExitFile = values["child-exit-file"];
const readyFile = values["ready-file"];
const parentExitedFile = values["parent-exited-file"];
const childExitedFile = values["child-exited-file"];

process.once("exit", () => mark(parentExitedFile, String(process.pid)));

function finishFromSignal(signal) {
  if (exiting) return;
  exiting = true;
  mark(exitFile, `${process.pid}:${signal}`);
  if (!helper) {
    process.exit(0);
    return;
  }
  helper.kill(signal);
  helper.once("exit", () => process.exit(0));
}

process.on("SIGTERM", () => finishFromSignal("SIGTERM"));
process.on("SIGINT", () => finishFromSignal("SIGINT"));

if (values.mode === "child") {
  const source = [
    "const fs = require('node:fs');",
    "process.on('SIGTERM', () => {",
    `  fs.writeFileSync(${JSON.stringify(childExitFile)}, String(process.pid));`,
    "  process.exit(0);",
    "});",
    "if (process.send) process.send('ready');",
    "setInterval(() => {}, 1000);"
  ].join("\n");
  helper = spawn(process.execPath, ["-e", source], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
  helper.on("message", (message) => {
    if (message === "ready") {
      mark(readyFile, JSON.stringify({ parentPid: process.pid, helperPid: helper.pid }));
    }
  });
  helper.once("exit", () => mark(childExitedFile, String(helper.pid)));
}

if (values.mode === "environment") {
  process.stdout.write(JSON.stringify({
    argv: process.argv.slice(2),
    cwd: process.cwd(),
    env: process.env
  }));
} else if (values.mode === "output") {
  writeBytes(process.stdout, Number(values.stdout ?? 0), "o");
  writeBytes(process.stderr, Number(values.stderr ?? 0), "e");
} else if (values.mode === "signal") {
  process.kill(process.pid, values.signal || "SIGTERM");
} else if (values.mode === "delay" || values.mode === "child") {
  setTimeout(() => {
    if (helper) helper.kill("SIGTERM");
    mark(exitFile, `${process.pid}:normal`);
    process.exit(Number(values.code ?? 0));
  }, Number(values.delay ?? 30_000));
} else {
  process.exit(Number(values.code ?? 0));
}
