import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createTierTagger } from "../src/tier-tagger.js";

function makeLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

const PRINCIPAL_ID = "111111111111111111";
const FRIEND_ID = "222222222222222222";
const STRANGER_ID = "333333333333333333";

describe("tier-tagger", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "trust-gate-test-"));
    writeFileSync(
      join(tmpDir, "principal.snapshot.json"),
      JSON.stringify({
        version: 1,
        principal_discord_id: PRINCIPAL_ID,
        principal_discord_username_hint: "operator",
        alt_ids: [],
      })
    );
    writeFileSync(
      join(tmpDir, "friends.snapshot.json"),
      JSON.stringify({
        version: 1,
        friends: [
          { discord_id: FRIEND_ID, handle_hint: "alpha", status: "active" },
          { discord_id: "444444444444444444", handle_hint: "suspended_friend", status: "suspended" },
        ],
      })
    );
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("tags the principal snowflake as principal", async () => {
    const hook = createTierTagger({ identityPath: tmpDir, logger: makeLogger() });
    const result = await hook({ senderId: PRINCIPAL_ID });
    expect(result.interlocutor_kind).toBe("principal");
    expect(result.interlocutor_id).toBe(PRINCIPAL_ID);
  });

  it("tags an active friend snowflake as friend", async () => {
    const hook = createTierTagger({ identityPath: tmpDir, logger: makeLogger() });
    const result = await hook({ senderId: FRIEND_ID });
    expect(result.interlocutor_kind).toBe("friend");
  });

  it("resolves suspended friend status to interloper", async () => {
    const hook = createTierTagger({ identityPath: tmpDir, logger: makeLogger() });
    const result = await hook({ senderId: "444444444444444444" });
    expect(result.interlocutor_kind).toBe("interloper");
  });

  it("tags unknown snowflakes as interloper", async () => {
    const hook = createTierTagger({ identityPath: tmpDir, logger: makeLogger() });
    const result = await hook({ senderId: STRANGER_ID });
    expect(result.interlocutor_kind).toBe("interloper");
  });

  it("fails safe to interloper when senderId is missing", async () => {
    const hook = createTierTagger({ identityPath: tmpDir, logger: makeLogger() });
    const result = await hook({});
    expect(result.interlocutor_kind).toBe("interloper");
    expect(result.interlocutor_id).toBe("unknown");
  });

  it("flags impersonation when stranger uses principal display name", async () => {
    const logger = makeLogger();
    const hook = createTierTagger({ identityPath: tmpDir, logger });
    const result = await hook({
      senderId: STRANGER_ID,
      senderDisplayName: "operator",
    });
    expect(result.impersonation_risk).toBe(true);
    expect(result.interlocutor_kind).toBe("interloper");
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("Impersonation risk")
    );
  });

  it("does not flag impersonation when the principal uses their own display name", async () => {
    const logger = makeLogger();
    const hook = createTierTagger({ identityPath: tmpDir, logger });
    const result = await hook({
      senderId: PRINCIPAL_ID,
      senderDisplayName: "operator",
    });
    expect(result.interlocutor_kind).toBe("principal");
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("detects confusable spoof attempts (zero-width chars)", async () => {
    const logger = makeLogger();
    const hook = createTierTagger({ identityPath: tmpDir, logger });
    const result = await hook({
      senderId: STRANGER_ID,
      senderDisplayName: "oper\u200Bator",
    });
    expect(result.impersonation_risk).toBe(true);
  });
});
