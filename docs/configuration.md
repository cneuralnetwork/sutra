# Configuration

## Files

| Path | Purpose | Trust |
| --- | --- | --- |
| `~/.sutra/config.json` | user settings | trusted |
| `~/.sutra/credentials.json` | API keys (mode 600), written by `sutra init` | trusted |
| `~/.sutra/AGENTS.md` | personal instructions for every project | guidance |
| `<repo>/AGENTS.md`, `<repo>/.sutra/AGENTS.md` | project instructions | guidance, lower trust |
| `<repo>/.sutra/config.json` | `model`, `tools.testCommand`, extra `protectedPaths` / `sensitivePaths` only | lower trust |
| `~/.sutra/sutra.db` | sessions (SQLite, mode 600) | |
| `~/.sutra/logs/` | `sutra.log` (structured), `tools/<session>/*.log` (full command output) | |

Set `SUTRA_HOME` to relocate `~/.sutra`.

**Precedence**, highest first: CLI flags > environment variables > user config > project config > defaults.

## Environment

| Variable | |
| --- | --- |
| `DEEPSEEK_API_KEY` | API key (takes precedence over credentials.json) |
| `DEEPSEEK_BASE_URL` | default `https://api.deepseek.com` |
| `DEEPSEEK_MODEL` | e.g. `deepseek-flash`, `deepseek-v4-pro` (DeepSeek only) |
| `SUTRA_PROVIDER` | any provider id from the table under [Providers](#providers) |
| `SUTRA_MODEL` | model for any provider |
| `SUTRA_QUALITY` | `fast` / `balanced` / `deep` |
| `OPENAI_BASE_URL` / `OPENAI_API_KEY` | endpoint and key for `openai-compatible` |
| `OPENROUTER_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, … | key for that provider (see the table below) |
| `OLLAMA_HOST` | Ollama address, e.g. `127.0.0.1:11434` (Sutra adds `/v1`) |
| `SUTRA_PROFILE` | `inspect` / `confirm` / `flow` |
| `SUTRA_LANG` | `en` / `hi` |
| `SUTRA_HOME` | state directory |
| `NO_COLOR` | disable colour |

Sutra does not read `.env` files. See [security.md](security.md) for why.

## Example `~/.sutra/config.json`

```json
{
  "provider": "deepseek",
  "model": "deepseek-flash",
  "thinking": "enabled",
  "reasoningEffort": "high",
  "permissions": {
    "profile": "confirm",
    "allowCommands": ["make verify", "pnpm lint"],
    "protectedPaths": ["vendor/", "src/generated/**"],
    "sensitivePaths": ["config/prod.yaml"]
  },
  "budget": {
    "maxSessionCostUsd": 1.0,
    "warnAtFraction": 0.8,
    "maxIterationsPerTurn": 60,
    "maxToolCallsPerTurn": 200
  },
  "context": {
    "maxContextTokens": 200000,
    "compactThreshold": 0.75,
    "keepRecentTurns": 2
  },
  "tools": {
    "commandTimeoutMs": 120000,
    "maxOutputChars": 30000,
    "retainFullLogs": true,
    "testCommand": "npm test",
    "scrubEnv": true
  },
  "ui": { "theme": "auto", "language": "en" }
}
```

`allowCommands` adds prefixes that `flow` treats as routine. Destructive, network and compound commands still ask.

## Providers

`sutra init` sets any of these up interactively. Keys come from the environment variable shown, or from `~/.sutra/credentials.json` (mode 600), where `sutra init` saves them.

| `provider` | Service | Default endpoint | Key |
| --- | --- | --- | --- |
| `deepseek` | DeepSeek | `https://api.deepseek.com` | `DEEPSEEK_API_KEY` |
| `openrouter` | OpenRouter | `https://openrouter.ai/api/v1` | `OPENROUTER_API_KEY` |
| `openai-compatible` | OpenAI, or any OpenAI-compatible server | `https://api.openai.com/v1` (`providers.openai.baseUrl`) | `OPENAI_API_KEY`; optional for `localhost` |
| `anthropic` | Anthropic (OpenAI-compatible endpoint) | `https://api.anthropic.com/v1` | `ANTHROPIC_API_KEY` |
| `gemini` | Google Gemini (OpenAI-compatible endpoint) | `https://generativelanguage.googleapis.com/v1beta/openai` | `GEMINI_API_KEY` |
| `xai` | xAI | `https://api.x.ai/v1` | `XAI_API_KEY` |
| `mistral` | Mistral | `https://api.mistral.ai/v1` | `MISTRAL_API_KEY` |
| `groq` | Groq | `https://api.groq.com/openai/v1` | `GROQ_API_KEY` |
| `cerebras` | Cerebras | `https://api.cerebras.ai/v1` | `CEREBRAS_API_KEY` |
| `together` | Together AI | `https://api.together.xyz/v1` | `TOGETHER_API_KEY` |
| `fireworks` | Fireworks AI | `https://api.fireworks.ai/inference/v1` | `FIREWORKS_API_KEY` |
| `deepinfra` | DeepInfra | `https://api.deepinfra.com/v1/openai` | `DEEPINFRA_API_KEY` |
| `moonshot` | Moonshot (Kimi) | `https://api.moonshot.ai/v1` | `MOONSHOT_API_KEY` |
| `zai` | Z.ai (GLM) | `https://api.z.ai/api/paas/v4` | `ZAI_API_KEY` |
| `qwen` | Alibaba Cloud DashScope (international) | `https://dashscope-intl.aliyuncs.com/compatible-mode/v1` | `DASHSCOPE_API_KEY` |
| `sambanova` | SambaNova | `https://api.sambanova.ai/v1` | `SAMBANOVA_API_KEY` |
| `huggingface` | Hugging Face Inference Providers | `https://router.huggingface.co/v1` | `HF_TOKEN` |
| `vercel` | Vercel AI Gateway | `https://ai-gateway.vercel.sh/v1` | `AI_GATEWAY_API_KEY` |
| `ollama` | Ollama (local) | `http://localhost:11434/v1` | none |
| `lmstudio` | LM Studio (local) | `http://localhost:1234/v1` | none |
| `llamacpp` | llama.cpp `llama-server` (local) | `http://localhost:8080/v1` | none |
| `vllm` | vLLM (local) | `http://localhost:8000/v1` | none |
| `jan` | Jan (local) | `http://localhost:1337/v1` | none |
| `custom` | any other OpenAI-compatible server | set `providers.custom.baseUrl` | `SUTRA_CUSTOM_API_KEY`, optional |

Each provider has its own section under `providers.<id>` with optional `baseUrl` (to override the default, for a regional endpoint or a proxy), `models` (per-model overrides such as `contextWindow`), `contextWindow`, `timeoutMs`, `freeOfCharge` and `headers`. Local providers cost $0. For cloud providers, cost comes from `pricing.<model>`: DeepSeek's prices are built in, and `sutra init` saves the prices OpenRouter publishes for the model you pick; otherwise `/cost` shows tokens and marks the cost unknown.

```json
{
  "provider": "openrouter",
  "model": "deepseek/deepseek-chat",
  "providers": { "openrouter": { "models": { "deepseek/deepseek-chat": { "contextWindow": 163840 } } } }
}
```

Only DeepSeek has a built-in default model. For the others Sutra uses `model` from your config or `--model`; if neither is set, it uses the first model the server lists and tells you so.

```json
{
  "provider": "ollama",
  "model": "qwen3-coder",
  "providers": { "ollama": { "contextWindow": 32768 } }
}
```

```json
{
  "provider": "openai-compatible",
  "model": "Qwen/Qwen3-Coder-30B-A3B-Instruct",
  "providers": {
    "openai": {
      "baseUrl": "http://localhost:8000/v1",
      "freeOfCharge": true,
      "contextWindow": 65536
    }
  }
}
```

**Context windows for local models.** Sutra can't reliably learn a local server's context length, so it assumes `providers.ollama.contextWindow` (default 32768) or `providers.openai.contextWindow` (default 128000) for models without metadata. Make these match your server. Ollama in particular **silently truncates** prompts longer than its configured context (`OLLAMA_CONTEXT_LENGTH`, or the model's `num_ctx`), which shows up as the agent "forgetting" the task.

The OpenAI-compatible adapter sends standard Chat Completions (streaming, `tools`, `stream_options.include_usage`). It reads streamed reasoning from `reasoning_content` or `reasoning` (Ollama, OpenRouter) for progress display, but doesn't send it back, because generic servers don't expect it.

## Quality

```json
{ "quality": { "mode": "balanced" } }
```

`fast`, `balanced` or `deep`. Also `--quality <mode>`, `SUTRA_QUALITY` and `/quality`.

`"economy": true` (or `--economy`) is an experiment: for a bug whose baseline has named failing tests, the acceptance criteria come from that baseline instead of a contract call, and when a fresh full-suite run passes with no test file changed, the review and judge calls are skipped. Anything less clear-cut takes the normal path. See [quality-engine.md](quality-engine.md) for what each mode does and costs.

## Context compiler and checkpoints

```json
{ "context": { "compile": true, "checkpointThreshold": 0.5 } }
```

| Key | |
| --- | --- |
| `compile` | Send a repeated test run as a delta against the previous run, an unchanged re-read as a pointer to the earlier result, and skip an identical test run when nothing changed since. The full output of every call stays available through `get_output`. See [token-economy.md](token-economy.md) |
| `checkpointThreshold` | When tests pass after edits and the context is above this fraction of `maxContextTokens`, compact then, at a settled point, instead of later in the middle of an investigation |

## Repository index

```json
{
  "index": {
    "enabled": true,
    "mapMode": "auto",
    "mapTokens": 1200,
    "maxFiles": 5000,
    "embeddings": { "baseUrl": "http://localhost:11434/v1", "model": "nomic-embed-text" }
  }
}
```

| Key | |
| --- | --- |
| `enabled` | Build the index at session start and offer `repo_map`, `find_symbol` and `code_search`. `--no-index` turns it off for one run |
| `mapMode` | `auto` (default): a focused map is appended to a request only when it is ambiguous or spans files, not when it names the file, a test or a unique symbol. `always`: a static map in the system prompt on every request (the old behaviour). `never`: no map; `repo_map` is still a tool. Also `--map` |
| `mapTokens` | Size budget of the map; `0` means no map |
| `maxFiles` | Stop indexing after this many source files (the map then says so) |
| `embeddings` | Optional. Any OpenAI-compatible `/embeddings` endpoint. `code_search` then fuses BM25 with embedding similarity (reciprocal-rank fusion). Use `apiKeyEnv` to name an environment variable holding the key; keys are never stored in config. `maxChunks` caps how much code is embedded (default 4,000 chunks) |

With embeddings configured, code chunks are sent to that endpoint. Use a local server (for example `ollama pull nomic-embed-text`) to keep code on your machine. Vectors are cached in `~/.sutra/index/` by content hash, so unchanged code is embedded only once. Embedding requests are not included in `/cost`. If the endpoint fails, `code_search` says so and falls back to BM25.

## Sandbox

```json
{ "sandbox": { "mode": "auto", "network": false, "allowWrite": [] } }
```

| Key | |
| --- | --- |
| `mode` | `auto` (default): use the OS sandbox when available. `required`: refuse to run commands without it. `off`: approvals only. Also `--sandbox <mode>` |
| `network` | `true` allows outbound network for every command. Default `false`: only commands approved as network commands get it |
| `allowWrite` | extra directories (relative to the workspace, or absolute) commands may write to |

See [security.md](security.md) for what the sandbox enforces.

## MCP servers

Sutra can call tools exposed by [Model Context Protocol](https://modelcontextprotocol.io/) servers. Configure them under `mcpServers` in **user** config (`~/.sutra/config.json`). Project `.sutra/config.json` cannot define servers: a repository must never be able to launch a process or send your data to an endpoint you did not choose.

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/Users/me/projects"]
    },
    "remote": {
      "type": "http",
      "url": "https://mcp.example.com/mcp",
      "headers": { "Authorization": "Bearer your-token-here" }
    }
  }
}
```

| Key | |
| --- | --- |
| `type` | `stdio` or `http`. Inferred from `command` / `url` when omitted |
| `enabled` | `false` skips the server without deleting its config. Default `true` |
| `command`, `args` | stdio: the executable to spawn and its arguments |
| `cwd` | stdio: working directory, relative to the Sutra workspace. Default: the workspace |
| `env` | stdio: environment variables for the server. Nothing is inherited implicitly |
| `inheritEnv` | stdio: names of parent environment variables to copy explicitly, for example `["GITHUB_TOKEN"]` |
| `url` | http: Streamable HTTP endpoint |
| `headers` | http: extra request headers (keep tokens out of shared configs) |
| `connectTimeoutMs` | Startup and `tools/list` timeout. Default `20000` |
| `toolTimeoutMs` | Per-call timeout. Default `120000` |

Sutra connects to all enabled servers at startup and discovers their tools before the first turn. A server that is offline or misconfigured produces a warning and is skipped; the others still load. Restart Sutra after changing `mcpServers`.

Each tool appears as `mcp_<server>_<tool>` and keeps the server's JSON input schema, so the model sees the same contract the server publishes. Tool names are sanitized to `[A-Za-z0-9_-]`, truncated to 64 characters, and disambiguated if two remote names collide.

**Permissions.** MCP tools are always treated as potentially unsafe: the harness cannot know whether a remote tool only reads data. In `confirm` and `flow` every call asks first; in `inspect` MCP servers are not started and their tools are hidden; in plan mode calls are refused until you approve the plan. There is no "allow for this session" shortcut. Non-interactive runs (`sutra -p`) do not start MCP servers and deny approvals, so they cannot call MCP tools.

**Secrets.** stdio servers receive only `PATH`, `HOME`, `USER`, `SHELL`, `TERM`, `LOGNAME`, the variables you list in `inheritEnv`, and `env`. They do not inherit your shell's API keys. Values from `env`, inherited variables and `headers` are redacted from tool output, the UI, logs and the database. A stdio server is a normal process running as your user and is **not** covered by the command sandbox; only configure servers you trust. See [security.md](security.md#mcp-servers).

## Models

Sutra ships metadata for `deepseek-flash` and `deepseek-v4-pro` (1M-token context, up to 384K output), taken from DeepSeek's documentation on 2026-11-05. Both support tool calls in thinking mode. To add or adjust a model:

```json
{ "providers": { "deepseek": { "models": { "my-model": { "contextWindow": 131072, "maxOutputTokens": 8192, "supportsThinking": false } } } } }
```

Models Sutra doesn't know about get conservative defaults (128K context, no thinking).

`context.maxContextTokens` defaults to 200,000, below the 1M window. Every request re-sends the context, so the cap keeps the cost per request predictable. Raise it if you need longer uncompacted sessions.

## Pricing

Costs are estimates, calculated as `cache-hit input × hit price + cache-miss input × miss price + output × output price`, using usage reported by the provider. The defaults are DeepSeek's published prices as of 2026-11-05, including the UTC weekday peak windows and the off-peak rates. Override or add prices (USD per 1M tokens):

```json
{
  "pricing": {
    "deepseek-flash": {
      "inputCacheHit": 0.006,
      "inputCacheMiss": 0.3,
      "output": 1.2,
      "offPeak": { "inputCacheHit": 0.003, "inputCacheMiss": 0.15, "output": 0.6 },
      "peakWindowsUtc": [
        { "days": [1, 2, 3, 4, 5], "start": "01:00", "end": "04:00" },
        { "days": [1, 2, 3, 4, 5], "start": "06:00", "end": "10:00" }
      ],
      "asOf": "2026-11-05"
    }
  }
}
```

If a model has no price, `/cost` marks the total as incomplete instead of guessing.
