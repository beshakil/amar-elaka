-- 0057_reviews
--
-- Reviews and the seller score (ADR 061), on the reviews / review_responses
-- tables of 0010.
--
--   lead_events          + actor_user_id → users (SET NULL): who contacted, also
--                          when they had no membership in that tenant yet (the
--                          member id stays NULL then). Backfilled from members.
--                          A review is proven by one of these. NEW index
--                          (tenant_id, store_id, actor_user_id, occurred_at).
--   reviews              + lead_event_id (the contact that proves it),
--                          edited_at, flags text[] (why it waits for a
--                          moderator), author_scrubbed_at. CHANGED RLS: no
--                          direct write by members or tenant staff any more
--                          (submit_review / edit_review / decide_review do,
--                          under the eligibility and audit rules); the
--                          reviewer reads their own review in any status.
--   review_responses     + edited_at.
--   moderation_actions   + review_id target.
--   report_reasons       + fake_review; moderation_reasons + fake_review.
--   stores               rating_avg / rating_count are written only by the
--                          review aggregate (or the system): a store's owner
--                          could set them with an ordinary update before.
--   store_seller_scores  NEW, tenant-scoped, system-written: the seller score
--                          cache (score, tier, components), stale on any
--                          change of an input.
--   review_prompts       NEW, tenant-scoped, system-written: "how was it?"
--                          asked once per member and store.
--   functions            review_eligibility, submit_review, edit_review,
--                          respond_to_review, report_review, decide_review,
--                          scrub_review_author, due_review_prompts,
--                          store_seller_score_inputs, review_integrity_flags;
--                          reads store_review_page, store_rating_summary,
--                          my_store_review, review_queue_page.
--   notification type    review_prompt (in_app + push), bn and en templates;
--                          scheduled job send-review-prompts.
--   settings             review_*, seller_score_*.
--
-- No column is dropped or renamed. Policies reviews_reviewer_insert,
-- reviews_reviewer_update and reviews_staff_moderate are replaced (writes
-- moved into the functions).
-- Tests: apps/api/test/reviews.db-spec.ts, reviews.e2e-spec.ts,
-- src/reviews/seller-score-formula.spec.ts.

SELECT set_config('app.is_platform_admin', 'true', true);
--> statement-breakpoint

-- ============================================================================
-- lead_events: who, by user
-- ============================================================================

ALTER TABLE public.lead_events
  ADD COLUMN actor_user_id uuid,
  ADD CONSTRAINT lead_events_actor_user_id_fk FOREIGN KEY (actor_user_id)
    REFERENCES public.users (id) ON DELETE SET NULL;
--> statement-breakpoint
UPDATE public.lead_events l SET actor_user_id = tm.user_id
FROM public.tenant_members tm
WHERE tm.tenant_id = l.tenant_id AND tm.id = l.actor_member_id AND l.actor_user_id IS NULL;
--> statement-breakpoint
-- Review eligibility and prompts: this user's contacts with this store.
CREATE INDEX lead_events_store_actor_user_idx
  ON public.lead_events (tenant_id, store_id, actor_user_id, occurred_at DESC)
  WHERE store_id IS NOT NULL AND actor_user_id IS NOT NULL;
--> statement-breakpoint

-- ============================================================================
-- reviews, review_responses
-- ============================================================================

ALTER TABLE public.reviews
  ADD COLUMN lead_event_id uuid,
  ADD COLUMN edited_at timestamptz,
  ADD COLUMN flags text[] NOT NULL DEFAULT '{}',
  ADD COLUMN author_scrubbed_at timestamptz,
  ADD CONSTRAINT reviews_lead_event_id_fk FOREIGN KEY (lead_event_id)
    REFERENCES public.lead_events (id) ON DELETE SET NULL,
  ADD CONSTRAINT reviews_flags_ck CHECK (flags <@ ARRAY[
    'low_trust', 'burst', 'shared_device', 'phone_pattern', 'similar_text'
  ]::text[]),
  -- A scrubbed author's words are gone; the rating stays (the aggregate).
  ADD CONSTRAINT reviews_scrubbed_body_ck CHECK (author_scrubbed_at IS NULL OR body IS NULL);
--> statement-breakpoint
-- The moderation queue: reviews waiting, oldest first.
CREATE INDEX reviews_tenant_pending_idx ON public.reviews (tenant_id, id)
  WHERE status_code = 'pending';
--> statement-breakpoint
-- Burst and similar-text checks: a store's recent reviews.
CREATE INDEX reviews_tenant_store_created_idx ON public.reviews (tenant_id, store_id, created_at DESC)
  WHERE store_id IS NOT NULL;
--> statement-breakpoint

ALTER TABLE public.review_responses ADD COLUMN edited_at timestamptz;
--> statement-breakpoint

-- Writes go through the functions below (eligibility, integrity, audit).
DROP POLICY reviews_reviewer_insert ON public.reviews;
--> statement-breakpoint
DROP POLICY reviews_reviewer_update ON public.reviews;
--> statement-breakpoint
DROP POLICY reviews_staff_moderate ON public.reviews;
--> statement-breakpoint
CREATE POLICY reviews_reviewer_read_own ON public.reviews
  FOR SELECT USING (
    tenant_id = (SELECT public.current_tenant_id())
    AND reviewer_member_id = (SELECT public.current_member_id())
  );
--> statement-breakpoint
CREATE POLICY reviews_staff_read ON public.reviews
  FOR SELECT USING (tenant_id = (SELECT public.current_tenant_id()) AND (SELECT public.app_is_staff()));
--> statement-breakpoint
-- The aggregate trigger and the score job run as system.
CREATE POLICY reviews_system_read ON public.reviews
  FOR SELECT USING (tenant_id = (SELECT public.current_tenant_id()) AND (SELECT public.app_is_system()));
--> statement-breakpoint
REVOKE INSERT, UPDATE, DELETE ON public.reviews FROM ae_app;
--> statement-breakpoint
-- A reply is written through respond_to_review (owner or an accepted manager).
REVOKE INSERT, UPDATE, DELETE ON public.review_responses FROM ae_app;
--> statement-breakpoint
GRANT SELECT ON public.reviews, public.review_responses TO ae_app;
--> statement-breakpoint

-- ============================================================================
-- moderation_actions, reports: the review target
-- ============================================================================

ALTER TABLE public.moderation_actions
  ADD COLUMN review_id uuid,
  ADD CONSTRAINT moderation_actions_tenant_id_review_id_fk FOREIGN KEY (tenant_id, review_id)
    REFERENCES public.reviews (tenant_id, id) ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE public.moderation_actions DROP CONSTRAINT moderation_actions_one_target_ck;
--> statement-breakpoint
ALTER TABLE public.moderation_actions
  ADD CONSTRAINT moderation_actions_one_target_ck
    CHECK (num_nonnulls(post_id, place_id, place_claim_id, store_id, conversation_id, review_id) = 1);
--> statement-breakpoint
CREATE INDEX moderation_actions_tenant_review_idx
  ON public.moderation_actions (tenant_id, review_id, id DESC)
  WHERE review_id IS NOT NULL;
--> statement-breakpoint

INSERT INTO public.report_reasons (code, label_key, sort_order) VALUES
  ('fake_review', 'enum.report_reasons.fake_review', 90);
--> statement-breakpoint
INSERT INTO public.moderation_reasons (code, label_key, sort_order) VALUES
  ('fake_review', 'enum.moderation_reasons.fake_review', 310);
--> statement-breakpoint
-- The review report queue.
CREATE INDEX reports_review_queue_idx ON public.reports (tenant_id, status_code, id)
  WHERE review_id IS NOT NULL;
--> statement-breakpoint

-- ============================================================================
-- stores: the rating columns are the aggregate's
-- ============================================================================

CREATE OR REPLACE FUNCTION public.stores_protect_rating()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF public.app_is_system() OR current_setting('app.review_aggregate', true) = 'on' THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' THEN
    NEW.rating_avg := NULL;
    NEW.rating_count := 0;
  ELSE
    NEW.rating_avg := OLD.rating_avg;
    NEW.rating_count := OLD.rating_count;
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER stores_c_protect_rating BEFORE INSERT OR UPDATE ON public.stores
  FOR EACH ROW EXECUTE FUNCTION public.stores_protect_rating();
--> statement-breakpoint

-- ============================================================================
-- store_seller_scores: TENANT-SCOPED, system-written
-- ============================================================================

CREATE TABLE public.store_seller_scores (
  id                 uuid        NOT NULL DEFAULT public.uuid_generate_v7(),
  tenant_id          uuid        NOT NULL DEFAULT public.current_tenant_id(),
  store_id           uuid        NOT NULL,
  score              smallint    NOT NULL,
  tier_code          text        NOT NULL,
  components         jsonb       NOT NULL DEFAULT '{}',
  algorithm_version  smallint    NOT NULL,
  computed_at        timestamptz NOT NULL DEFAULT now(),
  -- Set by any change of an input (a review, an upheld report, a
  -- verification) and by age: the next read recomputes.
  next_recompute_at  timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT store_seller_scores_pk PRIMARY KEY (id),
  CONSTRAINT store_seller_scores_tenant_id_fk FOREIGN KEY (tenant_id)
    REFERENCES public.tenants (id) ON DELETE RESTRICT,
  CONSTRAINT store_seller_scores_tenant_id_store_id_fk FOREIGN KEY (tenant_id, store_id)
    REFERENCES public.stores (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT store_seller_scores_store_uq UNIQUE (tenant_id, store_id),
  CONSTRAINT store_seller_scores_score_ck CHECK (score BETWEEN 0 AND 100),
  CONSTRAINT store_seller_scores_tier_ck CHECK (tier_code IN ('top', 'trusted', 'good', 'new', 'none')),
  CONSTRAINT store_seller_scores_components_ck CHECK (jsonb_typeof(components) = 'object')
);
--> statement-breakpoint
CREATE INDEX store_seller_scores_recompute_idx ON public.store_seller_scores (next_recompute_at)
  WHERE next_recompute_at IS NOT NULL;
--> statement-breakpoint
CREATE TRIGGER store_seller_scores_set_updated_at BEFORE UPDATE ON public.store_seller_scores
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint
ALTER TABLE public.store_seller_scores ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.store_seller_scores FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
-- The tier is public (through the API); the number is not shown, but the
-- store's own people and staff may read it.
CREATE POLICY store_seller_scores_read ON public.store_seller_scores
  FOR SELECT USING (
    tenant_id = (SELECT public.current_tenant_id())
    AND ((SELECT public.app_is_staff()) OR (SELECT public.app_is_system()) OR (SELECT public.can_manage_store(store_id)))
  );
--> statement-breakpoint
CREATE POLICY store_seller_scores_system_write ON public.store_seller_scores
  FOR ALL
  USING (tenant_id = (SELECT public.current_tenant_id()) AND (SELECT public.app_is_system()))
  WITH CHECK (tenant_id = (SELECT public.current_tenant_id()) AND (SELECT public.app_is_system()));
--> statement-breakpoint
CREATE POLICY store_seller_scores_platform_admin ON public.store_seller_scores
  FOR ALL USING ((SELECT public.is_platform_admin())) WITH CHECK ((SELECT public.is_platform_admin()));
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON public.store_seller_scores TO ae_app;
--> statement-breakpoint

-- ============================================================================
-- review_prompts: TENANT-SCOPED, system-written
-- ============================================================================

CREATE TABLE public.review_prompts (
  id             uuid        NOT NULL DEFAULT public.uuid_generate_v7(),
  tenant_id      uuid        NOT NULL DEFAULT public.current_tenant_id(),
  store_id       uuid        NOT NULL,
  user_id        uuid        NOT NULL,
  lead_event_id  uuid,
  sent_at        timestamptz NOT NULL DEFAULT now(),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT review_prompts_pk PRIMARY KEY (id),
  CONSTRAINT review_prompts_tenant_id_fk FOREIGN KEY (tenant_id)
    REFERENCES public.tenants (id) ON DELETE RESTRICT,
  CONSTRAINT review_prompts_tenant_id_store_id_fk FOREIGN KEY (tenant_id, store_id)
    REFERENCES public.stores (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT review_prompts_user_id_fk FOREIGN KEY (user_id)
    REFERENCES public.users (id) ON DELETE CASCADE,
  CONSTRAINT review_prompts_lead_event_id_fk FOREIGN KEY (lead_event_id)
    REFERENCES public.lead_events (id) ON DELETE SET NULL,
  -- Once per member and store, ever.
  CONSTRAINT review_prompts_store_user_uq UNIQUE (tenant_id, store_id, user_id)
);
--> statement-breakpoint
CREATE TRIGGER review_prompts_set_updated_at BEFORE UPDATE ON public.review_prompts
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint
ALTER TABLE public.review_prompts ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.review_prompts FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY review_prompts_own_read ON public.review_prompts
  FOR SELECT USING (tenant_id = (SELECT public.current_tenant_id()) AND user_id = (SELECT public.current_user_id()));
--> statement-breakpoint
CREATE POLICY review_prompts_system ON public.review_prompts
  FOR ALL
  USING (tenant_id = (SELECT public.current_tenant_id()) AND (SELECT public.app_is_system()))
  WITH CHECK (tenant_id = (SELECT public.current_tenant_id()) AND (SELECT public.app_is_system()));
--> statement-breakpoint
CREATE POLICY review_prompts_platform_admin ON public.review_prompts
  FOR ALL USING ((SELECT public.is_platform_admin())) WITH CHECK ((SELECT public.is_platform_admin()));
--> statement-breakpoint
GRANT SELECT ON public.review_prompts TO ae_app;
--> statement-breakpoint

-- ============================================================================
-- Settings (CLAUDE.md rule 9)
-- ============================================================================

INSERT INTO public.platform_settings
  (key, value, value_type_code, unit, min_value, max_value, tenant_override_scope_code, description)
VALUES
  ('review_min_hours_after_contact', '24', 'integer', 'hours', 0, 720, 'tenant_admin',
   'A member may review a store this long after contacting it (call, WhatsApp, SMS, or a chat the store answered) at the earliest.'),
  ('review_window_days', '90', 'integer', 'days', 1, 730, 'tenant_admin',
   'A member may review a store at most this long after their latest contact with it.'),
  ('review_edit_days', '30', 'integer', 'days', 0, 365, 'tenant_admin',
   'A review can be edited by its author this long after it was written (0 = never).'),
  ('review_text_max_length', '1000', 'integer', 'characters', 50, 5000, 'platform',
   'Longest review text.'),
  ('review_response_max_length', '1000', 'integer', 'characters', 50, 5000, 'platform',
   'Longest seller reply to a review.'),
  ('review_photos_max', '3', 'integer', 'photos', 0, 10, 'platform',
   'Most photos on one review.'),
  ('review_page_size_max', '50', 'integer', 'count', 5, 200, 'platform',
   'Largest page of a store''s reviews.'),
  ('review_low_trust_threshold', '20', 'integer', 'score', 0, 100, 'tenant_admin',
   'A review by a member whose trust score is below this waits for a moderator.'),
  ('review_burst_count', '5', 'integer', 'reviews', 2, 100, 'tenant_admin',
   'This many reviews on one store within review_burst_window_hours: each new one waits for a moderator.'),
  ('review_burst_window_hours', '24', 'integer', 'hours', 1, 720, 'tenant_admin',
   'The window of the review burst check.'),
  ('review_phone_prefix_length', '12', 'integer', 'characters', 8, 14, 'platform',
   'Two phone numbers (E.164, e.g. +8801712345678) agreeing on this many leading characters count as one pattern (sequential SIMs).'),
  ('review_phone_pattern_min_reviewers', '3', 'integer', 'reviewers', 2, 50, 'platform',
   'This many reviewers of one store in the burst window sharing a phone pattern: their reviews wait for a moderator. A reviewer sharing one with the store''s owner or staff always waits.'),
  ('review_text_similarity_threshold', '0.8', 'decimal', 'ratio', 0.3, 1, 'platform',
   'A review whose text is at least this similar (trigram) to another review of the same store waits for a moderator.'),
  ('review_text_similarity_min_length', '20', 'integer', 'characters', 5, 500, 'platform',
   'Shorter texts ("ভালো", "good") are not compared for similarity.'),
  ('review_prompt_hours', '48', 'integer', 'hours', 1, 720, 'tenant_admin',
   'After a member contacts a store, they are asked once to review it this long after.'),
  ('review_prompt_max_age_hours', '72', 'integer', 'hours', 1, 2160, 'platform',
   'A contact older than this when its prompt would be due is never prompted (no backlog after downtime).'),
  ('review_prompt_batch_size', '500', 'integer', 'count', 10, 10000, 'platform',
   'Most review prompts queued per run of the prompt job.'),
  ('seller_score_prior_mean', '4.0', 'decimal', 'stars', 1, 5, 'platform',
   'The Bayesian prior: the rating a store is assumed to have before its reviews say otherwise.'),
  ('seller_score_prior_weight', '10', 'decimal', 'reviews', 0, 1000, 'platform',
   'How many reviews the prior counts as: one 5-star review cannot outrank fifty 4.6s.'),
  ('seller_score_weight_rating', '45', 'integer', 'points', 0, 100, 'platform',
   'Seller score points for the (smoothed) rating at 5 stars.'),
  ('seller_score_weight_response_rate', '15', 'integer', 'points', 0, 100, 'platform',
   'Seller score points for answering every chat.'),
  ('seller_score_weight_response_time', '10', 'integer', 'points', 0, 100, 'platform',
   'Seller score points for a median first reply within seller_score_response_target_minutes.'),
  ('seller_score_weight_account_age', '10', 'integer', 'points', 0, 100, 'platform',
   'Seller score points for a store at least seller_score_account_age_full_months old.'),
  ('seller_score_weight_verification', '20', 'integer', 'points', 0, 100, 'platform',
   'Seller score points at the highest verification level (business); identity earns two thirds, phone one third.'),
  ('seller_score_penalty_per_upheld_report', '5', 'integer', 'points', 0, 100, 'platform',
   'Seller score points lost for each upheld report against the store, its posts or its owner.'),
  ('seller_score_response_target_minutes', '60', 'integer', 'minutes', 1, 10080, 'platform',
   'A median first chat reply this fast or faster earns all the response-time points.'),
  ('seller_score_response_max_minutes', '1440', 'integer', 'minutes', 2, 43200, 'platform',
   'A median first chat reply this slow or slower earns no response-time points.'),
  ('seller_score_response_window_days', '90', 'integer', 'days', 7, 730, 'platform',
   'Chats from this period count towards response rate and time.'),
  ('seller_score_min_conversations', '5', 'integer', 'conversations', 1, 100, 'platform',
   'Below this many chats, response rate and time earn half their points (not enough to judge).'),
  ('seller_score_account_age_full_months', '24', 'integer', 'months', 1, 240, 'platform',
   'A store this old earns all the account-age points.'),
  ('seller_score_min_reviews_for_tier', '3', 'integer', 'reviews', 0, 100, 'platform',
   'Below this many published reviews a store shows the "new" tier, whatever its score.'),
  ('seller_score_tier_top', '85', 'integer', 'score', 0, 100, 'platform',
   'Seller score at which a store shows the top tier.'),
  ('seller_score_tier_trusted', '70', 'integer', 'score', 0, 100, 'platform',
   'Seller score at which a store shows the trusted tier.'),
  ('seller_score_tier_good', '50', 'integer', 'score', 0, 100, 'platform',
   'Seller score at which a store shows the good tier (below: no badge).'),
  ('seller_score_cache_hours', '24', 'integer', 'hours', 1, 720, 'platform',
   'A seller score is recomputed at least this often (chat response stats change without an event).');
--> statement-breakpoint

-- ============================================================================
-- Notification: "how was it?"
-- ============================================================================

INSERT INTO public.notification_types (code, label_key, sort_order) VALUES
  ('review_prompt', 'enum.notification_types.review_prompt', 310);
--> statement-breakpoint
UPDATE public.notification_types SET default_channels = '{in_app,push}'
WHERE code = 'review_prompt';
--> statement-breakpoint
INSERT INTO public.notification_templates
  (type_code, channel_code, locale, variant, title_template, body_template, variables)
VALUES
  ('review_prompt', 'in_app', 'bn', 'single', '{{storeName}} কেমন লাগল?',
   'আপনার অভিজ্ঞতা লিখে অন্যদের সাহায্য করুন। রিভিউ দিতে এখানে চাপুন।', '{storeName}'),
  ('review_prompt', 'in_app', 'en', 'single', 'How was {{storeName}}?',
   'Help others by sharing your experience. Tap to write a review.', '{storeName}');
--> statement-breakpoint

INSERT INTO public.scheduled_jobs (code, label_key, sort_order) VALUES
  ('send-review-prompts', 'enum.scheduled_jobs.send-review-prompts', 160);
--> statement-breakpoint

-- ============================================================================
-- Functions (owner ae_rls_bypass)
-- ============================================================================

-- What this migration's SECURITY DEFINER functions touch. BYPASSRLS skips
-- policies, not grants (0009).
GRANT SELECT, INSERT, UPDATE ON public.reviews TO ae_rls_bypass;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON public.review_responses TO ae_rls_bypass;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON public.reports TO ae_rls_bypass;
--> statement-breakpoint
GRANT SELECT, INSERT ON public.moderation_actions TO ae_rls_bypass;
--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON public.media_attachments TO ae_rls_bypass;
--> statement-breakpoint
GRANT SELECT ON public.media_assets, public.lead_events, public.media_attachments, public.users, public.user_devices,
  public.user_profiles, public.tenant_members, public.stores, public.store_members, public.seller_profiles,
  public.member_trust_scores, public.conversations, public.posts, public.platform_settings,
  public.tenant_settings TO ae_rls_bypass;
--> statement-breakpoint
GRANT UPDATE ON public.stores TO ae_rls_bypass;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON public.review_prompts, public.store_seller_scores TO ae_rls_bypass;
--> statement-breakpoint

SET LOCAL ROLE ae_rls_bypass;
--> statement-breakpoint

-- An integer setting for a tenant (override, else default).
CREATE OR REPLACE FUNCTION public.review_setting_int(p_key text, p_tenant_id uuid)
RETURNS integer
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT (public.setting_value_for(p_key, p_tenant_id) #>> '{}')::numeric::integer
$$;
--> statement-breakpoint

-- Whether the caller may review this store, and with which contact (ADR 061,
-- the anti-fake rule): a lead_event from them to the store — a call, a
-- WhatsApp or SMS, or a chat the store answered (that lead only exists once
-- the seller replied, 0054) — at least review_min_hours_after_contact and at
-- most review_window_days ago. The newest such contact is the proof.
-- status: eligible | already_reviewed | no_contact | too_soon | expired |
-- own_store | store_unavailable | signed_out.
CREATE OR REPLACE FUNCTION public.review_eligibility(p_store_id uuid)
RETURNS TABLE (
  status          text,
  lead_event_id   uuid,
  eligible_at     timestamptz,
  expires_at      timestamptz,
  review_id       uuid
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
#variable_conflict use_column
DECLARE
  v_tenant uuid := public.current_tenant_id();
  v_user uuid := public.current_user_id();
  v_min interval;
  v_window interval;
  v_store public.stores%ROWTYPE;
  v_review uuid;
  v_latest record;
  v_valid record;
BEGIN
  IF v_user IS NULL THEN
    RETURN QUERY SELECT 'signed_out'::text, NULL::uuid, NULL::timestamptz, NULL::timestamptz, NULL::uuid;
    RETURN;
  END IF;
  SELECT * INTO v_store FROM public.stores s WHERE s.id = p_store_id AND s.tenant_id = v_tenant;
  IF NOT FOUND OR v_store.status_code <> 'active' THEN
    RETURN QUERY SELECT 'store_unavailable'::text, NULL::uuid, NULL::timestamptz, NULL::timestamptz, NULL::uuid;
    RETURN;
  END IF;
  -- The owner and the store's own staff never review it.
  IF EXISTS (
    SELECT 1 FROM public.tenant_members tm
    WHERE tm.tenant_id = v_tenant AND tm.user_id = v_user
      AND (tm.id = v_store.owner_member_id OR EXISTS (
        SELECT 1 FROM public.store_members sm
        WHERE sm.tenant_id = v_tenant AND sm.store_id = p_store_id AND sm.member_id = tm.id))
  ) THEN
    RETURN QUERY SELECT 'own_store'::text, NULL::uuid, NULL::timestamptz, NULL::timestamptz, NULL::uuid;
    RETURN;
  END IF;
  SELECT r.id INTO v_review
  FROM public.reviews r
  JOIN public.tenant_members tm ON tm.tenant_id = r.tenant_id AND tm.id = r.reviewer_member_id
  WHERE r.tenant_id = v_tenant AND r.store_id = p_store_id AND tm.user_id = v_user AND r.deleted_at IS NULL;
  IF v_review IS NOT NULL THEN
    RETURN QUERY SELECT 'already_reviewed'::text, NULL::uuid, NULL::timestamptz, NULL::timestamptz, v_review;
    RETURN;
  END IF;

  v_min := make_interval(hours => public.review_setting_int('review_min_hours_after_contact', v_tenant));
  v_window := make_interval(days => public.review_setting_int('review_window_days', v_tenant));

  SELECT l.id, l.occurred_at INTO v_valid
  FROM public.lead_events l
  WHERE l.tenant_id = v_tenant AND l.store_id = p_store_id AND l.actor_user_id = v_user
    AND l.channel_code IN ('call_click', 'whatsapp_click', 'sms_click', 'chat_started')
    AND l.occurred_at <= now() - v_min AND l.occurred_at >= now() - v_window
  ORDER BY l.occurred_at DESC
  LIMIT 1;
  IF FOUND THEN
    RETURN QUERY SELECT 'eligible'::text, v_valid.id, v_valid.occurred_at + v_min, v_valid.occurred_at + v_window, NULL::uuid;
    RETURN;
  END IF;

  SELECT l.id, l.occurred_at INTO v_latest
  FROM public.lead_events l
  WHERE l.tenant_id = v_tenant AND l.store_id = p_store_id AND l.actor_user_id = v_user
    AND l.channel_code IN ('call_click', 'whatsapp_click', 'sms_click', 'chat_started')
  ORDER BY l.occurred_at DESC
  LIMIT 1;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'no_contact'::text, NULL::uuid, NULL::timestamptz, NULL::timestamptz, NULL::uuid;
  ELSIF v_latest.occurred_at > now() - v_min THEN
    RETURN QUERY SELECT 'too_soon'::text, NULL::uuid, v_latest.occurred_at + v_min, v_latest.occurred_at + v_window, NULL::uuid;
  ELSE
    RETURN QUERY SELECT 'expired'::text, NULL::uuid, NULL::timestamptz, v_latest.occurred_at + v_window, NULL::uuid;
  END IF;
END
$$;
--> statement-breakpoint

-- Why a review should wait for a moderator (ADR 061): the author's trust is
-- very low; a burst of reviews on the store; the author shares a device or a
-- phone pattern with the store's people (or several of its reviewers share
-- one); the text is nearly another review's of the same store.
-- p_author_trust comes from TrustScoreService (the one trust rule).
CREATE OR REPLACE FUNCTION public.review_integrity_flags(
  p_store_id uuid,
  p_user_id uuid,
  p_body text,
  p_review_id uuid,
  p_author_trust integer
)
RETURNS text[]
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_tenant uuid := public.current_tenant_id();
  v_flags text[] := '{}';
  v_burst_window interval := make_interval(hours => public.review_setting_int('review_burst_window_hours', v_tenant));
  v_prefix integer := public.review_setting_int('review_phone_prefix_length', v_tenant);
  v_phone text;
  v_staff_users uuid[];
  v_similarity real := (public.setting_value_for('review_text_similarity_threshold', v_tenant) #>> '{}')::real;
BEGIN
  IF p_author_trust IS NOT NULL AND p_author_trust < public.review_setting_int('review_low_trust_threshold', v_tenant) THEN
    v_flags := array_append(v_flags, 'low_trust');
  END IF;

  -- This review counts as one of the burst.
  IF (
    SELECT count(*) + 1 FROM public.reviews r
    WHERE r.tenant_id = v_tenant AND r.store_id = p_store_id AND r.deleted_at IS NULL
      AND r.created_at >= now() - v_burst_window
      AND r.id IS DISTINCT FROM p_review_id
  ) >= public.review_setting_int('review_burst_count', v_tenant) THEN
    v_flags := array_append(v_flags, 'burst');
  END IF;

  -- The store's people: its owner and every staff member (any role, accepted or not).
  SELECT array_agg(DISTINCT tm.user_id) INTO v_staff_users
  FROM public.tenant_members tm
  WHERE tm.tenant_id = v_tenant AND (
    tm.id = (SELECT s.owner_member_id FROM public.stores s WHERE s.id = p_store_id AND s.tenant_id = v_tenant)
    OR tm.id IN (SELECT sm.member_id FROM public.store_members sm
                 WHERE sm.tenant_id = v_tenant AND sm.store_id = p_store_id)
  );

  IF EXISTS (
    SELECT 1 FROM public.user_devices mine
    JOIN public.user_devices theirs
      ON theirs.user_id = ANY (v_staff_users)
     AND ((mine.fingerprint_hash IS NOT NULL AND theirs.fingerprint_hash = mine.fingerprint_hash)
       OR (mine.push_token IS NOT NULL AND theirs.push_token = mine.push_token))
    WHERE mine.user_id = p_user_id
  ) THEN
    v_flags := array_append(v_flags, 'shared_device');
  END IF;

  SELECT u.phone_e164 INTO v_phone FROM public.users u WHERE u.id = p_user_id;
  IF v_phone IS NOT NULL AND (
    EXISTS (
      SELECT 1 FROM public.users u
      WHERE u.id = ANY (v_staff_users) AND left(u.phone_e164, v_prefix) = left(v_phone, v_prefix)
    )
    OR (
      SELECT count(DISTINCT u.id) FROM public.reviews r
      JOIN public.tenant_members tm ON tm.tenant_id = r.tenant_id AND tm.id = r.reviewer_member_id
      JOIN public.users u ON u.id = tm.user_id
      WHERE r.tenant_id = v_tenant AND r.store_id = p_store_id AND r.deleted_at IS NULL
        AND r.created_at >= now() - v_burst_window
        AND r.id IS DISTINCT FROM p_review_id
        AND u.id <> p_user_id
        AND left(u.phone_e164, v_prefix) = left(v_phone, v_prefix)
    ) + 1 >= public.review_setting_int('review_phone_pattern_min_reviewers', v_tenant)
  ) THEN
    v_flags := array_append(v_flags, 'phone_pattern');
  END IF;

  IF p_body IS NOT NULL
     AND char_length(btrim(p_body)) >= public.review_setting_int('review_text_similarity_min_length', v_tenant)
     AND EXISTS (
       SELECT 1 FROM public.reviews r
       WHERE r.tenant_id = v_tenant AND r.store_id = p_store_id AND r.deleted_at IS NULL
         AND r.id IS DISTINCT FROM p_review_id
         AND r.body IS NOT NULL
         AND similarity(lower(r.body), lower(p_body)) >= v_similarity
     ) THEN
    v_flags := array_append(v_flags, 'similar_text');
  END IF;
  RETURN v_flags;
END
$$;
--> statement-breakpoint

-- The caller's own photos, ready, not attached anywhere else, in this tenant:
-- attached to the review in order (replacing its previous ones).
CREATE OR REPLACE FUNCTION public.review_attach_media(p_review_id uuid, p_user_id uuid, p_media_ids uuid[])
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_tenant uuid := public.current_tenant_id();
  v_usable integer;
BEGIN
  p_media_ids := coalesce(p_media_ids, '{}');
  IF cardinality(p_media_ids) > public.review_setting_int('review_photos_max', v_tenant) THEN
    RAISE EXCEPTION 'review: too many photos' USING ERRCODE = 'AE611';
  END IF;
  SELECT count(*) INTO v_usable
  FROM public.media_assets m
  WHERE m.tenant_id = v_tenant AND m.id = ANY (p_media_ids)
    AND m.uploaded_by_user_id = p_user_id
    AND m.kind_code = 'image' AND m.status_code = 'ready' AND m.deleted_at IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM public.media_attachments a
      WHERE a.media_asset_id = m.id AND a.review_id IS DISTINCT FROM p_review_id
    );
  IF v_usable <> cardinality(p_media_ids) THEN
    RAISE EXCEPTION 'review: a photo is not usable' USING ERRCODE = 'AE612';
  END IF;
  DELETE FROM public.media_attachments a WHERE a.tenant_id = v_tenant AND a.review_id = p_review_id;
  INSERT INTO public.media_attachments (tenant_id, media_asset_id, review_id, sort_order)
  SELECT v_tenant, x.id, p_review_id, (x.ord - 1)::smallint
  FROM unnest(p_media_ids) WITH ORDINALITY AS x(id, ord);
END
$$;
--> statement-breakpoint

-- Write a review (ADR 061). Eligibility (review_eligibility, the one rule)
-- under a lock on the caller's member row, so two submits can't both pass;
-- the integrity flags decide published or pending. The caller's membership
-- in the store's tenant must exist (the API ensures it: a review is a
-- first write, like a post).
-- Errors: AE601 not eligible (with the status), AE602 bad rating, AE603 text
-- too long, AE611/AE612 photos.
CREATE OR REPLACE FUNCTION public.submit_review(
  p_store_id uuid,
  p_rating smallint,
  p_body text,
  p_media_ids uuid[],
  p_author_trust integer
)
RETURNS TABLE (review_id uuid, status_code text, flags text[])
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
#variable_conflict use_column
DECLARE
  v_tenant uuid := public.current_tenant_id();
  v_user uuid := public.current_user_id();
  v_member uuid := public.current_member_id();
  v_elig record;
  v_flags text[];
  v_status text;
  v_id uuid;
  v_body text := nullif(btrim(coalesce(p_body, '')), '');
BEGIN
  IF v_member IS NULL THEN
    RAISE EXCEPTION 'submit_review: no membership in this tenant' USING ERRCODE = 'insufficient_privilege';
  END IF;
  PERFORM 1 FROM public.tenant_members tm WHERE tm.tenant_id = v_tenant AND tm.id = v_member FOR UPDATE;
  SELECT * INTO v_elig FROM public.review_eligibility(p_store_id);
  IF v_elig.status <> 'eligible' THEN
    RAISE EXCEPTION 'submit_review: %', v_elig.status USING ERRCODE = 'AE601', DETAIL = v_elig.status;
  END IF;
  IF p_rating IS NULL OR p_rating NOT BETWEEN 1 AND 5 THEN
    RAISE EXCEPTION 'submit_review: rating' USING ERRCODE = 'AE602';
  END IF;
  IF v_body IS NOT NULL AND char_length(v_body) > public.review_setting_int('review_text_max_length', v_tenant) THEN
    RAISE EXCEPTION 'submit_review: text too long' USING ERRCODE = 'AE603';
  END IF;

  v_flags := public.review_integrity_flags(p_store_id, v_user, v_body, NULL, p_author_trust);
  v_status := CASE WHEN cardinality(v_flags) = 0 THEN 'published' ELSE 'pending' END;

  INSERT INTO public.reviews (tenant_id, reviewer_member_id, store_id, rating, body,
    has_verified_interaction, status_code, lead_event_id, flags)
  VALUES (v_tenant, v_member, p_store_id, p_rating, v_body, true, v_status, v_elig.lead_event_id, v_flags)
  RETURNING id INTO v_id;
  PERFORM public.review_attach_media(v_id, v_user, p_media_ids);
  RETURN QUERY SELECT v_id, v_status, v_flags;
END
$$;
--> statement-breakpoint

-- Edit one's own review within review_edit_days of writing it. The checks
-- run again: a published review that now trips one waits again; a review a
-- moderator hid or removed stays so (an edit can't undo a decision).
-- Errors: AE604 not yours / no such review, AE605 edit window over,
-- AE606 decided by a moderator, AE602/AE603/AE611/AE612 as submit.
CREATE OR REPLACE FUNCTION public.edit_review(
  p_review_id uuid,
  p_rating smallint,
  p_body text,
  p_media_ids uuid[],
  p_author_trust integer
)
RETURNS TABLE (review_id uuid, status_code text, flags text[])
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
#variable_conflict use_column
DECLARE
  v_tenant uuid := public.current_tenant_id();
  v_user uuid := public.current_user_id();
  v_review public.reviews%ROWTYPE;
  v_flags text[];
  v_status text;
  v_body text := nullif(btrim(coalesce(p_body, '')), '');
BEGIN
  SELECT * INTO v_review FROM public.reviews r
  WHERE r.id = p_review_id AND r.tenant_id = v_tenant
    AND r.reviewer_member_id = public.current_member_id() AND r.deleted_at IS NULL
  FOR UPDATE;
  IF NOT FOUND OR v_review.author_scrubbed_at IS NOT NULL THEN
    RAISE EXCEPTION 'edit_review: no such review' USING ERRCODE = 'AE604';
  END IF;
  IF v_review.created_at < now() - make_interval(days => public.review_setting_int('review_edit_days', v_tenant)) THEN
    RAISE EXCEPTION 'edit_review: edit window over' USING ERRCODE = 'AE605';
  END IF;
  IF v_review.status_code IN ('hidden', 'removed') THEN
    RAISE EXCEPTION 'edit_review: decided by a moderator' USING ERRCODE = 'AE606';
  END IF;
  IF p_rating IS NULL OR p_rating NOT BETWEEN 1 AND 5 THEN
    RAISE EXCEPTION 'edit_review: rating' USING ERRCODE = 'AE602';
  END IF;
  IF v_body IS NOT NULL AND char_length(v_body) > public.review_setting_int('review_text_max_length', v_tenant) THEN
    RAISE EXCEPTION 'edit_review: text too long' USING ERRCODE = 'AE603';
  END IF;

  v_flags := public.review_integrity_flags(v_review.store_id, v_user, v_body, v_review.id, p_author_trust);
  -- Trust and bursts are about who and when: an edit re-checks content only.
  v_flags := array(SELECT f FROM unnest(v_flags) f WHERE f IN ('shared_device', 'phone_pattern', 'similar_text'))
    || array(SELECT f FROM unnest(v_review.flags) f WHERE f IN ('low_trust', 'burst') AND v_review.status_code = 'pending');
  -- A pending review keeps its trust/burst flags (carried above), so it stays pending.
  v_status := CASE WHEN cardinality(v_flags) > 0 THEN 'pending' ELSE 'published' END;

  UPDATE public.reviews r SET
    rating = p_rating,
    body = v_body,
    flags = v_flags,
    status_code = v_status,
    edited_at = now()
  WHERE r.id = v_review.id;
  PERFORM public.review_attach_media(v_review.id, v_user, p_media_ids);
  RETURN QUERY SELECT v_review.id, v_status, v_flags;
END
$$;
--> statement-breakpoint

-- The store's reply to a review: one, editable, by its owner or an accepted
-- manager (can_manage_store). Errors: AE607 not the store's / no such review,
-- AE603 text too long.
CREATE OR REPLACE FUNCTION public.respond_to_review(p_review_id uuid, p_body text)
RETURNS TABLE (response_id uuid, created boolean)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
#variable_conflict use_column
DECLARE
  v_tenant uuid := public.current_tenant_id();
  v_member uuid := public.current_member_id();
  v_store uuid;
  v_body text := nullif(btrim(coalesce(p_body, '')), '');
  v_id uuid;
BEGIN
  SELECT r.store_id INTO v_store FROM public.reviews r
  WHERE r.id = p_review_id AND r.tenant_id = v_tenant AND r.status_code = 'published' AND r.deleted_at IS NULL
  FOR UPDATE;
  IF v_store IS NULL OR v_member IS NULL OR NOT public.can_manage_store(v_store) THEN
    RAISE EXCEPTION 'respond_to_review: not the store''s review' USING ERRCODE = 'AE607';
  END IF;
  IF v_body IS NULL OR char_length(v_body) > public.review_setting_int('review_response_max_length', v_tenant) THEN
    RAISE EXCEPTION 'respond_to_review: text' USING ERRCODE = 'AE603';
  END IF;
  UPDATE public.review_responses rr
  SET body = v_body, responder_member_id = v_member, edited_at = now()
  WHERE rr.tenant_id = v_tenant AND rr.review_id = p_review_id AND rr.deleted_at IS NULL
  RETURNING rr.id INTO v_id;
  IF v_id IS NOT NULL THEN
    RETURN QUERY SELECT v_id, false;
    RETURN;
  END IF;
  INSERT INTO public.review_responses (tenant_id, review_id, responder_member_id, body)
  VALUES (v_tenant, p_review_id, v_member, v_body)
  RETURNING id INTO v_id;
  RETURN QUERY SELECT v_id, true;
END
$$;
--> statement-breakpoint

-- Report a review (anyone in the tenant; the store's owner is the usual
-- reporter — they may report, never delete). One open report per reporter
-- and review. Errors: AE608 no such review, AE609 one's own review.
CREATE OR REPLACE FUNCTION public.report_review(p_review_id uuid, p_reason_code text, p_details text)
RETURNS TABLE (report_id uuid, created boolean)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
#variable_conflict use_column
DECLARE
  v_tenant uuid := public.current_tenant_id();
  v_member uuid := public.current_member_id();
  v_review public.reviews%ROWTYPE;
  v_id uuid;
BEGIN
  SELECT * INTO v_review FROM public.reviews r
  WHERE r.id = p_review_id AND r.tenant_id = v_tenant AND r.status_code = 'published' AND r.deleted_at IS NULL;
  IF NOT FOUND OR v_member IS NULL THEN
    RAISE EXCEPTION 'report_review: no such review' USING ERRCODE = 'AE608';
  END IF;
  IF v_review.reviewer_member_id = v_member THEN
    RAISE EXCEPTION 'report_review: own review' USING ERRCODE = 'AE609';
  END IF;
  SELECT rp.id INTO v_id FROM public.reports rp
  WHERE rp.tenant_id = v_tenant AND rp.reporter_member_id = v_member AND rp.review_id = p_review_id
    AND rp.status_code IN ('open', 'in_review');
  IF v_id IS NOT NULL THEN
    RETURN QUERY SELECT v_id, false;
    RETURN;
  END IF;
  INSERT INTO public.reports (tenant_id, reporter_member_id, review_id, reason_code, details)
  VALUES (v_tenant, v_member, p_review_id, p_reason_code, nullif(btrim(coalesce(p_details, '')), ''))
  RETURNING id INTO v_id;
  RETURN QUERY SELECT v_id, true;
END
$$;
--> statement-breakpoint

-- A moderator decides a review (pending from the integrity checks, or
-- reported): publish, hide or remove — with a moderation_actions row and the
-- review's open reports closed, in this one transaction (CLAUDE.md rule 13).
-- Errors: insufficient_privilege (not staff), AE608 no such review,
-- AE610 bad decision.
CREATE OR REPLACE FUNCTION public.decide_review(
  p_review_id uuid,
  p_decision text,
  p_reason_code text,
  p_note text
)
RETURNS TABLE (status_code text, reports_closed integer)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
#variable_conflict use_column
DECLARE
  v_tenant uuid := public.current_tenant_id();
  v_actor uuid := public.current_user_id();
  v_status text;
  v_action text;
  v_closed integer;
BEGIN
  IF NOT public.app_is_staff() THEN
    RAISE EXCEPTION 'decide_review: staff only' USING ERRCODE = 'insufficient_privilege';
  END IF;
  v_status := CASE p_decision WHEN 'publish' THEN 'published' WHEN 'hide' THEN 'hidden' WHEN 'remove' THEN 'removed' END;
  v_action := CASE p_decision WHEN 'publish' THEN 'approved' WHEN 'hide' THEN 'rejected' WHEN 'remove' THEN 'removed' END;
  IF v_status IS NULL THEN
    RAISE EXCEPTION 'decide_review: decision %', p_decision USING ERRCODE = 'AE610';
  END IF;
  UPDATE public.reviews r SET
    status_code = v_status,
    moderated_by_user_id = v_actor,
    moderated_at = now(),
    moderation_reason_code = p_reason_code
  WHERE r.id = p_review_id AND r.tenant_id = v_tenant AND r.deleted_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'decide_review: no such review' USING ERRCODE = 'AE608';
  END IF;
  INSERT INTO public.moderation_actions (tenant_id, review_id, actor_user_id, action_code, reason_code, reason_text)
  VALUES (v_tenant, p_review_id, v_actor, v_action, p_reason_code, nullif(btrim(coalesce(p_note, '')), ''));
  UPDATE public.reports rp SET
    status_code = CASE WHEN p_decision = 'publish' THEN 'dismissed' ELSE 'actioned' END,
    resolution_code = CASE WHEN p_decision = 'publish' THEN 'no_action' ELSE 'content_removed' END,
    resolution_note = nullif(btrim(coalesce(p_note, '')), ''),
    resolved_at = now(),
    assigned_to_user_id = v_actor
  WHERE rp.tenant_id = v_tenant AND rp.review_id = p_review_id AND rp.status_code IN ('open', 'in_review');
  GET DIAGNOSTICS v_closed = ROW_COUNT;
  RETURN QUERY SELECT v_status, v_closed;
END
$$;
--> statement-breakpoint

-- A privacy scrub of a review author (ADR 061): their name and words go —
-- the text, the photos — the rating stays in the store's aggregate. Every
-- review of the user in every tenant, refused outright under a legal hold on
-- the user (CLAUDE.md rule 11); a review of a store under hold is skipped.
-- Platform admins only; each scrubbed review records a privacy_scrub action.
-- Returns how many reviews were scrubbed.
CREATE OR REPLACE FUNCTION public.scrub_review_author(p_user_id uuid, p_reason text)
RETURNS integer
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_actor uuid := public.current_user_id();
  v_count integer := 0;
  r record;
BEGIN
  IF NOT public.is_platform_admin() THEN
    RAISE EXCEPTION 'scrub_review_author: platform admins only' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF btrim(coalesce(p_reason, '')) = '' THEN
    RAISE EXCEPTION 'scrub_review_author: a reason is required' USING ERRCODE = 'check_violation';
  END IF;
  IF public.legal_hold_blocks('user', p_user_id) THEN
    RAISE EXCEPTION 'scrub_review_author: the user is under a legal hold' USING ERRCODE = 'AE613';
  END IF;
  FOR r IN
    SELECT rv.id, rv.tenant_id, rv.store_id FROM public.reviews rv
    JOIN public.tenant_members tm ON tm.tenant_id = rv.tenant_id AND tm.id = rv.reviewer_member_id
    WHERE tm.user_id = p_user_id AND rv.author_scrubbed_at IS NULL
    FOR UPDATE OF rv
  LOOP
    CONTINUE WHEN r.store_id IS NOT NULL AND public.legal_hold_blocks('store', r.store_id);
    UPDATE public.reviews SET body = NULL, author_scrubbed_at = now() WHERE id = r.id;
    DELETE FROM public.media_attachments a WHERE a.tenant_id = r.tenant_id AND a.review_id = r.id;
    INSERT INTO public.moderation_actions (tenant_id, review_id, actor_user_id, action_code, reason_code, reason_text)
    VALUES (r.tenant_id, r.id, v_actor, 'privacy_scrub', 'privacy_request', p_reason);
    v_count := v_count + 1;
  END LOOP;
  RETURN v_count;
END
$$;
--> statement-breakpoint

-- Contacts whose "how was it?" is due (ADR 061): review_prompt_hours after a
-- signed-in member's contact with an active store, once per member and
-- store ever, not to its own people, not when they already reviewed it, and
-- never for a contact older than review_prompt_max_age_hours (no backlog
-- after downtime). Claims them (review_prompts) and returns what the
-- notification needs. System only (the job).
CREATE OR REPLACE FUNCTION public.due_review_prompts(p_limit integer)
RETURNS TABLE (tenant_id uuid, store_id uuid, user_id uuid, store_name text, lead_event_id uuid)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
#variable_conflict use_column
BEGIN
  IF NOT public.app_is_system() THEN
    RAISE EXCEPTION 'due_review_prompts: system only' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN QUERY
  WITH due AS (
    SELECT DISTINCT ON (l.tenant_id, l.store_id, l.actor_user_id)
      l.tenant_id, l.store_id, l.actor_user_id AS user_id, l.id AS lead_event_id
    FROM public.lead_events l
    JOIN public.stores s ON s.tenant_id = l.tenant_id AND s.id = l.store_id AND s.status_code = 'active'
    WHERE l.store_id IS NOT NULL AND l.actor_user_id IS NOT NULL
      AND l.channel_code IN ('call_click', 'whatsapp_click', 'sms_click', 'chat_started')
      AND l.occurred_at <= now() - make_interval(hours => public.review_setting_int('review_prompt_hours', l.tenant_id))
      AND l.occurred_at > now() - make_interval(hours =>
            public.review_setting_int('review_prompt_hours', l.tenant_id)
            + public.review_setting_int('review_prompt_max_age_hours', l.tenant_id))
      AND NOT EXISTS (SELECT 1 FROM public.review_prompts rp
                      WHERE rp.tenant_id = l.tenant_id AND rp.store_id = l.store_id AND rp.user_id = l.actor_user_id)
      AND NOT EXISTS (SELECT 1 FROM public.reviews r
                      JOIN public.tenant_members tm ON tm.tenant_id = r.tenant_id AND tm.id = r.reviewer_member_id
                      WHERE r.tenant_id = l.tenant_id AND r.store_id = l.store_id AND tm.user_id = l.actor_user_id)
      AND NOT EXISTS (SELECT 1 FROM public.tenant_members tm
                      WHERE tm.tenant_id = l.tenant_id AND tm.user_id = l.actor_user_id
                        AND (tm.id = s.owner_member_id OR EXISTS (
                          SELECT 1 FROM public.store_members sm
                          WHERE sm.tenant_id = l.tenant_id AND sm.store_id = l.store_id AND sm.member_id = tm.id)))
    ORDER BY l.tenant_id, l.store_id, l.actor_user_id, l.occurred_at DESC
    LIMIT p_limit
  ),
  claimed AS (
    INSERT INTO public.review_prompts (tenant_id, store_id, user_id, lead_event_id)
    SELECT d.tenant_id, d.store_id, d.user_id, d.lead_event_id FROM due d
    ON CONFLICT (tenant_id, store_id, user_id) DO NOTHING
    RETURNING review_prompts.tenant_id, review_prompts.store_id, review_prompts.user_id, review_prompts.lead_event_id
  )
  SELECT c.tenant_id, c.store_id, c.user_id, s.name_bn, c.lead_event_id
  FROM claimed c
  JOIN public.stores s ON s.tenant_id = c.tenant_id AND s.id = c.store_id;
END
$$;
--> statement-breakpoint

-- What the seller score is made of, for one store (ADR 061): published
-- reviews (a scrubbed author's rating included), chat responsiveness over
-- seller_score_response_window_days (conversations about the store or its
-- posts the buyer wrote in; answered = the store replied; the time to the
-- first reply), age, verification, and upheld reports against the store,
-- its posts or its owner. System only (SellerScoreService).
CREATE OR REPLACE FUNCTION public.store_seller_score_inputs(p_store_id uuid)
RETURNS TABLE (
  rating_sum           bigint,
  rating_count         bigint,
  conversations        bigint,
  answered             bigint,
  median_reply_seconds double precision,
  store_created_at     timestamptz,
  verification_level   text,
  upheld_reports       bigint
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_tenant uuid := public.current_tenant_id();
  v_store public.stores%ROWTYPE;
  v_window interval;
BEGIN
  IF NOT (public.app_is_system() OR public.app_is_staff() OR public.is_platform_admin()) THEN
    RAISE EXCEPTION 'store_seller_score_inputs: system only' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT * INTO v_store FROM public.stores s WHERE s.id = p_store_id AND s.tenant_id = v_tenant;
  IF NOT FOUND THEN
    RETURN;
  END IF;
  v_window := make_interval(days => public.review_setting_int('seller_score_response_window_days', v_tenant));
  RETURN QUERY
  WITH convs AS (
    SELECT c.created_at, c.first_seller_reply_at
    FROM public.conversations c
    LEFT JOIN public.posts p ON p.tenant_id = c.tenant_id AND p.id = c.post_id
    WHERE c.tenant_id = v_tenant
      AND (c.store_id = p_store_id OR p.store_id = p_store_id)
      AND c.created_at >= now() - v_window
      AND c.last_message_at IS NOT NULL
  )
  SELECT
    (SELECT coalesce(sum(r.rating), 0)::bigint FROM public.reviews r
       WHERE r.tenant_id = v_tenant AND r.store_id = p_store_id AND r.status_code = 'published' AND r.deleted_at IS NULL),
    (SELECT count(*)::bigint FROM public.reviews r
       WHERE r.tenant_id = v_tenant AND r.store_id = p_store_id AND r.status_code = 'published' AND r.deleted_at IS NULL),
    (SELECT count(*)::bigint FROM convs),
    (SELECT count(*)::bigint FROM convs WHERE first_seller_reply_at IS NOT NULL),
    (SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM first_seller_reply_at - created_at))
       FROM convs WHERE first_seller_reply_at IS NOT NULL),
    v_store.created_at,
    CASE
      WHEN v_store.is_verified THEN 'business'
      ELSE coalesce((SELECT sp.verification_level_code FROM public.seller_profiles sp
                     WHERE sp.tenant_id = v_tenant AND sp.member_id = v_store.owner_member_id), 'phone')
    END,
    (SELECT count(*)::bigint FROM public.reports rp
       LEFT JOIN public.posts p ON p.tenant_id = rp.tenant_id AND p.id = rp.post_id
       WHERE rp.tenant_id = v_tenant AND rp.status_code = 'actioned'
         AND (rp.store_id = p_store_id OR p.store_id = p_store_id
              OR rp.reported_member_id = v_store.owner_member_id));
END
$$;
--> statement-breakpoint

-- The store's rating cache (stores.rating_avg / rating_count): every
-- published review counts, a scrubbed author's too (ADR 061). The seller
-- score goes stale with it.
CREATE OR REPLACE FUNCTION public.reviews_maintain_store_rating()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_tenant uuid := coalesce(NEW.tenant_id, OLD.tenant_id);
  v_store uuid := coalesce(NEW.store_id, OLD.store_id);
BEGIN
  IF v_store IS NULL THEN
    RETURN NULL;
  END IF;
  PERFORM set_config('app.review_aggregate', 'on', true);
  UPDATE public.stores s SET
    rating_count = agg.n,
    rating_avg = CASE WHEN agg.n = 0 THEN NULL ELSE round(agg.total::numeric / agg.n, 2) END
  FROM (
    SELECT count(*) AS n, coalesce(sum(r.rating), 0) AS total FROM public.reviews r
    WHERE r.tenant_id = v_tenant AND r.store_id = v_store AND r.status_code = 'published' AND r.deleted_at IS NULL
  ) agg
  WHERE s.tenant_id = v_tenant AND s.id = v_store;
  PERFORM set_config('app.review_aggregate', 'off', true);
  UPDATE public.store_seller_scores sc SET next_recompute_at = now()
  WHERE sc.tenant_id = v_tenant AND sc.store_id = v_store;
  RETURN NULL;
END
$$;
--> statement-breakpoint

-- Verification or an upheld report changes the seller score: stale.
CREATE OR REPLACE FUNCTION public.stores_mark_seller_score_stale()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.is_verified IS DISTINCT FROM OLD.is_verified THEN
    UPDATE public.store_seller_scores sc SET next_recompute_at = now()
    WHERE sc.tenant_id = NEW.tenant_id AND sc.store_id = NEW.id;
  END IF;
  RETURN NULL;
END
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.reports_mark_seller_score_stale()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.status_code = 'actioned' AND OLD.status_code IS DISTINCT FROM 'actioned' THEN
    UPDATE public.store_seller_scores sc SET next_recompute_at = now()
    WHERE sc.tenant_id = NEW.tenant_id AND sc.store_id IN (
      SELECT NEW.store_id
      UNION SELECT p.store_id FROM public.posts p WHERE p.tenant_id = NEW.tenant_id AND p.id = NEW.post_id
      UNION SELECT s.id FROM public.stores s WHERE s.tenant_id = NEW.tenant_id AND s.owner_member_id = NEW.reported_member_id
    );
  END IF;
  RETURN NULL;
END
$$;
--> statement-breakpoint

-- A page of a store's published reviews, newest first (ADR 061): the
-- author's display name (none once scrubbed — the rating stays), the
-- store's reply, the photos. In the store's tenant; anyone may read.
CREATE OR REPLACE FUNCTION public.store_review_page(p_store_id uuid, p_before uuid, p_limit integer)
RETURNS TABLE (
  review_id         uuid,
  rating            smallint,
  body              text,
  author_name       text,
  author_scrubbed   boolean,
  created_at        timestamptz,
  edited_at         timestamptz,
  response_body     text,
  response_at       timestamptz,
  response_edited_at timestamptz,
  photos            jsonb
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT r.id, r.rating, r.body,
    CASE WHEN r.author_scrubbed_at IS NULL THEN nullif(btrim(up.display_name), '') END,
    r.author_scrubbed_at IS NOT NULL,
    r.created_at, r.edited_at,
    rr.body, rr.created_at, rr.edited_at,
    coalesce((
      SELECT jsonb_agg(jsonb_build_object('id', m.id, 'thumbhash', m.thumbhash, 'variants', m.variants)
                       ORDER BY a.sort_order)
      FROM public.media_attachments a
      JOIN public.media_assets m ON m.tenant_id = a.tenant_id AND m.id = a.media_asset_id
      WHERE a.tenant_id = r.tenant_id AND a.review_id = r.id
        AND m.status_code = 'ready' AND m.visibility_code = 'public' AND m.deleted_at IS NULL
    ), '[]'::jsonb)
  FROM public.reviews r
  JOIN public.tenant_members tm ON tm.tenant_id = r.tenant_id AND tm.id = r.reviewer_member_id
  LEFT JOIN public.user_profiles up ON up.user_id = tm.user_id
  LEFT JOIN public.review_responses rr
    ON rr.tenant_id = r.tenant_id AND rr.review_id = r.id AND rr.deleted_at IS NULL AND rr.status_code = 'published'
  WHERE r.tenant_id = public.current_tenant_id() AND r.store_id = p_store_id
    AND r.status_code = 'published' AND r.deleted_at IS NULL
    AND (p_before IS NULL OR r.id < p_before)
  ORDER BY r.id DESC
  LIMIT p_limit
$$;
--> statement-breakpoint

-- The store's star histogram (published reviews; a scrubbed author's count).
CREATE OR REPLACE FUNCTION public.store_rating_summary(p_store_id uuid)
RETURNS TABLE (rating smallint, n bigint)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT r.rating, count(*) FROM public.reviews r
  WHERE r.tenant_id = public.current_tenant_id() AND r.store_id = p_store_id
    AND r.status_code = 'published' AND r.deleted_at IS NULL
  GROUP BY r.rating
$$;
--> statement-breakpoint

-- The caller's own review of a store, in any status (to edit it, or to see it waits).
CREATE OR REPLACE FUNCTION public.my_store_review(p_store_id uuid)
RETURNS TABLE (
  review_id uuid, rating smallint, body text, status_code text, created_at timestamptz,
  edited_at timestamptz, editable_until timestamptz, photos jsonb
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT r.id, r.rating, r.body, r.status_code, r.created_at, r.edited_at,
    r.created_at + make_interval(days => public.review_setting_int('review_edit_days', r.tenant_id)),
    coalesce((
      SELECT jsonb_agg(jsonb_build_object('id', m.id, 'thumbhash', m.thumbhash, 'variants', m.variants)
                       ORDER BY a.sort_order)
      FROM public.media_attachments a
      JOIN public.media_assets m ON m.tenant_id = a.tenant_id AND m.id = a.media_asset_id
      WHERE a.tenant_id = r.tenant_id AND a.review_id = r.id AND m.deleted_at IS NULL
    ), '[]'::jsonb)
  FROM public.reviews r
  JOIN public.tenant_members tm ON tm.tenant_id = r.tenant_id AND tm.id = r.reviewer_member_id
  WHERE r.tenant_id = public.current_tenant_id() AND r.store_id = p_store_id
    AND tm.user_id = public.current_user_id() AND r.deleted_at IS NULL
    AND r.author_scrubbed_at IS NULL
$$;
--> statement-breakpoint

-- The moderators' review queue (ADR 061): reviews waiting (flagged) and
-- published reviews with open reports, oldest first. Staff only.
CREATE OR REPLACE FUNCTION public.review_queue_page(p_after uuid, p_limit integer)
RETURNS TABLE (
  review_id     uuid,
  store_id      uuid,
  store_name    text,
  rating        smallint,
  body          text,
  status_code   text,
  flags         text[],
  open_reports  bigint,
  report_reasons text[],
  author_name   text,
  created_at    timestamptz
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
#variable_conflict use_column
BEGIN
  IF NOT public.app_is_staff() THEN
    RAISE EXCEPTION 'review_queue_page: staff only' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN QUERY
  SELECT r.id, r.store_id, s.name_bn, r.rating, r.body, r.status_code, r.flags,
    (SELECT count(*) FROM public.reports rp
       WHERE rp.tenant_id = r.tenant_id AND rp.review_id = r.id AND rp.status_code IN ('open', 'in_review')),
    (SELECT array_agg(DISTINCT rp.reason_code) FROM public.reports rp
       WHERE rp.tenant_id = r.tenant_id AND rp.review_id = r.id AND rp.status_code IN ('open', 'in_review')),
    CASE WHEN r.author_scrubbed_at IS NULL THEN nullif(btrim(up.display_name), '') END,
    r.created_at
  FROM public.reviews r
  JOIN public.stores s ON s.tenant_id = r.tenant_id AND s.id = r.store_id
  JOIN public.tenant_members tm ON tm.tenant_id = r.tenant_id AND tm.id = r.reviewer_member_id
  LEFT JOIN public.user_profiles up ON up.user_id = tm.user_id
  WHERE r.tenant_id = public.current_tenant_id() AND r.deleted_at IS NULL
    AND (r.status_code = 'pending' OR (r.status_code = 'published' AND EXISTS (
      SELECT 1 FROM public.reports rp
      WHERE rp.tenant_id = r.tenant_id AND rp.review_id = r.id AND rp.status_code IN ('open', 'in_review'))))
    AND (p_after IS NULL OR r.id > p_after)
  ORDER BY r.id
  LIMIT p_limit;
END
$$;
--> statement-breakpoint

RESET ROLE;
--> statement-breakpoint

CREATE TRIGGER reviews_maintain_store_rating AFTER INSERT OR UPDATE OR DELETE ON public.reviews
  FOR EACH ROW EXECUTE FUNCTION public.reviews_maintain_store_rating();
--> statement-breakpoint
CREATE TRIGGER stores_mark_seller_score_stale AFTER UPDATE OF is_verified ON public.stores
  FOR EACH ROW EXECUTE FUNCTION public.stores_mark_seller_score_stale();
--> statement-breakpoint
CREATE TRIGGER reports_mark_seller_score_stale AFTER UPDATE OF status_code ON public.reports
  FOR EACH ROW EXECUTE FUNCTION public.reports_mark_seller_score_stale();
--> statement-breakpoint

REVOKE ALL ON FUNCTION public.review_setting_int(text, uuid) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.review_eligibility(uuid) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.review_integrity_flags(uuid, uuid, text, uuid, integer) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.review_attach_media(uuid, uuid, uuid[]) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.submit_review(uuid, smallint, text, uuid[], integer) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.edit_review(uuid, smallint, text, uuid[], integer) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.respond_to_review(uuid, text) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.report_review(uuid, text, text) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.decide_review(uuid, text, text, text) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.scrub_review_author(uuid, text) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.due_review_prompts(integer) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.store_seller_score_inputs(uuid) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.reviews_maintain_store_rating() FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.stores_mark_seller_score_stale() FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.reports_mark_seller_score_stale() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.review_eligibility(uuid) TO ae_app;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.submit_review(uuid, smallint, text, uuid[], integer) TO ae_app;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.edit_review(uuid, smallint, text, uuid[], integer) TO ae_app;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.respond_to_review(uuid, text) TO ae_app;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.report_review(uuid, text, text) TO ae_app;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.decide_review(uuid, text, text, text) TO ae_app;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.scrub_review_author(uuid, text) TO ae_app;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.due_review_prompts(integer) TO ae_app;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.store_seller_score_inputs(uuid) TO ae_app;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.store_review_page(uuid, uuid, integer) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.store_rating_summary(uuid) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.my_store_review(uuid) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.review_queue_page(uuid, integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.store_review_page(uuid, uuid, integer), public.store_rating_summary(uuid),
  public.my_store_review(uuid), public.review_queue_page(uuid, integer) TO ae_app;
--> statement-breakpoint
-- The functions call each other as their owner.
GRANT EXECUTE ON FUNCTION public.review_setting_int(text, uuid), public.review_integrity_flags(uuid, uuid, text, uuid, integer),
  public.review_attach_media(uuid, uuid, uuid[]), public.review_eligibility(uuid) TO ae_rls_bypass;
