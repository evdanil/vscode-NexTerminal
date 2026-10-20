import { spawn } from "node:child_process";
import { flattenProviderText } from "../../models/inventory";
import type {
  ContainerlabCommand,
  ContainerlabCommandResult,
  ContainerlabCommandRunner,
  ContainerlabRunContext
} from "./containerlabRuntimeContracts";

export const CONTAINERLAB_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const KILL_ESCALATION_MS = 100;
const CURRENT_CHECK_INTERVAL_MS = 25;
const STDERR_MESSAGE_LIMIT = 512;

function cancellationError(reason?: unknown): Error {
  const detail = reason instanceof Error ? flattenProviderText(reason.message) : "";
  const error = new Error(detail ? `Containerlab command cancelled: ${detail}` : "Containerlab command cancelled");
  error.name = "AbortError";
  return error;
}

function guardError(context: ContainerlabRunContext, now: number): Error | undefined {
  if (context.signal.aborted) return cancellationError(context.signal.reason);
  if (!context.isCurrent()) return cancellationError("the operation is no longer current");
  if (now >= context.deadline) return new Error("Containerlab command timed out at its deadline");
  return undefined;
}

function outputLimitError(): Error {
  return new Error(`Containerlab command output limit exceeded (${CONTAINERLAB_MAX_OUTPUT_BYTES} bytes combined).`);
}

function commandFailure(code: number | null, signal: NodeJS.Signals | null, stderr: string): Error {
  const status = signal ? `terminated by signal ${signal}` : `exited with code ${String(code)}`;
  const safeStderr = flattenProviderText(stderr).slice(0, STDERR_MESSAGE_LIMIT);
  return new Error(`Containerlab command ${status}${safeStderr ? `: ${safeStderr}` : ""}`);
}

/** Runs only the explicit argv and allowlisted environment supplied by the runtime. */
export function createContainerlabProcessRunner(): ContainerlabCommandRunner {
  return {
    run(command: ContainerlabCommand, context: ContainerlabRunContext): Promise<ContainerlabCommandResult> {
      const initialError = guardError(context, Date.now());
      if (initialError) return Promise.reject(initialError);

      return new Promise<ContainerlabCommandResult>((resolve, reject) => {
        const child = spawn(command.executable, [...command.args], {
          cwd: command.cwd,
          env: { ...command.env },
          shell: false,
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"]
        });
        const stdoutChunks: Buffer[] = [];
        const stderrChunks: Buffer[] = [];
        let outputBytes = 0;
        let streamError: Error | undefined;
        let cancellation: Error | undefined;
        let outputOverflow = false;
        let settled = false;
        let killEscalation: NodeJS.Timeout | undefined;
        let deadlineTimer: NodeJS.Timeout | undefined;
        let currentTimer: NodeJS.Timeout | undefined;

        const cleanup = (): void => {
          if (deadlineTimer) clearTimeout(deadlineTimer);
          if (currentTimer) clearInterval(currentTimer);
          if (killEscalation) clearTimeout(killEscalation);
          context.signal.removeEventListener("abort", onAbort);
          child.stdout?.removeListener("data", onStdout);
          child.stderr?.removeListener("data", onStderr);
          child.removeListener("error", onError);
          child.removeListener("close", onClose);
        };

        const terminate = (error: Error): void => {
          if (settled || cancellation) return;
          cancellation = error;
          try {
            child.kill("SIGTERM");
          } catch {
            // The close event remains authoritative for releasing this child.
          }
          killEscalation = setTimeout(() => {
            if (settled) return;
            try {
              child.kill("SIGKILL");
            } catch {
              // The child may have exited while the escalation timer was queued.
            }
          }, KILL_ESCALATION_MS);
          killEscalation.unref?.();
        };

        const onAbort = (): void => terminate(cancellationError(context.signal.reason));
        const onStdout = (chunk: Buffer | string): void => collect(stdoutChunks, chunk);
        const onStderr = (chunk: Buffer | string): void => collect(stderrChunks, chunk);
        const collect = (target: Buffer[], chunk: Buffer | string): void => {
          if (settled || outputOverflow) return;
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8");
          outputBytes += buffer.byteLength;
          if (outputBytes > CONTAINERLAB_MAX_OUTPUT_BYTES) {
            outputOverflow = true;
            terminate(outputLimitError());
            return;
          }
          target.push(buffer);
        };

        const onError = (error: Error): void => {
          streamError = error;
          terminate(error);
        };

        const onClose = (code: number | null, signal: NodeJS.Signals | null): void => {
          if (settled) return;
          settled = true;
          cleanup();
          if (cancellation) {
            reject(cancellation);
            return;
          }
          if (streamError) {
            reject(streamError);
            return;
          }
          if (outputOverflow) {
            reject(outputLimitError());
            return;
          }
          if (signal !== null || code === null) {
            reject(commandFailure(code, signal, Buffer.concat(stderrChunks).toString("utf8")));
            return;
          }
          if (code !== 0) {
            reject(commandFailure(code, signal, Buffer.concat(stderrChunks).toString("utf8")));
            return;
          }
          const lateError = guardError(context, Date.now());
          if (lateError) {
            reject(lateError);
            return;
          }
          resolve({
            stdout: Buffer.concat(stdoutChunks).toString("utf8"),
            stderr: Buffer.concat(stderrChunks).toString("utf8")
          });
        };

        child.stdout?.on("data", onStdout);
        child.stderr?.on("data", onStderr);
        child.on("error", onError);
        child.on("close", onClose);
        context.signal.addEventListener("abort", onAbort, { once: true });
        const remaining = context.deadline - Date.now();
        deadlineTimer = setTimeout(() => terminate(new Error("Containerlab command timed out at its deadline")), remaining);
        deadlineTimer.unref?.();
        currentTimer = setInterval(() => {
          const error = guardError(context, Date.now());
          if (error) terminate(error);
        }, CURRENT_CHECK_INTERVAL_MS);
        currentTimer.unref?.();

        // A synchronous abort between the initial guard and listener installation
        // must still stop this exact child.
        const afterStartError = guardError(context, Date.now());
        if (afterStartError) terminate(afterStartError);
      });
    }
  };
}
