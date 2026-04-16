/**
 * Gate Evaluator — reply_dispatch hook
 *
 * The Gate itself. Intercepts finalized replies and performs an inline
 * Haiku LLM call to evaluate against gate/rules.md. Uses AbortController
 * with configurable timeout (default 10s) since the hook runner has no
 * per-hook timeout enforcement.
 *
 * On API failure: non-principal gets static template, principal passes
 * through self-filtered.
 */

import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

interface GateEvaluatorOpts {
  gateStateManager: any; // The registered service
  gateTimeoutMs: number;
  gateModel: string;
  logger: { info: Function; warn: Function; error: Function };
  pluginApi: any; // OpenClaw plugin API — provides runtime.agent.runEmbeddedPiAgent
  workspaceDir: string;
  identityPath: string; // For direct tier lookup since inbound_claim data doesn't propagate
}

type Verdict = "approve" | "revise" | "reject";

interface GateResult {
  verdict: Verdict;
  revisedText?: string;
  reason?: string;
}

function parseGateResponse(response: string): GateResult {
  const trimmed = response.trim();

  // Scan each line — handles preamble before the verdict keyword
  for (const line of trimmed.split("\n")) {
    const l = line.trim();
    if (l.startsWith("APPROVE")) return { verdict: "approve" };
    if (l.startsWith("REVISE:")) return { verdict: "revise", revisedText: l.slice("REVISE:".length).trim() };
    if (l.startsWith("REJECT:")) return { verdict: "reject", reason: l.slice("REJECT:".length).trim() };
  }

  // Ambiguous response — treat as rejection (conservative)
  return { verdict: "reject", reason: "Ambiguous Gate response" };
}

// Senders that are always treated as principal (local/trusted channels)
const TRUSTED_SENDERS = new Set([
  "openclaw-control-ui",  // OpenClaw webchat UI — local, authenticated
  "webchat",
]);

// Direct tier lookup — inbound_claim data doesn't propagate to reply_dispatch
function lookupTier(senderId: string | undefined, identityPath: string): { tier: string; snowflake: string } {
  if (!senderId) return { tier: "interloper", snowflake: "unknown" };

  // Trusted local senders bypass snowflake lookup
  if (TRUSTED_SENDERS.has(senderId)) {
    return { tier: "principal", snowflake: senderId };
  }

  try {
    const principalPath = join(identityPath, "principal.snapshot.json");
    const principal = JSON.parse(readFileSync(principalPath, "utf-8"));
    if (senderId === principal.principal_discord_id || principal.alt_ids?.includes(senderId)) {
      return { tier: "principal", snowflake: senderId };
    }
  } catch {}

  try {
    const friendsPath = join(identityPath, "friends.snapshot.json");
    const friends = JSON.parse(readFileSync(friendsPath, "utf-8"));
    for (const f of friends.friends ?? []) {
      if (f.discord_id === senderId && f.status === "active") {
        return { tier: "friend", snowflake: senderId };
      }
    }
  } catch {}

  return { tier: "interloper", snowflake: senderId };
}

export function createGateEvaluator(opts: GateEvaluatorOpts) {
  // Per-snowflake rejection tracking. Two interlopers in parallel must not
  // trip each other's counter. Entries evict after 10 minutes of inactivity
  // so the map can't grow unbounded under sustained interloper traffic.
  const rejectionCounts = new Map<string, { count: number; ts: number }>();
  const REJECTION_TTL_MS = 10 * 60 * 1000;

  function resetRejections(snowflake: string): void {
    rejectionCounts.delete(snowflake);
  }

  function bumpRejections(snowflake: string): number {
    const now = Date.now();
    for (const [key, entry] of rejectionCounts) {
      if (now - entry.ts > REJECTION_TTL_MS) rejectionCounts.delete(key);
    }
    const next = (rejectionCounts.get(snowflake)?.count ?? 0) + 1;
    rejectionCounts.set(snowflake, { count: next, ts: now });
    return next;
  }

  return async (event: any, context: any) => {
    try {
      // Extract the draft reply text
      const draft: string = event?.ctx?.replyText ?? event?.ctx?.text ?? "";
      const originalMessage: string = event?.ctx?.originalMessage ?? event?.ctx?.userMessage ?? "";

      // Direct tier lookup from SenderId — inbound_claim results don't propagate to later hooks
      const senderId: string | undefined = event?.ctx?.SenderId ?? event?.ctx?.senderId ?? event?.ctx?.userId;
      const { tier, snowflake } = lookupTier(senderId, opts.identityPath);

      opts.logger.info(`[trust-gate:gate] Evaluating draft for tier=${tier} snowflake=${snowflake}`);

      // Skip Gate for principal — self-filtered pass-through
      if (tier === "principal") {
        resetRejections(snowflake);
        return {}; // let the default dispatch handle it
      }

      // Pre-check: exact-string allowlist
      if (draft && opts.gateStateManager.isPrecheckPass(draft)) {
        opts.gateStateManager.logVerdict({
          verdict: "precheck_pass",
          tier,
          snowflake,
          draftLength: draft.length,
        });
        resetRejections(snowflake);
        return {}; // pass through
      }

      // Load rules
      const rules = opts.gateStateManager.getRules();
      if (!rules) {
        opts.logger.error("[trust-gate:gate] No rules loaded — using static template");
        opts.gateStateManager.recordFailure();
        const template = opts.gateStateManager.getDeflectionTemplate(tier);
        return {
          handled: true,
          reply: { text: template },
          counts: { text: 1 },
        };
      }

      // Build Gate prompt
      const gatePrompt = `${rules}

---

## Current evaluation

**Interlocutor tier:** ${tier}
**Interlocutor snowflake:** ${snowflake}
**Original user message:** ${originalMessage}

**Draft reply to evaluate:**
${draft}

**Your verdict (APPROVE / REVISE: <text> / REJECT: <reason>):**`;

      // Inline Haiku LLM call via OpenClaw's embedded agent runtime.
      // Uses api.runtime.agent.runEmbeddedPiAgent() — handles auth,
      // provider routing, model selection internally. No raw SDK import needed.
      //
      // Self-managed timeout via AbortController (10s default) since
      // the hook runner has no per-hook timeout enforcement.

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), opts.gateTimeoutMs);

      try {
        const runId = `gate-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

        const agentResult = await opts.pluginApi.runtime?.agent?.runEmbeddedPiAgent?.({
          sessionId: `gate-eval-${runId}`,
          sessionKey: `trust-gate:gate-eval`,
          agentId: "main",
          sessionFile: `/tmp/trust-gate-${runId}.jsonl`,
          workspaceDir: opts.workspaceDir,
          prompt: gatePrompt,
          provider: "anthropic", // Real provider, not CLI backend — claude-cli is only for the main agent loop
          model: opts.gateModel, // e.g., "claude-haiku-4-5"
          timeoutMs: opts.gateTimeoutMs,
          runId,
          toolsAllow: [], // Gate has no tools — pure evaluation
          disableMessageTool: true,
          bootstrapContextMode: "lightweight",
          silentExpected: true,
          reasoningLevel: "off",
        });

        // Extract response text from embedded agent result
        const responseText = agentResult?.payloads
          ?.map((p: any) => p.text?.trim())
          .filter(Boolean)
          .join("\n") ?? "";

        const result = responseText
          ? parseGateResponse(responseText)
          : { verdict: "reject" as Verdict, reason: "Empty Gate response" };

        clearTimeout(timeout);
        opts.gateStateManager.recordSuccess();

        if (result.verdict === "approve") {
          resetRejections(snowflake);
          opts.gateStateManager.logVerdict({
            verdict: "approve",
            tier,
            snowflake,
            draftLength: draft.length,
          });
          return {}; // pass through
        }

        if (result.verdict === "revise") {
          resetRejections(snowflake);
          opts.gateStateManager.logVerdict({
            verdict: "revise",
            tier,
            snowflake,
            draftLength: draft.length,
          });
          return {
            handled: true,
            reply: { text: result.revisedText ?? draft },
            counts: { text: 1 },
          };
        }

        // REJECT — count per-snowflake, not globally
        const rejections = bumpRejections(snowflake);

        if (rejections >= 2) {
          // Forced revise on 2nd rejection — Gate produces its own text
          opts.logger.warn(
            `[trust-gate:gate] 2nd rejection for ${snowflake} — forced revise`
          );
          const template = opts.gateStateManager.getDeflectionTemplate(tier);
          resetRejections(snowflake);
          opts.gateStateManager.logVerdict({
            verdict: "forced_revise",
            tier,
            snowflake,
            reason: result.reason,
          });
          return {
            handled: true,
            reply: { text: template },
            counts: { text: 1 },
          };
        }

        opts.gateStateManager.logVerdict({
          verdict: "reject",
          tier,
          snowflake,
          reason: result.reason,
        });

        // First rejection — use deflection
        const template = opts.gateStateManager.getDeflectionTemplate(tier);
        return {
          handled: true,
          reply: { text: template },
          counts: { text: 1 },
        };
      } catch (apiErr: any) {
        clearTimeout(timeout);

        if (apiErr?.name === "AbortError") {
          opts.logger.error("[trust-gate:gate] Haiku API call timed out");
        } else {
          opts.logger.error(
            `[trust-gate:gate] Haiku API call failed: ${apiErr?.message ?? apiErr}`
          );
        }

        opts.gateStateManager.recordFailure();

        // API failure: static template for non-principal
        const template = opts.gateStateManager.getDeflectionTemplate(tier);
        opts.gateStateManager.logVerdict({
          verdict: "api_failure",
          tier,
          snowflake,
          error: apiErr?.message ?? "unknown",
        });

        return {
          handled: true,
          reply: { text: template },
          counts: { text: 1 },
        };
      }
    } catch (err: any) {
      // Outer catch-all — should never reach here but be safe
      opts.logger.error(
        `[trust-gate:gate] Unexpected error: ${err?.message ?? err}`
      );
      opts.gateStateManager.recordFailure();
      const template = opts.gateStateManager.getDeflectionTemplate("interloper");
      return {
        handled: true,
        reply: { text: template },
        counts: { text: 1 },
      };
    }
  };
}
