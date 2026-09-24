-- 0016_media_settings
--
-- Storage infrastructure (StorageService, apps/api/src/storage) needs one
-- business threshold — the max upload size (CLAUDE.md rule 9) — everything
-- else it touches (media_assets, media_kinds/visibilities/statuses) already
-- exists and is already seeded (0005_content.sql). No RLS changes: that
-- migration's media_assets_member_insert / media_assets_owner_or_staff_update
-- policies already let a member create their own row and flip it to ready.

INSERT INTO public.platform_settings
  (key, value, value_type_code, unit, min_value, max_value, tenant_override_scope_code, description)
VALUES
  ('media_max_upload_bytes', '10485760', 'integer', 'bytes', 1048576, 104857600, 'none',
   'Largest file size StorageService will presign an upload URL for.');
