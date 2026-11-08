/** Public library surface for embedding Sutra or writing extensions. */
export { AgentRuntime, type RuntimeDeps } from "./core/agent/runtime.js";
export type { AgentEvent, AgentStatus, ApprovalRequest, TurnResult } from "./core/events/types.js";
export { openSession, type SessionHandle } from "./core/session.js";
export { runDelegatedTask, type DelegatedTask } from "./core/delegate.js";
export { registerProvider, createProvider, type ProviderFactory } from "./providers/registry.js";
export type { ModelProvider, ModelRequest, ModelEvent, ModelInfo, Message, ToolDefinition } from "./providers/types.js";
export { ProviderError } from "./providers/errors.js";
export { DeepSeekProvider } from "./providers/deepseek/provider.js";
export { ToolRegistry, createDefaultRegistry } from "./tools/registry.js";
export type { Tool, ToolContext, ToolResult } from "./tools/types.js";
export { PermissionEngine } from "./permissions/engine.js";
export { SessionStore } from "./memory/store.js";
export { loadConfig } from "./config/load.js";
export { connectMcpServers, collectMcpSecrets, type McpRuntime, type ConnectedMcpServer } from "./mcp/client.js";
