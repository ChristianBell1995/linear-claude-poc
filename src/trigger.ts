/**
 * Decides whether a webhook delivery is worth acting on.
 *
 * This reads the smallest possible slice of Linear's payload: type, action,
 * issue id and actor. Everything else is re-read from the API by the runner, so
 * the service does not depend on the partly undocumented payload shape.
 */
import { config } from "./config.ts";
import type { ResolvedLabels } from "./linear.ts";

export interface WebhookPayload {
  type?: unknown;
  action?: unknown;
  data?: { id?: unknown };
  actor?: { id?: unknown; name?: unknown };
  updatedFrom?: Record<string, unknown> | null;
  webhookTimestamp?: unknown;
  webhookId?: unknown;
}

export type Nudge = { issueId: string } | { skip: string };

export function parseNudge(payload: WebhookPayload, labels: ResolvedLabels): Nudge {
  if (payload.type !== "Issue") return { skip: `type is ${String(payload.type)}, not Issue` };
  if (payload.action !== "create" && payload.action !== "update") {
    return { skip: `action is ${String(payload.action)}` };
  }

  const issueId = payload.data?.id;
  if (typeof issueId !== "string" || issueId.length === 0) return { skip: "no data.id" };

  // Only label additions by the configured user arm a job. This is the strongest
  // available control against a hostile issue body reaching the agent.
  if (payload.actor?.id !== config.linear.actorId) {
    return { skip: `actor ${String(payload.actor?.name ?? payload.actor?.id)} is not the configured operator` };
  }

  const updatedFrom = payload.updatedFrom;
  if (payload.action === "update" && updatedFrom && typeof updatedFrom === "object") {
    // Key presence, not truthiness: Linear sends null for previously-unset fields
    // and an empty array is truthy, so a truthiness test is wrong for arrays.
    if (!("labelIds" in updatedFrom)) return { skip: "labels did not change in this update" };
    const before = updatedFrom.labelIds;
    if (Array.isArray(before) && before.includes(labels.trigger)) {
      return { skip: "trigger label was already present before this update" };
    }
  }

  return { issueId };
}
