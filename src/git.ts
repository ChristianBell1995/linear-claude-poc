/**
 * All git and gh operations.
 *
 * Two rules hold throughout. First, the fine-grained PAT is injected explicitly
 * via GH_TOKEN on every call: baseEnv() strips it by default so the Claude child
 * cannot see it, and only this module puts it back. Without GH_TOKEN the gh
 * credential helper would hand git the keychain OAuth token instead, which
 * carries account-wide `repo` scope.
 *
 * Second, nothing here force-pushes. A rejected push means something happened
 * that the design did not predict, and the right response is to stop and report.
 */
import path from "node:path";
import { existsSync, readdirSync, statSync } from "node:fs";
import { rm } from "node:fs/promises";
import { config } from "./config.ts";
import { baseEnv, run, type RunResult } from "./exec.ts";

const TIMEOUT = {
  fetch: 60_000,
  lsRemote: 30_000,
  worktree: 60_000,
  cloneDeps: 120_000,
  inspect: 30_000,
  commit: 30_000,
  push: 90_000,
  gh: 60_000,
};

/** Max characters of diff handed to the PR-description model call. */
export const MAX_DIFF_CHARS = 60_000;

function tokenEnv(): NodeJS.ProcessEnv {
  if (!config.githubPat) {
    throw new Error("GITHUB_PAT is not set in .env, so pushing and opening pull requests is not possible");
  }
  return baseEnv({ GH_TOKEN: config.githubPat });
}

function git(args: string[], cwd: string, timeoutMs: number, signal?: AbortSignal): Promise<RunResult> {
  return run("git", args, { cwd, timeoutMs, signal, env: tokenEnv() });
}

function gh(args: string[], cwd: string, signal?: AbortSignal, stdin?: string): Promise<RunResult> {
  return run("gh", args, { cwd, timeoutMs: TIMEOUT.gh, signal, stdin, env: tokenEnv() });
}

/** Turns a non-zero exit into an error carrying the tail of whatever the command said. */
function expectOk(result: RunResult, what: string): RunResult {
  if (result.ok) return result;
  const cause = result.timedOut ? "timed out" : result.aborted ? "aborted" : `exit ${result.code}`;
  const detail = (result.stderr || result.stdout).trim().slice(-1500);
  throw new Error(`${what} failed (${cause})${detail ? `:\n${detail}` : ""}`);
}

/** Worktree directories are named from the identifier, not branchName, which contains a slash. */
export function worktreePathFor(identifier: string): string {
  return path.join(config.paths.worktreeRoot, identifier.replace(/[^A-Za-z0-9._-]/g, "-"));
}

/** Fallback link for the case where the push succeeded but PR creation did not. */
export function compareUrl(branch: string): string {
  return `https://github.com/${config.repo.slug}/compare/${config.repo.baseBranch}...${encodeURIComponent(branch)}?expand=1`;
}

export async function fetchBase(signal?: AbortSignal): Promise<void> {
  expectOk(
    await git(["fetch", "origin", config.repo.baseBranch], config.repo.path, TIMEOUT.fetch, signal),
    `git fetch origin ${config.repo.baseBranch}`,
  );
}

/** Gate 3: does the branch already exist upstream? `--exit-code` returns 2 for no match. */
export async function remoteBranchExists(branch: string, signal?: AbortSignal): Promise<boolean> {
  const result = await git(
    ["ls-remote", "--exit-code", "--heads", "origin", branch],
    config.repo.path,
    TIMEOUT.lsRemote,
    signal,
  );
  if (result.code === 0) return true;
  if (result.code === 2) return false;
  throw expectOk(result, `git ls-remote origin ${branch}`) as never;
}

export interface ExistingPr {
  url: string;
  state: string;
  number: number;
  isDraft: boolean;
}

/** Gate 4: is there already a PR for this branch, in any state? */
export async function openPrFor(branch: string, signal?: AbortSignal): Promise<ExistingPr | null> {
  const result = expectOk(
    await gh(
      ["pr", "list", "-R", config.repo.slug, "--head", branch, "--state", "all", "--json", "url,state,number,isDraft"],
      config.repo.path,
      signal,
    ),
    "gh pr list",
  );
  const rows = JSON.parse(result.stdout.trim() || "[]") as ExistingPr[];
  return rows[0] ?? null;
}

async function localBranchExists(branch: string, signal?: AbortSignal): Promise<boolean> {
  const result = await git(
    ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`],
    config.repo.path,
    TIMEOUT.inspect,
    signal,
  );
  return result.code === 0;
}

/**
 * Creates a worktree at the tip of origin/<base>, which is what keeps the main
 * checkout's uncommitted work out of the diff.
 *
 * Leftovers from an earlier failed run are cleared first. Deleting the local
 * branch is safe here because the caller's gates have already established that
 * nothing was pushed and no PR exists for it.
 */
export async function createWorktree(branch: string, dir: string, signal?: AbortSignal): Promise<void> {
  await rm(dir, { recursive: true, force: true });
  await git(["worktree", "prune"], config.repo.path, TIMEOUT.worktree, signal);
  if (await localBranchExists(branch, signal)) {
    expectOk(await git(["branch", "-D", branch], config.repo.path, TIMEOUT.inspect, signal), `git branch -D ${branch}`);
  }
  expectOk(
    await git(
      ["worktree", "add", "-b", branch, dir, `origin/${config.repo.baseBranch}`],
      config.repo.path,
      TIMEOUT.worktree,
      signal,
    ),
    `git worktree add ${dir}`,
  );
}

/**
 * Populates the worktree's node_modules with an APFS clonefile copy.
 *
 * `cp -Rc` is copy-on-write, so 469MB costs about five seconds and almost no
 * disk. A symlink would be faster still but resolves outside the worktree, which
 * puts node_modules/next/dist/docs/ beyond the agent's reach and makes the
 * repo's AGENTS.md instruction impossible to follow.
 */
export async function cloneNodeModules(dir: string, signal?: AbortSignal): Promise<void> {
  const source = path.join(config.repo.path, "node_modules");
  if (!existsSync(source)) {
    throw new Error(`${source} does not exist; run yarn install in the main checkout first`);
  }
  const dest = path.join(dir, "node_modules");
  expectOk(
    await run("cp", ["-Rc", source, dest], { timeoutMs: TIMEOUT.cloneDeps, signal, env: baseEnv() }),
    "cp -Rc node_modules",
  );
  if (!existsSync(path.join(dest, "next", "package.json"))) {
    throw new Error("the node_modules clone is incomplete: next/package.json is missing from the worktree");
  }
}

export async function stageAll(dir: string, signal?: AbortSignal): Promise<void> {
  expectOk(await git(["add", "-A"], dir, TIMEOUT.inspect, signal), "git add -A");
}

export async function stagedFiles(dir: string, signal?: AbortSignal): Promise<string[]> {
  const result = expectOk(
    await git(["diff", "--cached", "--name-only"], dir, TIMEOUT.inspect, signal),
    "git diff --cached --name-only",
  );
  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

export async function stagedDiff(dir: string, maxChars = MAX_DIFF_CHARS, signal?: AbortSignal): Promise<string> {
  const result = expectOk(await git(["diff", "--cached"], dir, TIMEOUT.inspect, signal), "git diff --cached");
  const diff = result.stdout;
  return diff.length > maxChars ? `${diff.slice(0, maxChars)}\n\n[…diff truncated at ${maxChars} characters…]` : diff;
}

export async function stagedDiffStat(dir: string, signal?: AbortSignal): Promise<string> {
  const result = expectOk(
    await git(["diff", "--cached", "--stat"], dir, TIMEOUT.inspect, signal),
    "git diff --cached --stat",
  );
  return result.stdout.trim();
}

export async function commit(dir: string, message: string, signal?: AbortSignal): Promise<void> {
  expectOk(await git(["commit", "-m", message], dir, TIMEOUT.commit, signal), "git commit");
}

/** Never force-pushes. Recognises the two failure modes worth naming in a Linear comment. */
export async function push(dir: string, branch: string, signal?: AbortSignal): Promise<void> {
  const result = await git(["push", "--set-upstream", "origin", branch], dir, TIMEOUT.push, signal);
  if (result.ok) return;

  const stderr = result.stderr;
  if (/could not read Username|Authentication failed|terminal prompts disabled|Invalid username/i.test(stderr)) {
    throw new Error(
      `git push could not authenticate. Check GITHUB_PAT is valid and has Contents: write on ${config.repo.slug}.\n${stderr.trim().slice(-800)}`,
    );
  }
  if (/non-fast-forward|\[rejected\]|fetch first/i.test(stderr)) {
    throw new Error(
      `push to ${branch} was rejected, and this does not force-push. Resolve the branch manually.\n${stderr.trim().slice(-800)}`,
    );
  }
  expectOk(result, `git push origin ${branch}`);
}

export interface CreatePrOptions {
  dir: string;
  branch: string;
  title: string;
  body: string;
  draft: boolean;
}

/**
 * Opens the pull request, passing the body on stdin so it is never subject to
 * argv length limits or shell quoting. Recovers the URL if a PR already exists.
 */
export async function createPr(options: CreatePrOptions, signal?: AbortSignal): Promise<string> {
  const args = [
    "pr",
    "create",
    "-R",
    config.repo.slug,
    "--head",
    options.branch,
    "--base",
    config.repo.baseBranch,
    "--title",
    options.title,
    "--body-file",
    "-",
  ];
  if (options.draft) args.push("--draft");

  const result = await gh(args, options.dir, signal, options.body);
  if (result.ok) {
    const url = result.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.startsWith("https://"))
      .pop();
    if (url) return url;
  }

  // gh reports an existing PR as an error; that is a success for our purposes.
  const existing = await openPrFor(options.branch, signal).catch(() => null);
  if (existing) return existing.url;

  throw new Error(
    `gh pr create failed. The branch ${options.branch} was pushed, so open the PR by hand: ${compareUrl(options.branch)}\n${(result.stderr || result.stdout).trim().slice(-800)}`,
  );
}

export async function removeWorktree(dir: string, signal?: AbortSignal): Promise<void> {
  await git(["worktree", "remove", "--force", dir], config.repo.path, TIMEOUT.worktree, signal);
  await rm(dir, { recursive: true, force: true });
  await git(["worktree", "prune"], config.repo.path, TIMEOUT.worktree, signal);
}

/**
 * Clears worktrees left behind by old failed runs. Called at startup only, when
 * nothing can be in flight.
 */
export async function pruneStale(maxAgeMs = 24 * 60 * 60 * 1000): Promise<string[]> {
  await git(["worktree", "prune"], config.repo.path, TIMEOUT.worktree);
  if (!existsSync(config.paths.worktreeRoot)) return [];

  const removed: string[] = [];
  for (const entry of readdirSync(config.paths.worktreeRoot)) {
    const dir = path.join(config.paths.worktreeRoot, entry);
    try {
      if (Date.now() - statSync(dir).mtimeMs < maxAgeMs) continue;
      await removeWorktree(dir);
      removed.push(entry);
    } catch {
      // A directory we cannot inspect or remove is not worth failing startup over.
    }
  }
  return removed;
}
