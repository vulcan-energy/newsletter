import { NewsletterError } from "./errors.js";
export type Status = "subscribed" | "unsubscribed" | "cleaned";
export type StatusInput =
  | {
      type: "external_suppression";
      status: Exclude<Status, "subscribed">;
      at: string;
    }
  | {
      type:
        | "signup"
        | "edit"
        | "import"
        | "delivered"
        | "opened"
        | "clicked"
        | "failed"
        | "suppressed"
        | "provider_subscribed"
        | "temporary_bounce"
        | "permanent_bounce"
        | "complained"
        | "contact_unsubscribed"
        | "resubscribe";
      // When the provider says the change happened, for webhook events.
      at?: string;
    };
export function nextStatus(
  row: { status: Status; resubscribed_at?: string | null },
  input: StatusInput,
): Status {
  if (input.type === "resubscribe") {
    if (row.status === "cleaned")
      throw new NewsletterError("A cleaned address cannot be resubscribed");
    return "subscribed";
  }
  if (row.status === "cleaned") return "cleaned";
  if (input.type === "external_suppression") {
    if (!Number.isFinite(Date.parse(input.at)))
      throw new NewsletterError("Suppression timestamp required");
    if (
      row.resubscribed_at &&
      Date.parse(row.resubscribed_at) > Date.parse(input.at)
    )
      return row.status;
    return input.status;
  }
  // A late-delivered opt-out from before an explicit resubscribe is stale.
  if (
    "at" in input &&
    input.at &&
    row.resubscribed_at &&
    Date.parse(input.at) < Date.parse(row.resubscribed_at)
  )
    return row.status;
  if (input.type === "permanent_bounce") return "cleaned";
  if (input.type === "complained" || input.type === "contact_unsubscribed")
    return "unsubscribed";
  return row.status;
}
