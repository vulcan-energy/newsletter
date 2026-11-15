import type { Status } from "./rules.js";
export type CampaignStats = {
  emails_sent: number;
  delivered: number;
  unique_opens: number;
  opens: number;
  unique_clicks: number;
  clicks: number;
  bounces: number;
  complaints: number;
  unsubscribes: number;
  unsubscribes_approximate: boolean;
  links: { url: string; clicks: number; unique_clicks: number }[];
};
export type ErasedStats = { kind: "erased"; totals: CampaignStats };
export type StoredStats = CampaignStats | ErasedStats;
export type NewsletterCampaign = {
  id: string;
  slug: string;
  subject: string;
  preview_text: string;
  html: string;
  html_sha256: string;
  status: "draft" | "sending" | "sent" | "send_unknown" | "failed";
  source: "external" | "provider";
  target_tag: string | null;
  is_public: boolean;
  external_campaign_id: string | null;
  provider_broadcast_id: string | null;
  recipient_count: number | null;
  tracking_started_at: string | null;
  tracking_links: string[];
  tracking_recipient_count: number | null;
  stats: StoredStats | null;
  last_test_sha256: string | null;
  sent_by: string | null;
  sent_at: string | null;
  created_at: string;
  updated_at: string;
};
export type NewsletterSubscriber = {
  id: string;
  email: string;
  first_name: string | null;
  last_name: string | null;
  company: string | null;
  tags: string[];
  status: Status;
  status_changed_at: string;
  resubscribed_at: string | null;
  consent_source: string;
  consent_at: string | null;
  consent_ip: string | null;
  tracking_token: string | null;
  tracking_consent_source: string | null;
  tracking_granted_at: string | null;
  tracking_revoked_at: string | null;
  external_id: string | null;
  provider_contact_id: string | null;
  created_at: string;
  updated_at: string;
};
export type NewsletterEvent = {
  id: string;
  campaign_id: string | null;
  subscriber_id: string | null;
  type:
    | "delivered"
    | "opened"
    | "clicked"
    | "bounced"
    | "complained"
    | "unsubscribed"
    | "failed"
    | "suppressed";
  url: string | null;
  occurred_at: string;
  provider_event_id: string | null;
};
export type NewsletterTables = {
  newsletter_campaigns: NewsletterCampaign;
  newsletter_subscribers: NewsletterSubscriber;
  newsletter_events: NewsletterEvent;
};
