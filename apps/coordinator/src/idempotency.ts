/**
 * Minimal, in-memory webhook-delivery dedup guard.
 *
 * Not previously flagged in any prior phase — introduced here because real
 * JIRA writes mean a redelivered webhook can now produce a duplicate
 * comment/label, not just a wasted (idempotent) Anthropic call.
 *
 * Deliberately NOT durable: this is a per-process Map with no persistence.
 * It does NOT survive a container restart and does NOT work across multiple
 * replicas — durable, cross-restart dedup needs a real store (Cosmos DB per
 * CLAUDE.md's audit-log decision), which is out of scope here (standing up
 * real Cosmos DB is an Azure resource, explicitly excluded from this phase).
 * Note also: CLAUDE.md's "Build phases" list has no phase that explicitly
 * owns wiring up Cosmos DB — see "Decisions made in Phase 4."
 *
 * Dedup key is the webhook's `eventId` when the payload provides one (real
 * JIRA webhooks include an event identifier); falling back to `ticketKey`
 * alone within a short TTL window when it doesn't, since Phase 3's payload
 * schema deliberately didn't model JIRA's real webhook envelope yet. The
 * fallback has a real, accepted limitation: a genuinely new, distinct event
 * for the same ticket arriving within the TTL window would be incorrectly
 * treated as a duplicate and dropped.
 */

const TTL_MS = 2 * 60 * 1000; // 2 minutes

const seen = new Map<string, number>(); // dedupe key -> expiry timestamp (ms)

function sweepExpired(now: number): void {
  for (const [key, expiresAt] of seen) {
    if (expiresAt <= now) {
      seen.delete(key);
    }
  }
}

export function buildDedupeKey(ticketKey: string, eventId?: string): string {
  return eventId ?? ticketKey;
}

/**
 * Returns true if this dedupe key was already seen within the TTL window
 * (i.e. this delivery should be treated as a duplicate and skipped).
 * Otherwise records it and returns false.
 */
export function isDuplicateDelivery(dedupeKey: string): boolean {
  const now = Date.now();
  sweepExpired(now);

  if (seen.has(dedupeKey)) {
    return true;
  }

  seen.set(dedupeKey, now + TTL_MS);
  return false;
}
