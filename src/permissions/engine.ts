import type { PermissionProfile } from "../config/schema.js";
import { assessCommand, type CommandAssessment } from "./commands.js";
import type { ResolvedPath } from "./paths.js";
import { isSensitivePath, matchesAny } from "./sensitive.js";

export type PermissionCategory = "read" | "write" | "execute" | "internal" | "mcp";

export interface PermissionRequest {
  tool: string;
  category: PermissionCategory;
  paths?: ResolvedPath[];
  command?: string;
  /** Human readable one-liner shown in approval prompts. */
  summary: string;
  /** Deletes or irreversibly discards data; always needs approval. */
  destructive?: boolean;
}

export type Verdict = "allow" | "ask" | "deny";

export interface PermissionDecision {
  verdict: Verdict;
  reason: string;
  warnings: string[];
  /** Whether "allow for the rest of this session" may be offered. */
  grantable: boolean;
  grantKey?: string;
  command?: CommandAssessment;
}

export type ApprovalChoice = "once" | "session" | "deny";

export interface PermissionPolicy {
  profile: PermissionProfile;
  allowCommands: string[];
  sensitivePaths: string[];
  protectedPaths: string[];
  /** Command prefixes considered routine (e.g. the configured test command). */
  routineCommands: string[];
}

/**
 * The permission engine runs in the harness, independent of anything the
 * model or repository content says. Model output can only *request* actions;
 * this code decides.
 */
export class PermissionEngine {
  private grants = new Set<string>();
  constructor(public policy: PermissionPolicy) {}

  setProfile(profile: PermissionProfile): void {
    this.policy = { ...this.policy, profile };
    this.grants.clear();
  }

  grant(key: string): void {
    this.grants.add(key);
  }

  listGrants(): string[] {
    return [...this.grants];
  }

  evaluate(req: PermissionRequest): PermissionDecision {
    const { profile } = this.policy;
    const warnings: string[] = [];
    const paths = req.paths ?? [];
    const outside = paths.filter((p) => !p.insideWorkspace);
    const sensitive = paths.filter((p) => isSensitivePath(p.insideWorkspace ? p.display : p.absolute, this.policy.sensitivePaths));
    if (outside.length) warnings.push(`Outside the workspace: ${outside.map((p) => p.absolute).join(", ")}`);
    if (sensitive.length) warnings.push(`Possibly sensitive: ${sensitive.map((p) => p.display).join(", ")}`);

    const deny = (reason: string): PermissionDecision => ({ verdict: "deny", reason, warnings, grantable: false });
    const allow = (reason: string): PermissionDecision => ({ verdict: "allow", reason, warnings, grantable: false });
    const ask = (reason: string, grantKey?: string, command?: CommandAssessment): PermissionDecision => {
      if (grantKey && this.grants.has(grantKey)) return { verdict: "allow", reason: "allowed for this session", warnings, grantable: false };
      return { verdict: "ask", reason, warnings, grantable: !!grantKey, ...(grantKey ? { grantKey } : {}), ...(command ? { command } : {}) };
    };

    switch (req.category) {
      case "internal":
        return allow("internal bookkeeping");

      case "read": {
        if (outside.length) return profile === "inspect" ? deny("inspect profile: reads are limited to the workspace") : ask("read outside the workspace");
        if (sensitive.length) return profile === "inspect" ? deny("inspect profile: sensitive files are not readable") : ask("read a possibly sensitive file");
        return allow("workspace read");
      }

      case "write": {
        if (profile === "inspect") return deny("inspect profile is read-only");
        const gitInternal = paths.filter((p) => p.insideWorkspace && /^\.git(\/|$)/.test(p.display));
        if (gitInternal.length) return deny("direct writes into .git/ are not permitted");
        const protectedHit = paths.filter((p) => p.insideWorkspace && matchesAny(p.display, this.policy.protectedPaths));
        if (protectedHit.length) return deny(`protected path: ${protectedHit.map((p) => p.display).join(", ")}`);
        if (outside.length) return ask("write outside the workspace"); // never grantable
        if (sensitive.length) return ask("modify a possibly sensitive file");
        if (req.destructive) return ask("change deletes files");
        if (profile === "flow") return allow("flow profile: routine workspace edit");
        return ask("modify files", "write:workspace");
      }

      case "execute": {
        if (profile === "inspect") return deny("inspect profile does not run commands");
        const cmd = req.command ?? "";
        const assessment = assessCommand(cmd, [...this.policy.allowCommands, ...this.policy.routineCommands]);
        if (assessment.reasons.length) warnings.push(...assessment.reasons);
        if (outside.length) return ask("run a command outside the workspace", undefined, assessment);
        switch (assessment.risk) {
          case "privileged":
            return ask("command requests elevated privileges", undefined, assessment);
          case "destructive":
            return ask("command may be destructive", undefined, assessment);
          case "network":
            return ask("command may access the network", undefined, assessment);
          case "routine":
            if (profile === "flow") return { ...allow("flow profile: routine command"), command: assessment };
            return ask("run a command", `exec:${cmd}`, assessment);
          default:
            return ask("run a command", `exec:${cmd}`, assessment);
        }
      }

      case "mcp": {
        // A remote MCP tool's behaviour is opaque to the harness: it can read,
        // write, run code or send data anywhere. Never classify it as read-only,
        // and never offer a blanket session grant.
        if (profile === "inspect") return deny("inspect profile does not call MCP tools");
        return ask("call an MCP tool; its effects are controlled by the server, not by Sutra");
      }
    }
  }
}
