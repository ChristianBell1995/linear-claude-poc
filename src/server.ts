/**
 * Webhook receiver.
 *
 * Linear disables a webhook that fails to answer 200 within 5 seconds, so the
 * handler does nothing but authenticate, respond, and enqueue. All real work
 * happens after the response has been written.
 */
import http from "node:http";
import { config } from "./config.ts";
import { pruneStale } from "./git.ts";
import { enqueue, queueDepth } from "./jobs.ts";
import { resolveLabels, type ResolvedLabels } from "./linear.ts";
import { runJob } from "./runner.ts";
import { parseNudge, type WebhookPayload } from "./trigger.ts";
import { isFresh, verifySignature } from "./verify.ts";

const MAX_BODY_BYTES = 1_000_000;

function readRawBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function main(): Promise<void> {
  let labels: ResolvedLabels;
  try {
    labels = await resolveLabels();
  } catch (error) {
    console.error(`[startup] could not resolve labels: ${error instanceof Error ? error.message : error}`);
    process.exit(1);
  }
  console.log(
    `[startup] labels resolved: ${config.labels.trigger}=${labels.trigger.slice(0, 8)}… ` +
      `${config.labels.running}=${labels.running.slice(0, 8)}… ${config.labels.failed}=${labels.failed.slice(0, 8)}…`,
  );

  // Safe to do here and only here: nothing can be in flight at startup.
  const pruned = await pruneStale().catch((error) => {
    console.warn(`[startup] worktree prune skipped: ${error instanceof Error ? error.message : error}`);
    return [] as string[];
  });
  if (pruned.length > 0) console.log(`[startup] removed ${pruned.length} stale worktree(s): ${pruned.join(", ")}`);
  if (config.claude.stub) console.log("[startup] CLAUDE_STUB=1 — no model will run; a placeholder file is written instead");

  const server = http.createServer((req, res) => {
    void handle(req, res, labels).catch((error) => {
      console.error("[server] handler threw:", error);
      if (!res.headersSent) res.writeHead(500).end();
    });
  });

  server.listen(config.port, () => {
    console.log(`[startup] listening on http://localhost:${config.port}`);
    console.log(`[startup] webhook path: POST /webhooks/linear`);
    console.log(`[startup] target repo: ${config.repo.slug} (base ${config.repo.baseBranch})`);
  });
}

async function handle(req: http.IncomingMessage, res: http.ServerResponse, labels: ResolvedLabels): Promise<void> {
  const url = new URL(req.url ?? "/", `http://localhost:${config.port}`);

  if (req.method === "GET" && url.pathname === "/healthz") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, queueDepth: queueDepth() }));
    return;
  }

  if (req.method !== "POST" || url.pathname !== "/webhooks/linear") {
    res.writeHead(404).end();
    return;
  }

  let raw: Buffer;
  try {
    raw = await readRawBody(req);
  } catch {
    res.writeHead(413).end();
    return;
  }

  // Authenticate on the raw bytes before parsing anything.
  if (!verifySignature(raw, req.headers["linear-signature"], config.linear.webhookSecret)) {
    console.warn(`[webhook] rejected: bad signature (${raw.length} bytes)`);
    res.writeHead(401).end();
    return;
  }

  let payload: WebhookPayload;
  try {
    payload = JSON.parse(raw.toString("utf8")) as WebhookPayload;
  } catch {
    res.writeHead(400).end();
    return;
  }

  if (!isFresh(payload.webhookTimestamp)) {
    console.warn(`[webhook] rejected: stale timestamp ${String(payload.webhookTimestamp)}`);
    res.writeHead(401).end();
    return;
  }

  const delivery = req.headers["linear-delivery"] ?? "unknown";
  console.log(
    `[webhook] ${String(payload.type)}/${String(payload.action)} delivery=${String(delivery)} ` +
      `webhookId=${String(payload.webhookId)}`,
  );

  // Answer before doing anything else. Nothing below this line may be awaited
  // inside the request lifecycle.
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ received: true }));

  try {
    const nudge = parseNudge(payload, labels);
    if ("skip" in nudge) {
      console.log(`[webhook] skipped: ${nudge.skip}`);
      return;
    }
    const result = enqueue(nudge.issueId, (signal) => runJob(nudge.issueId, labels, signal));
    console.log(
      result.accepted
        ? `[webhook] enqueued ${nudge.issueId} (depth ${queueDepth()})`
        : `[webhook] not enqueued: ${result.reason}`,
    );
  } catch (error) {
    console.error("[webhook] post-response failure:", error);
  }
}

void main();
