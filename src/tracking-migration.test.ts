import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
const name = "20261103210043_newsletter_tracking_consent.sql";
it("keeps the additive consent migration mirrored, guarded and service-only", () => {
  const sql = readFileSync(
    // The package's own copy; the host's release checks keep its mirror identical.
    new URL(`../migrations/${name}`, import.meta.url),
    "utf8",
  );
  expect(sql).toContain("ADD COLUMN tracking_token uuid");
  expect(sql).toContain("tracking_consent_source");
  expect(sql).toContain("NEW.tracking_token := NULL");
  expect(sql).toContain("OLD.updated_at + interval '1 millisecond'");
  expect(sql).toContain("OLD.provider_broadcast_id IS NOT NULL");
  expect(sql).toContain("p_row->>'tracking_consent_source'");
  expect(sql).toContain("SECURITY INVOKER SET search_path = public");
  expect(sql).toContain("FROM PUBLIC, anon, authenticated");
  expect(sql).toContain("TO service_role");
  expect(
    readFileSync(new URL(`../migrations/${name}`, import.meta.url), "utf8"),
  ).toBe(sql);
});
it("stamps preparation with the database clock before freezing broadcast mappings", () => {
  const sql = readFileSync(
    new URL(`../migrations/${name}`, import.meta.url),
    "utf8",
  );
  const guard = sql.slice(
    sql.indexOf("CREATE FUNCTION public.newsletter_tracking_campaign_guard"),
  );
  expect(guard).toContain(
    "OLD.provider_broadcast_id IS NULL AND NEW.provider_broadcast_id IS NULL",
  );
  expect(guard).toContain(
    "NEW.status = 'sending' AND NEW.tracking_started_at IS NOT NULL",
  );
  expect(guard).toContain("NEW.tracking_started_at := clock_timestamp()");
  expect(
    guard.indexOf("NEW.tracking_started_at := clock_timestamp()"),
  ).toBeLessThan(guard.indexOf("OLD.provider_broadcast_id IS NOT NULL"));
});
