/**
 * Linear GraphQL client.
 *
 * Deliberately thin: one request helper plus the handful of operations the runner
 * needs. Personal API keys go in the Authorization header raw, with no "Bearer "
 * prefix, which is the usual cause of a first-attempt 401.
 */
import { config } from "./config.ts";

const ENDPOINT = "https://api.linear.app/graphql";
const TIMEOUT_MS = 15_000;

export interface LinearLabel {
  id: string;
  name: string;
}

export interface LinearComment {
  body: string;
  createdAt: string;
  user: { name: string } | null;
}

export interface LinearIssue {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  /** Linear's own branch name, e.g. "christianbell/eng-12-add-about-page". Using it guarantees PR auto-linking. */
  branchName: string;
  url: string;
  labels: { nodes: LinearLabel[] };
  comments: { nodes: LinearComment[] };
  team: { id: string; key: string };
}

/**
 * GraphQL returns HTTP 200 with an `errors` array for most failures, so checking
 * res.ok alone silently swallows them.
 */
async function gql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: config.linear.apiKey,
    },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Linear HTTP ${res.status} ${res.statusText}: ${text.slice(0, 500)}`);
  }

  const payload = JSON.parse(text) as { data?: T; errors?: Array<{ message: string }> };
  if (payload.errors?.length) {
    throw new Error(`Linear GraphQL error: ${payload.errors.map((e) => e.message).join("; ")}`);
  }
  if (!payload.data) throw new Error("Linear returned no data");
  return payload.data;
}

export interface ResolvedLabels {
  trigger: string;
  running: string;
  failed: string;
}

/**
 * Maps the three configured label names to UUIDs. Called once at startup, never
 * per request, so it cannot eat into the 5 second webhook ack budget.
 *
 * Webhook payloads carry `labelIds` as UUIDs; there is no dependable array of
 * label names, so matching by name at request time is not an option.
 */
export async function resolveLabels(): Promise<ResolvedLabels> {
  const data = await gql<{ issueLabels: { nodes: Array<LinearLabel & { team: { key: string } | null }> } }>(
    `query Labels { issueLabels(first: 250) { nodes { id name team { key } } } }`,
  );

  const find = (name: string): string => {
    const matches = data.issueLabels.nodes.filter((label) => label.name === name);
    if (matches.length === 0) {
      const available = data.issueLabels.nodes.map((l) => l.name).join(", ");
      throw new Error(`No Linear label named "${name}". Create it first. Existing labels: ${available}`);
    }
    if (matches.length > 1) {
      const teams = matches.map((m) => m.team?.key ?? "workspace").join(", ");
      console.warn(`[linear] label "${name}" exists in multiple teams (${teams}); using the first`);
    }
    return matches[0]!.id;
  };

  return {
    trigger: find(config.labels.trigger),
    running: find(config.labels.running),
    failed: find(config.labels.failed),
  };
}

/** Authoritative read of the issue. The webhook payload is only ever a nudge to call this. */
export async function getIssue(id: string): Promise<LinearIssue> {
  const data = await gql<{ issue: LinearIssue | null }>(
    `query Issue($id: String!) {
      issue(id: $id) {
        id identifier title description branchName url
        labels { nodes { id name } }
        comments(first: 50) { nodes { body createdAt user { name } } }
        team { id key }
      }
    }`,
    { id },
  );
  if (!data.issue) throw new Error(`Linear issue ${id} not found`);
  return data.issue;
}

export async function comment(issueId: string, body: string): Promise<void> {
  await gql(
    `mutation Comment($issueId: String!, $body: String!) {
      commentCreate(input: { issueId: $issueId, body: $body }) { success }
    }`,
    { issueId, body },
  );
}

/*
 * issueAddLabel / issueRemoveLabel rather than issueUpdate(labelIds:), which is a
 * full replace and would clobber a concurrent human label edit.
 */
export async function addLabel(issueId: string, labelId: string): Promise<void> {
  await gql(
    `mutation AddLabel($id: String!, $labelId: String!) {
      issueAddLabel(id: $id, labelId: $labelId) { success }
    }`,
    { id: issueId, labelId },
  );
}

export async function removeLabel(issueId: string, labelId: string): Promise<void> {
  await gql(
    `mutation RemoveLabel($id: String!, $labelId: String!) {
      issueRemoveLabel(id: $id, labelId: $labelId) { success }
    }`,
    { id: issueId, labelId },
  );
}
