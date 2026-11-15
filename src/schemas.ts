import { z } from "zod";
const id = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[a-zA-Z0-9-]+$/);
export const draftSchema = z
  .object({
    id: id.optional(),
    slug: z
      .string()
      .min(1)
      .max(100)
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    subject: z.string().trim().min(1).max(998),
    preview_text: z.string().max(500).default(""),
    html: z.string().max(102 * 1024),
    target_tag: z.string().trim().min(1).max(100).nullable().default(null),
    is_public: z.boolean().default(false),
  })
  .strict();
export const sendSchema = z
  .object({
    expected_recipient_count: z.number().int().nonnegative(),
    review_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export const assetSchema = z
  .object({
    // Email clients do not render SVG, and it can carry scripts.
    mime: z.enum(["image/png", "image/jpeg", "image/gif", "image/webp"]),
    base64: z
      .string()
      .max(7_000_000)
      .refine(
        (value) =>
          value.length % 4 === 0 && Buffer.from(value, "base64").toString("base64") === value,
      ),
  })
  .strict();
export const operations = {
  status: z.object({ id: id.optional() }).strict(),
  draft: draftSchema.extend({ dry_run: z.boolean().optional() }),
  "upload-asset": assetSchema,
  test: z.object({ id }).strict(),
  reconcile: z.object({ id }).strict(),
  send: sendSchema.extend({ id }),
  stats: z.object({ id, people: z.boolean().optional() }).strict(),
};
export type Operation = keyof typeof operations;
// One line per command, shared by the CLI help and the MCP tool descriptions.
export const commands: Record<Operation, [args: string, about: string]> = {
  status: ["[--id ID]", "List campaigns, or show one with its review_sha256 and anything blocking a send"],
  draft: ["--input FILE [--dry-run]", "Create or update a draft; a dry run only validates"],
  "upload-asset": ["--file PATH --mime TYPE", "Upload a PNG, JPEG, GIF or WebP image of up to 5 MB"],
  test: ["--id ID", "Send a test to the configured test inbox; needed before sending"],
  reconcile: ["--id ID", "Sync the audience and count who a send would reach"],
  send: ["--id ID --count N --sha256 REVIEW_SHA256", "Send once with the reviewed count and review_sha256; never retry an uncertain send"],
  stats: ["--id ID [--people]", "Report results; --people lists individuals and needs the send token"],
};
export const failure = (code: string, message: string, next_action: string) => ({
  ok: false as const,
  code,
  message,
  next_action,
});
