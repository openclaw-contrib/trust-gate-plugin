# trust-gate — OpenClaw Trust-Tier Security Plugin

Reference implementation of the trust-tier pattern from the [Ryn Orchestrator Reference Design](https://github.com/openclaw-contrib/orchestrator-protocol-spec).

Implements the trust-tier pattern via OpenClaw plugin hooks:
- **Trust-tier tagging** — every inbound message is tagged `principal` / `friend` / `interloper` based on platform-stable identity (Discord snowflakes). Tier is written to an in-process sender cache keyed by `sessionKey` so downstream hooks can read it.
- **Memory recall** — per-interlocutor memory is auto-injected into the system prompt via a `registerMemoryPromptSupplement` callback. (The originally-planned `<untrusted>`-tag entity-encoder ran on `before_agent_start`, which does not fire reliably for workspace plugins; the equivalent untrusted-content discipline is enforced via gate `rules.md` instructions and the safety-backstop's outbound check for raw `<untrusted>` tags.)
- **Inline Gate evaluation** — non-principal drafts are evaluated by a Haiku judge before send. Verdict surface is binary: `approve` ships the draft, `deflect` substitutes a tier-appropriate template from `deflection_templates.md`. (The `revise` and `reject` verdicts from earlier design iterations are retired — see [trust-gate-plugin.md §3](https://github.com/openclaw-contrib/orchestrator-protocol-spec/blob/main/trust-gate-plugin.md) in the spec repo.)
- **Safety backstop** — final filter on outbound messages for architecture leaks and raw untrusted-tag escape, registered ahead of the Gate so a cancel short-circuits the Haiku call.
- **Tool gating** — only the principal can invoke tools; friend and interloper tiers are conversation-only. Resolution chain: sender-cache → `channel_tiers` → cron-sessionKey-shape grant → deny.
- **Turn logging** — every turn is logged to per-interlocutor `turns.ndjson` for lossless recovery.

Fail-closed semantics on `inbound_claim` and `message_sending` are enforced at the OpenClaw gateway — see [Gateway config](#gateway-config-required) below.

## Status

Published reference implementation, v0.1.0. See [SECURITY.md](SECURITY.md) for what's actually guaranteed and what isn't.

## Who this is for

- Hobbyists building personal AI companions exposed to Discord or similar mixed-trust channels on OpenClaw.
- Researchers wanting a runnable companion to the trust-tier reference design.
- OpenClaw plugin authors looking for a reference of the hook composition pattern (`inbound_claim` (priority 100) → memory-supplement callback → two handlers on `message_sending` (safety-backstop first, then gate-evaluator) → `before_tool_call` → `agent_end`).

## Who this is NOT for

- Production / commercial deployments — this is a reference implementation, not a hardened product. The Gate's judge-model recall is unmeasured.
- Multi-tenant platforms — the design assumes a single operator (the principal).

## Install

This plugin is distributed as a repo, not an npm package. Clone it directly into your OpenClaw workspace's extensions folder:

```bash
git clone https://github.com/openclaw-contrib/trust-gate-plugin.git \
  path/to/workspace/.openclaw/extensions/trust-gate
```

Then enable it in `openclaw.json`:

```json
{
  "extensions": {
    "trust-gate": { "enabled": true }
  }
}
```

`npm install` is only needed if you plan to run the test suite (installs `vitest`); it is not required to use the plugin.

## Gateway config (required)

Two of this plugin's hooks are advertised as fail-closed. That behavior is enforced at the OpenClaw gateway, not in the plugin — the plugin registers the hooks but does not self-enforce the policy. Add to your `openclaw.json`:

```json
{
  "failurePolicyByHook": {
    "inbound_claim": "fail_closed",
    "message_sending": "fail_closed"
  }
}
```

Without this, a thrown exception inside `inbound_claim` (tier tagging) or `message_sending` (safety backstop) will fail-open — messages flow through untagged or unfiltered. **Do not deploy without this config.**

## Configure

The plugin reads config via `configSchema` in [`openclaw.plugin.json`](openclaw.plugin.json). All paths are relative to the OpenClaw workspace.

| Key | Default | What it is |
|---|---|---|
| `identityPath` | `state/identity` | Directory holding `principal.snapshot.json` + `friends.snapshot.json`. |
| `memoryPath` | `memory/interlocutors` | Directory for per-interlocutor memory (one subdirectory per snowflake). |
| `gatePath` | `state/gate` | Directory for Gate rules, deflection templates, pre-check allowlist, and verdict log. |
| `recallBudgetTokens` | `4000` | Max tokens of recalled memory injected per message. |
| `gateTimeoutMs` | `60000` | Self-managed timeout on the inline Haiku Gate call. **Default raised from 10s in v0.1.0** — long-prompt evaluations under load were timing out at 10s, returning a transient error string the parser correctly flagged as not-a-verdict and triggering deflect-on-everything. 30s minimum, 60s recommended. |
| `gateModel` | `claude-haiku-4-5` | Model used for Gate evaluation. |
| `consecutiveFailureThreshold` | `3` | Consecutive Gate API failures before an error log is emitted. (The notify-to-principal path is planned; v0.1.0 logs only.) |

### Trusted local sender IDs

The Gate evaluator treats two sender IDs as principal-equivalent by default: `openclaw-control-ui` and `webchat`. These are local/authenticated OpenClaw channels that never carry a Discord snowflake. If you expose your OpenClaw webchat to the public internet, this bypass becomes a principal escalation — see SECURITY.md §"Known residual risks". The list is currently hardcoded in `src/gate-evaluator.ts`; a config-driven override is planned.

## Populate identity snapshots

The plugin resolves trust tiers from two JSON files in `identityPath`. Schemas are in [`schemas/`](schemas/); stub examples in [`examples/`](examples/).

**`principal.snapshot.json`** — single principal (you).

```json
{
  "version": 1,
  "principal_discord_id": "YOUR_DISCORD_SNOWFLAKE",
  "principal_discord_username_hint": "your_display_name",
  "alt_ids": []
}
```

**`friends.snapshot.json`** — active friend-tier interlocutors.

```json
{
  "version": 1,
  "friends": [
    { "discord_id": "FRIEND_SNOWFLAKE", "handle_hint": "display_name", "status": "active" }
  ]
}
```

Bump the `version` field on every update — the plugin reloads snapshots whenever the version increases.

## Gate rules

The Gate reads plain-text rules from `gatePath/rules.md` each turn (cached, auto-reloaded on mtime change). Write your rules as a system prompt for a Haiku judge that emits one of two verdicts on its own line: `APPROVE` (ship the draft) or `DEFLECT: <brief reason>` (replace with a template). The legacy `REJECT` keyword is also accepted for compatibility but treated as `DEFLECT`. The parser tolerates leading markdown emphasis (`**APPROVE**`, `> APPROVE`), and on ambiguous responses logs the raw output at `WARN` level for tuning. Keep rules deployment-private — the published adversarial-test pattern expects the rules themselves to be a trust boundary.

Also expected in `gatePath`:
- `deflection_templates.md` — tier-keyed templates substituted on a `deflect` verdict. Two sections: `## For Interlopers` and `## For Friends`.
- `degraded_templates.md` — static deflection lines used when the Gate API itself is degraded (timeout, empty, or unparseable response, after all retries). Same two-section structure as `deflection_templates.md`.
- `precheck_allowlist.json` — exact-string fast-path bypasses (e.g., trivial acknowledgments). Shape: `{ "allowed": ["ok", "got it", ...] }`.

## Test

```bash
npm test
```

Runs the vitest suite. 24 tests across safety-backstop, tool-gating, and tier-tagger.

## Security model

See [SECURITY.md](SECURITY.md). Short version: code-enforced invariants (routing, tagging, encoding, tool-gating) are strong. LLM-judge decisions (semantic injection detection) are bounded by the judge model and have **unmeasured recall** as of this release — treat the Gate as a soft layer on top of the deterministic structure, not a guarantee.

For the full architectural rationale and threat model, read the [companion reference design](https://github.com/openclaw-contrib/orchestrator-protocol-spec), in particular `THREAT_MODEL.md` and `05-security-deepdive.md`.

## License

Apache-2.0. See [LICENSE](LICENSE).
