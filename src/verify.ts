/**
 * Linear webhook authentication.
 *
 * The cloudflared tunnel URL is world-reachable and unauthenticated at the
 * transport layer, so this HMAC check is the only thing between the internet and
 * the job queue. It runs on the raw request bytes before any JSON parsing.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Hex HMAC-SHA256 of the raw body against the webhook signing secret.
 *
 * Length is compared before timingSafeEqual because that function throws on a
 * length mismatch, which would otherwise turn a malformed signature header into
 * a 500 instead of a 401. Buffer.from(x, "hex") also truncates silently on
 * non-hex input rather than throwing, so the length check catches that too.
 */
export function verifySignature(
  rawBody: Buffer,
  header: string | string[] | undefined,
  secret: string,
): boolean {
  if (typeof header !== "string" || header.length === 0) return false;
  try {
    const provided = Buffer.from(header, "hex");
    const expected = createHmac("sha256", secret).update(rawBody).digest();
    if (provided.length !== expected.length) return false;
    return timingSafeEqual(provided, expected);
  } catch {
    return false;
  }
}

/** Rejects replayed deliveries. `webhookTimestamp` is a UNIX time in milliseconds. */
export function isFresh(webhookTimestamp: unknown, toleranceMs = 60_000): boolean {
  if (typeof webhookTimestamp !== "number" || !Number.isFinite(webhookTimestamp)) return false;
  return Math.abs(Date.now() - webhookTimestamp) <= toleranceMs;
}
