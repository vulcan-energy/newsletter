import { createNewsletter, importSubscriber, allRows, type NewsletterConfig } from "@vulcan-energy/newsletter";
declare const config: NewsletterConfig;
const core = createNewsletter(config);
const campaign = await core.campaign("example");
const subject: string = campaign.subject;
// @ts-expect-error Campaign fields must be checked for external callers.
campaign.subjet;
const sent = await core.send(
  { campaign_id: "example", expected_recipient_count: 1, review_sha256: "hash" },
  "owner",
);
const notified: boolean = sent.notificationFailed;
// @ts-expect-error Send results must not erase their row type.
sent.recipient_cout;
const person = await importSubscriber(config.supabase, {
  email: "person@example.com",
  status: "subscribed",
  tags: [],
  consent_source: "test",
});
// @ts-expect-error Subscriber results must not be any.
person?.consent_sorce;
const people = await allRows(config.supabase, "newsletter_subscribers");
const email: string = people[0].email;
// @ts-expect-error Table result types must reflect their rows.
people[0].html;
const onSent: NonNullable<NewsletterConfig["onSent"]> = async (row) => {
  const id: string = row.id;
  // @ts-expect-error Callbacks must carry the same campaign type.
  row.recipients_count;
};
void [subject, notified, email, onSent];
