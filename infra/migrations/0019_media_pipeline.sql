-- 0019_media_pipeline
--
-- Media pipeline (apps/api/src/media): presign -> direct upload -> confirm ->
-- worker (verify, strip metadata, WebP variants, ThumbHash) -> ready.
--
--   1. media_assets.thumbhash: the placeholder the worker computes (ThumbHash,
--      base64). Additive; the older `blurhash` column is left untouched.
--   2. media_asset_is_referenced(): one definition of "attached" for the
--      orphan cleanup and the post-deletion trigger: a media_attachments row,
--      a chat message, an ad creative, or a user avatar / tenant logo that
--      stores the key directly.
--   3. Orphans may be hard-deleted, by the system role only, and only while
--      nothing references them. The RESTRICTIVE policy is ANDed with every
--      permissive one (including platform admin), and the FKs from messages
--      and ad_creatives stay RESTRICT as a second line of defence.
--   4. Deleting a post (deleted_at set) soft-deletes the media only that post
--      uses, due for purge after media_purge_days (scrub_media_purge_days for
--      a privacy scrub), except media under an evidence hold or a post under
--      a legal hold (schema.md §4.2 "Deletion", §11.9).
--   5. Settings for upload rate limits and variant sizes (CLAUDE.md rule 9).

ALTER TABLE public.media_assets ADD COLUMN thumbhash text;
--> statement-breakpoint

-- Orphan cleanup scans processed-but-unattached uploads by age.
CREATE INDEX media_assets_unattached_candidates_idx ON public.media_assets (created_at)
  WHERE deleted_at IS NULL AND status_code IN ('processing', 'ready', 'rejected');
--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.media_asset_is_referenced(
  p_media_asset_id uuid,
  p_storage_key text,
  p_ignore_post_id uuid DEFAULT NULL
)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT
    EXISTS (
      SELECT 1 FROM public.media_attachments a
      WHERE a.media_asset_id = p_media_asset_id
        AND (p_ignore_post_id IS NULL OR a.post_id IS DISTINCT FROM p_ignore_post_id)
    )
    OR EXISTS (SELECT 1 FROM public.messages m WHERE m.media_asset_id = p_media_asset_id)
    OR EXISTS (SELECT 1 FROM public.ad_creatives c WHERE c.media_asset_id = p_media_asset_id)
    OR EXISTS (SELECT 1 FROM public.user_profiles u WHERE u.avatar_storage_key = p_storage_key)
    OR EXISTS (SELECT 1 FROM public.tenant_settings s WHERE s.logo_storage_key = p_storage_key)
$$;
--> statement-breakpoint
COMMENT ON FUNCTION public.media_asset_is_referenced(uuid, text, uuid) IS
  'True while anything uses the asset (attachments, messages, ad creatives, avatars, tenant logos). '
  'p_ignore_post_id leaves out one post''s attachments (the post being deleted).';
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.media_asset_is_referenced(uuid, text, uuid) TO ae_app;
--> statement-breakpoint

CREATE POLICY media_assets_delete_unreferenced_only ON public.media_assets
  AS RESTRICTIVE
  FOR DELETE
  USING (
    (SELECT public.app_is_system())
    AND NOT evidence_hold
    AND NOT public.media_asset_is_referenced(id, storage_key)
  );
--> statement-breakpoint
GRANT DELETE ON public.media_assets TO ae_app;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.posts_soft_delete_media()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  purge_days integer;
BEGIN
  -- A legal hold keeps the post's content, media included, in full.
  IF NEW.deletion_reason_code = 'legal_hold' OR public.legal_hold_blocks('post', NEW.id) THEN
    RETURN NEW;
  END IF;

  SELECT (value #>> '{}')::integer INTO purge_days
  FROM public.platform_settings
  WHERE key = CASE WHEN NEW.scrubbed_at IS NOT NULL THEN 'scrub_media_purge_days' ELSE 'media_purge_days' END;

  UPDATE public.media_assets m
  SET deleted_at = now(),
      purge_due_at = CASE WHEN m.evidence_hold THEN NULL
                          ELSE now() + make_interval(days => purge_days) END
  WHERE m.tenant_id = NEW.tenant_id
    AND m.deleted_at IS NULL
    AND m.id IN (SELECT a.media_asset_id FROM public.media_attachments a WHERE a.post_id = NEW.id)
    AND NOT public.media_asset_is_referenced(m.id, m.storage_key, NEW.id);
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER posts_b_soft_delete_media
  AFTER UPDATE OF deleted_at ON public.posts
  FOR EACH ROW
  WHEN (OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL)
  EXECUTE FUNCTION public.posts_soft_delete_media();
--> statement-breakpoint

INSERT INTO public.platform_settings
  (key, value, value_type_code, unit, min_value, max_value, tenant_override_scope_code, description)
VALUES
  ('media_uploads_per_hour', '40', 'integer', 'count', 1, 1000, 'none',
   'Most uploads one user may start in a rolling hour (POST /media/presign).'),
  ('media_uploads_per_day', '200', 'integer', 'count', 1, 10000, 'none',
   'Most uploads one user may start in a rolling day.'),
  ('media_upload_bytes_per_day', '209715200', 'integer', 'bytes', 1048576, 10737418240, 'none',
   'Most bytes one user may declare for upload in a rolling day.'),
  ('media_max_input_pixels', '40000000', 'integer', 'pixels', 1000000, 200000000, 'none',
   'Largest image (width x height) the worker will decode; guards against decompression bombs.'),
  ('media_variant_thumb_px', '200', 'integer', 'px', 32, 1000, 'none',
   'Long edge of the `thumb` WebP variant.'),
  ('media_variant_card_px', '600', 'integer', 'px', 100, 2000, 'none',
   'Long edge of the `card` WebP variant.'),
  ('media_variant_full_px', '1200', 'integer', 'px', 200, 4000, 'none',
   'Long edge of the `full` WebP variant.'),
  ('media_image_quality', '80', 'integer', 'percent', 30, 100, 'none',
   'Encoder quality for every image the worker writes: WebP variants and the metadata-stripped original.');
