import { expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "./mcp.js";
import { runCli, apiClient } from "./client.js";
import { httpFixture } from "./testing/http.js";
it("CLI and MCP use the actual HTTP handler and preserve result/error codes", async () => {
  const { handler } = await httpFixture();
  const config = {
    url: "https://example.com/api/newsletter/v1",
    token: "o".repeat(43),
    fetch: (async (url, init) => handler(new Request(url as string, init))) as typeof fetch,
  };
  const call = apiClient(config);
  const expected = await call("status", {});
  const output: string[] = [];
  expect(await runCli(["status", "--json"], config, (text) => output.push(text))).toBe(0);
  expect(JSON.parse(output[0])).toEqual(expected);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createMcpServer(config);
  const client = new Client({ name: "tests", version: "1" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const tools = (await client.listTools()).tools;
  expect(tools.map((t) => t.name)).not.toContain("send");
  // Fields with defaults stay optional for agents.
  expect(tools.find((t) => t.name === "draft")?.inputSchema.required).toEqual(["slug", "subject", "html"]);
  const result = await client.callTool({ name: "status", arguments: {} });
  expect(JSON.parse((result.content as any)[0].text)).toEqual(expected);
  const error = await call("stats", { id: "missing" });
  const mcpError = await client.callTool({ name: "stats", arguments: { id: "missing" } });
  expect(JSON.parse((mcpError.content as any)[0].text)).toEqual(error);
  output.length = 0;
  expect(
    await runCli(["stats", "--id", "missing", "--json"], config, (text) => output.push(text)),
  ).toBe(1);
  expect(JSON.parse(output[0])).toEqual(error);
  await client.close();
  await server.close();
});
it("only explicitly configured send credentials expose the MCP send tool", async () => {
  const [a, b] = InMemoryTransport.createLinkedPair();
  const server = createMcpServer({
    url: "https://example.com/api/newsletter/v1",
    token: "o".repeat(43),
    sendToken: "s".repeat(43),
  });
  const client = new Client({ name: "tests", version: "1" });
  await server.connect(b);
  await client.connect(a);
  expect((await client.listTools()).tools.map((t) => t.name)).toContain("send");
  await client.close();
  await server.close();
});
it("never follows redirects with a token and reports transport uncertainty without retry", async () => {
  let calls = 0;
  const call = apiClient({
    url: "https://example.com/api/newsletter/v1",
    token: "o".repeat(43),
    sendToken: "s".repeat(43),
    fetch: (async (_url, init) => {
      calls++;
      expect(init?.redirect).toBe("error");
      throw new Error("secret");
    }) as typeof fetch,
  });
  const result = await call("send", {
    id: "one",
    expected_recipient_count: 1,
    review_sha256: "a".repeat(64),
  });
  expect(result).toMatchObject({ ok: false, code: "transport_error" });
  expect(result.next_action).toContain("never retry");
  expect(calls).toBe(1);
});
it("invalid MCP arguments preserve the HTTP schema error envelope", async () => {
  const config = { url: "https://example.com/api/newsletter/v1", token: "o".repeat(43) };
  const expected = await apiClient(config)("stats", { id: "../invalid" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const server = createMcpServer(config);
  const client = new Client({ name: "tests", version: "1" });
  await server.connect(b);
  await client.connect(a);
  const result = await client.callTool({ name: "stats", arguments: { id: "../invalid" } });
  expect(JSON.parse((result.content as any)[0].text)).toEqual(expected);
  await client.close();
  await server.close();
});
it("explains setup problems and bad arguments with exit code 2, and API failures with 1", async () => {
  const lines: string[] = [];
  const out = (line: string) => lines.push(line);
  const ok = vi.fn(async () => Response.json({ ok: true, data: [] }));
  const refused = vi.fn(async () =>
    Response.json({ ok: false, code: "operation_failed", message: "Campaign is not a draft", next_action: "" }, { status: 409 }),
  );
  expect(await runCli(["--help"], { url: "", token: "" }, out)).toBe(0);
  expect(lines.pop()).toContain("Usage: vulcan-newsletter");
  expect(await runCli([], { url: "", token: "" }, out)).toBe(2);
  expect(await runCli(["status"], { url: "", token: "t" }, out)).toBe(2);
  expect(JSON.parse(lines.pop()!)).toMatchObject({ code: "configuration_required" });
  expect(await runCli(["publish"], { url: "https://x.example", token: "t" }, out)).toBe(2);
  expect(JSON.parse(lines.pop()!).message).toBe("Unknown command: publish");
  expect(await runCli(["send", "--id", "c"], { url: "https://x.example", token: "t", sendToken: "s" }, out)).toBe(2);
  expect(JSON.parse(lines.pop()!).message).toMatch(/^Input does not match the schema: expected_recipient_count/);
  expect(await runCli(["status"], { url: "http://localhost:3001/api/newsletter/v1", token: "t", fetch: ok }, out)).toBe(0);
  expect(await runCli(["status"], { url: "http://example.com/api", token: "t", fetch: ok }, out)).toBe(2);
  expect(await runCli(["test", "--id", "c"], { url: "https://x.example", token: "t", fetch: refused }, out)).toBe(1);
  expect(JSON.parse(lines.pop()!).message).toBe("Campaign is not a draft");
});
