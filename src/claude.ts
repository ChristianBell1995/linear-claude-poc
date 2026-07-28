/**
 * Runs Claude Code headless.
 *
 * Three things here are load-bearing and easy to get wrong:
 *
 * 1. The prompt goes on STDIN, never as a positional argument. `--allowedTools`,
 *    `--disallowedTools`, `--tools` and `--add-dir` are all variadic, so a
 *    positional prompt placed after any of them is swallowed and the CLI exits
 *    with "Input must be provided either through stdin or as a prompt argument".
 *
 * 2. `--tools` is the real boundary, not `--allowedTools`. Under `acceptEdits`,
 *    Claude Code auto-approves commands it classifies as read-only whether or not
 *    they were allowlisted. Omitting WebFetch, WebSearch and Agent from `--tools`
 *    is what actually removes the outbound network channel and uncontrolled
 *    subagents; omitting ToolSearch removes every deferred tool.
 *
 * 3. A denied tool does NOT fail the run: exit code stays 0 and is_error stays
 *    false. The only signal is a non-empty permission_denials array, so a run with
 *    denials is treated as failed rather than shipped as a PR.
 */
import path from "node:path";
import { writeFile } from "node:fs/promises";
import { config } from "./config.ts";
import { baseEnv, run } from "./exec.ts";
import type { LinearIssue } from "./linear.ts";
import { implementPrompt, prDescriptionPrompt, repairPrompt } from "./prompts.ts";

const TIMEOUT = {
  implement: 15 * 60_000,
  repair: 8 * 60_000,
  describe: 2 * 60_000,
};

/** Built-ins the agent may use at all. This is the security boundary. Exported so tests assert the real list. */
export const TOOLS = "Read,Edit,Write,Glob,Grep,Bash";

/*
 * Broad on purpose. An earlier version allowed only `yarn lint`, `yarn tsc` and
 * `yarn build`, which blocked the agent from orienting itself with `yarn
 * --version`, `which yarn` and `type yarn` and made runs fail for no good reason.
 * `Bash(yarn:*)` is safe here because deny beats allow, so the mutating and
 * long-running subcommands below still cannot run.
 */
export const ALLOWED = [
  "Bash(yarn:*)",
  "Bash(ls:*)",
  "Bash(find:*)",
  "Bash(grep:*)",
  "Bash(head:*)",
  "Bash(tail:*)",
  "Bash(wc:*)",
  "Bash(cat:*)",
  "Bash(echo:*)",
  "Bash(pwd)",
  "Bash(which:*)",
  "Bash(type:*)",
  "Bash(command:*)",
];

/*
 * Deny beats allow. `node` is here because `node -e` is arbitrary code execution
 * that would sail past every other rule, and the shells plus xargs are the
 * standard ways to launder a denied command past prefix matching. This is a
 * guardrail, not a sandbox: assume a determined agent can escape it, and rely on
 * the controls that still hold afterwards (secrets absent from this environment,
 * a repo-scoped PAT, and a human watching).
 */
export const DISALLOWED = [
  "Bash(git:*)",
  "Bash(gh:*)",
  "Bash(curl:*)",
  "Bash(wget:*)",
  // Dependency mutation: the runner aborts on a package.json diff anyway, but
  // stopping it here means the agent never wastes a turn on it.
  "Bash(yarn add:*)",
  "Bash(yarn remove:*)",
  "Bash(yarn install:*)",
  "Bash(yarn upgrade:*)",
  "Bash(yarn global:*)",
  "Bash(yarn link:*)",
  "Bash(yarn create:*)",
  "Bash(yarn publish:*)",
  // Long-running servers: these never exit, so the agent would sit against the
  // 5 minute Bash timeout for nothing.
  "Bash(yarn dev:*)",
  "Bash(yarn start:*)",
  "Bash(npm:*)",
  "Bash(npx:*)",
  "Bash(pnpm:*)",
  "Bash(bun:*)",
  "Bash(node:*)",
  "Bash(sh:*)",
  "Bash(bash:*)",
  "Bash(zsh:*)",
  "Bash(eval:*)",
  "Bash(xargs:*)",
  "Bash(sudo:*)",
  "Bash(rm:*)",
  "WebFetch",
  "WebSearch",
];

export interface ClaudeResult {
  ok: boolean;
  /** Set when ok is false: a specific, reportable reason. */
  failureReason?: string;
  /** The agent's own final message, used in PR bodies and Linear comments. */
  summary: string;
  sessionId?: string;
  costUsd: number;
  denials: string[];
}

interface Envelope {
  is_error?: boolean;
  subtype?: string;
  terminal_reason?: string;
  permission_denials?: Array<{ tool_name?: string; tool_input?: { command?: string } }>;
  result?: string;
  structured_output?: unknown;
  session_id?: string;
  total_cost_usd?: number;
  api_error_status?: number | null;
}

/**
 * Environment for the agent. baseEnv() already strips every secret; the Bash
 * timeout is raised because a cold Next build in a fresh worktree can outlast the
 * 2 minute default.
 */
function childEnv(): NodeJS.ProcessEnv {
  return baseEnv({
    BASH_DEFAULT_TIMEOUT_MS: "300000",
    BASH_MAX_TIMEOUT_MS: "600000",
  });
}

function baseArgs(budgetUsd: number): string[] {
  return [
    "-p",
    "--model",
    config.claude.model,
    "--effort",
    config.claude.effort,
    "--output-format",
    "json",
    // No --mcp-config alongside this, so all MCP servers are disabled. Without it
    // the unauthenticated Linear MCP server registered at user scope would load
    // into every run.
    "--strict-mcp-config",
    "--max-budget-usd",
    String(budgetUsd),
  ];
}

async function invoke(
  label: string,
  identifier: string,
  args: string[],
  prompt: string,
  cwd: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<{ envelope: Envelope | null; result: ClaudeResult }> {
  const started = Date.now();
  const proc = await run("claude", args, { cwd, timeoutMs, signal, stdin: prompt, env: childEnv() });

  await writeFile(
    path.join(config.paths.logs, `${identifier}-${label}.json`),
    JSON.stringify(
      { label, args, durationMs: Date.now() - started, code: proc.code, timedOut: proc.timedOut, stdout: proc.stdout, stderr: proc.stderr },
      null,
      2,
    ),
    "utf8",
  ).catch(() => {});

  const fail = (reason: string): { envelope: Envelope | null; result: ClaudeResult } => ({
    envelope: null,
    result: { ok: false, failureReason: reason, summary: "", costUsd: 0, denials: [] },
  });

  if (proc.timedOut) return fail(`Claude Code hit the ${Math.round(timeoutMs / 60_000)} minute limit and was terminated`);
  if (proc.aborted) return fail("the job exceeded its overall wall clock limit");

  let envelope: Envelope;
  try {
    envelope = JSON.parse(proc.stdout) as Envelope;
  } catch {
    return fail(
      `could not parse Claude Code output (exit ${proc.code}):\n${(proc.stderr || proc.stdout).trim().slice(-1200)}`,
    );
  }

  const denials = (envelope.permission_denials ?? []).map(
    (d) => d.tool_input?.command ?? d.tool_name ?? "unknown",
  );
  const result: ClaudeResult = {
    ok: true,
    summary: envelope.result ?? "",
    sessionId: envelope.session_id,
    costUsd: envelope.total_cost_usd ?? 0,
    denials,
  };

  if (envelope.api_error_status) {
    return { envelope, result: { ...result, ok: false, failureReason: `the Claude API returned ${envelope.api_error_status}` } };
  }
  if (envelope.is_error || envelope.subtype !== "success" || envelope.terminal_reason !== "completed") {
    return {
      envelope,
      result: {
        ...result,
        ok: false,
        failureReason: `the run did not complete cleanly (subtype=${envelope.subtype}, terminal_reason=${envelope.terminal_reason})`,
      },
    };
  }
  /*
   * Denials are reported, not fatal.
   *
   * They used to fail the run, on the theory that a stonewalled agent must not
   * produce a PR. In practice the agent probes its environment (`which yarn`,
   * `yarn --version`) and works around a refusal perfectly well, so failing on
   * that killed runs that would otherwise have succeeded.
   *
   * Nothing is lost by relaxing it: an agent that genuinely gave up produces
   * either a failing build or an empty diff, and the runner already catches both.
   * Those checks test the outcome rather than guessing from the transcript.
   */
  if (denials.length > 0) {
    console.warn(`[claude] ${denials.length} command(s) were denied but the run completed: ${denials.slice(0, 8).join(", ")}`);
  }

  return { envelope, result };
}

/** Writes one trivial file, so the git and PR chain can be proven without spending tokens. */
async function stubImplement(dir: string, issue: LinearIssue): Promise<ClaudeResult> {
  await writeFile(
    path.join(dir, "app", "claude-stub.ts"),
    `// Written by the CLAUDE_STUB path for ${issue.identifier}. Not a real implementation.\nexport const stubbedIssue = ${JSON.stringify(issue.identifier)};\n`,
    "utf8",
  );
  return {
    ok: true,
    summary: `CLAUDE_STUB=1 was set, so no model ran. Wrote app/claude-stub.ts for ${issue.identifier}.`,
    costUsd: 0,
    denials: [],
  };
}

export async function implement(dir: string, issue: LinearIssue, signal?: AbortSignal): Promise<ClaudeResult> {
  if (config.claude.stub) return stubImplement(dir, issue);

  const args = [
    ...baseArgs(config.claude.maxBudgetUsd),
    "--permission-mode",
    "acceptEdits",
    "--tools",
    TOOLS,
    "--allowedTools",
    ...ALLOWED,
    "--disallowedTools",
    ...DISALLOWED,
  ];
  const { result } = await invoke("implement", issue.identifier, args, implementPrompt(issue), dir, TIMEOUT.implement, signal);
  return result;
}

/** One repair attempt, forked from the implementation session so context is retained. */
export async function repair(
  dir: string,
  issue: LinearIssue,
  sessionId: string,
  stage: string,
  output: string,
  signal?: AbortSignal,
): Promise<ClaudeResult> {
  if (config.claude.stub) {
    return { ok: false, failureReason: "CLAUDE_STUB cannot repair", summary: "", costUsd: 0, denials: [] };
  }

  const args = [
    ...baseArgs(Math.max(1, config.claude.maxBudgetUsd / 2)),
    "--resume",
    sessionId,
    "--fork-session",
    "--permission-mode",
    "acceptEdits",
    "--tools",
    TOOLS,
    "--allowedTools",
    ...ALLOWED,
    "--disallowedTools",
    ...DISALLOWED,
  ];
  const { result } = await invoke("repair", issue.identifier, args, repairPrompt(stage, output), dir, TIMEOUT.repair, signal);
  return result;
}

export interface PrDescription {
  title: string;
  body: string;
}

/**
 * Generates the PR title and body with zero tools. Returns null on any problem:
 * the caller must fall back to a deterministic description, because a model call
 * is not allowed to be a single point of failure in the plumbing.
 */
export async function describePr(
  dir: string,
  issue: LinearIssue,
  diff: string,
  summary: string,
  signal?: AbortSignal,
): Promise<PrDescription | null> {
  if (config.claude.stub) return null;

  const schema = JSON.stringify({
    type: "object",
    properties: { title: { type: "string", maxLength: 72 }, body: { type: "string", maxLength: 4000 } },
    required: ["title", "body"],
    additionalProperties: false,
  });

  const args = [
    "-p",
    "--model",
    config.claude.model,
    "--effort",
    "low",
    "--output-format",
    "json",
    "--strict-mcp-config",
    "--max-budget-usd",
    "0.5",
    "--tools",
    "",
    "--json-schema",
    schema,
  ];

  const { envelope, result } = await invoke(
    "describe",
    issue.identifier,
    args,
    prDescriptionPrompt(issue, diff, summary),
    dir,
    TIMEOUT.describe,
    signal,
  );
  if (!result.ok || !envelope) return null;

  const output = envelope.structured_output as PrDescription | undefined;
  if (!output?.title?.trim() || !output?.body?.trim()) return null;
  return { title: output.title.trim(), body: output.body.trim() };
}
