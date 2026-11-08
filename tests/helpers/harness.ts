import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ConfigSchema, type SutraConfig } from "../../src/config/schema.js";
import { DEFAULT_PRICING } from "../../src/config/pricing.js";
import type { ApprovalRequest, AgentEvent } from "../../src/core/events/types.js";
import { openSession, type SessionHandle } from "../../src/core/session.js";
import { SessionStore } from "../../src/memory/store.js";
import type { ApprovalChoice } from "../../src/permissions/engine.js";
import type { ModelProvider } from "../../src/providers/types.js";
import type { SandboxStatus } from "../../src/sandbox/sandbox.js";
import type { ToolRegistry } from "../../src/tools/registry.js";

export function tempDir(prefix = "sutra-test-"): string {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

export function writeFiles(root: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    const p = join(root, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, content);
  }
}

export function testConfig(overrides: Partial<SutraConfig> = {}): SutraConfig {
  const c = ConfigSchema.parse({});
  c.model = "deepseek-flash";
  c.pricing = { ...DEFAULT_PRICING };
  c.providers.deepseek.apiKey = "sk-test-key-0000000000000000";
  // Quality layers that make extra model calls would consume scripted replies; tests opt in explicitly.
  c.quality.mode = "fast";
  return { ...c, ...overrides };
}

export interface Harness {
  workspace: string;
  home: string;
  store: SessionStore;
  session: SessionHandle;
  events: AgentEvent[];
  approvals: ApprovalRequest[];
  cleanup(): void;
}

export function createHarness(opts: {
  provider: ModelProvider;
  files?: Record<string, string>;
  config?: SutraConfig;
  approve?: (r: ApprovalRequest) => ApprovalChoice | Promise<ApprovalChoice>;
  workspace?: string;
  dbFile?: string;
  resumeId?: string;
  sandbox?: SandboxStatus;
  tools?: ToolRegistry;
  extraSecrets?: string[];
}): Harness {
  const workspace = opts.workspace ?? tempDir();
  const home = tempDir("sutra-home-");
  process.env.SUTRA_HOME = home;
  if (opts.files) writeFiles(workspace, opts.files);
  const store = new SessionStore(opts.dbFile ?? ":memory:");
  const events: AgentEvent[] = [];
  const approvals: ApprovalRequest[] = [];
  const session = openSession({
    config: opts.config ?? testConfig(),
    provider: opts.provider,
    store,
    workspaceRoot: workspace,
    ...(opts.resumeId ? { resumeId: opts.resumeId } : {}),
    ...(opts.sandbox ? { sandbox: opts.sandbox } : {}),
    ...(opts.tools ? { tools: opts.tools } : {}),
    ...(opts.extraSecrets ? { extraSecrets: opts.extraSecrets } : {}),
    approve: async (r) => {
      approvals.push(r);
      return opts.approve ? opts.approve(r) : "once";
    },
  });
  session.runtime.on((e) => events.push(e));
  return {
    workspace,
    home,
    store,
    session,
    events,
    approvals,
    cleanup() {
      store.close();
      rmSync(home, { recursive: true, force: true });
      if (!opts.workspace) rmSync(workspace, { recursive: true, force: true });
    },
  };
}
