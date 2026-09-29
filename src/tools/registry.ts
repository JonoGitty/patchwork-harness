import { bashTool } from "./bash.js";
import { budgetStatusTool } from "./budget_status.js";
import { contextQueryTool } from "./context_query.js";
import { contextSearchTool } from "./context_search.js";
import { contextWriteTool } from "./context_write.js";
import { editTool } from "./edit.js";
import { gitOpsTool } from "./git_ops.js";
import { globTool } from "./glob.js";
import { grepTool } from "./grep.js";
import { imageGenerateTool } from "./image_generate.js";
import { readTool } from "./read.js";
import { todoTool } from "./todo.js";
import { writeTool } from "./write.js";
import type { Tool } from "./base.js";

const builtIns: Tool[] = [
  readTool as Tool,
  writeTool as Tool,
  editTool as Tool,
  bashTool as Tool,
  grepTool as Tool,
  globTool as Tool,
  gitOpsTool as Tool,
  imageGenerateTool as Tool,
  todoTool as Tool,
  budgetStatusTool as Tool,
  contextSearchTool as Tool,
  contextQueryTool as Tool,
  contextWriteTool as Tool,
];

const registry = new Map<string, Tool>(builtIns.map((t) => [t.name, t]));

export function tools(): Tool[] {
  return [...registry.values()];
}

export function getTool(name: string): Tool {
  const t = registry.get(name);
  if (!t) throw new Error(`unknown tool: ${name}`);
  return t;
}

export function registerTool(t: Tool): void {
  registry.set(t.name, t);
}
