import { Buffer } from "node:buffer";
import { flattenProviderText } from "../../models/inventory";
import { quotePosixToken } from "./providers/containerlabCommands";
import type {
  ContainerlabCommand,
  ContainerlabCommandResult,
  ContainerlabCommandRunner,
  ContainerlabRunContext
} from "./containerlabRuntimeContracts";
import type { ContextAwareSshFactory, SshCommandChannel, SshConnection } from "../ssh/contracts";

const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const CURRENT_CHECK_INTERVAL_MS = 25;
const REMOTE_ENV_EXECUTABLE = "/usr/bin/env";

export interface ContainerlabSshRunnerDependencies {
  readonly sshFactory: ContextAwareSshFactory;
  readonly now?: () => number;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? flattenProviderText(error.message) : "";
}

function cancellationError(reason?: unknown): Error {
  const detail = errorMessage(reason);
  const error = new Error(detail ? `Containerlab SSH command cancelled: ${detail}` : "Containerlab SSH command cancelled");
  error.name = "AbortError";
  return error;
}

function timeoutError(): Error {
  return new Error("Containerlab SSH command timed out at its deadline");
}

function outputLimitError(): Error {
  return new Error(`Containerlab command output limit exceeded (${MAX_OUTPUT_BYTES} bytes combined).`);
}

function reasonError(signal: AbortSignal, context: ContainerlabRunContext, now: () => number): Error | undefined {
  if (context.signal.aborted) return cancellationError(context.signal.reason);
  if (signal.aborted) {
    const reason = signal.reason;
    return reason instanceof Error && /timed out|deadline/iu.test(reason.message) ? reason : cancellationError(reason);
  }
  if (!context.isCurrent()) return cancellationError("the operation is no longer current");
  if (now() >= context.deadline) return timeoutError();
  return undefined;
}

function createRunGuard(context: ContainerlabRunContext, now: () => number): {
  readonly signal: AbortSignal;
  assertCurrent(): void;
  dispose(): void;
} {
  const controller = new AbortController();
  const abortForContext = (): void => controller.abort(cancellationError(context.signal.reason));
  const check = (): void => {
    if (controller.signal.aborted) return;
    if (context.signal.aborted) {
      abortForContext();
    } else if (!context.isCurrent()) {
      controller.abort(cancellationError("the operation is no longer current"));
    } else if (now() >= context.deadline) {
      controller.abort(timeoutError());
    }
  };
  if (context.signal.aborted) abortForContext();
  else context.signal.addEventListener("abort", abortForContext, { once: true });
  const remaining = Math.max(0, context.deadline - now());
  const deadlineTimer = setTimeout(() => controller.abort(timeoutError()), remaining);
  deadlineTimer.unref?.();
  const currentTimer = setInterval(check, CURRENT_CHECK_INTERVAL_MS);
  currentTimer.unref?.();

  return {
    signal: controller.signal,
    assertCurrent: () => {
      check();
      const error = reasonError(controller.signal, context, now);
      if (error) throw error;
    },
    dispose: () => {
      clearTimeout(deadlineTimer);
      clearInterval(currentTimer);
      context.signal.removeEventListener("abort", abortForContext);
    }
  };
}

function awaitWithSignal<T>(promise: Promise<T>, signal: AbortSignal, disposeLate?: (value: T) => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const cleanup = (): void => signal.removeEventListener("abort", onAbort);
    const onAbort = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(signal.reason instanceof Error ? signal.reason : cancellationError(signal.reason));
    };
    if (signal.aborted) {
      void promise.then((value) => disposeLate?.(value), () => undefined);
      reject(signal.reason instanceof Error ? signal.reason : cancellationError(signal.reason));
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
    void promise.then(
      (value) => {
        if (settled || signal.aborted) {
          try {
            disposeLate?.(value);
          } catch {
            // The primary cancellation owns this branch; late-resource cleanup is best-effort here.
          }
          onAbort();
          return;
        }
        settled = true;
        cleanup();
        resolve(value);
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      }
    );
  });
}

function remoteCommandLine(command: ContainerlabCommand): string {
  const environment = Object.entries(command.env).sort(([left], [right]) => left.localeCompare(right));
  const tokens = [
    REMOTE_ENV_EXECUTABLE,
    "-i",
    ...environment.map(([key, value]) => `${key}=${value}`),
    command.executable,
    ...command.args
  ];
  return tokens.map(quotePosixToken).join(" ");
}

function closeOnce(channel: SshCommandChannel): () => void {
  let closed = false;
  return () => {
    if (closed) return;
    closed = true;
    channel.close();
  };
}

function consumeChannel(
  channel: SshCommandChannel,
  signal: AbortSignal,
  context: ContainerlabRunContext,
  now: () => number,
  closeChannel: () => void
): Promise<ContainerlabCommandResult> {
  return new Promise<ContainerlabCommandResult>((resolve, reject) => {
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let totalBytes = 0;
    let stdoutEnded = false;
    let stderrEnded = false;
    let completed = false;
    let completion: { readonly code: number | null; readonly signal?: string } | undefined;
    let settled = false;

    const cleanup = (): void => {
      channel.stdout.removeListener("data", onStdout);
      channel.stdout.removeListener("end", onStdoutEnd);
      channel.stdout.removeListener("error", onStreamError);
      channel.stderr.removeListener("data", onStderr);
      channel.stderr.removeListener("end", onStderrEnd);
      channel.stderr.removeListener("error", onStreamError);
      signal.removeEventListener("abort", onAbort);
    };
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      closeChannel();
      reject(error);
    };
    const onAbort = (): void => {
      const error = signal.reason instanceof Error ? signal.reason : cancellationError(signal.reason);
      fail(error);
    };
    const collect = (chunks: Buffer[], chunk: Buffer | string): void => {
      if (settled) return;
      const buffer = Buffer.isBuffer(chunk) ? Buffer.from(chunk) : Buffer.from(chunk, "utf8");
      totalBytes += buffer.byteLength;
      if (totalBytes > MAX_OUTPUT_BYTES) {
        fail(outputLimitError());
        return;
      }
      chunks.push(buffer);
    };
    const onStdout = (chunk: Buffer | string): void => collect(stdout, chunk);
    const onStderr = (chunk: Buffer | string): void => collect(stderr, chunk);
    const onStdoutEnd = (): void => {
      stdoutEnded = true;
      finishIfComplete();
    };
    const onStderrEnd = (): void => {
      stderrEnded = true;
      finishIfComplete();
    };
    const onStreamError = (error: Error): void => fail(new Error(`Containerlab SSH output stream failed: ${flattenProviderText(error.message)}`));
    const finishIfComplete = (): void => {
      if (settled || !completed || !stdoutEnded || !stderrEnded) return;
      if (!completion || typeof completion.code !== "number" && completion.code !== null) {
        fail(new Error("Containerlab SSH command completed without exit information."));
        return;
      }
      if (completion.signal) {
        fail(new Error(`Containerlab SSH command terminated by signal ${flattenProviderText(completion.signal)}.`));
        return;
      }
      if (completion.code === null) {
        fail(new Error("Containerlab SSH command closed without an exit code or signal."));
        return;
      }
      if (completion.code !== 0) {
        const safeStderr = flattenProviderText(Buffer.concat(stderr).toString("utf8")).slice(0, 512);
        fail(new Error(`Containerlab SSH command exited with code ${completion.code}${safeStderr ? `: ${safeStderr}` : ""}`));
        return;
      }
      const error = reasonError(signal, context, now);
      if (error) {
        fail(error);
        return;
      }
      settled = true;
      cleanup();
      resolve({ stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") });
    };

    // Both streams are observed before waiting for completion so neither can
    // fill its SSH channel window while the other stream is being drained.
    channel.stdout.on("data", onStdout);
    channel.stdout.on("end", onStdoutEnd);
    channel.stdout.on("error", onStreamError);
    channel.stderr.on("data", onStderr);
    channel.stderr.on("end", onStderrEnd);
    channel.stderr.on("error", onStreamError);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();

    void channel.completion.then(
      (result) => {
        completion = result;
        completed = true;
        finishIfComplete();
      },
      (error: unknown) => fail(error instanceof Error ? error : new Error("Containerlab SSH command completion failed."))
    );
  });
}

function validateContext(context: ContainerlabRunContext, now: () => number): void {
  if (!context.labHost) throw new Error("Containerlab SSH execution requires a validated lab-host snapshot.");
  if (!context.labHostRouteIdentity || context.labHostRouteIdentity.trim() === "") {
    throw new Error("Containerlab SSH execution requires the captured lab-host route identity.");
  }
  const error = reasonError(context.signal, context, now);
  if (error) throw error;
}

/** Acquires a bounded, noninteractive-capable SSH lease and uses typed exec only. */
export function createContainerlabSshRunner(dependencies: ContainerlabSshRunnerDependencies): ContainerlabCommandRunner {
  const now = dependencies.now ?? Date.now;
  return {
    async run(command: ContainerlabCommand, context: ContainerlabRunContext): Promise<ContainerlabCommandResult> {
      validateContext(context, now);
      const guard = createRunGuard(context, now);
      let connection: SshConnection | undefined;
      let channel: SshCommandChannel | undefined;
      let closeChannel: (() => void) | undefined;
      try {
        guard.assertCurrent();
        const host = context.labHost!;
        const acquisition = dependencies.sshFactory.connectWithContext(host, {
          interaction: context.interaction,
          signal: guard.signal,
          isActive: () => !guard.signal.aborted && context.isCurrent() && now() < context.deadline
        });
        connection = await awaitWithSignal(acquisition, guard.signal, (late) => late.dispose());
        guard.assertCurrent();
        if (connection.execCommand === undefined) {
          throw new Error("Containerlab SSH execution requires typed command channels.");
        }
        guard.assertCurrent();
        const opening = connection.execCommand(remoteCommandLine(command), guard.signal);
        channel = await awaitWithSignal(opening, guard.signal, (late) => late.close());
        closeChannel = closeOnce(channel);
        guard.assertCurrent();
        return await consumeChannel(channel, guard.signal, context, now, closeChannel);
      } finally {
        if (channel) {
          (closeChannel ?? closeOnce(channel))();
        }
        connection?.dispose();
        guard.dispose();
      }
    }
  };
}
