-- The status transition and event receipt commit together, after any provider suppression.
CREATE OR REPLACE FUNCTION public.newsletter_record_event(
  p_subscriber_id uuid, p_expected_updated_at timestamptz, p_status text,
  p_contact_unsubscribed boolean, p_event jsonb
) RETURNS boolean LANGUAGE plpgsql SECURITY INVOKER SET search_path = public AS $$
DECLARE current_row public.newsletter_subscribers;
BEGIN
  IF p_subscriber_id IS NOT NULL THEN
    SELECT * INTO current_row FROM public.newsletter_subscribers WHERE id = p_subscriber_id FOR UPDATE;
    IF NOT FOUND OR current_row.updated_at IS DISTINCT FROM p_expected_updated_at THEN RETURN false; END IF;
  END IF;
  IF EXISTS (SELECT 1 FROM public.newsletter_events WHERE provider_event_id = p_event->>'provider_event_id') THEN RETURN true; END IF;
  IF p_contact_unsubscribed AND (p_subscriber_id IS NULL OR current_row.status <> 'subscribed') THEN RETURN true; END IF;
  IF p_subscriber_id IS NOT NULL AND current_row.status <> p_status THEN
    UPDATE public.newsletter_subscribers SET status = p_status,
      status_changed_at = (p_event->>'occurred_at')::timestamptz, updated_at = clock_timestamp()
      WHERE id = p_subscriber_id;
  END IF;
  INSERT INTO public.newsletter_events (campaign_id, subscriber_id, type, url, occurred_at, provider_event_id)
    VALUES ((p_event->>'campaign_id')::uuid, p_subscriber_id, p_event->>'type', p_event->>'url',
      (p_event->>'occurred_at')::timestamptz, p_event->>'provider_event_id')
    ON CONFLICT (provider_event_id) DO NOTHING;
  RETURN true;
END;
$$;
REVOKE ALL ON FUNCTION public.newsletter_record_event(uuid, timestamptz, text, boolean, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.newsletter_record_event(uuid, timestamptz, text, boolean, jsonb) TO service_role;
