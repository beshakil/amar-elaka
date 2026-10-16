-- 0060_local_info_services
--
-- Local information services, first set (ADR 064, schema.md §10): emergency
-- contacts, blood donors with urgent requests, daily bazar prices. The tables
-- of 0011 had no service yet; this migration adds what the services need:
--
--   emergency_service_types  + the national helpline kinds (national_emergency,
--                            health_helpline, child_helpline, legal_aid,
--                            disaster_warning, information, anti_corruption).
--   national_hotlines        seeded (it never was: the feed's emergency card
--                            was always empty).
--   bazar_commodities        the global catalogue seeded (dev seed only so far).
--   NEW tenant_bazar_items   TENANT-SCOPED: the area's own price board — which
--                            commodities, in which unit, in what order. An area
--                            without one uses every active commodity
--                            (bazar_catalogue(), the one rule).
--   NEW bazar_board_sponsors TENANT-SCOPED: the sponsorship slot on the board
--                            (display only; selling it is week 16).
--   bazar_enter_prices()     the fast entry: today's (or yesterday's) price per
--                            item, published at once, staff or field agents.
--   blood_donors             + contact_window_code (preferred contact time),
--                            alerts_enabled; approx_location snapped to a grid
--                            (blood_donor_location_grid_m) by trigger.
--   NEW donor_contact_windows lookup: when a donor may be contacted (local time).
--   NEW blood_group_compatibility lookup: which donor groups a recipient takes.
--   NEW blood_donor_contacts TENANT-SCOPED (the donor's area): every contact,
--                            what the donor sees ("who contacted me") and what
--                            the per-donor daily cap counts. Written only by
--                            blood_donor_record_contact().
--   blood_requests           + location (the hospital), alerted_at.
--   NEW blood_request_alerts TENANT-SCOPED (the donor's area): one row per
--                            urgent-request push, for the per-donor daily cap
--                            and dedupe. Written only by blood_request_alert_donors().
--   moderation_actions       + blood_request_id target (a removed request).
--
-- Radius, never tenant (CLAUDE.md rule 10): blood_donors_near(),
-- blood_requests_near(), blood_requests_summary_near() and
-- emergency_contacts_near() are SECURITY DEFINER readers across areas, like
-- feed_stores(); each checks its caller itself and returns no phone number
-- except emergency_contacts_near() (public institutional numbers).
--
-- Settings: blood_donation_interval_days (0003) stays THE donation gap — the
-- eligible_from trigger already reads it; no second key.
--
-- Error codes: AE901 donor contact refused, AE902 blood request refused,
-- AE903 bazar entry refused. The DETAIL names the reason.

-- ============================================================================
-- Lookups
-- ============================================================================

INSERT INTO public.emergency_service_types (code, label_key, sort_order) VALUES
  ('national_emergency', 'enum.emergency_service_types.national_emergency', 5),
  ('health_helpline', 'enum.emergency_service_types.health_helpline', 110),
  ('child_helpline', 'enum.emergency_service_types.child_helpline', 120),
  ('legal_aid', 'enum.emergency_service_types.legal_aid', 130),
  ('disaster_warning', 'enum.emergency_service_types.disaster_warning', 140),
  ('information', 'enum.emergency_service_types.information', 150),
  ('anti_corruption', 'enum.emergency_service_types.anti_corruption', 160)
ON CONFLICT (code) DO NOTHING;
--> statement-breakpoint

CREATE TABLE public.donor_contact_windows (
  code text NOT NULL, label_key text NOT NULL, sort_order integer NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true,
  -- Local time of the donor's area; both NULL = any time. starts_at > ends_at wraps midnight.
  starts_at time, ends_at time,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT donor_contact_windows_pk PRIMARY KEY (code),
  CONSTRAINT donor_contact_windows_code_ck CHECK (code ~ '^[a-z][a-z0-9_]*$'),
  CONSTRAINT donor_contact_windows_bounds_ck CHECK ((starts_at IS NULL) = (ends_at IS NULL))
);
--> statement-breakpoint
CREATE TRIGGER donor_contact_windows_set_updated_at BEFORE UPDATE ON public.donor_contact_windows
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint
INSERT INTO public.donor_contact_windows (code, label_key, sort_order, starts_at, ends_at) VALUES
  ('any', 'enum.donor_contact_windows.any', 10, NULL, NULL),
  ('morning', 'enum.donor_contact_windows.morning', 20, '06:00', '12:00'),
  ('afternoon', 'enum.donor_contact_windows.afternoon', 30, '12:00', '17:00'),
  ('evening', 'enum.donor_contact_windows.evening', 40, '17:00', '22:00'),
  ('daytime', 'enum.donor_contact_windows.daytime', 50, '08:00', '20:00');
--> statement-breakpoint

-- Red-cell compatibility: a recipient of recipient_code may take donor_code.
CREATE TABLE public.blood_group_compatibility (
  recipient_code text NOT NULL,
  donor_code     text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT blood_group_compatibility_pk PRIMARY KEY (recipient_code, donor_code),
  CONSTRAINT blood_group_compatibility_recipient_fk FOREIGN KEY (recipient_code)
    REFERENCES public.blood_groups (code) ON DELETE RESTRICT,
  CONSTRAINT blood_group_compatibility_donor_fk FOREIGN KEY (donor_code)
    REFERENCES public.blood_groups (code) ON DELETE RESTRICT
);
--> statement-breakpoint
CREATE TRIGGER blood_group_compatibility_set_updated_at BEFORE UPDATE ON public.blood_group_compatibility
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint
INSERT INTO public.blood_group_compatibility (recipient_code, donor_code) VALUES
  ('o_neg', 'o_neg'),
  ('o_pos', 'o_neg'), ('o_pos', 'o_pos'),
  ('a_neg', 'o_neg'), ('a_neg', 'a_neg'),
  ('a_pos', 'o_neg'), ('a_pos', 'o_pos'), ('a_pos', 'a_neg'), ('a_pos', 'a_pos'),
  ('b_neg', 'o_neg'), ('b_neg', 'b_neg'),
  ('b_pos', 'o_neg'), ('b_pos', 'o_pos'), ('b_pos', 'b_neg'), ('b_pos', 'b_pos'),
  ('ab_neg', 'o_neg'), ('ab_neg', 'a_neg'), ('ab_neg', 'b_neg'), ('ab_neg', 'ab_neg'),
  ('ab_pos', 'o_neg'), ('ab_pos', 'o_pos'), ('ab_pos', 'a_neg'), ('ab_pos', 'a_pos'),
  ('ab_pos', 'b_neg'), ('ab_pos', 'b_pos'), ('ab_pos', 'ab_neg'), ('ab_pos', 'ab_pos');
--> statement-breakpoint

-- An in-app "please contact me" to a donor who doesn't share a number.
INSERT INTO public.lead_channels (code, label_key, sort_order) VALUES
  ('donor_request', 'enum.lead_channels.donor_request', 80);
--> statement-breakpoint
-- A donor revealing a blood request's contact number.
INSERT INTO public.lead_sources (code, label_key, sort_order) VALUES
  ('blood_request', 'enum.lead_sources.blood_request', 80);
--> statement-breakpoint

INSERT INTO public.moderation_action_types (code, label_key, sort_order) VALUES
  ('blood_request_removed', 'enum.moderation_action_types.blood_request_removed', 500);
--> statement-breakpoint
INSERT INTO public.moderation_reasons (code, label_key, sort_order) VALUES
  ('fake_blood_request', 'enum.moderation_reasons.fake_blood_request', 430),
  ('blood_request_abuse', 'enum.moderation_reasons.blood_request_abuse', 440);
--> statement-breakpoint

-- ============================================================================
-- National hotlines (GLOBAL reference data)
-- ============================================================================

INSERT INTO public.national_hotlines
  (service_type_code, name_bn, name_en, dial_string, description_bn, description_en, sort_order)
SELECT v.service_type_code, v.name_bn, v.name_en, v.dial_string, v.description_bn, v.description_en, v.sort_order
FROM (VALUES
  ('national_emergency', 'জাতীয় জরুরি সেবা', 'National Emergency Service', '999',
   'পুলিশ, ফায়ার সার্ভিস ও অ্যাম্বুলেন্স — বিনা খরচে, ২৪ ঘণ্টা', 'Police, fire and ambulance — toll-free, 24 hours', 10),
  ('fire_service', 'ফায়ার সার্ভিস ও সিভিল ডিফেন্স', 'Fire Service & Civil Defence', '16163',
   'আগুন, দুর্ঘটনা ও উদ্ধার', 'Fire, accidents and rescue', 20),
  ('health_helpline', 'স্বাস্থ্য বাতায়ন', 'Shastho Batayon (health line)', '16263',
   'ডাক্তারের পরামর্শ ও অ্যাম্বুলেন্সের তথ্য, ২৪ ঘণ্টা', 'Doctor advice and ambulance information, 24 hours', 30),
  ('women_child_helpline', 'নারী ও শিশু নির্যাতন প্রতিরোধ', 'Violence against women & children', '109',
   'নারী ও শিশু নির্যাতন প্রতিরোধে জাতীয় হেল্পলাইন', 'National helpline against violence on women and children', 40),
  ('child_helpline', 'শিশু সহায়তা', 'Child Helpline', '1098',
   'বিপদে পড়া শিশুর জন্য', 'For children at risk', 50),
  ('information', 'জাতীয় তথ্য বাতায়ন', 'National information line', '333',
   'সরকারি সেবা, তথ্য ও অভিযোগ', 'Government services, information and complaints', 60),
  ('disaster_warning', 'দুর্যোগের আগাম বার্তা', 'Disaster early warning', '1090',
   'ঘূর্ণিঝড়, বন্যা ও আবহাওয়ার সতর্কবার্তা', 'Cyclone, flood and weather warnings', 70),
  ('legal_aid', 'সরকারি আইনগত সহায়তা', 'Government legal aid', '16430',
   'বিনা খরচে আইনি পরামর্শ', 'Free legal advice', 80),
  ('anti_corruption', 'দুর্নীতি দমন কমিশন', 'Anti-Corruption Commission', '106',
   'দুর্নীতির অভিযোগ', 'Report corruption', 90)
) AS v (service_type_code, name_bn, name_en, dial_string, description_bn, description_en, sort_order)
WHERE NOT EXISTS (SELECT 1 FROM public.national_hotlines h WHERE h.dial_string = v.dial_string);
--> statement-breakpoint

-- ============================================================================
-- Global bazar catalogue (codes match the dev seed's)
-- ============================================================================

INSERT INTO public.bazar_commodities (code, name_bn, name_en, group_code, default_unit_code, sort_order)
VALUES
  ('rice-coarse', 'মোটা চাল', 'Coarse rice', 'rice_grains', 'kg', 10),
  ('rice-medium', 'মাঝারি চাল (পাইজাম/লতা)', 'Medium rice (Paijam/Lota)', 'rice_grains', 'kg', 20),
  ('rice-fine', 'সরু চাল (মিনিকেট/নাজিরশাইল)', 'Fine rice (Miniket/Nazirshail)', 'rice_grains', 'kg', 30),
  ('atta-loose', 'আটা (খোলা)', 'Flour (loose)', 'rice_grains', 'kg', 40),
  ('lentil-coarse', 'মসুর ডাল (মোটা)', 'Red lentil (coarse)', 'pulses', 'kg', 50),
  ('lentil-fine', 'মসুর ডাল (সরু)', 'Red lentil (fine)', 'pulses', 'kg', 60),
  ('soybean-oil-loose', 'সয়াবিন তেল (খোলা)', 'Soybean oil (loose)', 'oil', 'litre', 70),
  ('soybean-oil-bottle', 'সয়াবিন তেল (বোতল)', 'Soybean oil (bottled)', 'oil', 'litre', 80),
  ('mustard-oil', 'সরিষার তেল', 'Mustard oil', 'oil', 'litre', 90),
  ('onion', 'পেঁয়াজ', 'Onion', 'vegetables', 'kg', 100),
  ('potato', 'আলু', 'Potato', 'vegetables', 'kg', 110),
  ('garlic', 'রসুন', 'Garlic', 'spices', 'kg', 120),
  ('ginger', 'আদা', 'Ginger', 'spices', 'kg', 130),
  ('green-chilli', 'কাঁচা মরিচ', 'Green chilli', 'vegetables', 'kg', 140),
  ('brinjal', 'বেগুন', 'Brinjal', 'vegetables', 'kg', 150),
  ('tomato', 'টমেটো', 'Tomato', 'vegetables', 'kg', 160),
  ('egg-farm', 'ফার্মের ডিম', 'Farm egg', 'meat_eggs', 'dozen', 170),
  ('broiler-chicken', 'ব্রয়লার মুরগি', 'Broiler chicken', 'meat_eggs', 'kg', 180),
  ('beef', 'গরুর মাংস', 'Beef', 'meat_eggs', 'kg', 190),
  ('rui-fish', 'রুই মাছ', 'Rui fish', 'fish', 'kg', 200),
  ('pangas-fish', 'পাঙ্গাস মাছ', 'Pangas fish', 'fish', 'kg', 210),
  ('hilsa-fish', 'ইলিশ মাছ', 'Hilsa fish', 'fish', 'kg', 220),
  ('sugar', 'চিনি', 'Sugar', 'spices', 'kg', 230)
ON CONFLICT (code) DO NOTHING;
--> statement-breakpoint

-- ============================================================================
-- tenant_bazar_items: TENANT-SCOPED — the area's price board
-- ============================================================================

CREATE TABLE public.tenant_bazar_items (
  id            uuid        NOT NULL DEFAULT public.uuid_generate_v7(),
  tenant_id     uuid        NOT NULL DEFAULT public.current_tenant_id(),
  commodity_id  uuid        NOT NULL,
  unit_code     text        NOT NULL,
  sort_order    integer     NOT NULL DEFAULT 0,
  is_active     boolean     NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tenant_bazar_items_pk PRIMARY KEY (id),
  CONSTRAINT tenant_bazar_items_tenant_id_fk FOREIGN KEY (tenant_id)
    REFERENCES public.tenants (id) ON DELETE RESTRICT,
  CONSTRAINT tenant_bazar_items_commodity_id_fk FOREIGN KEY (commodity_id)
    REFERENCES public.bazar_commodities (id) ON DELETE RESTRICT,
  CONSTRAINT tenant_bazar_items_unit_code_fk FOREIGN KEY (unit_code)
    REFERENCES public.measurement_units (code) ON DELETE RESTRICT,
  CONSTRAINT tenant_bazar_items_tenant_commodity_unit_uq UNIQUE (tenant_id, commodity_id, unit_code),
  CONSTRAINT tenant_bazar_items_tenant_id_id_uq UNIQUE (tenant_id, id)
);
--> statement-breakpoint
CREATE INDEX tenant_bazar_items_board_idx ON public.tenant_bazar_items (tenant_id, sort_order) WHERE is_active;
--> statement-breakpoint
CREATE TRIGGER tenant_bazar_items_set_updated_at BEFORE UPDATE ON public.tenant_bazar_items
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint

-- ============================================================================
-- bazar_board_sponsors: TENANT-SCOPED — display only (selling it is week 16)
-- ============================================================================

CREATE TABLE public.bazar_board_sponsors (
  id            uuid        NOT NULL DEFAULT public.uuid_generate_v7(),
  tenant_id     uuid        NOT NULL DEFAULT public.current_tenant_id(),
  name_bn       text        NOT NULL,
  name_en       text,
  tagline_bn    text,
  link_url      text,
  starts_on     date        NOT NULL,
  ends_on       date,
  is_active     boolean     NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT bazar_board_sponsors_pk PRIMARY KEY (id),
  CONSTRAINT bazar_board_sponsors_tenant_id_fk FOREIGN KEY (tenant_id)
    REFERENCES public.tenants (id) ON DELETE RESTRICT,
  CONSTRAINT bazar_board_sponsors_dates_ck CHECK (ends_on IS NULL OR ends_on >= starts_on),
  CONSTRAINT bazar_board_sponsors_link_ck CHECK (link_url IS NULL OR link_url ~ '^https://'),
  CONSTRAINT bazar_board_sponsors_name_ck CHECK (btrim(name_bn) <> '')
);
--> statement-breakpoint
CREATE INDEX bazar_board_sponsors_current_idx ON public.bazar_board_sponsors (tenant_id, starts_on DESC) WHERE is_active;
--> statement-breakpoint
CREATE TRIGGER bazar_board_sponsors_set_updated_at BEFORE UPDATE ON public.bazar_board_sponsors
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint

-- ============================================================================
-- blood_donors: contact window, alerts switch, snapped location
-- ============================================================================

ALTER TABLE public.blood_donors
  ADD COLUMN contact_window_code text NOT NULL DEFAULT 'any',
  ADD COLUMN alerts_enabled boolean NOT NULL DEFAULT true,
  ADD CONSTRAINT blood_donors_contact_window_code_fk FOREIGN KEY (contact_window_code)
    REFERENCES public.donor_contact_windows (code) ON DELETE RESTRICT;
--> statement-breakpoint

-- A donor's point is only ever approximate: snapped to a grid of
-- blood_donor_location_grid_m (setting) before it is stored.
CREATE OR REPLACE FUNCTION public.blood_donors_snap_location()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  grid_m double precision;
BEGIN
  IF NEW.approx_location IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT (value #>> '{}')::double precision INTO grid_m
  FROM public.platform_settings WHERE key = 'blood_donor_location_grid_m';
  IF coalesce(grid_m, 0) > 0 THEN
    -- Metres to degrees at the equator: coarse on purpose (it only blurs).
    NEW.approx_location := st_snaptogrid(NEW.approx_location::geometry, grid_m / 111320.0)::geography;
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER blood_donors_b_snap_location
  BEFORE INSERT OR UPDATE OF approx_location ON public.blood_donors
  FOR EACH ROW EXECUTE FUNCTION public.blood_donors_snap_location();
--> statement-breakpoint

-- ============================================================================
-- blood_requests: where (the hospital), when the donors were alerted
-- ============================================================================

ALTER TABLE public.blood_requests
  ADD COLUMN location geography(Point,4326),
  ADD COLUMN alerted_at timestamptz;
--> statement-breakpoint
CREATE INDEX blood_requests_location_gix ON public.blood_requests USING gist (location)
  WHERE status_code = 'open' AND deleted_at IS NULL;
--> statement-breakpoint
-- The alert job's worklist: open requests not yet matched.
CREATE INDEX blood_requests_unalerted_idx ON public.blood_requests (id)
  WHERE status_code = 'open' AND alerted_at IS NULL;
--> statement-breakpoint

-- ============================================================================
-- blood_donor_contacts: TENANT-SCOPED (the donor's area)
-- ============================================================================

CREATE TABLE public.blood_donor_contacts (
  id                    uuid        NOT NULL DEFAULT public.uuid_generate_v7(),
  tenant_id             uuid        NOT NULL DEFAULT public.current_tenant_id(),
  blood_donor_id        uuid        NOT NULL,
  requester_user_id     uuid,
  -- The requester's own open request, when they named one (any area).
  blood_request_id      uuid,
  channel_code          text        NOT NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT blood_donor_contacts_pk PRIMARY KEY (id),
  CONSTRAINT blood_donor_contacts_tenant_id_blood_donor_id_fk FOREIGN KEY (tenant_id, blood_donor_id)
    REFERENCES public.blood_donors (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT blood_donor_contacts_requester_user_id_fk FOREIGN KEY (requester_user_id)
    REFERENCES public.users (id) ON DELETE SET NULL,
  CONSTRAINT blood_donor_contacts_blood_request_id_fk FOREIGN KEY (blood_request_id)
    REFERENCES public.blood_requests (id) ON DELETE SET NULL,
  CONSTRAINT blood_donor_contacts_channel_code_fk FOREIGN KEY (channel_code)
    REFERENCES public.lead_channels (code) ON DELETE RESTRICT
);
--> statement-breakpoint
-- "Who contacted me" and the daily cap.
CREATE INDEX blood_donor_contacts_donor_idx ON public.blood_donor_contacts (tenant_id, blood_donor_id, created_at DESC);
--> statement-breakpoint
CREATE TRIGGER blood_donor_contacts_set_updated_at BEFORE UPDATE ON public.blood_donor_contacts
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint

-- ============================================================================
-- blood_request_alerts: TENANT-SCOPED (the donor's area)
-- ============================================================================

CREATE TABLE public.blood_request_alerts (
  id                 uuid        NOT NULL DEFAULT public.uuid_generate_v7(),
  tenant_id          uuid        NOT NULL DEFAULT public.current_tenant_id(),
  blood_donor_id     uuid        NOT NULL,
  blood_request_id   uuid        NOT NULL,
  distance_m         integer     NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT blood_request_alerts_pk PRIMARY KEY (id),
  CONSTRAINT blood_request_alerts_tenant_id_blood_donor_id_fk FOREIGN KEY (tenant_id, blood_donor_id)
    REFERENCES public.blood_donors (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT blood_request_alerts_blood_request_id_fk FOREIGN KEY (blood_request_id)
    REFERENCES public.blood_requests (id) ON DELETE CASCADE,
  CONSTRAINT blood_request_alerts_request_donor_uq UNIQUE (blood_request_id, blood_donor_id),
  CONSTRAINT blood_request_alerts_distance_ck CHECK (distance_m >= 0)
);
--> statement-breakpoint
-- The per-donor daily alert cap.
CREATE INDEX blood_request_alerts_donor_idx ON public.blood_request_alerts (tenant_id, blood_donor_id, created_at DESC);
--> statement-breakpoint
CREATE TRIGGER blood_request_alerts_set_updated_at BEFORE UPDATE ON public.blood_request_alerts
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint

-- ============================================================================
-- moderation_actions: a removed blood request is a takedown (rule 13)
-- ============================================================================

ALTER TABLE public.moderation_actions
  ADD COLUMN blood_request_id uuid,
  ADD CONSTRAINT moderation_actions_tenant_id_blood_request_id_fk FOREIGN KEY (tenant_id, blood_request_id)
    REFERENCES public.blood_requests (tenant_id, id) ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE public.moderation_actions DROP CONSTRAINT moderation_actions_one_target_ck;
--> statement-breakpoint
ALTER TABLE public.moderation_actions
  ADD CONSTRAINT moderation_actions_one_target_ck
    CHECK (num_nonnulls(post_id, place_id, place_claim_id, store_id, conversation_id, review_id, verification_id,
                        ban_id, blacklist_entry_id, blood_request_id) = 1);
--> statement-breakpoint
CREATE INDEX moderation_actions_tenant_blood_request_idx
  ON public.moderation_actions (tenant_id, blood_request_id, id DESC)
  WHERE blood_request_id IS NOT NULL;
--> statement-breakpoint

-- ============================================================================
-- Settings (registry: apps/api/src/settings/settings.registry.ts)
-- ============================================================================

INSERT INTO public.platform_settings
  (key, value, value_type_code, unit, min_value, max_value, tenant_override_scope_code, description)
VALUES
  ('emergency_contacts_radius_km', '15', 'decimal', 'km', 1, 100, 'tenant_admin',
   'Local emergency contacts within this distance of the viewer are listed (any area''s).'),
  ('emergency_contacts_max', '200', 'integer', 'count', 10, 1000, 'none',
   'Most local emergency contacts one emergency page lists.'),
  ('emergency_refresh_hours', '12', 'integer', 'hours', 1, 168, 'none',
   'The apps refresh their offline copy of the emergency page in the background this often.'),
  ('blood_search_radius_km', '10', 'decimal', 'km', 1, 100, 'tenant_admin',
   'Default distance of a blood donor search.'),
  ('blood_search_max_radius_km', '50', 'decimal', 'km', 1, 200, 'none',
   'Largest distance a blood donor or request search may ask for.'),
  ('blood_page_size_max', '30', 'integer', 'count', 5, 100, 'none',
   'Largest page of a donor or blood request list.'),
  ('blood_donor_daily_contact_cap', '3', 'integer', 'count', 1, 50, 'tenant_admin',
   'A donor is contacted at most this many times in 24 hours; then they are not contactable until the oldest contact is a day old.'),
  ('blood_donor_location_grid_m', '500', 'integer', 'metres', 0, 5000, 'none',
   'A donor''s location is snapped to a grid this coarse before it is stored (0 = exact; never shown either way).'),
  ('blood_donor_alerts_per_day', '2', 'integer', 'count', 0, 20, 'platform',
   'Most urgent-request pushes one donor gets in 24 hours.'),
  ('blood_request_alert_radius_km', '15', 'decimal', 'km', 1, 100, 'tenant_admin',
   'Available matching donors within this distance of the hospital get a push for an urgent request.'),
  ('blood_request_alert_max_donors', '30', 'integer', 'count', 1, 500, 'platform',
   'Most donors one urgent request pushes to (nearest first).'),
  ('blood_request_grace_hours', '6', 'integer', 'hours', 0, 168, 'none',
   'An open blood request closes on its own this long after its needed-by time.'),
  ('blood_request_max_ahead_hours', '168', 'integer', 'hours', 1, 720, 'none',
   'A blood request''s needed-by time may be at most this far ahead.'),
  ('blood_request_max_open_per_user', '2', 'integer', 'count', 1, 20, 'none',
   'Most open blood requests one person may have at once (across areas).'),
  ('blood_job_batch_size', '500', 'integer', 'count', 10, 10000, 'none',
   'Most blood requests the expiry and alert jobs handle per run.'),
  ('bazar_trend_days', '7', 'integer', 'days', 2, 31, 'none',
   'Days of price history on the bazar board''s trend.'),
  ('bazar_entry_backdate_days', '1', 'integer', 'days', 0, 7, 'tenant_admin',
   'How many days back a bazar price may still be entered or corrected (0 = today only).'),
  ('feed_blood_card_position', '6', 'integer', 'count', 0, 100, 'tenant_admin',
   'Slot on the first feed page for the urgent blood requests card (shown only when there are any nearby); 0 = off.');
--> statement-breakpoint

-- ============================================================================
-- Notifications and scheduled jobs
-- ============================================================================

INSERT INTO public.notification_types (code, label_key, sort_order) VALUES
  ('blood_donor_contacted', 'enum.notification_types.blood_donor_contacted', 420);
--> statement-breakpoint
-- The donor chose this (alerts_enabled, contact window, daily cap): a matched
-- urgent request is not held by quiet hours.
UPDATE public.notification_types SET default_channels = '{in_app,push}', is_urgent = true
WHERE code = 'blood_request_nearby';
--> statement-breakpoint
UPDATE public.notification_types SET default_channels = '{in_app,push}'
WHERE code = 'blood_donor_contacted';
--> statement-breakpoint
INSERT INTO public.notification_templates
  (type_code, channel_code, locale, variant, title_template, body_template, variables)
VALUES
  ('blood_request_nearby', 'in_app', 'bn', 'single', 'জরুরি রক্ত প্রয়োজন: {{group}}',
   '{{hospital}}-এ {{units|number}} ব্যাগ {{group}} রক্ত লাগবে{{#distanceKm}}, আপনার থেকে প্রায় {{distanceKm|number}} কিমি দূরে{{/distanceKm}}। দিতে পারলে খুলে যোগাযোগ করুন।',
   '{group,hospital,units,distanceKm}'),
  ('blood_request_nearby', 'in_app', 'en', 'single', 'Urgent: {{group}} blood needed',
   '{{units|number}} bag(s) of {{group}} needed at {{hospital}}{{#distanceKm}}, about {{distanceKm|number}} km from you{{/distanceKm}}. Open to help.',
   '{group,hospital,units,distanceKm}'),
  ('blood_donor_contacted', 'in_app', 'bn', 'single', 'রক্তের জন্য যোগাযোগ',
   '{{#requesterName}}{{requesterName}} {{/requesterName}}{{^requesterName}}একজন {{/requesterName}}রক্তদাতা হিসেবে আপনার সাথে যোগাযোগ করতে চেয়েছেন{{#hospital}} ({{hospital}}){{/hospital}}। কে যোগাযোগ করেছেন দেখতে খুলুন।',
   '{requesterName,hospital}'),
  ('blood_donor_contacted', 'in_app', 'en', 'single', 'Someone needs your blood',
   '{{#requesterName}}{{requesterName}}{{/requesterName}}{{^requesterName}}Someone{{/requesterName}} asked to contact you as a donor{{#hospital}} ({{hospital}}){{/hospital}}. Open to see who.',
   '{requesterName,hospital}');
--> statement-breakpoint

INSERT INTO public.scheduled_jobs (code, label_key, sort_order) VALUES
  ('expire-blood-requests', 'enum.scheduled_jobs.expire-blood-requests', 220),
  ('alert-blood-donors', 'enum.scheduled_jobs.alert-blood-donors', 230);
--> statement-breakpoint

-- ============================================================================
-- Functions
-- ============================================================================

-- Today in an area's own zone (tenants.timezone), never an assumed one.
CREATE OR REPLACE FUNCTION public.tenant_local_today(p_tenant_id uuid)
RETURNS date
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT (now() AT TIME ZONE t.timezone)::date FROM public.tenants t WHERE t.id = p_tenant_id
$$;
--> statement-breakpoint

-- True when local time p_at (the donor area's zone) is inside the window.
CREATE OR REPLACE FUNCTION public.donor_window_open(p_window_code text, p_local time)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public
AS $$
  SELECT CASE
    WHEN w.starts_at IS NULL THEN true
    WHEN w.starts_at <= w.ends_at THEN p_local >= w.starts_at AND p_local < w.ends_at
    ELSE p_local >= w.starts_at OR p_local < w.ends_at
  END
  FROM public.donor_contact_windows w WHERE w.code = p_window_code
$$;
--> statement-breakpoint

-- A donor is listable (and contactable) when available, not deleted, past
-- their donation gap (eligible_from, blood_donation_interval_days) and their
-- account and membership are in good standing. THE rule — the search, the
-- contact path and the alert matcher all use it.
CREATE OR REPLACE FUNCTION public.blood_donor_listable(p_donor_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.blood_donors d
    JOIN public.tenant_members tm ON tm.tenant_id = d.tenant_id AND tm.id = d.member_id
    JOIN public.users u ON u.id = tm.user_id
    WHERE d.id = p_donor_id
      AND d.is_available AND d.deleted_at IS NULL
      AND (d.eligible_from IS NULL OR d.eligible_from <= public.tenant_local_today(d.tenant_id))
      AND tm.deleted_at IS NULL AND tm.ban_severity_code IS NULL
      AND u.deleted_at IS NULL AND u.status_code = 'active'
  )
$$;
--> statement-breakpoint

-- The area's price board: its own items, else every active commodity in its
-- default unit. THE catalogue rule (board, entry, feed card).
CREATE OR REPLACE FUNCTION public.bazar_catalogue(p_tenant_id uuid)
RETURNS TABLE (commodity_id uuid, code text, name_bn text, name_en text, group_code text, unit_code text,
               sort_order integer)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT c.id, c.code, c.name_bn, c.name_en, c.group_code, i.unit_code, i.sort_order
  FROM public.tenant_bazar_items i
  JOIN public.bazar_commodities c ON c.id = i.commodity_id AND c.is_active
  WHERE i.tenant_id = p_tenant_id AND i.is_active
  UNION ALL
  SELECT c.id, c.code, c.name_bn, c.name_en, c.group_code, c.default_unit_code, c.sort_order
  FROM public.bazar_commodities c
  WHERE c.is_active
    AND NOT EXISTS (SELECT 1 FROM public.tenant_bazar_items i WHERE i.tenant_id = p_tenant_id AND i.is_active)
$$;
--> statement-breakpoint

-- The fast entry (ADR 064): today's — or up to bazar_entry_backdate_days
-- earlier — price per item, published at once as the area's consolidated
-- figure (no market, no quality note). Staff or field agents of the area.
-- A second entry for the same item, unit and day corrects the first.
-- p_items: [{"commodity_id": uuid, "unit_code": text, "min_price": "45.00", "max_price": "50.00"}]
CREATE OR REPLACE FUNCTION public.bazar_enter_prices(p_date date, p_items jsonb)
RETURNS integer
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_tenant uuid := public.current_tenant_id();
  v_staff boolean := public.app_is_staff();
  v_today date;
  v_backdate integer;
  v_item jsonb;
  v_commodity uuid;
  v_unit text;
  v_min numeric(12,2);
  v_max numeric(12,2);
  v_count integer := 0;
BEGIN
  IF v_tenant IS NULL OR NOT public.app_is_active_user()
     OR NOT (v_staff OR public.app_role() = 'agent') THEN
    RAISE EXCEPTION 'bazar_enter_prices: staff or agents only' USING ERRCODE = 'AE903', DETAIL = 'role';
  END IF;
  v_today := public.tenant_local_today(v_tenant);
  v_backdate := (public.setting_value_for('bazar_entry_backdate_days', v_tenant) #>> '{}')::integer;
  IF p_date IS NULL OR p_date > v_today OR p_date < v_today - coalesce(v_backdate, 0) THEN
    RAISE EXCEPTION 'bazar_enter_prices: date' USING ERRCODE = 'AE903', DETAIL = 'date';
  END IF;
  IF jsonb_typeof(p_items) <> 'array' OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'bazar_enter_prices: items' USING ERRCODE = 'AE903', DETAIL = 'item';
  END IF;

  -- One writer per area and day: two agents saving at once don't race.
  PERFORM pg_advisory_xact_lock(hashtextextended('bazar_enter_prices:' || v_tenant::text || ':' || p_date::text, 0));

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    v_commodity := (v_item ->> 'commodity_id')::uuid;
    v_unit := v_item ->> 'unit_code';
    v_min := (v_item ->> 'min_price')::numeric(12,2);
    v_max := (v_item ->> 'max_price')::numeric(12,2);
    IF NOT EXISTS (SELECT 1 FROM public.bazar_catalogue(v_tenant) c
                   WHERE c.commodity_id = v_commodity AND c.unit_code = v_unit) THEN
      RAISE EXCEPTION 'bazar_enter_prices: item not on the board' USING ERRCODE = 'AE903', DETAIL = 'item';
    END IF;
    IF v_min IS NULL OR v_max IS NULL OR v_min <= 0 OR v_max < v_min THEN
      RAISE EXCEPTION 'bazar_enter_prices: price' USING ERRCODE = 'AE903', DETAIL = 'price';
    END IF;

    UPDATE public.bazar_prices bp
    SET min_price = v_min, max_price = v_max,
        source_code = CASE WHEN v_staff THEN 'staff' ELSE 'agent' END,
        reported_by_member_id = public.current_member_id(),
        published_by_user_id = public.current_user_id()
    WHERE bp.tenant_id = v_tenant AND bp.commodity_id = v_commodity AND bp.unit_code = v_unit
      AND bp.price_date = p_date AND bp.bazar_market_id IS NULL AND bp.quality_note IS NULL
      AND bp.status_code = 'published';
    IF NOT FOUND THEN
      INSERT INTO public.bazar_prices
        (tenant_id, commodity_id, bazar_market_id, price_date, unit_code, min_price, max_price, source_code,
         reported_by_member_id, status_code, published_by_user_id)
      VALUES
        (v_tenant, v_commodity, NULL, p_date, v_unit, v_min, v_max, CASE WHEN v_staff THEN 'staff' ELSE 'agent' END,
         public.current_member_id(), 'published', public.current_user_id());
    END IF;
    v_count := v_count + 1;
  END LOOP;
  RETURN v_count;
END
$$;
--> statement-breakpoint

-- Local emergency contacts near the viewer, from every area (rule 10), plus
-- the given area's own contacts that have no point. Public institutional
-- numbers: no caller check.
CREATE OR REPLACE FUNCTION public.emergency_contacts_near(p_origin geography, p_radius_km double precision,
                                                         p_tenant_id uuid, p_limit integer)
RETURNS TABLE (id uuid, tenant_id uuid, service_type_code text, name_bn text, name_en text, phones text[],
               address_text text, lat double precision, lng double precision, is_24h boolean,
               availability_note text, last_verified_at timestamptz, distance_m double precision,
               sort_order integer)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT e.id, e.tenant_id, e.service_type_code, e.name_bn, e.name_en, e.phones, e.address_text,
         st_y(e.location::geometry), st_x(e.location::geometry), e.is_24h, e.availability_note,
         e.last_verified_at,
         CASE WHEN e.location IS NOT NULL AND p_origin IS NOT NULL THEN st_distance(e.location, p_origin, false) END,
         e.sort_order
  FROM public.emergency_contacts e
  WHERE e.is_active AND e.deleted_at IS NULL
    AND (
      (p_origin IS NOT NULL AND e.location IS NOT NULL
       AND st_dwithin(e.location, p_origin, p_radius_km * 1000, false))
      OR (e.tenant_id = p_tenant_id AND e.location IS NULL)
    )
  ORDER BY 13 NULLS LAST, e.sort_order, e.id
  LIMIT p_limit
$$;
--> statement-breakpoint

-- Available, eligible donors near a point, from every area (rule 10). Signed-
-- in, active users only (health-adjacent data, schema.md §10.4); never the
-- caller themself; never a phone number. The distance is rounded to the
-- location grid so it can't be used to triangulate a home.
CREATE OR REPLACE FUNCTION public.blood_donors_near(
  p_origin geography, p_radius_km double precision, p_groups text[],
  p_after_distance double precision, p_after_id uuid, p_limit integer
)
RETURNS TABLE (id uuid, tenant_id uuid, distance_m double precision, blood_group_code text,
               display_name text, area_bn text, area_en text, contact_window_code text,
               contact_preference_code text, last_donated_on date)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
SET plan_cache_mode = force_custom_plan
AS $$
DECLARE
  v_max_radius double precision := (public.setting_value_for('blood_search_max_radius_km', NULL) #>> '{}')::double precision;
  v_page integer := (public.setting_value_for('blood_page_size_max', NULL) #>> '{}')::integer;
  v_grid double precision := greatest((public.setting_value_for('blood_donor_location_grid_m', NULL) #>> '{}')::double precision, 1);
BEGIN
  IF NOT public.app_is_active_user() THEN
    RAISE EXCEPTION 'blood_donors_near: sign in' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_origin IS NULL OR p_radius_km IS NULL OR p_radius_km <= 0 OR p_limit IS NULL OR p_limit <= 0 THEN
    RAISE EXCEPTION 'blood_donors_near needs an origin, a positive radius and a positive limit'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  RETURN QUERY
    SELECT x.id, x.tenant_id, x.distance_m, x.blood_group_code, x.display_name, x.area_bn, x.area_en,
           x.contact_window_code, x.contact_preference_code, x.last_donated_on
    FROM (
      SELECT d.id, d.tenant_id,
             round(st_distance(d.approx_location, p_origin, false) / v_grid) * v_grid AS distance_m,
             d.blood_group_code, up.display_name, l.name_bn AS area_bn, l.name_en AS area_en,
             d.contact_window_code, d.contact_preference_code, d.last_donated_on
      FROM public.blood_donors d
      JOIN public.tenant_members tm ON tm.tenant_id = d.tenant_id AND tm.id = d.member_id
      LEFT JOIN public.user_profiles up ON up.user_id = tm.user_id
      LEFT JOIN public.localities l ON l.tenant_id = d.tenant_id AND l.id = d.locality_id
      WHERE d.is_available AND d.deleted_at IS NULL AND d.approx_location IS NOT NULL
        AND (p_groups IS NULL OR d.blood_group_code = ANY (p_groups))
        AND st_dwithin(d.approx_location, p_origin, least(p_radius_km, v_max_radius) * 1000, false)
        AND tm.user_id <> public.current_user_id()
        AND public.blood_donor_listable(d.id)
    ) x
    WHERE p_after_distance IS NULL OR (x.distance_m, x.id) > (p_after_distance, p_after_id)
    ORDER BY x.distance_m, x.id
    LIMIT least(p_limit, v_page);
END
$$;
--> statement-breakpoint

-- What the contact path needs about a donor, without writing anything:
-- whose number, and the number itself only when the donor shares it.
CREATE OR REPLACE FUNCTION public.blood_donor_contact_target(p_donor_id uuid)
RETURNS TABLE (tenant_id uuid, member_id uuid, user_id uuid, contact_preference_code text, phone_e164 text,
               display_name text, blood_group_code text)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NOT public.app_is_active_user() THEN
    RAISE EXCEPTION 'blood_donor_contact_target: sign in' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN QUERY
    SELECT d.tenant_id, d.member_id, tm.user_id, d.contact_preference_code,
           CASE WHEN d.contact_preference_code = 'reveal_on_request' THEN u.phone_e164 END,
           up.display_name, d.blood_group_code
    FROM public.blood_donors d
    JOIN public.tenant_members tm ON tm.tenant_id = d.tenant_id AND tm.id = d.member_id
    JOIN public.users u ON u.id = tm.user_id
    LEFT JOIN public.user_profiles up ON up.user_id = tm.user_id
    WHERE d.id = p_donor_id AND public.blood_donor_listable(d.id);
END
$$;
--> statement-breakpoint

-- Records one contact of a donor: a blood_donor_contacts row (what the donor
-- sees) and the lead_events row (rule: every number leaving the API is a
-- lead). Refuses past blood_donor_daily_contact_cap in 24 hours (the donor's
-- area setting), under a row lock so two requesters can't both pass the cap.
CREATE OR REPLACE FUNCTION public.blood_donor_record_contact(p_donor_id uuid, p_channel text,
                                                            p_request_id uuid, p_viewer_key text)
RETURNS uuid
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_donor public.blood_donors%ROWTYPE;
  v_user uuid := public.current_user_id();
  v_donor_user uuid;
  v_cap integer;
  v_used integer;
  v_id uuid;
BEGIN
  IF NOT public.app_is_active_user() THEN
    RAISE EXCEPTION 'blood_donor_record_contact: sign in' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT * INTO v_donor FROM public.blood_donors d WHERE d.id = p_donor_id FOR UPDATE;
  IF NOT FOUND OR NOT public.blood_donor_listable(p_donor_id) THEN
    RAISE EXCEPTION 'blood_donor_record_contact: unavailable' USING ERRCODE = 'AE901', DETAIL = 'unavailable';
  END IF;
  SELECT tm.user_id INTO v_donor_user FROM public.tenant_members tm
  WHERE tm.tenant_id = v_donor.tenant_id AND tm.id = v_donor.member_id;
  IF v_donor_user = v_user THEN
    RAISE EXCEPTION 'blood_donor_record_contact: self' USING ERRCODE = 'AE901', DETAIL = 'self';
  END IF;
  IF p_request_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.blood_requests r
    JOIN public.tenant_members rm ON rm.tenant_id = r.tenant_id AND rm.id = r.requester_member_id
    WHERE r.id = p_request_id AND r.status_code = 'open' AND r.deleted_at IS NULL AND rm.user_id = v_user
  ) THEN
    RAISE EXCEPTION 'blood_donor_record_contact: request' USING ERRCODE = 'AE901', DETAIL = 'request';
  END IF;
  v_cap := (public.setting_value_for('blood_donor_daily_contact_cap', v_donor.tenant_id) #>> '{}')::integer;
  SELECT count(*) INTO v_used FROM public.blood_donor_contacts c
  WHERE c.tenant_id = v_donor.tenant_id AND c.blood_donor_id = p_donor_id
    AND c.created_at > now() - interval '1 day';
  IF v_used >= v_cap THEN
    RAISE EXCEPTION 'blood_donor_record_contact: cap' USING ERRCODE = 'AE901', DETAIL = 'cap';
  END IF;

  INSERT INTO public.blood_donor_contacts (tenant_id, blood_donor_id, requester_user_id, blood_request_id, channel_code)
  VALUES (v_donor.tenant_id, p_donor_id, v_user, p_request_id, p_channel)
  RETURNING blood_donor_contacts.id INTO v_id;
  INSERT INTO public.lead_events
    (tenant_id, channel_code, source_code, target_member_id, actor_member_id, actor_user_id, anon_session_hash)
  VALUES
    (v_donor.tenant_id, p_channel, 'blood_donor_list', v_donor.member_id,
     (SELECT tm.id FROM public.tenant_members tm
      WHERE tm.tenant_id = v_donor.tenant_id AND tm.user_id = v_user AND tm.deleted_at IS NULL),
     v_user, p_viewer_key);
  RETURN v_id;
END
$$;
--> statement-breakpoint

-- The area a blood request lives in (its routes run there). Ids only.
CREATE OR REPLACE FUNCTION public.blood_request_tenant_of(p_request_id uuid)
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT r.tenant_id FROM public.blood_requests r WHERE r.id = p_request_id AND r.deleted_at IS NULL
$$;
--> statement-breakpoint

-- Open blood requests near a point, from every area. Signed-in users only;
-- no phone, no patient note (the detail and the contact endpoint have those).
CREATE OR REPLACE FUNCTION public.blood_requests_near(p_origin geography, p_radius_km double precision,
                                                     p_groups text[], p_limit integer)
RETURNS TABLE (id uuid, tenant_id uuid, distance_m double precision, blood_group_code text, units_needed smallint,
               hospital_name text, needed_by timestamptz, urgency_code text, created_at timestamptz,
               is_mine boolean)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_max_radius double precision := (public.setting_value_for('blood_search_max_radius_km', NULL) #>> '{}')::double precision;
  v_page integer := (public.setting_value_for('blood_page_size_max', NULL) #>> '{}')::integer;
BEGIN
  IF NOT public.app_is_active_user() THEN
    RAISE EXCEPTION 'blood_requests_near: sign in' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_origin IS NULL OR p_radius_km IS NULL OR p_radius_km <= 0 OR p_limit IS NULL OR p_limit <= 0 THEN
    RAISE EXCEPTION 'blood_requests_near needs an origin, a positive radius and a positive limit'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  RETURN QUERY
    SELECT r.id, r.tenant_id, st_distance(r.location, p_origin, false), r.blood_group_code, r.units_needed,
           r.hospital_name, r.needed_by, r.urgency_code, r.created_at,
           rm.user_id = public.current_user_id()
    FROM public.blood_requests r
    JOIN public.tenant_members rm ON rm.tenant_id = r.tenant_id AND rm.id = r.requester_member_id
    WHERE r.status_code = 'open' AND r.deleted_at IS NULL AND r.location IS NOT NULL
      AND (p_groups IS NULL OR r.blood_group_code = ANY (p_groups))
      AND st_dwithin(r.location, p_origin, least(p_radius_km, v_max_radius) * 1000, false)
    ORDER BY CASE r.urgency_code WHEN 'critical' THEN 0 WHEN 'urgent' THEN 1 ELSE 2 END, r.needed_by, r.id
    LIMIT least(p_limit, v_page);
END
$$;
--> statement-breakpoint

-- The feed card's summary: how many open requests nearby and of which groups.
-- Counts only — nothing personal — so anyone may read it.
CREATE OR REPLACE FUNCTION public.blood_requests_summary_near(p_origin geography, p_radius_km double precision)
RETURNS TABLE (open_count integer, groups text[], most_urgent text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT count(*)::integer,
         coalesce(array_agg(DISTINCT r.blood_group_code), '{}'),
         (array_agg(r.urgency_code ORDER BY CASE r.urgency_code WHEN 'critical' THEN 0 WHEN 'urgent' THEN 1 ELSE 2 END))[1]
  FROM public.blood_requests r
  WHERE r.status_code = 'open' AND r.deleted_at IS NULL AND r.location IS NOT NULL AND r.needed_by > now()
    AND st_dwithin(r.location, p_origin, p_radius_km * 1000, false)
$$;
--> statement-breakpoint

-- Matches an urgent request to donors and records one alert each (the system
-- only). Donors: compatible group, listable, alerts on, within
-- blood_request_alert_radius_km of the hospital, inside their contact window
-- now (their area's local time), under blood_donor_alerts_per_day — nearest
-- first, at most blood_request_alert_max_donors. Idempotent: a request is
-- matched once (alerted_at).
CREATE OR REPLACE FUNCTION public.blood_request_alert_donors(p_request_id uuid)
RETURNS TABLE (alert_id uuid, donor_user_id uuid, donor_tenant_id uuid, distance_m integer)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
#variable_conflict use_column
DECLARE
  v_req public.blood_requests%ROWTYPE;
  v_requester uuid;
  v_radius double precision;
  v_max integer;
BEGIN
  IF NOT public.app_is_system() THEN
    RAISE EXCEPTION 'blood_request_alert_donors: system only' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT * INTO v_req FROM public.blood_requests r WHERE r.id = p_request_id FOR UPDATE;
  IF NOT FOUND OR v_req.status_code <> 'open' OR v_req.alerted_at IS NOT NULL OR v_req.deleted_at IS NOT NULL THEN
    RETURN;
  END IF;
  UPDATE public.blood_requests r SET alerted_at = now() WHERE r.id = p_request_id;
  IF v_req.location IS NULL THEN
    RETURN;
  END IF;
  SELECT tm.user_id INTO v_requester FROM public.tenant_members tm
  WHERE tm.tenant_id = v_req.tenant_id AND tm.id = v_req.requester_member_id;
  v_radius := (public.setting_value_for('blood_request_alert_radius_km', v_req.tenant_id) #>> '{}')::double precision;
  v_max := (public.setting_value_for('blood_request_alert_max_donors', v_req.tenant_id) #>> '{}')::integer;

  RETURN QUERY
  WITH candidates AS (
    SELECT d.id, d.tenant_id, tm.user_id, st_distance(d.approx_location, v_req.location, false) AS dist
    FROM public.blood_donors d
    JOIN public.tenant_members tm ON tm.tenant_id = d.tenant_id AND tm.id = d.member_id
    JOIN public.tenants t ON t.id = d.tenant_id
    WHERE d.is_available AND d.deleted_at IS NULL AND d.alerts_enabled AND d.approx_location IS NOT NULL
      AND d.blood_group_code IN (SELECT c.donor_code FROM public.blood_group_compatibility c
                                 WHERE c.recipient_code = v_req.blood_group_code)
      AND st_dwithin(d.approx_location, v_req.location, v_radius * 1000, false)
      AND tm.user_id IS DISTINCT FROM v_requester
      AND public.donor_window_open(d.contact_window_code, (now() AT TIME ZONE t.timezone)::time)
      AND (SELECT count(*) FROM public.blood_request_alerts a
           WHERE a.tenant_id = d.tenant_id AND a.blood_donor_id = d.id AND a.created_at > now() - interval '1 day')
          < (public.setting_value_for('blood_donor_alerts_per_day', d.tenant_id) #>> '{}')::integer
      AND public.blood_donor_listable(d.id)
    ORDER BY 4, d.id
    LIMIT v_max
  ),
  inserted AS (
    INSERT INTO public.blood_request_alerts (tenant_id, blood_donor_id, blood_request_id, distance_m)
    SELECT c.tenant_id, c.id, p_request_id, round(c.dist)::integer FROM candidates c
    ON CONFLICT (blood_request_id, blood_donor_id) DO NOTHING
    RETURNING blood_request_alerts.id, blood_request_alerts.blood_donor_id, blood_request_alerts.tenant_id,
              blood_request_alerts.distance_m
  )
  SELECT i.id, c.user_id, i.tenant_id, i.distance_m
  FROM inserted i JOIN candidates c ON c.id = i.blood_donor_id;
END
$$;
--> statement-breakpoint

-- Open requests not matched yet (the alert job's worklist; the API matches
-- right after create, this catches a failed or crashed one).
CREATE OR REPLACE FUNCTION public.blood_requests_to_alert(p_limit integer)
RETURNS TABLE (id uuid)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NOT public.app_is_system() THEN
    RAISE EXCEPTION 'blood_requests_to_alert: system only' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN QUERY
    SELECT r.id FROM public.blood_requests r
    WHERE r.status_code = 'open' AND r.alerted_at IS NULL AND r.deleted_at IS NULL
    ORDER BY r.id LIMIT p_limit;
END
$$;
--> statement-breakpoint

-- Closes open requests blood_request_grace_hours past their needed-by time
-- (the system only). Returns how many.
CREATE OR REPLACE FUNCTION public.expire_blood_requests(p_limit integer)
RETURNS integer
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_count integer;
BEGIN
  IF NOT public.app_is_system() THEN
    RAISE EXCEPTION 'expire_blood_requests: system only' USING ERRCODE = 'insufficient_privilege';
  END IF;
  WITH due AS (
    SELECT r.id FROM public.blood_requests r
    WHERE r.status_code = 'open' AND r.needed_by < now()
      AND r.needed_by + make_interval(hours => (public.setting_value_for('blood_request_grace_hours', r.tenant_id) #>> '{}')::integer) < now()
    ORDER BY r.needed_by
    LIMIT p_limit
    FOR UPDATE SKIP LOCKED
  )
  UPDATE public.blood_requests r SET status_code = 'expired'
  FROM due WHERE r.id = due.id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END
$$;
--> statement-breakpoint

-- A moderator takes a blood request down (a fake request is a known scam):
-- status removed and the moderation_actions row in one transaction (rule 13).
CREATE OR REPLACE FUNCTION public.remove_blood_request(p_request_id uuid, p_reason_code text, p_reason_text text)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_tenant uuid := public.current_tenant_id();
BEGIN
  IF v_tenant IS NULL OR NOT (public.app_is_staff() OR public.is_platform_admin()) THEN
    RAISE EXCEPTION 'remove_blood_request: staff only' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_reason_code NOT IN ('fake_blood_request', 'blood_request_abuse')
     OR p_reason_text IS NULL OR btrim(p_reason_text) = '' THEN
    RAISE EXCEPTION 'remove_blood_request: reason' USING ERRCODE = 'AE902', DETAIL = 'reason';
  END IF;
  UPDATE public.blood_requests r SET status_code = 'removed'
  WHERE r.tenant_id = v_tenant AND r.id = p_request_id AND r.status_code <> 'removed';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'remove_blood_request: not found' USING ERRCODE = 'AE902', DETAIL = 'not_found';
  END IF;
  INSERT INTO public.moderation_actions (tenant_id, blood_request_id, actor_user_id, action_code, reason_code, reason_text)
  VALUES (v_tenant, p_request_id, public.current_user_id(), 'blood_request_removed', p_reason_code, p_reason_text);
END
$$;
--> statement-breakpoint

-- ============================================================================
-- RLS
-- ============================================================================

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['donor_contact_windows', 'blood_group_compatibility', 'tenant_bazar_items',
                           'bazar_board_sponsors', 'blood_donor_contacts', 'blood_request_alerts']
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);
  END LOOP;
END
$$;
--> statement-breakpoint

CREATE POLICY donor_contact_windows_read_all ON public.donor_contact_windows FOR SELECT USING (true);
--> statement-breakpoint
CREATE POLICY donor_contact_windows_platform_admin ON public.donor_contact_windows
  FOR ALL USING ((SELECT public.is_platform_admin())) WITH CHECK ((SELECT public.is_platform_admin()));
--> statement-breakpoint
CREATE POLICY blood_group_compatibility_read_all ON public.blood_group_compatibility FOR SELECT USING (true);
--> statement-breakpoint
CREATE POLICY blood_group_compatibility_platform_admin ON public.blood_group_compatibility
  FOR ALL USING ((SELECT public.is_platform_admin())) WITH CHECK ((SELECT public.is_platform_admin()));
--> statement-breakpoint

-- tenant_bazar_items: T-PUBLIC-READ (active); staff write
CREATE POLICY tenant_bazar_items_public_read ON public.tenant_bazar_items
  FOR SELECT USING (tenant_id = (SELECT public.current_tenant_id()) AND is_active);
--> statement-breakpoint
CREATE POLICY tenant_bazar_items_staff_write ON public.tenant_bazar_items
  FOR ALL
  USING (tenant_id = (SELECT public.current_tenant_id()) AND (SELECT public.app_is_staff()))
  WITH CHECK (tenant_id = (SELECT public.current_tenant_id()) AND (SELECT public.app_is_staff()));
--> statement-breakpoint
CREATE POLICY tenant_bazar_items_platform_admin ON public.tenant_bazar_items
  FOR ALL USING ((SELECT public.is_platform_admin())) WITH CHECK ((SELECT public.is_platform_admin()));
--> statement-breakpoint

-- bazar_board_sponsors: T-PUBLIC-READ (active); staff write
CREATE POLICY bazar_board_sponsors_public_read ON public.bazar_board_sponsors
  FOR SELECT USING (tenant_id = (SELECT public.current_tenant_id()) AND is_active);
--> statement-breakpoint
CREATE POLICY bazar_board_sponsors_staff_write ON public.bazar_board_sponsors
  FOR ALL
  USING (tenant_id = (SELECT public.current_tenant_id()) AND (SELECT public.app_is_staff()))
  WITH CHECK (tenant_id = (SELECT public.current_tenant_id()) AND (SELECT public.app_is_staff()));
--> statement-breakpoint
CREATE POLICY bazar_board_sponsors_platform_admin ON public.bazar_board_sponsors
  FOR ALL USING ((SELECT public.is_platform_admin())) WITH CHECK ((SELECT public.is_platform_admin()));
--> statement-breakpoint

-- blood_donor_contacts: the donor reads their own; staff read; written by function only
CREATE POLICY blood_donor_contacts_donor_read ON public.blood_donor_contacts
  FOR SELECT
  USING (
    tenant_id = (SELECT public.current_tenant_id())
    AND EXISTS (
      SELECT 1 FROM public.blood_donors bd
      WHERE bd.tenant_id = blood_donor_contacts.tenant_id AND bd.id = blood_donor_contacts.blood_donor_id
        AND bd.member_id = (SELECT public.current_member_id())
    )
  );
--> statement-breakpoint
CREATE POLICY blood_donor_contacts_staff_read ON public.blood_donor_contacts
  FOR SELECT USING (tenant_id = (SELECT public.current_tenant_id()) AND (SELECT public.app_is_staff()));
--> statement-breakpoint
CREATE POLICY blood_donor_contacts_platform_admin ON public.blood_donor_contacts
  FOR ALL USING ((SELECT public.is_platform_admin())) WITH CHECK ((SELECT public.is_platform_admin()));
--> statement-breakpoint

-- blood_request_alerts: the donor reads their own; staff read; written by function only
CREATE POLICY blood_request_alerts_donor_read ON public.blood_request_alerts
  FOR SELECT
  USING (
    tenant_id = (SELECT public.current_tenant_id())
    AND EXISTS (
      SELECT 1 FROM public.blood_donors bd
      WHERE bd.tenant_id = blood_request_alerts.tenant_id AND bd.id = blood_request_alerts.blood_donor_id
        AND bd.member_id = (SELECT public.current_member_id())
    )
  );
--> statement-breakpoint
CREATE POLICY blood_request_alerts_staff_read ON public.blood_request_alerts
  FOR SELECT USING (tenant_id = (SELECT public.current_tenant_id()) AND (SELECT public.app_is_staff()));
--> statement-breakpoint
CREATE POLICY blood_request_alerts_platform_admin ON public.blood_request_alerts
  FOR ALL USING ((SELECT public.is_platform_admin())) WITH CHECK ((SELECT public.is_platform_admin()));
--> statement-breakpoint

-- ============================================================================
-- Grants and function ownership
-- ============================================================================

GRANT SELECT ON public.donor_contact_windows, public.blood_group_compatibility TO ae_app;
--> statement-breakpoint
GRANT INSERT, UPDATE ON public.donor_contact_windows, public.blood_group_compatibility TO ae_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON public.tenant_bazar_items TO ae_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON public.bazar_board_sponsors TO ae_app;
--> statement-breakpoint
GRANT SELECT ON public.blood_donor_contacts, public.blood_request_alerts TO ae_app;
--> statement-breakpoint

-- What the SECURITY DEFINER functions read and write.
GRANT SELECT ON public.blood_donors, public.blood_requests, public.tenant_members, public.users,
  public.user_profiles, public.tenants, public.localities, public.donor_contact_windows,
  public.blood_group_compatibility, public.tenant_bazar_items, public.bazar_commodities,
  public.emergency_contacts, public.platform_settings, public.tenant_settings
TO ae_rls_bypass;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON public.bazar_prices, public.blood_donor_contacts, public.blood_request_alerts
TO ae_rls_bypass;
--> statement-breakpoint
GRANT UPDATE ON public.blood_requests, public.blood_donors TO ae_rls_bypass;
--> statement-breakpoint
GRANT SELECT, INSERT ON public.lead_events TO ae_rls_bypass;
--> statement-breakpoint
GRANT INSERT ON public.moderation_actions TO ae_rls_bypass;
--> statement-breakpoint

DO $$
DECLARE
  f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'public.tenant_local_today(uuid)', 'public.blood_donor_listable(uuid)', 'public.bazar_catalogue(uuid)',
    'public.bazar_enter_prices(date, jsonb)',
    'public.emergency_contacts_near(geography, double precision, uuid, integer)',
    'public.blood_donors_near(geography, double precision, text[], double precision, uuid, integer)',
    'public.blood_donor_contact_target(uuid)', 'public.blood_donor_record_contact(uuid, text, uuid, text)',
    'public.blood_requests_near(geography, double precision, text[], integer)', 'public.blood_request_tenant_of(uuid)',
    'public.blood_requests_summary_near(geography, double precision)',
    'public.blood_request_alert_donors(uuid)', 'public.blood_requests_to_alert(integer)',
    'public.expire_blood_requests(integer)', 'public.remove_blood_request(uuid, text, text)'
  ]
  LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO ae_rls_bypass', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
  END LOOP;
END
$$;
--> statement-breakpoint
-- Called by the app (each checks the caller itself).
GRANT EXECUTE ON FUNCTION
  public.tenant_local_today(uuid), public.bazar_catalogue(uuid), public.bazar_enter_prices(date, jsonb),
  public.emergency_contacts_near(geography, double precision, uuid, integer),
  public.blood_donors_near(geography, double precision, text[], double precision, uuid, integer),
  public.blood_donor_contact_target(uuid), public.blood_donor_record_contact(uuid, text, uuid, text),
  public.blood_requests_near(geography, double precision, text[], integer), public.blood_request_tenant_of(uuid),
  public.blood_requests_summary_near(geography, double precision),
  public.blood_request_alert_donors(uuid), public.blood_requests_to_alert(integer),
  public.expire_blood_requests(integer), public.remove_blood_request(uuid, text, text)
TO ae_app;
--> statement-breakpoint
-- Internal helpers, called from inside the functions above.
GRANT EXECUTE ON FUNCTION public.tenant_local_today(uuid), public.blood_donor_listable(uuid),
  public.bazar_catalogue(uuid), public.setting_value_for(text, uuid)
TO ae_rls_bypass;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.donor_window_open(text, time) TO ae_app, ae_rls_bypass;
