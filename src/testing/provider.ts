import type {
  Contact,
  EmailProvider,
  Message,
  BroadcastState,
  NewContact,
} from "../provider.js";
export class FakeProvider implements EmailProvider {
  trackingTokens = new Map<string, string | null>();
  async assertTrackingDisabled(_from: string) {}
  async setTrackingToken(id: string, token: string | null) {
    this.trackingTokens.set(id, token);
  }
  broadcasts = new Map<string, BroadcastState>();
  sendCalls = 0;
  async createBroadcast(_input: Message & { audience: string }) {
    const id = `broadcast-${this.broadcasts.size}`;
    this.broadcasts.set(id, "draft");
    return id;
  }
  async sendBroadcast(id: string) {
    this.sendCalls++;
    this.broadcasts.set(id, "sent");
  }
  async getBroadcastState(id: string) {
    return this.broadcasts.get(id) ?? "unknown";
  }
  async sendTest(_input: Message & { to: string }) {}
  parseWebhook(): never {
    throw new Error("Use signed fixture adapter");
  }
  contacts = new Map<string, Contact>();
  audiences = new Map<string, string>();
  memberships = new Map<string, Set<string>>();
  async findContact(email: string) {
    return [...this.contacts.values()].find((c) => c.email === email) ?? null;
  }
  async createContact(input: NewContact) {
    const existing = await this.findContact(input.email);
    if (existing) return existing.id;
    const id = `contact-${this.contacts.size}`;
    this.contacts.set(id, { ...input, id });
    return id;
  }
  async deleteContact(id: string) {
    this.contacts.delete(id);
    for (const members of this.memberships.values()) members.delete(id);
  }
  async setUnsubscribed(id: string) {
    this.contacts.get(id)!.unsubscribed = true;
  }
  async resubscribe(id: string) {
    this.contacts.get(id)!.unsubscribed = false;
  }
  async ensureAudience(name: string) {
    if (!this.audiences.has(name)) {
      const id = `audience-${this.audiences.size}`;
      this.audiences.set(name, id);
      this.memberships.set(id, new Set());
    }
    return this.audiences.get(name)!;
  }
  async addToAudience(id: string, audience: string) {
    this.memberships.get(audience)!.add(id);
  }
  async removeFromAudience(id: string, audience: string) {
    this.memberships.get(audience)!.delete(id);
  }
  async *listContacts(audience: string) {
    for (const id of this.memberships.get(audience) ?? [])
      yield this.contacts.get(id)!;
  }
}
