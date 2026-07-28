/**
 * Child process helper with Node-side timeouts.
 *
 * This machine has no `timeout`/`gtimeout` binary, so every limit is enforced
 * here with SIGTERM followed by SIGKILL. `run` never rejects: callers inspect
 * the result, which means a hung or crashed child can never take down the
 * service via an unhandled rejection.
 */
import { spawn } from "node:child_process";

const MAX_OUTPUT_BYTES = 1_000_000;
const SIGKILL_GRACE_MS = 20_000;

/** Secrets stripped from every child environment, so even a compromised child cannot read them. */
const STRIPPED_SECRETS = [
  "LINEAR_API_KEY",
  "LINEAR_WEBHOOK_SECRET",
  "GITHUB_PAT",
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "ANTHROPIC_API_KEY",
];

export interface RunResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  aborted: boolean;
  durationMs: number;
  ok: boolean;
}

export interface RunOptions {
  cwd?: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  stdin?: string;
  signal?: AbortSignal;
}

/**
 * Base environment for children: secrets removed, and every knob that could make
 * a tool decide to prompt for input turned off. An interactive prompt in a
 * headless child is an indefinite hang.
 */
export function baseEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const name of STRIPPED_SECRETS) delete env[name];
  // Deliberately not setting GIT_ASKPASS="": an empty value is ambiguous across
  // git versions and would sit in front of the gh credential helper that supplies
  // the push token. GIT_TERMINAL_PROMPT=0 is the documented way to refuse prompts.
  delete env.GIT_ASKPASS;
  delete env.SSH_ASKPASS;
  return {
    ...env,
    GIT_TERMINAL_PROMPT: "0",
    CI: "1",
    NEXT_TELEMETRY_DISABLED: "1",
    ...extra,
  };
}

/**
 * A byte-capped sink that keeps the tail of a stream. Truncating the head is the
 * right trade for build and lint output, where the error is at the end.
 */
function createTailSink(limit: number) {
  const chunks: string[] = [];
  let length = 0;
  let truncated = false;
  return {
    push(chunk: string) {
      chunks.push(chunk);
      length += chunk.length;
      while (length > limit && chunks.length > 1) {
        length -= chunks.shift()!.length;
        truncated = true;
      }
    },
    value(): string {
      const text = chunks.join("");
      return truncated ? `[…output truncated…]\n${text.slice(-limit)}` : text;
    },
  };
}

export function run(command: string, args: string[], options: RunOptions = {}): Promise<RunResult> {
  const { cwd, timeoutMs, env, stdin, signal } = options;
  const startedAt = Date.now();

  return new Promise<RunResult>((resolve) => {
    const child = spawn(command, args, {
      cwd,
      env: env ?? baseEnv(),
      stdio: "pipe",
      shell: false,
    });

    const out = createTailSink(MAX_OUTPUT_BYTES);
    const err = createTailSink(MAX_OUTPUT_BYTES);
    let timedOut = false;
    let aborted = false;
    let settled = false;

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => out.push(chunk));
    child.stderr.on("data", (chunk: string) => err.push(chunk));

    let killTimer: NodeJS.Timeout | undefined;
    const terminate = () => {
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), SIGKILL_GRACE_MS);
      killTimer.unref();
    };

    const timeoutTimer = timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          terminate();
        }, timeoutMs)
      : undefined;

    const onAbort = () => {
      aborted = true;
      terminate();
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    const settle = (code: number | null, sig: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (killTimer) clearTimeout(killTimer);
      signal?.removeEventListener("abort", onAbort);
      resolve({
        code,
        signal: sig,
        stdout: out.value(),
        stderr: err.value(),
        timedOut,
        aborted,
        durationMs: Date.now() - startedAt,
        ok: code === 0 && !timedOut && !aborted,
      });
    };

    child.on("error", (error) => {
      err.push(`\n${error.message}`);
      settle(null, null);
    });
    child.on("close", settle);

    // Writing the prompt and then closing stdin is mandatory: `claude -p` waits
    // on stdin indefinitely if it is left open.
    if (stdin !== undefined) {
      child.stdin.on("error", () => {});
      child.stdin.end(stdin);
    } else {
      child.stdin.end();
    }
  });
}
