import { describe, it, expect, vi } from "vitest";
import { createToolGating } from "../src/tool-gating.js";

function makeLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

describe("tool-gating", () => {
  it("allows tool calls from principal-tier interlocutors", () => {
    const logger = makeLogger();
    const hook = createToolGating({ logger });
    const result = hook({
      interlocutor_kind: "principal",
      toolName: "Read",
    });
    expect(result).toEqual({});
    expect(logger.info).not.toHaveBeenCalled();
  });

  it("blocks tool calls from friend-tier interlocutors", () => {
    const logger = makeLogger();
    const hook = createToolGating({ logger });
    const result = hook({
      interlocutor_kind: "friend",
      toolName: "Bash",
    });
    expect(result.block).toBe(true);
    expect(result.blockReason).toContain("friend");
    expect(logger.info).toHaveBeenCalled();
  });

  it("blocks tool calls from interloper-tier interlocutors", () => {
    const logger = makeLogger();
    const hook = createToolGating({ logger });
    const result = hook({
      interlocutor_kind: "interloper",
      toolName: "Edit",
    });
    expect(result.block).toBe(true);
    expect(result.blockReason).toContain("interloper");
  });

  it("defaults to interloper (blocked) when tier is missing", () => {
    const logger = makeLogger();
    const hook = createToolGating({ logger });
    const result = hook({ toolName: "Write" });
    expect(result.block).toBe(true);
  });

  it("handles missing toolName gracefully", () => {
    const logger = makeLogger();
    const hook = createToolGating({ logger });
    const result = hook({ interlocutor_kind: "friend" });
    expect(result.block).toBe(true);
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining("unknown")
    );
  });
});
