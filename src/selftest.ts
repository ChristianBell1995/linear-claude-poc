/**
 * Offline checks for the security-critical logic: signature verification,
 * timestamp freshness, trigger parsing, and the serial queue.
 *
 * Needs no Linear account and no network. Uses dummy env vars of its own, so it
 * must be run WITHOUT --env-file to avoid depending on real credentials.
 *
 *   node --experimental-strip-types src/selftest.ts
 */
import { createHmac } from "node:crypto";

const SECRET = "test-secret";
const ACTOR = "11111111-1111-1111-1111-111111111111";
const TRIGGER_LABEL = "22222222-2222-2222-2222-222222222222";

process.env.LINEAR_API_KEY ??= "lin_api_dummy";
process.env.LINEAR_WEBHOOK_SECRET ??= SECRET;
process.env.LINEAR_ACTOR_ID ??= ACTOR;

const { verifySignature, isFresh } = await import("./verify.ts");
const { parseNudge } = await import("./trigger.ts");
const { enqueue } = await import("./jobs.ts");

let failures = 0;
function check(name: string, actual: unknown, expected: unknown): void {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  if (!pass) failures++;
  console.log(`${pass ? "  ok  " : " FAIL "} ${name}${pass ? "" : `\n         expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`}`);
}

console.log("\nsignature verification");
const body = Buffer.from(JSON.stringify({ hello: "world" }));
const goodSig = createHmac("sha256", SECRET).update(body).digest("hex");
check("accepts a correct signature", verifySignature(body, goodSig, SECRET), true);
check("rejects a wrong secret", verifySignature(body, goodSig, "other-secret"), false);
check("rejects a tampered body", verifySignature(Buffer.from("tampered"), goodSig, SECRET), false);
check("rejects a missing header", verifySignature(body, undefined, SECRET), false);
check("rejects an empty header", verifySignature(body, "", SECRET), false);
check("rejects non-hex without throwing", verifySignature(body, "not-hex-at-all", SECRET), false);
check("rejects a truncated signature", verifySignature(body, goodSig.slice(0, 32), SECRET), false);
check("rejects an over-long signature", verifySignature(body, `${goodSig}00`, SECRET), false);
check("rejects an array header", verifySignature(body, ["a", "b"], SECRET), false);

console.log("\ntimestamp freshness");
check("accepts now", isFresh(Date.now()), true);
check("accepts 30s old", isFresh(Date.now() - 30_000), true);
check("rejects 5min old", isFresh(Date.now() - 300_000), false);
check("rejects 5min in the future", isFresh(Date.now() + 300_000), false);
check("rejects a string", isFresh(String(Date.now())), false);
check("rejects undefined", isFresh(undefined), false);
check("rejects NaN", isFresh(Number.NaN), false);

console.log("\ntrigger parsing");
const labels = { trigger: TRIGGER_LABEL, running: "r", failed: "f" };
const base = {
  type: "Issue",
  action: "update",
  actor: { id: ACTOR, name: "Operator" },
  data: { id: "issue-uuid" },
  updatedFrom: { labelIds: [] as string[] },
};
const nudge = (overrides: Record<string, unknown>) => parseNudge({ ...base, ...overrides }, labels);

check("accepts a label being added", nudge({}), { issueId: "issue-uuid" });
check("accepts create with no updatedFrom", nudge({ action: "create", updatedFrom: undefined }), { issueId: "issue-uuid" });
check(
  "skips a non-Issue type",
  "skip" in nudge({ type: "Comment" }),
  true,
);
check("skips a remove action", "skip" in nudge({ action: "remove" }), true);
check("skips a missing data.id", "skip" in nudge({ data: {} }), true);
check("skips a different actor", "skip" in nudge({ actor: { id: "someone-else", name: "Someone" } }), true);
check("skips when labels did not change", "skip" in nudge({ updatedFrom: { title: "old" } }), true);
check(
  "skips when the trigger label was already present",
  "skip" in nudge({ updatedFrom: { labelIds: [TRIGGER_LABEL, "other"] } }),
  true,
);
check(
  "accepts when other labels were present but not the trigger",
  nudge({ updatedFrom: { labelIds: ["other"] } }),
  { issueId: "issue-uuid" },
);
// Linear sends null for previously-unset fields. Key presence must win over truthiness.
check("accepts a null previous labelIds", nudge({ updatedFrom: { labelIds: null } }), { issueId: "issue-uuid" });
// A malformed updatedFrom must fall through to the authoritative read, not skip.
check("falls through on a malformed updatedFrom", nudge({ updatedFrom: { labelIds: "nonsense" } }), {
  issueId: "issue-uuid",
});

console.log("\nqueue serialisation and the in-flight gate");
const order: string[] = [];
const slow = (tag: string) => async () => {
  order.push(`${tag}:start`);
  await new Promise((r) => setTimeout(r, 40));
  order.push(`${tag}:end`);
};
check("first enqueue accepted", enqueue("issue-a", slow("a")), { accepted: true });
check("same issue rejected while in flight", enqueue("issue-a", slow("a2")), {
  accepted: false,
  reason: "in-flight",
});
check("a different issue is accepted", enqueue("issue-b", slow("b")), { accepted: true });
await new Promise((r) => setTimeout(r, 250));
check("jobs ran serially, never interleaved", order, ["a:start", "a:end", "b:start", "b:end"]);
check("the same issue is accepted again once finished", enqueue("issue-a", slow("a3")), { accepted: true });
await new Promise((r) => setTimeout(r, 150));

console.log(failures === 0 ? "\nAll checks passed.\n" : `\n${failures} check(s) FAILED.\n`);
process.exit(failures === 0 ? 0 : 1);
