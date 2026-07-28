/**
 * Job orchestration: a labelled Linear issue becomes a draft pull request.
 *
 * The division of labour is deliberate. Claude Code only reads and writes source
 * files; every git and gh operation, and the whole verification gate, is plain
 * code here. Nothing depends on the model cooperating, and nothing depends on it
 * having remembered to run the checks.
 *
 * Worktrees are kept on failure and removed on success: a kept worktree is the
 * entire debugging surface for a bad run.
 */
import { config } from "./config.ts";
import { describePr, implement, repair, type ClaudeResult } from "./claude.ts";
import { baseEnv, run } from "./exec.ts";
import { addLabel, comment, getIssue, removeLabel, type LinearIssue, type ResolvedLabels } from "./linear.ts";
import { getRecord, putRecord, updateRecord } from "./jobs.ts";
import * as git from "./git.ts";

/**
 * Build MUST come first: it regenerates the gitignored next-env.d.ts and
 * .next/types that the typecheck depends on. Run tsc first in a fresh worktree
 * and its include globs match nothing, which passes and proves nothing.
 */
const VERIFY_STEPS = [
  { stage: "yarn build", args: ["build"], timeoutMs: 8 * 60_000 },
  { stage: "yarn tsc --noEmit", args: ["tsc", "--noEmit"], timeoutMs: 3 * 60_000 },
  { stage: "yarn lint", args: ["lint"], timeoutMs: 3 * 60_000 },
];

/** Changes to these are a hard abort: dependency drift is not this tool's business. */
const FORBIDDEN_FILES = ["package.json", "yarn.lock"];

const MAX_REPORTED_OUTPUT = 3000;

function shortError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function fence(text: string): string {
  return `\`\`\`\n${text.trim().slice(-MAX_REPORTED_OUTPUT)}\n\`\`\``;
}

type VerifyOutcome = { ok: true } | { ok: false; stage: string; output: string };

async function verify(dir: string, signal: AbortSignal): Promise<VerifyOutcome> {
  for (const step of VERIFY_STEPS) {
    const result = await run("yarn", step.args, { cwd: dir, timeoutMs: step.timeoutMs, signal, env: baseEnv() });
    if (!result.ok) {
      const output = result.timedOut
        ? `${step.stage} timed out after ${Math.round(step.timeoutMs / 60_000)} minutes`
        : `${result.stdout}\n${result.stderr}`.trim();
      return { ok: false, stage: step.stage, output };
    }
  }
  return { ok: true };
}

/** Deterministic PR description, used whenever the model-generated one is unavailable. */
function fallbackDescription(issue: LinearIssue, diffStat: string): { title: string; body: string } {
  return {
    title: `${issue.identifier}: ${issue.title}`.slice(0, 72),
    body: [
      `Implements ${issue.identifier}.`,
      "",
      "```",
      diffStat,
      "```",
    ].join("\n"),
  };
}
// The issue URL is deliberately absent above: runJob appends it once as a footer
// to every PR body, and including it here too duplicated it on the fallback path.

/**
 * Reports a terminal failure. Best-effort: if the cause was itself a Linear API
 * problem then none of these calls can succeed, so the console stays the
 * guaranteed record.
 */
async function reportFailure(
  issueId: string,
  tag: string,
  armed: boolean,
  labels: ResolvedLabels,
  body: string,
): Promise<void> {
  console.error(`[${tag}] failed: ${body.split("\n")[0]}`);
  if (armed) {
    updateRecord(issueId, { status: "failed", error: body.split("\n")[0], finishedAt: new Date().toISOString() });
    await removeLabel(issueId, labels.running).catch(() => {});
    await addLabel(issueId, labels.failed).catch(() => {});
  }
  await comment(issueId, body).catch((error) => {
    console.error(`[${tag}] could not post the failure comment either: ${shortError(error)}`);
    console.error(`[${tag}] if this says "Invalid scope", the LINEAR_API_KEY is read-only and needs Write`);
  });
}

export async function runJob(issueId: string, labels: ResolvedLabels, signal: AbortSignal): Promise<void> {
  let tag = issueId.slice(0, 8);
  let armed = false;
  let worktree: string | undefined;
  let keepWorktree = false;

  try {
    const issue = await getIssue(issueId);
    tag = issue.identifier;
    const log = (message: string) => console.log(`[${tag}] ${message}`);
    const branch = issue.branchName;

    // The webhook only said something changed. This is the authoritative check.
    if (!issue.labels.nodes.some((label) => label.id === labels.trigger)) {
      log(`no "${config.labels.trigger}" label on the authoritative read, ignoring`);
      return;
    }

    // Gate 2: a previous run recorded as still going should not be run over.
    const previous = getRecord(issueId);
    if (previous?.status === "running") {
      log(`a previous run is still recorded as running (started ${previous.startedAt}), ignoring`);
      await comment(
        issueId,
        `A previous run is still recorded as in progress (started ${previous.startedAt}). If it died, clear its entry from \`state.json\` and re-add the \`${config.labels.trigger}\` label.`,
      );
      return;
    }

    await git.fetchBase(signal);

    // Gates 3 and 4 query reality rather than memory, so they survive a restart.
    const existingPr = await git.openPrFor(branch, signal);
    if (existingPr) {
      log(`a PR already exists for ${branch}: ${existingPr.url}`);
      await removeLabel(issueId, labels.trigger);
      await comment(
        issueId,
        `A pull request already exists for \`${branch}\`: ${existingPr.url} (${existingPr.state.toLowerCase()}).\n\nClose it and delete the branch if you want a fresh run.`,
      );
      return;
    }
    if (await git.remoteBranchExists(branch, signal)) {
      log(`branch ${branch} already exists upstream`);
      await removeLabel(issueId, labels.trigger);
      await addLabel(issueId, labels.failed);
      await comment(
        issueId,
        `Branch \`${branch}\` already exists upstream with no pull request. Delete or rename it, then re-add the \`${config.labels.trigger}\` label.`,
      );
      return;
    }

    // Self-disarm before any real work, so re-adding the label is always a
    // deliberate re-trigger.
    await removeLabel(issueId, labels.trigger);
    await addLabel(issueId, labels.running);
    armed = true;
    putRecord({
      issueId,
      identifier: issue.identifier,
      status: "running",
      branch,
      startedAt: new Date().toISOString(),
    });
    log(`picked up: "${issue.title}" -> ${branch}`);

    worktree = git.worktreePathFor(issue.identifier);
    await git.createWorktree(branch, worktree, signal);
    await git.cloneNodeModules(worktree, signal);
    log(`worktree ready at ${worktree}`);

    let attempt: ClaudeResult = await implement(worktree, issue, signal);
    if (!attempt.ok) {
      keepWorktree = true;
      const detail = attempt.sessionId ? `\n\nSession: \`${attempt.sessionId}\` (resume with \`claude --resume\`)` : "";
      throw new Error(`The implementation run failed: ${attempt.failureReason}.${detail}`);
    }
    log(`implementation done (cost $${attempt.costUsd.toFixed(2)})`);

    let checks = await verify(worktree, signal);
    if (!checks.ok && attempt.sessionId) {
      log(`${checks.stage} failed, attempting one repair`);
      await comment(issueId, `\`${checks.stage}\` failed. Attempting one repair pass.`).catch(() => {});
      const repaired = await repair(worktree, issue, attempt.sessionId, checks.stage, checks.output, signal);
      if (repaired.ok) {
        attempt = { ...repaired, costUsd: attempt.costUsd + repaired.costUsd };
        checks = await verify(worktree, signal);
      }
    }
    if (!checks.ok) {
      keepWorktree = true;
      throw new Error(
        `\`${checks.stage}\` still fails after a repair attempt, so no pull request was opened.\n\n${fence(checks.output)}\n\nThe worktree was kept at \`${worktree}\` for debugging.`,
      );
    }
    log("build, typecheck and lint all pass");

    await git.stageAll(worktree, signal);
    const changed = await git.stagedFiles(worktree, signal);

    if (changed.length === 0) {
      await comment(
        issueId,
        `No file changes were produced, so there is nothing to open a pull request for. The agent reported:\n\n${fence(attempt.summary || "(no summary)")}\n\nThe issue may need more detail.`,
      );
      updateRecord(issueId, { status: "failed", error: "no diff produced", finishedAt: new Date().toISOString() });
      await removeLabel(issueId, labels.running);
      await addLabel(issueId, labels.failed);
      log("no diff produced");
      return;
    }

    const forbidden = changed.filter((file) => FORBIDDEN_FILES.includes(file));
    if (forbidden.length > 0) {
      keepWorktree = true;
      throw new Error(
        `The agent modified ${forbidden.map((f) => `\`${f}\``).join(" and ")}, which is not allowed, so no pull request was opened.\n\nChanged files:\n${fence(changed.join("\n"))}`,
      );
    }

    // Both of these must be read BEFORE the commit: committing empties the index,
    // so `git diff --cached` afterwards returns nothing at all.
    const diffStat = await git.stagedDiffStat(worktree, signal);
    const diff = await git.stagedDiff(worktree, undefined, signal);

    await git.commit(worktree, `${issue.identifier}: ${issue.title}`.slice(0, 72), signal);
    await git.push(worktree, branch, signal);
    log(`pushed ${branch}`);

    const described = await describePr(worktree, issue, diff, attempt.summary, signal).catch(() => null);
    const description = described ?? fallbackDescription(issue, diffStat);
    // The issue URL in the body is what makes Linear link the PR back to the issue.
    const body = `${description.body}\n\n---\n${issue.url}`;

    const prUrl = await git.createPr(
      { dir: worktree, branch, title: description.title, body, draft: true },
      signal,
    );
    log(`opened ${prUrl}`);

    updateRecord(issueId, { status: "succeeded", prUrl, finishedAt: new Date().toISOString() });
    await comment(
      issueId,
      [
        `Opened a draft pull request: ${prUrl}`,
        "",
        `- Branch: \`${branch}\``,
        `- Files changed: ${changed.length}`,
        `- Cost: $${attempt.costUsd.toFixed(2)}${described ? "" : " (PR description generated deterministically)"}`,
        `- \`yarn build\`, \`yarn tsc --noEmit\` and \`yarn lint\` all passed`,
        // Surfaced rather than fatal: worth knowing the allowlist is pinching, but
        // the verification above is what decides whether the change is good.
        ...(attempt.denials.length > 0
          ? [`- ${attempt.denials.length} command(s) were denied by the tool allowlist: ${attempt.denials.slice(0, 6).map((d) => `\`${d}\``).join(", ")}`]
          : []),
        "",
        "```",
        diffStat,
        "```",
      ].join("\n"),
    );
    await removeLabel(issueId, labels.running);
  } catch (error) {
    await reportFailure(issueId, tag, armed, labels, shortError(error));
  } finally {
    if (worktree && !keepWorktree) {
      await git.removeWorktree(worktree).catch((error) => {
        console.error(`[${tag}] could not remove the worktree at ${worktree}: ${shortError(error)}`);
      });
    } else if (worktree) {
      console.error(`[${tag}] worktree kept for debugging: ${worktree}`);
    }
  }
}
