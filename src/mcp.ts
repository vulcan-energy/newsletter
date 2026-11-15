import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { apiClient, type ClientConfig } from "./client.js";
import { createRequire } from "node:module";
import { operations, failure, commands, type Operation } from "./schemas.js";
const { name, version } = createRequire(import.meta.url)("../package.json");
export function createMcpServer(config: ClientConfig) {
  const server = new Server(
    { name, version },
    { capabilities: { tools: {} } },
  );
  const names = (Object.keys(operations) as Operation[]).filter(
    (name) => name !== "send" || !!config.sendToken,
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: names.map((name) => ({
      name,
      description: commands[name][1],
      // Input mode, so fields with defaults are optional for the agent.
      inputSchema: { ...z.toJSONSchema(operations[name], { io: "input" }), type: "object" as const },
      annotations: {
        readOnlyHint: name === "status" || name === "stats",
        destructiveHint: name === "send",
      },
    })),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params.name as Operation;
    const result = names.includes(name)
      ? await apiClient(config)(name, request.params.arguments ?? {})
      : failure("not_found", "Unknown newsletter operation", "Use an advertised tool");
    return { content: [{ type: "text", text: JSON.stringify(result) }], isError: !result.ok };
  });
  return server;
}
