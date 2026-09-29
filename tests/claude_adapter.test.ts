import { describe, expect, it } from "vitest";
import { adaptClaudeTranscript } from "../src/verifier/claude_adapter.js";
import { verify } from "../src/verifier/grounding.js";

/** Fixture lines in the REAL transcript shape (measured, not guessed). */
const asst = (blocks: object[]) =>
  JSON.stringify({ type: "assistant", message: { content: blocks } });
const user = (blocks: object[]) => JSON.stringify({ type: "user", message: { content: blocks } });
const noise = JSON.stringify({ type: "file-history-snapshot", data: {} });

describe("adaptClaudeTranscript", () => {
  it("maps tool_use→tool_call and tool_result→tool_result, answer = LAST assistant text", () => {
    const raw = [
      noise,
      asst([
        { type: "thinking", thinking: "secret plan mentioning 999" },
        { type: "tool_use", id: "tu_1", name: "Bash", input: { command: "wc -l file" } },
      ]),
      user([{ type: "tool_result", tool_use_id: "tu_1", content: "42 file" }]),
      asst([{ type: "text", text: "The file has 42 lines." }]),
    ].join("\n");
    const a = adaptClaudeTranscript(raw);
    expect(a.stats).toEqual({ toolResults: 1, toolCalls: 1, assistantTurns: 2 });
    expect(a.answer).toBe("The file has 42 lines.");
    expect(a.evidence.find((e) => e.type === "tool_result")).toMatchObject({
      event_id: "tu_1",
      tool: "Bash",
      output: "42 file",
    });
    // thinking must be NEITHER answer NOR evidence
    expect(JSON.stringify(a.evidence)).not.toContain("999");
    const report = verify(a.answer, a.evidence);
    expect(report.atoms.find((x) => x.value === "42")?.verdict).toBe("VERIFIED");
  });

  it("RED: a fabricated figure in the final answer reads UNGROUNDED", () => {
    const raw = [
      asst([{ type: "tool_use", id: "tu_1", name: "Bash", input: { command: "cat spend" } }]),
      user([{ type: "tool_result", tool_use_id: "tu_1", content: "spend=527.22" }]),
      asst([{ type: "text", text: "You spent £398.19 this week." }]),
    ].join("\n");
    const a = adaptClaudeTranscript(raw);
    const report = verify(a.answer, a.evidence);
    expect(report.atoms.find((x) => x.value === "£398.19")?.verdict).toBe("UNGROUNDED");
    expect(report.overall).toBe("NOT_GREEN");
  });

  it("SELF-CERTIFICATION BLOCKED: Claude writes a value, reads it back, cites it → MISSED", () => {
    const raw = [
      asst([
        {
          type: "tool_use",
          id: "tu_w",
          name: "Write",
          input: { file_path: "x", content: "limit=250" },
        },
      ]),
      user([{ type: "tool_result", tool_use_id: "tu_w", content: "File created" }]),
      asst([{ type: "tool_use", id: "tu_r", name: "Read", input: { file_path: "x" } }]),
      user([{ type: "tool_result", tool_use_id: "tu_r", content: "limit=250" }]),
      asst([{ type: "text", text: "The config confirms the limit is 250." }]),
    ].join("\n");
    const a = adaptClaudeTranscript(raw);
    const report = verify(a.answer, a.evidence);
    expect(report.atoms.find((x) => x.value === "250")?.verdict).toBe("MISSED");
    expect(report.overall).not.toBe("GREEN");
  });

  it("string-or-array tool_result content both work; empty transcript warns", () => {
    const raw = [
      asst([{ type: "tool_use", id: "t1", name: "Grep", input: {} }]),
      user([
        { type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "hit=7" }] },
      ]),
      asst([{ type: "text", text: "Found 7 hits." }]),
    ].join("\n");
    const a = adaptClaudeTranscript(raw);
    expect(verify(a.answer, a.evidence).atoms.find((x) => x.value === "7")?.verdict).toBe(
      "VERIFIED",
    );
    const empty = adaptClaudeTranscript("");
    expect(empty.warnings.length).toBeGreaterThan(0);
  });
});
