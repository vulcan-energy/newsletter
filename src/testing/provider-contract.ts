import assert from "node:assert/strict";
import type { EmailProvider } from "../provider.js";
// Shared by CI fakes and the explicitly invoked owner-only live check.
export async function providerContract(
  provider: EmailProvider,
  config = {
    email: "person@example.com",
    recipient: "owner@example.com",
    audience: "everyone",
    tag: "tag:test",
    from: "sender@example.com",
    replyTo: "reply@example.com",
  },
) {
  await provider.assertTrackingDisabled(config.from);
  const a = await provider.ensureAudience(config.audience);
  const b = await provider.ensureAudience(config.tag);
  assert.equal(await provider.ensureAudience(config.audience), a);
  const id = await provider.createContact({
    email: config.email,
    unsubscribed: true,
  });
  assert.equal(
    await provider.createContact({ email: config.email, unsubscribed: false }),
    id,
  );
  assert.equal((await provider.findContact(config.email))?.unsubscribed, true);
  await provider.addToAudience(id, a);
  await provider.addToAudience(id, b);
  await provider.removeFromAudience(id, b);
  const list = [];
  for await (const c of provider.listContacts(a)) list.push(c);
  assert.equal(list.length, 1);
  assert.equal(list[0].id, id);
  assert.equal((await provider.findContact(config.email))?.unsubscribed, true);
  await provider.setTrackingToken(id, "00000000-0000-4000-8000-000000000001");
  assert.equal((await provider.findContact(config.email))?.unsubscribed, true);
  await provider.setTrackingToken(id, null);
  assert.equal((await provider.findContact(config.email))?.unsubscribed, true);
  await provider.resubscribe(id);
  assert.equal((await provider.findContact(config.email))?.unsubscribed, false);
  await provider.setUnsubscribed(id);
  assert.equal((await provider.findContact(config.email))?.unsubscribed, true);
  const recipientId = await provider.createContact({
    email: config.recipient,
    unsubscribed: false,
  });
  await provider.addToAudience(recipientId, a);
  assert.equal(
    (await provider.findContact(config.recipient))?.unsubscribed,
    false,
  );
  const message = {
    audience: a,
    subject: "Contract example",
    html: '<a href="{{unsubscribe_url}}">Leave</a>',
    from: config.from,
    replyTo: config.replyTo,
  };
  const broadcast = await provider.createBroadcast(message);
  assert.equal(await provider.getBroadcastState(broadcast), "draft");
  await provider.sendBroadcast(broadcast);
  let state = await provider.getBroadcastState(broadcast);
  for (let i = 0; state === "sending" && i < 30; i++) {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    state = await provider.getBroadcastState(broadcast);
  }
  assert.equal(state, "sent");
  await provider.sendTest({
    ...message,
    subject: "[TEST] Contract example",
    to: config.recipient,
  });
  await provider.deleteContact(id);
  await provider.deleteContact(recipientId);
  assert.equal(await provider.findContact(config.email), null);
  assert.equal(await provider.findContact(config.recipient), null);
  return { audiences: [a, b], broadcast };
}
