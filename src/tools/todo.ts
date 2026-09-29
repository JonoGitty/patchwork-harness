import { z } from "zod";
import type { Tool } from "./base.js";

const Item = z.object({
  text: z.string(),
  status: z.enum(["pending", "in_progress", "done"]).default("pending"),
});

const Input = z.object({
  action: z.enum(["set", "show"]),
  items: z.array(Item).optional(),
});
type In = z.infer<typeof Input>;

const STATE = new Map<string, z.infer<typeof Item>[]>(); // sessionId -> items

export const todoTool: Tool<In, { items: z.infer<typeof Item>[] }> = {
  name: "todo",
  description:
    "Per-session todo list the planner uses to track sub-task progress. action='set' replaces the list; 'show' returns the current list.",
  inputSchema: Input,
  assess: () => ({ level: "none", flags: [] }),
  preview: (i) => ({ description: `todo ${i.action}` }),
  async run(input, ctx) {
    if (input.action === "set" && input.items) STATE.set(ctx.sessionId, input.items);
    return { items: STATE.get(ctx.sessionId) ?? [] };
  },
};
