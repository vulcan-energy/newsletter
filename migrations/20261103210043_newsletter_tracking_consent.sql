-- Tracking consent is independent of permission to receive the newsletter. Existing rows remain untracked.
ALTER TABLE public.newsletter_subscribers
  ADD COLUMN tracking_token uuid,
  ADD COLUMN tracking_consent_source text,
  ADD COLUMN tracking_granted_at timestamptz,
  ADD COLUMN tracking_revoked_at timestamptz,
  ADD CONSTRAINT newsletter_tracking_consent_valid CHECK (tracking_token IS NULL OR
    (status = 'subscribed' AND nullif(btrim(tracking_consent_source), '') IS NOT NULL
      AND tracking_granted_at IS NOT NULL AND tracking_revoked_at IS NULL));
CREATE UNIQUE INDEX newsletter_tracking_token ON public.newsletter_subscribers(tracking_token) WHERE tracking_token IS NOT NULL;
ALTER TABLE public.newsletter_campaigns
  ADD COLUMN tracking_links text[] NOT NULL DEFAULT '{}',
  ADD COLUMN tracking_started_at timestamptz,
  ADD COLUMN tracking_recipient_count integer CHECK (tracking_recipient_count >= 0);

CREATE FUNCTION public.newsletter_tracking_consent_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = public AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status = 'subscribed' AND nullif(btrim(NEW.tracking_consent_source), '') IS NOT NULL THEN
      NEW.tracking_token := gen_random_uuid();
      NEW.tracking_granted_at := clock_timestamp();
      NEW.tracking_revoked_at := NULL;
    ELSE
      NEW.tracking_token := NULL;
      NEW.tracking_consent_source := NULL;
      NEW.tracking_granted_at := NULL;
      NEW.tracking_revoked_at := NULL;
    END IF;
  ELSE
    IF NEW.status <> 'subscribed' OR NEW.tracking_token IS NULL THEN
      NEW.tracking_token := NULL;
      NEW.tracking_consent_source := OLD.tracking_consent_source;
      NEW.tracking_granted_at := OLD.tracking_granted_at;
      IF OLD.tracking_token IS NOT NULL THEN NEW.tracking_revoked_at := clock_timestamp(); END IF;
    ELSIF NEW.tracking_token IS DISTINCT FROM OLD.tracking_token THEN
      IF nullif(btrim(NEW.tracking_consent_source), '') IS NULL THEN RAISE EXCEPTION 'Tracking consent proof required'; END IF;
      NEW.tracking_granted_at := clock_timestamp();
      NEW.tracking_revoked_at := NULL;
    END IF;
    IF NEW.tracking_token IS DISTINCT FROM OLD.tracking_token OR NEW.status IS DISTINCT FROM OLD.status THEN
      NEW.updated_at := greatest(NEW.updated_at, clock_timestamp(), OLD.updated_at + interval '1 millisecond');
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER newsletter_tracking_consent_guard BEFORE INSERT OR UPDATE ON public.newsletter_subscribers
FOR EACH ROW EXECUTE FUNCTION public.newsletter_tracking_consent_guard();

-- A delivered link must always keep its original destination and consent cutoff.
CREATE FUNCTION public.newsletter_tracking_campaign_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = public AS $$
BEGIN
  -- Consent grants and the issue cutoff must use the same clock.
  IF OLD.provider_broadcast_id IS NULL AND NEW.provider_broadcast_id IS NULL
    AND NEW.status = 'sending' AND NEW.tracking_started_at IS NOT NULL
    THEN NEW.tracking_started_at := clock_timestamp(); END IF;
  IF OLD.provider_broadcast_id IS NOT NULL AND OLD.tracking_started_at IS NOT NULL AND
    (NEW.provider_broadcast_id IS DISTINCT FROM OLD.provider_broadcast_id OR NEW.tracking_links IS DISTINCT FROM OLD.tracking_links
      OR NEW.tracking_started_at IS DISTINCT FROM OLD.tracking_started_at)
    THEN RAISE EXCEPTION 'Broadcast tracking links are immutable'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER newsletter_tracking_campaign_guard BEFORE UPDATE ON public.newsletter_campaigns
FOR EACH ROW EXECUTE FUNCTION public.newsletter_tracking_campaign_guard();

-- Preserve the insertion/erasure address lock; only an explicit source opts a newly inserted row in.
CREATE OR REPLACE FUNCTION public.newsletter_insert_subscriber(p_row jsonb, p_hash text)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path = public AS $$
DECLARE inserted public.newsletter_subscribers;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(p_hash, 0));
  IF EXISTS (SELECT 1 FROM public.newsletter_erasures WHERE email_sha256 = p_hash) THEN RETURN NULL; END IF;
  INSERT INTO public.newsletter_subscribers (email, status, tags, consent_source, first_name, last_name, company,
    external_id, status_changed_at, consent_at, consent_ip, updated_at, tracking_consent_source)
  VALUES (p_row->>'email', p_row->>'status', ARRAY(SELECT jsonb_array_elements_text(p_row->'tags')),
    p_row->>'consent_source', p_row->>'first_name', p_row->>'last_name', p_row->>'company', p_row->>'external_id',
    COALESCE((p_row->>'status_changed_at')::timestamptz, now()), (p_row->>'consent_at')::timestamptz,
    (p_row->>'consent_ip')::inet, (p_row->>'updated_at')::timestamptz, p_row->>'tracking_consent_source') RETURNING * INTO inserted;
  RETURN to_jsonb(inserted);
END;
$$;
REVOKE ALL ON FUNCTION public.newsletter_tracking_consent_guard(), public.newsletter_tracking_campaign_guard(), public.newsletter_insert_subscriber(jsonb, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.newsletter_tracking_consent_guard(), public.newsletter_tracking_campaign_guard(), public.newsletter_insert_subscriber(jsonb, text) TO service_role;
