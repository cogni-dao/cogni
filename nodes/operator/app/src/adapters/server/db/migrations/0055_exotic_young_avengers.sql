ALTER TABLE "akash_tx_allocations" ADD COLUMN "egress_key_version" text;--> statement-breakpoint
ALTER TABLE "akash_tx_allocations" ADD COLUMN "egress_observations" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "akash_tx_allocations" ADD CONSTRAINT "akash_tx_allocations_egress_observations_check" CHECK (jsonb_typeof("akash_tx_allocations"."egress_observations") = 'array' AND jsonb_array_length("akash_tx_allocations"."egress_observations") <= 4);--> statement-breakpoint
-- Additive and inert: no receipt is enrolled by this migration. No existing gate is changed.
CREATE FUNCTION public.cogni_egress_receipt_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public AS $$
BEGIN
  IF OLD.egress_key_version IS NOT NULL AND NEW.egress_key_version IS DISTINCT FROM OLD.egress_key_version THEN
    RAISE EXCEPTION 'egress_version_is_immutable' USING ERRCODE = '23514';
  END IF;
  IF NEW.state IN ('released', 'failed') THEN NEW.egress_observations := '[]'::jsonb; END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER cogni_egress_receipt_guard BEFORE UPDATE ON public.akash_tx_allocations
FOR EACH ROW EXECUTE FUNCTION public.cogni_egress_receipt_guard();
--> statement-breakpoint
CREATE FUNCTION public.cogni_egress_pin(p_scope text, p_receipt uuid, p_node uuid,
  p_lane text, p_uid text, p_version text, p_deadline bigint) RETURNS text
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public SET lock_timeout = '100ms' AS $$
DECLARE r public.akash_tx_allocations%ROWTYPE;
BEGIN
  IF p_scope IS NULL OR p_receipt IS NULL OR p_node IS NULL OR p_lane IS NULL OR p_uid IS NULL OR p_version IS NULL OR p_deadline IS NULL THEN
    RAISE EXCEPTION 'egress_invalid_identity' USING ERRCODE = '22023'; END IF;
  IF floor(extract(epoch FROM clock_timestamp()) * 1000) >= p_deadline THEN
    RAISE EXCEPTION 'egress_write_deadline' USING ERRCODE = '57014'; END IF;
  IF p_version !~ '^[a-zA-Z0-9._-]{1,64}$' THEN
    RAISE EXCEPTION 'egress_invalid_version' USING ERRCODE = '22023'; END IF;
  SELECT * INTO r FROM public.akash_tx_allocations
    WHERE id = p_receipt AND wallet_scope = p_scope FOR UPDATE;
  IF NOT FOUND OR r.node_id <> p_node OR r.environment <> p_lane OR r.composite_uid <> p_uid
    OR r.state NOT IN ('preparing', 'allocated') THEN
    RAISE EXCEPTION 'egress_receipt_mismatch' USING ERRCODE = '22023'; END IF;
  IF floor(extract(epoch FROM clock_timestamp()) * 1000) >= p_deadline THEN
    RAISE EXCEPTION 'egress_write_deadline' USING ERRCODE = '57014'; END IF;
  IF r.egress_key_version IS NULL THEN
    UPDATE public.akash_tx_allocations SET egress_key_version = p_version WHERE id = r.id;
    RETURN p_version;
  END IF;
  RETURN r.egress_key_version;
END $$;
--> statement-breakpoint
CREATE FUNCTION public.cogni_egress_report(p_scope text, p_receipt uuid, p_node uuid,
  p_lane text, p_uid text, p_version text, p_ipv4 text, p_origin text, p_deadline bigint) RETURNS void
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public SET lock_timeout = '100ms' AS $$
DECLARE r public.akash_tx_allocations%ROWTYPE; observations jsonb; observed_ms bigint; address inet;
BEGIN
  IF p_scope IS NULL OR p_receipt IS NULL OR p_node IS NULL OR p_lane IS NULL OR p_uid IS NULL OR p_version IS NULL OR p_ipv4 IS NULL OR p_origin IS NULL OR p_deadline IS NULL THEN
    RAISE EXCEPTION 'egress_invalid_identity' USING ERRCODE = '22023'; END IF;
  observed_ms := floor(extract(epoch FROM clock_timestamp()) * 1000);
  IF observed_ms >= p_deadline THEN RAISE EXCEPTION 'egress_write_deadline' USING ERRCODE = '57014'; END IF;
  address := p_ipv4::inet;
  IF family(address) <> 4 OR masklen(address) <> 32 OR host(address) <> p_ipv4
    OR address <<= ANY(ARRAY['0.0.0.0/8','10.0.0.0/8','100.64.0.0/10','127.0.0.0/8',
      '169.254.0.0/16','172.16.0.0/12','192.0.0.0/24','192.0.2.0/24','192.168.0.0/16',
      '198.18.0.0/15','198.51.100.0/24','203.0.113.0/24','224.0.0.0/3']::inet[])
    OR length(p_origin) > 256 OR p_origin !~ '^https://[a-zA-Z0-9.-]+(:[0-9]{1,5})?$' THEN
    RAISE EXCEPTION 'egress_invalid_observer' USING ERRCODE = '22023'; END IF;
  SELECT * INTO r FROM public.akash_tx_allocations
    WHERE id = p_receipt AND wallet_scope = p_scope FOR UPDATE;
  IF NOT FOUND OR r.node_id <> p_node OR r.environment <> p_lane OR r.composite_uid <> p_uid
    OR r.egress_key_version IS DISTINCT FROM p_version OR p_version IS NULL
    OR r.state NOT IN ('preparing', 'allocated') THEN
    RAISE EXCEPTION 'egress_receipt_mismatch' USING ERRCODE = '22023'; END IF;
  observed_ms := floor(extract(epoch FROM clock_timestamp()) * 1000);
  IF observed_ms >= p_deadline THEN RAISE EXCEPTION 'egress_write_deadline' USING ERRCODE = '57014'; END IF;
  SELECT coalesce(jsonb_agg(item), '[]'::jsonb) INTO observations
    FROM jsonb_array_elements(r.egress_observations) item
    WHERE (item->>'expiresAt')::bigint > observed_ms AND item->>'ipv4' <> p_ipv4;
  IF jsonb_array_length(observations) >= 4 THEN
    RAISE EXCEPTION 'egress_observation_capacity' USING ERRCODE = '54000'; END IF;
  observations := observations || jsonb_build_array(jsonb_build_object('ipv4', p_ipv4,
    'observedAt', observed_ms, 'expiresAt', observed_ms + 600000, 'observerOrigin', p_origin));
  -- Recheck AFTER lock and construction: canceled/queued work must not refresh a late request.
  IF floor(extract(epoch FROM clock_timestamp()) * 1000) >= p_deadline THEN
    RAISE EXCEPTION 'egress_write_deadline' USING ERRCODE = '57014'; END IF;
  UPDATE public.akash_tx_allocations SET egress_observations = observations WHERE id = r.id;
END $$;
