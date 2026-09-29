import { execa } from "execa";
import { z } from "zod";
import type { Tool, RiskAssessment } from "./base.js";

const Action = z.enum(["status", "diff", "add", "commit", "push", "branch", "pr_create"]);

const Input = z.object({
  action: Action,
  message: z.string().optional().describe("for commit"),
  files: z.array(z.string()).optional().describe("for add"),
  branch: z.string().optional(),
  pr_title: z.string().optional(),
  pr_body: z.string().optional(),
});
type In = z.infer<typeof Input>;

function classify(action: z.infer<typeof Action>): RiskAssessment {
  if (action === "push") return { level: "high", flags: ["network_request"] };
  if (action === "pr_create") return { level: "high", flags: ["network_request"] };
  if (action === "commit" || action === "add") return { level: "low", flags: [] };
  return { level: "none", flags: [] };
}

export const gitOpsTool: Tool<In, { action: string; output: string; success: boolean }> = {
  name: "git_ops",
  description:
    "Perform a git or gh action: status, diff, add, commit, push, branch, pr_create. Each action prompts unless explicitly auto-approved.",
  inputSchema: Input,
  assess: (i) => classify(i.action),
  preview: (i) => {
    const cmd =
      i.action === "commit"
        ? `git commit -m ${JSON.stringify(i.message ?? "")}`
        : i.action === "add"
          ? `git add ${(i.files ?? []).join(" ") || "."}`
          : i.action === "push"
            ? `git push${i.branch ? " origin " + i.branch : ""}`
            : i.action === "pr_create"
              ? `gh pr create --title ${JSON.stringify(i.pr_title ?? "")}`
              : `git ${i.action}`;
    return { description: cmd, details: { command: cmd } };
  },
  async run(input, ctx) {
    const args: string[][] = [];
    let bin = "git";
    switch (input.action) {
      case "status":
        args.push(["status", "--short"]);
        break;
      case "diff":
        args.push(["diff", "--stat"]);
        args.push(["diff"]);
        break;
      case "add":
        args.push(["add", ...(input.files ?? ["."])]);
        break;
      case "commit":
        if (!input.message) throw new Error("commit requires a message");
        args.push(["commit", "-m", input.message]);
        break;
      case "push":
        args.push(["push", "origin", input.branch ?? "HEAD"]);
        break;
      case "branch":
        if (!input.branch) throw new Error("branch requires a name");
        args.push(["checkout", "-b", input.branch]);
        break;
      case "pr_create":
        bin = "gh";
        if (!input.pr_title) throw new Error("pr_create requires a title");
        args.push([
          "pr",
          "create",
          "--title",
          input.pr_title,
          "--body",
          input.pr_body ?? "",
        ]);
        break;
    }
    let combined = "";
    let success = true;
    for (const a of args) {
      const r = await execa(bin, a, { cwd: ctx.cwd, reject: false });
      combined += `$ ${bin} ${a.join(" ")}\n${r.stdout}\n${r.stderr}\n`;
      if (r.exitCode !== 0) success = false;
    }
    return { action: input.action, output: combined, success };
  },
};
