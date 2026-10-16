-- 0062_field_agent_mode
--
-- Field agent mode (ADR 066): how the first shops get onto the map. Agents
-- capture shops offline on the phone; the queue syncs later, exactly once.
-- Builds on 0012's field_agents / agent_visits.
--
--   field_agents                  + commission_rate (taka per approved shop;
--                                  NULL = agent_commission_per_shop) and
--                                  targets ({daily_shops, weekly_shops}).
--   NEW agent_task_types          lookup: map_shop | verify_shop | update_info.
--   NEW agent_task_statuses       lookup: open | done | cancelled.
--   NEW agent_tasks               TENANT-SCOPED: what an agent is asked to do,
--                                 where, by when.
--   NEW agent_submission_kinds    lookup: new_shop | verify_shop | update_info.
--   NEW agent_fraud_flags         lookup: the anti-fraud signals.
--   NEW agent_submissions         TENANT-SCOPED: one captured submission. The
--                                 primary key is the phone's own UUID — the
--                                 idempotency key of the offline sync. Linked to
--                                 what it created: a place (pending review), a
--                                 visit, an edit suggestion.
--   NEW agent_phone_checks        TENANT-SCOPED: a shop phone's OTP outcome, by
--                                 submission (possibly before it syncs).
--   agent_submission_outcomes()   THE review status of a submission (from its
--                                 place / suggestion and moderation_actions) and
--                                 its estimated commission — stats, the admin
--                                 numbers and the commission report all use it.
--   agent_photo_reuse()           other submissions in the area with the same
--                                 photo (checksum or thumbhash).
--   Settings                      agent_* (rule 9).

-- ============================================================================
-- field_agents: commission and targets
-- ============================================================================

ALTER TABLE public.field_agents
  ADD COLUMN commission_rate numeric(12,2),
  ADD COLUMN targets jsonb NOT NULL DEFAULT '{}',
  ADD CONSTRAINT field_agents_commission_rate_ck CHECK (commission_rate IS NULL OR commission_rate >= 0),
  ADD CONSTRAINT field_agents_targets_ck CHECK (
    jsonb_typeof(targets) = 'object' AND targets - ARRAY['daily_shops', 'weekly_shops'] = '{}'::jsonb
  );
--> statement-breakpoint
COMMENT ON COLUMN public.field_agents.commission_rate IS
  'Taka per approved new shop for this agent; NULL = the agent_commission_per_shop setting. Calculation only (payouts are manual).';
--> statement-breakpoint

-- ============================================================================
-- Lookups
-- ============================================================================

CREATE TABLE public.agent_task_types (
  code text NOT NULL, label_key text NOT NULL, sort_order integer NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT agent_task_types_pk PRIMARY KEY (code),
  CONSTRAINT agent_task_types_code_ck CHECK (code ~ '^[a-z][a-z0-9_]*$')
);
--> statement-breakpoint
CREATE TRIGGER agent_task_types_set_updated_at BEFORE UPDATE ON public.agent_task_types
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint
INSERT INTO public.agent_task_types (code, label_key, sort_order) VALUES
  ('map_shop', 'enum.agent_task_types.map_shop', 10),
  ('verify_shop', 'enum.agent_task_types.verify_shop', 20),
  ('update_info', 'enum.agent_task_types.update_info', 30);
--> statement-breakpoint

CREATE TABLE public.agent_task_statuses (
  code text NOT NULL, label_key text NOT NULL, sort_order integer NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT agent_task_statuses_pk PRIMARY KEY (code),
  CONSTRAINT agent_task_statuses_code_ck CHECK (code ~ '^[a-z][a-z0-9_]*$')
);
--> statement-breakpoint
CREATE TRIGGER agent_task_statuses_set_updated_at BEFORE UPDATE ON public.agent_task_statuses
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint
INSERT INTO public.agent_task_statuses (code, label_key, sort_order) VALUES
  ('open', 'enum.agent_task_statuses.open', 10),
  ('done', 'enum.agent_task_statuses.done', 20),
  ('cancelled', 'enum.agent_task_statuses.cancelled', 30);
--> statement-breakpoint

CREATE TABLE public.agent_submission_kinds (
  code text NOT NULL, label_key text NOT NULL, sort_order integer NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT agent_submission_kinds_pk PRIMARY KEY (code),
  CONSTRAINT agent_submission_kinds_code_ck CHECK (code ~ '^[a-z][a-z0-9_]*$')
);
--> statement-breakpoint
CREATE TRIGGER agent_submission_kinds_set_updated_at BEFORE UPDATE ON public.agent_submission_kinds
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint
INSERT INTO public.agent_submission_kinds (code, label_key, sort_order) VALUES
  ('new_shop', 'enum.agent_submission_kinds.new_shop', 10),
  ('verify_shop', 'enum.agent_submission_kinds.verify_shop', 20),
  ('update_info', 'enum.agent_submission_kinds.update_info', 30);
--> statement-breakpoint

CREATE TABLE public.agent_fraud_flags (
  code text NOT NULL, label_key text NOT NULL, sort_order integer NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT agent_fraud_flags_pk PRIMARY KEY (code),
  CONSTRAINT agent_fraud_flags_code_ck CHECK (code ~ '^[a-z][a-z0-9_]*$')
);
--> statement-breakpoint
CREATE TRIGGER agent_fraud_flags_set_updated_at BEFORE UPDATE ON public.agent_fraud_flags
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint
INSERT INTO public.agent_fraud_flags (code, label_key, sort_order) VALUES
  -- The shutter's GPS fix far from (or long before) the save's.
  ('gps_photo_mismatch', 'enum.agent_fraud_flags.gps_photo_mismatch', 10),
  -- Faster than agent_fraud_max_speed_kmh since the agent's previous capture.
  ('impossible_travel', 'enum.agent_fraud_flags.impossible_travel', 20),
  -- Within agent_fraud_min_seconds_between of the previous capture.
  ('rapid_fire', 'enum.agent_fraud_flags.rapid_fire', 30),
  -- A photo identical (checksum) or near-identical (thumbhash) to another submission's.
  ('duplicate_photo', 'enum.agent_fraud_flags.duplicate_photo', 40),
  -- The shop's phone failed its OTP.
  ('phone_otp_failed', 'enum.agent_fraud_flags.phone_otp_failed', 50);
--> statement-breakpoint

INSERT INTO public.visit_purposes (code, label_key, sort_order) VALUES
  ('info_update', 'enum.visit_purposes.info_update', 60)
ON CONFLICT (code) DO NOTHING;
--> statement-breakpoint
INSERT INTO public.visit_outcomes (code, label_key, sort_order) VALUES
  ('submitted', 'enum.visit_outcomes.submitted', 60)
ON CONFLICT (code) DO NOTHING;
--> statement-breakpoint

-- ============================================================================
-- agent_tasks
-- ============================================================================

CREATE TABLE public.agent_tasks (
  id                  uuid        NOT NULL DEFAULT public.uuid_generate_v7(),
  tenant_id           uuid        NOT NULL DEFAULT public.current_tenant_id(),
  field_agent_id      uuid        NOT NULL,
  type_code           text        NOT NULL,
  title               text        NOT NULL,
  -- Where: a locality, a point, or (verify / update) the place itself.
  locality_id         uuid,
  target_location     geography(Point, 4326),
  place_id            uuid,
  due_on              date        NOT NULL,
  status_code         text        NOT NULL DEFAULT 'open',
  done_at             timestamptz,
  notes               text,
  created_by_user_id  uuid,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT agent_tasks_pk PRIMARY KEY (id),
  CONSTRAINT agent_tasks_tenant_id_fk FOREIGN KEY (tenant_id) REFERENCES public.tenants (id) ON DELETE RESTRICT,
  CONSTRAINT agent_tasks_tenant_id_field_agent_id_fk FOREIGN KEY (tenant_id, field_agent_id)
    REFERENCES public.field_agents (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT agent_tasks_type_code_fk FOREIGN KEY (type_code)
    REFERENCES public.agent_task_types (code) ON DELETE RESTRICT,
  CONSTRAINT agent_tasks_status_code_fk FOREIGN KEY (status_code)
    REFERENCES public.agent_task_statuses (code) ON DELETE RESTRICT,
  CONSTRAINT agent_tasks_tenant_id_locality_id_fk FOREIGN KEY (tenant_id, locality_id)
    REFERENCES public.localities (tenant_id, id) ON DELETE SET NULL (locality_id),
  CONSTRAINT agent_tasks_tenant_id_place_id_fk FOREIGN KEY (tenant_id, place_id)
    REFERENCES public.places (tenant_id, id) ON DELETE SET NULL (place_id),
  CONSTRAINT agent_tasks_created_by_user_id_fk FOREIGN KEY (created_by_user_id)
    REFERENCES public.users (id) ON DELETE SET NULL,
  CONSTRAINT agent_tasks_title_ck CHECK (length(btrim(title)) > 0),
  CONSTRAINT agent_tasks_done_ck CHECK ((status_code = 'done') = (done_at IS NOT NULL)),
  -- Verifying or updating needs the place.
  CONSTRAINT agent_tasks_place_ck CHECK (type_code = 'map_shop' OR place_id IS NOT NULL),
  CONSTRAINT agent_tasks_tenant_id_id_uq UNIQUE (tenant_id, id)
);
--> statement-breakpoint
-- Today's route (an agent's open tasks by due day) and the admin list.
CREATE INDEX agent_tasks_agent_due_idx ON public.agent_tasks (tenant_id, field_agent_id, due_on, status_code);
--> statement-breakpoint
CREATE INDEX agent_tasks_locality_idx ON public.agent_tasks (tenant_id, locality_id) WHERE locality_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX agent_tasks_place_idx ON public.agent_tasks (tenant_id, place_id) WHERE place_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX agent_tasks_target_gix ON public.agent_tasks USING gist (target_location)
  WHERE target_location IS NOT NULL;
--> statement-breakpoint
CREATE TRIGGER agent_tasks_set_updated_at BEFORE UPDATE ON public.agent_tasks
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint

-- ============================================================================
-- agent_submissions
-- ============================================================================

CREATE TABLE public.agent_submissions (
  -- The phone's own UUID, made when the capture began: the sync's
  -- idempotency key. A repeated upload finds this row and gets its outcome.
  id                        uuid          NOT NULL,
  tenant_id                 uuid          NOT NULL DEFAULT public.current_tenant_id(),
  field_agent_id            uuid          NOT NULL,
  task_id                   uuid,
  kind_code                 text          NOT NULL,
  -- On the phone: when saved, where, and how sure the GPS was.
  captured_at               timestamptz   NOT NULL,
  location                  geography(Point, 4326) NOT NULL,
  accuracy_m                numeric(6,1)  NOT NULL,
  -- The phone's fix at the shutter (the anti-fraud comparison).
  photo_location            geography(Point, 4326),
  photo_taken_at            timestamptz,
  photo_media_ids           uuid[]        NOT NULL DEFAULT '{}',
  -- What was captured, as sent (name, category, hours, notes; the phone lives on the place).
  payload                   jsonb         NOT NULL,
  -- What it became.
  place_id                  uuid,
  place_edit_suggestion_id  uuid,
  agent_visit_id            uuid,
  -- Duplicate on sync: the agent's answer ('new' = a different shop, 'same' = it is duplicate_of_place_id).
  duplicate_decision        text,
  duplicate_of_place_id     uuid,
  fraud_flags               text[]        NOT NULL DEFAULT '{}',
  fraud_detail              jsonb         NOT NULL DEFAULT '{}',
  phone_check_status        text          NOT NULL DEFAULT 'none',
  created_at                timestamptz   NOT NULL DEFAULT now(),
  updated_at                timestamptz   NOT NULL DEFAULT now(),
  CONSTRAINT agent_submissions_pk PRIMARY KEY (id),
  CONSTRAINT agent_submissions_tenant_id_fk FOREIGN KEY (tenant_id) REFERENCES public.tenants (id) ON DELETE RESTRICT,
  CONSTRAINT agent_submissions_tenant_id_field_agent_id_fk FOREIGN KEY (tenant_id, field_agent_id)
    REFERENCES public.field_agents (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT agent_submissions_tenant_id_task_id_fk FOREIGN KEY (tenant_id, task_id)
    REFERENCES public.agent_tasks (tenant_id, id) ON DELETE SET NULL (task_id),
  CONSTRAINT agent_submissions_kind_code_fk FOREIGN KEY (kind_code)
    REFERENCES public.agent_submission_kinds (code) ON DELETE RESTRICT,
  CONSTRAINT agent_submissions_tenant_id_place_id_fk FOREIGN KEY (tenant_id, place_id)
    REFERENCES public.places (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT agent_submissions_tenant_id_suggestion_id_fk FOREIGN KEY (tenant_id, place_edit_suggestion_id)
    REFERENCES public.place_edit_suggestions (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT agent_submissions_tenant_id_agent_visit_id_fk FOREIGN KEY (tenant_id, agent_visit_id)
    REFERENCES public.agent_visits (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT agent_submissions_tenant_id_duplicate_of_fk FOREIGN KEY (tenant_id, duplicate_of_place_id)
    REFERENCES public.places (tenant_id, id) ON DELETE SET NULL (duplicate_of_place_id),
  CONSTRAINT agent_submissions_accuracy_ck CHECK (accuracy_m >= 0),
  CONSTRAINT agent_submissions_payload_ck CHECK (jsonb_typeof(payload) = 'object'),
  CONSTRAINT agent_submissions_decision_ck CHECK (
    duplicate_decision IS NULL OR duplicate_decision IN ('new', 'same')),
  CONSTRAINT agent_submissions_same_ck CHECK (
    (duplicate_decision = 'same') = (duplicate_of_place_id IS NOT NULL)),
  CONSTRAINT agent_submissions_phone_check_ck CHECK (phone_check_status IN ('none', 'verified', 'failed')),
  -- Every submission is linked to what it made, in the transaction that made it.
  CONSTRAINT agent_submissions_links_ck CHECK (
    CASE
      WHEN kind_code = 'new_shop' AND duplicate_decision IS DISTINCT FROM 'same'
        THEN place_id IS NOT NULL AND agent_visit_id IS NOT NULL
      WHEN kind_code = 'update_info' THEN place_id IS NOT NULL AND place_edit_suggestion_id IS NOT NULL
      ELSE place_id IS NOT NULL AND agent_visit_id IS NOT NULL
    END),
  CONSTRAINT agent_submissions_tenant_id_id_uq UNIQUE (tenant_id, id)
);
--> statement-breakpoint
-- My stats, the admin's per-agent numbers and the anti-fraud "previous capture".
CREATE INDEX agent_submissions_agent_captured_idx
  ON public.agent_submissions (tenant_id, field_agent_id, captured_at DESC);
--> statement-breakpoint
-- The commission report and the admin's map of a day.
CREATE INDEX agent_submissions_tenant_created_idx ON public.agent_submissions (tenant_id, created_at DESC);
--> statement-breakpoint
CREATE INDEX agent_submissions_place_idx ON public.agent_submissions (tenant_id, place_id) WHERE place_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX agent_submissions_suggestion_idx ON public.agent_submissions (tenant_id, place_edit_suggestion_id)
  WHERE place_edit_suggestion_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX agent_submissions_visit_idx ON public.agent_submissions (tenant_id, agent_visit_id)
  WHERE agent_visit_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX agent_submissions_task_idx ON public.agent_submissions (tenant_id, task_id) WHERE task_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX agent_submissions_duplicate_of_idx ON public.agent_submissions (tenant_id, duplicate_of_place_id)
  WHERE duplicate_of_place_id IS NOT NULL;
--> statement-breakpoint
-- duplicate_photo: which submissions carry a media id.
CREATE INDEX agent_submissions_photos_gin ON public.agent_submissions USING gin (photo_media_ids);
--> statement-breakpoint
CREATE INDEX agent_submissions_location_gix ON public.agent_submissions USING gist (location);
--> statement-breakpoint
CREATE INDEX agent_submissions_photo_location_gix ON public.agent_submissions USING gist (photo_location)
  WHERE photo_location IS NOT NULL;
--> statement-breakpoint
CREATE TRIGGER agent_submissions_set_updated_at BEFORE UPDATE ON public.agent_submissions
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint

-- Proof of capture: what was captured and where cannot change after the fact
-- (only the system may add fraud flags or the phone check).
CREATE OR REPLACE FUNCTION public.agent_submissions_immutable()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF (NEW.field_agent_id, NEW.kind_code, NEW.captured_at, NEW.location, NEW.accuracy_m, NEW.photo_location,
      NEW.photo_taken_at, NEW.photo_media_ids, NEW.payload, NEW.place_id, NEW.place_edit_suggestion_id,
      NEW.agent_visit_id, NEW.duplicate_decision, NEW.duplicate_of_place_id)
     IS DISTINCT FROM
     (OLD.field_agent_id, OLD.kind_code, OLD.captured_at, OLD.location, OLD.accuracy_m, OLD.photo_location,
      OLD.photo_taken_at, OLD.photo_media_ids, OLD.payload, OLD.place_id, OLD.place_edit_suggestion_id,
      OLD.agent_visit_id, OLD.duplicate_decision, OLD.duplicate_of_place_id)
     AND NOT public.app_is_system() THEN
    RAISE EXCEPTION 'agent_submissions: a capture cannot be changed (id %)', OLD.id
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER agent_submissions_a_immutable BEFORE UPDATE ON public.agent_submissions
  FOR EACH ROW EXECUTE FUNCTION public.agent_submissions_immutable();
--> statement-breakpoint

-- ============================================================================
-- agent_phone_checks
-- ============================================================================

CREATE TABLE public.agent_phone_checks (
  id              uuid        NOT NULL DEFAULT public.uuid_generate_v7(),
  tenant_id       uuid        NOT NULL DEFAULT public.current_tenant_id(),
  field_agent_id  uuid        NOT NULL,
  -- The submission's UUID: the check may happen before the submission syncs.
  submission_id   uuid        NOT NULL,
  -- HMAC of the shop's phone (the number itself lives on the place).
  phone_hash      text        NOT NULL,
  status_code     text        NOT NULL DEFAULT 'sent',
  attempts        integer     NOT NULL DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT agent_phone_checks_pk PRIMARY KEY (id),
  CONSTRAINT agent_phone_checks_tenant_id_fk FOREIGN KEY (tenant_id) REFERENCES public.tenants (id) ON DELETE RESTRICT,
  CONSTRAINT agent_phone_checks_tenant_id_field_agent_id_fk FOREIGN KEY (tenant_id, field_agent_id)
    REFERENCES public.field_agents (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT agent_phone_checks_status_ck CHECK (status_code IN ('sent', 'verified', 'failed')),
  CONSTRAINT agent_phone_checks_attempts_ck CHECK (attempts >= 0),
  CONSTRAINT agent_phone_checks_hash_ck CHECK (phone_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT agent_phone_checks_submission_uq UNIQUE (tenant_id, submission_id),
  CONSTRAINT agent_phone_checks_tenant_id_id_uq UNIQUE (tenant_id, id)
);
--> statement-breakpoint
CREATE INDEX agent_phone_checks_agent_idx ON public.agent_phone_checks (tenant_id, field_agent_id, created_at DESC);
--> statement-breakpoint
CREATE TRIGGER agent_phone_checks_set_updated_at BEFORE UPDATE ON public.agent_phone_checks
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint

-- ============================================================================
-- Settings (rule 9)
-- ============================================================================

INSERT INTO public.platform_settings
  (key, value, value_type_code, unit, min_value, max_value, tenant_override_scope_code, description)
VALUES
  ('agent_min_gps_accuracy_m', '25', 'integer', 'm', 3, 200, 'tenant_admin',
   'A shop is saved only with a GPS fix at least this accurate (the phone refuses, the API refuses again).'),
  ('agent_commission_per_shop', '"20.00"', 'money', 'BDT', NULL, NULL, 'tenant_admin',
   'Estimated commission per approved new shop (a field agent''s own rate overrides it). Calculation only; payouts are manual.'),
  ('agent_commission_per_verification', '"0.00"', 'money', 'BDT', NULL, NULL, 'tenant_admin',
   'Estimated commission per shop verification visit.'),
  ('agent_commission_per_update', '"0.00"', 'money', 'BDT', NULL, NULL, 'tenant_admin',
   'Estimated commission per approved information update.'),
  ('agent_capture_max_age_days', '14', 'integer', 'days', 1, 90, 'tenant_admin',
   'A capture older than this when it syncs is refused (too old to trust).'),
  ('agent_capture_photos_max', '3', 'integer', 'count', 1, 10, 'platform',
   'Photos per captured shop (the shop front first).'),
  ('agent_fraud_photo_fix_max_m', '150', 'integer', 'm', 10, 5000, 'tenant_admin',
   'Flag gps_photo_mismatch when the shutter''s GPS fix is farther than this from the save''s.'),
  ('agent_fraud_photo_age_max_minutes', '30', 'integer', 'minutes', 1, 1440, 'tenant_admin',
   'Flag gps_photo_mismatch when the photo was taken longer than this before the save.'),
  ('agent_fraud_max_speed_kmh', '80', 'integer', 'km/h', 5, 500, 'tenant_admin',
   'Flag impossible_travel when getting here from the agent''s previous capture needed more than this speed.'),
  ('agent_fraud_min_seconds_between', '40', 'integer', 'seconds', 1, 3600, 'tenant_admin',
   'Flag rapid_fire when a capture is saved within this many seconds of the agent''s previous one.'),
  ('agent_fraud_photo_lookback_days', '90', 'integer', 'days', 1, 3650, 'platform',
   'duplicate_photo compares with submissions in the area from this many days back.'),
  ('agent_list_page_size_max', '100', 'integer', 'count', 10, 500, 'platform',
   'Most rows per page in the agent lists (tasks, submissions, review queue).'),
  ('agent_stats_week_start_iso_day', '6', 'integer', 'iso_day', 1, 7, 'tenant_admin',
   'The first day of an agent''s week for "this week" stats and targets (ISO: 6 = Saturday, as in Bangladesh).');
--> statement-breakpoint

-- ============================================================================
-- Functions
-- ============================================================================

-- THE review status of a submission (one rule): a new shop is its place's
-- moderation (pending_review / published… / rejected, merged = duplicate), an
-- update its edit suggestion's, a verification is recorded. The commission is
-- the agent's rate (or the kind's setting) when approved. A caller sees their
-- own agent's rows; the area's staff any agent's (p_agent NULL = every agent).
CREATE OR REPLACE FUNCTION public.agent_submission_outcomes(p_agent uuid, p_from timestamptz, p_to timestamptz)
RETURNS TABLE (
  submission_id     uuid,
  field_agent_id    uuid,
  kind_code         text,
  captured_at       timestamptz,
  created_at        timestamptz,
  place_id          uuid,
  review_status     text,
  reason_code       text,
  reason_text       text,
  fraud_flags       text[],
  commission        numeric(12,2)
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_tenant uuid := public.current_tenant_id();
  v_shop numeric(12,2);
  v_verify numeric(12,2);
  v_update numeric(12,2);
BEGIN
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'agent_submission_outcomes: tenant' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT (public.app_is_staff() OR public.is_platform_admin() OR public.app_is_system()
          OR (p_agent IS NOT NULL AND public.is_my_field_agent(p_agent))) THEN
    RAISE EXCEPTION 'agent_submission_outcomes: own or staff' USING ERRCODE = 'insufficient_privilege';
  END IF;
  v_shop := (public.setting_value_for('agent_commission_per_shop', v_tenant) #>> '{}')::numeric;
  v_verify := (public.setting_value_for('agent_commission_per_verification', v_tenant) #>> '{}')::numeric;
  v_update := (public.setting_value_for('agent_commission_per_update', v_tenant) #>> '{}')::numeric;

  RETURN QUERY
  WITH base AS (
    SELECT s.id, s.field_agent_id, s.kind_code, s.captured_at, s.created_at,
           coalesce(s.place_id, s.duplicate_of_place_id) AS place_id, s.fraud_flags, s.duplicate_decision,
           fa.commission_rate,
           CASE
             WHEN s.kind_code = 'update_info' THEN
               CASE sg.status_code WHEN 'pending' THEN 'pending' WHEN 'approved' THEN 'approved' ELSE 'rejected' END
             WHEN s.kind_code = 'verify_shop' OR s.duplicate_decision = 'same' THEN 'approved'
             WHEN p.id IS NULL OR p.deleted_at IS NOT NULL THEN 'rejected'
             WHEN p.merged_into_place_id IS NOT NULL THEN 'rejected'
             WHEN p.status_code = 'pending_review' THEN 'pending'
             WHEN p.status_code = 'rejected' THEN 'rejected'
             ELSE 'approved'
           END AS st,
           CASE
             WHEN s.kind_code = 'update_info' THEN sg.decision_reason_code
             WHEN s.kind_code = 'verify_shop' OR s.duplicate_decision = 'same' THEN NULL
             WHEN p.merged_into_place_id IS NOT NULL THEN 'duplicate'
             WHEN p.status_code = 'rejected' THEN ma.reason_code
           END AS rc,
           CASE
             WHEN s.kind_code = 'update_info' THEN sg.decision_note
             WHEN p.status_code = 'rejected' THEN ma.reason_text
           END AS rt
    FROM public.agent_submissions s
    JOIN public.field_agents fa ON fa.tenant_id = s.tenant_id AND fa.id = s.field_agent_id
    LEFT JOIN public.places p ON p.tenant_id = s.tenant_id AND p.id = s.place_id
    LEFT JOIN public.place_edit_suggestions sg
      ON sg.tenant_id = s.tenant_id AND sg.id = s.place_edit_suggestion_id
    LEFT JOIN LATERAL (
      SELECT m.reason_code, m.reason_text FROM public.moderation_actions m
      WHERE m.tenant_id = s.tenant_id AND m.place_id = s.place_id AND m.action_code = 'rejected'
      ORDER BY m.created_at DESC LIMIT 1
    ) ma ON s.kind_code = 'new_shop' AND p.status_code = 'rejected'
    WHERE s.tenant_id = v_tenant
      AND (p_agent IS NULL OR s.field_agent_id = p_agent)
      AND s.created_at >= p_from AND s.created_at < p_to
  )
  SELECT b.id, b.field_agent_id, b.kind_code, b.captured_at, b.created_at, b.place_id, b.st, b.rc, b.rt,
         b.fraud_flags,
         (CASE WHEN b.st <> 'approved' THEN 0
               WHEN b.kind_code = 'new_shop' AND b.duplicate_decision IS DISTINCT FROM 'same'
                 THEN coalesce(b.commission_rate, v_shop)
               WHEN b.kind_code = 'update_info' THEN v_update
               ELSE v_verify
          END)::numeric(12,2)
  FROM base b
  ORDER BY b.created_at DESC, b.id;
END
$$;
--> statement-breakpoint
COMMENT ON FUNCTION public.agent_submission_outcomes(uuid, timestamptz, timestamptz) IS
  'THE review status and estimated commission of field agent submissions (ADR 066). Own agent or the area''s staff.';
--> statement-breakpoint

-- Other submissions in the area (any agent) whose photo is the same file
-- (checksum) or the same picture re-encoded (thumbhash), since p_since.
CREATE OR REPLACE FUNCTION public.agent_photo_reuse(p_submission uuid, p_media uuid[], p_since timestamptz)
RETURNS TABLE (media_id uuid, other_submission_id uuid, other_agent_id uuid)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT DISTINCT mine.id, s.id, s.field_agent_id
  FROM public.media_assets mine
  JOIN public.agent_submissions s
    ON s.tenant_id = public.current_tenant_id() AND s.id <> p_submission AND s.created_at >= p_since
  JOIN public.media_assets theirs
    ON theirs.id = ANY (s.photo_media_ids) AND theirs.id <> mine.id
   AND (theirs.checksum_sha256 = mine.checksum_sha256
        OR (theirs.thumbhash IS NOT NULL AND theirs.thumbhash = mine.thumbhash))
  WHERE mine.id = ANY (p_media)
    AND public.current_tenant_id() IS NOT NULL
    AND (public.app_role() = 'agent' OR public.app_is_staff() OR public.app_is_system())
$$;
--> statement-breakpoint
COMMENT ON FUNCTION public.agent_photo_reuse(uuid, uuid[], timestamptz) IS
  'duplicate_photo: other submissions in the caller''s area with the same photo file or picture (ADR 066).';
--> statement-breakpoint

-- ============================================================================
-- RLS
-- ============================================================================

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['agent_task_types', 'agent_task_statuses', 'agent_submission_kinds', 'agent_fraud_flags',
                           'agent_tasks', 'agent_submissions', 'agent_phone_checks']
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);
  END LOOP;
END
$$;
--> statement-breakpoint

CREATE POLICY agent_task_types_read_all ON public.agent_task_types FOR SELECT USING (true);
--> statement-breakpoint
CREATE POLICY agent_task_statuses_read_all ON public.agent_task_statuses FOR SELECT USING (true);
--> statement-breakpoint
CREATE POLICY agent_submission_kinds_read_all ON public.agent_submission_kinds FOR SELECT USING (true);
--> statement-breakpoint
CREATE POLICY agent_fraud_flags_read_all ON public.agent_fraud_flags FOR SELECT USING (true);
--> statement-breakpoint

-- agent_tasks: the agent reads theirs and marks them done; the area's staff manage all.
CREATE POLICY agent_tasks_agent_read ON public.agent_tasks
  FOR SELECT USING (tenant_id = (SELECT public.current_tenant_id()) AND (SELECT public.is_my_field_agent(field_agent_id)));
--> statement-breakpoint
CREATE POLICY agent_tasks_agent_done ON public.agent_tasks
  FOR UPDATE
  USING (tenant_id = (SELECT public.current_tenant_id()) AND (SELECT public.is_my_field_agent(field_agent_id)))
  WITH CHECK (tenant_id = (SELECT public.current_tenant_id()) AND (SELECT public.is_my_field_agent(field_agent_id)));
--> statement-breakpoint
CREATE POLICY agent_tasks_staff_manage ON public.agent_tasks
  FOR ALL
  USING (tenant_id = (SELECT public.current_tenant_id()) AND (SELECT public.app_is_staff()))
  WITH CHECK (tenant_id = (SELECT public.current_tenant_id()) AND (SELECT public.app_is_staff()));
--> statement-breakpoint
CREATE POLICY agent_tasks_system ON public.agent_tasks
  FOR ALL USING ((SELECT public.app_is_system())) WITH CHECK ((SELECT public.app_is_system()));
--> statement-breakpoint
CREATE POLICY agent_tasks_platform_admin ON public.agent_tasks
  FOR ALL USING ((SELECT public.is_platform_admin())) WITH CHECK ((SELECT public.is_platform_admin()));
--> statement-breakpoint

-- agent_submissions: the agent inserts and reads their own; the area's staff read; the system flags.
CREATE POLICY agent_submissions_agent_read ON public.agent_submissions
  FOR SELECT USING (tenant_id = (SELECT public.current_tenant_id()) AND (SELECT public.is_my_field_agent(field_agent_id)));
--> statement-breakpoint
CREATE POLICY agent_submissions_agent_insert ON public.agent_submissions
  FOR INSERT
  WITH CHECK (tenant_id = (SELECT public.current_tenant_id()) AND (SELECT public.is_my_field_agent(field_agent_id)));
--> statement-breakpoint
CREATE POLICY agent_submissions_staff_read ON public.agent_submissions
  FOR SELECT USING (tenant_id = (SELECT public.current_tenant_id()) AND (SELECT public.app_is_staff()));
--> statement-breakpoint
CREATE POLICY agent_submissions_system ON public.agent_submissions
  FOR ALL USING ((SELECT public.app_is_system())) WITH CHECK ((SELECT public.app_is_system()));
--> statement-breakpoint
CREATE POLICY agent_submissions_platform_admin ON public.agent_submissions
  FOR SELECT USING ((SELECT public.is_platform_admin()));
--> statement-breakpoint

-- agent_phone_checks: the agent keeps their own; the area's staff read.
CREATE POLICY agent_phone_checks_agent_own ON public.agent_phone_checks
  FOR ALL
  USING (tenant_id = (SELECT public.current_tenant_id()) AND (SELECT public.is_my_field_agent(field_agent_id)))
  WITH CHECK (tenant_id = (SELECT public.current_tenant_id()) AND (SELECT public.is_my_field_agent(field_agent_id)));
--> statement-breakpoint
CREATE POLICY agent_phone_checks_staff_read ON public.agent_phone_checks
  FOR SELECT USING (tenant_id = (SELECT public.current_tenant_id()) AND (SELECT public.app_is_staff()));
--> statement-breakpoint
CREATE POLICY agent_phone_checks_platform_admin ON public.agent_phone_checks
  FOR SELECT USING ((SELECT public.is_platform_admin()));
--> statement-breakpoint

-- ============================================================================
-- Grants
-- ============================================================================

GRANT SELECT ON public.agent_task_types, public.agent_task_statuses, public.agent_submission_kinds,
  public.agent_fraud_flags TO ae_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON public.agent_tasks, public.agent_submissions, public.agent_phone_checks TO ae_app;
--> statement-breakpoint
GRANT SELECT ON public.agent_submissions, public.field_agents, public.places, public.place_edit_suggestions,
  public.moderation_actions, public.media_assets TO ae_rls_bypass;
--> statement-breakpoint

DO $$
DECLARE
  f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'public.agent_submission_outcomes(uuid, timestamptz, timestamptz)',
    'public.agent_photo_reuse(uuid, uuid[], timestamptz)'
  ]
  LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO ae_rls_bypass', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
  END LOOP;
END
$$;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.agent_submission_outcomes(uuid, timestamptz, timestamptz),
  public.agent_photo_reuse(uuid, uuid[], timestamptz)
TO ae_app;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.is_my_field_agent(uuid) TO ae_rls_bypass;
