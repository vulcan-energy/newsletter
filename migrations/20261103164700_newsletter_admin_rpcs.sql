-- Insert and erasure share a transaction-scoped address lock, including when no row exists.
CREATE OR REPLACE FUNCTION public.newsletter_insert_subscriber(p_row jsonb, p_hash text)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path = public AS $$
DECLARE inserted public.newsletter_subscribers;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(p_hash, 0));
  IF EXISTS (SELECT 1 FROM public.newsletter_erasures WHERE email_sha256 = p_hash) THEN RETURN NULL; END IF;
  INSERT INTO public.newsletter_subscribers (email, status, tags, consent_source, first_name, last_name, company,
    external_id, status_changed_at, consent_at, consent_ip, updated_at)
  VALUES (p_row->>'email', p_row->>'status', ARRAY(SELECT jsonb_array_elements_text(p_row->'tags')),
    p_row->>'consent_source', p_row->>'first_name', p_row->>'last_name', p_row->>'company', p_row->>'external_id',
    COALESCE((p_row->>'status_changed_at')::timestamptz, now()), (p_row->>'consent_at')::timestamptz,
    (p_row->>'consent_ip')::inet, (p_row->>'updated_at')::timestamptz) RETURNING * INTO inserted;
  RETURN to_jsonb(inserted);
END;
$$;
CREATE OR REPLACE FUNCTION public.newsletter_begin_erasure(p_email text, p_hash text, p_expected_updated_at timestamptz, p_status text)
RETURNS boolean LANGUAGE plpgsql SECURITY INVOKER SET search_path = public AS $$
DECLARE current_row public.newsletter_subscribers;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(p_hash, 0));
  SELECT * INTO current_row FROM public.newsletter_subscribers WHERE email = p_email FOR UPDATE;
  IF current_row.updated_at IS DISTINCT FROM p_expected_updated_at THEN RETURN false; END IF;
  INSERT INTO public.newsletter_erasures(email_sha256) VALUES (p_hash) ON CONFLICT DO NOTHING;
  UPDATE public.newsletter_subscribers SET status = p_status, status_changed_at = clock_timestamp(), updated_at = clock_timestamp()
    WHERE email = p_email;
  RETURN true;
END;
$$;
CREATE OR REPLACE FUNCTION public.newsletter_resubscribe(p_id uuid, p_hash text, p_expected_updated_at timestamptz, p_reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path = public AS $$
DECLARE changed public.newsletter_subscribers;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(p_hash, 0));
  IF EXISTS (SELECT 1 FROM public.newsletter_erasures WHERE email_sha256 = p_hash) THEN RETURN NULL; END IF;
  UPDATE public.newsletter_subscribers SET status = 'subscribed', consent_source = p_reason,
    consent_at = clock_timestamp(), resubscribed_at = clock_timestamp(), status_changed_at = clock_timestamp(), updated_at = clock_timestamp()
    WHERE id = p_id AND updated_at = p_expected_updated_at AND status <> 'cleaned' RETURNING * INTO changed;
  IF NOT FOUND THEN RETURN NULL; END IF;
  RETURN to_jsonb(changed);
END;
$$;
REVOKE ALL ON FUNCTION public.newsletter_insert_subscriber(jsonb, text), public.newsletter_begin_erasure(text, text, timestamptz, text), public.newsletter_resubscribe(uuid, text, timestamptz, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.newsletter_insert_subscriber(jsonb, text), public.newsletter_begin_erasure(text, text, timestamptz, text), public.newsletter_resubscribe(uuid, text, timestamptz, text) TO service_role;
