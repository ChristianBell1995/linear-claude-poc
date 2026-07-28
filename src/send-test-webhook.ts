/**
 * Sends a correctly signed fake webhook at the local server, so the whole
 * receive path can be tested without Linear or a tunnel.
 *
 *   node --experimental-strip-types --env-file=.env src/send-test-webhook.ts <issue-uuid> [case]
 *
 * Cases: valid (default) | unsigned | badsig | stale | wrongactor | nolabelchange
 */
import { createHmac } from "node:crypto";

const [, , issueId, testCase = "valid"] = process.argv;
if (!issueId) {
  console.error("Usage: send-test-webhook.ts <issue-uuid> [valid|unsigned|badsig|stale|wrongactor|nolabelchange]");
  process.exit(1);
}

const secret = process.env.LINEAR_WEBHOOK_SECRET?.trim();
const actorId = process.env.LINEAR_ACTOR_ID?.trim();
const port = process.env.PORT?.trim() || "3939";
if (!secret || !actorId) {
  console.error("LINEAR_WEBHOOK_SECRET and LINEAR_ACTOR_ID must be set (run with --env-file=.env)");
  process.exit(1);
}

const payload: Record<string, unknown> = {
  type: "Issue",
  action: "update",
  actor: { id: testCase === "wrongactor" ? "00000000-0000-0000-0000-000000000000" : actorId, name: "Test Actor" },
  data: { id: issueId },
  // Previous label set, deliberately not containing the trigger label, so this
  // reads as "the trigger label was just added".
  updatedFrom: testCase === "nolabelchange" ? { title: "old title" } : { labelIds: [] },
  webhookTimestamp: testCase === "stale" ? Date.now() - 5 * 60 * 1000 : Date.now(),
  webhookId: "test-webhook",
  organizationId: "test-org",
};

const body = JSON.stringify(payload);
const headers: Record<string, string> = {
  "content-type": "application/json",
  "linear-delivery": `test-${Date.now().toString(36)}`,
};

if (testCase === "badsig") headers["linear-signature"] = "not-hex-at-all";
else if (testCase !== "unsigned") {
  headers["linear-signature"] = createHmac("sha256", secret).update(body).digest("hex");
}

const started = Date.now();
const res = await fetch(`http://localhost:${port}/webhooks/linear`, { method: "POST", headers, body });
console.log(`case=${testCase} → HTTP ${res.status} in ${Date.now() - started}ms  ${await res.text()}`);
