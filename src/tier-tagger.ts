/**
 * Tier Tagger — inbound_claim hook (fail-closed)
 *
 * Reads Discord snowflake from message metadata, looks up identity
 * snapshot files, stamps interlocutor_kind / interlocutor_id /
 * impersonation_risk onto message context.
 *
 * Fail-safe: unknown snowflake → interloper.
 * Fail-closed: if this hook throws, the gateway blocks the message
 * entirely (configured via failurePolicyByHook).
 */

import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { setSenderForSession } from "./sender-cache.js";

interface TierTaggerOpts {
  identityPath: string;
  logger: { info: Function; warn: Function; error: Function };
}

interface IdentitySnapshot {
  version: number;
  principal_discord_id?: string;
  principal_discord_username_hint?: string;
  alt_ids?: string[];
  friends?: Array<{
    discord_id: string;
    handle_hint: string;
    status: string;
  }>;
}

type InterlocutorKind = "principal" | "friend" | "interloper";

// Cached identity data
let principalCache: IdentitySnapshot | null = null;
let principalVersion = -1;
let friendsCache: IdentitySnapshot | null = null;
let friendsVersion = -1;

function loadSnapshot(filePath: string, currentVersion: number): IdentitySnapshot | null {
  try {
    const stat = statSync(filePath);
    const data = JSON.parse(readFileSync(filePath, "utf-8"));
    if (data.version > currentVersion) {
      return data;
    }
    return null; // no change
  } catch {
    return null;
  }
}

// Basic Unicode confusable check — catches common spoofing
function normalizeForConfusables(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/[\u200B-\u200F\u2028-\u202F\uFEFF]/g, "") // zero-width chars
    .toLowerCase()
    .trim();
}

function checkImpersonationRisk(
  displayName: string | undefined,
  principalHint: string | undefined,
  friendHints: string[]
): boolean {
  if (!displayName) return false;
  const normalized = normalizeForConfusables(displayName);
  if (principalHint && normalizeForConfusables(principalHint) === normalized) return true;
  for (const hint of friendHints) {
    if (normalizeForConfusables(hint) === normalized) return true;
  }
  // Substring check for partial matches
  if (principalHint && normalized.includes(normalizeForConfusables(principalHint))) return true;
  return false;
}

export function createTierTagger(opts: TierTaggerOpts) {
  const principalPath = join(opts.identityPath, "principal.snapshot.json");
  const friendsPath = join(opts.identityPath, "friends.snapshot.json");

  return async (event: any) => {
    const senderId: string | undefined = event?.senderId;

    // If no senderId available (webhook, system event), tag as interloper
    if (!senderId) {
      return {
        interlocutor_kind: "interloper" as InterlocutorKind,
        interlocutor_id: "unknown",
        impersonation_risk: false,
      };
    }

    // Refresh caches if needed
    const newPrincipal = loadSnapshot(principalPath, principalVersion);
    if (newPrincipal) {
      principalCache = newPrincipal;
      principalVersion = newPrincipal.version;
    }

    const newFriends = loadSnapshot(friendsPath, friendsVersion);
    if (newFriends) {
      friendsCache = newFriends;
      friendsVersion = newFriends.version;
    }

    // Determine tier by snowflake
    let kind: InterlocutorKind = "interloper"; // fail-safe default

    if (principalCache) {
      if (
        senderId === principalCache.principal_discord_id ||
        principalCache.alt_ids?.includes(senderId)
      ) {
        kind = "principal";
      }
    }

    if (kind === "interloper" && friendsCache?.friends) {
      for (const friend of friendsCache.friends) {
        if (friend.discord_id === senderId && friend.status === "active") {
          kind = "friend";
          break;
        }
      }
    }

    // Check impersonation risk
    const displayName = event?.senderDisplayName ?? event?.senderName;
    const friendHints = friendsCache?.friends?.map((f) => f.handle_hint) ?? [];
    const impersonationRisk = checkImpersonationRisk(
      displayName,
      principalCache?.principal_discord_username_hint,
      friendHints
    );

    if (impersonationRisk && kind !== "principal") {
      opts.logger.warn(
        `[trust-gate:tier-tagger] Impersonation risk detected: senderId=${senderId} displayName="${displayName}" tagged as ${kind}`
      );
    }

    // Cache sender info for downstream hooks (before_agent_start, reply_dispatch, agent_end)
    // that don't receive senderId in their events.
    const sessionKey = event?.sessionKey ?? event?.conversationId ?? "";
    if (sessionKey && senderId) {
      setSenderForSession(sessionKey, senderId, kind);
    }

    return {
      interlocutor_kind: kind,
      interlocutor_id: senderId,
      impersonation_risk: impersonationRisk,
    };
  };
}
