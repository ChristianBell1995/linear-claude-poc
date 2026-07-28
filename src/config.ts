/**
 * Environment configuration, validated once at import time.
 *
 * Secrets have no defaults and throw immediately if absent, so a misconfigured
 * service fails at startup rather than halfway through a job. GITHUB_PAT is the
 * exception: it is only needed once the runner starts pushing, so it is checked
 * at point of use by git.ts instead of blocking the webhook path from starting.
 */
import { fileURLToPath } from "node:url";
import path from "node:path";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(
      `Missing required env var ${name}. Copy .env.example to .env, fill it in, and run with --env-file=.env`,
    );
  }
  return value;
}

function optional(name: string, fallback: string): string {
  return process.env[name]?.trim() || fallback;
}

function numeric(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Env var ${name} must be a number, got ${JSON.stringify(raw)}`);
  }
  return parsed;
}

export const config = Object.freeze({
  projectRoot: PROJECT_ROOT,
  port: numeric("PORT", 3939),

  linear: Object.freeze({
    apiKey: required("LINEAR_API_KEY"),
    webhookSecret: required("LINEAR_WEBHOOK_SECRET"),
    /** Only label additions by this Linear user arm a job. The strongest control against prompt injection. */
    actorId: required("LINEAR_ACTOR_ID"),
  }),

  labels: Object.freeze({
    trigger: optional("CLAUDE_LABEL", "claude"),
    running: optional("RUNNING_LABEL", "claude-running"),
    failed: optional("FAILED_LABEL", "claude-failed"),
  }),

  repo: Object.freeze({
    path: optional("REPO_PATH", "/Users/christianbell/code/ChristianBell1995/my-app"),
    slug: optional("REPO_SLUG", "ChristianBell1995/Nextjs"),
    baseBranch: optional("BASE_BRANCH", "main"),
  }),

  claude: Object.freeze({
    model: optional("CLAUDE_MODEL", "sonnet"),
    effort: optional("CLAUDE_EFFORT", "medium"),
    maxBudgetUsd: numeric("MAX_BUDGET_USD", 4),
    /**
     * CLAUDE_STUB=1 writes a trivial file instead of invoking the model. Lets the
     * git and PR chain be exercised end to end without spending tokens, which is
     * how checkpoint 2 is verified.
     */
    stub: (process.env.CLAUDE_STUB?.trim() ?? "") === "1",
  }),

  paths: Object.freeze({
    worktreeRoot: optional("WORKTREE_ROOT", path.join(PROJECT_ROOT, "worktrees")),
    logs: path.join(PROJECT_ROOT, "logs"),
    state: path.join(PROJECT_ROOT, "state.json"),
  }),

  /** Not validated here; git.ts throws if it is missing when a push is attempted. */
  githubPat: process.env.GITHUB_PAT?.trim() ?? "",
});
