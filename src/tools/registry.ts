import { z } from "zod";
import type { ToolDefinition } from "../providers/types.js";
import { updatePlanTool } from "./agent/plan-tool.js";
import { hypothesesTool } from "./agent/hypotheses-tool.js";
import { getOutputTool } from "./agent/output-tool.js";
import { globFilesTool, grepSearchTool, listDirectoryTool, readFileTool, searchFilesTool } from "./filesystem/read-tools.js";
import { applyPatchTool, editFileTool, writeFileTool } from "./filesystem/write-tools.js";
import { gitDiffTool, gitStatusTool } from "./git/git-tools.js";
import { executeCommandTool, runTestsTool } from "./shell/shell-tools.js";
import { diagnoseFailureTool } from "./shell/diagnose-tool.js";
import { inspectSymbolTool } from "./index/inspect-tools.js";
import { codeSearchTool, findSymbolTool, repoMapTool } from "./index/index-tools.js";
import type { Tool } from "./types.js";

const NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Tool extension interface: anything implementing `Tool` can be registered.
 * Names must be unique and valid function names for every provider.
 */
export class ToolRegistry {
  private tools = new Map<string, Tool<any>>();

  register(tool: Tool<any>): this {
    if (!NAME_RE.test(tool.name)) throw new Error(`Invalid tool name: ${tool.name}`);
    if (this.tools.has(tool.name)) throw new Error(`Duplicate tool: ${tool.name}`);
    this.tools.set(tool.name, tool);
    return this;
  }

  get(name: string): Tool<any> | undefined {
    return this.tools.get(name);
  }

  list(): Tool<any>[] {
    return [...this.tools.values()];
  }

  /** A restricted view (used for read-only profiles and delegated tasks). */
  subset(filter: (t: Tool<any>) => boolean): ToolRegistry {
    const r = new ToolRegistry();
    for (const t of this.list()) if (filter(t)) r.register(t);
    return r;
  }

  definitions(): ToolDefinition[] {
    return this.list().map((t) => ({ name: t.name, description: t.description, parameters: t.parameters ?? toJsonSchema(t.schema) }));
  }
}

export function toJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const js = z.toJSONSchema(schema, { target: "draft-7", io: "input" }) as Record<string, unknown>;
  delete js.$schema;
  return js;
}

export function createDefaultRegistry(): ToolRegistry {
  return new ToolRegistry()
    .register(readFileTool)
    .register(listDirectoryTool)
    .register(globFilesTool)
    .register(searchFilesTool)
    .register(grepSearchTool)
    .register(writeFileTool)
    .register(editFileTool)
    .register(applyPatchTool)
    .register(executeCommandTool)
    .register(runTestsTool)
    .register(diagnoseFailureTool)
    .register(gitStatusTool)
    .register(gitDiffTool)
    .register(repoMapTool)
    .register(findSymbolTool)
    .register(codeSearchTool)
    .register(inspectSymbolTool)
    .register(updatePlanTool)
    .register(hypothesesTool)
    .register(getOutputTool);
}
