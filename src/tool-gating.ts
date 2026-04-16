/**
 * Tool Gating — before_tool_call hook
 *
 * Blocks all tool calls from non-principal interlocutors.
 * In the default configuration, only the principal can invoke tools;
 * friend- and interloper-tier interlocutors are conversation partners,
 * not assistants.
 *
 * Returns { block: true, blockReason: "..." } for non-principal.
 */

interface ToolGatingOpts {
  logger: { info: Function; warn: Function; error: Function };
}

export function createToolGating(opts: ToolGatingOpts) {
  return (event: any) => {
    const tier: string = event?.interlocutor_kind ?? "interloper";
    const toolName: string = event?.toolName ?? "unknown";

    // Principal gets full tool access
    if (tier === "principal") {
      return {};
    }

    // Non-principal: block all tools
    opts.logger.info(
      `[trust-gate:tool-gating] Blocked tool "${toolName}" for ${tier} interlocutor`
    );

    return {
      block: true,
      blockReason: `Tool access is not available for ${tier}-tier interlocutors.`,
    };
  };
}
