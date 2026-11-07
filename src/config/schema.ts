import { z } from "zod";

export const PermissionProfileSchema = z.enum(["inspect", "confirm", "flow"]);
export type PermissionProfile = z.infer<typeof PermissionProfileSchema>;

/** Price per 1M tokens, in USD. */
export const ModelPriceSchema = z.object({
  inputCacheMiss: z.number().nonnegative(),
  inputCacheHit: z.number().nonnegative(),
  output: z.number().nonnegative(),
  /**
   * Optional off-peak pricing. When present, `peakWindowsUtc` decides which
   * requests use the base (peak) price; all other times use `offPeak`.
   */
  offPeak: z
    .object({ inputCacheMiss: z.number(), inputCacheHit: z.number(), output: z.number() })
    .optional(),
  /** e.g. [{ days: [1,2,3,4,5], start: "01:00", end: "04:00" }] (days: 0=Sun). */
  peakWindowsUtc: z
    .array(z.object({ days: z.array(z.number().int().min(0).max(6)), start: z.string(), end: z.string() }))
    .optional(),
  currency: z.literal("USD").default("USD"),
  source: z.string().optional(),
  asOf: z.string().optional(),
});
export type ModelPrice = z.infer<typeof ModelPriceSchema>;

const ModelInfoOverride = z.object({
  contextWindow: z.number().int().positive().optional(),
  maxOutputTokens: z.number().int().positive().optional(),
  defaultOutputTokens: z.number().int().positive().optional(),
  supportsTools: z.boolean().optional(),
  supportsThinking: z.boolean().optional(),
  thinkingSupportsTools: z.boolean().optional(),
});

/** Settings for one catalog provider (OpenRouter, Groq, LM Studio, ...): see src/providers/catalog.ts. */
export const EndpointSchema = z.object({
  /** Overrides the catalog's base URL (for example a regional endpoint or a proxy). */
  baseUrl: z.string().url().optional(),
  /** Discouraged: keep keys in credentials.json (`sutra init`) or the environment. */
  apiKey: z.string().optional(),
  timeoutMs: z.number().int().positive().optional(),
  models: z.record(z.string(), ModelInfoOverride).default({}),
  /** Context window assumed for models with no metadata. */
  contextWindow: z.number().int().positive().optional(),
  /** Treat requests as free (self-hosted inference). */
  freeOfCharge: z.boolean().optional(),
  headers: z.record(z.string(), z.string()).optional(),
});
export type EndpointConfig = z.infer<typeof EndpointSchema>;

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** RFC 9110 field-name. */
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

/**
 * One user-configured MCP server. `command` selects a local stdio server;
 * `url` selects a remote Streamable HTTP server. There is deliberately no
 * project-level equivalent: a repository must never be able to launch a
 * process or send your data to a server you did not configure.
 */
export const McpServerSchema = z
  .object({
    enabled: z.boolean().default(true),
    /** Inferred from `url` / `command` when omitted. */
    type: z.enum(["stdio", "http"]).optional(),
    /** stdio: executable to spawn. */
    command: z.string().min(1).optional(),
    args: z.array(z.string()).default([]),
    /** stdio: environment variables for the server. Never inherited implicitly. */
    env: z
      .record(z.string().regex(ENV_NAME, "Environment variable names must match [A-Za-z_][A-Za-z0-9_]*"), z.string())
      .default({}),
    /** stdio: names of parent environment variables to copy explicitly (for example ["GITHUB_TOKEN"]). */
    inheritEnv: z.array(z.string().regex(ENV_NAME, "Environment variable names must match [A-Za-z_][A-Za-z0-9_]*")).default([]),
    cwd: z.string().min(1).optional(),
    /** http: endpoint speaking Streamable HTTP. */
    url: z.string().url().optional(),
    /** http: extra request headers, for example {"Authorization":"Bearer …"}. */
    headers: z
      .record(
        z.string().regex(HEADER_NAME, "Invalid HTTP header name"),
        z.string().refine((v) => !/[\r\n]/.test(v), "HTTP header values cannot contain newlines"),
      )
      .default({}),
    /** Initialization and tools/list timeout. */
    connectTimeoutMs: z.number().int().positive().max(300_000).default(20_000),
    /** Per-call timeout. */
    toolTimeoutMs: z.number().int().positive().max(3_600_000).default(120_000),
  })
  .superRefine((v, ctx) => {
    const transport = v.type ?? (v.url ? "http" : "stdio");
    if (transport === "stdio") {
      if (!v.command) ctx.addIssue({ code: "custom", message: "stdio MCP server requires `command`" });
      if (v.url) ctx.addIssue({ code: "custom", message: "stdio MCP server cannot also set `url`" });
      if (Object.keys(v.headers).length)
        ctx.addIssue({ code: "custom", path: ["headers"], message: "stdio MCP server cannot set `headers`; use `env` or `inheritEnv`" });
    } else {
      if (!v.url) {
        ctx.addIssue({ code: "custom", message: "http MCP server requires `url`" });
      } else {
        try {
          const url = new URL(v.url);
          if (url.protocol !== "http:" && url.protocol !== "https:")
            ctx.addIssue({ code: "custom", path: ["url"], message: "http MCP server URL must use http:// or https://" });
          if (url.username || url.password)
            ctx.addIssue({ code: "custom", path: ["url"], message: "http MCP server URL must not embed credentials; use `headers` instead" });
        } catch {
          /* z.string().url() already rejected malformed URLs. */
        }
      }
      if (v.command) ctx.addIssue({ code: "custom", message: "http MCP server cannot also set `command`" });
      if (v.args.length) ctx.addIssue({ code: "custom", path: ["args"], message: "http MCP server cannot set `args`" });
      if (Object.keys(v.env).length || v.inheritEnv.length)
        ctx.addIssue({ code: "custom", path: ["env"], message: "http MCP server cannot set `env` or `inheritEnv`; use `headers`" });
      if (v.cwd) ctx.addIssue({ code: "custom", path: ["cwd"], message: "http MCP server cannot set `cwd`" });
    }
  });
export type McpServerConfig = z.infer<typeof McpServerSchema>;

/** Server names become part of tool names, so keep them short and provider-safe. */
const MCP_SERVER_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/;

export const ConfigSchema = z.object({
  provider: z.string().default("deepseek"),
  model: z.string().optional(),
  thinking: z.enum(["enabled", "disabled"]).default("enabled"),
  reasoningEffort: z.enum(["low", "high", "max"]).default("high"),
  maxOutputTokens: z.number().int().positive().optional(),
  permissions: z
    .object({
      profile: PermissionProfileSchema.default("confirm"),
      /** Command prefixes auto-approved in `flow` (still blocked if destructive/network). */
      allowCommands: z.array(z.string()).default([]),
      /** Extra glob-ish path patterns treated as sensitive. */
      sensitivePaths: z.array(z.string()).default([]),
      /** Paths (relative to workspace) the agent may never write. */
      protectedPaths: z.array(z.string()).default([]),
    })
    .prefault({}),
  providers: z
    .object({
      deepseek: z
        .object({
          apiKey: z.string().optional(),
          baseUrl: z.string().url().default("https://api.deepseek.com"),
          timeoutMs: z.number().int().positive().optional(),
          models: z.record(z.string(), ModelInfoOverride).default({}),
        })
        .prefault({}),
      /** Any OpenAI-compatible endpoint: OpenAI, vLLM, LM Studio, llama.cpp, OpenRouter, ... */
      openai: z
        .object({
          apiKey: z.string().optional(),
          baseUrl: z.string().url().default("https://api.openai.com/v1"),
          timeoutMs: z.number().int().positive().optional(),
          models: z.record(z.string(), ModelInfoOverride).default({}),
          /** Treat requests as free (self-hosted inference). */
          freeOfCharge: z.boolean().default(false),
          /** Context window assumed for models with no metadata. */
          contextWindow: z.number().int().positive().default(128_000),
        })
        .prefault({}),
      /** Local Ollama server (OpenAI-compatible endpoint). */
      ollama: z
        .object({
          baseUrl: z.string().url().default("http://localhost:11434/v1"),
          timeoutMs: z.number().int().positive().optional(),
          models: z.record(z.string(), ModelInfoOverride).default({}),
          /**
           * Must match the server's context length (OLLAMA_CONTEXT_LENGTH or the
           * model's num_ctx). Ollama silently truncates longer prompts.
           */
          contextWindow: z.number().int().positive().default(32_768),
        })
        .prefault({}),
    })
    // Every other catalog provider: providers.openrouter, providers.groq, providers.lmstudio, ...
    .catchall(EndpointSchema)
    .prefault({}),
  sandbox: z
    .object({
      /**
       * OS-level isolation for shell commands and tests.
       * auto: use it when the platform supports it; required: refuse to run
       * commands without it; off: approval gate only.
       */
      mode: z.enum(["auto", "required", "off"]).default("auto"),
      /** Extra directories commands may write to (besides the workspace and temp dirs). */
      allowWrite: z.array(z.string()).default([]),
      /** Allow network for every command, not only for approved network commands. */
      network: z.boolean().default(false),
    })
    .prefault({}),
  pricing: z.record(z.string(), ModelPriceSchema).default({}),
  budget: z
    .object({
      /** Hard per-session spend limit in USD. Inference pauses when reached. */
      maxSessionCostUsd: z.number().positive().optional(),
      warnAtFraction: z.number().min(0).max(1).default(0.8),
      maxIterationsPerTurn: z.number().int().positive().default(60),
      maxToolCallsPerTurn: z.number().int().positive().default(200),
    })
    .prefault({}),
  context: z
    .object({
      /** Fraction of the model context window that triggers compaction. */
      compactThreshold: z.number().min(0.1).max(0.95).default(0.75),
      /**
       * Cap below the model window. DeepSeek models accept 1M tokens, but
       * every request re-sends the context, so a lower cap keeps spend
       * predictable. Raise it in config if you need more.
       */
      maxContextTokens: z.number().int().positive().default(200_000),
      keepRecentTurns: z.number().int().min(1).default(2),
      /**
       * Compile tool results: repeated test runs as deltas, unchanged re-reads
       * as pointers, identical re-runs skipped. Full output stays available
       * through get_output.
       */
      compile: z.boolean().default(true),
      /**
       * Checkpoint compaction: after tests pass following edits (a natural
       * boundary), compact early if context is above this fraction of the
       * limit, instead of waiting for compactThreshold mid-investigation.
       */
      checkpointThreshold: z.number().min(0.1).max(0.95).default(0.5),
    })
    .prefault({}),
  quality: z
    .object({
      /**
       * fast: evidence labels only, no extra model calls. balanced: evidence
       * packet, task contract, finish gate, alignment review, one
       * counterexample round. deep: adds a second round and competing patches.
       */
      /**
       * Experiment: when a fresh, unambiguous test result settles every
       * criterion (a bug whose failing tests now pass, nothing regressed, no
       * test edited), skip the contract, review and judge calls.
       */
      economy: z.boolean().default(false),
      mode: z.enum(["fast", "balanced", "deep"]).default("balanced"),
    })
    .prefault({}),
  index: z
    .object({
      /** Build a repository index (symbols, reference graph, ranked search) at session start. */
      enabled: z.boolean().default(true),
      /**
       * auto: a focused map is appended to a request only when it is
       * ambiguous or spans files (not when it names the file, a test or a
       * unique symbol). always: a static map in the system prompt, every
       * request. never: no map; repo_map is still available as a tool.
       */
      mapMode: z.enum(["auto", "always", "never"]).default("auto"),
      /** Token budget for the map (0 = no map). */
      mapTokens: z.number().int().min(0).max(16_000).default(1200),
      maxFiles: z.number().int().positive().default(5000),
      /** Optional embeddings for code_search (any OpenAI-compatible /embeddings endpoint). */
      embeddings: z
        .object({
          baseUrl: z.string().url(),
          model: z.string().min(1),
          /** Name of an environment variable holding the key (keys are never stored in config). */
          apiKeyEnv: z.string().optional(),
          maxChunks: z.number().int().positive().optional(),
        })
        .optional(),
    })
    .prefault({}),
  tools: z
    .object({
      commandTimeoutMs: z.number().int().positive().default(120_000),
      maxOutputChars: z.number().int().positive().default(30_000),
      retainFullLogs: z.boolean().default(true),
      testCommand: z.string().optional(),
      scrubEnv: z.boolean().default(true),
    })
    .prefault({}),
  /**
   * Model Context Protocol servers. User config only (never `.sutra/config.json`).
   * Tools are exposed as `mcp_<server>_<tool>` and always ask before running.
   */
  mcpServers: z
    .record(z.string(), McpServerSchema)
    .default({})
    .superRefine((servers, ctx) => {
      for (const name of Object.keys(servers)) {
        if (!MCP_SERVER_NAME.test(name))
          ctx.addIssue({ code: "custom", path: [name], message: "MCP server names must be 1-32 characters: letters, digits, `_` or `-`, starting with a letter or digit" });
      }
    }),
  ui: z
    .object({
      theme: z.enum(["auto", "dark", "light"]).default("auto"),
      language: z.enum(["en", "hi"]).default("en"),
    })
    .prefault({}),
});

export type SutraConfig = z.infer<typeof ConfigSchema>;

/**
 * Keys a repository's `.sutra/config.json` may set. Project config is lower
 * trust than user config: it can never loosen permissions, change the API
 * endpoint, or touch credentials.
 */
export const ProjectConfigSchema = z
  .object({
    model: z.string().optional(),
    tools: z.object({ testCommand: z.string().optional() }).optional(),
    permissions: z
      .object({
        protectedPaths: z.array(z.string()).optional(),
        sensitivePaths: z.array(z.string()).optional(),
      })
      .optional(),
  })
  .strip();
export type ProjectConfig = z.infer<typeof ProjectConfigSchema>;
