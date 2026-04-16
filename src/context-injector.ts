/**
 * Context Injector — registerMemoryPromptSupplement callback.
 *
 * Fires on every turn during system-prompt assembly. Reads per-interlocutor
 * recent.md based on the most-recently cached sender and injects it as a
 * system-prompt supplement.
 *
 * Note: workspace plugins register `before_prompt_build` / `before_agent_start`
 * but those hooks don't actually fire. The memory-supplement API is the
 * working mechanism for per-turn context injection.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

interface MemorySupplementOpts {
  memoryPath: string;
  identityPath: string;
  recallBudgetTokens: number;
  logger: { info: Function; warn: Function; error: Function };
}

/**
 * Creates a memory prompt supplement builder for registerMemoryPromptSupplement.
 * Fires on every turn. Reads per-interlocutor recent.md based on the most
 * recently cached sender from inbound_claim.
 *
 * The callback receives { availableTools, citationsMode } — no sender info.
 * We use the sender cache (populated by inbound_claim) to know whose memory to load.
 * For guild channels with multiple users, we load the MOST RECENT sender's context
 * (the one who just sent the message that triggered this turn).
 */
export function createMemorySupplementBuilder(opts: MemorySupplementOpts) {
  return (params: { availableTools?: Set<string>; citationsMode?: string }) => {
    try {
      // Find the most recently cached sender across all sessions
      // The sender cache is populated by inbound_claim on every inbound message
      const { getLastSender } = require("./sender-cache.js");
      const lastSender = getLastSender();

      if (!lastSender) {
        return []; // No sender cached yet — first turn after restart
      }

      const { senderId: snowflake, tier } = lastSender;

      if (!snowflake || snowflake === "unknown") {
        return [];
      }

      // Read per-interlocutor memory
      const recentPath = join(opts.memoryPath, snowflake, "recent.md");
      let recentContent: string;
      try {
        recentContent = readFileSync(recentPath, "utf-8");
      } catch {
        return []; // No memory file = first interaction. Normal.
      }

      if (!recentContent.trim()) return [];

      // Budget-cap
      const estimatedTokens = Math.ceil(recentContent.length / 4);
      let content = recentContent;
      if (estimatedTokens > opts.recallBudgetTokens) {
        const targetChars = opts.recallBudgetTokens * 4;
        content = recentContent.slice(-targetChars);
      }

      opts.logger.info(
        `[trust-gate:memory-supplement] Injecting memory for ${snowflake} (${tier}), ~${Math.ceil(content.length / 4)} tokens`
      );

      return [
        "",
        "## Per-Interlocutor Context (auto-recalled)",
        `Interlocutor: ${snowflake} (${tier})`,
        "",
        content,
        "",
      ];
    } catch (err: any) {
      opts.logger.error(
        `[trust-gate:memory-supplement] Failed to build supplement: ${err?.message ?? err}`
      );
      return [];
    }
  };
}

