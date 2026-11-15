import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
it("isolates tables, preserves anonymous events, bounds assets and enforces identity", () => {
  const sql = readFileSync(new URL("../schema.sql", import.meta.url), "utf8");
  for (const table of ["subscribers", "campaigns", "events", "erasures"])
    expect(sql).toContain(
      `ALTER TABLE public.newsletter_${table} ENABLE ROW LEVEL SECURITY`,
    );
  expect(sql).not.toMatch(/CREATE POLICY/i);
  expect(sql).toContain("lower(email)");
  expect(sql).toContain("ON DELETE SET NULL");
  expect(sql).toContain("provider_event_id text UNIQUE");
  expect(sql).toContain("5242880");
  expect(sql).toContain("ARRAY['image/*']");
});

it("records webhook transitions and receipts atomically with service-only invoker rights", () => {
  const sql = readFileSync(new URL("../migrations/20261103164600_newsletter_event_rpc.sql", import.meta.url), "utf8");
  expect(sql).toContain("CREATE OR REPLACE FUNCTION public.newsletter_record_event");
  expect(sql).toContain("FOR UPDATE");
  expect(sql).toContain("SECURITY INVOKER");
  expect(sql).toContain("FROM PUBLIC, anon, authenticated");
  expect(
    sql.indexOf("UPDATE public.newsletter_subscribers SET status"),
  ).toBeLessThan(sql.indexOf("INSERT INTO public.newsletter_events"));
  expect(sql).toContain("p_expected_updated_at");
});
