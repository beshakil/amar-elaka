-- 0054_chat
--
-- Chat (ADR 058): what the API needs on top of the 0009 chat schema
-- (conversations, conversation_participants, messages, user_blocks), which
-- already enforces participants-only reads, idempotent sends
-- (messages_send_idempotency_uq) and "no message across a block" in RLS.
--
--   conversations        + origin_source_code (lead_sources): where the buyer
--                          opened it, for the chat lead's source.
--                        + first_seller_reply_at: set once, by the first
--                          seller-side reply — that reply is the chat lead.
--   conversation_participants
--                        + last_delivered_message_id, last_read_message_id:
--                          per-participant watermarks (uuid v7 = time order).
--                          A message's sent / delivered / read state is its id
--                          against the other participants' watermarks: one row
--                          update per receipt instead of one per message.
--   messages             CHANGED messages_content_ck: a listing_card carries
--                          only its listing_snapshot (a body with the title
--                          would survive a scrub). Constraint replaced, no
--                          column touched.
--                        + index on media_asset_id (the participant media read
--                          and the orphan sweep look messages up by asset).
--                        + index on listing_snapshot->>'postId'.
--   posts                + trigger posts_scrub_listing_cards: a scrub replaces
--                          EVERY listing card of the post with the neutral
--                          marker, also cards shared in other conversations
--                          (a store's product card in a store conversation);
--                          scrub_post (0032) only covers the post's own
--                          conversations. Q46, ADR 006.
--   reports              + conversation_id target. CHANGED reports_target_ck and
--                          reports_open_per_target_uq (dropped and recreated
--                          with the new target; no column dropped).
--   moderation_actions   + conversation_id target. CHANGED
--                          moderation_actions_one_target_ck (same).
--   conversation_report_snapshots
--                        NEW, TENANT-SCOPED. The transcript a conversation
--                          report attaches as evidence; staff-only, append-only.
--   store_quick_replies  NEW, TENANT-SCOPED. A store's canned replies, for its
--                          owner and managers.
--   media_assets         + RLS media_assets_chat_participant_read: a chat_image
--                          is readable by the conversation's participants.
--   media_kinds          + chat_image (private bucket).
--   moderation_action_types + conversation_locked; moderation_reasons + harassment.
--   store_members        + trigger store_members_sync_chat: an accepted manager
--                          joins (and a removed one leaves) the store's
--                          conversations as store_staff.
--   functions            conversation_tenant_of, open_conversation,
--                          my_conversations, claim_first_seller_reply,
--                          report_conversation, decide_conversation_report,
--                          messages_sync_conversation (trigger).
--   settings             chat_* (see the end).
--
-- No backfill: existing conversations (none in production) keep null
-- watermarks and a null origin source (the lead then falls back to
-- post_detail / store_page).
-- Tests: apps/api/test/chat.db-spec.ts, rls-chat.db-spec.ts, chat.e2e-spec.ts.

SELECT set_config('app.is_platform_admin', 'true', true);
--> statement-breakpoint

-- ============================================================================
-- Lookups
-- ============================================================================

INSERT INTO public.media_kinds (code, label_key, sort_order) VALUES
  ('chat_image', 'enum.media_kinds.chat_image', 50);
--> statement-breakpoint
INSERT INTO public.moderation_action_types (code, label_key, sort_order) VALUES
  ('conversation_locked', 'enum.moderation_action_types.conversation_locked', 260);
--> statement-breakpoint
INSERT INTO public.moderation_reasons (code, label_key, sort_order) VALUES
  ('harassment', 'enum.moderation_reasons.harassment', 300);
--> statement-breakpoint

-- ============================================================================
-- conversations, conversation_participants
-- ============================================================================

ALTER TABLE public.conversations
  ADD COLUMN origin_source_code text,
  ADD COLUMN first_seller_reply_at timestamptz,
  ADD CONSTRAINT conversations_origin_source_code_fk FOREIGN KEY (origin_source_code)
    REFERENCES public.lead_sources (code) ON DELETE RESTRICT;
--> statement-breakpoint
-- A store's conversations (its staff sync, the store's inbox).
CREATE INDEX conversations_tenant_store_idx ON public.conversations (tenant_id, store_id)
  WHERE store_id IS NOT NULL;
--> statement-breakpoint

ALTER TABLE public.conversation_participants
  ADD COLUMN last_delivered_message_id uuid,
  ADD COLUMN last_read_message_id uuid,
  ADD CONSTRAINT conversation_participants_tenant_id_last_delivered_message_id_fk
    FOREIGN KEY (tenant_id, last_delivered_message_id)
    REFERENCES public.messages (tenant_id, id) ON DELETE SET NULL (last_delivered_message_id),
  ADD CONSTRAINT conversation_participants_tenant_id_last_read_message_id_fk
    FOREIGN KEY (tenant_id, last_read_message_id)
    REFERENCES public.messages (tenant_id, id) ON DELETE SET NULL (last_read_message_id);
--> statement-breakpoint

-- ============================================================================
-- messages
-- ============================================================================

ALTER TABLE public.messages DROP CONSTRAINT messages_content_ck;
--> statement-breakpoint
ALTER TABLE public.messages ADD CONSTRAINT messages_content_ck CHECK (
  (kind_code = 'system' AND system_event_key IS NOT NULL)
  OR (kind_code = 'listing_card' AND listing_snapshot IS NOT NULL)
  OR (kind_code NOT IN ('system', 'listing_card') AND num_nonnulls(body, media_asset_id, offer_amount, location) >= 1)
);
--> statement-breakpoint
CREATE INDEX messages_tenant_media_asset_idx ON public.messages (tenant_id, media_asset_id)
  WHERE media_asset_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX messages_listing_post_idx ON public.messages ((listing_snapshot ->> 'postId'))
  WHERE kind_code = 'listing_card';
--> statement-breakpoint

-- Keeps the conversation and every participant's row in step with a new
-- message: last activity and preview; one more unread for everyone but the
-- sender; the sender's own watermarks move to it (you have read what you
-- sent); a new message brings an archived conversation back. Watermarks only
-- move forward, so two sends racing each other can't move one back.
-- Owned by ae_rls_bypass: a member may not update other participants' rows.
CREATE OR REPLACE FUNCTION public.messages_sync_conversation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  UPDATE public.conversations c SET
    last_message_at = greatest(coalesce(c.last_message_at, NEW.created_at), NEW.created_at),
    last_message_preview = CASE
      WHEN c.last_message_at IS NULL OR c.last_message_at <= NEW.created_at
        THEN CASE WHEN NEW.kind_code = 'text' THEN NEW.body END
      ELSE c.last_message_preview
    END
  WHERE c.tenant_id = NEW.tenant_id AND c.id = NEW.conversation_id;

  UPDATE public.conversation_participants cp SET
    last_message_at = greatest(coalesce(cp.last_message_at, NEW.created_at), NEW.created_at),
    unread_count = CASE
      WHEN cp.member_id IS NOT DISTINCT FROM NEW.sender_member_id THEN cp.unread_count
      ELSE cp.unread_count + 1
    END,
    last_read_message_id = CASE
      WHEN cp.member_id = NEW.sender_member_id
        AND (cp.last_read_message_id IS NULL OR cp.last_read_message_id < NEW.id) THEN NEW.id
      ELSE cp.last_read_message_id
    END,
    last_delivered_message_id = CASE
      WHEN cp.member_id = NEW.sender_member_id
        AND (cp.last_delivered_message_id IS NULL OR cp.last_delivered_message_id < NEW.id) THEN NEW.id
      ELSE cp.last_delivered_message_id
    END,
    last_read_at = CASE WHEN cp.member_id = NEW.sender_member_id THEN NEW.created_at ELSE cp.last_read_at END,
    is_archived = false
  WHERE cp.tenant_id = NEW.tenant_id AND cp.conversation_id = NEW.conversation_id AND cp.left_at IS NULL;
  RETURN NULL;
END
$$;
--> statement-breakpoint
ALTER FUNCTION public.messages_sync_conversation() OWNER TO ae_rls_bypass;
--> statement-breakpoint
CREATE TRIGGER messages_sync_conversation AFTER INSERT ON public.messages
  FOR EACH ROW EXECUTE FUNCTION public.messages_sync_conversation();
--> statement-breakpoint

-- Q46 (ADR 006): a scrubbed post leaves no listing card anywhere, whatever
-- conversation it was shared in. scrub_post (0032) is the only scrub path
-- and it sets scrubbed_at, so this sees every scrub; the legal-hold check is
-- scrub_post's own (a held post never gets here).
CREATE OR REPLACE FUNCTION public.posts_scrub_listing_cards()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  UPDATE public.messages m SET listing_snapshot = '{"state": "listing_removed"}'::jsonb
  WHERE m.kind_code = 'listing_card'
    AND m.listing_snapshot ->> 'postId' = NEW.id::text;
  RETURN NULL;
END
$$;
--> statement-breakpoint
ALTER FUNCTION public.posts_scrub_listing_cards() OWNER TO ae_rls_bypass;
--> statement-breakpoint
CREATE TRIGGER posts_scrub_listing_cards AFTER UPDATE OF scrubbed_at ON public.posts
  FOR EACH ROW
  WHEN (OLD.scrubbed_at IS NULL AND NEW.scrubbed_at IS NOT NULL)
  EXECUTE FUNCTION public.posts_scrub_listing_cards();
--> statement-breakpoint

-- ============================================================================
-- reports and moderation_actions: a conversation target
-- ============================================================================

ALTER TABLE public.reports
  ADD COLUMN conversation_id uuid,
  ADD CONSTRAINT reports_tenant_id_conversation_id_fk FOREIGN KEY (tenant_id, conversation_id)
    REFERENCES public.conversations (tenant_id, id) ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE public.reports DROP CONSTRAINT reports_target_ck;
--> statement-breakpoint
ALTER TABLE public.reports ADD CONSTRAINT reports_target_ck CHECK (
  num_nonnulls(post_id, store_id, place_id, reported_member_id, message_id, review_id,
               lost_found_item_id, notice_id, blood_request_id, conversation_id) = 1
);
--> statement-breakpoint
DROP INDEX public.reports_open_per_target_uq;
--> statement-breakpoint
-- One open report per reporter per target (0010), now with conversations.
CREATE UNIQUE INDEX reports_open_per_target_uq ON public.reports (
  tenant_id, reporter_member_id,
  coalesce(post_id, store_id, place_id, reported_member_id, message_id, review_id,
           lost_found_item_id, notice_id, blood_request_id, conversation_id)
) WHERE status_code IN ('open', 'in_review');
--> statement-breakpoint
-- The chat report queue.
CREATE INDEX reports_conversation_queue_idx ON public.reports (tenant_id, status_code, id)
  WHERE conversation_id IS NOT NULL;
--> statement-breakpoint

ALTER TABLE public.moderation_actions
  ADD COLUMN conversation_id uuid,
  ADD CONSTRAINT moderation_actions_tenant_id_conversation_id_fk FOREIGN KEY (tenant_id, conversation_id)
    REFERENCES public.conversations (tenant_id, id) ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE public.moderation_actions DROP CONSTRAINT moderation_actions_one_target_ck;
--> statement-breakpoint
ALTER TABLE public.moderation_actions
  ADD CONSTRAINT moderation_actions_one_target_ck
    CHECK (num_nonnulls(post_id, place_id, place_claim_id, store_id, conversation_id) = 1);
--> statement-breakpoint
CREATE INDEX moderation_actions_tenant_conversation_idx
  ON public.moderation_actions (tenant_id, conversation_id, id DESC)
  WHERE conversation_id IS NOT NULL;
--> statement-breakpoint

-- ============================================================================
-- conversation_report_snapshots: TENANT-SCOPED, append-only evidence
-- ============================================================================

CREATE TABLE public.conversation_report_snapshots (
  id                uuid        NOT NULL DEFAULT public.uuid_generate_v7(),
  tenant_id         uuid        NOT NULL DEFAULT public.current_tenant_id(),
  report_id         uuid        NOT NULL,
  conversation_id   uuid        NOT NULL,
  -- Oldest first: [{id, senderMemberId, senderRole, kind, body, mediaAssetId,
  -- location, listing, systemEvent, flaggedByFilter, createdAt, deletedAt}].
  -- Messages the sender deleted are kept: they are the evidence.
  transcript        jsonb       NOT NULL,
  message_count     integer     NOT NULL,
  captured_at       timestamptz NOT NULL DEFAULT now(),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT conversation_report_snapshots_pk PRIMARY KEY (id),
  CONSTRAINT conversation_report_snapshots_tenant_id_fk FOREIGN KEY (tenant_id)
    REFERENCES public.tenants (id) ON DELETE RESTRICT,
  CONSTRAINT conversation_report_snapshots_tenant_id_report_id_fk FOREIGN KEY (tenant_id, report_id)
    REFERENCES public.reports (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT conversation_report_snapshots_tenant_id_conversation_id_fk FOREIGN KEY (tenant_id, conversation_id)
    REFERENCES public.conversations (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT conversation_report_snapshots_report_uq UNIQUE (report_id),
  CONSTRAINT conversation_report_snapshots_transcript_ck CHECK (jsonb_typeof(transcript) = 'array'),
  CONSTRAINT conversation_report_snapshots_message_count_ck CHECK (message_count >= 0)
);
--> statement-breakpoint
CREATE TRIGGER conversation_report_snapshots_set_updated_at BEFORE UPDATE ON public.conversation_report_snapshots
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint

-- ============================================================================
-- store_quick_replies: TENANT-SCOPED
-- ============================================================================

-- How many and how long are settings (chat_quick_replies_per_store_max,
-- chat_quick_reply_max_length), enforced by the API under a per-store lock.
CREATE TABLE public.store_quick_replies (
  id                    uuid        NOT NULL DEFAULT public.uuid_generate_v7(),
  tenant_id             uuid        NOT NULL DEFAULT public.current_tenant_id(),
  store_id              uuid        NOT NULL,
  body                  text        NOT NULL,
  sort_order            integer     NOT NULL DEFAULT 0,
  created_by_member_id  uuid        NOT NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT store_quick_replies_pk PRIMARY KEY (id),
  CONSTRAINT store_quick_replies_tenant_id_fk FOREIGN KEY (tenant_id)
    REFERENCES public.tenants (id) ON DELETE RESTRICT,
  CONSTRAINT store_quick_replies_tenant_id_store_id_fk FOREIGN KEY (tenant_id, store_id)
    REFERENCES public.stores (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT store_quick_replies_tenant_id_created_by_member_id_fk FOREIGN KEY (tenant_id, created_by_member_id)
    REFERENCES public.tenant_members (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT store_quick_replies_body_ck CHECK (btrim(body) <> ''),
  CONSTRAINT store_quick_replies_tenant_id_id_uq UNIQUE (tenant_id, id)
);
--> statement-breakpoint
CREATE INDEX store_quick_replies_store_idx ON public.store_quick_replies (tenant_id, store_id, sort_order, id);
--> statement-breakpoint
CREATE TRIGGER store_quick_replies_set_updated_at BEFORE UPDATE ON public.store_quick_replies
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint

-- ============================================================================
-- RLS
-- ============================================================================

ALTER TABLE public.conversation_report_snapshots ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.conversation_report_snapshots FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.store_quick_replies ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.store_quick_replies FORCE ROW LEVEL SECURITY;
--> statement-breakpoint

-- Staff read the evidence of their own tenant only; written only by
-- report_conversation(); nobody updates or deletes it (no grant).
CREATE POLICY conversation_report_snapshots_staff_read ON public.conversation_report_snapshots
  FOR SELECT USING (tenant_id = (SELECT public.current_tenant_id()) AND (SELECT public.app_is_staff()));
--> statement-breakpoint
CREATE POLICY conversation_report_snapshots_platform_admin ON public.conversation_report_snapshots
  FOR ALL USING ((SELECT public.is_platform_admin())) WITH CHECK ((SELECT public.is_platform_admin()));
--> statement-breakpoint

-- The store's owner and accepted managers (can_manage_store, 0006) — the
-- people who answer the store's conversations.
CREATE POLICY store_quick_replies_manager ON public.store_quick_replies
  FOR ALL
  USING (tenant_id = (SELECT public.current_tenant_id()) AND public.can_manage_store(store_id))
  WITH CHECK (tenant_id = (SELECT public.current_tenant_id()) AND public.can_manage_store(store_id));
--> statement-breakpoint
CREATE POLICY store_quick_replies_platform_admin ON public.store_quick_replies
  FOR ALL USING ((SELECT public.is_platform_admin())) WITH CHECK ((SELECT public.is_platform_admin()));
--> statement-breakpoint

-- A chat image is private (bucket `documents`); the conversation's
-- participants read its row (for the variant keys) — besides its uploader
-- and staff (media_assets_private_read, 0005).
CREATE POLICY media_assets_chat_participant_read ON public.media_assets
  FOR SELECT
  USING (
    tenant_id = (SELECT public.current_tenant_id())
    AND kind_code = 'chat_image'
    AND status_code = 'ready'
    AND deleted_at IS NULL
    AND EXISTS (
      SELECT 1 FROM public.messages m
      WHERE m.tenant_id = media_assets.tenant_id
        AND m.media_asset_id = media_assets.id
        AND (SELECT public.is_conversation_participant(m.conversation_id))
    )
  );
--> statement-breakpoint

GRANT SELECT ON public.conversation_report_snapshots TO ae_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON public.store_quick_replies TO ae_app;
--> statement-breakpoint

-- What this migration's SECURITY DEFINER functions (owner ae_rls_bypass)
-- touch. BYPASSRLS skips policies, not grants (see 0009).
GRANT SELECT, INSERT, UPDATE ON public.conversations TO ae_rls_bypass;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON public.conversation_participants TO ae_rls_bypass;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON public.messages TO ae_rls_bypass;
--> statement-breakpoint
GRANT SELECT, INSERT ON public.conversation_report_snapshots TO ae_rls_bypass;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON public.reports TO ae_rls_bypass;
--> statement-breakpoint
GRANT SELECT, INSERT ON public.moderation_actions TO ae_rls_bypass;
--> statement-breakpoint
GRANT SELECT, UPDATE ON public.media_assets TO ae_rls_bypass;
--> statement-breakpoint
GRANT SELECT ON public.posts, public.stores, public.store_members, public.tenant_members,
  public.user_profiles, public.user_blocks TO ae_rls_bypass;
--> statement-breakpoint
-- Fix (found by chat.db-spec's Q46 test): scrub_post (owner ae_rls_bypass,
-- 0032) filters the post's photos with media_asset_is_referenced() (0019,
-- invoker rights), which reads ad_creatives — never granted to
-- ae_rls_bypass. The planner may evaluate it on any media row of the
-- tenant before the attachment filter, so a scrub in any tenant holding
-- other media (every real one) failed with "permission denied for table
-- ad_creatives". Read-only, the one table it lacked.
GRANT SELECT ON public.ad_creatives TO ae_rls_bypass;
--> statement-breakpoint

-- ============================================================================
-- Store staff follow the store's conversations
-- ============================================================================

-- An accepted manager answers the store's conversations (store_staff); a
-- manager who is removed, demoted or not yet accepted leaves them. Editors
-- only post as the store (ADR 054), so they never join. A member who is in a
-- conversation in another role (its seller, say) keeps that role.
CREATE OR REPLACE FUNCTION public.store_members_sync_chat()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_was boolean := TG_OP <> 'INSERT' AND OLD.role_code = 'manager' AND OLD.accepted_at IS NOT NULL;
  v_is boolean := TG_OP <> 'DELETE' AND NEW.role_code = 'manager' AND NEW.accepted_at IS NOT NULL;
BEGIN
  IF v_was AND NOT v_is THEN
    UPDATE public.conversation_participants cp SET left_at = now()
    FROM public.conversations c
    WHERE c.tenant_id = OLD.tenant_id AND c.store_id = OLD.store_id
      AND cp.tenant_id = c.tenant_id AND cp.conversation_id = c.id
      AND cp.member_id = OLD.member_id AND cp.role_code = 'store_staff' AND cp.left_at IS NULL;
  ELSIF v_is AND NOT v_was THEN
    INSERT INTO public.conversation_participants (tenant_id, conversation_id, member_id, role_code)
    SELECT c.tenant_id, c.id, NEW.member_id, 'store_staff'
    FROM public.conversations c
    WHERE c.tenant_id = NEW.tenant_id AND c.store_id = NEW.store_id
    ON CONFLICT (tenant_id, conversation_id, member_id) DO UPDATE SET left_at = NULL
      WHERE conversation_participants.role_code = 'store_staff';
  END IF;
  RETURN NULL;
END
$$;
--> statement-breakpoint
ALTER FUNCTION public.store_members_sync_chat() OWNER TO ae_rls_bypass;
--> statement-breakpoint
CREATE TRIGGER store_members_sync_chat AFTER INSERT OR UPDATE OF role_code, accepted_at OR DELETE
  ON public.store_members
  FOR EACH ROW EXECUTE FUNCTION public.store_members_sync_chat();
--> statement-breakpoint

-- ============================================================================
-- Functions
-- ============================================================================

-- The tenant a conversation lives in, but only for one of its active
-- participants (any of the caller's memberships): everyone else gets NULL,
-- the same answer as for a conversation that doesn't exist. The API then
-- runs as the caller's membership in that tenant and RLS decides everything.
CREATE OR REPLACE FUNCTION public.conversation_tenant_of(p_conversation_id uuid)
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT c.tenant_id
  FROM public.conversations c
  WHERE c.id = p_conversation_id
    AND EXISTS (
      SELECT 1
      FROM public.conversation_participants cp
      JOIN public.tenant_members tm ON tm.tenant_id = cp.tenant_id AND tm.id = cp.member_id
      WHERE cp.tenant_id = c.tenant_id AND cp.conversation_id = c.id AND cp.left_at IS NULL
        AND tm.user_id = public.current_user_id()
    )
$$;
--> statement-breakpoint

-- Opens the caller's conversation about a post or a store, in the current
-- tenant (the post's or store's own; the API switches to it), or returns the
-- one already open (one per buyer and post, or buyer and store, by
-- dedupe_key) whatever has happened to the post since. A new one needs a
-- listed post (post_is_listed, the one rule: 0049, 0050) or an active
-- store; the seller is the post's author or
-- the store's owner, and the store's owner and accepted managers join as
-- store_staff (also for a store's post).
--   no_data_found  no such live post / active store here
--   AE260          your own post or store
--   AE261          you and the seller have blocked each other (either way)
CREATE OR REPLACE FUNCTION public.open_conversation(p_post_id uuid, p_store_id uuid, p_source_code text)
RETURNS TABLE (conversation_id uuid, created boolean)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
#variable_conflict use_column
DECLARE
  v_tenant uuid := public.current_tenant_id();
  v_member uuid := public.current_member_id();
  v_user uuid := public.current_user_id();
  v_key text;
  v_kind text;
  v_seller uuid;
  v_store uuid;
  v_id uuid;
BEGIN
  IF v_tenant IS NULL OR v_member IS NULL OR NOT public.app_is_active_user()
     OR NOT EXISTS (SELECT 1 FROM public.tenant_members tm
                    WHERE tm.tenant_id = v_tenant AND tm.id = v_member AND tm.user_id = v_user) THEN
    RAISE EXCEPTION 'open_conversation: an active member context is required' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF num_nonnulls(p_post_id, p_store_id) <> 1 THEN
    RAISE EXCEPTION 'open_conversation: exactly one of post or store' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  v_key := CASE WHEN p_post_id IS NOT NULL THEN format('post:%s:%s', p_post_id, v_member)
                ELSE format('store:%s:%s', p_store_id, v_member) END;
  SELECT c.id INTO v_id FROM public.conversations c WHERE c.tenant_id = v_tenant AND c.dedupe_key = v_key;
  IF v_id IS NOT NULL THEN
    UPDATE public.conversation_participants cp SET is_archived = false
    WHERE cp.tenant_id = v_tenant AND cp.conversation_id = v_id AND cp.member_id = v_member AND cp.is_archived;
    RETURN QUERY SELECT v_id, false;
    RETURN;
  END IF;

  IF p_post_id IS NOT NULL THEN
    SELECT p.author_member_id, p.store_id INTO v_seller, v_store
    FROM public.posts p
    WHERE p.id = p_post_id AND p.tenant_id = v_tenant AND p.author_member_id IS NOT NULL
      AND public.post_is_listed(p.status_code, p.deleted_at, p.scrubbed_at, p.hidden_by_owner,
                                p.store_hidden, p.expires_at, now());
    IF NOT FOUND THEN
      RAISE EXCEPTION 'open_conversation: no live post % here', p_post_id USING ERRCODE = 'no_data_found';
    END IF;
    v_kind := 'post_inquiry';
  ELSE
    SELECT s.owner_member_id INTO v_seller
    FROM public.stores s
    WHERE s.id = p_store_id AND s.tenant_id = v_tenant AND s.status_code = 'active' AND s.deleted_at IS NULL;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'open_conversation: no active store % here', p_store_id USING ERRCODE = 'no_data_found';
    END IF;
    v_store := p_store_id;
    v_kind := 'store_inquiry';
  END IF;

  IF v_seller = v_member OR (v_store IS NOT NULL AND (
       EXISTS (SELECT 1 FROM public.stores s WHERE s.tenant_id = v_tenant AND s.id = v_store AND s.owner_member_id = v_member)
       OR EXISTS (SELECT 1 FROM public.store_members sm
                  WHERE sm.tenant_id = v_tenant AND sm.store_id = v_store AND sm.member_id = v_member
                    AND sm.role_code = 'manager' AND sm.accepted_at IS NOT NULL))) THEN
    RAISE EXCEPTION 'open_conversation: your own listing' USING ERRCODE = 'AE260';
  END IF;
  IF public.is_blocked_between(v_user, (SELECT tm.user_id FROM public.tenant_members tm
                                        WHERE tm.tenant_id = v_tenant AND tm.id = v_seller)) THEN
    RAISE EXCEPTION 'open_conversation: blocked' USING ERRCODE = 'AE261';
  END IF;

  INSERT INTO public.conversations
    (tenant_id, kind_code, post_id, store_id, dedupe_key, created_by_member_id, origin_source_code)
  VALUES (v_tenant, v_kind, p_post_id, v_store, v_key, v_member, p_source_code)
  ON CONFLICT (tenant_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING
  RETURNING id INTO v_id;
  IF v_id IS NULL THEN
    -- Opened by a concurrent request a moment ago.
    SELECT c.id INTO v_id FROM public.conversations c WHERE c.tenant_id = v_tenant AND c.dedupe_key = v_key;
    RETURN QUERY SELECT v_id, false;
    RETURN;
  END IF;

  INSERT INTO public.conversation_participants (tenant_id, conversation_id, member_id, role_code) VALUES
    (v_tenant, v_id, v_member, 'buyer'),
    (v_tenant, v_id, v_seller, 'seller');
  IF v_store IS NOT NULL THEN
    INSERT INTO public.conversation_participants (tenant_id, conversation_id, member_id, role_code)
    SELECT v_tenant, v_id, staff.member_id, 'store_staff'
    FROM (
      SELECT s.owner_member_id AS member_id FROM public.stores s WHERE s.tenant_id = v_tenant AND s.id = v_store
      UNION
      SELECT sm.member_id FROM public.store_members sm
      WHERE sm.tenant_id = v_tenant AND sm.store_id = v_store
        AND sm.role_code = 'manager' AND sm.accepted_at IS NOT NULL
    ) staff
    WHERE staff.member_id NOT IN (v_member, v_seller)
    ON CONFLICT DO NOTHING;
  END IF;
  RETURN QUERY SELECT v_id, true;
END
$$;
--> statement-breakpoint

-- The caller's conversations across every tenant they're a participant in
-- (the inbox), newest activity first, keyset-paged on (activity, id); or one
-- of them with p_conversation_id. The counterpart is the store (a buyer in a
-- store's conversation), else the seller (a buyer) or the buyer (seller
-- side) — a display name only, never a phone. The post's title only while
-- the post page is still viewable (post_is_viewable, 0049) and not
-- scrubbed. Watermarks: the furthest any other
-- participant has received / read.
CREATE OR REPLACE FUNCTION public.my_conversations(
  p_conversation_id uuid,
  p_before_at timestamptz,
  p_before_id uuid,
  p_limit integer
)
RETURNS TABLE (
  conversation_id          uuid,
  tenant_id                uuid,
  kind_code                text,
  post_id                  uuid,
  store_id                 uuid,
  post_context_removed     boolean,
  is_locked                boolean,
  created_at               timestamptz,
  activity_at              timestamptz,
  unread_count             integer,
  is_archived              boolean,
  my_member_id             uuid,
  my_role_code             text,
  my_last_read_message_id  uuid,
  others_delivered_up_to   uuid,
  others_read_up_to        uuid,
  post_title               text,
  store_slug               text,
  store_name_bn            text,
  store_name_en            text,
  counterpart_kind         text,
  counterpart_name         text,
  blocked                  boolean,
  blocked_by_me            boolean,
  last_message_id          uuid
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT
    c.id, c.tenant_id, c.kind_code, c.post_id, c.store_id, c.post_context_removed, c.is_locked,
    c.created_at, coalesce(c.last_message_at, c.created_at),
    cp.unread_count, cp.is_archived, cp.member_id, cp.role_code, cp.last_read_message_id,
    others.delivered_up_to, others.read_up_to,
    CASE WHEN public.post_is_viewable(p.status_code, p.deleted_at, p.hidden_by_owner)
              AND p.scrubbed_at IS NULL THEN p.title END,
    s.slug, s.name_bn, s.name_en,
    CASE WHEN cp.role_code <> 'buyer' THEN 'buyer'
         WHEN c.store_id IS NOT NULL THEN 'store'
         ELSE 'seller' END,
    CASE WHEN cp.role_code = 'buyer' AND c.store_id IS NOT NULL THEN s.name_bn
         ELSE counterpart.display_name END,
    coalesce(public.is_blocked_between(tm.user_id, counterpart.user_id), false),
    EXISTS (SELECT 1 FROM public.user_blocks ub
            WHERE ub.blocker_user_id = tm.user_id AND ub.blocked_user_id = counterpart.user_id),
    last_message.id
  FROM public.tenant_members tm
  JOIN public.conversation_participants cp
    ON cp.tenant_id = tm.tenant_id AND cp.member_id = tm.id AND cp.left_at IS NULL
  JOIN public.conversations c ON c.tenant_id = cp.tenant_id AND c.id = cp.conversation_id
  LEFT JOIN public.posts p ON p.tenant_id = c.tenant_id AND p.id = c.post_id
  LEFT JOIN public.stores s ON s.tenant_id = c.tenant_id AND s.id = c.store_id
  LEFT JOIN LATERAL (
    SELECT other_tm.user_id, up.display_name
    FROM public.conversation_participants other
    JOIN public.tenant_members other_tm ON other_tm.tenant_id = other.tenant_id AND other_tm.id = other.member_id
    LEFT JOIN public.user_profiles up ON up.user_id = other_tm.user_id
    WHERE other.tenant_id = c.tenant_id AND other.conversation_id = c.id
      AND other.role_code = CASE WHEN cp.role_code = 'buyer' THEN 'seller' ELSE 'buyer' END
    LIMIT 1
  ) counterpart ON true
  LEFT JOIN LATERAL (
    SELECT (array_agg(o.last_delivered_message_id ORDER BY o.last_delivered_message_id DESC NULLS LAST))[1]
             AS delivered_up_to,
           (array_agg(o.last_read_message_id ORDER BY o.last_read_message_id DESC NULLS LAST))[1]
             AS read_up_to
    FROM public.conversation_participants o
    WHERE o.tenant_id = c.tenant_id AND o.conversation_id = c.id
      AND o.member_id <> cp.member_id AND o.left_at IS NULL
  ) others ON true
  LEFT JOIN LATERAL (
    SELECT m.id FROM public.messages m
    WHERE m.tenant_id = c.tenant_id AND m.conversation_id = c.id AND m.deleted_at IS NULL
    ORDER BY m.id DESC
    LIMIT 1
  ) last_message ON true
  WHERE tm.user_id = public.current_user_id()
    AND (p_conversation_id IS NULL OR c.id = p_conversation_id)
    AND (p_before_at IS NULL
         OR (coalesce(c.last_message_at, c.created_at), c.id) < (p_before_at, p_before_id))
  ORDER BY coalesce(c.last_message_at, c.created_at) DESC, c.id DESC
  LIMIT p_limit
$$;
--> statement-breakpoint

-- The chat lead (ADR 058): the first seller-side reply in a conversation the
-- buyer has written in. Marks the conversation (once, under the row lock of
-- the UPDATE, so two replies racing each other give one lead) and returns
-- what the lead needs; no row when this isn't that reply. The API writes the
-- lead_events row in the same transaction, through the same code as every
-- contact reveal.
CREATE OR REPLACE FUNCTION public.claim_first_seller_reply(p_conversation_id uuid, p_message_id uuid)
RETURNS TABLE (
  post_id           uuid,
  store_id          uuid,
  source_code       text,
  seller_member_id  uuid,
  buyer_member_id   uuid,
  buyer_user_id     uuid
)
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  WITH claimed AS (
    UPDATE public.conversations c SET first_seller_reply_at = now()
    WHERE c.tenant_id = public.current_tenant_id()
      AND c.id = p_conversation_id
      AND c.first_seller_reply_at IS NULL
      AND EXISTS (
        SELECT 1 FROM public.messages m
        JOIN public.conversation_participants cp
          ON cp.tenant_id = m.tenant_id AND cp.conversation_id = m.conversation_id AND cp.member_id = m.sender_member_id
        WHERE m.tenant_id = c.tenant_id AND m.conversation_id = c.id AND m.id = p_message_id
          AND m.sender_member_id = public.current_member_id()
          AND cp.role_code IN ('seller', 'store_staff')
      )
      AND EXISTS (
        SELECT 1 FROM public.messages m
        JOIN public.conversation_participants cp
          ON cp.tenant_id = m.tenant_id AND cp.conversation_id = m.conversation_id AND cp.member_id = m.sender_member_id
        WHERE m.tenant_id = c.tenant_id AND m.conversation_id = c.id AND cp.role_code = 'buyer'
      )
    RETURNING c.tenant_id, c.id, c.post_id, c.store_id, c.origin_source_code
  )
  SELECT claimed.post_id, claimed.store_id,
         coalesce(claimed.origin_source_code,
                  CASE WHEN claimed.post_id IS NOT NULL THEN 'post_detail' ELSE 'store_page' END),
         seller.member_id, buyer.member_id, buyer_tm.user_id
  FROM claimed
  JOIN public.conversation_participants buyer
    ON buyer.tenant_id = claimed.tenant_id AND buyer.conversation_id = claimed.id AND buyer.role_code = 'buyer'
  JOIN public.tenant_members buyer_tm ON buyer_tm.tenant_id = buyer.tenant_id AND buyer_tm.id = buyer.member_id
  LEFT JOIN public.conversation_participants seller
    ON seller.tenant_id = claimed.tenant_id AND seller.conversation_id = claimed.id AND seller.role_code = 'seller'
$$;
--> statement-breakpoint

-- A participant reports the conversation: a reports row (one open report per
-- reporter per conversation; again returns the open one) and, for a new
-- report, the transcript as evidence — the last p_max_messages messages,
-- oldest first, including ones their sender deleted — with its images put
-- under evidence hold so no purge removes them. Staff see the conversation
-- only through this snapshot (Q13: no blanket staff read).
--   no_data_found  not a participant of such a conversation here
CREATE OR REPLACE FUNCTION public.report_conversation(
  p_conversation_id uuid,
  p_reason_code text,
  p_details text,
  p_max_messages integer
)
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
  v_report uuid;
BEGIN
  IF v_tenant IS NULL OR v_member IS NULL OR NOT public.app_is_active_user() THEN
    RAISE EXCEPTION 'report_conversation: an active member context is required' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.conversation_participants cp
    WHERE cp.tenant_id = v_tenant AND cp.conversation_id = p_conversation_id
      AND cp.member_id = v_member AND cp.left_at IS NULL
  ) THEN
    RAISE EXCEPTION 'report_conversation: no conversation % here', p_conversation_id USING ERRCODE = 'no_data_found';
  END IF;

  INSERT INTO public.reports (tenant_id, reporter_member_id, conversation_id, reason_code, details)
  VALUES (v_tenant, v_member, p_conversation_id, p_reason_code, nullif(btrim(p_details), ''))
  ON CONFLICT DO NOTHING
  RETURNING id INTO v_report;
  IF v_report IS NULL THEN
    SELECT r.id INTO v_report FROM public.reports r
    WHERE r.tenant_id = v_tenant AND r.reporter_member_id = v_member
      AND r.conversation_id = p_conversation_id AND r.status_code IN ('open', 'in_review');
    RETURN QUERY SELECT v_report, false;
    RETURN;
  END IF;

  INSERT INTO public.conversation_report_snapshots (tenant_id, report_id, conversation_id, transcript, message_count)
  SELECT v_tenant, v_report, p_conversation_id,
         coalesce(jsonb_agg(t.entry ORDER BY t.id), '[]'::jsonb), count(*)::integer
  FROM (
    SELECT m.id, jsonb_build_object(
      'id', m.id,
      'senderMemberId', m.sender_member_id,
      'senderRole', sender.role_code,
      'kind', m.kind_code,
      'body', m.body,
      'mediaAssetId', m.media_asset_id,
      'location', CASE WHEN m.location IS NOT NULL THEN jsonb_build_object(
                    'lat', public.st_y(m.location::public.geometry),
                    'lng', public.st_x(m.location::public.geometry)) END,
      'listing', m.listing_snapshot,
      'systemEvent', m.system_event_key,
      'flaggedByFilter', m.flagged_by_filter,
      'createdAt', m.created_at,
      'deletedAt', m.deleted_at
    ) AS entry
    FROM public.messages m
    LEFT JOIN public.conversation_participants sender
      ON sender.tenant_id = m.tenant_id AND sender.conversation_id = m.conversation_id
     AND sender.member_id = m.sender_member_id
    WHERE m.tenant_id = v_tenant AND m.conversation_id = p_conversation_id
    ORDER BY m.id DESC
    LIMIT p_max_messages
  ) t;

  UPDATE public.media_assets ma SET evidence_hold = true
  WHERE ma.tenant_id = v_tenant AND NOT ma.evidence_hold
    AND ma.id IN (
      SELECT (e ->> 'mediaAssetId')::uuid
      FROM public.conversation_report_snapshots crs, jsonb_array_elements(crs.transcript) e
      WHERE crs.report_id = v_report AND e ->> 'mediaAssetId' IS NOT NULL
    );

  RETURN QUERY SELECT v_report, true;
END
$$;
--> statement-breakpoint

-- A moderator decides a conversation report, in one transaction with its
-- moderation_actions row (CLAUDE.md rule 13):
--   lock     the conversation is locked (nobody can send; RLS, 0009) with a
--            system message, the action 'conversation_locked', and every open
--            report on it 'actioned';
--   dismiss  the action 'reports_dismissed' and the report 'dismissed'.
--   no_data_found  no open conversation report here
CREATE OR REPLACE FUNCTION public.decide_conversation_report(
  p_report_id uuid,
  p_decision text,
  p_reason_code text,
  p_note text
)
RETURNS TABLE (conversation_id uuid, action_id uuid)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
#variable_conflict use_column
DECLARE
  v_tenant uuid := public.current_tenant_id();
  v_user uuid := public.current_user_id();
  v_conversation uuid;
  v_action uuid;
BEGIN
  IF v_tenant IS NULL OR v_user IS NULL OR NOT public.app_is_staff() THEN
    RAISE EXCEPTION 'decide_conversation_report: staff only' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_decision NOT IN ('lock', 'dismiss') THEN
    RAISE EXCEPTION 'decide_conversation_report: unknown decision %', p_decision USING ERRCODE = 'invalid_parameter_value';
  END IF;

  SELECT r.conversation_id INTO v_conversation
  FROM public.reports r
  WHERE r.tenant_id = v_tenant AND r.id = p_report_id AND r.conversation_id IS NOT NULL
    AND r.status_code IN ('open', 'in_review')
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'decide_conversation_report: no open report % here', p_report_id USING ERRCODE = 'no_data_found';
  END IF;

  IF p_decision = 'lock' THEN
    UPDATE public.conversations SET is_locked = true, locked_reason_code = p_reason_code
    WHERE tenant_id = v_tenant AND id = v_conversation;
    INSERT INTO public.messages (tenant_id, conversation_id, sender_member_id, kind_code, system_event_key, client_message_id)
    VALUES (v_tenant, v_conversation, NULL, 'system', 'conversation_locked', format('system:%s', public.uuid_generate_v7()));
    INSERT INTO public.moderation_actions
      (tenant_id, conversation_id, actor_user_id, action_code, reason_code, reason_text, evidence_refs)
    SELECT v_tenant, v_conversation, v_user, 'conversation_locked', p_reason_code, nullif(btrim(p_note), ''),
           coalesce(jsonb_agg(r.id ORDER BY r.id), '[]'::jsonb)
    FROM public.reports r
    WHERE r.tenant_id = v_tenant AND r.conversation_id = v_conversation AND r.status_code IN ('open', 'in_review')
    RETURNING id INTO v_action;
    UPDATE public.reports SET status_code = 'actioned', resolution_code = 'content_removed',
      resolution_note = nullif(btrim(p_note), ''), resolved_at = now(), assigned_to_user_id = v_user
    WHERE tenant_id = v_tenant AND conversation_id = v_conversation AND status_code IN ('open', 'in_review');
  ELSE
    INSERT INTO public.moderation_actions
      (tenant_id, conversation_id, actor_user_id, action_code, reason_code, reason_text, evidence_refs)
    VALUES (v_tenant, v_conversation, v_user, 'reports_dismissed', p_reason_code, nullif(btrim(p_note), ''),
            jsonb_build_array(p_report_id))
    RETURNING id INTO v_action;
    UPDATE public.reports SET status_code = 'dismissed', resolution_code = 'no_action',
      resolution_note = nullif(btrim(p_note), ''), resolved_at = now(), assigned_to_user_id = v_user
    WHERE tenant_id = v_tenant AND id = p_report_id;
  END IF;
  RETURN QUERY SELECT v_conversation, v_action;
END
$$;
--> statement-breakpoint

ALTER FUNCTION public.conversation_tenant_of(uuid) OWNER TO ae_rls_bypass;
--> statement-breakpoint
ALTER FUNCTION public.open_conversation(uuid, uuid, text) OWNER TO ae_rls_bypass;
--> statement-breakpoint
ALTER FUNCTION public.my_conversations(uuid, timestamptz, uuid, integer) OWNER TO ae_rls_bypass;
--> statement-breakpoint
ALTER FUNCTION public.claim_first_seller_reply(uuid, uuid) OWNER TO ae_rls_bypass;
--> statement-breakpoint
ALTER FUNCTION public.report_conversation(uuid, text, text, integer) OWNER TO ae_rls_bypass;
--> statement-breakpoint
ALTER FUNCTION public.decide_conversation_report(uuid, text, text, text) OWNER TO ae_rls_bypass;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public.conversation_tenant_of(uuid) FROM PUBLIC;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public.open_conversation(uuid, uuid, text) FROM PUBLIC;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public.my_conversations(uuid, timestamptz, uuid, integer) FROM PUBLIC;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public.claim_first_seller_reply(uuid, uuid) FROM PUBLIC;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public.report_conversation(uuid, text, text, integer) FROM PUBLIC;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public.decide_conversation_report(uuid, text, text, text) FROM PUBLIC;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public.messages_sync_conversation() FROM PUBLIC;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public.posts_scrub_listing_cards() FROM PUBLIC;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public.store_members_sync_chat() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.conversation_tenant_of(uuid) TO ae_app;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.open_conversation(uuid, uuid, text) TO ae_app;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.my_conversations(uuid, timestamptz, uuid, integer) TO ae_app;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.claim_first_seller_reply(uuid, uuid) TO ae_app;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.report_conversation(uuid, text, text, integer) TO ae_app;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.decide_conversation_report(uuid, text, text, text) TO ae_app;
--> statement-breakpoint

-- ============================================================================
-- Settings (CLAUDE.md rule 9)
-- ============================================================================

INSERT INTO public.platform_settings
  (key, value, value_type_code, unit, min_value, max_value, tenant_override_scope_code, description)
VALUES
  ('chat_contact_filter_first_messages', '6', 'integer', 'messages', 0, 100, 'tenant_admin',
   'A phone number or link typed in a conversation''s first this-many messages is held back with a gentle notice pointing to the contact button (0 = off).'),
  ('chat_messages_per_user_per_minute', '30', 'integer', 'messages', 1, 600, 'platform',
   'Messages one user may send per rolling minute, across conversations.'),
  ('chat_new_conversations_per_user_per_day', '40', 'integer', 'conversations', 1, 1000, 'platform',
   'New conversations one user may open per rolling 24 hours (reopening one is free).'),
  ('chat_message_max_length', '2000', 'integer', 'characters', 100, 10000, 'platform',
   'Longest text message.'),
  ('chat_quick_replies_per_store_max', '10', 'integer', 'replies', 0, 50, 'platform',
   'Quick replies a store may keep.'),
  ('chat_quick_reply_max_length', '300', 'integer', 'characters', 20, 1000, 'platform',
   'Longest quick reply.'),
  ('chat_history_page_size_max', '50', 'integer', 'messages', 10, 200, 'platform',
   'Most messages one history page returns.'),
  ('chat_inbox_page_size_max', '30', 'integer', 'conversations', 5, 100, 'platform',
   'Most conversations one inbox page returns.'),
  ('chat_report_transcript_max_messages', '200', 'integer', 'messages', 10, 2000, 'platform',
   'Most recent messages a conversation report keeps as its evidence snapshot.'),
  ('chat_token_grace_seconds', '60', 'integer', 'seconds', 0, 900, 'none',
   'How long a chat socket stays open after its access token expires, waiting for auth:refresh.'),
  ('chat_presence_ttl_seconds', '45', 'integer', 'seconds', 10, 600, 'none',
   'A participant counts as viewing a conversation (no notification) this long after their last heartbeat.'),
  ('chat_typing_ttl_seconds', '6', 'integer', 'seconds', 2, 30, 'none',
   'How long a typing indicator shows without a fresh typing event.'),
  ('chat_media_url_ttl_seconds', '900', 'integer', 'seconds', 60, 86400, 'none',
   'Validity of the signed URLs a chat image is shown through.');
