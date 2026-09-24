-- 0009_communication
--
-- Communication domain (docs/specs/schema.md §8): conversations & messages,
-- notification templates/inbox/delivery log, per-user notification
-- preferences, lead events (contact-intent analytics, including call taps —
-- there is no separate call_logs table, Q22) and their daily rollup,
-- cross-tenant user blocks, and saved radius-search alerts. Runs as
-- ae_migrator; RLS and grants are in this same file.
--
-- Two decisions the spec itself flagged as open, resolved before writing
-- this migration:
--   - messages (§8.3, Q15) is a plain table, not partitioned. No message
--     volume exists yet to justify the operational cost of a partition-
--     maintenance job; partition later via a dedicated migration once real
--     traffic warrants it.
--   - is_blocked_between(a, b) needs to see a block in the direction the
--     current session normally can't ("the blocked user has no access") —
--     the same FORCE-ROW-LEVEL-SECURITY-blocks-SECURITY-DEFINER problem
--     already hit in 0003/0006. Fixed at the role level this time instead
--     of working around it per-function: infra/db/bootstrap-roles.sql now
--     creates ae_rls_bypass, a NOLOGIN role with real BYPASSRLS, used only
--     as the owner of this migration's two SECURITY DEFINER helpers
--     (is_blocked_between, is_conversation_participant). Every other role,
--     table and function keeps exactly the restrictions it had before.
--
-- ============================================================================
-- SCOPE — as with 0007/0008: full DDL/CHECKs/indexes/RLS for every table.
-- NOT built here — each is real orchestration, not schema:
--   - staff_open_conversation(conversation_id, report_id): requires a
--     linked `reports` row, and reports doesn't exist until 0010 (Trust).
--     Until then tenant staff have no path into a conversation at all,
--     which is a strict subset of the spec's intended behaviour (Q13's
--     "no blanket read access" baseline holds; only the report-linked
--     exception is missing).
--   - Denormalised sync of conversations.last_message_at/
--     last_message_preview and conversation_participants.unread_count/
--     last_message_at when a message is sent: real fan-out business logic
--     (increment for every other participant, zero for the sender), not a
--     structural safety net.
--   - purge_message_bodies() (the message_body_retention_days job),
--     the lead_events -> lead_daily_stats nightly rollup,
--     the saved_searches instant/daily alert-matching jobs, and the whole
--     "render a template and actually deliver it" notification pipeline.
-- ============================================================================

-- ============================================================================
-- Enum tables
-- ============================================================================

CREATE TABLE public.conversation_kinds (
  code text NOT NULL, label_key text NOT NULL, sort_order integer NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT conversation_kinds_pk PRIMARY KEY (code), CONSTRAINT conversation_kinds_code_ck CHECK (code ~ '^[a-z][a-z0-9_]*$')
);
--> statement-breakpoint
CREATE TRIGGER conversation_kinds_set_updated_at BEFORE UPDATE ON public.conversation_kinds FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint
INSERT INTO public.conversation_kinds (code, label_key, sort_order) VALUES
  ('post_inquiry', 'enum.conversation_kinds.post_inquiry', 10),
  ('store_inquiry', 'enum.conversation_kinds.store_inquiry', 20),
  ('direct', 'enum.conversation_kinds.direct', 30);
--> statement-breakpoint

CREATE TABLE public.participant_roles (
  code text NOT NULL, label_key text NOT NULL, sort_order integer NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT participant_roles_pk PRIMARY KEY (code), CONSTRAINT participant_roles_code_ck CHECK (code ~ '^[a-z][a-z0-9_]*$')
);
--> statement-breakpoint
CREATE TRIGGER participant_roles_set_updated_at BEFORE UPDATE ON public.participant_roles FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint
INSERT INTO public.participant_roles (code, label_key, sort_order) VALUES
  ('buyer', 'enum.participant_roles.buyer', 10),
  ('seller', 'enum.participant_roles.seller', 20),
  ('store_staff', 'enum.participant_roles.store_staff', 30);
--> statement-breakpoint

CREATE TABLE public.message_kinds (
  code text NOT NULL, label_key text NOT NULL, sort_order integer NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT message_kinds_pk PRIMARY KEY (code), CONSTRAINT message_kinds_code_ck CHECK (code ~ '^[a-z][a-z0-9_]*$')
);
--> statement-breakpoint
CREATE TRIGGER message_kinds_set_updated_at BEFORE UPDATE ON public.message_kinds FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint
INSERT INTO public.message_kinds (code, label_key, sort_order) VALUES
  ('text', 'enum.message_kinds.text', 10),
  ('image', 'enum.message_kinds.image', 20),
  ('offer', 'enum.message_kinds.offer', 30),
  ('location', 'enum.message_kinds.location', 40),
  ('listing_card', 'enum.message_kinds.listing_card', 50),
  ('system', 'enum.message_kinds.system', 60);
--> statement-breakpoint

-- Non-exhaustive by design (spec lists these then "…"): more types are
-- seeded by later domains (trust, local info) as those features land.
CREATE TABLE public.notification_types (
  code text NOT NULL, label_key text NOT NULL, sort_order integer NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT notification_types_pk PRIMARY KEY (code), CONSTRAINT notification_types_code_ck CHECK (code ~ '^[a-z][a-z0-9_]*$')
);
--> statement-breakpoint
CREATE TRIGGER notification_types_set_updated_at BEFORE UPDATE ON public.notification_types FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint
INSERT INTO public.notification_types (code, label_key, sort_order) VALUES
  ('new_message', 'enum.notification_types.new_message', 10),
  ('post_approved', 'enum.notification_types.post_approved', 20),
  ('post_rejected', 'enum.notification_types.post_rejected', 30),
  ('boost_expiring', 'enum.notification_types.boost_expiring', 40),
  ('payment_succeeded', 'enum.notification_types.payment_succeeded', 50),
  ('blood_request_nearby', 'enum.notification_types.blood_request_nearby', 60),
  ('notice_published', 'enum.notification_types.notice_published', 70),
  ('saved_search_match', 'enum.notification_types.saved_search_match', 80),
  ('followed_store_new_post', 'enum.notification_types.followed_store_new_post', 90),
  ('ban_issued', 'enum.notification_types.ban_issued', 100),
  ('appeal_decided', 'enum.notification_types.appeal_decided', 110);
--> statement-breakpoint

CREATE TABLE public.notification_channels (
  code text NOT NULL, label_key text NOT NULL, sort_order integer NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT notification_channels_pk PRIMARY KEY (code), CONSTRAINT notification_channels_code_ck CHECK (code ~ '^[a-z][a-z0-9_]*$')
);
--> statement-breakpoint
CREATE TRIGGER notification_channels_set_updated_at BEFORE UPDATE ON public.notification_channels FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint
INSERT INTO public.notification_channels (code, label_key, sort_order) VALUES
  ('push', 'enum.notification_channels.push', 10),
  ('sms', 'enum.notification_channels.sms', 20),
  ('email', 'enum.notification_channels.email', 30),
  ('in_app', 'enum.notification_channels.in_app', 40);
--> statement-breakpoint

CREATE TABLE public.delivery_purposes (
  code text NOT NULL, label_key text NOT NULL, sort_order integer NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT delivery_purposes_pk PRIMARY KEY (code), CONSTRAINT delivery_purposes_code_ck CHECK (code ~ '^[a-z][a-z0-9_]*$')
);
--> statement-breakpoint
CREATE TRIGGER delivery_purposes_set_updated_at BEFORE UPDATE ON public.delivery_purposes FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint
INSERT INTO public.delivery_purposes (code, label_key, sort_order) VALUES
  ('otp', 'enum.delivery_purposes.otp', 10),
  ('appeal_otp', 'enum.delivery_purposes.appeal_otp', 20),
  ('appeal_decision', 'enum.delivery_purposes.appeal_decision', 30),
  ('notification', 'enum.delivery_purposes.notification', 40),
  ('marketing', 'enum.delivery_purposes.marketing', 50);
--> statement-breakpoint

CREATE TABLE public.delivery_statuses (
  code text NOT NULL, label_key text NOT NULL, sort_order integer NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT delivery_statuses_pk PRIMARY KEY (code), CONSTRAINT delivery_statuses_code_ck CHECK (code ~ '^[a-z][a-z0-9_]*$')
);
--> statement-breakpoint
CREATE TRIGGER delivery_statuses_set_updated_at BEFORE UPDATE ON public.delivery_statuses FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint
INSERT INTO public.delivery_statuses (code, label_key, sort_order) VALUES
  ('queued', 'enum.delivery_statuses.queued', 10),
  ('sent', 'enum.delivery_statuses.sent', 20),
  ('delivered', 'enum.delivery_statuses.delivered', 30),
  ('failed', 'enum.delivery_statuses.failed', 40),
  ('undeliverable', 'enum.delivery_statuses.undeliverable', 50);
--> statement-breakpoint

CREATE TABLE public.lead_channels (
  code text NOT NULL, label_key text NOT NULL, sort_order integer NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT lead_channels_pk PRIMARY KEY (code), CONSTRAINT lead_channels_code_ck CHECK (code ~ '^[a-z][a-z0-9_]*$')
);
--> statement-breakpoint
CREATE TRIGGER lead_channels_set_updated_at BEFORE UPDATE ON public.lead_channels FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint
INSERT INTO public.lead_channels (code, label_key, sort_order) VALUES
  ('call_click', 'enum.lead_channels.call_click', 10),
  ('whatsapp_click', 'enum.lead_channels.whatsapp_click', 20),
  ('sms_click', 'enum.lead_channels.sms_click', 30),
  ('phone_revealed', 'enum.lead_channels.phone_revealed', 40),
  ('chat_started', 'enum.lead_channels.chat_started', 50),
  ('directions_click', 'enum.lead_channels.directions_click', 60),
  ('website_click', 'enum.lead_channels.website_click', 70);
--> statement-breakpoint

CREATE TABLE public.lead_sources (
  code text NOT NULL, label_key text NOT NULL, sort_order integer NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT lead_sources_pk PRIMARY KEY (code), CONSTRAINT lead_sources_code_ck CHECK (code ~ '^[a-z][a-z0-9_]*$')
);
--> statement-breakpoint
CREATE TRIGGER lead_sources_set_updated_at BEFORE UPDATE ON public.lead_sources FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint
INSERT INTO public.lead_sources (code, label_key, sort_order) VALUES
  ('post_detail', 'enum.lead_sources.post_detail', 10),
  ('search_result', 'enum.lead_sources.search_result', 20),
  ('store_page', 'enum.lead_sources.store_page', 30),
  ('place_page', 'enum.lead_sources.place_page', 40),
  ('boosted_slot', 'enum.lead_sources.boosted_slot', 50),
  ('ad', 'enum.lead_sources.ad', 60),
  ('blood_donor_list', 'enum.lead_sources.blood_donor_list', 70);
--> statement-breakpoint

CREATE TABLE public.alert_frequencies (
  code text NOT NULL, label_key text NOT NULL, sort_order integer NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT alert_frequencies_pk PRIMARY KEY (code), CONSTRAINT alert_frequencies_code_ck CHECK (code ~ '^[a-z][a-z0-9_]*$')
);
--> statement-breakpoint
CREATE TRIGGER alert_frequencies_set_updated_at BEFORE UPDATE ON public.alert_frequencies FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint
INSERT INTO public.alert_frequencies (code, label_key, sort_order) VALUES
  ('off', 'enum.alert_frequencies.off', 10),
  ('instant', 'enum.alert_frequencies.instant', 20),
  ('daily', 'enum.alert_frequencies.daily', 30);
--> statement-breakpoint

-- ============================================================================
-- conversations (§8.1): TENANT-SCOPED
-- ============================================================================

CREATE TABLE public.conversations (
  id                       uuid        NOT NULL DEFAULT public.uuid_generate_v7(),
  tenant_id                uuid        NOT NULL DEFAULT public.current_tenant_id(),
  kind_code                text        NOT NULL,
  post_id                  uuid,
  store_id                 uuid,
  dedupe_key               text,
  created_by_member_id     uuid        NOT NULL,
  last_message_at          timestamptz,
  last_message_preview     text,
  is_locked                boolean     NOT NULL DEFAULT false,
  post_context_removed     boolean     NOT NULL DEFAULT false,
  locked_reason_code       text,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT conversations_pk PRIMARY KEY (id),
  CONSTRAINT conversations_kind_code_fk FOREIGN KEY (kind_code)
    REFERENCES public.conversation_kinds (code) ON DELETE RESTRICT,
  CONSTRAINT conversations_tenant_id_post_id_fk FOREIGN KEY (tenant_id, post_id)
    REFERENCES public.posts (tenant_id, id) ON DELETE SET NULL (post_id),
  CONSTRAINT conversations_tenant_id_store_id_fk FOREIGN KEY (tenant_id, store_id)
    REFERENCES public.stores (tenant_id, id) ON DELETE SET NULL (store_id),
  CONSTRAINT conversations_tenant_id_created_by_member_id_fk FOREIGN KEY (tenant_id, created_by_member_id)
    REFERENCES public.tenant_members (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT conversations_locked_reason_code_fk FOREIGN KEY (locked_reason_code)
    REFERENCES public.moderation_reasons (code) ON DELETE RESTRICT,
  CONSTRAINT conversations_post_context_removed_ck CHECK (NOT post_context_removed OR post_id IS NULL),
  -- Composite-FK target (§0.4).
  CONSTRAINT conversations_tenant_id_id_uq UNIQUE (tenant_id, id)
);
--> statement-breakpoint
CREATE UNIQUE INDEX conversations_tenant_dedupe_uq ON public.conversations (tenant_id, dedupe_key)
  WHERE dedupe_key IS NOT NULL;
--> statement-breakpoint
-- Seller's "inquiries on this post".
CREATE INDEX conversations_tenant_post_idx ON public.conversations (tenant_id, post_id)
  WHERE post_id IS NOT NULL;
--> statement-breakpoint
CREATE TRIGGER conversations_set_updated_at BEFORE UPDATE ON public.conversations
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint

-- ============================================================================
-- conversation_participants (§8.2): TENANT-SCOPED, join table (§13.2)
-- ============================================================================

CREATE TABLE public.conversation_participants (
  tenant_id            uuid        NOT NULL DEFAULT public.current_tenant_id(),
  conversation_id      uuid        NOT NULL,
  member_id            uuid        NOT NULL,
  role_code            text        NOT NULL,
  last_message_at      timestamptz,
  last_read_at         timestamptz,
  unread_count         integer     NOT NULL DEFAULT 0,
  is_muted             boolean     NOT NULL DEFAULT false,
  is_archived          boolean     NOT NULL DEFAULT false,
  left_at              timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT conversation_participants_pk PRIMARY KEY (tenant_id, conversation_id, member_id),
  CONSTRAINT conversation_participants_tenant_id_conversation_id_fk FOREIGN KEY (tenant_id, conversation_id)
    REFERENCES public.conversations (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT conversation_participants_tenant_id_member_id_fk FOREIGN KEY (tenant_id, member_id)
    REFERENCES public.tenant_members (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT conversation_participants_role_code_fk FOREIGN KEY (role_code)
    REFERENCES public.participant_roles (code) ON DELETE RESTRICT,
  CONSTRAINT conversation_participants_unread_count_ck CHECK (unread_count >= 0)
);
--> statement-breakpoint
-- The inbox.
CREATE INDEX conversation_participants_inbox_idx
  ON public.conversation_participants (tenant_id, member_id, last_message_at DESC)
  WHERE NOT is_archived AND left_at IS NULL;
--> statement-breakpoint
CREATE TRIGGER conversation_participants_set_updated_at BEFORE UPDATE ON public.conversation_participants
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint

-- ============================================================================
-- messages (§8.3): TENANT-SCOPED. Plain table, not partitioned (see header).
-- ============================================================================

CREATE TABLE public.messages (
  id                      uuid          NOT NULL DEFAULT public.uuid_generate_v7(),
  tenant_id               uuid          NOT NULL DEFAULT public.current_tenant_id(),
  conversation_id         uuid          NOT NULL,
  sender_member_id        uuid,
  kind_code               text          NOT NULL DEFAULT 'text',
  body                    text,
  media_asset_id          uuid,
  offer_amount            numeric(12,2),
  location                geography(Point,4326),
  system_event_key        text,
  reply_to_message_id     uuid,
  listing_snapshot        jsonb,
  client_message_id       text          NOT NULL,
  flagged_by_filter       boolean       NOT NULL DEFAULT false,
  edited_at               timestamptz,
  created_at              timestamptz   NOT NULL DEFAULT now(),
  updated_at              timestamptz   NOT NULL DEFAULT now(),
  deleted_at              timestamptz,
  CONSTRAINT messages_pk PRIMARY KEY (id),
  CONSTRAINT messages_tenant_id_conversation_id_fk FOREIGN KEY (tenant_id, conversation_id)
    REFERENCES public.conversations (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT messages_tenant_id_sender_member_id_fk FOREIGN KEY (tenant_id, sender_member_id)
    REFERENCES public.tenant_members (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT messages_tenant_id_media_asset_id_fk FOREIGN KEY (tenant_id, media_asset_id)
    REFERENCES public.media_assets (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT messages_tenant_id_reply_to_message_id_fk FOREIGN KEY (tenant_id, reply_to_message_id)
    REFERENCES public.messages (tenant_id, id) ON DELETE SET NULL (reply_to_message_id),
  CONSTRAINT messages_kind_code_fk FOREIGN KEY (kind_code)
    REFERENCES public.message_kinds (code) ON DELETE RESTRICT,
  CONSTRAINT messages_listing_snapshot_ck CHECK ((kind_code = 'listing_card') = (listing_snapshot IS NOT NULL)),
  CONSTRAINT messages_content_ck CHECK (
    (kind_code = 'system' AND system_event_key IS NOT NULL)
    OR (kind_code <> 'system' AND num_nonnulls(body, media_asset_id, offer_amount, location) >= 1)
  ),
  -- Composite-FK target (§0.4).
  CONSTRAINT messages_tenant_id_id_uq UNIQUE (tenant_id, id)
);
--> statement-breakpoint
-- Idempotent send.
CREATE UNIQUE INDEX messages_send_idempotency_uq
  ON public.messages (tenant_id, conversation_id, sender_member_id, client_message_id);
--> statement-breakpoint
-- Paginate thread newest-first (uuid v7 order = time order).
CREATE INDEX messages_tenant_conversation_idx ON public.messages (tenant_id, conversation_id, id DESC);
--> statement-breakpoint
-- Retention and partition maintenance.
CREATE INDEX messages_created_at_brin_idx ON public.messages USING brin (created_at);
--> statement-breakpoint
-- Audit rule; "messages shared near here" for moderation.
CREATE INDEX messages_location_gix ON public.messages USING gist (location) WHERE location IS NOT NULL;
--> statement-breakpoint
CREATE TRIGGER messages_set_updated_at BEFORE UPDATE ON public.messages
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint

-- ============================================================================
-- notification_templates (§8.4): GLOBAL
-- ============================================================================

CREATE TABLE public.notification_templates (
  id                  uuid        NOT NULL DEFAULT public.uuid_generate_v7(),
  type_code           text        NOT NULL,
  channel_code        text        NOT NULL,
  locale              text        NOT NULL,
  version             integer     NOT NULL DEFAULT 1,
  title_template      text,
  body_template       text        NOT NULL,
  variables           text[]      NOT NULL DEFAULT '{}',
  max_sms_segments    smallint,
  is_active           boolean     NOT NULL DEFAULT true,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT notification_templates_pk PRIMARY KEY (id),
  CONSTRAINT notification_templates_type_code_fk FOREIGN KEY (type_code)
    REFERENCES public.notification_types (code) ON DELETE RESTRICT,
  CONSTRAINT notification_templates_channel_code_fk FOREIGN KEY (channel_code)
    REFERENCES public.notification_channels (code) ON DELETE RESTRICT,
  CONSTRAINT notification_templates_version_ck CHECK (version > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX notification_templates_version_uq
  ON public.notification_templates (type_code, channel_code, locale, version);
--> statement-breakpoint
-- One live template per combination.
CREATE UNIQUE INDEX notification_templates_active_uq
  ON public.notification_templates (type_code, channel_code, locale) WHERE is_active;
--> statement-breakpoint
CREATE TRIGGER notification_templates_set_updated_at BEFORE UPDATE ON public.notification_templates
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint

-- ============================================================================
-- notifications (§8.5): GLOBAL, no tenant_id — a user's inbox spans tenants
-- ============================================================================

CREATE TABLE public.notifications (
  id              uuid        NOT NULL DEFAULT public.uuid_generate_v7(),
  user_id         uuid        NOT NULL,
  type_code       text        NOT NULL,
  params          jsonb       NOT NULL DEFAULT '{}',
  deep_link       text,
  dedupe_key      text,
  entity_id       uuid,
  read_at         timestamptz,
  archived_at     timestamptz,
  expires_at      timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT notifications_pk PRIMARY KEY (id),
  CONSTRAINT notifications_user_id_fk FOREIGN KEY (user_id)
    REFERENCES public.users (id) ON DELETE CASCADE,
  CONSTRAINT notifications_type_code_fk FOREIGN KEY (type_code)
    REFERENCES public.notification_types (code) ON DELETE RESTRICT,
  CONSTRAINT notifications_params_ck CHECK (jsonb_typeof(params) = 'object')
);
--> statement-breakpoint
-- The inbox.
CREATE INDEX notifications_inbox_idx ON public.notifications (user_id, id DESC) WHERE archived_at IS NULL;
--> statement-breakpoint
-- Unread badge count.
CREATE INDEX notifications_unread_idx ON public.notifications (user_id) WHERE read_at IS NULL AND archived_at IS NULL;
--> statement-breakpoint
-- Purge job.
CREATE INDEX notifications_expires_idx ON public.notifications (expires_at) WHERE expires_at IS NOT NULL;
--> statement-breakpoint
-- Idempotent scheduled notices.
CREATE UNIQUE INDEX notifications_dedupe_uq ON public.notifications (user_id, dedupe_key) WHERE dedupe_key IS NOT NULL;
--> statement-breakpoint
CREATE TRIGGER notifications_set_updated_at BEFORE UPDATE ON public.notifications
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint

-- ============================================================================
-- notification_deliveries (§8.6): GLOBAL
-- ============================================================================

CREATE TABLE public.notification_deliveries (
  id                    uuid          NOT NULL DEFAULT public.uuid_generate_v7(),
  notification_id       uuid,
  user_id                uuid,
  billed_tenant_id       uuid,
  purpose_code           text          NOT NULL,
  channel_code           text          NOT NULL,
  recipient_masked       text          NOT NULL,
  provider_code          text          NOT NULL,
  provider_message_id    text,
  status_code            text          NOT NULL DEFAULT 'queued',
  attempt_count          smallint      NOT NULL DEFAULT 0,
  last_error             text,
  sms_segments           smallint,
  cost_amount            numeric(12,2),
  sent_at                timestamptz,
  delivered_at           timestamptz,
  created_at             timestamptz   NOT NULL DEFAULT now(),
  updated_at             timestamptz   NOT NULL DEFAULT now(),
  CONSTRAINT notification_deliveries_pk PRIMARY KEY (id),
  CONSTRAINT notification_deliveries_notification_id_fk FOREIGN KEY (notification_id)
    REFERENCES public.notifications (id) ON DELETE SET NULL,
  CONSTRAINT notification_deliveries_user_id_fk FOREIGN KEY (user_id)
    REFERENCES public.users (id) ON DELETE SET NULL,
  CONSTRAINT notification_deliveries_billed_tenant_id_fk FOREIGN KEY (billed_tenant_id)
    REFERENCES public.tenants (id) ON DELETE RESTRICT,
  CONSTRAINT notification_deliveries_purpose_code_fk FOREIGN KEY (purpose_code)
    REFERENCES public.delivery_purposes (code) ON DELETE RESTRICT,
  CONSTRAINT notification_deliveries_channel_code_fk FOREIGN KEY (channel_code)
    REFERENCES public.notification_channels (code) ON DELETE RESTRICT,
  CONSTRAINT notification_deliveries_status_code_fk FOREIGN KEY (status_code)
    REFERENCES public.delivery_statuses (code) ON DELETE RESTRICT,
  CONSTRAINT notification_deliveries_attempt_count_ck CHECK (attempt_count >= 0)
);
--> statement-breakpoint
-- Match delivery-report callbacks.
CREATE UNIQUE INDEX notification_deliveries_provider_msg_uq
  ON public.notification_deliveries (provider_code, provider_message_id) WHERE provider_message_id IS NOT NULL;
--> statement-breakpoint
-- Monthly SMS cost per tenant.
CREATE INDEX notification_deliveries_tenant_sms_idx
  ON public.notification_deliveries (billed_tenant_id, created_at) WHERE channel_code = 'sms';
--> statement-breakpoint
-- Retry sweeper.
CREATE INDEX notification_deliveries_retry_idx
  ON public.notification_deliveries (status_code, updated_at) WHERE status_code IN ('queued', 'failed');
--> statement-breakpoint
-- OTP rate-limit forensics.
CREATE INDEX notification_deliveries_otp_idx
  ON public.notification_deliveries (user_id, created_at DESC) WHERE purpose_code = 'otp';
--> statement-breakpoint
CREATE TRIGGER notification_deliveries_set_updated_at BEFORE UPDATE ON public.notification_deliveries
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint

-- ============================================================================
-- user_notification_preferences (§8.7): GLOBAL
-- ============================================================================

CREATE TABLE public.user_notification_preferences (
  user_id         uuid        NOT NULL,
  type_code       text        NOT NULL,
  channel_code    text        NOT NULL,
  is_enabled      boolean     NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT user_notification_preferences_pk PRIMARY KEY (user_id, type_code, channel_code),
  CONSTRAINT user_notification_preferences_user_id_fk FOREIGN KEY (user_id)
    REFERENCES public.users (id) ON DELETE CASCADE,
  CONSTRAINT user_notification_preferences_type_code_fk FOREIGN KEY (type_code)
    REFERENCES public.notification_types (code) ON DELETE RESTRICT,
  CONSTRAINT user_notification_preferences_channel_code_fk FOREIGN KEY (channel_code)
    REFERENCES public.notification_channels (code) ON DELETE RESTRICT
);
--> statement-breakpoint
CREATE TRIGGER user_notification_preferences_set_updated_at BEFORE UPDATE ON public.user_notification_preferences
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint

-- ============================================================================
-- user_blocks (§8.10): GLOBAL
-- ============================================================================

CREATE TABLE public.user_blocks (
  id                  uuid        NOT NULL DEFAULT public.uuid_generate_v7(),
  blocker_user_id     uuid        NOT NULL,
  blocked_user_id     uuid        NOT NULL,
  source_tenant_id    uuid,
  note                text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT user_blocks_pk PRIMARY KEY (id),
  CONSTRAINT user_blocks_blocker_user_id_fk FOREIGN KEY (blocker_user_id)
    REFERENCES public.users (id) ON DELETE CASCADE,
  CONSTRAINT user_blocks_blocked_user_id_fk FOREIGN KEY (blocked_user_id)
    REFERENCES public.users (id) ON DELETE CASCADE,
  CONSTRAINT user_blocks_source_tenant_id_fk FOREIGN KEY (source_tenant_id)
    REFERENCES public.tenants (id) ON DELETE RESTRICT,
  CONSTRAINT user_blocks_distinct_ck CHECK (blocker_user_id <> blocked_user_id),
  CONSTRAINT user_blocks_pair_uq UNIQUE (blocker_user_id, blocked_user_id)
);
--> statement-breakpoint
-- Reverse-direction lookup for is_blocked_between().
CREATE INDEX user_blocks_reverse_idx ON public.user_blocks (blocked_user_id, blocker_user_id);
--> statement-breakpoint
CREATE TRIGGER user_blocks_set_updated_at BEFORE UPDATE ON public.user_blocks
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint

-- ============================================================================
-- lead_events (§8.8): TENANT-SCOPED
-- ============================================================================

CREATE TABLE public.lead_events (
  id                    uuid        NOT NULL DEFAULT public.uuid_generate_v7(),
  tenant_id             uuid        NOT NULL DEFAULT public.current_tenant_id(),
  channel_code          text        NOT NULL,
  source_code           text        NOT NULL,
  post_id               uuid,
  store_id              uuid,
  place_id              uuid,
  target_member_id      uuid,
  actor_member_id       uuid,
  anon_session_hash     text,
  ad_booking_id         uuid,
  boost_id              uuid,
  subject_scrubbed      boolean     NOT NULL DEFAULT false,
  occurred_at           timestamptz NOT NULL DEFAULT now(),
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT lead_events_pk PRIMARY KEY (id),
  CONSTRAINT lead_events_channel_code_fk FOREIGN KEY (channel_code)
    REFERENCES public.lead_channels (code) ON DELETE RESTRICT,
  CONSTRAINT lead_events_source_code_fk FOREIGN KEY (source_code)
    REFERENCES public.lead_sources (code) ON DELETE RESTRICT,
  -- Billing/audit evidence: never nulled by a scrub.
  CONSTRAINT lead_events_tenant_id_post_id_fk FOREIGN KEY (tenant_id, post_id)
    REFERENCES public.posts (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT lead_events_tenant_id_store_id_fk FOREIGN KEY (tenant_id, store_id)
    REFERENCES public.stores (tenant_id, id) ON DELETE SET NULL (store_id),
  CONSTRAINT lead_events_tenant_id_place_id_fk FOREIGN KEY (tenant_id, place_id)
    REFERENCES public.places (tenant_id, id) ON DELETE SET NULL (place_id),
  CONSTRAINT lead_events_tenant_id_target_member_id_fk FOREIGN KEY (tenant_id, target_member_id)
    REFERENCES public.tenant_members (tenant_id, id) ON DELETE SET NULL (target_member_id),
  CONSTRAINT lead_events_tenant_id_actor_member_id_fk FOREIGN KEY (tenant_id, actor_member_id)
    REFERENCES public.tenant_members (tenant_id, id) ON DELETE SET NULL (actor_member_id),
  CONSTRAINT lead_events_tenant_id_ad_booking_id_fk FOREIGN KEY (tenant_id, ad_booking_id)
    REFERENCES public.ad_bookings (tenant_id, id) ON DELETE SET NULL (ad_booking_id),
  CONSTRAINT lead_events_tenant_id_boost_id_fk FOREIGN KEY (tenant_id, boost_id)
    REFERENCES public.boosts (tenant_id, id) ON DELETE SET NULL (boost_id),
  CONSTRAINT lead_events_target_ck CHECK (num_nonnulls(post_id, store_id, place_id, target_member_id) >= 1)
);
--> statement-breakpoint
-- Nightly rollup into lead_daily_stats; retention.
CREATE INDEX lead_events_occurred_at_brin_idx ON public.lead_events USING brin (occurred_at);
--> statement-breakpoint
-- Rate-limit phone scraping.
CREATE INDEX lead_events_phone_revealed_idx ON public.lead_events (tenant_id, target_member_id, occurred_at)
  WHERE channel_code = 'phone_revealed';
--> statement-breakpoint
-- Abuse detection.
CREATE INDEX lead_events_actor_idx ON public.lead_events (tenant_id, actor_member_id, occurred_at)
  WHERE actor_member_id IS NOT NULL;
--> statement-breakpoint
CREATE TRIGGER lead_events_set_updated_at BEFORE UPDATE ON public.lead_events
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint

-- ============================================================================
-- lead_daily_stats (§8.9): TENANT-SCOPED
-- ============================================================================

CREATE TABLE public.lead_daily_stats (
  id                     uuid        NOT NULL DEFAULT public.uuid_generate_v7(),
  tenant_id              uuid        NOT NULL DEFAULT public.current_tenant_id(),
  stat_date              date        NOT NULL,
  post_id                uuid,
  store_id               uuid,
  place_id               uuid,
  channel_code           text        NOT NULL,
  event_count            integer     NOT NULL DEFAULT 0,
  subject_scrubbed       boolean     NOT NULL DEFAULT false,
  unique_actor_count     integer     NOT NULL DEFAULT 0,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT lead_daily_stats_pk PRIMARY KEY (id),
  CONSTRAINT lead_daily_stats_channel_code_fk FOREIGN KEY (channel_code)
    REFERENCES public.lead_channels (code) ON DELETE RESTRICT,
  -- Lead/call history survives its subject (§13.31).
  CONSTRAINT lead_daily_stats_tenant_id_post_id_fk FOREIGN KEY (tenant_id, post_id)
    REFERENCES public.posts (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT lead_daily_stats_tenant_id_store_id_fk FOREIGN KEY (tenant_id, store_id)
    REFERENCES public.stores (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT lead_daily_stats_tenant_id_place_id_fk FOREIGN KEY (tenant_id, place_id)
    REFERENCES public.places (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT lead_daily_stats_target_ck CHECK (num_nonnulls(post_id, store_id, place_id) = 1),
  CONSTRAINT lead_daily_stats_event_count_ck CHECK (event_count >= 0),
  CONSTRAINT lead_daily_stats_unique_actor_count_ck CHECK (unique_actor_count >= 0)
);
--> statement-breakpoint
-- Idempotent upsert (PG15+ syntax so NULLs count as equal for the unmatched columns).
CREATE UNIQUE INDEX lead_daily_stats_upsert_uq ON public.lead_daily_stats
  (tenant_id, stat_date, post_id, store_id, place_id, channel_code) NULLS NOT DISTINCT;
--> statement-breakpoint
-- Owner dashboard range queries.
CREATE INDEX lead_daily_stats_store_range_idx ON public.lead_daily_stats (tenant_id, store_id, stat_date)
  WHERE store_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX lead_daily_stats_post_range_idx ON public.lead_daily_stats (tenant_id, post_id, stat_date)
  WHERE post_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX lead_daily_stats_place_range_idx ON public.lead_daily_stats (tenant_id, place_id, stat_date)
  WHERE place_id IS NOT NULL;
--> statement-breakpoint
CREATE TRIGGER lead_daily_stats_set_updated_at BEFORE UPDATE ON public.lead_daily_stats
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint

-- ============================================================================
-- saved_searches (§8.11): GLOBAL
-- ============================================================================

CREATE TABLE public.saved_searches (
  id                        uuid          NOT NULL DEFAULT public.uuid_generate_v7(),
  user_id                   uuid          NOT NULL,
  name                      text          NOT NULL,
  query_text                text,
  category_id               uuid,
  filters                   jsonb         NOT NULL DEFAULT '{}',
  price_min                 numeric(12,2),
  price_max                 numeric(12,2),
  center                    geography(Point,4326) NOT NULL,
  radius_km                 numeric(5,2)  NOT NULL DEFAULT 10,
  alert_frequency_code      text          NOT NULL DEFAULT 'daily',
  last_alerted_at           timestamptz,
  last_matched_post_id      uuid,
  is_active                 boolean       NOT NULL DEFAULT true,
  last_engaged_at           timestamptz,
  paused_at                 timestamptz,
  created_at                timestamptz   NOT NULL DEFAULT now(),
  updated_at                timestamptz   NOT NULL DEFAULT now(),
  deleted_at                timestamptz,
  CONSTRAINT saved_searches_pk PRIMARY KEY (id),
  CONSTRAINT saved_searches_user_id_fk FOREIGN KEY (user_id)
    REFERENCES public.users (id) ON DELETE CASCADE,
  CONSTRAINT saved_searches_category_id_fk FOREIGN KEY (category_id)
    REFERENCES public.categories (id) ON DELETE SET NULL,
  CONSTRAINT saved_searches_alert_frequency_code_fk FOREIGN KEY (alert_frequency_code)
    REFERENCES public.alert_frequencies (code) ON DELETE RESTRICT,
  CONSTRAINT saved_searches_filters_ck CHECK (jsonb_typeof(filters) = 'object'),
  CONSTRAINT saved_searches_price_max_ck CHECK (price_max IS NULL OR price_min IS NULL OR price_max >= price_min),
  CONSTRAINT saved_searches_radius_km_ck CHECK (radius_km BETWEEN 0.5 AND 50)
);
--> statement-breakpoint
-- "My saved searches".
CREATE INDEX saved_searches_user_idx ON public.saved_searches (user_id, id DESC) WHERE deleted_at IS NULL;
--> statement-breakpoint
-- Instant-alert matching: ST_DWithin(center, post.location, 50km) then filter by each row's own radius_km.
CREATE INDEX saved_searches_center_gix ON public.saved_searches USING gist (center)
  WHERE is_active AND alert_frequency_code = 'instant' AND deleted_at IS NULL;
--> statement-breakpoint
-- Daily digest job.
CREATE INDEX saved_searches_daily_digest_idx ON public.saved_searches (alert_frequency_code, last_alerted_at)
  WHERE is_active AND paused_at IS NULL AND alert_frequency_code = 'daily';
--> statement-breakpoint
-- Auto-pause job.
CREATE INDEX saved_searches_auto_pause_idx ON public.saved_searches (last_engaged_at)
  WHERE is_active AND paused_at IS NULL;
--> statement-breakpoint
CREATE TRIGGER saved_searches_set_updated_at BEFORE UPDATE ON public.saved_searches
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint

-- ============================================================================
-- Helper functions
-- ============================================================================

-- Genuinely needs to bypass RLS: called from conversations'/messages' own
-- policies to check conversation_participants, and conversation_participants'
-- own SELECT policy calls it too (to show the whole roster, not just the
-- caller's row) — a plain function would recurse into conversation_
-- participants' own policy. Owned by ae_rls_bypass (real BYPASSRLS), so the
-- inner query never re-triggers any policy at all. See header.
CREATE OR REPLACE FUNCTION public.is_conversation_participant(target_conversation_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.conversation_participants cp
    WHERE cp.conversation_id = target_conversation_id
      AND cp.tenant_id = (SELECT public.current_tenant_id())
      AND cp.member_id = (SELECT public.current_member_id())
      AND cp.left_at IS NULL
  )
$$;
--> statement-breakpoint
ALTER FUNCTION public.is_conversation_participant(uuid) OWNER TO ae_rls_bypass;
--> statement-breakpoint

-- Genuinely needs to bypass RLS: the caller must be able to detect a block
-- in the direction they can't normally see (user_blocks' own RLS shows the
-- blocker only their own rows — "the blocked user has no access", by
-- design). Owned by ae_rls_bypass; see header.
CREATE OR REPLACE FUNCTION public.is_blocked_between(user_a uuid, user_b uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.user_blocks
    WHERE (blocker_user_id = user_a AND blocked_user_id = user_b)
       OR (blocker_user_id = user_b AND blocked_user_id = user_a)
  )
$$;
--> statement-breakpoint
ALTER FUNCTION public.is_blocked_between(uuid, uuid) OWNER TO ae_rls_bypass;
--> statement-breakpoint

-- Plain (not SECURITY DEFINER): every table it reads already shows the
-- caller their own authorship/management/claim rows under that table's own
-- RLS (posts' own-post visibility, can_manage_store(), place_claims' own-
-- claimant visibility), so no bypass is needed — matches the can_manage_
-- store()/can_view_invoice() precedent from 0006/0007.
CREATE OR REPLACE FUNCTION public.owns_lead_target(target_post_id uuid, target_store_id uuid, target_place_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public
AS $$
  SELECT
    (target_post_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM public.posts p
      WHERE p.id = target_post_id
        AND p.tenant_id = (SELECT public.current_tenant_id())
        AND p.author_member_id = (SELECT public.current_member_id())
    ))
    OR (target_store_id IS NOT NULL AND (SELECT public.can_manage_store(target_store_id)))
    OR (target_place_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM public.place_claims pc
      WHERE pc.place_id = target_place_id
        AND pc.tenant_id = (SELECT public.current_tenant_id())
        AND pc.claimant_member_id = (SELECT public.current_member_id())
        AND pc.status_code = 'approved'
    ))
$$;
--> statement-breakpoint

-- BYPASSRLS only bypasses row-level *policies* — the base table-level GRANT
-- still applies to whichever role is actually executing the query, which
-- for a SECURITY DEFINER function is its owner (ae_rls_bypass), not the
-- caller. Without these, is_conversation_participant()/is_blocked_between()
-- fail with "permission denied for table ..." the moment they're called.
GRANT SELECT ON public.conversation_participants TO ae_rls_bypass;
--> statement-breakpoint
GRANT SELECT ON public.user_blocks TO ae_rls_bypass;
--> statement-breakpoint

GRANT EXECUTE ON FUNCTION public.is_conversation_participant(uuid) TO ae_app;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.is_blocked_between(uuid, uuid) TO ae_app;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.owns_lead_target(uuid, uuid, uuid) TO ae_app;


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
        'conversation_kinds', 'participant_roles', 'message_kinds', 'notification_types',
        'notification_channels', 'delivery_purposes', 'delivery_statuses', 'lead_channels',
        'lead_sources', 'alert_frequencies',
        'conversations', 'conversation_participants', 'messages', 'notification_templates',
        'notifications', 'notification_deliveries', 'user_notification_preferences',
        'user_blocks', 'lead_events', 'lead_daily_stats', 'saved_searches'
      )
  LOOP
    EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', obj.ident);
    EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', obj.ident);
  END LOOP;
END
$$;
--> statement-breakpoint

-- ---- enum tables: read by all, write by platform admin (as 0002-0008) ----

DO $$
DECLARE
  enum_table text;
BEGIN
  FOREACH enum_table IN ARRAY ARRAY[
    'conversation_kinds', 'participant_roles', 'message_kinds', 'notification_types',
    'notification_channels', 'delivery_purposes', 'delivery_statuses', 'lead_channels',
    'lead_sources', 'alert_frequencies'
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

-- ---- conversations: participants only; staff lock; no blanket staff read (Q13)

CREATE POLICY conversations_participant_read ON public.conversations
  FOR SELECT USING ((SELECT public.is_conversation_participant(id)));
--> statement-breakpoint
CREATE POLICY conversations_creator_insert ON public.conversations
  FOR INSERT
  WITH CHECK (
    tenant_id = (SELECT public.current_tenant_id())
    AND created_by_member_id = (SELECT public.current_member_id())
    AND (SELECT public.app_is_active_user())
  );
--> statement-breakpoint
CREATE POLICY conversations_staff_lock ON public.conversations
  FOR UPDATE
  USING (tenant_id = (SELECT public.current_tenant_id()) AND (SELECT public.app_is_staff()))
  WITH CHECK (tenant_id = (SELECT public.current_tenant_id()) AND (SELECT public.app_is_staff()));
--> statement-breakpoint
CREATE POLICY conversations_platform_admin ON public.conversations
  FOR ALL USING ((SELECT public.is_platform_admin())) WITH CHECK ((SELECT public.is_platform_admin()));
--> statement-breakpoint

-- ---- conversation_participants: roster read; own-row update; service writes

CREATE POLICY conversation_participants_roster_read ON public.conversation_participants
  FOR SELECT USING ((SELECT public.is_conversation_participant(conversation_id)));
--> statement-breakpoint
CREATE POLICY conversation_participants_own_update ON public.conversation_participants
  FOR UPDATE
  USING (tenant_id = (SELECT public.current_tenant_id()) AND member_id = (SELECT public.current_member_id()))
  WITH CHECK (tenant_id = (SELECT public.current_tenant_id()) AND member_id = (SELECT public.current_member_id()));
--> statement-breakpoint
CREATE POLICY conversation_participants_system_write ON public.conversation_participants
  FOR ALL
  USING ((SELECT public.app_is_system()))
  WITH CHECK ((SELECT public.app_is_system()));
--> statement-breakpoint
CREATE POLICY conversation_participants_platform_admin ON public.conversation_participants
  FOR ALL USING ((SELECT public.is_platform_admin())) WITH CHECK ((SELECT public.is_platform_admin()));
--> statement-breakpoint

-- ---- messages: participants read (deleted hidden from non-senders); sender
-- ---- writes (insert own, edit/soft-delete own); system inserts system msgs

CREATE POLICY messages_participant_read ON public.messages
  FOR SELECT
  USING (
    (SELECT public.is_conversation_participant(conversation_id))
    AND (deleted_at IS NULL OR sender_member_id = (SELECT public.current_member_id()))
  );
--> statement-breakpoint
CREATE POLICY messages_sender_insert ON public.messages
  FOR INSERT
  WITH CHECK (
    tenant_id = (SELECT public.current_tenant_id())
    AND sender_member_id = (SELECT public.current_member_id())
    AND (SELECT public.is_conversation_participant(conversation_id))
    AND NOT EXISTS (
      SELECT 1 FROM public.conversations c
      WHERE c.tenant_id = messages.tenant_id AND c.id = messages.conversation_id AND c.is_locked
    )
    AND NOT EXISTS (
      SELECT 1
      FROM public.conversation_participants cp
      JOIN public.tenant_members sender_tm
        ON sender_tm.tenant_id = messages.tenant_id AND sender_tm.id = messages.sender_member_id
      JOIN public.tenant_members other_tm
        ON other_tm.tenant_id = messages.tenant_id AND other_tm.id = cp.member_id
      WHERE cp.tenant_id = messages.tenant_id
        AND cp.conversation_id = messages.conversation_id
        AND cp.member_id <> messages.sender_member_id
        AND (SELECT public.is_blocked_between(sender_tm.user_id, other_tm.user_id))
    )
  );
--> statement-breakpoint
CREATE POLICY messages_system_insert ON public.messages
  FOR INSERT
  WITH CHECK (
    tenant_id = (SELECT public.current_tenant_id())
    AND sender_member_id IS NULL
    AND (SELECT public.app_is_system())
  );
--> statement-breakpoint
-- Edit/soft-delete: sender only. The "within a time window" narrowing (spec:
-- "service") isn't enforced here, same caveat as 0007/0008's column-level
-- narrowing notes.
CREATE POLICY messages_sender_update ON public.messages
  FOR UPDATE
  USING (tenant_id = (SELECT public.current_tenant_id()) AND sender_member_id = (SELECT public.current_member_id()))
  WITH CHECK (tenant_id = (SELECT public.current_tenant_id()) AND sender_member_id = (SELECT public.current_member_id()));
--> statement-breakpoint
CREATE POLICY messages_platform_admin ON public.messages
  FOR ALL USING ((SELECT public.is_platform_admin())) WITH CHECK ((SELECT public.is_platform_admin()));
--> statement-breakpoint

-- ---- notification_templates: platform/system read only, not client data (§8.4)

CREATE POLICY notification_templates_platform_read ON public.notification_templates
  FOR SELECT USING ((SELECT public.app_is_platform()) OR (SELECT public.app_is_system()));
--> statement-breakpoint
CREATE POLICY notification_templates_platform_admin ON public.notification_templates
  FOR ALL USING ((SELECT public.is_platform_admin())) WITH CHECK ((SELECT public.is_platform_admin()));
--> statement-breakpoint

-- ---- notifications: G-OWNER; system inserts (§8.5) -----------------------

CREATE POLICY notifications_owner_read ON public.notifications
  FOR SELECT USING (user_id = (SELECT public.current_user_id()));
--> statement-breakpoint
CREATE POLICY notifications_owner_update ON public.notifications
  FOR UPDATE
  USING (user_id = (SELECT public.current_user_id()))
  WITH CHECK (user_id = (SELECT public.current_user_id()));
--> statement-breakpoint
CREATE POLICY notifications_system_insert ON public.notifications
  FOR INSERT WITH CHECK ((SELECT public.app_is_system()));
--> statement-breakpoint
CREATE POLICY notifications_platform_admin ON public.notifications
  FOR ALL USING ((SELECT public.is_platform_admin())) WITH CHECK ((SELECT public.is_platform_admin()));
--> statement-breakpoint

-- ---- notification_deliveries: system-only (§8.6) --------------------------

CREATE POLICY notification_deliveries_system_only ON public.notification_deliveries
  FOR ALL
  USING ((SELECT public.app_is_system()))
  WITH CHECK ((SELECT public.app_is_system()));
--> statement-breakpoint

-- ---- user_notification_preferences: G-OWNER (§8.7) ------------------------

CREATE POLICY user_notification_preferences_owner ON public.user_notification_preferences
  FOR ALL
  USING (user_id = (SELECT public.current_user_id()))
  WITH CHECK (user_id = (SELECT public.current_user_id()));
--> statement-breakpoint

-- ---- user_blocks: G-OWNER on blocker; blocked user has no access; platform/system read (§8.10)

CREATE POLICY user_blocks_owner ON public.user_blocks
  FOR ALL
  USING (blocker_user_id = (SELECT public.current_user_id()))
  WITH CHECK (blocker_user_id = (SELECT public.current_user_id()));
--> statement-breakpoint
CREATE POLICY user_blocks_platform_read ON public.user_blocks
  FOR SELECT USING ((SELECT public.app_is_platform()) OR (SELECT public.app_is_system()));
--> statement-breakpoint

-- ---- lead_events: anyone in the tenant inserts; platform/system + staff (not scrubbed) read (§8.8)

CREATE POLICY lead_events_insert_anyone ON public.lead_events
  FOR INSERT WITH CHECK (tenant_id = (SELECT public.current_tenant_id()));
--> statement-breakpoint
CREATE POLICY lead_events_platform_read ON public.lead_events
  FOR SELECT USING ((SELECT public.app_is_platform()) OR (SELECT public.app_is_system()));
--> statement-breakpoint
CREATE POLICY lead_events_staff_read ON public.lead_events
  FOR SELECT
  USING (
    tenant_id = (SELECT public.current_tenant_id())
    AND (SELECT public.app_is_staff())
    AND NOT subject_scrubbed
  );
--> statement-breakpoint
-- The scrub job flips subject_scrubbed; system only.
CREATE POLICY lead_events_system_update ON public.lead_events
  FOR UPDATE
  USING ((SELECT public.app_is_system()))
  WITH CHECK ((SELECT public.app_is_system()));
--> statement-breakpoint

-- ---- lead_daily_stats: T-ISOLATE; owner/staff read (not scrubbed); system writes (§8.9)

CREATE POLICY lead_daily_stats_owner_read ON public.lead_daily_stats
  FOR SELECT
  USING (
    tenant_id = (SELECT public.current_tenant_id())
    AND NOT subject_scrubbed
    AND (SELECT public.owns_lead_target(post_id, store_id, place_id))
  );
--> statement-breakpoint
CREATE POLICY lead_daily_stats_staff_read ON public.lead_daily_stats
  FOR SELECT
  USING (
    tenant_id = (SELECT public.current_tenant_id())
    AND NOT subject_scrubbed
    AND (SELECT public.app_is_staff())
  );
--> statement-breakpoint
CREATE POLICY lead_daily_stats_system_write ON public.lead_daily_stats
  FOR ALL
  USING ((SELECT public.app_is_system()))
  WITH CHECK ((SELECT public.app_is_system()));
--> statement-breakpoint
CREATE POLICY lead_daily_stats_platform_admin ON public.lead_daily_stats
  FOR ALL USING ((SELECT public.is_platform_admin())) WITH CHECK ((SELECT public.is_platform_admin()));
--> statement-breakpoint

-- ---- saved_searches: G-OWNER; matching job runs as system (§8.11) --------

CREATE POLICY saved_searches_owner ON public.saved_searches
  FOR ALL
  USING (user_id = (SELECT public.current_user_id()))
  WITH CHECK (user_id = (SELECT public.current_user_id()));
--> statement-breakpoint
CREATE POLICY saved_searches_system ON public.saved_searches
  FOR ALL
  USING ((SELECT public.app_is_system()))
  WITH CHECK ((SELECT public.app_is_system()));


-- ============================================================================
-- Grants
-- ============================================================================

GRANT SELECT ON
  public.conversation_kinds, public.participant_roles, public.message_kinds, public.notification_types,
  public.notification_channels, public.delivery_purposes, public.delivery_statuses, public.lead_channels,
  public.lead_sources, public.alert_frequencies
TO ae_app;
--> statement-breakpoint
GRANT INSERT, UPDATE ON
  public.conversation_kinds, public.participant_roles, public.message_kinds, public.notification_types,
  public.notification_channels, public.delivery_purposes, public.delivery_statuses, public.lead_channels,
  public.lead_sources, public.alert_frequencies
TO ae_app;
--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE ON public.conversations TO ae_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON public.conversation_participants TO ae_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON public.messages TO ae_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON public.notification_templates TO ae_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON public.notifications TO ae_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON public.notification_deliveries TO ae_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON public.user_notification_preferences TO ae_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON public.user_blocks TO ae_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON public.lead_events TO ae_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON public.lead_daily_stats TO ae_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON public.saved_searches TO ae_app;
