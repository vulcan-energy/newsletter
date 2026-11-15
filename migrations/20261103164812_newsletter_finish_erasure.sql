-- Preserve anonymous contributions and remove raw history in one retry-safe commit.
CREATE FUNCTION public.newsletter_finish_erasure(
  p_email text, p_hash text, p_subscriber_id uuid, p_event_ids uuid[], p_campaign_updates jsonb
) RETURNS boolean LANGUAGE plpgsql SECURITY INVOKER SET search_path = public AS $$
DECLARE
  current_id uuid;
  current_stats jsonb;
  change jsonb;
  event_ids uuid[];
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(p_hash, 0));
  IF NOT EXISTS (SELECT 1 FROM public.newsletter_erasures WHERE email_sha256 = p_hash) THEN
    RAISE EXCEPTION 'Erasure has not started';
  END IF;
  SELECT id INTO current_id FROM public.newsletter_subscribers WHERE email = p_email FOR UPDATE;
  IF NOT FOUND THEN RETURN true; END IF;
  IF current_id <> p_subscriber_id THEN RETURN false; END IF;
  SELECT COALESCE(array_agg(id ORDER BY id), '{}'::uuid[]) INTO event_ids
    FROM public.newsletter_events WHERE subscriber_id = current_id;
  IF event_ids IS DISTINCT FROM ARRAY(SELECT unnest(p_event_ids) ORDER BY 1) THEN RETURN false; END IF;

  -- Validate every locked campaign before writing any of them.
  FOR change IN SELECT value FROM jsonb_array_elements(p_campaign_updates) ORDER BY value->>'id' LOOP
    SELECT stats INTO current_stats FROM public.newsletter_campaigns WHERE id = (change->>'id')::uuid FOR UPDATE;
    IF NOT FOUND OR current_stats IS DISTINCT FROM NULLIF(change->'expected_stats', 'null'::jsonb) THEN RETURN false; END IF;
  END LOOP;
  FOR change IN SELECT value FROM jsonb_array_elements(p_campaign_updates) LOOP
    UPDATE public.newsletter_campaigns SET stats = change->'stats' WHERE id = (change->>'id')::uuid;
  END LOOP;
  DELETE FROM public.newsletter_events WHERE subscriber_id = current_id;
  DELETE FROM public.newsletter_subscribers WHERE id = current_id;
  RETURN true;
END;
$$;
REVOKE ALL ON FUNCTION public.newsletter_finish_erasure(text, text, uuid, uuid[], jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.newsletter_finish_erasure(text, text, uuid, uuid[], jsonb) TO service_role;
