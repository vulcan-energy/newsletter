import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
it("commits erasure contributions and raw-history deletion atomically behind service-only rights", () => {
  const sql = readFileSync(
    new URL("../migrations/20261103164812_newsletter_finish_erasure.sql", import.meta.url),
    "utf8",
  );
  expect(sql).toContain("SECURITY INVOKER SET search_path = public");
  expect(sql).toContain("pg_advisory_xact_lock");
  expect(sql).toContain("FOR UPDATE");
  expect(sql).toContain("array_agg(id ORDER BY id)");
  expect(sql).toContain("current_stats IS DISTINCT FROM");
  expect(sql.indexOf("current_stats IS DISTINCT FROM")).toBeLessThan(
    sql.indexOf("UPDATE public.newsletter_campaigns"),
  );
  expect(sql.indexOf("UPDATE public.newsletter_campaigns")).toBeLessThan(
    sql.indexOf("DELETE FROM public.newsletter_events"),
  );
  expect(sql.indexOf("DELETE FROM public.newsletter_events")).toBeLessThan(
    sql.indexOf("DELETE FROM public.newsletter_subscribers"),
  );
  expect(sql).toContain("FROM PUBLIC, anon, authenticated");
  expect(sql).toContain("TO service_role");
});
