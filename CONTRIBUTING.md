# Contributing

Thanks for considering a contribution. This plugin is a reference implementation paired with the [Ryn Orchestrator Reference Design](https://github.com/openclaw-contrib/orchestrator-protocol-spec); changes that drift from the reference design's security model will be declined unless the design document itself is updated first.

## Before you file a PR

- **Open an issue first** for anything beyond a typo fix or a small bug fix. Design changes are easier to discuss before code is written.
- **Read `SECURITY.md`** — particularly the "what this plugin does NOT guarantee" section. Many feature ideas that sound reasonable actually relax the code-layer invariants; those are not accepted.

## Requirements for a PR

- `npm test` passes locally. All existing tests stay green.
- New behavior has tests covering the happy path and at least one failure mode. Security-relevant changes (anything in `safety-backstop.ts`, `tier-tagger.ts`, `tool-gating.ts`, or Gate-evaluation code) need a test for the block path, not just the allow path.
- No new runtime dependencies unless they are justified in the PR description. Vitest is the only dev dependency and we'd like to keep it that way.
- No commented-out code, no dead branches.
- Keep log prefixes consistent: `[trust-gate:<subsystem>]`.

## What is in scope

- Bug fixes.
- Test coverage improvements.
- Docs, schema clarifications, better error messages.
- Portability improvements (e.g. supporting platforms other than Discord's snowflake format — if generalized behind a clean interface).

## What is out of scope

- Changes that weaken any fail-closed hook (`inbound_claim`, `message_sending`) to fail-open.
- Auto-elevation of trust tiers without operator approval.
- Removing the `<untrusted>` tag preservation behavior.
- Principal-tier bypass of the safety-backstop unless explicitly opt-in and documented.

Anything in the "out of scope" list can still be discussed via an issue, but the bar for acceptance is high and typically requires a corresponding update to the reference design spec.

## Commit and PR style

- One logical change per PR.
- Commit messages: imperative mood, short summary line, body explains motivation (the "why").
- No AI-coauthor trailers.

## License

By submitting a contribution, you agree it will be licensed under Apache-2.0 (the project license).
