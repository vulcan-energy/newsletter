export type Contact = { id: string; email: string; unsubscribed: boolean };
export type NewContact = {
  email: string;
  firstName?: string;
  lastName?: string;
  unsubscribed: boolean;
};
export interface ContactProvider {
  listContacts(audience: string): AsyncIterable<Contact>;
  findContact(email: string): Promise<Contact | null>;
  createContact(contact: NewContact): Promise<string>;
  deleteContact(id: string): Promise<void>;
  setUnsubscribed(id: string): Promise<void>;
  resubscribe(id: string): Promise<void>;
  ensureAudience(name: string): Promise<string>;
  addToAudience(id: string, audience: string): Promise<void>;
  removeFromAudience(id: string, audience: string): Promise<void>;
}

export type EventType =
  | "delivered"
  | "opened"
  | "clicked"
  | "bounced"
  | "complained"
  | "contact_unsubscribed"
  | "failed"
  | "suppressed";
export type NormalizedEvent = {
  id: string;
  type: EventType;
  email: string;
  occurredAt: string;
  broadcastId?: string;
  fromDomain?: string;
  permanent?: boolean;
  url?: string | null;
};
export interface WebhookProvider extends ContactProvider {
  parseWebhook(rawBody: string, headers: Headers): NormalizedEvent[];
}
export type Message = {
  subject: string;
  html: string;
  from: string;
  replyTo: string;
  previewText?: string;
};
// "missing": the provider no longer has it. Providers only delete unsent broadcasts.
export type BroadcastState = "draft" | "sending" | "sent" | "unknown" | "missing";
export interface EmailProvider extends WebhookProvider {
  assertTrackingDisabled(from: string): Promise<void>;
  setTrackingToken(id: string, token: string | null): Promise<void>;
  createBroadcast(input: Message & { audience: string }): Promise<string>;
  sendBroadcast(id: string): Promise<void>;
  getBroadcastState(id: string): Promise<BroadcastState>;
  sendTest(input: Message & { to: string }): Promise<void>;
}
