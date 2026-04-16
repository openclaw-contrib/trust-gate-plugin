/**
 * trust-gate — OpenClaw Trust-Tier Security Plugin
 *
 * Implements the trust-tier pattern via OpenClaw plugin hooks:
 * - Trust-tier tagging (inbound_claim)
 * - Memory recall (registerMemoryPromptSupplement)
 * - Inline Gate evaluation (reply_dispatch)
 * - Safety backstop (message_sending)
 * - Tool gating (before_tool_call)
 * - Turn logging (agent_end)
 *
 * Fail-closed semantics for inbound_claim and message_sending are enforced
 * at the gateway via `failurePolicyByHook` — see README "Gateway config" and
 * SECURITY.md. This plugin does not self-enforce fail-closed policy.
 *
 * Companion reference design:
 * https://github.com/openclaw-contrib/orchestrator-protocol-spec
 */

import { createTierTagger } from "./tier-tagger.js";
import { createGateEvaluator } from "./gate-evaluator.js";
import { createSafetyBackstop } from "./safety-backstop.js";
import { createToolGating } from "./tool-gating.js";
import { createTurnLogger } from "./turn-logger.js";
import { createGateStateManager } from "./gate-state-manager.js";

interface PluginConfig {
  identityPath: string;
  memoryPath: string;
  gatePath: string;
  recallBudgetTokens: number;
  gateTimeoutMs: number;
  gateModel: string;
  layer2Enabled: boolean;
  consecutiveFailureThreshold: number;
}

export default {
  id: "trust-gate",
  name: "Trust Gate",

  register(api: any) {
    const config: PluginConfig = api.pluginConfig ?? {};
    const logger = api.logger;

    // Resolve workspace path from OpenClaw config — NOT api.resolvePath("~/")
    // which resolves to the user's home directory, not the workspace.
    const workspacePath: string | undefined =
      api.config?.agents?.defaults?.workspace ??
      api.config?.workspace ??
      process.env.OPENCLAW_WORKSPACE;

    if (!workspacePath) {
      throw new Error(
        "[trust-gate] No workspace path resolved. Set one of: " +
          "OpenClaw config.agents.defaults.workspace, config.workspace, " +
          "or the OPENCLAW_WORKSPACE environment variable."
      );
    }

    const { join } = require("node:path");
    const identityPath = join(workspacePath, config.identityPath ?? "state/identity");
    const memoryPath = join(workspacePath, config.memoryPath ?? "memory/interlocutors");
    const gatePath = join(workspacePath, config.gatePath ?? "state/gate");

    logger.info(`[trust-gate] Workspace: ${workspacePath}`);
    logger.info(`[trust-gate] Identity: ${identityPath}`);
    logger.info(`[trust-gate] Gate: ${gatePath}`);

    // --- Service: Gate State Manager ---
    const gateStateManager = createGateStateManager({
      gatePath,
      logger,
      consecutiveFailureThreshold: config.consecutiveFailureThreshold ?? 3,
    });
    api.registerService(gateStateManager);

    // --- Hook: Tier Tagger (inbound_claim, fail-closed) ---
    const tierTagger = createTierTagger({ identityPath, logger });
    api.on("inbound_claim", tierTagger, { priority: 100 });

    // --- Memory Prompt Supplement ---
    // registerMemoryPromptSupplement takes ONLY the builder function.
    // The plugin ID is auto-injected by OpenClaw's API wrapper.
    // Builder receives { availableTools, citationsMode } and returns string[].
    const { createMemorySupplementBuilder } = require("./context-injector.js");
    api.registerMemoryPromptSupplement(
      createMemorySupplementBuilder({ memoryPath, identityPath, recallBudgetTokens: config.recallBudgetTokens ?? 4000, logger })
    );

    // --- Hook: Gate Evaluator (reply_dispatch) ---
    const gateEvaluator = createGateEvaluator({
      gateStateManager,
      gateTimeoutMs: config.gateTimeoutMs ?? 10000,
      gateModel: config.gateModel ?? "claude-haiku-4-5",
      logger,
      pluginApi: api,
      workspaceDir: workspacePath,
      identityPath,
    });
    api.on("reply_dispatch", gateEvaluator);

    // --- Hook: Safety Backstop (message_sending, fail-closed) ---
    const safetyBackstop = createSafetyBackstop({ logger });
    api.on("message_sending", safetyBackstop);

    // --- Hook: Tool Gating (before_tool_call) ---
    const toolGating = createToolGating({ logger });
    api.on("before_tool_call", toolGating);

    // --- Hook: Turn Logger (agent_end) ---
    const turnLogger = createTurnLogger({
      memoryPath,
      workspacePath,
      logger,
    });
    api.on("agent_end", turnLogger);

    // --- CLI Commands ---
    if (api.registerCli) {
      api.registerCli((cmd: any) => {
        cmd
          .command("trust-gate status")
          .description("Show Gate health, tier cache, and consecutive failures")
          .action(() => {
            const status = gateStateManager.getStatus();
            console.log(JSON.stringify(status, null, 2));
          });

        cmd
          .command("trust-gate incidents")
          .description("Show recent security escalations")
          .action(() => {
            const incidents = gateStateManager.getRecentIncidents();
            console.log(JSON.stringify(incidents, null, 2));
          });
      });
    }

    logger.info("[trust-gate] Plugin registered. Hooks: inbound_claim (p100), reply_dispatch, message_sending, before_tool_call, agent_end. Memory: registerMemoryPromptSupplement.");
  },
};
