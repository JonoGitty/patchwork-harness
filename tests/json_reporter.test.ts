import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { StdoutJsonReporter, NoOpJsonReporter } from "../src/util/json_reporter.js";

describe("StdoutJsonReporter", () => {
  let writeSpy: ReturnType<typeof vi.spyOn>;
  let written: string[];

  beforeEach(() => {
    written = [];
    writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(((chunk: unknown) => {
      written.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);
  });

  afterEach(() => {
    writeSpy.mockRestore();
  });

  it("emits one JSON object per line with timestamp + session_id", () => {
    const r = new StdoutJsonReporter();
    r.setSessionId("sess_abc");
    r.emit("session_start", { goal: "do x" });
    expect(written).toHaveLength(1);
    const line = written[0]!;
    expect(line.endsWith("\n")).toBe(true);
    const parsed = JSON.parse(line);
    expect(parsed.type).toBe("session_start");
    expect(parsed.session_id).toBe("sess_abc");
    expect(parsed.data).toEqual({ goal: "do x" });
    expect(typeof parsed.timestamp).toBe("string");
    expect(parsed.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("emits multiple events as separate lines (NDJSON)", () => {
    const r = new StdoutJsonReporter();
    r.setSessionId("s1");
    r.emit("step_start", { step: "a" });
    r.emit("step_token", { text: "hello" });
    r.emit("step_end", { step: "a", status: "completed" });
    expect(written).toHaveLength(3);
    for (const line of written) {
      expect(line.endsWith("\n")).toBe(true);
      // Each line must independently parse as JSON
      const parsed = JSON.parse(line.trim());
      expect(parsed.session_id).toBe("s1");
    }
  });

  it("session_id is empty until set", () => {
    const r = new StdoutJsonReporter();
    r.emit("session_start", {});
    const parsed = JSON.parse(written[0]!.trim());
    expect(parsed.session_id).toBe("");
  });
});

describe("NoOpJsonReporter", () => {
  it("does nothing on emit", () => {
    const r = new NoOpJsonReporter();
    expect(() => r.emit("session_start", { x: 1 })).not.toThrow();
    expect(() => r.setSessionId("s")).not.toThrow();
  });
});
