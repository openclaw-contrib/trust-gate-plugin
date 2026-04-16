/**
 * Turn Logger — agent_end hook
 *
 * Appends each turn to per-interlocutor turns.ndjson (rolling turn log
 * for lossless recovery) and cost data to cost.ndjson.
 *
 * Follows memory-lancedb agent_end auto-capture pattern.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { getSenderForSession } from "./sender-cache.js";

interface TurnLoggerOpts {
  memoryPath: string;
  workspacePath: string;
  logger: { info: Function; warn: Function; error: Function };
}

export function createTurnLogger(opts: TurnLoggerOpts) {
  return async (event: any, ctx: any) => {
    try {
      // Resolve sender from cache (inbound_claim stashed it)
      const sessionKey = ctx?.sessionKey ?? "";
      const cached = getSenderForSession(sessionKey);
      const snowflake: string = cached?.senderId ?? "unknown";
      const tier: string = cached?.tier ?? "unknown";
      const success: boolean = event?.success ?? true;
      const durationMs: number = event?.durationMs ?? 0;

      if (!snowflake || snowflake === "unknown") return;

      // --- Append to per-interlocutor turns.ndjson ---
      const turnsDir = join(opts.memoryPath, snowflake);
      const turnsPath = join(turnsDir, "turns.ndjson");

      // Ensure directory exists
      try {
        mkdirSync(turnsDir, { recursive: true });
      } catch {
        // Already exists
      }

      // Extract last user message and assistant reply from the event
      const messages: any[] = event?.messages ?? [];
      const lastUser = messages.filter((m: any) => m.role === "user").pop();
      const lastAssistant = messages.filter((m: any) => m.role === "assistant").pop();

      const turnEntry = {
        ts: new Date().toISOString(),
        tier,
        inbound: lastUser?.content ?? "",
        outbound: lastAssistant?.content ?? "",
        gate_verdict: event?.gate_verdict,
        duration_ms: durationMs,
        success,
      };

      const turnLine = JSON.stringify(turnEntry) + "\n";

      // Single write, O_APPEND discipline (≤4KB per spec §6.2)
      if (turnLine.length <= 4096) {
        appendFileSync(turnsPath, turnLine);
      } else {
        // Truncate content to fit — should be rare
        const truncated = {
          ...turnEntry,
          inbound: turnEntry.inbound.slice(0, 500) + "...[truncated]",
          outbound: turnEntry.outbound.slice(0, 500) + "...[truncated]",
        };
        appendFileSync(turnsPath, JSON.stringify(truncated) + "\n");
        opts.logger.warn(
          `[trust-gate:turn-logger] Turn entry for ${snowflake} exceeded 4KB — truncated`
        );
      }

      // --- Append to cost.ndjson ---
      const costPath = join(opts.workspacePath, "state", "cost.ndjson");
      const costEntry = {
        ts: new Date().toISOString(),
        snowflake,
        tier,
        duration_ms: durationMs,
        success,
        tokens_in: event?.usage?.input_tokens,
        tokens_out: event?.usage?.output_tokens,
      };
      const costLine = JSON.stringify(costEntry) + "\n";
      try {
        appendFileSync(costPath, costLine);
      } catch {
        // Best-effort cost logging
      }
    } catch (err: any) {
      // Turn logging is observational — never block on failure
      opts.logger.warn(
        `[trust-gate:turn-logger] Failed to log turn: ${err?.message ?? err}`
      );
    }
  };
}
