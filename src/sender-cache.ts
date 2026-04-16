/**
 * Sender Cache — bridges hook data between inbound_claim and downstream hooks.
 *
 * OpenClaw hook return values do NOT propagate between hooks.
 * inbound_claim has senderId; before_agent_start, reply_dispatch, agent_end don't.
 * This cache stores senderId + tier keyed by sessionKey so downstream hooks can look it up.
 */

const cache = new Map<string, { senderId: string; tier: string; timestamp: number }>();

export function setSenderForSession(sessionKey: string, senderId: string, tier: string): void {
  // Prune stale entries older than 5 minutes
  const cutoff = Date.now() - 5 * 60 * 1000;
  for (const [key, entry] of cache) {
    if (entry.timestamp < cutoff) cache.delete(key);
  }
  cache.set(sessionKey, { senderId, tier, timestamp: Date.now() });
}

export function getSenderForSession(sessionKey: string): { senderId: string; tier: string } | undefined {
  return cache.get(sessionKey);
}

/**
 * Get the most recently cached sender across ALL sessions.
 * Used by the memory prompt supplement builder which doesn't receive sender info.
 */
export function getLastSender(): { senderId: string; tier: string } | undefined {
  let latest: { senderId: string; tier: string; timestamp: number } | undefined;
  for (const entry of cache.values()) {
    if (!latest || entry.timestamp > latest.timestamp) {
      latest = entry;
    }
  }
  return latest ? { senderId: latest.senderId, tier: latest.tier } : undefined;
}
