import { describe, it, expect } from "vitest";
import { nextStatus } from "./rules.js";
const statuses = ["subscribed", "unsubscribed", "cleaned"] as const;
describe("consent transitions", () => {
  for (const status of statuses) {
    for (const type of [
      "signup",
      "edit",
      "import",
      "delivered",
      "opened",
      "clicked",
      "failed",
      "suppressed",
      "provider_subscribed",
      "temporary_bounce",
    ] as const) {
      it(`${status} is unchanged by ${type}`, () =>
        expect(nextStatus({ status }, { type })).toBe(status));
    }
    for (const type of ["complained", "contact_unsubscribed"] as const) {
      it(`${type} suppresses ${status}`, () =>
        expect(nextStatus({ status }, { type })).toBe(
          status === "cleaned" ? "cleaned" : "unsubscribed",
        ));
    }
    it(`permanent bounce cleans ${status}`, () =>
      expect(nextStatus({ status }, { type: "permanent_bounce" })).toBe(
        "cleaned",
      ));
    it(`external suppression respects ${status}`, () =>
      expect(
        nextStatus(
          { status },
          {
            type: "external_suppression",
            status: "unsubscribed",
            at: "2026-01-02T00:00:00Z",
          },
        ),
      ).toBe(status === "cleaned" ? "cleaned" : "unsubscribed"));
    it(`resubscribe respects ${status}`, () =>
      status === "cleaned"
        ? expect(() =>
            nextStatus({ status }, { type: "resubscribe" }),
          ).toThrow()
        : expect(nextStatus({ status }, { type: "resubscribe" })).toBe(
            "subscribed",
          ));
  }
  it("only a newer explicit resubscribe defeats an external suppression", () => {
    const row = {
      status: "subscribed" as const,
      resubscribed_at: "2026-02-01T00:00:00Z",
    };
    expect(
      nextStatus(row, {
        type: "external_suppression",
        status: "unsubscribed",
        at: "2026-01-01T00:00:00Z",
      }),
    ).toBe("subscribed");
    expect(
      nextStatus(row, {
        type: "external_suppression",
        status: "cleaned",
        at: row.resubscribed_at,
      }),
    ).toBe("cleaned");
  });
});
