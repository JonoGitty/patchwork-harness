import { spawn } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { TOOLS, handle, runCommand, summariseRun } from "../src/mcp/server.js";
import { PROJECT_ROOT } from "../src/util/paths.js";

describe("patchwork-harness MCP server (ADR-0014)", () => {
  it("answers initialize with a tools capability and echoes the client's protocol", async () => {
    const r = (await handle({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-03-26" },
    })) as { result: { protocolVersion: string; capabilities: { tools: object } } };
    expect(r.result.protocolVersion).toBe("2025-03-26");
    expect(r.result.capabilities.tools).toBeDefined();
  });

  it("lists every tool with a schema, and ignores notifications", async () => {
    const r = (await handle({ jsonrpc: "2.0", id: 2, method: "tools/list" })) as {
      result: { tools: Array<{ name: string; inputSchema: { type: string } }> };
    };
    expect(r.result.tools.map((t) => t.name)).toEqual(TOOLS.map((t) => t.name));
    for (const t of r.result.tools) expect(t.inputSchema.type).toBe("object");
    expect(await handle({ jsonrpc: "2.0", method: "notifications/initialized" })).toBeNull();
  });

  it("refuses to run without confirm: true (spends money, executes tools)", async () => {
    const r = (await handle({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "harness_run", arguments: { goal: "x", cwd: "C:\\tmp" } },
    })) as { result: { isError: boolean; content: Array<{ text: string }> } };
    expect(r.result.isError).toBe(true);
    expect(r.result.content[0]?.text).toContain("confirm: true");
  });

  it("caps a confirmed run's budget", async () => {
    const r = (await handle({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: {
        name: "harness_run",
        arguments: { goal: "x", cwd: "C:\\tmp", confirm: true, budget_usd: 500 },
      },
    })) as { result: { isError: boolean; content: Array<{ text: string }> } };
    expect(r.result.isError).toBe(true);
    expect(r.result.content[0]?.text).toContain("budget_usd must be between");
  });

  it("harness_continue (ADR-0022) needs confirm, and becomes `run --continue` with its options", async () => {
    const r = (await handle({
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: { name: "harness_continue", arguments: { cwd: "C:\\tmp" } },
    })) as { result: { isError: boolean; content: Array<{ text: string }> } };
    expect(r.result.isError).toBe(true);
    expect(r.result.content[0]?.text).toContain("harness_continue spends money");
    expect(
      runCommand(
        {
          cwd: "C:\\tmp",
          confirm: true,
          session_id: "ses_1",
          instruction: "also add tests",
          budget_usd: 1,
        },
        "continue",
      ),
    ).toEqual([
      "run",
      "--continue",
      "also add tests",
      "--session",
      "ses_1",
      "-u",
      "--cwd",
      "C:\\tmp",
      "--budget",
      "1",
      "--verify",
    ]);
    // no session: the latest run in cwd; no instruction: just continue
    expect(runCommand({ cwd: "C:\\tmp", confirm: true }, "continue").slice(0, 3)).toEqual([
      "run",
      "--continue",
      "-u",
    ]);
  });

  it("reports unknown methods and tools as JSON-RPC errors", async () => {
    expect(await handle({ jsonrpc: "2.0", id: 5, method: "nope" })).toMatchObject({
      error: { code: -32601 },
    });
    expect(
      await handle({ jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "nope" } }),
    ).toMatchObject({ error: { code: -32602 } });
  });

  it("summarises a background run from its NDJSON log", () => {
    const log = [
      '{"type":"session_start","session_id":"ses_1","data":{}}',
      '{"type":"step_end","session_id":"ses_1","data":{"title":"write","status":"completed"}}',
      '{"type":"permission_required","session_id":"ses_1","data":{}}',
      '{"type":"session_end","session_id":"ses_1","data":{"status":"completed","cost_usd":0.01}}',
    ].join("\n");
    const s = summariseRun(log);
    expect(s).toContain("status: completed");
    expect(s).toContain("write: completed");
    expect(s).toContain("safe defaults");
    expect(summariseRun('{"type":"session_start","data":{}}\n{"type":"step_')).toContain(
      "status: running",
    );
  });

  it("speaks clean JSON-RPC over real stdio and runs a read-only tool end to end", async () => {
    const tsx = join(PROJECT_ROOT, "node_modules", "tsx", "dist", "cli.mjs");
    const child = spawn(process.execPath, [tsx, join(PROJECT_ROOT, "src", "cli.ts"), "mcp"], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (d) => {
      out += d;
    });
    const send = (m: object) => child.stdin.write(`${JSON.stringify(m)}\n`);
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: PROTOCOL } });
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    send({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "harness_verify_file",
        arguments: {
          path: join(PROJECT_ROOT, "tests", "fixtures", "verifier-corpus", "fab-001.json"),
        },
      },
    });
    const deadline = Date.now() + 120_000;
    while (!out.includes('"id":2') && Date.now() < deadline)
      await new Promise((r) => setTimeout(r, 250));
    child.stdin.end();
    const lines = out.split("\n").filter(Boolean);
    for (const l of lines) expect(() => JSON.parse(l), `non-JSON on stdout: ${l}`).not.toThrow();
    const call = lines.map((l) => JSON.parse(l)).find((m) => m.id === 2);
    expect(call.result.content[0].text).toContain("exit 1");
    expect(call.result.content[0].text).toContain("NOT_GREEN");
  }, 150_000);
});

const PROTOCOL = "2025-06-18";
