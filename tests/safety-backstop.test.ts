import { describe, it, expect, vi } from "vitest";
import { createSafetyBackstop } from "../src/safety-backstop.js";

function makeLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

describe("safety-backstop", () => {
  describe("tier handling", () => {
    it("passes through principal-tier messages untouched", () => {
      const logger = makeLogger();
      const hook = createSafetyBackstop({ logger });
      const result = hook({
        content: "<untrusted>still here</untrusted> sub-agent openclaw",
        metadata: { interlocutor_kind: "principal" },
      });
      expect(result).toEqual({});
      expect(logger.error).not.toHaveBeenCalled();
    });

    it("defaults unknown tier to interloper (and thus applies filters)", () => {
      const logger = makeLogger();
      const hook = createSafetyBackstop({ logger });
      const result = hook({
        content: "mentions openclaw internals",
        metadata: {},
      });
      expect(result).toEqual({ cancel: true });
    });
  });

  describe("raw untrusted tag blocking", () => {
    it("cancels outbound containing raw <untrusted> open tag", () => {
      const logger = makeLogger();
      const hook = createSafetyBackstop({ logger });
      const result = hook({
        content: "hello <untrusted>foo</untrusted>",
        metadata: { interlocutor_kind: "friend" },
      });
      expect(result).toEqual({ cancel: true });
      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining("raw <untrusted> tags")
      );
    });

    it("cancels on standalone closing </untrusted> tag too", () => {
      const logger = makeLogger();
      const hook = createSafetyBackstop({ logger });
      const result = hook({
        content: "leak </untrusted> here",
        metadata: { interlocutor_kind: "interloper" },
      });
      expect(result).toEqual({ cancel: true });
    });

    it("allows entity-encoded untrusted references through", () => {
      const logger = makeLogger();
      const hook = createSafetyBackstop({ logger });
      const result = hook({
        content: "harmless &lt;untrusted&gt; mention",
        metadata: { interlocutor_kind: "friend" },
      });
      expect(result).toEqual({});
    });
  });

  describe("architecture leak blocking", () => {
    const leakPhrases = [
      "I'll spawn a sub-agent to help",
      "let me check with the personality gate",
      "my openclaw plugin says",
      "sessions_send is failing",
      "reading workspace/state for context",
    ];

    for (const phrase of leakPhrases) {
      it(`blocks outbound containing internal term: "${phrase}"`, () => {
        const logger = makeLogger();
        const hook = createSafetyBackstop({ logger });
        const result = hook({
          content: phrase,
          metadata: { interlocutor_kind: "interloper" },
        });
        expect(result).toEqual({ cancel: true });
      });
    }

    it("passes clean casual reply through", () => {
      const logger = makeLogger();
      const hook = createSafetyBackstop({ logger });
      const result = hook({
        content: "yeah that movie was great, rewatched last weekend",
        metadata: { interlocutor_kind: "friend" },
      });
      expect(result).toEqual({});
      expect(logger.error).not.toHaveBeenCalled();
    });
  });
});
