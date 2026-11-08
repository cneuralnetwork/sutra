import { createServer } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { ConfigSchema, ProjectConfigSchema } from "../../src/config/schema.js";
import { PlanStore } from "../../src/core/planning/plan.js";
import {
  buildMcpToolName,
  collectMcpSecrets,
  compileMcpInputSchema,
  connectMcpServers,
  createMcpToolAdapter,
  formatMcpCallResult,
  type McpRuntime,
} from "../../src/mcp/client.js";
import { PermissionEngine, type PermissionPolicy } from "../../src/permissions/engine.js";
import { Workspace } from "../../src/permissions/paths.js";
import { SecretRedactor } from "../../src/permissions/sensitive.js";
import { FileStateTracker } from "../../src/tools/file-state.js";
import { createDefaultRegistry } from "../../src/tools/registry.js";
import type { ToolContext } from "../../src/tools/types.js";
import { createHarness, tempDir, testConfig, type Harness } from "../helpers/harness.js";
import { ScriptedProvider } from "../helpers/scripted-provider.js";

const fixture = fileURLToPath(new URL("../fixtures/mcp-echo-server.mjs", import.meta.url));
const TOKEN = "mcp-test-secret-value-1234567890";

const mcpConfig = ConfigSchema.parse({
  mcpServers: {
    echo: {
      command: process.execPath,
      args: [fixture],
      env: { MCP_TEST_TOKEN: TOKEN },
    },
  },
});

function toolContext(root: string): ToolContext {
  return {
    workspace: new Workspace(root),
    fileState: new FileStateTracker(),
    plan: new PlanStore(),
    redactor: new SecretRedactor(),
    signal: new AbortController().signal,
    sessionId: "s",
    toolCallId: "call1",
    settings: { commandTimeoutMs: 10_000, maxOutputChars: 30_000, retainFullLogs: false, scrubEnv: true, logDir: join(root, ".logs") },
  };
}

function policy(profile: PermissionPolicy["profile"]): PermissionPolicy {
  return { profile, allowCommands: [], sensitivePaths: [], protectedPaths: [], routineCommands: [] };
}

/** A stateless Streamable HTTP MCP server used to exercise the remote transport. */
async function startHttpMcpServer(): Promise<{ url: string; seenAuth: string[]; close(): Promise<void> }> {
  const seenAuth: string[] = [];
  const http = createServer(async (req, res) => {
    seenAuth.push(String(req.headers.authorization ?? ""));
    if (req.method !== "POST") {
      res.writeHead(405).end();
      return;
    }
    const server = new McpServer({ name: "sutra-http-mcp", version: "0.1.0" });
    server.registerTool(
      "echo_http",
      { description: "Echo over HTTP.", inputSchema: { text: z.string() } },
      async ({ text }) => ({ content: [{ type: "text", text: `http:${text}` }] }),
    );
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await server.connect(transport);
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    await transport.handleRequest(req, res);
  });
  await new Promise<void>((resolve, reject) => {
    http.once("error", reject);
    http.listen(0, "127.0.0.1", resolve);
  });
  const address = http.address();
  if (!address || typeof address === "string") throw new Error("test HTTP server has no port");
  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    seenAuth,
    async close() {
      await new Promise<void>((resolve) => http.close(() => resolve()));
    },
  };
}

let mcp: McpRuntime;
let h: Harness | undefined;

beforeAll(async () => {
  mcp = await connectMcpServers(mcpConfig, tempDir("sutra-mcp-ws-"));
});

afterAll(async () => {
  await mcp.close();
});

afterEach(() => {
  h?.cleanup();
  h = undefined;
});

describe("MCP configuration", () => {
  it("accepts stdio and HTTP servers with safe defaults", () => {
    const stdio = ConfigSchema.parse({ mcpServers: { local: { command: "node", args: ["server.js"] } } }).mcpServers.local!;
    expect(stdio).toMatchObject({ enabled: true, args: ["server.js"], env: {}, inheritEnv: [], headers: {}, connectTimeoutMs: 20_000, toolTimeoutMs: 120_000 });

    const http = ConfigSchema.parse({ mcpServers: { remote: { url: "https://example.com/mcp", headers: { Authorization: "Bearer x" } } } }).mcpServers.remote!;
    expect(http).toMatchObject({ url: "https://example.com/mcp", headers: { Authorization: "Bearer x" } });
  });

  it("rejects ambiguous or incomplete transports and unsafe server names", () => {
    expect(() => ConfigSchema.parse({ mcpServers: { x: { command: "node", url: "https://example.com" } } })).toThrow();
    expect(() => ConfigSchema.parse({ mcpServers: { x: { args: [] } } })).toThrow();
    expect(() => ConfigSchema.parse({ mcpServers: { x: { type: "http" } } })).toThrow();
    expect(() => ConfigSchema.parse({ mcpServers: { "bad name": { command: "node" } } })).toThrow(/server names/i);
    expect(() => ConfigSchema.parse({ mcpServers: { ["a".repeat(40)]: { command: "node" } } })).toThrow(/server names/i);
    // Cross-transport settings are rejected instead of being silently ignored.
    expect(() => ConfigSchema.parse({ mcpServers: { x: { command: "node", headers: { Authorization: "x" } } } })).toThrow(/headers/i);
    expect(() => ConfigSchema.parse({ mcpServers: { x: { url: "https://example.com/mcp", env: { A: "b" } } } })).toThrow(/env/i);
    expect(() => ConfigSchema.parse({ mcpServers: { x: { url: "https://example.com/mcp", cwd: "." } } })).toThrow(/cwd/i);
  });

  it("rejects unsafe env, header and URL values", () => {
    expect(() => ConfigSchema.parse({ mcpServers: { x: { command: "node", env: { "BAD-NAME": "v" } } } })).toThrow(/Environment variable/i);
    expect(() => ConfigSchema.parse({ mcpServers: { x: { command: "node", inheritEnv: ["BAD-NAME"] } } })).toThrow(/Environment variable/i);
    expect(() => ConfigSchema.parse({ mcpServers: { x: { url: "ftp://example.com/mcp" } } })).toThrow(/http:\/\//i);
    expect(() => ConfigSchema.parse({ mcpServers: { x: { url: "https://user:pass@example.com/mcp" } } })).toThrow(/credentials/i);
    expect(() => ConfigSchema.parse({ mcpServers: { x: { url: "https://example.com/mcp", headers: { "Bad Header": "x" } } } })).toThrow(/header name/i);
    expect(() => ConfigSchema.parse({ mcpServers: { x: { url: "https://example.com/mcp", headers: { "X-Test": "a\nb" } } } })).toThrow(/newlines/i);
  });

  it("is user-config only: project config strips mcpServers", () => {
    const parsed = ProjectConfigSchema.parse({ model: "m", mcpServers: { evil: { command: "rm" } } });
    expect(parsed).not.toHaveProperty("mcpServers");
  });

  it("collects env and header values for redaction", () => {
    const secrets = collectMcpSecrets(
      ConfigSchema.parse({
        mcpServers: {
          a: { command: "node", env: { API_TOKEN: TOKEN } },
          b: { url: "https://example.com/mcp", headers: { Authorization: `Bearer ${TOKEN}` } },
        },
      }),
    );
    expect(secrets).toContain(TOKEN);
  });
});

describe("MCP tool naming and schemas", () => {
  it("prefixes names and stays inside provider limits", () => {
    expect(buildMcpToolName("fs", "read_file")).toBe("mcp_fs_read_file");
    const long = buildMcpToolName("s".repeat(20), "t".repeat(60));
    expect(long.length).toBeLessThanOrEqual(64);
    expect(long).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
    const foreign = buildMcpToolName("echo", "read.file");
    expect(foreign).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
  });

  it("disambiguates collisions deterministically", () => {
    const taken = new Set(["mcp_echo_echo"]);
    const a = buildMcpToolName("echo", "echo", taken);
    expect(a).not.toBe("mcp_echo_echo");
    expect(buildMcpToolName("echo", "echo", taken)).toBe(a);
    expect(buildMcpToolName("echo", "echo", new Set([...taken, a]))).not.toBe(a);
  });

  it("preserves the server schema while validating required arguments", () => {
    const compiled = compileMcpInputSchema({
      type: "object",
      properties: { text: { type: "string" }, limit: { type: "integer" } },
      required: ["text"],
      additionalProperties: false,
    });
    expect(compiled.parameters).toMatchObject({ type: "object", required: ["text"], additionalProperties: false });
    expect(compiled.schema.safeParse({ text: "hello" }).success).toBe(true);
    expect(compiled.schema.safeParse({}).success).toBe(false);
    expect(compiled.parameters).not.toHaveProperty("$schema");
  });

  it("formats text, binary, resource and structured content", () => {
    const text = formatMcpCallResult({ content: [{ type: "text", text: "hi" }] });
    expect(text).toEqual({ output: "hi", isError: false });

    const mixed = formatMcpCallResult({
      content: [
        { type: "text", text: "see attached" },
        { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
        { type: "resource", resource: { uri: "file:///x", mimeType: "text/plain", text: "body" } },
      ],
      structuredContent: { ok: true },
      isError: false,
    });
    expect(mixed.output).toContain("see attached");
    expect(mixed.output).toContain("[image: image/png");
    expect(mixed.output).toContain("[resource file:///x (text/plain)]");
    expect(mixed.output).toContain('"ok": true');
  });

  it("redacts server-controlled descriptions and results", async () => {
    const adapters: string[] = [];
    const tool = createMcpToolAdapter({
      server: "echo",
      transport: "stdio",
      localName: "mcp_echo_leak",
      remote: {
        name: "leak",
        description: `description contains ${TOKEN}`,
        inputSchema: { type: "object" as const, properties: {} },
        annotations: { title: `title ${TOKEN}` },
      },
      client: {
        async callTool() {
          return { content: [{ type: "text", text: `output ${TOKEN}` }] };
        },
      },
      timeoutMs: 1_000,
      redact: (text) => {
        adapters.push(text);
        return text.split(TOKEN).join("[redacted-secret]");
      },
    });
    expect(tool.description).not.toContain(TOKEN);
    expect(tool.description).toContain("[redacted-secret]");
    const res = await tool.execute({}, toolContext(tempDir("sutra-mcp-ws-")));
    expect(res.ok).toBe(true);
    expect(res.output).not.toContain(TOKEN);
    expect(res.output).toContain("[redacted-secret]");
    expect(adapters.length).toBeGreaterThan(0);
  });
});

describe("MCP permission policy", () => {
  it("denies in inspect and always asks in confirm and flow", () => {
    for (const profile of ["inspect", "confirm", "flow"] as const) {
      const decision = new PermissionEngine(policy(profile)).evaluate({ tool: "mcp_echo_echo", category: "mcp", summary: "echo" });
      if (profile === "inspect") expect(decision.verdict).toBe("deny");
      else expect(decision).toMatchObject({ verdict: "ask", grantable: false });
    }
  });
});

describe("MCP stdio server", () => {
  it("connects, discovers tools and exposes their schemas", () => {
    expect(mcp.warnings).toEqual([]);
    expect(mcp.servers).toEqual([{ name: "echo", transport: "stdio", serverVersion: { name: "sutra-test-mcp", version: "1.2.3" }, toolCount: 5 }]);
    expect(mcp.tools.map((t) => t.name).sort()).toEqual(["mcp_echo_add", "mcp_echo_binary", "mcp_echo_echo", "mcp_echo_fail", "mcp_echo_secret"]);
    const echo = mcp.tools.find((t) => t.name === "mcp_echo_echo")!;
    expect(echo.description).toContain("[MCP echo · echo]");
    expect(echo.category).toBe("mcp");
    expect(echo.readOnly).toBe(false);
    expect(echo.parameters).toMatchObject({ type: "object", properties: { text: { type: "string" } }, required: ["text"] });
    expect(echo.schema.safeParse({ text: "hi" }).success).toBe(true);
    expect(echo.schema.safeParse({ nope: 1 }).success).toBe(false);
  });

  it("calls tools and maps structured output and tool errors", async () => {
    const ctx = toolContext(tempDir("sutra-mcp-ws-"));
    const add = mcp.tools.find((t) => t.name === "mcp_echo_add")!;
    const added = await add.execute(add.schema.parse({ a: 2, b: 3 }), ctx);
    expect(added.ok).toBe(true);
    expect(added.output).toContain("5");
    expect(added.output).toContain('"sum": 5');

    const binary = mcp.tools.find((t) => t.name === "mcp_echo_binary")!;
    const mixed = await binary.execute(binary.schema.parse({}), ctx);
    expect(mixed.output).toContain("see attached");
    expect(mixed.output).toContain("[image: image/png");

    const failed = mcp.tools.find((t) => t.name === "mcp_echo_fail")!;
    const err = await failed.execute(failed.schema.parse({ message: "it broke" }), ctx);
    expect(err.ok).toBe(false);
    expect(err.error?.code).toBe("execution_failed");
    expect(err.output).toContain("it broke");
  });

  it("runs through the agent harness, asks first and redacts MCP secrets", async () => {
    const provider = new ScriptedProvider([
      { toolCalls: [{ id: "m1", name: "mcp_echo_echo", args: { text: "through the runtime" } }] },
      { toolCalls: [{ id: "m2", name: "mcp_echo_secret", args: {} }] },
      { content: "done" },
    ]);
    const cfg = testConfig({ mcpServers: mcpConfig.mcpServers });
    const tools = createDefaultRegistry();
    for (const tool of mcp.tools) tools.register(tool);
    h = createHarness({ provider, config: cfg, tools, extraSecrets: collectMcpSecrets(mcpConfig), approve: () => "once" });

    const result = await h.session.runtime.runTurn("use mcp");
    expect(result.status).toBe("completed");
    expect(result.toolCalls).toBe(2);
    expect(h.approvals).toHaveLength(2);
    expect(h.approvals[0]!.decision.reason).toContain("MCP");
    expect(h.approvals[0]!.decision.grantable).toBe(false);

    const toolMessages = h.session.context.messages().filter((m) => m.role === "tool");
    expect(toolMessages[0]!.content).toContain("through the runtime");
    expect(toolMessages[1]!.content).toContain("[redacted-secret]");
    expect(toolMessages[1]!.content).not.toContain(TOKEN);
  });

  it("keeps MCP tools out of inspect sessions", () => {
    const cfg = testConfig();
    cfg.permissions.profile = "inspect";
    const tools = createDefaultRegistry();
    for (const tool of mcp.tools) tools.register(tool);
    h = createHarness({ provider: new ScriptedProvider([{ content: "ok" }]), config: cfg, tools });
    expect(h.session.tools.get("read_file")).toBeDefined();
    expect(h.session.tools.get("mcp_echo_echo")).toBeUndefined();
  });

  it("does not start MCP servers at all in the inspect profile", async () => {
    const inspect = ConfigSchema.parse({ permissions: { profile: "inspect" }, mcpServers: mcpConfig.mcpServers });
    const runtime = await connectMcpServers(inspect, tempDir("sutra-mcp-ws-"));
    expect(runtime.tools).toEqual([]);
    expect(runtime.servers).toEqual([]);
    await runtime.close();
  });

  it("turns a broken server into a warning instead of a startup failure", async () => {
    const broken = ConfigSchema.parse({ mcpServers: { missing: { command: "/definitely/no/such/mcp-server-xyz" } } });
    const runtime = await connectMcpServers(broken, tempDir("sutra-mcp-ws-"));
    expect(runtime.tools).toEqual([]);
    expect(runtime.warnings).toHaveLength(1);
    expect(runtime.warnings[0]).toContain('MCP server "missing" unavailable');
    await runtime.close();
  });

  it("assigns colliding tool names deterministically regardless of connect timing", async () => {
    // Both server names truncate to the same 20-character prefix, so their
    // `echo` tools share a base name.
    const prefix = "a".repeat(20);
    const cfg = ConfigSchema.parse({
      mcpServers: {
        [`${prefix}X`]: { command: process.execPath, args: [fixture] },
        [`${prefix}Y`]: { command: process.execPath, args: [fixture] },
      },
    });
    const echoNames = (runtime: McpRuntime) =>
      runtime.tools
        .map((t) => t.name)
        .filter((name) => name.includes("_echo"))
        .sort();
    const first = await connectMcpServers(cfg, tempDir("sutra-mcp-ws-"));
    const second = await connectMcpServers(cfg, tempDir("sutra-mcp-ws-"));
    try {
      expect(first.warnings).toEqual([]);
      expect(echoNames(first)).toHaveLength(2);
      expect(new Set(echoNames(first)).size).toBe(2);
      expect(echoNames(second)).toEqual(echoNames(first));
    } finally {
      await first.close();
      await second.close();
    }
  });

  it("connects over Streamable HTTP and sends configured headers", async () => {
    const server = await startHttpMcpServer();
    const runtimeConfig = ConfigSchema.parse({
      mcpServers: {
        remote: { type: "http", url: server.url, headers: { Authorization: `Bearer ${TOKEN}` } },
      },
    });
    const runtime = await connectMcpServers(runtimeConfig, tempDir("sutra-mcp-ws-"));
    try {
      expect(runtime.warnings).toEqual([]);
      expect(runtime.servers).toEqual([
        { name: "remote", transport: "http", serverVersion: { name: "sutra-http-mcp", version: "0.1.0" }, toolCount: 1 },
      ]);
      const tool = runtime.tools[0]!;
      expect(tool.name).toBe("mcp_remote_echo_http");
      const res = await tool.execute(tool.schema.parse({ text: "hello" }), toolContext(tempDir("sutra-mcp-ws-")));
      expect(res).toMatchObject({ ok: true, output: "http:hello" });
      expect(server.seenAuth).toContain(`Bearer ${TOKEN}`);
    } finally {
      await runtime.close();
      await server.close();
    }
  });
});

describe("MCP runtime behavior", () => {
  it("refuses MCP calls in plan mode without prompting", async () => {
    const provider = new ScriptedProvider([
      { toolCalls: [{ id: "m1", name: "mcp_echo_echo", args: { text: "nope" } }] },
      { content: "planned" },
    ]);
    const cfg = testConfig({ mcpServers: mcpConfig.mcpServers });
    const tools = createDefaultRegistry();
    for (const tool of mcp.tools) tools.register(tool);
    h = createHarness({ provider, config: cfg, tools, extraSecrets: collectMcpSecrets(mcpConfig) });

    const result = await h.session.runtime.runTurn("plan it", undefined, { mode: "plan" });
    expect(result.status).toBe("completed");
    expect(h.approvals).toHaveLength(0);
    const toolMessages = h.session.context.messages().filter((m) => m.role === "tool");
    expect(toolMessages[0]!.content).toContain("Plan mode");
  });

  it("redacts MCP secrets from events and persisted invocations", async () => {
    const provider = new ScriptedProvider([
      { toolCalls: [{ id: "m1", name: "mcp_echo_echo", args: { text: `arg ${TOKEN}` } }] },
      { content: "done" },
    ]);
    const cfg = testConfig({ mcpServers: mcpConfig.mcpServers });
    const tools = createDefaultRegistry();
    for (const tool of mcp.tools) tools.register(tool);
    h = createHarness({ provider, config: cfg, tools, extraSecrets: collectMcpSecrets(mcpConfig), approve: () => "once" });

    await h.session.runtime.runTurn("leak check");
    const invocations = h.store.listToolInvocations(h.session.record.id);
    expect(invocations).toHaveLength(1);
    expect(invocations[0]!.arguments).not.toContain(TOKEN);
    expect(invocations[0]!.arguments).toContain("[redacted-secret]");
    expect(invocations[0]!.output).not.toContain(TOKEN);
    for (const event of h.events) expect(JSON.stringify(event)).not.toContain(TOKEN);
  });
});
