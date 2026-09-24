-- 0010_trust
--
-- Trust domain (docs/specs/schema.md §9): reviews & responses, identity and
-- business verification, reports, the global blacklist, computed trust
-- scores, tenant-level bans, ban appeals, and append-only moderation
-- actions. Runs as ae_migrator; RLS and grants are in this same file.
--
-- §9.6/§9.8's ban_severities, blacklist_reasons, blacklist_severities and
-- blacklist_statuses enums already exist (0001) — only referenced here, not
-- recreated. moderation_reasons (0005) is extended with the six codes §9.11
-- needs that 0005 didn't have a reason to seed yet.
--
-- ============================================================================
-- SCOPE — as with 0007-0009: full DDL/CHECKs/indexes/RLS for every table,
-- every self-contained trigger. NOT built here, and why:
--   - appeal_submit_in_app()/public_appeal_submit()/public_appeal_status():
--     spec §9.10 says this outright — "built in the auth phase, not now".
--     They need app_verified_phone(), the OTP/Redis plumbing, and the
--     advisory-lock rate limiter, none of which exist yet. ban_appeals'
--     full shape and RLS are built; only the routing-on-insert functions
--     (which set queue_code/escalate_at atomically) are missing, so this
--     migration adds a narrow system-only INSERT policy as a structural
--     placeholder — nothing else can legally construct a correctly-routed
--     row without that business logic anyway.
--   - blacklist_entries'/bans' "emits to the outbox": outbox_events is
--     §11.8, not built until a later cross-cutting migration. The trigger
--     still does the DB-local half (recomputing tenant_members.
--     ban_severity_code, writing audit_logs, which already exists).
--   - moderation_actions.xact_id's "commit-time check on posts": that's a
--     trigger on `posts` itself (0005) proving a takedown was recorded in
--     the same transaction — cross-migration coupling into an already-
--     shipped, tested migration, deferred until the takedown mutation path
--     (scrub_post() etc.) is actually built.
--   - staff_open_conversation(conversation_id, report_id) (deferred in
--     0009's header pending `reports`): reports exists now, but resolving
--     "is this report linked to that conversation" correctly across every
--     report target type, plus the audit_logs write, is real orchestration
--     — still deferred, tracked here instead of re-explained in 0009.
--   - purge_verification_documents() (kyc_document_retention_days) and the
--     business-verification / bans expiry sweep jobs.
--   - verification_rejection_reasons' codes aren't enumerated anywhere in
--     the spec (unlike every other enum here) — seeded with a reasonable
--     placeholder set, same treatment as 0008's tax_invoice_formats.
--
-- Read-only SECURITY DEFINER helpers, same two ownership patterns as before:
--   - owns_review_target(): plain (not SECURITY DEFINER) — every table it
--     reads already shows the caller their own rows under that table's own
--     RLS, matching can_manage_store()/owns_lead_target().
--   - blacklist_severity(), trust_summary(), my_active_bans(),
--     my_post_moderation_history(): genuinely need to see rows their
--     caller's own RLS would hide (an anonymous signup check, staff reading
--     another member's score, a banned user reading their own ban, an
--     owner reading a removed post's history) — owned by ae_rls_bypass
--     (0009), with matching GRANT SELECT on the tables they read.
-- ============================================================================

-- ============================================================================
-- Enum tables
-- ============================================================================

CREATE TABLE public.review_statuses (
  code text NOT NULL, label_key text NOT NULL, sort_order integer NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT review_statuses_pk PRIMARY KEY (code), CONSTRAINT review_statuses_code_ck CHECK (code ~ '^[a-z][a-z0-9_]*$')
);
--> statement-breakpoint
CREATE TRIGGER review_statuses_set_updated_at BEFORE UPDATE ON public.review_statuses FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint
INSERT INTO public.review_statuses (code, label_key, sort_order) VALUES
  ('pending', 'enum.review_statuses.pending', 10),
  ('published', 'enum.review_statuses.published', 20),
  ('hidden', 'enum.review_statuses.hidden', 30),
  ('removed', 'enum.review_statuses.removed', 40);
--> statement-breakpoint

CREATE TABLE public.verification_types (
  code text NOT NULL, label_key text NOT NULL, sort_order integer NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT verification_types_pk PRIMARY KEY (code), CONSTRAINT verification_types_code_ck CHECK (code ~ '^[a-z][a-z0-9_]*$')
);
--> statement-breakpoint
CREATE TRIGGER verification_types_set_updated_at BEFORE UPDATE ON public.verification_types FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint
INSERT INTO public.verification_types (code, label_key, sort_order) VALUES
  ('nid', 'enum.verification_types.nid', 10),
  ('passport', 'enum.verification_types.passport', 20),
  ('birth_certificate', 'enum.verification_types.birth_certificate', 30),
  ('selfie_liveness', 'enum.verification_types.selfie_liveness', 40);
--> statement-breakpoint

CREATE TABLE public.verification_statuses (
  code text NOT NULL, label_key text NOT NULL, sort_order integer NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT verification_statuses_pk PRIMARY KEY (code), CONSTRAINT verification_statuses_code_ck CHECK (code ~ '^[a-z][a-z0-9_]*$')
);
--> statement-breakpoint
CREATE TRIGGER verification_statuses_set_updated_at BEFORE UPDATE ON public.verification_statuses FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint
INSERT INTO public.verification_statuses (code, label_key, sort_order) VALUES
  ('submitted', 'enum.verification_statuses.submitted', 10),
  ('in_review', 'enum.verification_statuses.in_review', 20),
  ('approved', 'enum.verification_statuses.approved', 30),
  ('rejected', 'enum.verification_statuses.rejected', 40),
  ('expired', 'enum.verification_statuses.expired', 50),
  ('revoked', 'enum.verification_statuses.revoked', 60);
--> statement-breakpoint

-- Not enumerated anywhere in the spec (unlike every other enum table here) —
-- provisional placeholder set, same treatment as 0008's tax_invoice_formats.
CREATE TABLE public.verification_rejection_reasons (
  code text NOT NULL, label_key text NOT NULL, sort_order integer NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT verification_rejection_reasons_pk PRIMARY KEY (code), CONSTRAINT verification_rejection_reasons_code_ck CHECK (code ~ '^[a-z][a-z0-9_]*$')
);
--> statement-breakpoint
CREATE TRIGGER verification_rejection_reasons_set_updated_at BEFORE UPDATE ON public.verification_rejection_reasons FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint
INSERT INTO public.verification_rejection_reasons (code, label_key, sort_order) VALUES
  ('document_unclear', 'enum.verification_rejection_reasons.document_unclear', 10),
  ('document_expired', 'enum.verification_rejection_reasons.document_expired', 20),
  ('name_mismatch', 'enum.verification_rejection_reasons.name_mismatch', 30),
  ('suspected_fraud', 'enum.verification_rejection_reasons.suspected_fraud', 40),
  ('duplicate_submission', 'enum.verification_rejection_reasons.duplicate_submission', 50),
  ('other', 'enum.verification_rejection_reasons.other', 60);
--> statement-breakpoint

CREATE TABLE public.business_verification_types (
  code text NOT NULL, label_key text NOT NULL, sort_order integer NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT business_verification_types_pk PRIMARY KEY (code), CONSTRAINT business_verification_types_code_ck CHECK (code ~ '^[a-z][a-z0-9_]*$')
);
--> statement-breakpoint
CREATE TRIGGER business_verification_types_set_updated_at BEFORE UPDATE ON public.business_verification_types FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint
INSERT INTO public.business_verification_types (code, label_key, sort_order) VALUES
  ('trade_license', 'enum.business_verification_types.trade_license', 10),
  ('tin', 'enum.business_verification_types.tin', 20),
  ('physical_visit', 'enum.business_verification_types.physical_visit', 30),
  ('bsti_license', 'enum.business_verification_types.bsti_license', 40),
  ('drug_license', 'enum.business_verification_types.drug_license', 50);
--> statement-breakpoint

CREATE TABLE public.report_reasons (
  code text NOT NULL, label_key text NOT NULL, sort_order integer NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT report_reasons_pk PRIMARY KEY (code), CONSTRAINT report_reasons_code_ck CHECK (code ~ '^[a-z][a-z0-9_]*$')
);
--> statement-breakpoint
CREATE TRIGGER report_reasons_set_updated_at BEFORE UPDATE ON public.report_reasons FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint
INSERT INTO public.report_reasons (code, label_key, sort_order) VALUES
  ('scam', 'enum.report_reasons.scam', 10),
  ('fake_listing', 'enum.report_reasons.fake_listing', 20),
  ('prohibited_item', 'enum.report_reasons.prohibited_item', 30),
  ('harassment', 'enum.report_reasons.harassment', 40),
  ('spam', 'enum.report_reasons.spam', 50),
  ('wrong_information', 'enum.report_reasons.wrong_information', 60),
  ('duplicate', 'enum.report_reasons.duplicate', 70),
  ('other', 'enum.report_reasons.other', 80);
--> statement-breakpoint

CREATE TABLE public.report_statuses (
  code text NOT NULL, label_key text NOT NULL, sort_order integer NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT report_statuses_pk PRIMARY KEY (code), CONSTRAINT report_statuses_code_ck CHECK (code ~ '^[a-z][a-z0-9_]*$')
);
--> statement-breakpoint
CREATE TRIGGER report_statuses_set_updated_at BEFORE UPDATE ON public.report_statuses FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint
INSERT INTO public.report_statuses (code, label_key, sort_order) VALUES
  ('open', 'enum.report_statuses.open', 10),
  ('in_review', 'enum.report_statuses.in_review', 20),
  ('actioned', 'enum.report_statuses.actioned', 30),
  ('dismissed', 'enum.report_statuses.dismissed', 40),
  ('escalated', 'enum.report_statuses.escalated', 50);
--> statement-breakpoint

CREATE TABLE public.report_resolutions (
  code text NOT NULL, label_key text NOT NULL, sort_order integer NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT report_resolutions_pk PRIMARY KEY (code), CONSTRAINT report_resolutions_code_ck CHECK (code ~ '^[a-z][a-z0-9_]*$')
);
--> statement-breakpoint
CREATE TRIGGER report_resolutions_set_updated_at BEFORE UPDATE ON public.report_resolutions FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint
INSERT INTO public.report_resolutions (code, label_key, sort_order) VALUES
  ('content_removed', 'enum.report_resolutions.content_removed', 10),
  ('user_warned', 'enum.report_resolutions.user_warned', 20),
  ('tenant_ban_issued', 'enum.report_resolutions.tenant_ban_issued', 30),
  ('blacklist_recommended', 'enum.report_resolutions.blacklist_recommended', 40),
  ('no_action', 'enum.report_resolutions.no_action', 50);
--> statement-breakpoint

CREATE TABLE public.trust_bands (
  code text NOT NULL, label_key text NOT NULL, sort_order integer NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT trust_bands_pk PRIMARY KEY (code), CONSTRAINT trust_bands_code_ck CHECK (code ~ '^[a-z][a-z0-9_]*$')
);
--> statement-breakpoint
CREATE TRIGGER trust_bands_set_updated_at BEFORE UPDATE ON public.trust_bands FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint
INSERT INTO public.trust_bands (code, label_key, sort_order) VALUES
  ('new', 'enum.trust_bands.new', 10),
  ('low', 'enum.trust_bands.low', 20),
  ('standard', 'enum.trust_bands.standard', 30),
  ('trusted', 'enum.trust_bands.trusted', 40),
  ('top', 'enum.trust_bands.top', 50);
--> statement-breakpoint

CREATE TABLE public.ban_reasons (
  code text NOT NULL, label_key text NOT NULL, sort_order integer NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ban_reasons_pk PRIMARY KEY (code), CONSTRAINT ban_reasons_code_ck CHECK (code ~ '^[a-z][a-z0-9_]*$')
);
--> statement-breakpoint
CREATE TRIGGER ban_reasons_set_updated_at BEFORE UPDATE ON public.ban_reasons FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint
INSERT INTO public.ban_reasons (code, label_key, sort_order) VALUES
  ('scam', 'enum.ban_reasons.scam', 10),
  ('harassment', 'enum.ban_reasons.harassment', 20),
  ('spam', 'enum.ban_reasons.spam', 30),
  ('fake_listings', 'enum.ban_reasons.fake_listings', 40),
  ('payment_fraud', 'enum.ban_reasons.payment_fraud', 50),
  ('identity_fraud', 'enum.ban_reasons.identity_fraud', 60),
  ('repeated_violations', 'enum.ban_reasons.repeated_violations', 70),
  ('other', 'enum.ban_reasons.other', 80);
--> statement-breakpoint

CREATE TABLE public.ban_statuses (
  code text NOT NULL, label_key text NOT NULL, sort_order integer NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ban_statuses_pk PRIMARY KEY (code), CONSTRAINT ban_statuses_code_ck CHECK (code ~ '^[a-z][a-z0-9_]*$')
);
--> statement-breakpoint
CREATE TRIGGER ban_statuses_set_updated_at BEFORE UPDATE ON public.ban_statuses FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint
INSERT INTO public.ban_statuses (code, label_key, sort_order) VALUES
  ('active', 'enum.ban_statuses.active', 10),
  ('expired', 'enum.ban_statuses.expired', 20),
  ('revoked', 'enum.ban_statuses.revoked', 30),
  ('superseded', 'enum.ban_statuses.superseded', 40);
--> statement-breakpoint

CREATE TABLE public.appeal_channels (
  code text NOT NULL, label_key text NOT NULL, sort_order integer NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT appeal_channels_pk PRIMARY KEY (code), CONSTRAINT appeal_channels_code_ck CHECK (code ~ '^[a-z][a-z0-9_]*$')
);
--> statement-breakpoint
CREATE TRIGGER appeal_channels_set_updated_at BEFORE UPDATE ON public.appeal_channels FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint
INSERT INTO public.appeal_channels (code, label_key, sort_order) VALUES
  ('in_app', 'enum.appeal_channels.in_app', 10),
  ('public_otp', 'enum.appeal_channels.public_otp', 20);
--> statement-breakpoint

CREATE TABLE public.appeal_queues (
  code text NOT NULL, label_key text NOT NULL, sort_order integer NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT appeal_queues_pk PRIMARY KEY (code), CONSTRAINT appeal_queues_code_ck CHECK (code ~ '^[a-z][a-z0-9_]*$')
);
--> statement-breakpoint
CREATE TRIGGER appeal_queues_set_updated_at BEFORE UPDATE ON public.appeal_queues FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint
INSERT INTO public.appeal_queues (code, label_key, sort_order) VALUES
  ('tenant_admin', 'enum.appeal_queues.tenant_admin', 10),
  ('platform', 'enum.appeal_queues.platform', 20);
--> statement-breakpoint

CREATE TABLE public.appeal_statuses (
  code text NOT NULL, label_key text NOT NULL, sort_order integer NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT appeal_statuses_pk PRIMARY KEY (code), CONSTRAINT appeal_statuses_code_ck CHECK (code ~ '^[a-z][a-z0-9_]*$')
);
--> statement-breakpoint
CREATE TRIGGER appeal_statuses_set_updated_at BEFORE UPDATE ON public.appeal_statuses FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint
INSERT INTO public.appeal_statuses (code, label_key, sort_order) VALUES
  ('submitted', 'enum.appeal_statuses.submitted', 10),
  ('in_review', 'enum.appeal_statuses.in_review', 20),
  ('escalated', 'enum.appeal_statuses.escalated', 30),
  ('upheld', 'enum.appeal_statuses.upheld', 40),
  ('granted', 'enum.appeal_statuses.granted', 50),
  ('reduced', 'enum.appeal_statuses.reduced', 60),
  ('withdrawn', 'enum.appeal_statuses.withdrawn', 70);
--> statement-breakpoint

-- moderation_action_types: spec §12 groups this under "Content", but no
-- Content-domain table (0005) actually references it — moderation_actions
-- below is the first and only user, so it's created here instead.
CREATE TABLE public.moderation_action_types (
  code text NOT NULL, label_key text NOT NULL, sort_order integer NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT moderation_action_types_pk PRIMARY KEY (code), CONSTRAINT moderation_action_types_code_ck CHECK (code ~ '^[a-z][a-z0-9_]*$')
);
--> statement-breakpoint
CREATE TRIGGER moderation_action_types_set_updated_at BEFORE UPDATE ON public.moderation_action_types FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint
INSERT INTO public.moderation_action_types (code, label_key, sort_order) VALUES
  ('removed', 'enum.moderation_action_types.removed', 10),
  ('restored', 'enum.moderation_action_types.restored', 20),
  ('moderator_removed', 'enum.moderation_action_types.moderator_removed', 30),
  ('legal_hold_placed', 'enum.moderation_action_types.legal_hold_placed', 40),
  ('legal_hold_cleared', 'enum.moderation_action_types.legal_hold_cleared', 50),
  ('privacy_scrub', 'enum.moderation_action_types.privacy_scrub', 60),
  ('spam_auto_deleted', 'enum.moderation_action_types.spam_auto_deleted', 70);
--> statement-breakpoint

-- Extending moderation_reasons (0005) with the codes §9.11 needs.
-- moderation_reasons already has FORCE ROW LEVEL SECURITY from 0005, and
-- its write policy requires is_platform_admin() — ae_migrator owns the
-- table but FORCE means even the owner is subject to that policy, so this
-- session-local flag is needed for this one INSERT (transaction-scoped;
-- clears itself at commit, same trick usable anywhere a later migration
-- needs to extend an already-RLS'd enum table).
SELECT set_config('app.is_platform_admin', 'true', true);
--> statement-breakpoint
INSERT INTO public.moderation_reasons (code, label_key, sort_order) VALUES
  ('illegal_content', 'enum.moderation_reasons.illegal_content', 100),
  ('doxxing', 'enum.moderation_reasons.doxxing', 110),
  ('csam', 'enum.moderation_reasons.csam', 120),
  ('credible_threat', 'enum.moderation_reasons.credible_threat', 130),
  ('privacy_request', 'enum.moderation_reasons.privacy_request', 140),
  ('law_enforcement_request', 'enum.moderation_reasons.law_enforcement_request', 150);

-- ============================================================================
-- reviews (§9.1): TENANT-SCOPED
-- ============================================================================

CREATE TABLE public.reviews (
  id                          uuid        NOT NULL DEFAULT public.uuid_generate_v7(),
  tenant_id                   uuid        NOT NULL DEFAULT public.current_tenant_id(),
  reviewer_member_id          uuid        NOT NULL,
  store_id                    uuid,
  place_id                    uuid,
  seller_member_id            uuid,
  post_id                     uuid,
  rating                      smallint    NOT NULL,
  body                        text,
  has_verified_interaction    boolean     NOT NULL DEFAULT false,
  status_code                 text        NOT NULL DEFAULT 'published',
  moderated_by_user_id        uuid,
  moderated_at                timestamptz,
  moderation_reason_code      text,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now(),
  deleted_at                  timestamptz,
  CONSTRAINT reviews_pk PRIMARY KEY (id),
  CONSTRAINT reviews_tenant_id_reviewer_member_id_fk FOREIGN KEY (tenant_id, reviewer_member_id)
    REFERENCES public.tenant_members (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT reviews_tenant_id_store_id_fk FOREIGN KEY (tenant_id, store_id)
    REFERENCES public.stores (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT reviews_tenant_id_place_id_fk FOREIGN KEY (tenant_id, place_id)
    REFERENCES public.places (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT reviews_tenant_id_seller_member_id_fk FOREIGN KEY (tenant_id, seller_member_id)
    REFERENCES public.tenant_members (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT reviews_tenant_id_post_id_fk FOREIGN KEY (tenant_id, post_id)
    REFERENCES public.posts (tenant_id, id) ON DELETE SET NULL (post_id),
  CONSTRAINT reviews_moderated_by_user_id_fk FOREIGN KEY (moderated_by_user_id)
    REFERENCES public.users (id) ON DELETE SET NULL,
  CONSTRAINT reviews_status_code_fk FOREIGN KEY (status_code)
    REFERENCES public.review_statuses (code) ON DELETE RESTRICT,
  CONSTRAINT reviews_moderation_reason_code_fk FOREIGN KEY (moderation_reason_code)
    REFERENCES public.moderation_reasons (code) ON DELETE RESTRICT,
  CONSTRAINT reviews_rating_ck CHECK (rating BETWEEN 1 AND 5),
  CONSTRAINT reviews_target_ck CHECK (num_nonnulls(store_id, place_id, seller_member_id) = 1),
  CONSTRAINT reviews_not_self_ck CHECK (seller_member_id IS DISTINCT FROM reviewer_member_id),
  -- Composite-FK target (§0.4).
  CONSTRAINT reviews_tenant_id_id_uq UNIQUE (tenant_id, id)
);
--> statement-breakpoint
-- One review per reviewer per target.
CREATE UNIQUE INDEX reviews_tenant_reviewer_store_uq ON public.reviews (tenant_id, reviewer_member_id, store_id)
  WHERE store_id IS NOT NULL AND deleted_at IS NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX reviews_tenant_reviewer_place_uq ON public.reviews (tenant_id, reviewer_member_id, place_id)
  WHERE place_id IS NOT NULL AND deleted_at IS NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX reviews_tenant_reviewer_seller_uq ON public.reviews (tenant_id, reviewer_member_id, seller_member_id)
  WHERE seller_member_id IS NOT NULL AND deleted_at IS NULL;
--> statement-breakpoint
-- Store/place/seller review lists.
CREATE INDEX reviews_tenant_store_published_idx ON public.reviews (tenant_id, store_id, id DESC)
  WHERE status_code = 'published';
--> statement-breakpoint
CREATE INDEX reviews_tenant_place_published_idx ON public.reviews (tenant_id, place_id, id DESC)
  WHERE status_code = 'published';
--> statement-breakpoint
CREATE INDEX reviews_tenant_seller_published_idx ON public.reviews (tenant_id, seller_member_id, id DESC)
  WHERE status_code = 'published';
--> statement-breakpoint
CREATE TRIGGER reviews_set_updated_at BEFORE UPDATE ON public.reviews
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint

-- ============================================================================
-- review_responses (§9.2): TENANT-SCOPED
-- ============================================================================

CREATE TABLE public.review_responses (
  id                     uuid        NOT NULL DEFAULT public.uuid_generate_v7(),
  tenant_id              uuid        NOT NULL DEFAULT public.current_tenant_id(),
  review_id              uuid        NOT NULL,
  responder_member_id    uuid        NOT NULL,
  body                   text        NOT NULL,
  status_code            text        NOT NULL DEFAULT 'published',
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  deleted_at             timestamptz,
  CONSTRAINT review_responses_pk PRIMARY KEY (id),
  CONSTRAINT review_responses_tenant_id_review_id_fk FOREIGN KEY (tenant_id, review_id)
    REFERENCES public.reviews (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT review_responses_tenant_id_responder_member_id_fk FOREIGN KEY (tenant_id, responder_member_id)
    REFERENCES public.tenant_members (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT review_responses_status_code_fk FOREIGN KEY (status_code)
    REFERENCES public.review_statuses (code) ON DELETE RESTRICT
);
--> statement-breakpoint
-- One response per review.
CREATE UNIQUE INDEX review_responses_tenant_review_uq ON public.review_responses (tenant_id, review_id)
  WHERE deleted_at IS NULL;
--> statement-breakpoint
CREATE TRIGGER review_responses_set_updated_at BEFORE UPDATE ON public.review_responses
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint

-- ============================================================================
-- verification_requests (§9.3): GLOBAL
-- ============================================================================

CREATE TABLE public.verification_requests (
  id                          uuid        NOT NULL DEFAULT public.uuid_generate_v7(),
  user_id                     uuid        NOT NULL,
  type_code                   text        NOT NULL,
  status_code                 text        NOT NULL DEFAULT 'submitted',
  document_number_hash        text,
  document_number_last4       text,
  name_on_document             text,
  date_of_birth                date,
  document_storage_keys        text[]      NOT NULL DEFAULT '{}',
  collected_in_tenant_id       uuid,
  collected_by_user_id         uuid,
  provider_code                text,
  provider_reference           text,
  reviewed_by_user_id          uuid,
  reviewed_at                  timestamptz,
  rejection_reason_code        text,
  expires_at                   timestamptz,
  documents_purged_at          timestamptz,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT verification_requests_pk PRIMARY KEY (id),
  CONSTRAINT verification_requests_user_id_fk FOREIGN KEY (user_id)
    REFERENCES public.users (id) ON DELETE RESTRICT,
  CONSTRAINT verification_requests_type_code_fk FOREIGN KEY (type_code)
    REFERENCES public.verification_types (code) ON DELETE RESTRICT,
  CONSTRAINT verification_requests_status_code_fk FOREIGN KEY (status_code)
    REFERENCES public.verification_statuses (code) ON DELETE RESTRICT,
  CONSTRAINT verification_requests_collected_in_tenant_id_fk FOREIGN KEY (collected_in_tenant_id)
    REFERENCES public.tenants (id) ON DELETE RESTRICT,
  CONSTRAINT verification_requests_collected_by_user_id_fk FOREIGN KEY (collected_by_user_id)
    REFERENCES public.users (id) ON DELETE SET NULL,
  CONSTRAINT verification_requests_reviewed_by_user_id_fk FOREIGN KEY (reviewed_by_user_id)
    REFERENCES public.users (id) ON DELETE SET NULL,
  CONSTRAINT verification_requests_rejection_reason_code_fk FOREIGN KEY (rejection_reason_code)
    REFERENCES public.verification_rejection_reasons (code) ON DELETE RESTRICT
);
--> statement-breakpoint
-- One open request per type.
CREATE UNIQUE INDEX verification_requests_open_uq ON public.verification_requests (user_id, type_code)
  WHERE status_code IN ('submitted', 'in_review');
--> statement-breakpoint
-- Duplicate-identity and blacklist matching.
CREATE INDEX verification_requests_doc_hash_idx ON public.verification_requests (document_number_hash)
  WHERE document_number_hash IS NOT NULL;
--> statement-breakpoint
-- Platform review queue.
CREATE INDEX verification_requests_queue_idx ON public.verification_requests (status_code, id)
  WHERE status_code IN ('submitted', 'in_review');
--> statement-breakpoint
CREATE TRIGGER verification_requests_set_updated_at BEFORE UPDATE ON public.verification_requests
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint

-- ============================================================================
-- business_verifications (§9.4): TENANT-SCOPED
-- ============================================================================

CREATE TABLE public.business_verifications (
  id                          uuid        NOT NULL DEFAULT public.uuid_generate_v7(),
  tenant_id                   uuid        NOT NULL DEFAULT public.current_tenant_id(),
  store_id                    uuid,
  place_id                    uuid,
  type_code                   text        NOT NULL,
  status_code                 text        NOT NULL DEFAULT 'submitted',
  document_number             text,
  issuing_authority            text,
  valid_until                  date,
  agent_visit_id                uuid,  -- FK added with agent_visits (0012)
  submitted_by_member_id       uuid        NOT NULL,
  reviewed_by_user_id          uuid,
  reviewed_at                  timestamptz,
  rejection_reason_code        text,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT business_verifications_pk PRIMARY KEY (id),
  CONSTRAINT business_verifications_tenant_id_store_id_fk FOREIGN KEY (tenant_id, store_id)
    REFERENCES public.stores (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT business_verifications_tenant_id_place_id_fk FOREIGN KEY (tenant_id, place_id)
    REFERENCES public.places (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT business_verifications_type_code_fk FOREIGN KEY (type_code)
    REFERENCES public.business_verification_types (code) ON DELETE RESTRICT,
  CONSTRAINT business_verifications_status_code_fk FOREIGN KEY (status_code)
    REFERENCES public.verification_statuses (code) ON DELETE RESTRICT,
  CONSTRAINT business_verifications_tenant_id_submitted_by_member_id_fk FOREIGN KEY (tenant_id, submitted_by_member_id)
    REFERENCES public.tenant_members (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT business_verifications_reviewed_by_user_id_fk FOREIGN KEY (reviewed_by_user_id)
    REFERENCES public.users (id) ON DELETE SET NULL,
  CONSTRAINT business_verifications_rejection_reason_code_fk FOREIGN KEY (rejection_reason_code)
    REFERENCES public.verification_rejection_reasons (code) ON DELETE RESTRICT,
  CONSTRAINT business_verifications_target_ck CHECK (num_nonnulls(store_id, place_id) = 1)
);
--> statement-breakpoint
-- Review queue.
CREATE INDEX business_verifications_queue_idx ON public.business_verifications (tenant_id, id)
  WHERE status_code IN ('submitted', 'in_review');
--> statement-breakpoint
-- Subject history.
CREATE INDEX business_verifications_tenant_store_idx ON public.business_verifications (tenant_id, store_id);
--> statement-breakpoint
CREATE INDEX business_verifications_tenant_place_idx ON public.business_verifications (tenant_id, place_id);
--> statement-breakpoint
-- Cross-tenant system job: expire verifications and clear stores.is_verified.
CREATE INDEX business_verifications_expiry_idx ON public.business_verifications (status_code, valid_until)
  WHERE status_code = 'approved';
--> statement-breakpoint
CREATE TRIGGER business_verifications_set_updated_at BEFORE UPDATE ON public.business_verifications
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint

-- ============================================================================
-- reports (§9.5): TENANT-SCOPED. lost_found_item_id/notice_id/blood_request_id
-- are deferred (0011 local information); their columns are bare.
-- ============================================================================

CREATE TABLE public.reports (
  id                       uuid        NOT NULL DEFAULT public.uuid_generate_v7(),
  tenant_id                uuid        NOT NULL DEFAULT public.current_tenant_id(),
  reporter_member_id       uuid        NOT NULL,
  post_id                  uuid,
  store_id                 uuid,
  place_id                 uuid,
  reported_member_id       uuid,
  message_id               uuid,
  review_id                uuid,
  lost_found_item_id       uuid,  -- FK added with lost_found (0011)
  notice_id                uuid,  -- FK added with notices (0011)
  blood_request_id         uuid,  -- FK added with blood_requests (0011)
  reason_code              text        NOT NULL,
  details                  text,
  status_code              text        NOT NULL DEFAULT 'open',
  priority                 smallint    NOT NULL DEFAULT 0,
  assigned_to_user_id      uuid,
  resolution_code          text,
  resolution_note          text,
  resolved_at              timestamptz,
  escalated_at             timestamptz,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT reports_pk PRIMARY KEY (id),
  CONSTRAINT reports_tenant_id_reporter_member_id_fk FOREIGN KEY (tenant_id, reporter_member_id)
    REFERENCES public.tenant_members (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT reports_tenant_id_post_id_fk FOREIGN KEY (tenant_id, post_id)
    REFERENCES public.posts (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT reports_tenant_id_store_id_fk FOREIGN KEY (tenant_id, store_id)
    REFERENCES public.stores (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT reports_tenant_id_place_id_fk FOREIGN KEY (tenant_id, place_id)
    REFERENCES public.places (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT reports_tenant_id_reported_member_id_fk FOREIGN KEY (tenant_id, reported_member_id)
    REFERENCES public.tenant_members (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT reports_tenant_id_message_id_fk FOREIGN KEY (tenant_id, message_id)
    REFERENCES public.messages (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT reports_tenant_id_review_id_fk FOREIGN KEY (tenant_id, review_id)
    REFERENCES public.reviews (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT reports_reason_code_fk FOREIGN KEY (reason_code)
    REFERENCES public.report_reasons (code) ON DELETE RESTRICT,
  CONSTRAINT reports_status_code_fk FOREIGN KEY (status_code)
    REFERENCES public.report_statuses (code) ON DELETE RESTRICT,
  CONSTRAINT reports_assigned_to_user_id_fk FOREIGN KEY (assigned_to_user_id)
    REFERENCES public.users (id) ON DELETE SET NULL,
  CONSTRAINT reports_resolution_code_fk FOREIGN KEY (resolution_code)
    REFERENCES public.report_resolutions (code) ON DELETE RESTRICT,
  CONSTRAINT reports_target_ck CHECK (
    num_nonnulls(post_id, store_id, place_id, reported_member_id, message_id, review_id,
                 lost_found_item_id, notice_id, blood_request_id) = 1
  ),
  -- Composite-FK target (§0.4).
  CONSTRAINT reports_tenant_id_id_uq UNIQUE (tenant_id, id)
);
--> statement-breakpoint
-- One open report per reporter per target.
CREATE UNIQUE INDEX reports_open_per_target_uq ON public.reports (
  tenant_id, reporter_member_id,
  coalesce(post_id, store_id, place_id, reported_member_id, message_id, review_id,
           lost_found_item_id, notice_id, blood_request_id)
) WHERE status_code IN ('open', 'in_review');
--> statement-breakpoint
-- Moderation queue.
CREATE INDEX reports_queue_idx ON public.reports (tenant_id, status_code, priority DESC, id)
  WHERE status_code IN ('open', 'in_review');
--> statement-breakpoint
-- Auto-hide threshold and history.
CREATE INDEX reports_tenant_post_idx ON public.reports (tenant_id, post_id) WHERE post_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX reports_tenant_reported_member_idx ON public.reports (tenant_id, reported_member_id)
  WHERE reported_member_id IS NOT NULL;
--> statement-breakpoint
-- Cross-tenant platform trust & safety queue.
CREATE INDEX reports_escalated_idx ON public.reports (escalated_at) WHERE status_code = 'escalated';
--> statement-breakpoint
CREATE TRIGGER reports_set_updated_at BEFORE UPDATE ON public.reports
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint

-- ============================================================================
-- blacklist_entries (§9.6): already exists (0001) — table, indexes, trigger,
-- and grants are already in place. This migration only closes its deferred
-- composite FK to reports, and replaces 0002's temporary "platform only
-- until auth lands" policy with the real RLS below.
-- ============================================================================

-- Composite (source_tenant_id, source_report_id) -> reports (tenant_id, id);
-- MATCH SIMPLE skips the check when either is NULL (platform-originated).
ALTER TABLE public.blacklist_entries
  ADD CONSTRAINT blacklist_entries_source_tenant_id_report_id_fk FOREIGN KEY (source_tenant_id, source_report_id)
    REFERENCES public.reports (tenant_id, id) ON DELETE SET NULL (source_report_id);
--> statement-breakpoint

-- ============================================================================
-- user_trust_scores (§9.7): GLOBAL, 1:1 with users
-- ============================================================================

CREATE TABLE public.user_trust_scores (
  user_id             uuid        NOT NULL,
  score               smallint    NOT NULL,
  band_code           text        NOT NULL,
  components          jsonb       NOT NULL DEFAULT '{}',
  algorithm_version   smallint    NOT NULL,
  computed_at         timestamptz NOT NULL,
  next_recompute_at   timestamptz,
  override_score      smallint,
  override_reason     text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT user_trust_scores_pk PRIMARY KEY (user_id),
  CONSTRAINT user_trust_scores_user_id_fk FOREIGN KEY (user_id)
    REFERENCES public.users (id) ON DELETE CASCADE,
  CONSTRAINT user_trust_scores_band_code_fk FOREIGN KEY (band_code)
    REFERENCES public.trust_bands (code) ON DELETE RESTRICT,
  CONSTRAINT user_trust_scores_score_ck CHECK (score BETWEEN 0 AND 100),
  CONSTRAINT user_trust_scores_components_ck CHECK (jsonb_typeof(components) = 'object'),
  CONSTRAINT user_trust_scores_override_score_ck CHECK (override_score IS NULL OR override_score BETWEEN 0 AND 100),
  CONSTRAINT user_trust_scores_override_reason_ck CHECK ((override_score IS NULL) OR (override_reason IS NOT NULL))
);
--> statement-breakpoint
-- Recompute worker.
CREATE INDEX user_trust_scores_recompute_idx ON public.user_trust_scores (next_recompute_at)
  WHERE next_recompute_at IS NOT NULL;
--> statement-breakpoint
CREATE TRIGGER user_trust_scores_set_updated_at BEFORE UPDATE ON public.user_trust_scores
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint

-- ============================================================================
-- bans (§9.8): TENANT-SCOPED
-- ============================================================================

CREATE TABLE public.bans (
  id                       uuid          NOT NULL DEFAULT public.uuid_generate_v7(),
  tenant_id                uuid          NOT NULL DEFAULT public.current_tenant_id(),
  user_id                  uuid          NOT NULL,
  severity_code            text          NOT NULL,
  reason_code              text          NOT NULL,
  reason_text              text          NOT NULL,
  evidence_refs            jsonb         NOT NULL DEFAULT '[]',
  banned_by_user_id        uuid          NOT NULL,
  is_permanent             boolean       NOT NULL DEFAULT false,
  starts_at                timestamptz   NOT NULL DEFAULT now(),
  expires_at               timestamptz,
  escalation_step          smallint      NOT NULL,
  ladder_override_reason   text,
  previous_ban_id          uuid,
  status_code              text          NOT NULL DEFAULT 'active',
  revoked_at               timestamptz,
  revoked_by_user_id       uuid,
  revoke_reason            text,
  created_at               timestamptz   NOT NULL DEFAULT now(),
  updated_at               timestamptz   NOT NULL DEFAULT now(),
  CONSTRAINT bans_pk PRIMARY KEY (id),
  CONSTRAINT bans_tenant_id_user_id_fk FOREIGN KEY (user_id, tenant_id)
    REFERENCES public.tenant_members (user_id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT bans_banned_by_user_id_fk FOREIGN KEY (banned_by_user_id)
    REFERENCES public.users (id) ON DELETE RESTRICT,
  CONSTRAINT bans_revoked_by_user_id_fk FOREIGN KEY (revoked_by_user_id)
    REFERENCES public.users (id) ON DELETE SET NULL,
  CONSTRAINT bans_tenant_id_previous_ban_id_fk FOREIGN KEY (tenant_id, previous_ban_id)
    REFERENCES public.bans (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT bans_severity_code_fk FOREIGN KEY (severity_code)
    REFERENCES public.ban_severities (code) ON DELETE RESTRICT,
  CONSTRAINT bans_reason_code_fk FOREIGN KEY (reason_code)
    REFERENCES public.ban_reasons (code) ON DELETE RESTRICT,
  CONSTRAINT bans_status_code_fk FOREIGN KEY (status_code)
    REFERENCES public.ban_statuses (code) ON DELETE RESTRICT,
  CONSTRAINT bans_severity_ck CHECK (severity_code IN ('restricted', 'banned')),
  CONSTRAINT bans_reason_text_ck CHECK (btrim(reason_text) <> ''),
  CONSTRAINT bans_evidence_refs_ck CHECK (jsonb_typeof(evidence_refs) = 'array'),
  CONSTRAINT bans_expires_at_ck
    CHECK ((is_permanent AND expires_at IS NULL) OR (NOT is_permanent AND expires_at > starts_at)),
  CONSTRAINT bans_escalation_step_ck CHECK (escalation_step >= 1),
  CONSTRAINT bans_permanent_evidence_ck
    CHECK (NOT is_permanent OR (btrim(reason_text) <> '' AND jsonb_array_length(evidence_refs) >= 1)),
  -- Composite-FK target (§0.4).
  CONSTRAINT bans_tenant_id_id_uq UNIQUE (tenant_id, id)
);
--> statement-breakpoint
-- Request guard, cache recompute; also the tenant_id index.
CREATE INDEX bans_tenant_user_active_idx ON public.bans (tenant_id, user_id) WHERE status_code = 'active';
--> statement-breakpoint
-- Escalation history.
CREATE INDEX bans_tenant_user_idx ON public.bans (tenant_id, user_id, id DESC);
--> statement-breakpoint
-- Cross-tenant system job: expire bans.
CREATE INDEX bans_expiry_idx ON public.bans (status_code, expires_at) WHERE status_code = 'active' AND NOT is_permanent;
--> statement-breakpoint
CREATE TRIGGER bans_set_updated_at BEFORE UPDATE ON public.bans
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint

-- Content columns immutable after insert; only the revoke fields (and
-- status_code moving to 'revoked') may change, and only once.
CREATE OR REPLACE FUNCTION public.bans_prevent_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'bans rows cannot be deleted (revoke instead)'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.status_code = 'revoked' THEN
    RAISE EXCEPTION 'bans: already revoked (id %)', OLD.id
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF row(NEW.id, NEW.tenant_id, NEW.user_id, NEW.severity_code, NEW.reason_code, NEW.reason_text,
         NEW.evidence_refs, NEW.banned_by_user_id, NEW.is_permanent, NEW.starts_at, NEW.expires_at,
         NEW.escalation_step, NEW.ladder_override_reason, NEW.previous_ban_id)
      IS DISTINCT FROM
      row(OLD.id, OLD.tenant_id, OLD.user_id, OLD.severity_code, OLD.reason_code, OLD.reason_text,
         OLD.evidence_refs, OLD.banned_by_user_id, OLD.is_permanent, OLD.starts_at, OLD.expires_at,
         OLD.escalation_step, OLD.ladder_override_reason, OLD.previous_ban_id) THEN
    RAISE EXCEPTION 'bans: only status/revoke fields may change after insert (id %)', OLD.id
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER bans_a_prevent_mutation BEFORE UPDATE OR DELETE ON public.bans
  FOR EACH ROW EXECUTE FUNCTION public.bans_prevent_mutation();
--> statement-breakpoint

-- Cache maintenance: recompute tenant_members.ban_severity_code (the most
-- severe active tenant-level ban for that membership) and write an
-- audit_logs row. Emitting to the outbox is deferred (outbox_events, §11.8,
-- not built yet — see header).
CREATE OR REPLACE FUNCTION public.bans_sync_membership_cache()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  affected_user_id uuid;
  affected_tenant_id uuid;
  new_severity text;
BEGIN
  affected_user_id := coalesce(NEW.user_id, OLD.user_id);
  affected_tenant_id := coalesce(NEW.tenant_id, OLD.tenant_id);

  SELECT b.severity_code INTO new_severity
  FROM public.bans b
  WHERE b.tenant_id = affected_tenant_id AND b.user_id = affected_user_id AND b.status_code = 'active'
  ORDER BY (b.severity_code = 'banned') DESC, b.id DESC
  LIMIT 1;

  UPDATE public.tenant_members
  SET ban_severity_code = new_severity
  WHERE tenant_id = affected_tenant_id AND user_id = affected_user_id;

  INSERT INTO public.audit_logs (tenant_id, actor_role, action, entity_table, entity_id, changes)
  VALUES (
    affected_tenant_id, 'system', 'ban.changed', 'bans', coalesce(NEW.id, OLD.id),
    jsonb_build_object('user_id', affected_user_id, 'new_severity', new_severity)
  );

  RETURN coalesce(NEW, OLD);
END
$$;
--> statement-breakpoint
CREATE TRIGGER bans_b_sync_membership_cache AFTER INSERT OR UPDATE ON public.bans
  FOR EACH ROW EXECUTE FUNCTION public.bans_sync_membership_cache();
--> statement-breakpoint

-- ============================================================================
-- ban_appeals (§9.9): GLOBAL, no tenant_id
-- ============================================================================

CREATE TABLE public.ban_appeals (
  id                          uuid        NOT NULL DEFAULT public.uuid_generate_v7(),
  public_reference            text        NOT NULL,
  user_id                     uuid        NOT NULL,
  ban_id                      uuid,
  blacklist_entry_id          uuid,
  channel_code                text        NOT NULL,
  submitted_phone_e164        text        NOT NULL,
  submitted_at                timestamptz NOT NULL DEFAULT now(),
  submitted_on                date        GENERATED ALWAYS AS (((submitted_at AT TIME ZONE 'Asia/Dhaka'))::date) STORED,
  statement                   text        NOT NULL,
  attachment_storage_keys     text[]      NOT NULL DEFAULT '{}',
  queue_code                  text        NOT NULL,
  status_code                 text        NOT NULL DEFAULT 'submitted',
  escalate_at                 timestamptz,
  escalated_at                timestamptz,
  assigned_to_user_id         uuid,
  decided_by_user_id          uuid,
  decided_at                  timestamptz,
  decision_note               text,
  ip_address                  inet,
  user_agent                  text,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ban_appeals_pk PRIMARY KEY (id),
  CONSTRAINT ban_appeals_user_id_fk FOREIGN KEY (user_id)
    REFERENCES public.users (id) ON DELETE RESTRICT,
  CONSTRAINT ban_appeals_ban_id_fk FOREIGN KEY (ban_id)
    REFERENCES public.bans (id) ON DELETE RESTRICT,
  CONSTRAINT ban_appeals_blacklist_entry_id_fk FOREIGN KEY (blacklist_entry_id)
    REFERENCES public.blacklist_entries (id) ON DELETE RESTRICT,
  CONSTRAINT ban_appeals_assigned_to_user_id_fk FOREIGN KEY (assigned_to_user_id)
    REFERENCES public.users (id) ON DELETE SET NULL,
  CONSTRAINT ban_appeals_decided_by_user_id_fk FOREIGN KEY (decided_by_user_id)
    REFERENCES public.users (id) ON DELETE SET NULL,
  CONSTRAINT ban_appeals_channel_code_fk FOREIGN KEY (channel_code)
    REFERENCES public.appeal_channels (code) ON DELETE RESTRICT,
  CONSTRAINT ban_appeals_queue_code_fk FOREIGN KEY (queue_code)
    REFERENCES public.appeal_queues (code) ON DELETE RESTRICT,
  CONSTRAINT ban_appeals_status_code_fk FOREIGN KEY (status_code)
    REFERENCES public.appeal_statuses (code) ON DELETE RESTRICT,
  CONSTRAINT ban_appeals_target_ck CHECK (num_nonnulls(ban_id, blacklist_entry_id) = 1),
  CONSTRAINT ban_appeals_statement_ck CHECK (btrim(statement) <> ''),
  CONSTRAINT ban_appeals_public_reference_uq UNIQUE (public_reference)
);
--> statement-breakpoint
-- One open appeal per ban / per blacklist entry.
CREATE UNIQUE INDEX ban_appeals_ban_open_uq ON public.ban_appeals (ban_id)
  WHERE status_code IN ('submitted', 'in_review', 'escalated');
--> statement-breakpoint
CREATE UNIQUE INDEX ban_appeals_blacklist_entry_open_uq ON public.ban_appeals (blacklist_entry_id)
  WHERE status_code IN ('submitted', 'in_review', 'escalated');
--> statement-breakpoint
-- Rate-limit lookup (advisory-locked by the deferred submit functions).
CREATE INDEX ban_appeals_rate_limit_idx ON public.ban_appeals (submitted_phone_e164, submitted_on);
--> statement-breakpoint
-- Appeal queues.
CREATE INDEX ban_appeals_queue_idx ON public.ban_appeals (queue_code, status_code, id)
  WHERE status_code IN ('submitted', 'in_review', 'escalated');
--> statement-breakpoint
CREATE INDEX ban_appeals_ban_id_idx ON public.ban_appeals (ban_id) WHERE ban_id IS NOT NULL;
--> statement-breakpoint
-- Cross-tenant system job: auto-escalation.
CREATE INDEX ban_appeals_escalate_idx ON public.ban_appeals (escalate_at)
  WHERE queue_code = 'tenant_admin' AND status_code IN ('submitted', 'in_review');
--> statement-breakpoint
-- Appeal history.
CREATE INDEX ban_appeals_user_idx ON public.ban_appeals (user_id, id DESC);
--> statement-breakpoint
CREATE TRIGGER ban_appeals_set_updated_at BEFORE UPDATE ON public.ban_appeals
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint

-- ============================================================================
-- moderation_actions (§9.11): TENANT-SCOPED, append-only
-- ============================================================================

CREATE TABLE public.moderation_actions (
  id                 uuid        NOT NULL DEFAULT public.uuid_generate_v7(),
  tenant_id          uuid        NOT NULL DEFAULT public.current_tenant_id(),
  post_id            uuid        NOT NULL,
  actor_user_id      uuid,
  action_code        text        NOT NULL,
  reason_code        text        NOT NULL,
  reason_text        text,
  evidence_refs      jsonb       NOT NULL DEFAULT '[]',
  legal_hold_id      uuid,  -- FK added with legal_holds (0012)
  xact_id            xid8        NOT NULL DEFAULT pg_current_xact_id(),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT moderation_actions_pk PRIMARY KEY (id),
  CONSTRAINT moderation_actions_tenant_id_post_id_fk FOREIGN KEY (tenant_id, post_id)
    REFERENCES public.posts (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT moderation_actions_actor_user_id_fk FOREIGN KEY (actor_user_id)
    REFERENCES public.users (id) ON DELETE RESTRICT,
  CONSTRAINT moderation_actions_action_code_fk FOREIGN KEY (action_code)
    REFERENCES public.moderation_action_types (code) ON DELETE RESTRICT,
  CONSTRAINT moderation_actions_reason_code_fk FOREIGN KEY (reason_code)
    REFERENCES public.moderation_reasons (code) ON DELETE RESTRICT,
  CONSTRAINT moderation_actions_actor_required_ck CHECK (actor_user_id IS NOT NULL OR action_code = 'spam_auto_deleted'),
  CONSTRAINT moderation_actions_evidence_refs_ck CHECK (jsonb_typeof(evidence_refs) = 'array'),
  CONSTRAINT moderation_actions_reason_text_ck CHECK (
    action_code NOT IN ('moderator_removed', 'legal_hold_placed', 'legal_hold_cleared', 'privacy_scrub')
    OR (reason_text IS NOT NULL AND btrim(reason_text) <> '')
  ),
  CONSTRAINT moderation_actions_evidence_required_ck CHECK (
    action_code NOT IN ('moderator_removed', 'legal_hold_placed') OR jsonb_array_length(evidence_refs) >= 1
  ),
  CONSTRAINT moderation_actions_legal_hold_id_ck
    CHECK ((action_code IN ('legal_hold_placed', 'legal_hold_cleared')) = (legal_hold_id IS NOT NULL))
);
--> statement-breakpoint
-- Moderation history of a post; also the tenant_id index.
CREATE INDEX moderation_actions_tenant_post_idx ON public.moderation_actions (tenant_id, post_id, id DESC);
--> statement-breakpoint
-- Commit-time check on posts (not built here, see header) would use this.
CREATE INDEX moderation_actions_post_xact_idx ON public.moderation_actions (post_id, xact_id);
--> statement-breakpoint
-- Cross-tenant legal-hold audit trail.
CREATE INDEX moderation_actions_legal_hold_idx ON public.moderation_actions (action_code, id)
  WHERE action_code IN ('legal_hold_placed', 'legal_hold_cleared');
--> statement-breakpoint
-- Review of a moderator's actions.
CREATE INDEX moderation_actions_actor_idx ON public.moderation_actions (actor_user_id, id DESC)
  WHERE actor_user_id IS NOT NULL;
--> statement-breakpoint
CREATE TRIGGER moderation_actions_set_updated_at BEFORE UPDATE ON public.moderation_actions
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint

-- Append-only: no UPDATE or DELETE, for any role.
CREATE OR REPLACE FUNCTION public.moderation_actions_prevent_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'moderation_actions rows are immutable (% blocked)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END
$$;
--> statement-breakpoint
CREATE TRIGGER moderation_actions_a_prevent_mutation BEFORE UPDATE OR DELETE ON public.moderation_actions
  FOR EACH ROW EXECUTE FUNCTION public.moderation_actions_prevent_mutation();
--> statement-breakpoint

-- ============================================================================
-- Helper functions
-- ============================================================================

-- Plain (not SECURITY DEFINER): every table it reads already shows the
-- caller their own rows under that table's own RLS (reviews' own row via
-- T-PUBLIC-READ/own-row policies, can_manage_store(), place_claims' own-
-- claimant visibility) — matches owns_lead_target() (0009).
CREATE OR REPLACE FUNCTION public.owns_review_target(target_review_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public
AS $$
  SELECT
    r.seller_member_id = (SELECT public.current_member_id())
    OR (r.store_id IS NOT NULL AND (SELECT public.can_manage_store(r.store_id)))
    OR (r.place_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM public.place_claims pc
      WHERE pc.place_id = r.place_id
        AND pc.tenant_id = (SELECT public.current_tenant_id())
        AND pc.claimant_member_id = (SELECT public.current_member_id())
        AND pc.status_code = 'approved'
    ))
  FROM public.reviews r
  WHERE r.id = target_review_id AND r.tenant_id = (SELECT public.current_tenant_id())
$$;
--> statement-breakpoint

-- Genuinely needs to bypass RLS: called during signup/login/post-time
-- checks, often with no session role at all (app_role() = 'anon'), which no
-- policy on blacklist_entries grants any access to. Owned by ae_rls_bypass
-- (0009). Returns only the severity code, never the row.
CREATE OR REPLACE FUNCTION public.blacklist_severity(phone text, uid uuid, device_hash text)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT be.severity_code
  FROM public.blacklist_entries be
  JOIN public.blacklist_severities bs ON bs.code = be.severity_code
  WHERE be.status_code = 'active'
    AND (
      (phone IS NOT NULL AND be.phone_e164 = phone)
      OR (uid IS NOT NULL AND be.user_id = uid)
      OR (device_hash IS NOT NULL AND be.device_fingerprint_hash = device_hash)
    )
  ORDER BY bs.sort_order DESC
  LIMIT 1
$$;
--> statement-breakpoint
ALTER FUNCTION public.blacklist_severity(text, uuid, text) OWNER TO ae_rls_bypass;
--> statement-breakpoint

-- Genuinely needs to bypass RLS: staff reading a trust score belonging to
-- someone else (a member of their own tenant). Owned by ae_rls_bypass.
-- Verifies both app_is_staff() and that the target is actually a member of
-- the caller's own tenant, so staff can't read scores of users elsewhere.
CREATE OR REPLACE FUNCTION public.trust_summary(target_user_id uuid)
RETURNS TABLE (score smallint, band_code text, computed_at timestamptz)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT uts.score, uts.band_code, uts.computed_at
  FROM public.user_trust_scores uts
  WHERE uts.user_id = target_user_id
    AND (SELECT public.app_is_staff())
    AND EXISTS (
      SELECT 1 FROM public.tenant_members tm
      WHERE tm.tenant_id = (SELECT public.current_tenant_id()) AND tm.user_id = target_user_id
    )
$$;
--> statement-breakpoint
ALTER FUNCTION public.trust_summary(uuid) OWNER TO ae_rls_bypass;
--> statement-breakpoint

-- Genuinely needs to bypass RLS: bans' own RLS gives the banned user no
-- SELECT path at all (staff/platform only) — by design, so an enforcement
-- guard can't be bypassed by reading around it. Owned by ae_rls_bypass;
-- deliberately excludes reason_text/evidence_refs/banned_by_user_id (spec:
-- "never reason_text or evidence").
CREATE OR REPLACE FUNCTION public.my_active_bans()
RETURNS TABLE (
  id uuid, tenant_id uuid, severity_code text, reason_code text,
  starts_at timestamptz, expires_at timestamptz, is_permanent boolean
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT b.id, b.tenant_id, b.severity_code, b.reason_code, b.starts_at, b.expires_at, b.is_permanent
  FROM public.bans b
  WHERE b.user_id = (SELECT public.current_user_id())
    AND b.status_code = 'active'
$$;
--> statement-breakpoint
ALTER FUNCTION public.my_active_bans() OWNER TO ae_rls_bypass;
--> statement-breakpoint

-- Genuinely needs to bypass RLS: moderation_actions' own RLS is staff/
-- platform only, but an owner needs to see why their own post was
-- actioned — often a post that's no longer publicly visible at all. Owned
-- by ae_rls_bypass; verifies authorship itself (posts may not be visible
-- via posts' own RLS once removed), and only exposes reason_text for
-- removed/restored (spec).
CREATE OR REPLACE FUNCTION public.my_post_moderation_history(target_post_id uuid)
RETURNS TABLE (action_code text, reason_code text, reason_text text, created_at timestamptz)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT
    ma.action_code,
    ma.reason_code,
    CASE WHEN ma.action_code IN ('removed', 'restored') THEN ma.reason_text ELSE NULL END,
    ma.created_at
  FROM public.moderation_actions ma
  WHERE ma.post_id = target_post_id
    AND ma.tenant_id = (SELECT public.current_tenant_id())
    AND EXISTS (
      SELECT 1 FROM public.posts p
      WHERE p.id = target_post_id
        AND p.tenant_id = (SELECT public.current_tenant_id())
        AND p.author_member_id = (SELECT public.current_member_id())
    )
  ORDER BY ma.id DESC
$$;
--> statement-breakpoint
ALTER FUNCTION public.my_post_moderation_history(uuid) OWNER TO ae_rls_bypass;
--> statement-breakpoint

-- BYPASSRLS only bypasses row-level policies — the base table-level GRANT
-- still applies to the SECURITY DEFINER function's owner (see 0009).
GRANT SELECT ON public.blacklist_entries TO ae_rls_bypass;
--> statement-breakpoint
-- blacklist_severity() also joins this enum table to rank severities.
GRANT SELECT ON public.blacklist_severities TO ae_rls_bypass;
--> statement-breakpoint
GRANT SELECT ON public.user_trust_scores TO ae_rls_bypass;
--> statement-breakpoint
GRANT SELECT ON public.tenant_members TO ae_rls_bypass;
--> statement-breakpoint
GRANT SELECT ON public.bans TO ae_rls_bypass;
--> statement-breakpoint
GRANT SELECT ON public.moderation_actions TO ae_rls_bypass;
--> statement-breakpoint
GRANT SELECT ON public.posts TO ae_rls_bypass;
--> statement-breakpoint

GRANT EXECUTE ON FUNCTION public.owns_review_target(uuid) TO ae_app;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.blacklist_severity(text, uuid, text) TO ae_app;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.trust_summary(uuid) TO ae_app;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.my_active_bans() TO ae_app;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.my_post_moderation_history(uuid) TO ae_app;


-- ============================================================================
-- RLS: enable + force on every table created in this migration
-- ============================================================================

DO $$
DECLARE
  obj record;
BEGIN
  FOR obj IN
    SELECT c.oid::regclass AS ident
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind = 'r'
      AND c.relname IN (
        'review_statuses', 'verification_types', 'verification_statuses', 'verification_rejection_reasons',
        'business_verification_types', 'report_reasons', 'report_statuses', 'report_resolutions', 'trust_bands',
        'ban_reasons', 'ban_statuses', 'appeal_channels', 'appeal_queues', 'appeal_statuses', 'moderation_action_types',
        'reviews', 'review_responses', 'verification_requests', 'business_verifications', 'reports',
        'blacklist_entries', 'user_trust_scores', 'bans', 'ban_appeals', 'moderation_actions'
      )
  LOOP
    EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', obj.ident);
    EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', obj.ident);
  END LOOP;
END
$$;
--> statement-breakpoint

-- ---- enum tables: read by all, write by platform admin (as 0002-0009) ----

DO $$
DECLARE
  enum_table text;
BEGIN
  FOREACH enum_table IN ARRAY ARRAY[
    'review_statuses', 'verification_types', 'verification_statuses', 'verification_rejection_reasons',
    'business_verification_types', 'report_reasons', 'report_statuses', 'report_resolutions', 'trust_bands',
    'ban_reasons', 'ban_statuses', 'appeal_channels', 'appeal_queues', 'appeal_statuses', 'moderation_action_types'
  ]
  LOOP
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR SELECT USING (true)',
      enum_table || '_read_all', enum_table
    );
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR ALL USING ((SELECT public.is_platform_admin())) WITH CHECK ((SELECT public.is_platform_admin()))',
      enum_table || '_platform_admin', enum_table
    );
  END LOOP;
END
$$;
--> statement-breakpoint

-- ---- reviews: T-PUBLIC-READ (published); reviewer own; staff moderate (§9.1)

CREATE POLICY reviews_public_read ON public.reviews
  FOR SELECT USING (tenant_id = (SELECT public.current_tenant_id()) AND status_code = 'published');
--> statement-breakpoint
CREATE POLICY reviews_reviewer_insert ON public.reviews
  FOR INSERT
  WITH CHECK (tenant_id = (SELECT public.current_tenant_id()) AND reviewer_member_id = (SELECT public.current_member_id()));
--> statement-breakpoint
CREATE POLICY reviews_reviewer_update ON public.reviews
  FOR UPDATE
  USING (tenant_id = (SELECT public.current_tenant_id()) AND reviewer_member_id = (SELECT public.current_member_id()))
  WITH CHECK (tenant_id = (SELECT public.current_tenant_id()) AND reviewer_member_id = (SELECT public.current_member_id()));
--> statement-breakpoint
CREATE POLICY reviews_staff_moderate ON public.reviews
  FOR ALL
  USING (tenant_id = (SELECT public.current_tenant_id()) AND (SELECT public.app_is_staff()))
  WITH CHECK (tenant_id = (SELECT public.current_tenant_id()) AND (SELECT public.app_is_staff()));
--> statement-breakpoint
CREATE POLICY reviews_platform_admin ON public.reviews
  FOR ALL USING ((SELECT public.is_platform_admin())) WITH CHECK ((SELECT public.is_platform_admin()));
--> statement-breakpoint

-- ---- review_responses: T-PUBLIC-READ (published); target owner; staff (§9.2)

CREATE POLICY review_responses_public_read ON public.review_responses
  FOR SELECT USING (tenant_id = (SELECT public.current_tenant_id()) AND status_code = 'published');
--> statement-breakpoint
CREATE POLICY review_responses_owner_write ON public.review_responses
  FOR ALL
  USING (
    tenant_id = (SELECT public.current_tenant_id())
    AND responder_member_id = (SELECT public.current_member_id())
    AND (SELECT public.owns_review_target(review_id))
  )
  WITH CHECK (
    tenant_id = (SELECT public.current_tenant_id())
    AND responder_member_id = (SELECT public.current_member_id())
    AND (SELECT public.owns_review_target(review_id))
  );
--> statement-breakpoint
CREATE POLICY review_responses_staff_moderate ON public.review_responses
  FOR ALL
  USING (tenant_id = (SELECT public.current_tenant_id()) AND (SELECT public.app_is_staff()))
  WITH CHECK (tenant_id = (SELECT public.current_tenant_id()) AND (SELECT public.app_is_staff()));
--> statement-breakpoint
CREATE POLICY review_responses_platform_admin ON public.review_responses
  FOR ALL USING ((SELECT public.is_platform_admin())) WITH CHECK ((SELECT public.is_platform_admin()));
--> statement-breakpoint

-- ---- verification_requests: G-OWNER SELECT/INSERT; platform reviews; no tenant role (§9.3)

CREATE POLICY verification_requests_owner_read ON public.verification_requests
  FOR SELECT USING (user_id = (SELECT public.current_user_id()));
--> statement-breakpoint
CREATE POLICY verification_requests_owner_insert ON public.verification_requests
  FOR INSERT WITH CHECK (user_id = (SELECT public.current_user_id()));
--> statement-breakpoint
CREATE POLICY verification_requests_platform_read ON public.verification_requests
  FOR SELECT USING ((SELECT public.app_is_platform()) OR (SELECT public.app_is_system()));
--> statement-breakpoint
CREATE POLICY verification_requests_platform_review ON public.verification_requests
  FOR UPDATE USING ((SELECT public.is_platform_admin())) WITH CHECK ((SELECT public.is_platform_admin()));
--> statement-breakpoint

-- ---- business_verifications: T-ISOLATE; submitter/managers/staff read (§9.4)

CREATE POLICY business_verifications_submitter_read ON public.business_verifications
  FOR SELECT
  USING (tenant_id = (SELECT public.current_tenant_id()) AND submitted_by_member_id = (SELECT public.current_member_id()));
--> statement-breakpoint
CREATE POLICY business_verifications_manager_read ON public.business_verifications
  FOR SELECT
  USING (
    tenant_id = (SELECT public.current_tenant_id())
    AND (
      (store_id IS NOT NULL AND (SELECT public.can_manage_store(store_id)))
      OR (place_id IS NOT NULL AND EXISTS (
        SELECT 1 FROM public.place_claims pc
        WHERE pc.place_id = business_verifications.place_id
          AND pc.tenant_id = (SELECT public.current_tenant_id())
          AND pc.claimant_member_id = (SELECT public.current_member_id())
          AND pc.status_code = 'approved'
      ))
    )
  );
--> statement-breakpoint
CREATE POLICY business_verifications_staff_read ON public.business_verifications
  FOR SELECT USING (tenant_id = (SELECT public.current_tenant_id()) AND (SELECT public.app_is_staff()));
--> statement-breakpoint
CREATE POLICY business_verifications_manager_insert ON public.business_verifications
  FOR INSERT
  WITH CHECK (
    tenant_id = (SELECT public.current_tenant_id())
    AND submitted_by_member_id = (SELECT public.current_member_id())
    AND (
      (store_id IS NOT NULL AND (SELECT public.can_manage_store(store_id)))
      OR (place_id IS NOT NULL AND EXISTS (
        SELECT 1 FROM public.place_claims pc
        WHERE pc.place_id = business_verifications.place_id
          AND pc.tenant_id = (SELECT public.current_tenant_id())
          AND pc.claimant_member_id = (SELECT public.current_member_id())
          AND pc.status_code = 'approved'
      ))
    )
  );
--> statement-breakpoint
CREATE POLICY business_verifications_staff_review ON public.business_verifications
  FOR UPDATE
  USING (tenant_id = (SELECT public.current_tenant_id()) AND (SELECT public.app_is_staff()))
  WITH CHECK (tenant_id = (SELECT public.current_tenant_id()) AND (SELECT public.app_is_staff()));
--> statement-breakpoint
CREATE POLICY business_verifications_platform_admin ON public.business_verifications
  FOR ALL USING ((SELECT public.is_platform_admin())) WITH CHECK ((SELECT public.is_platform_admin()));
--> statement-breakpoint

-- ---- reports: T-ISOLATE; reporter own; staff all; platform escalated (§9.5)

CREATE POLICY reports_reporter_read ON public.reports
  FOR SELECT
  USING (tenant_id = (SELECT public.current_tenant_id()) AND reporter_member_id = (SELECT public.current_member_id()));
--> statement-breakpoint
CREATE POLICY reports_reporter_insert ON public.reports
  FOR INSERT
  WITH CHECK (tenant_id = (SELECT public.current_tenant_id()) AND reporter_member_id = (SELECT public.current_member_id()));
--> statement-breakpoint
CREATE POLICY reports_staff_all ON public.reports
  FOR ALL
  USING (tenant_id = (SELECT public.current_tenant_id()) AND (SELECT public.app_is_staff()))
  WITH CHECK (tenant_id = (SELECT public.current_tenant_id()) AND (SELECT public.app_is_staff()));
--> statement-breakpoint
CREATE POLICY reports_platform_escalated_read ON public.reports
  FOR SELECT USING ((SELECT public.app_is_platform()) AND status_code = 'escalated');
--> statement-breakpoint
CREATE POLICY reports_platform_admin ON public.reports
  FOR ALL USING ((SELECT public.is_platform_admin())) WITH CHECK ((SELECT public.is_platform_admin()));
--> statement-breakpoint

-- ---- blacklist_entries: custom (§9.6) -------------------------------------
-- Replaces 0002's temporary "platform only until auth lands" policy.

DROP POLICY blacklist_entries_platform_admin ON public.blacklist_entries;
--> statement-breakpoint
CREATE POLICY blacklist_entries_platform_read ON public.blacklist_entries
  FOR SELECT USING ((SELECT public.app_is_platform()) OR (SELECT public.app_is_system()));
--> statement-breakpoint
CREATE POLICY blacklist_entries_staff_active_read ON public.blacklist_entries
  FOR SELECT USING ((SELECT public.app_is_staff()) AND status_code = 'active');
--> statement-breakpoint
CREATE POLICY blacklist_entries_staff_own_recommended_read ON public.blacklist_entries
  FOR SELECT USING ((SELECT public.app_is_staff()) AND source_tenant_id = (SELECT public.current_tenant_id()));
--> statement-breakpoint
CREATE POLICY blacklist_entries_tenant_admin_insert ON public.blacklist_entries
  FOR INSERT
  WITH CHECK (
    (SELECT public.app_is_tenant_admin())
    AND status_code = 'recommended'
    AND source_tenant_id = (SELECT public.current_tenant_id())
    AND reviewed_by_user_id IS NULL
  );
--> statement-breakpoint
CREATE POLICY blacklist_entries_platform_admin_write ON public.blacklist_entries
  FOR UPDATE USING ((SELECT public.is_platform_admin())) WITH CHECK ((SELECT public.is_platform_admin()));
--> statement-breakpoint

-- ---- user_trust_scores: owner + platform/system read; system/platform write (§9.7)

CREATE POLICY user_trust_scores_owner_read ON public.user_trust_scores
  FOR SELECT USING (user_id = (SELECT public.current_user_id()));
--> statement-breakpoint
CREATE POLICY user_trust_scores_platform_read ON public.user_trust_scores
  FOR SELECT USING ((SELECT public.app_is_platform()) OR (SELECT public.app_is_system()));
--> statement-breakpoint
CREATE POLICY user_trust_scores_system_write ON public.user_trust_scores
  FOR ALL
  USING ((SELECT public.app_is_system()) OR (SELECT public.is_platform_admin()))
  WITH CHECK ((SELECT public.app_is_system()) OR (SELECT public.is_platform_admin()));
--> statement-breakpoint

-- ---- bans: T-ISOLATE; staff read; moderator/tenant_admin insert; tenant_admin revoke (§9.8)

CREATE POLICY bans_staff_read ON public.bans
  FOR SELECT USING (tenant_id = (SELECT public.current_tenant_id()) AND (SELECT public.app_is_staff()));
--> statement-breakpoint
CREATE POLICY bans_staff_insert ON public.bans
  FOR INSERT
  WITH CHECK (
    tenant_id = (SELECT public.current_tenant_id())
    AND (SELECT public.app_is_staff())
    AND ((SELECT public.app_is_tenant_admin()) OR NOT is_permanent)
  );
--> statement-breakpoint
CREATE POLICY bans_tenant_admin_revoke ON public.bans
  FOR UPDATE
  USING (tenant_id = (SELECT public.current_tenant_id()) AND (SELECT public.app_is_tenant_admin()))
  WITH CHECK (tenant_id = (SELECT public.current_tenant_id()) AND (SELECT public.app_is_tenant_admin()));
--> statement-breakpoint
CREATE POLICY bans_platform_write ON public.bans
  FOR ALL USING ((SELECT public.is_platform_admin())) WITH CHECK ((SELECT public.is_platform_admin()));
--> statement-breakpoint

-- ---- ban_appeals: custom (§9.9). User-facing submission is deferred (see
-- ---- header) — the system-only insert policy is a structural placeholder.

CREATE POLICY ban_appeals_owner_read ON public.ban_appeals
  FOR SELECT USING (user_id = (SELECT public.current_user_id()));
--> statement-breakpoint
CREATE POLICY ban_appeals_tenant_admin_access ON public.ban_appeals
  FOR ALL
  USING (
    queue_code = 'tenant_admin'
    AND (SELECT public.app_is_tenant_admin())
    AND EXISTS (SELECT 1 FROM public.bans b WHERE b.id = ban_appeals.ban_id)
  )
  WITH CHECK (
    queue_code = 'tenant_admin'
    AND (SELECT public.app_is_tenant_admin())
    AND EXISTS (SELECT 1 FROM public.bans b WHERE b.id = ban_appeals.ban_id)
  );
--> statement-breakpoint
CREATE POLICY ban_appeals_platform_read ON public.ban_appeals
  FOR SELECT USING ((SELECT public.app_is_platform()));
--> statement-breakpoint
CREATE POLICY ban_appeals_platform_decide ON public.ban_appeals
  FOR UPDATE
  USING (queue_code = 'platform' AND (SELECT public.is_platform_admin()))
  WITH CHECK (queue_code = 'platform' AND (SELECT public.is_platform_admin()));
--> statement-breakpoint
CREATE POLICY ban_appeals_system_insert ON public.ban_appeals
  FOR INSERT WITH CHECK ((SELECT public.app_is_system()));
--> statement-breakpoint

-- ---- moderation_actions: T-ISOLATE base; staff/platform read; scoped inserts (§9.11)

CREATE POLICY moderation_actions_staff_read ON public.moderation_actions
  FOR SELECT USING (tenant_id = (SELECT public.current_tenant_id()) AND (SELECT public.app_is_staff()));
--> statement-breakpoint
CREATE POLICY moderation_actions_platform_read ON public.moderation_actions
  FOR SELECT USING ((SELECT public.app_is_platform()));
--> statement-breakpoint
CREATE POLICY moderation_actions_staff_insert ON public.moderation_actions
  FOR INSERT
  WITH CHECK (
    tenant_id = (SELECT public.current_tenant_id())
    AND (SELECT public.app_is_staff())
    AND actor_user_id = (SELECT public.current_user_id())
    AND action_code <> 'legal_hold_cleared'
  );
--> statement-breakpoint
CREATE POLICY moderation_actions_platform_insert ON public.moderation_actions
  FOR INSERT
  WITH CHECK ((SELECT public.app_is_platform()) AND actor_user_id = (SELECT public.current_user_id()));
--> statement-breakpoint
CREATE POLICY moderation_actions_owner_privacy_scrub_insert ON public.moderation_actions
  FOR INSERT
  WITH CHECK (
    tenant_id = (SELECT public.current_tenant_id())
    AND actor_user_id = (SELECT public.current_user_id())
    AND action_code = 'privacy_scrub'
    AND EXISTS (
      SELECT 1 FROM public.posts p
      WHERE p.id = moderation_actions.post_id
        AND p.tenant_id = (SELECT public.current_tenant_id())
        AND p.author_member_id = (SELECT public.current_member_id())
    )
  );
--> statement-breakpoint
CREATE POLICY moderation_actions_system_insert ON public.moderation_actions
  FOR INSERT
  WITH CHECK (
    tenant_id = (SELECT public.current_tenant_id())
    AND actor_user_id IS NULL
    AND action_code = 'spam_auto_deleted'
    AND (SELECT public.app_is_system())
  );
--> statement-breakpoint
CREATE POLICY moderation_actions_legal_hold_cleared_insert ON public.moderation_actions
  FOR INSERT
  WITH CHECK (action_code = 'legal_hold_cleared' AND (SELECT public.is_platform_admin()));


-- ============================================================================
-- Grants
-- ============================================================================

GRANT SELECT ON
  public.review_statuses, public.verification_types, public.verification_statuses,
  public.verification_rejection_reasons, public.business_verification_types, public.report_reasons,
  public.report_statuses, public.report_resolutions, public.trust_bands, public.ban_reasons, public.ban_statuses,
  public.appeal_channels, public.appeal_queues, public.appeal_statuses, public.moderation_action_types
TO ae_app;
--> statement-breakpoint
GRANT INSERT, UPDATE ON
  public.review_statuses, public.verification_types, public.verification_statuses,
  public.verification_rejection_reasons, public.business_verification_types, public.report_reasons,
  public.report_statuses, public.report_resolutions, public.trust_bands, public.ban_reasons, public.ban_statuses,
  public.appeal_channels, public.appeal_queues, public.appeal_statuses, public.moderation_action_types
TO ae_app;
--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE ON public.reviews TO ae_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON public.review_responses TO ae_app;
--> statement-breakpoint
-- UPDATE is for platform review (owner insert-only; "review fields hidden
-- by the API" is enforced at the app layer, RLS has no owner-update policy).
GRANT SELECT, INSERT, UPDATE ON public.verification_requests TO ae_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON public.business_verifications TO ae_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON public.reports TO ae_app;
--> statement-breakpoint
-- No DELETE: none, for any role.
GRANT SELECT, INSERT, UPDATE ON public.blacklist_entries TO ae_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON public.user_trust_scores TO ae_app;
--> statement-breakpoint
-- No DELETE: none.
GRANT SELECT, INSERT, UPDATE ON public.bans TO ae_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON public.ban_appeals TO ae_app;
--> statement-breakpoint
-- No UPDATE/DELETE: append-only, permanent retention.
GRANT SELECT, INSERT ON public.moderation_actions TO ae_app;
