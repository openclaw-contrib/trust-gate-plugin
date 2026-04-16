/**
 * Safety Backstop — message_sending hook (fail-closed)
 *
 * Defense-in-depth final filter before Discord API send.
 * Checks for: unencoded untrusted content, prohibited-category
 * content for non-principal, anything that slipped past the Gate.
 *
 * Returns { cancel: true } on violation.
 * Fail-closed via failurePolicyByHook — if this hook throws,
 * the message is blocked entirely.
 */

interface SafetyBackstopOpts {
  logger: { info: Function; warn: Function; error: Function };
}

// Default patterns the backstop blocks in outbound messages to non-principal
// tiers. These cover generic OpenClaw / trust-gate architecture terms that
// should not leak to strangers.
//
// Deployments SHOULD extend this list with their own project-specific terms
// (internal plugin names, agent names, private file paths, etc.) — the default
// list does not know about your deployment's naming. The cleanest extension
// pattern is to fork this file or wrap the hook; a config-driven list is
// planned for a future release.
const ARCHITECTURE_LEAK_PATTERNS = [
  /\bsub-?agent/i,
  /\bhead\s*session/i,
  /\bpersonality\s*gate/i,
  /\btrust-gate/i,
  /\bopenclaw/i,
  /\bsessions?_spawn/i,
  /\bsessions?_send/i,
  /\breply_dispatch/i,
  /\binbound_claim/i,
  /\bbefore_agent/i,
  /\bmessage_sending/i,
  /\bworkspace\/state/i,
  /\bworkspace\/memory/i,
  /\bgate\/rules\.md/i,
  /\bfriends\.snapshot\.json/i,
  /\bprincipal\.snapshot\.json/i,
  /\bturns\.ndjson/i,
  /\brecent\.md/i,
  /\bplugin\s*hook/i,
  /\bhaiku.*gate/i,
  /\binline.*gate/i,
];

// Raw untrusted tags that should have been entity-encoded
const RAW_UNTRUSTED_PATTERN = /<\/?untrusted[\s>]/i;

export function createSafetyBackstop(opts: SafetyBackstopOpts) {
  return (event: any) => {
    const content: string = event?.content ?? "";
    const tier: string = event?.metadata?.interlocutor_kind ?? "interloper";

    // Principal gets pass-through at this layer
    if (tier === "principal") {
      return {};
    }

    // Check for raw untrusted tags (encoding failure upstream)
    if (RAW_UNTRUSTED_PATTERN.test(content)) {
      opts.logger.error(
        `[trust-gate:backstop] BLOCKED: raw <untrusted> tags in outbound to ${tier}`
      );
      return { cancel: true };
    }

    // Check for architecture/internal leak patterns
    for (const pattern of ARCHITECTURE_LEAK_PATTERNS) {
      if (pattern.test(content)) {
        opts.logger.error(
          `[trust-gate:backstop] BLOCKED: architecture leak pattern "${pattern.source}" in outbound to ${tier}`
        );
        return { cancel: true };
      }
    }

    return {};
  };
}
