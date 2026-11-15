#!/usr/bin/env node
import { runCli } from "./client.js";
const config = {
  url: process.env.NEWSLETTER_API_URL ?? "",
  token: process.env.NEWSLETTER_API_TOKEN ?? "",
  sendToken: process.env.NEWSLETTER_SEND_TOKEN,
};
if (process.argv[2] === "mcp") {
  // The MCP SDK is an optional peer, loaded only for this command.
  const loaded = await Promise.all([
    import("@modelcontextprotocol/sdk/server/stdio.js"),
    import("./mcp.js"),
  ]).catch(() => null);
  if (!loaded) {
    console.error("Install @modelcontextprotocol/sdk to run the MCP server.");
    process.exitCode = 2;
  } else await loaded[1].createMcpServer(config).connect(new loaded[0].StdioServerTransport());
} else process.exitCode = await runCli(process.argv.slice(2), config);
