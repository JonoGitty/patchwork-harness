import { describe, expect, it } from "vitest";
import { AuditEmitter } from "../src/audit.js";
import { decide } from "../src/permissions/policy.js";
import { newSessionId } from "../src/util/ulid.js";
import { loadModels, loadPolicy } from "../src/config.js";

describe("config", () => {
  it("loads models.yml", () => {
    const m = loadModels();
    expect(m.models.length).toBeGreaterThan(3);
    expect(m.defaults.planner).toBe("gpt-6-luna");
  });
  it("loads policy.yml", () => {
    const p = loadPolicy();
    expect(p.mode).toBe("fail-closed");
    expect(p.bash_denylist.length).toBeGreaterThan(0);
  });
});

describe("audit", () => {
  it("emits a Patchwork-shape event", () => {
    const sid = newSessionId();
    const e = new AuditEmitter(sid, process.cwd(), "test");
    const evt = e.emit({ action: "session_start" });
    expect(evt.id).toMatch(/^evt_/);
    expect(evt.session_id).toBe(sid);
    expect(evt.agent).toBe("patchwork-harness");
    expect(evt.action).toBe("session_start");
    expect(evt.risk.level).toBe("none");
  });
});

describe("permissions", () => {
  it("denies sudo bash unconditionally", () => {
    const d = decide({
      cwd: "/x",
      toolName: "bash",
      risk: { level: "critical", flags: ["destructive_command"] },
      description: "bash: sudo rm -rf /",
      details: { command: "sudo rm -rf /" },
      mode: "auto",
    });
    expect(d.kind).toBe("deny");
  });
  it("auto-approves npm test", () => {
    const d = decide({
      cwd: "/x",
      toolName: "bash",
      risk: { level: "low", flags: [] },
      description: "bash: npm test",
      details: { command: "npm test" },
      mode: "default",
    });
    expect(d.kind).toBe("auto");
  });
  it("prompts on git push", () => {
    const d = decide({
      cwd: "/x",
      toolName: "git_ops",
      risk: { level: "high", flags: [] },
      description: "git push",
      details: { command: "git push origin main" },
      mode: "default",
    });
    expect(d.kind).toBe("prompt");
  });
});
