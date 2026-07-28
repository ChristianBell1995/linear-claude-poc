/**
 * Serial job queue and durable job state.
 *
 * Concurrency is 1 on purpose: two jobs racing on the same repo would fight over
 * git refs and there is no reason a proof of concept needs throughput. The state
 * file is what stops a duplicate PR after a service restart, since an in-memory
 * set alone dies with the process.
 */
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { config } from "./config.ts";

const MAX_QUEUE_LENGTH = 10;
const JOB_WALL_MS = 30 * 60 * 1000;

export type JobStatus = "running" | "succeeded" | "failed";

export interface JobRecord {
  issueId: string;
  identifier: string;
  status: JobStatus;
  branch?: string;
  prUrl?: string;
  error?: string;
  startedAt: string;
  finishedAt?: string;
}

type StateFile = Record<string, JobRecord>;

function loadState(): StateFile {
  try {
    return JSON.parse(readFileSync(config.paths.state, "utf8")) as StateFile;
  } catch {
    return {};
  }
}

let state: StateFile = loadState();

/** Temp file plus rename, so a crash mid-write cannot leave a truncated state file. */
function persist(): void {
  const temp = `${config.paths.state}.tmp`;
  writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  renameSync(temp, config.paths.state);
}

export function getRecord(issueId: string): JobRecord | undefined {
  return state[issueId];
}

export function putRecord(record: JobRecord): void {
  state[record.issueId] = record;
  persist();
}

export function updateRecord(id: string, patch: Partial<JobRecord>): void {
  const existing = state[id];
  if (!existing) return;
  state[id] = { ...existing, ...patch };
  persist();
}

const inFlight = new Set<string>();
const pending: Array<() => Promise<void>> = [];
let draining = false;

export function queueDepth(): number {
  return pending.length;
}

export interface EnqueueResult {
  accepted: boolean;
  reason?: "in-flight" | "queue-full";
}

/**
 * Adds a job to the tail of the queue. The task receives an AbortSignal that
 * fires at the 30 minute wall, which every child process in the chain honours.
 */
export function enqueue(issueId: string, task: (signal: AbortSignal) => Promise<void>): EnqueueResult {
  if (inFlight.has(issueId) || pending.length >= MAX_QUEUE_LENGTH) {
    return { accepted: false, reason: inFlight.has(issueId) ? "in-flight" : "queue-full" };
  }

  inFlight.add(issueId);
  pending.push(async () => {
    const controller = new AbortController();
    const wall = setTimeout(() => controller.abort(), JOB_WALL_MS);
    try {
      await task(controller.signal);
    } catch (error) {
      // The task owns its own reporting; this is the last line of defence so one
      // bad job cannot stop the queue draining.
      console.error(`[jobs] unhandled failure for ${issueId}:`, error);
    } finally {
      clearTimeout(wall);
      inFlight.delete(issueId);
    }
  });

  void drain();
  return { accepted: true };
}

async function drain(): Promise<void> {
  if (draining) return;
  draining = true;
  try {
    while (pending.length > 0) {
      await pending.shift()!();
    }
  } finally {
    draining = false;
  }
}
