CREATE TABLE public.newsletter_subscribers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL CHECK (email = lower(btrim(email))),
  first_name text, last_name text, company text,
  tags text[] NOT NULL DEFAULT '{}',
  status text NOT NULL CHECK (status IN ('subscribed', 'unsubscribed', 'cleaned')),
  status_changed_at timestamptz NOT NULL DEFAULT now(), resubscribed_at timestamptz,
  consent_source text NOT NULL, consent_at timestamptz, consent_ip inet,
  external_id text, provider_contact_id text,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX newsletter_subscribers_email ON public.newsletter_subscribers (lower(email));
CREATE TABLE public.newsletter_campaigns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), slug text NOT NULL UNIQUE,
  subject text NOT NULL, preview_text text NOT NULL DEFAULT '', html text NOT NULL, html_sha256 text NOT NULL,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'sending', 'sent', 'send_unknown', 'failed')),
  source text NOT NULL CHECK (source IN ('external', 'provider')),
  target_tag text, is_public boolean NOT NULL DEFAULT false,
  external_campaign_id text UNIQUE, provider_broadcast_id text UNIQUE,
  recipient_count integer, stats jsonb, last_test_sha256 text, sent_by text, sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.newsletter_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id uuid REFERENCES public.newsletter_campaigns(id),
  subscriber_id uuid REFERENCES public.newsletter_subscribers(id) ON DELETE SET NULL,
  type text NOT NULL CHECK (type IN ('delivered', 'opened', 'clicked', 'bounced', 'complained', 'unsubscribed', 'failed', 'suppressed')),
  url text, occurred_at timestamptz NOT NULL, provider_event_id text UNIQUE
);
CREATE INDEX newsletter_events_campaign_type ON public.newsletter_events (campaign_id, type);
CREATE INDEX newsletter_events_subscriber_time ON public.newsletter_events (subscriber_id, occurred_at);
CREATE TABLE public.newsletter_erasures (email_sha256 text PRIMARY KEY, erased_at timestamptz NOT NULL DEFAULT now());
ALTER TABLE public.newsletter_subscribers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.newsletter_campaigns ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.newsletter_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.newsletter_erasures ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.newsletter_subscribers, public.newsletter_campaigns, public.newsletter_events, public.newsletter_erasures FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.newsletter_subscribers, public.newsletter_campaigns, public.newsletter_events, public.newsletter_erasures TO service_role;
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('newsletter-assets', 'newsletter-assets', true, 5242880, ARRAY['image/*']);
