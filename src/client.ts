import { parseArgs } from "node:util";
import { readFile } from "node:fs/promises";
import { operations, failure, commands, type Operation } from "./schemas.js";
import { NewsletterError } from "./errors.js";
const setup = (message: string) =>
  failure("configuration_required", message, "Fix the setting and run again");
export type ClientConfig = { url: string; token: string; sendToken?: string; fetch?: typeof fetch };
export function apiClient(config: ClientConfig) {
  return async (operation: Operation, input: unknown): Promise<any> => {
    const parsed = operations[operation].safeParse(input);
    if (!parsed.success)
      return failure(
        "invalid_arguments",
        `Input does not match the schema: ${parsed.error.issues
          .map((issue) => `${issue.path.join(".") || "input"} ${issue.message}`)
          .join("; ")}`,
        "Run with --help for each command's arguments",
      );
    let base: URL;
    try {
      base = new URL(config.url);
    } catch {
      return setup("Set NEWSLETTER_API_URL, for example https://example.com/api/newsletter/v1");
    }
    // HTTPS only, except plain HTTP to this machine for local development.
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(base.hostname);
    if (
      !(base.protocol === "https:" || (base.protocol === "http:" && local)) ||
      base.username ||
      base.password ||
      base.search ||
      base.hash
    )
      return setup("NEWSLETTER_API_URL must be an HTTPS URL without credentials or query");
    const data = parsed.data as Record<string, any>;
    const { id, dry_run, people, ...body } = data;
    const route =
      operation === "draft"
        ? `campaigns${dry_run ? "?dry_run=1" : ""}`
        : operation === "upload-asset"
          ? "assets"
          : operation === "status"
            ? `campaigns${id ? "/" + id : ""}`
            : `campaigns/${id}/${operation}${people ? "?people=1" : ""}`;
    const method = operation === "status" || operation === "stats" ? "GET" : "POST";
    const token =
      operation === "send" || people
        ? config.sendToken || config.token
        : config.token || config.sendToken;
    if (!token)
      return setup(
        operation === "send" || people
          ? "Set NEWSLETTER_SEND_TOKEN: sending needs the owner's send token"
          : "Set NEWSLETTER_API_TOKEN",
      );
    try {
      const response = await (config.fetch ?? fetch)(`${base.href.replace(/\/$/, "")}/${route}`, {
        method,
        redirect: "error",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        ...(method === "POST"
          ? {
              body: JSON.stringify(
                operation === "draft" ? { ...body, ...(id ? { id } : {}) } : body,
              ),
            }
          : {}),
        signal: AbortSignal.timeout(310_000),
      });
      const result = await response.json();
      if (typeof result?.ok !== "boolean") throw new NewsletterError("Invalid response");
      return result;
    } catch {
      return failure(
        "transport_error",
        "Newsletter API response unavailable",
        "Inspect campaign status; never retry a send automatically",
      );
    }
  };
}
const usage = `Usage: vulcan-newsletter <command> [options]\n\n${Object.entries(commands)
  .map(([name, [args, about]]) => `  ${name} ${args}\n      ${about}`)
  .join("\n")}\n  mcp\n      Run as an MCP server over stdio\n
Environment: NEWSLETTER_API_URL, NEWSLETTER_API_TOKEN, NEWSLETTER_SEND_TOKEN
Output is JSON. Exit codes: 0 success, 1 API error, 2 bad arguments or setup.`;
export async function runCli(args: string[], config: ClientConfig, output = console.log) {
  const fail = (message: string) => {
    output(JSON.stringify(failure("invalid_arguments", message, "Run with --help")));
    return 2;
  };
  let parsed;
  try {
    parsed = parseArgs({
      args,
      allowPositionals: true,
      options: {
        help: { type: "boolean", short: "h" },
        json: { type: "boolean" },
        "dry-run": { type: "boolean" },
        input: { type: "string" },
        id: { type: "string" },
        file: { type: "string" },
        mime: { type: "string" },
        people: { type: "boolean" },
        count: { type: "string" },
        sha256: { type: "string" },
      },
    });
  } catch (error) {
    return fail(error instanceof Error ? error.message : "Invalid arguments");
  }
  const { positionals, values } = parsed;
  if (values.help || !positionals.length) {
    output(usage);
    return values.help ? 0 : 2;
  }
  const operation = positionals[0] as Operation;
  if (positionals.length !== 1 || !Object.hasOwn(operations, operation))
    return fail(`Unknown command: ${positionals.join(" ")}`);
  let data: Record<string, unknown> = {};
  if (values.input) {
    const text = await readFile(values.input, "utf8").catch(() => null);
    if (text === null) return fail(`Cannot read ${values.input}`);
    try {
      data = JSON.parse(text);
    } catch {
      return fail(`${values.input} is not valid JSON`);
    }
  }
  if (values.id) data.id = values.id;
  if (values["dry-run"]) data.dry_run = true;
  if (values.people) data.people = true;
  if (values.count !== undefined) data.expected_recipient_count = Number(values.count);
  if (values.sha256) data.review_sha256 = values.sha256;
  if (values.file) {
    // Accept the common spellings people type: IMAGE/PNG, image/jpg.
    data.mime = values.mime?.toLowerCase().replace(/^image\/jpg$/, "image/jpeg");
    const bytes = await readFile(values.file).catch(() => null);
    if (!bytes) return fail(`Cannot read ${values.file}`);
    data.base64 = bytes.toString("base64");
  }
  const result = await apiClient(config)(operation, data);
  output(JSON.stringify(result));
  return result.ok ? 0 : ["invalid_arguments", "configuration_required"].includes(result.code) ? 2 : 1;
}
