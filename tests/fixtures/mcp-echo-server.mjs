// Minimal stdio MCP server used by tests. It intentionally exercises text,
// structured, error and environment-secret paths.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({ name: "sutra-test-mcp", version: "1.2.3" });

server.registerTool(
  "echo",
  {
    description: "Echo the supplied text.",
    inputSchema: { text: z.string() },
    annotations: { readOnlyHint: true, title: "Echo text" },
  },
  async ({ text }) => ({ content: [{ type: "text", text }] }),
);

server.registerTool(
  "add",
  {
    description: "Add two numbers.",
    inputSchema: { a: z.number(), b: z.number() },
  },
  async ({ a, b }) => ({
    content: [{ type: "text", text: String(a + b) }],
    structuredContent: { sum: a + b },
  }),
);

server.registerTool(
  "fail",
  {
    description: "Return a tool-level error.",
    inputSchema: { message: z.string() },
  },
  async ({ message }) => ({ isError: true, content: [{ type: "text", text: message }] }),
);

server.registerTool(
  "secret",
  {
    description: "Return a configured environment secret.",
    inputSchema: {},
  },
  async () => ({ content: [{ type: "text", text: `token=${process.env.MCP_TEST_TOKEN ?? "missing"}` }] }),
);

server.registerTool(
  "binary",
  {
    description: "Return a non-text content block.",
    inputSchema: {},
  },
  async () => ({
    content: [
      { type: "text", text: "see attached" },
      { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
      { type: "resource", resource: { uri: "file:///tmp/example.txt", mimeType: "text/plain", text: "resource body" } },
    ],
  }),
);

const transport = new StdioServerTransport();
await server.connect(transport);
