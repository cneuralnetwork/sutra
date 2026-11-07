import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { CompatibilityCallToolResultSchema, ErrorCode, McpError, type Tool as McpToolDefinition } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { McpServerConfig, SutraConfig } from "../config/schema.js";
import { SecretRedactor } from "../permissions/sensitive.js";
import { log } from "../telemetry/logger.js";
import { fail, ok, type Tool, type ToolContext, type ToolPreview, type ToolResult } from "../tools/types.js";
import { oneLine, truncateMiddle } from "../utils/text.js";
import { version } from "../version.js";

const MAX_LIST_PAGES = 20;
const MAX_TOOLS_PER_SERVER = 200;
const MAX_DESCRIPTION_CHARS = 4_000;

export interface ConnectedMcpServer {
  name: string;
  transport: "stdio" | "http";
  serverVersion?: { name: string; version: string };
  toolCount: number;
}

export interface McpRuntime {
  tools: Tool<Record<string, unknown>>[];
  servers: ConnectedMcpServer[];
  warnings: string[];
  close(): Promise<void>;
}

/**
 * Sanitize a server or remote tool name into a provider-safe function name
 * (`[A-Za-z0-9_-]{1,64}`). Collisions get a deterministic hash suffix so
 * two distinct remote tools on the same server never overwrite each other.
 */
export function buildMcpToolName(server: string, remoteName: string, taken: ReadonlySet<string> = new Set()): string {
  const s = sanitizePart(server, 20);
  const t = sanitizePart(remoteName, 36);
  const base = trimName(`mcp_${s}_${t}`) || `mcp_${s}_tool`;
  if (!taken.has(base)) return base;

  const suffix = createHash("sha256").update(`${server}\0${remoteName}`).digest("hex").slice(0, 6);
  let name = withSuffix(base, suffix);
  let i = 2;
  while (taken.has(name)) name = withSuffix(base, `${suffix}${i++}`);
  return name;
}

function trimName(raw: string): string {
  const clean = raw.slice(0, 64).replace(/[-_]+$/, "");
  return /^[A-Za-z0-9_-]{1,64}$/.test(clean) ? clean : "";
}

function withSuffix(base: string, suffix: string): string {
  const stem = base.slice(0, Math.max(1, 64 - 1 - suffix.length)).replace(/[-_]+$/, "") || "mcp";
  return `${stem}_${suffix}`;
}

function sanitizePart(raw: string, max: number): string {
  const clean = raw
    .replace(/[^A-Za-z0-9_-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^[-_]+|[-_]+$/g, "")
    .slice(0, max);
  return clean || "x";
}

/**
 * Normalize an MCP `inputSchema` so every provider accepts it as a function
 * `parameters` schema, and compile a Zod validator for harness-side checks.
 */
export function compileMcpInputSchema(raw: unknown): {
  parameters: Record<string, unknown>;
  schema: z.ZodType<Record<string, unknown>>;
} {
  const parameters = normalizeParameters(raw);
  try {
    const fromJson = z.fromJSONSchema(parameters as Parameters<typeof z.fromJSONSchema>[0]) as z.ZodType<unknown>;
    const schema = z.custom<Record<string, unknown>>().transform((val, ctx) => {
      if (!isPlainObject(val)) {
        ctx.addIssue({ code: "custom", message: "Arguments must be a JSON object" });
        return z.NEVER;
      }
      const parsed = fromJson.safeParse(val);
      if (!parsed.success) {
        for (const issue of parsed.error.issues) ctx.addIssue({ code: "custom", path: issue.path, message: issue.message });
        return z.NEVER;
      }
      return (isPlainObject(parsed.data) ? parsed.data : val) as Record<string, unknown>;
    });
    return { parameters, schema };
  } catch {
    // Some valid JSON Schemas use keywords z.fromJSONSchema does not support;
    // keep lightweight required/type checks so the tool still works.
    return { parameters, schema: fallbackSchema(parameters) };
  }
}

function normalizeParameters(raw: unknown): Record<string, unknown> {
  if (!isPlainObject(raw)) return { type: "object", properties: {} };
  const copy: Record<string, unknown> = { ...raw, type: "object" };
  delete copy.$schema;
  if (!isPlainObject(copy.properties)) copy.properties = {};
  if (!Array.isArray(copy.required)) delete copy.required;
  return copy;
}

function fallbackSchema(parameters: Record<string, unknown>): z.ZodType<Record<string, unknown>> {
  const required = Array.isArray(parameters.required) ? parameters.required.filter((k): k is string => typeof k === "string") : [];
  return z.record(z.string(), z.unknown()).superRefine((obj, ctx) => {
    for (const key of required) {
      if (!(key in obj) || obj[key] === undefined) {
        ctx.addIssue({ code: "custom", path: [key], message: `Missing required property "${key}"` });
      }
    }
  });
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Strip terminal escape sequences and control characters from server-controlled text. */
function sanitizeText(text: string): string {
  return text
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, " ")
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, " ")
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, " ");
}

/**
 * Format an MCP `CallToolResult` as plain text for the model. Non-text items
 * are represented explicitly so nothing happens silently; the runtime applies
 * the configured size limit afterwards.
 */
export function formatMcpCallResult(raw: Record<string, unknown>): { output: string; isError: boolean } {
  const isError = raw.isError === true;
  const parts: string[] = [];

  if (Array.isArray(raw.content)) {
    for (const item of raw.content) {
      if (!isPlainObject(item)) continue;
      switch (item.type) {
        case "text":
          if (typeof item.text === "string" && item.text.length > 0) parts.push(item.text);
          break;
        case "resource": {
          const res = isPlainObject(item.resource) ? item.resource : {};
          const uri = typeof res.uri === "string" ? res.uri : "resource";
          const mime = typeof res.mimeType === "string" ? ` (${res.mimeType})` : "";
          if (typeof res.text === "string") {
            parts.push(`[resource ${uri}${mime}]\n${res.text}`);
          } else if (typeof res.blob === "string") {
            parts.push(`[binary resource ${uri}${mime}: ${res.blob.length} base64 chars]`);
          } else {
            parts.push(`[resource ${uri}${mime}]`);
          }
          break;
        }
        case "resource_link": {
          const uri = typeof item.uri === "string" ? item.uri : "";
          const name = typeof item.name === "string" ? item.name : uri;
          const desc = typeof item.description === "string" ? ` — ${item.description}` : "";
          parts.push(`[resource link: ${name}${uri && uri !== name ? ` (${uri})` : ""}${desc}]`);
          break;
        }
        case "image": {
          const mime = typeof item.mimeType === "string" ? item.mimeType : "image";
          const size = typeof item.data === "string" ? `${item.data.length} base64 chars` : "omitted";
          parts.push(`[image: ${mime}, ${size}]`);
          break;
        }
        case "audio": {
          const mime = typeof item.mimeType === "string" ? item.mimeType : "audio";
          const size = typeof item.data === "string" ? `${item.data.length} base64 chars` : "omitted";
          parts.push(`[audio: ${mime}, ${size}]`);
          break;
        }
        default:
          parts.push(safeJson(item));
      }
    }
  } else if (Array.isArray(raw.toolResult)) {
    parts.push(safeJson(raw.toolResult));
  } else if ("toolResult" in raw && raw.toolResult !== undefined) {
    parts.push(typeof raw.toolResult === "string" ? raw.toolResult : safeJson(raw.toolResult));
  }

  if (isPlainObject(raw.structuredContent) && Object.keys(raw.structuredContent).length > 0) {
    const json = safeJson(raw.structuredContent);
    if (!parts.includes(json)) parts.push(parts.length ? `Structured content:\n${json}` : json);
  }

  const output = parts.join("\n\n").trim() || (isError ? "MCP tool reported an error with no message." : "(no output)");
  return { output, isError };
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

export interface McpToolCallClient {
  callTool(name: string, args: Record<string, unknown>, signal: AbortSignal, timeoutMs: number): Promise<Record<string, unknown>>;
}

/**
 * Wrap one tool advertised by an MCP server as a first-class Sutra `Tool`.
 */
export function createMcpToolAdapter(opts: {
  server: string;
  transport: "stdio" | "http";
  localName: string;
  remote: McpToolDefinition;
  client: McpToolCallClient;
  timeoutMs: number;
  /** Applied to server-controlled text before it reaches the model, UI or logs. */
  redact?: (text: string) => string;
}): Tool<Record<string, unknown>> {
  const { server, transport, localName, remote, client, timeoutMs } = opts;
  const redact = opts.redact ?? ((text: string) => text);
  const { parameters, schema } = compileMcpInputSchema(remote.inputSchema);
  const displayName = sanitizeText(redact(remote.name));
  const rawTitle = remote.annotations?.title ?? remote.title;
  const title = rawTitle ? oneLine(sanitizeText(redact(rawTitle)), 100) : undefined;
  // A server controls its own description, so redact known secrets, strip
  // terminal escapes and cap the size before it becomes part of every request.
  const descBody = truncateMiddle(
    sanitizeText(redact(remote.description?.trim() || rawTitle?.trim() || `Tool "${remote.name}" on MCP server "${server}".`)),
    MAX_DESCRIPTION_CHARS,
  ).text;
  const destructive = remote.annotations?.destructiveHint === true;

  return {
    name: localName,
    description: `[MCP ${server} · ${displayName}] ${descBody}`,
    version: "1.0.0",
    schema,
    parameters,
    category: "mcp",
    // Remote tool annotations are untrusted hints, so MCP calls never run
    // unapproved or in parallel batches.
    readOnly: false,
    timeoutMs,
    describe(args: Record<string, unknown>, ctx: ToolContext) {
      const argText = sanitizeText(ctx.redactor.redact(summarizeArgs(args)));
      return {
        tool: localName,
        category: "mcp",
        summary: `${server}/${displayName}${argText ? ` ${argText}` : ""}`,
        ...(destructive ? { destructive: true } : {}),
      };
    },
    async preview(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolPreview> {
      const details = [`Server: ${server} (${transport})`, `Tool:   ${displayName}`];
      if (title && title !== displayName) details.push(`Title:  ${title}`);
      const keys = Object.keys(args);
      if (keys.length === 0) {
        details.push("Args:   {}");
      } else {
        const pretty = sanitizeText(ctx.redactor.redact(safeJson(args)));
        for (const line of truncateMiddle(pretty, 600).text.split("\n").slice(0, 12)) {
          details.push(`        ${line}`);
        }
      }
      return { summary: `${server}/${displayName}`, details };
    },
    async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
      try {
        const res = await client.callTool(remote.name, args, ctx.signal, timeoutMs);
        const { output, isError } = formatMcpCallResult(res);
        const safeOutput = sanitizeText(redact(output));
        const data = { mcpServer: server, mcpTool: remote.name };
        if (isError) return fail("execution_failed", safeOutput, { data });
        return ok(safeOutput, data);
      } catch (err) {
        if (ctx.signal.aborted) return fail("cancelled", "Cancelled by user");
        if (err instanceof McpError && err.code === ErrorCode.RequestTimeout) {
          return fail("timeout", sanitizeText(redact(`MCP tool ${server}/${remote.name} timed out after ${timeoutMs} ms`)), { retryable: true });
        }
        const msg = err instanceof Error ? err.message : String(err);
        return fail("execution_failed", sanitizeText(redact(`MCP ${server}/${remote.name} failed: ${msg}`)));
      }
    },
  };
}

function summarizeArgs(args: Record<string, unknown>): string {
  const entries = Object.entries(args);
  if (entries.length === 0) return "";
  const parts = entries.slice(0, 3).map(([k, v]) => {
    const val = typeof v === "string" ? JSON.stringify(oneLine(v, 36)) : oneLine(safeJson(v), 36);
    return `${k}=${val}`;
  });
  if (entries.length > 3) parts.push(`+${entries.length - 3} more`);
  return `(${parts.join(", ")})`;
}

/**
 * Connect to all enabled MCP servers in user config, discover their tools, and
 * return Sutra `Tool` adapters plus a single `close()` handle. A broken server
 * produces a warning instead of aborting startup so one offline server does not
 * block local work.
 */
interface ServerSetup {
  name: string;
  transport: "stdio" | "http";
  tools: McpToolDefinition[];
  truncated: boolean;
  toolTimeoutMs: number;
  serverVersion?: { name: string; version: string };
  callClient: McpToolCallClient;
  close(): Promise<void>;
}

type ServerResult = { ok: true; setup: ServerSetup } | { ok: false; warning: string };

async function discoverTools(
  client: Client,
  connectTimeoutMs: number,
): Promise<{ tools: McpToolDefinition[]; truncated: boolean }> {
  const discovered: McpToolDefinition[] = [];
  let cursor: string | undefined;
  let truncated = false;
  for (let page = 0; page < MAX_LIST_PAGES; page++) {
    const res = await client.listTools(cursor ? { cursor } : undefined, { timeout: connectTimeoutMs });
    for (const tool of res.tools) {
      if (discovered.length >= MAX_TOOLS_PER_SERVER) {
        truncated = true;
        break;
      }
      discovered.push(tool);
    }
    if (truncated) break;
    if (!res.nextCursor) break;
    cursor = res.nextCursor;
    if (page === MAX_LIST_PAGES - 1) truncated = true;
  }
  return { tools: discovered, truncated };
}

export async function connectMcpServers(
  config: SutraConfig,
  workspaceRoot: string,
  opts: { reservedNames?: Iterable<string>; env?: NodeJS.ProcessEnv } = {},
): Promise<McpRuntime> {
  const entries = Object.entries(config.mcpServers ?? {}).filter(([, s]) => s.enabled);
  if (entries.length === 0) {
    return { tools: [], servers: [], warnings: [], close: async () => {} };
  }
  // Inspect promises that nothing is executed. Starting a stdio server is
  // itself execution, so the whole MCP layer stays off in that profile.
  if (config.permissions.profile === "inspect") {
    return { tools: [], servers: [], warnings: [], close: async () => {} };
  }

  const taken = new Set<string>(opts.reservedNames ?? []);
  const tools: Tool<Record<string, unknown>>[] = [];
  const servers: ConnectedMcpServer[] = [];
  const warnings: string[] = [];
  const closers: (() => Promise<void>)[] = [];
  const env = opts.env ?? process.env;
  const redactor = new SecretRedactor();
  for (const secret of collectMcpSecrets(config, env)) redactor.add(secret);
  const redact = (text: string) => redactor.redact(text);

  const results = await Promise.all(
    entries.map(async ([name, serverCfg]): Promise<ServerResult> => {
      let transport: Transport | undefined;
      let client: Client | undefined;
      let errorContext = () => "";
      try {
        const created = createTransport(serverCfg, workspaceRoot, env);
        transport = created.transport;
        errorContext = created.errorContext;
        client = new Client({ name: "sutra", version: version() });
        await client.connect(transport, { timeout: serverCfg.connectTimeoutMs });

        const discovered = await discoverTools(client, serverCfg.connectTimeoutMs);
        const connectedClient = client;
        const callClient: McpToolCallClient = {
          async callTool(remoteName, args, signal, timeoutMs) {
            return (await connectedClient.callTool(
              { name: remoteName, arguments: args },
              CompatibilityCallToolResultSchema,
              { signal, timeout: timeoutMs },
            )) as Record<string, unknown>;
          },
        };
        const sv = client.getServerVersion();
        const closeOne = async () => {
          try {
            await connectedClient.close();
          } catch {
            try {
              await transport?.close();
            } catch {
              /* ignore shutdown errors */
            }
          }
        };
        log().info({ mcpServer: name, transport: created.kind, tools: discovered.tools.length }, "mcp connected");
        return {
          ok: true,
          setup: {
            name,
            transport: created.kind,
            tools: discovered.tools,
            truncated: discovered.truncated,
            toolTimeoutMs: serverCfg.toolTimeoutMs,
            ...(sv ? { serverVersion: { name: sv.name, version: sv.version } } : {}),
            callClient,
            close: closeOne,
          },
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const detail = [msg, errorContext()].filter(Boolean).join("\n");
        const warning = sanitizeText(redact(`MCP server "${name}" unavailable: ${oneLine(detail, 400)}`));
        log().warn({ mcpServer: name, err: sanitizeText(redact(detail)) }, "mcp connect failed");
        try {
          await client?.close();
        } catch {
          /* ignore */
        }
        try {
          await transport?.close();
        } catch {
          /* ignore */
        }
        return { ok: false, warning };
      }
    }),
  );

  // Name tools and collect warnings sequentially, in config order. Assigning
  // names inside the concurrent connection tasks would make collisions (long
  // server names truncate to the same prefix) depend on connection timing.
  for (const result of results) {
    if (!result.ok) {
      warnings.push(result.warning);
      continue;
    }
    const setup = result.setup;
    if (setup.truncated) {
      warnings.push(
        `MCP server "${setup.name}" advertised more than ${MAX_TOOLS_PER_SERVER} tools or ${MAX_LIST_PAGES} pages; only the first ${setup.tools.length} were loaded.`,
      );
    }
    for (const remote of setup.tools) {
      const localName = buildMcpToolName(setup.name, redact(remote.name), taken);
      taken.add(localName);
      tools.push(
        createMcpToolAdapter({
          server: setup.name,
          transport: setup.transport,
          localName,
          remote,
          client: setup.callClient,
          timeoutMs: setup.toolTimeoutMs,
          redact,
        }),
      );
    }
    servers.push({
      name: setup.name,
      transport: setup.transport,
      ...(setup.serverVersion ? { serverVersion: setup.serverVersion } : {}),
      toolCount: setup.tools.length,
    });
    closers.push(setup.close);
  }

  tools.sort((a, b) => a.name.localeCompare(b.name));

  let closed = false;
  return {
    tools,
    servers,
    warnings,
    async close() {
      if (closed) return;
      closed = true;
      await Promise.allSettled(closers.map((fn) => fn()));
    },
  };
}

function createTransport(
  cfg: McpServerConfig,
  workspaceRoot: string,
  parentEnv: NodeJS.ProcessEnv,
): { kind: "stdio" | "http"; transport: Transport; errorContext: () => string } {
  const kind = cfg.type ?? (cfg.url ? "http" : "stdio");
  if (kind === "http") {
    const headers = Object.keys(cfg.headers).length ? { ...cfg.headers } : undefined;
    return {
      kind: "http",
      transport: new StreamableHTTPClientTransport(new URL(cfg.url!), headers ? { requestInit: { headers } } : undefined),
      errorContext: () => "",
    };
  }

  // Stdio servers only receive the SDK's safe baseline environment (PATH, HOME,
  // USER, SHELL, TERM, LOGNAME), any variables explicitly listed in inheritEnv,
  // and the server's own `env` map. API keys in Sutra's process environment are
  // never passed through implicitly.
  const childEnv: Record<string, string> = { ...getDefaultEnvironment() };
  for (const key of cfg.inheritEnv) {
    const val = parentEnv[key];
    if (val !== undefined) childEnv[key] = val;
  }
  Object.assign(childEnv, cfg.env);

  const cwd = cfg.cwd ? resolve(workspaceRoot, cfg.cwd) : workspaceRoot;
  const transport = new StdioClientTransport({
    command: cfg.command!,
    args: cfg.args,
    env: childEnv,
    cwd,
    stderr: "pipe",
  });
  // Drain the child's stderr so a chatty server cannot block on a full pipe and
  // the TUI is never corrupted. Keep a short tail for connection errors.
  let tail = "";
  transport.stderr?.on("data", (chunk: Buffer | string) => {
    tail = (tail + chunk.toString()).slice(-2000);
  });
  return { kind: "stdio", transport, errorContext: () => tail.trim() };
}

/** Collect secret-looking values from `mcpServers` so they are redacted from output and logs. */
export function collectMcpSecrets(config: SutraConfig, env: NodeJS.ProcessEnv = process.env): string[] {
  const out: string[] = [];
  for (const server of Object.values(config.mcpServers ?? {})) {
    for (const v of Object.values(server.env ?? {})) if (v) out.push(v);
    for (const k of server.inheritEnv ?? []) if (env[k]) out.push(env[k]!);
    for (const v of Object.values(server.headers ?? {})) {
      if (!v) continue;
      out.push(v);
      const scheme = v.match(/^(?:Bearer|Token|Basic)\s+(.+)$/i);
      if (scheme?.[1]) out.push(scheme[1].trim());
    }
    if (server.url) {
      try {
        const url = new URL(server.url);
        // URLs with embedded credentials are rejected by config validation, but
        // callers can construct a config programmatically. Redact them anyway.
        if (url.username) out.push(decodeUrlPart(url.username));
        if (url.password) out.push(decodeUrlPart(url.password));
        for (const [k, v] of url.searchParams) {
          if (v && /(token|key|secret|auth|password|cookie)/i.test(k)) out.push(v);
        }
      } catch {
        /* Config validation already required a valid URL. */
      }
    }
  }
  return out;
}

function decodeUrlPart(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
