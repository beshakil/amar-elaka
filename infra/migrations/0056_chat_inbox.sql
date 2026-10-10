-- 0056_chat_inbox
--
-- The chat inbox's archive (ADR 060): my_conversations (0054) takes
-- p_archived — false for the inbox, true for the archive, null for one
-- conversation by id whatever its state. Its signature changes, so the
-- 0054 function is dropped and recreated as its owner (same body otherwise,
-- same grants). Archiving itself is the participant's own row
-- (conversation_participants_own_update, 0009): no new policy.
--
-- No table changes. Tests: apps/api/test/chat.e2e-spec.ts (archive).

SELECT set_config('app.is_platform_admin', 'true', true);
--> statement-breakpoint
-- Owned by ae_rls_bypass: only it may drop and redefine it (ae_migrator is
-- NOINHERIT, see 0024) — and grant on it — so this part runs as that role.
SET LOCAL ROLE ae_rls_bypass;
--> statement-breakpoint
DROP FUNCTION public.my_conversations(uuid, timestamptz, uuid, integer);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.my_conversations(
  p_conversation_id uuid,
  p_before_at timestamptz,
  p_before_id uuid,
  p_limit integer,
  p_archived boolean
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
    -- The inbox (false), the archive (true), or both (null: one conversation by id).
    AND (p_archived IS NULL OR cp.is_archived = p_archived)
    AND (p_before_at IS NULL
         OR (coalesce(c.last_message_at, c.created_at), c.id) < (p_before_at, p_before_id))
  ORDER BY coalesce(c.last_message_at, c.created_at) DESC, c.id DESC
  LIMIT p_limit
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public.my_conversations(uuid, timestamptz, uuid, integer, boolean) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.my_conversations(uuid, timestamptz, uuid, integer, boolean) TO ae_app;
--> statement-breakpoint
RESET ROLE;
