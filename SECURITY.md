# Security

## What this plugin actually guarantees

Claims of "enforcement" in this plugin refer to **code-layer controls** — deterministic checks running in OpenClaw plugin hooks that cannot be bypassed by prompt engineering the agent. These include:

- **Trust-tier tagging** on `inbound_claim`: every message is tagged by platform-stable snowflake before reaching the agent.
- **Entity encoding** on the memory-prompt-supplement path: untrusted content is HTML-entity-encoded and wrapped in `<untrusted>` tags. The agent's system prompt MUST instruct it to treat tagged content as data, not instruction.
- **Tool gating** on `before_tool_call`: non-principal tiers cannot invoke any tools.
- **Safety backstop** on `message_sending`: outbound messages to non-principal tiers are filtered for raw untrusted-tag escape and architecture-leak patterns.

These are mechanical, testable, and do not rely on LLM judgment.

### Fail-closed is a gateway-config requirement, not a plugin self-enforcement

The plugin registers the hooks. Whether a thrown exception from `inbound_claim` or `message_sending` fails *closed* (block) or *open* (pass through untagged/unfiltered) is decided by the OpenClaw gateway's `failurePolicyByHook` setting. Deployers MUST configure:

```json
{
  "failurePolicyByHook": {
    "inbound_claim": "fail_closed",
    "message_sending": "fail_closed"
  }
}
```

Without this, the "fail-closed" characterization above does not hold.

## What this plugin does NOT guarantee

The **Personality Gate** is an inline Haiku LLM call. It is a soft-layer judge that:

- Evaluates draft replies against deployment-private `rules.md`.
- Is **bounded by the judge model's capability** — novel jailbreaks against Haiku are undetected until Anthropic patches the model.
- Has **unmeasured recall** as of v0.1.0. A ≥95% recall target against public benchmarks (PINT, Gandalf) is planned but not met.

**Do not treat the Gate as a security guarantee.** Treat it as an additional soft layer on top of the deterministic controls above. If the Gate is the only thing standing between a hostile interlocutor and a bad outcome in your deployment, you are out of the model the spec describes.

## Known residual risks

The [companion reference design](https://github.com/openclaw-contrib/orchestrator-protocol-spec) documents the full threat model — read `THREAT_MODEL.md` in that repository. Headline items:

- **LLM jailbreaks against the Gate** (Haiku) — mitigation is Anthropic's model-safety pipeline; unmeasured recall at publication.
- **Principal-tier degraded mode** — when the Gate API is unreachable, principal messages pass through self-filtered (by the main agent). Documented trade-off; see spec §8.4.1.
- **Operator misconfiguration** — weak `rules.md`, outdated identity snapshots, over-broad pre-check allowlists, and tier-list drift will all degrade effective security. This plugin cannot detect or correct operator misconfiguration.
- **Supply-chain / platform compromise** — trust of Anthropic's API, OpenClaw's runtime, and the host machine is assumed. Out of scope.
- **Trusted-local-sender bypass** — the Gate evaluator treats the hardcoded sender IDs `openclaw-control-ui` and `webchat` as principal-equivalent (see `src/gate-evaluator.ts` `TRUSTED_SENDERS`). This assumes the OpenClaw webchat UI is a local, authenticated channel. If you expose it to the public internet, any unauthenticated user reaches principal tier. A config-driven override is planned; until then, treat this list as part of your threat surface.
- **Memory recall is scoped to "most recent sender across sessions"** — OpenClaw's `registerMemoryPromptSupplement` callback does not receive session or sender info. The plugin reads the most recently cached sender (populated by `inbound_claim`) to pick whose memory to inject. Under serial single-agent turn processing this is correct; under highly concurrent multi-channel traffic, a race between two inbound messages can cause one turn to read the other sender's memory. Mitigations: keep turn processing serial per agent; set `recallBudgetTokens` conservatively; do not rely on memory-scoping for secrets.

## Reporting a vulnerability

If you find a security issue in this plugin, please do **not** open a public GitHub issue. Email `wardcorin+security@proton.me` with:

- A clear description of the issue and its impact.
- Minimal reproduction steps.
- Whether you want credit in the fix announcement.

Response target: acknowledge within 7 days, patch or mitigation plan within 30 days for confirmed issues.

Out-of-scope reports (not treated as vulnerabilities):
- LLM jailbreak techniques against the Gate — submit those upstream to Anthropic.
- Issues that require operator-granted principal-tier access to exploit.
- Operator misconfiguration of rules, snapshots, or templates.

## Supported versions

Only the latest published release receives security patches.

## Apache-2.0 disclaimer

See [LICENSE](LICENSE) §7–8. This software is provided "AS IS" without warranty. Security-sensitive deployments should perform their own review.
