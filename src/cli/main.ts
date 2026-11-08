import { paths } from "../config/paths.js";
import { loadConfig } from "../config/load.js";
import { openSession } from "../core/session.js";
import { setLanguage, t } from "../i18n/index.js";
import { collectMcpSecrets, connectMcpServers, type McpRuntime } from "../mcp/client.js";
import { SessionStore } from "../memory/store.js";
import { canonicalize } from "../permissions/paths.js";
import { createProvider, providerNeedsKey } from "../providers/registry.js";
import type { SessionHandle } from "../core/session.js";
import { runAuditCommand } from "./audit-command.js";
import { runBenchCommand } from "./bench-command.js";
import { initLogger, log } from "../telemetry/logger.js";
import { createDefaultRegistry } from "../tools/registry.js";
import { colorEnabled, detectTheme } from "../tui/theme.js";
import { version } from "../version.js";
import { HELP, parseCli } from "./args.js";
import { runHeadless } from "./headless.js";
import { runInit } from "./init.js";

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8").trim();
}

export async function main(argv: string[]): Promise<number> {
  let args;
  try {
    args = parseCli(argv);
  } catch (err) {
    process.stderr.write(`sutra: ${(err as Error).message}\n\n${HELP}\n`);
    return 2;
  }
  if (args.command === "help") {
    process.stdout.write(HELP + "\n");
    return 0;
  }
  if (args.command === "version") {
    process.stdout.write(`sutra ${version()}\n`);
    return 0;
  }

  const color = args.color && colorEnabled();
  const workspaceRoot = canonicalize(process.cwd());
  initLogger({ debug: args.debug });

  let loaded;
  try {
    loaded = loadConfig(workspaceRoot, {
      ...(args.provider ? { provider: args.provider } : {}),
      ...(args.model ? { model: args.model } : {}),
      ...(args.profile ? { profile: args.profile } : {}),
      ...(args.thinking ? { thinking: args.thinking } : {}),
    });
  } catch (err) {
    process.stderr.write(`sutra: ${(err as Error).message}\n`);
    return 1;
  }
  const { config, warnings } = loaded;
  setLanguage((args.lang ?? process.env.SUTRA_LANG ?? config.ui.language) === "hi" ? "hi" : "en");
  const theme = detectTheme(args.theme ?? config.ui.theme);

  if (args.command === "init") return runInit({ color, theme });

  if (args.sandbox) config.sandbox.mode = args.sandbox;
  if (!args.index) config.index.enabled = false;
  if (args.quality) config.quality.mode = args.quality;
  if (args.map) config.index.mapMode = args.map;
  if (args.economy) config.quality.economy = true;

  // Commands that only read the local session store need no provider.
  if (args.command === "replay" || args.command === "export") {
    const store = new SessionStore(paths.database());
    try {
      return runAuditCommand(args.command, store, workspaceRoot, args, { theme, color });
    } finally {
      store.close();
    }
  }

  const key = providerNeedsKey(config);
  if (key.needed) {
    process.stderr.write(config.provider === "deepseek" ? `${t("noApiKey")}\n` : `No API key for ${config.provider}. Set ${key.envVar}, or run \`sutra init\`.\n`);
    return 1;
  }

  const provider = createProvider(config);
  if (!config.model) {
    // Ollama / OpenAI-compatible servers: use the first model the server reports.
    try {
      const ids = await provider.listModels?.(AbortSignal.timeout(10_000));
      if (!ids?.length) throw new Error("the server reported no models");
      config.model = ids[0]!;
      warnings.push(`No model configured; using ${config.model} (first of ${ids.length} on the server). Pass --model to choose.`);
    } catch (err) {
      const hint = config.provider === "ollama" ? " Is Ollama running (`ollama serve`) and has a model been pulled (`ollama pull qwen3-coder`)?" : "";
      process.stderr.write(`sutra: could not determine a model for ${provider.displayName}: ${(err as Error).message}.${hint} Pass --model <id>.\n`);
      return 1;
    }
  }

  const store = new SessionStore(paths.database());

  if (args.command === "bench") {
    try {
      return await runBenchCommand({ args, config, provider, store, theme, color });
    } finally {
      store.close();
    }
  }

  let resumeId: string | undefined = args.session;
  if (args.resume && !resumeId) {
    const latest = store.latestSession(workspaceRoot);
    if (!latest) {
      process.stderr.write("No previous session in this directory.\n");
      store.close();
      return 1;
    }
    resumeId = latest.id;
  }

  const interactive = !args.print && process.stdin.isTTY === true && process.stdout.isTTY === true;
  log().info({ workspace: workspaceRoot, model: config.model, profile: config.permissions.profile, interactive, resume: !!resumeId }, "start");

  // MCP discovery is asynchronous, while openSession is synchronous: connect
  // once for the process and hand the same registry to every session. Bench and
  // audit runs deliberately stay isolated from user-configured MCP servers.
  // Non-interactive runs deny every approval, so starting servers there would
  // only spawn processes that can never be called.
  const mcp: McpRuntime = interactive
    ? await connectMcpServers(config, workspaceRoot, {
        reservedNames: createDefaultRegistry().list().map((t) => t.name),
      })
    : { tools: [], servers: [], warnings: [], close: async () => {} };
  const mcpSecrets = interactive ? collectMcpSecrets(config) : [];
  const tools = createDefaultRegistry();
  for (const tool of mcp.tools) tools.register(tool);
  const mcpWarnings = mcp.warnings;
  const mcpInfo =
    mcp.tools.length > 0
      ? [`[mcp] ${mcp.tools.length} tool${mcp.tools.length === 1 ? "" : "s"} from ${mcp.servers.map((s) => `${s.name} (${s.toolCount})`).join(", ")}`]
      : [];

  try {
    if (!interactive) {
      const prompt = [args.prompt, await readStdin()].filter(Boolean).join("\n\n");
      if (!prompt) {
        process.stderr.write("No prompt given. Usage: sutra -p \"your task\"  (or pipe text on stdin)\n");
        return 2;
      }
      for (const w of [...warnings, ...mcpWarnings]) process.stderr.write(`[warn] ${w}\n`);
      for (const i of mcpInfo) process.stderr.write(`[info] ${i}\n`);
      const session = openSession({
        config,
        provider,
        store,
        workspaceRoot,
        approve: async () => "deny",
        tools,
        extraSecrets: mcpSecrets,
        ...(resumeId ? { resumeId } : {}),
      });
      if (!requireSandbox(session)) return 1;
      if (session.repairedToolCalls) process.stderr.write(`[info] repaired ${session.repairedToolCalls} interrupted tool call(s) from the previous run\n`);
      const result = await runHeadless(session, prompt, { theme, color, json: args.json });
      return result.status === "completed" ? 0 : result.status === "cancelled" ? 130 : 1;
    }

    const [{ render }, React, { App, ApprovalBridge }] = await Promise.all([import("ink"), import("react"), import("../tui/App.js")]);
    const bridge = new ApprovalBridge();
    const make = (id?: string) =>
      openSession({
        config,
        provider,
        store,
        workspaceRoot,
        approve: bridge.request,
        tools,
        extraSecrets: mcpSecrets,
        ...(id ? { resumeId: id } : {}),
      });
    const session = make(resumeId);
    if (!requireSandbox(session)) return 1;
    const notices = [...warnings, ...mcpWarnings.map((w) => `[mcp] ${w}`), ...mcpInfo];
    if (!session.sandbox.runner && session.sandbox.mode === "auto") notices.push(`No OS sandbox: ${session.sandbox.reason}. Commands are protected by approvals only.`);
    if (session.repairedToolCalls) notices.push(`Repaired ${session.repairedToolCalls} tool call(s) interrupted in the previous run.`);
    if (session.instructions.length) notices.push(`Instructions: ${session.instructions.map((i) => i.path).join(", ")}`);
    const instance = render(
      React.createElement(App, {
        ui: { theme, color },
        config,
        store,
        provider,
        bridge,
        initialSession: session,
        newSession: (id?: string) => make(id),
        notices,
        ...(args.prompt ? { initialPrompt: args.prompt } : {}),
      }),
      { exitOnCtrlC: false, patchConsole: true },
    );
    await instance.waitUntilExit();
    process.stdout.write(`\nSession ${session.record.id.slice(0, 8)} saved. Resume with: sutra --resume\n`);
    return 0;
  } catch (err) {
    process.stderr.write(`sutra: ${(err as Error).message}\n`);
    log().error({ err: (err as Error).message }, "fatal");
    return 1;
  } finally {
    await mcp.close();
    store.close();
  }
}


function requireSandbox(session: SessionHandle): boolean {
  if (session.sandbox.mode === "required" && !session.sandbox.runner) {
    process.stderr.write(`sutra: sandbox.mode is "required" but no OS sandbox is available: ${session.sandbox.reason}.\n`);
    return false;
  }
  return true;
}
